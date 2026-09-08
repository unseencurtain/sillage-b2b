<?php
/**
 * Activation and deactivation.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * One-time setup.
 *
 * Registering global product attributes is the one piece of schema work that genuinely has to
 * happen in PHP: `wc_create_attribute()` writes wp_woocommerce_attribute_taxonomies *and* flushes
 * a WooCommerce transient, and the taxonomy is not registered with WordPress until that transient
 * is rebuilt. Inserting the row over SQL leaves the attribute invisible.
 */
final class Sillage_Activator {

	/**
	 * Attributes sillage-core assigns terms to. `volume` already exists on this install.
	 *
	 * The product-type attribute is slugged `item-type`, not `type`: WordPress reserves `type` as
	 * a public query variable, so `wc_create_attribute()` refuses it and the attribute silently
	 * never appears.
	 */
	private const ATTRIBUTES = array(
		'gender'    => 'Gender',
		'item-type' => 'Product Type',
		'volume'    => 'Volume',
		// vendor / pa_vendor intentionally omitted — LPS labels must not appear on product pages.
		// Retail vendor identity is `_sillage_vendor` postmeta (sillage-core).
	);

	/** Option holding the last activation's failures, surfaced on the status page. */
	public const ERRORS_OPTION = 'sillage_activation_errors';

	public static function activate(): void {
		self::register_attributes();
		self::ensure_secret();
		flush_rewrite_rules();
	}

	public static function deactivate(): void {
		flush_rewrite_rules();
	}

	/** Idempotent: create any attributes added after the original activation. */
	public static function ensure_attributes(): void {
		self::register_attributes();
	}

	/** Create any missing global attribute, then force WooCommerce to re-read the list. */
	private static function register_attributes(): void {
		if ( ! function_exists( 'wc_create_attribute' ) || ! function_exists( 'wc_get_attribute_taxonomies' ) ) {
			return;
		}

		$existing = array();
		foreach ( wc_get_attribute_taxonomies() as $attribute ) {
			$existing[] = $attribute->attribute_name;
		}

		$created = false;
		$errors  = array();
		foreach ( self::ATTRIBUTES as $name => $label ) {
			if ( in_array( $name, $existing, true ) ) {
				continue;
			}

			$result = wc_create_attribute(
				array(
					'name'         => $label,
					'slug'         => $name,
					'type'         => 'select',
					'order_by'     => 'name',
					'has_archives' => false,
				)
			);

			if ( is_wp_error( $result ) ) {
				// Recorded rather than swallowed: a rejected attribute means products import
				// without that facet, and the only symptom is a filter that is quietly absent.
				$errors[ $name ] = $result->get_error_message();
				continue;
			}
			$created = true;
		}

		update_option( self::ERRORS_OPTION, $errors, false );

		if ( $created ) {
			// Without this the taxonomies stay unregistered until the next request, and any code
			// running later in this one would silently skip them.
			delete_transient( 'wc_attribute_taxonomies' );
			if ( class_exists( 'WC_Cache_Helper' ) ) {
				WC_Cache_Helper::invalidate_cache_group( 'woocommerce-attributes' );
			}
		}
	}

	/**
	 * Make sure a shared secret exists so the REST endpoints are never left unauthenticated.
	 *
	 * The intended source is the SILLAGE_SHARED_SECRET constant in wp-config.php. This fallback
	 * only prevents an accidentally open endpoint if the constant has not been added yet.
	 */
	private static function ensure_secret(): void {
		if ( defined( 'SILLAGE_SHARED_SECRET' ) ) {
			return;
		}
		if ( '' === (string) get_option( 'sillage_shared_secret', '' ) ) {
			add_option( 'sillage_shared_secret', wp_generate_password( 64, false, false ), '', false );
		}
	}
}
