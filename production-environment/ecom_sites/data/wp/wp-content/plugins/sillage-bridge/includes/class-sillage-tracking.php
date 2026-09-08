<?php
/**
 * Customer-facing order tracking page.
 *
 * Shortcode: [sillage_track]
 * Create a WordPress page containing that shortcode (e.g. /track-order/).
 * Customers enter order number + email; we show shipment tracking written by sillage-core.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Tracking {

	public function register(): void {
		add_shortcode( 'sillage_track', array( $this, 'render_shortcode' ) );
	}

	/**
	 * @param array<string, string>|string $atts Shortcode attributes.
	 */
	public function render_shortcode( $atts = array() ): string {
		unset( $atts );
		$order_number = isset( $_POST['sillage_order'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['sillage_order'] ) ) : '';
		$email        = isset( $_POST['sillage_email'] ) ? sanitize_email( wp_unslash( (string) $_POST['sillage_email'] ) ) : '';
		$nonce_ok     = isset( $_POST['sillage_track_nonce'] )
			&& wp_verify_nonce( sanitize_text_field( wp_unslash( (string) $_POST['sillage_track_nonce'] ) ), 'sillage_track' );

		ob_start();
		?>
		<form class="sillage-track-form" method="post" style="max-width:28rem;display:grid;gap:0.75rem">
			<p><?php esc_html_e( 'Enter your order number and the email used at checkout.', 'sillage-bridge' ); ?></p>
			<?php wp_nonce_field( 'sillage_track', 'sillage_track_nonce' ); ?>
			<label>
				<span><?php esc_html_e( 'Order number', 'sillage-bridge' ); ?></span>
				<input type="text" name="sillage_order" value="<?php echo esc_attr( $order_number ); ?>" required />
			</label>
			<label>
				<span><?php esc_html_e( 'Email', 'sillage-bridge' ); ?></span>
				<input type="email" name="sillage_email" value="<?php echo esc_attr( $email ); ?>" required />
			</label>
			<button type="submit"><?php esc_html_e( 'Track order', 'sillage-bridge' ); ?></button>
		</form>
		<?php

		if ( $nonce_ok && $order_number !== '' && is_email( $email ) ) {
			echo $this->lookup_html( $order_number, $email ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}

		return (string) ob_get_clean();
	}

	private function lookup_html( string $order_number, string $email ): string {
		$order = wc_get_order( absint( $order_number ) );
		if ( ! $order ) {
			// Try order number meta for custom numbering plugins.
			$orders = wc_get_orders(
				array(
					'limit'        => 1,
					'return'       => 'objects',
					'meta_key'     => '_order_number',
					'meta_value'   => $order_number,
					'meta_compare' => '=',
				)
			);
			$order = $orders[0] ?? null;
		}

		if ( ! $order instanceof WC_Order ) {
			return '<p class="sillage-track-error">' . esc_html__( 'No order found for that number.', 'sillage-bridge' ) . '</p>';
		}

		$billing = strtolower( (string) $order->get_billing_email() );
		if ( $billing === '' || strtolower( $email ) !== $billing ) {
			return '<p class="sillage-track-error">' . esc_html__( 'Email does not match this order.', 'sillage-bridge' ) . '</p>';
		}

		$parcels = $order->get_meta( '_sillage_tracking' );
		if ( ! is_array( $parcels ) ) {
			$parcels = array();
		}

		// Fallback: look for common WooCommerce shipment tracking meta written by order-update.
		if ( empty( $parcels ) ) {
			$code = $order->get_meta( '_tracking_number' );
			$url  = $order->get_meta( '_tracking_url' );
			if ( is_string( $code ) && $code !== '' ) {
				$parcels[] = array(
					'courier' => (string) $order->get_meta( '_tracking_provider' ),
					'code'    => $code,
					'url'     => is_string( $url ) ? $url : '',
				);
			}
		}

		$html  = '<div class="sillage-track-result" style="margin-top:1.5rem">';
		$html .= '<p><strong>' . esc_html__( 'Order status:', 'sillage-bridge' ) . '</strong> '
			. esc_html( wc_get_order_status_name( $order->get_status() ) ) . '</p>';

		if ( empty( $parcels ) ) {
			$html .= '<p>' . esc_html__( 'No tracking number yet. You will receive an email when the parcel ships.', 'sillage-bridge' ) . '</p>';
		} else {
			$html .= '<ul>';
			foreach ( $parcels as $parcel ) {
				if ( ! is_array( $parcel ) ) {
					continue;
				}
				$code = isset( $parcel['code'] ) ? (string) $parcel['code'] : '';
				$url  = isset( $parcel['url'] ) ? (string) $parcel['url'] : '';
				$cour = isset( $parcel['courier'] ) ? (string) $parcel['courier'] : '';
				$html .= '<li>';
				if ( $cour !== '' ) {
					$html .= esc_html( $cour ) . ' — ';
				}
				if ( $url !== '' ) {
					$html .= '<a href="' . esc_url( $url ) . '" rel="noopener noreferrer" target="_blank">' . esc_html( $code !== '' ? $code : $url ) . '</a>';
				} else {
					$html .= esc_html( $code );
				}
				$html .= '</li>';
			}
			$html .= '</ul>';
		}
		$html .= '</div>';
		return $html;
	}
}
