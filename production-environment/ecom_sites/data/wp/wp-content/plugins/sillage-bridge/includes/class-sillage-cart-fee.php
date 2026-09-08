<?php
/**
 * Cart minimums: global small-order fee + per-vendor MOQ hard block.
 *
 * Global floor (`cart_min_*` in sil_settings): Foodpanda-style fee when enabled. Never blocks
 * checkout. If sillage is unreachable or that config is unusable, the fee is a no-op so a
 * broken global config cannot block a sale.
 *
 * Per-vendor floor (`sil_vendors.order_config.min_order_value_eur`): hard block at cart/checkout
 * with a shortfall notice using the storefront label. A shop fee cannot satisfy a wholesaler
 * MOQ — dispatch would still reject — so vendor floors always surface and always block, even
 * when the global fee toggle is off.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Cart_Fee {

	private const CACHE_GROUP = 'sillage';
	private const CACHE_KEY   = 'cart_min_config';
	private const CACHE_TTL   = 60;

	private const DEFAULT_FEE_LABEL = 'Small order fee';

	/** @var array{fee:array{enabled:bool,min:float,fee:float,label:string,message:string}|null,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null|false */
	private $config = false;

	public function register(): void {
		add_action( 'woocommerce_cart_calculate_fees', array( $this, 'apply_fee' ), 20 );
		add_action( 'woocommerce_before_cart', array( $this, 'maybe_notice' ) );
		add_action( 'woocommerce_before_checkout_form', array( $this, 'maybe_notice' ), 5 );
		add_action( 'woocommerce_check_cart_items', array( $this, 'validate_vendor_moq' ) );
		add_action( 'woocommerce_check_cart_items', array( $this, 'maybe_notice' ), 20 );
	}

	/**
	 * @param WC_Cart $cart Cart being totals-calculated.
	 */
	public function apply_fee( $cart ): void {
		if ( is_admin() && ! defined( 'DOING_AJAX' ) ) {
			return;
		}
		if ( ! $cart instanceof WC_Cart ) {
			return;
		}

		$assessment = $this->assess_fee( $cart );
		if ( null === $assessment || ! $assessment['applies'] ) {
			return;
		}

		$cart->add_fee(
			$assessment['label'],
			$assessment['fee'],
			false
		);
	}

	/**
	 * Soft notices for the optional global small-order fee (does not block checkout).
	 */
	public function maybe_notice(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}

		static $shown = false;
		if ( $shown ) {
			return;
		}

		$assessment = $this->assess_fee( WC()->cart );
		if ( null === $assessment || ! $assessment['applies'] ) {
			return;
		}

		$shown = true;

		$remaining = $assessment['remaining'];
		if ( $remaining > 0 && '' !== $assessment['message'] ) {
			$formatted = wp_strip_all_tags( wc_price( $remaining ) );
			$text      = str_replace( '{remaining}', $formatted, $assessment['message'] );
			wc_add_notice( $text, 'notice' );
		}
	}

	/**
	 * Hard-block checkout when any vendor subtotal is below that vendor's min_order_value_eur.
	 */
	public function validate_vendor_moq(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}

		static $shown = false;
		if ( $shown ) {
			return;
		}

		$shortfalls = $this->vendor_shortfalls( WC()->cart );
		if ( empty( $shortfalls['shortfalls'] ) ) {
			return;
		}

		$shown  = true;
		$config = $this->load_config();
		$labels = is_array( $config ) ? $config['vendor_labels'] : array();

		foreach ( $shortfalls['shortfalls'] as $slug => $shortfall ) {
			if ( $shortfall <= 0 ) {
				continue;
			}
			$label = $labels[ $slug ] ?? $slug;
			$is_wholesale = defined( 'SILLAGE_STOREFRONT_PROFILE' ) && 'wholesale' === SILLAGE_STOREFRONT_PROFILE;
			if ( $is_wholesale ) {
				$min = ( is_array( $config ) && isset( $config['vendor_mins'][ $slug ] ) )
					? (float) $config['vendor_mins'][ $slug ]
					: 0.0;
				wc_add_notice(
					sprintf(
						/* translators: 1: formatted minimum order, 2: formatted shortfall */
						__( 'This is a wholesale shop. Orders must be at least %1$s. Add %2$s more to check out.', 'sillage-bridge' ),
						wp_strip_all_tags( wc_price( $min ) ),
						wp_strip_all_tags( wc_price( $shortfall ) )
					),
					'error'
				);
				continue;
			}
			wc_add_notice(
				sprintf(
					/* translators: 1: formatted money amount, 2: shop section label such as LPS03 */
					__( 'Add %1$s more from %2$s to meet the minimum order for that supplier.', 'sillage-bridge' ),
					wp_strip_all_tags( wc_price( $shortfall ) ),
					esc_html( $label )
				),
				'error'
			);
		}
	}

	/**
	 * @return array{
	 *   applies: bool,
	 *   fee: float,
	 *   label: string,
	 *   remaining: float,
	 *   message: string
	 * }|null Null when the global fee must not run.
	 */
	private function assess_fee( WC_Cart $cart ): ?array {
		$config = $this->load_config();
		if ( null === $config || null === $config['fee'] || ! $config['fee']['enabled'] ) {
			return null;
		}
		$fee_cfg = $config['fee'];
		if ( $fee_cfg['fee'] <= 0 ) {
			return null;
		}

		$subtotals = $this->vendor_subtotals( $cart );
		if ( $subtotals['total'] <= 0 ) {
			return null;
		}

		$remaining = 0.0;
		if ( $fee_cfg['min'] > 0 && $subtotals['total'] < $fee_cfg['min'] ) {
			$remaining = $fee_cfg['min'] - $subtotals['total'];
		}

		if ( $remaining <= 0 ) {
			return null;
		}

		return array(
			'applies'   => true,
			'fee'       => $fee_cfg['fee'],
			'label'     => $fee_cfg['label'],
			'remaining' => $remaining,
			'message'   => $fee_cfg['message'],
		);
	}

	/**
	 * @return array{shortfalls: array<string, float>, vendors_in_cart: list<string>}
	 */
	private function vendor_shortfalls( WC_Cart $cart ): array {
		$config = $this->load_config();
		$mins   = is_array( $config ) ? $config['vendor_mins'] : array();
		if ( empty( $mins ) ) {
			return array(
				'shortfalls'      => array(),
				'vendors_in_cart' => array(),
			);
		}

		$subtotals = $this->vendor_subtotals( $cart );
		$shortfalls = array();
		foreach ( $subtotals['by_vendor'] as $slug => $amount ) {
			$min = $mins[ $slug ] ?? 0.0;
			if ( $min > 0 && $amount < $min ) {
				$shortfalls[ $slug ] = $min - $amount;
			}
		}

		return array(
			'shortfalls'      => $shortfalls,
			'vendors_in_cart' => array_keys( $subtotals['by_vendor'] ),
		);
	}

	/**
	 * @return array{total: float, by_vendor: array<string, float>}
	 */
	private function vendor_subtotals( WC_Cart $cart ): array {
		$by_vendor = array();
		$total     = 0.0;

		foreach ( $cart->get_cart() as $item ) {
			$line = isset( $item['line_subtotal'] ) ? (float) $item['line_subtotal'] : 0.0;
			$total += $line;

			$pid = isset( $item['product_id'] ) ? (int) $item['product_id'] : 0;
			if ( $pid <= 0 ) {
				continue;
			}
			$meta = get_post_meta( $pid, '_sillage_vendor', true );
			if ( ! is_string( $meta ) || '' === $meta ) {
				continue;
			}
			$slug = strtolower( $meta );
			$by_vendor[ $slug ] = ( $by_vendor[ $slug ] ?? 0.0 ) + $line;
		}

		return array(
			'total'     => $total,
			'by_vendor' => $by_vendor,
		);
	}

	/**
	 * @return array{fee:array{enabled:bool,min:float,fee:float,label:string,message:string}|null,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null
	 */
	private function load_config(): ?array {
		if ( false !== $this->config ) {
			return $this->config;
		}

		$cached = wp_cache_get( self::CACHE_KEY, self::CACHE_GROUP );
		if (
			is_array( $cached )
			&& array_key_exists( 'fee', $cached )
			&& isset( $cached['vendor_mins'], $cached['vendor_labels'] )
		) {
			$this->config = $cached;
			return $this->config;
		}

		$loaded = $this->fetch_config();
		$this->config = $loaded;
		if ( null !== $loaded ) {
			wp_cache_set( self::CACHE_KEY, $loaded, self::CACHE_GROUP, self::CACHE_TTL );
		}
		return $loaded;
	}

	/**
	 * @return array{fee:array{enabled:bool,min:float,fee:float,label:string,message:string}|null,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null
	 */
	private function fetch_config(): ?array {
		global $wpdb;

		$suppress = $wpdb->suppress_errors( true );
		try {
			$fee_cfg       = null;
			$vendor_mins   = array();
			$vendor_labels = array();

			$settings_table = SILLAGE_DB . '.sil_settings';
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT setting_key, setting_value FROM {$settings_table}
					 WHERE setting_key IN (%s, %s, %s, %s, %s)",
					'cart_min_enabled',
					'cart_min_subtotal_eur',
					'cart_min_fee_eur',
					'cart_min_fee_label',
					'cart_min_message'
				),
				ARRAY_A
			);
			// phpcs:enable

			// Global fee settings are optional. Missing/broken rows leave fee_cfg null (no fee),
			// but vendor MOQ below can still apply.
			if ( null !== $rows && '' === (string) $wpdb->last_error ) {
				$map = array();
				foreach ( (array) $rows as $row ) {
					if ( ! is_array( $row ) || ! isset( $row['setting_key'], $row['setting_value'] ) ) {
						continue;
					}
					$map[ (string) $row['setting_key'] ] = (string) $row['setting_value'];
				}

				if ( isset( $map['cart_min_enabled'], $map['cart_min_subtotal_eur'], $map['cart_min_fee_eur'], $map['cart_min_message'] ) ) {
					$enabled = ( '1' === $map['cart_min_enabled'] || 'true' === strtolower( $map['cart_min_enabled'] ) );
					$min     = $this->parse_non_negative( $map['cart_min_subtotal_eur'] );
					$fee     = $this->parse_non_negative( $map['cart_min_fee_eur'] );
					if ( null !== $min && null !== $fee ) {
						$label = isset( $map['cart_min_fee_label'] ) ? trim( $map['cart_min_fee_label'] ) : '';
						if ( '' === $label ) {
							$label = self::DEFAULT_FEE_LABEL;
						}
						$message = trim( $map['cart_min_message'] );
						if ( '' === $message || ! str_contains( $message, '{remaining}' ) ) {
							$message = __( 'Add {remaining} more to your basket and the small-order fee disappears.', 'sillage-bridge' );
						}
						$fee_cfg = array(
							'enabled' => $enabled,
							'min'     => $min,
							'fee'     => $fee,
							'label'   => $label,
							'message' => $message,
						);
					}
				}
			}

			$vendors_table = SILLAGE_DB . '.sil_vendors';
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$vendor_rows = $wpdb->get_results(
				"SELECT slug, storefront_label, order_config FROM {$vendors_table} WHERE active = 1",
				ARRAY_A
			);
			// phpcs:enable

			if ( null === $vendor_rows || '' !== (string) $wpdb->last_error ) {
				// Cannot read vendors at all — fail open for MOQ (same spirit as fee fail-open),
				// but still return a usable shell so fee can apply if loaded.
				return array(
					'fee'           => $fee_cfg,
					'vendor_mins'   => array(),
					'vendor_labels' => array(),
				);
			}

			foreach ( (array) $vendor_rows as $vrow ) {
				if ( ! is_array( $vrow ) || ! isset( $vrow['slug'] ) ) {
					continue;
				}
				$slug = strtolower( (string) $vrow['slug'] );

				// Customers see the shop section label (LPS01 / LPS02 / LPS03), never a supplier name.
				$label = isset( $vrow['storefront_label'] ) ? trim( (string) $vrow['storefront_label'] ) : '';
				if ( '' !== $label ) {
					$vendor_labels[ $slug ] = $label;
				}

				$raw = $vrow['order_config'] ?? null;
				if ( ! is_string( $raw ) || '' === $raw ) {
					continue;
				}
				$decoded = json_decode( $raw, true );
				if ( ! is_array( $decoded ) || ! array_key_exists( 'min_order_value_eur', $decoded ) ) {
					continue;
				}
				$vmin = $this->parse_non_negative( $decoded['min_order_value_eur'] );
				if ( null !== $vmin && $vmin > 0 ) {
					$vendor_mins[ $slug ] = $vmin;
				}
			}

			return array(
				'fee'           => $fee_cfg,
				'vendor_mins'   => $vendor_mins,
				'vendor_labels' => $vendor_labels,
			);
		} catch ( Throwable $e ) {
			unset( $e );
			return null;
		} finally {
			$wpdb->suppress_errors( $suppress );
		}
	}

	private function parse_non_negative( mixed $value ): ?float {
		if ( is_int( $value ) || is_float( $value ) ) {
			$n = (float) $value;
			return ( is_finite( $n ) && $n >= 0 ) ? $n : null;
		}
		if ( ! is_string( $value ) || '' === trim( $value ) ) {
			return null;
		}
		if ( ! is_numeric( $value ) ) {
			return null;
		}
		$n = (float) $value;
		return ( is_finite( $n ) && $n >= 0 ) ? $n : null;
	}
}
