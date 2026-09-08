<?php
/**
 * Resolve barcode searches to products.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Turns an EAN-shaped search term into a direct product lookup.
 *
 * A default WordPress search runs a LIKE over post_title and post_content, which for a barcode
 * matches nothing and is slow about it. Barcodes live in sillage.sil_ean_index, one row per EAN
 * per product — BeautyFort products carry up to 26 EANs each, so they cannot be held in a single
 * postmeta row and searched reliably.
 *
 * Runs on the storefront and in wp-admin. Everywhere else, a barcode search falls through to the
 * normal behaviour.
 */
final class Sillage_Search {

	/** EANs are 8, 12, 13 or 14 digits. Anything else is treated as an ordinary search. */
	private const EAN_PATTERN = '/^\d{8}$|^\d{12,14}$/';

	public function register(): void {
		add_action( 'pre_get_posts', array( $this, 'intercept_search' ) );
		add_filter( 'woocommerce_shortcode_products_query', array( $this, 'shortcode_query' ), 10, 3 );
	}

	/** Extract post IDs for a barcode, or null when the term is not a barcode. */
	public static function lookup( string $term ): ?array {
		$term = trim( $term );
		if ( 1 !== preg_match( self::EAN_PATTERN, $term ) ) {
			return null;
		}
		if ( ! Sillage_Settings::ean_index_available() ) {
			return null;
		}

		global $wpdb;
		$table = SILLAGE_DB . '.sil_ean_index';

		// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT wp_post_id FROM {$table} WHERE ean = %s LIMIT 50",
				$term
			)
		);
		// phpcs:enable

		if ( empty( $ids ) ) {
			// A shopper may paste an EAN with a leading zero stripped by a spreadsheet, so retry
			// zero-padded to 13 digits before giving up.
			$padded = str_pad( $term, 13, '0', STR_PAD_LEFT );
			if ( $padded !== $term ) {
				// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
				$ids = $wpdb->get_col(
					$wpdb->prepare(
						"SELECT wp_post_id FROM {$table} WHERE ean = %s LIMIT 50",
						$padded
					)
				);
				// phpcs:enable
			}
		}

		return array_map( 'intval', (array) $ids );
	}

	/**
	 * Short-circuit a barcode search to the matching product IDs.
	 *
	 * @param WP_Query $query The query being prepared.
	 */
	public function intercept_search( $query ): void {
		if ( ! $query instanceof WP_Query || ! $query->is_search() ) {
			return;
		}
		if ( ! $query->is_main_query() && ! is_admin() ) {
			return;
		}

		$term = (string) $query->get( 's' );
		$ids  = self::lookup( $term );
		if ( null === $ids ) {
			return;
		}

		// Replace the text search entirely. post__in with an empty array returns nothing, which is
		// the correct answer for a barcode that is not in the catalogue.
		$query->set( 's', '' );
		$query->set( 'post_type', 'product' );
		$query->set( 'post__in', empty( $ids ) ? array( 0 ) : $ids );
		$query->set( 'orderby', 'post__in' );
		$query->is_search = true;
	}

	/**
	 * Same treatment for the [products] shortcode.
	 *
	 * @param array  $args      Query args.
	 * @param array  $atts      Shortcode attributes.
	 * @param string $loop_name Loop name.
	 */
	public function shortcode_query( $args, $atts, $loop_name ) {
		unset( $atts, $loop_name );
		if ( ! is_array( $args ) || empty( $args['s'] ) ) {
			return $args;
		}
		$ids = self::lookup( (string) $args['s'] );
		if ( null === $ids ) {
			return $args;
		}
		unset( $args['s'] );
		$args['post__in'] = empty( $ids ) ? array( 0 ) : $ids;
		return $args;
	}
}
