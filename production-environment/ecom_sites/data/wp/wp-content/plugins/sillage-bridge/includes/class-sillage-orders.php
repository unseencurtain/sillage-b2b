<?php
/**
 * Order relay: outbound webhook to sillage-core, inbound tracking updates.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Connects WooCommerce orders to the dispatch engine.
 *
 * Unlike products, orders go through WooCommerce's own API in both directions. Volume is a
 * handful per day rather than tens of thousands, so correctness matters far more than speed —
 * and the CRUD layer is what fires the emails, writes the order notes and keeps HPOS and its
 * lookup tables consistent.
 */
final class Sillage_Orders {

	/** Statuses that mean "this order is paid for and should be sent to the vendor". */
	private const DISPATCHABLE = array( 'processing', 'completed' );

	private const NOTIFIED_META = '_sillage_notified';

	public function register(): void {
		add_action( 'woocommerce_order_status_changed', array( $this, 'on_status_changed' ), 10, 4 );
	}

	/**
	 * Notify sillage-core when an order becomes dispatchable.
	 *
	 * @param int      $order_id   Order ID.
	 * @param string   $old_status Previous status.
	 * @param string   $new_status New status.
	 * @param WC_Order $order      Order object.
	 */
	public function on_status_changed( $order_id, $old_status, $new_status, $order = null ): void {
		if ( ! in_array( $new_status, self::DISPATCHABLE, true ) ) {
			return;
		}

		$order = $order instanceof WC_Order ? $order : wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		// Send once. An order can move processing -> on-hold -> processing, and each transition
		// must not enqueue another vendor order.
		if ( '' !== (string) $order->get_meta( self::NOTIFIED_META ) ) {
			return;
		}

		$payload = wp_json_encode(
			array(
				'event'      => 'order.dispatchable',
				'order_id'   => (int) $order->get_id(),
				'order_number' => (string) $order->get_order_number(),
				'status'     => $new_status,
				'previous'   => $old_status,
				'total'      => (float) $order->get_total(),
				'currency'   => $order->get_currency(),
				'country'    => $order->get_shipping_country() ?: $order->get_billing_country(),
				'timestamp'  => time(),
			)
		);
		if ( ! is_string( $payload ) ) {
			return;
		}

		$response = wp_remote_post(
			Sillage_Settings::core_url() . '/api/webhooks/order',
			array(
				'timeout' => 15,
				'headers' => array(
					'Content-Type'         => 'application/json',
					'X-Sillage-Signature'  => Sillage_Settings::sign( $payload ),
				),
				'body'    => $payload,
			)
		);

		if ( is_wp_error( $response ) ) {
			// Not fatal: sillage-core also sweeps for unreferenced dispatchable orders, so a
			// missed webhook delays dispatch rather than losing it.
			$order->add_order_note(
				sprintf(
					/* translators: %s: error message */
					__( 'Sillage: could not notify the sync engine (%s). It will be picked up by the next sweep.', 'sillage-bridge' ),
					$response->get_error_message()
				)
			);
			$order->save();
			return;
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( $code < 200 || $code >= 300 ) {
			// Do not set _sillage_notified — allow a status re-transition or operator retry.
			// Sweep still picks the order up within a few minutes regardless.
			$order->add_order_note(
				sprintf(
					/* translators: %d: HTTP status code */
					__( 'Sillage: sync engine rejected the notify webhook (HTTP %d). It will be picked up by the next sweep.', 'sillage-bridge' ),
					$code
				)
			);
			$order->save();
			return;
		}

		$order->update_meta_data( self::NOTIFIED_META, (string) time() );
		$order->add_order_note( __( 'Sillage: queued for vendor dispatch.', 'sillage-bridge' ) );
		$order->save();
	}

	/**
	 * Apply a vendor status or tracking update coming back from sillage-core.
	 *
	 * Everything here goes through the WooCommerce order API rather than SQL, so notes, emails and
	 * HPOS lookup tables all stay consistent.
	 *
	 * @param WP_REST_Request $request Signed request.
	 */
	public function handle_order_update( $request ) {
		$body = json_decode( (string) $request->get_body(), true );
		if ( ! is_array( $body ) ) {
			return new WP_REST_Response( array( 'ok' => false, 'error' => 'invalid JSON body' ), 400 );
		}

		$order_id = isset( $body['order_id'] ) ? (int) $body['order_id'] : 0;
		$order    = $order_id > 0 ? wc_get_order( $order_id ) : null;
		if ( ! $order instanceof WC_Order ) {
			return new WP_REST_Response( array( 'ok' => false, 'error' => 'order not found' ), 404 );
		}

		$applied = array();

		if ( ! empty( $body['note'] ) && is_string( $body['note'] ) ) {
			$order->add_order_note(
				sanitize_textarea_field( $body['note'] ),
				! empty( $body['notify_customer'] ) ? 1 : 0
			);
			$applied[] = 'note';
		}

		if ( ! empty( $body['tracking'] ) && is_array( $body['tracking'] ) ) {
			$this->apply_tracking( $order, $body['tracking'], ! empty( $body['notify_customer'] ) );
			$applied[] = 'tracking';
		}

		if ( ! empty( $body['vendor_order_number'] ) && is_string( $body['vendor_order_number'] ) ) {
			$vendor = isset( $body['vendor'] ) ? sanitize_key( (string) $body['vendor'] ) : 'vendor';
			$order->update_meta_data(
				'_sillage_' . $vendor . '_order_number',
				sanitize_text_field( $body['vendor_order_number'] )
			);
			$applied[] = 'vendor_order_number';
		}

		if ( ! empty( $body['status'] ) && is_string( $body['status'] ) ) {
			$status = sanitize_key( $body['status'] );
			// Only ever move an order forward to completed. Anything else stays a human decision.
			if ( 'completed' === $status && ! $order->has_status( 'completed' ) ) {
				$order->update_status( 'completed', __( 'Sillage: all vendor shipments dispatched.', 'sillage-bridge' ) );
				$applied[] = 'status';
			}
		}

		$order->save();

		return new WP_REST_Response( array( 'ok' => true, 'applied' => $applied ), 200 );
	}

	/**
	 * Store tracking on the order.
	 *
	 * Written both as structured meta and as an order note. The meta feeds any tracking plugin or
	 * theme template; the note is what a human and the customer actually read, and is the only
	 * part guaranteed to be visible with no extra plugin installed.
	 *
	 * @param WC_Order $order    Order.
	 * @param array    $tracking Tracking payload.
	 * @param bool     $notify   Whether to email the customer.
	 */
	private function apply_tracking( WC_Order $order, array $tracking, bool $notify ): void {
		$code     = isset( $tracking['code'] ) ? sanitize_text_field( (string) $tracking['code'] ) : '';
		$courier  = isset( $tracking['courier'] ) ? sanitize_text_field( (string) $tracking['courier'] ) : '';
		$url      = isset( $tracking['url'] ) ? esc_url_raw( (string) $tracking['url'] ) : '';
		$vendor   = isset( $tracking['vendor'] ) ? sanitize_key( (string) $tracking['vendor'] ) : 'vendor';

		if ( '' === $code ) {
			return;
		}

		$existing = $order->get_meta( '_sillage_tracking' );
		$all      = is_array( $existing ) ? $existing : array();

		foreach ( $all as $entry ) {
			// Never record the same parcel twice; the poller re-reads the vendor every 15 minutes.
			if ( isset( $entry['code'] ) && $entry['code'] === $code ) {
				return;
			}
		}

		$all[] = array(
			'vendor'  => $vendor,
			'courier' => $courier,
			'code'    => $code,
			'url'     => $url,
			'added'   => time(),
		);
		$order->update_meta_data( '_sillage_tracking', $all );

		$note = sprintf(
			/* translators: 1: courier name, 2: tracking code */
			__( 'Shipped via %1$s. Tracking number: %2$s', 'sillage-bridge' ),
			'' !== $courier ? $courier : __( 'carrier', 'sillage-bridge' ),
			$code
		);
		if ( '' !== $url ) {
			$note .= "\n" . $url;
		}

		$order->add_order_note( $note, $notify ? 1 : 0 );
	}
}
