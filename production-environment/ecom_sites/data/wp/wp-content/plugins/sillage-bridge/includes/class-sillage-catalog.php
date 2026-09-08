<?php
/**
 * Storefront catalog helpers for the LPS retail shop (BeautyFort + BTS).
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme-agnostic WooCommerce query filters.
 *
 * Vendor identity lives on `_sillage_vendor` postmeta only — never on `product_cat` and never as
 * a visible `pa_vendor` product attribute (LPS labels must not appear in Additional information).
 * Marketplace connectors treat product categories as browse taxonomy; LPS01/LPS02/LPS03 must not
 * appear there.
 *
 * Dual-catalog / B2B wholesale UI lived here briefly and was removed: wholesale-perfumes is
 * parked for a separate site (`b2b-wholesale/` in the repo). WPF products are hidden via
 * WooCommerce `product_visibility` from sillage-core, not via vendor-meta query hacks.
 *
 * Legacy LPS* `product_cat` terms (from an earlier mistaken lane) are stripped from category
 * widgets / `get_terms` / nav if they still exist. Empty feed categories are hidden too.
 */
final class Sillage_Catalog {

	/** @var string[] Legacy product_cat slugs that must never appear in browse UI. */
	private const LEGACY_VENDOR_CAT_SLUGS = array( 'lps01', 'lps02', 'lps03' );

	/** @var string[] Starter-site demo product_cat slugs (tiny leftover counts). */
	private const DEMO_CAT_SLUGS = array( 'body', 'face', 'hands', 'legs', 'uncategorized' );

	public function register(): void {
		add_action( 'pre_get_posts', array( $this, 'ensure_main_catalog_visibility' ), 20 );
		add_action( 'woocommerce_product_query', array( $this, 'ensure_wc_catalog_visibility' ), 20 );
		// Blocksy live search uses WP REST /wp/v2/search (not the main query).
		add_filter( 'rest_post_search_query', array( $this, 'ensure_rest_search_visibility' ), 1000, 2 );
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_image_safety_css' ), 30 );
		add_filter( 'get_terms', array( $this, 'filter_product_cat_term_lists' ), 20, 3 );
		add_filter( 'woocommerce_product_categories_widget_args', array( $this, 'filter_category_widget_args' ), 20 );
		add_filter( 'woocommerce_product_categories_widget_dropdown_args', array( $this, 'filter_category_widget_args' ), 20 );
		add_filter( 'wp_get_nav_menu_items', array( $this, 'hide_legacy_vendor_cats_from_nav' ), 20, 3 );
		add_shortcode( 'sillage_shop_categories', array( $this, 'shortcode_shop_categories' ) );
		add_shortcode( 'sillage_shop_brands', array( $this, 'shortcode_shop_brands' ) );
	}

	/**
	 * Soft-cap external vendor images so a tiny BF thumb cannot stretch a card.
	 * Root fix is sync-time image resolution; this is a theme-agnostic safety net.
	 */
	public function enqueue_image_safety_css(): void {
		if ( is_admin() ) {
			return;
		}
		$css = '.woocommerce ul.products li.product img,'
			. '.woocommerce div.product div.images img,'
			. '.woocommerce-page ul.products li.product img{'
			. 'max-width:100%;height:auto;object-fit:contain;'
			. '}'
			. '.sillage-shop-cats,.sillage-shop-brands{list-style:none;margin:0;padding:0;}'
			. '.sillage-shop-cats li,.sillage-shop-brands li{margin:0 0 .4rem;}'
			. '.sillage-shop-cats a,.sillage-shop-brands a{text-decoration:none;}'
			. '.sillage-shop-cats .count,.sillage-shop-brands .count{opacity:.7;margin-left:.25rem;}'
			. '.sillage-shop-brands{max-height:22rem;overflow:auto;}';
		wp_register_style( 'sillage-bridge-images', false, array(), SILLAGE_BRIDGE_VERSION );
		wp_enqueue_style( 'sillage-bridge-images' );
		wp_add_inline_style( 'sillage-bridge-images', $css );
	}

	/**
	 * Top-level feed browse categories for the retail shop sidebar (BF/BTS counts).
	 *
	 * Reads `wp_term_taxonomy.count` directly — WooCommerce's `wc_change_term_counts`
	 * zeroes get_terms() counts outside a product loop, which emptied this list.
	 *
	 * @param array|string $atts Shortcode attributes (unused).
	 */
	public function shortcode_shop_categories( $atts = array() ): string {
		unset( $atts );
		global $wpdb;

		$exclude = array_merge( self::LEGACY_VENDOR_CAT_SLUGS, self::DEMO_CAT_SLUGS );
		$ph      = implode( ',', array_fill( 0, count( $exclude ), '%s' ) );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT t.term_id, t.name, t.slug, tt.count
				FROM {$wpdb->terms} t
				INNER JOIN {$wpdb->term_taxonomy} tt
					ON tt.term_id = t.term_id AND tt.taxonomy = 'product_cat' AND tt.parent = 0
				WHERE tt.count >= 20
				  AND t.slug NOT IN ({$ph})
				ORDER BY t.name ASC",
				$exclude
			),
			ARRAY_A
		);

		if ( ! is_array( $rows ) || array() === $rows ) {
			return '';
		}

		$html = '<ul class="sillage-shop-cats">';
		foreach ( $rows as $row ) {
			$name = (string) ( $row['name'] ?? '' );
			$slug = (string) ( $row['slug'] ?? '' );
			if ( '' === $slug || preg_match( '/^lps0[123]$/i', $name ) ) {
				continue;
			}
			$term_id = (int) ( $row['term_id'] ?? 0 );
			$count   = (int) ( $row['count'] ?? 0 );
			$url     = $term_id > 0 ? get_term_link( $term_id, 'product_cat' ) : '';
			$url     = is_wp_error( $url ) ? '' : (string) $url;
			$html   .= '<li><a href="' . esc_url( $url ) . '">' . esc_html( $name )
				. '<span class="count">(' . esc_html( (string) $count ) . ')</span></a></li>';
		}
		$html .= '</ul>';
		return $html;
	}

	/**
	 * Brand browse list for the retail shop sidebar (names + counts).
	 *
	 * Replaces Blocksy's logo-mode Ajax brand filter, which rendered empty checkboxes
	 * when `showLabel` was false and no brand logos existed. Reads `wp_term_taxonomy.count`
	 * directly so WooCommerce's `wc_change_term_counts` cannot blank the list.
	 *
	 * @param array|string $atts Shortcode attributes (unused).
	 */
	public function shortcode_shop_brands( $atts = array() ): string {
		unset( $atts );
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			"SELECT t.term_id, t.name, t.slug, tt.count
			FROM {$wpdb->terms} t
			INNER JOIN {$wpdb->term_taxonomy} tt
				ON tt.term_id = t.term_id AND tt.taxonomy = 'product_brand'
			WHERE tt.count > 0
			  AND t.name <> ''
			ORDER BY t.name ASC",
			ARRAY_A
		);

		if ( ! is_array( $rows ) || array() === $rows ) {
			return '';
		}

		$html = '<ul class="sillage-shop-brands">';
		foreach ( $rows as $row ) {
			$name = (string) ( $row['name'] ?? '' );
			$slug = (string) ( $row['slug'] ?? '' );
			if ( '' === $name || '' === $slug ) {
				continue;
			}
			$term_id = (int) ( $row['term_id'] ?? 0 );
			$count   = (int) ( $row['count'] ?? 0 );
			$url     = $term_id > 0 ? get_term_link( $term_id, 'product_brand' ) : '';
			$url     = is_wp_error( $url ) ? '' : (string) $url;
			$html   .= '<li><a href="' . esc_url( $url ) . '">' . esc_html( $name )
				. '<span class="count">(' . esc_html( (string) $count ) . ')</span></a></li>';
		}
		$html .= '</ul>';
		return $html;
	}

	/**
	 * @param WP_Query $query Main query.
	 */
	public function ensure_main_catalog_visibility( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query || ! $query->is_main_query() ) {
			return;
		}
		if ( $query->is_singular() ) {
			return;
		}
		if ( ! $this->is_product_listing_query( $query ) ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
	}

	/**
	 * @param WP_Query $query Product query.
	 */
	public function ensure_wc_catalog_visibility( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query ) {
			return;
		}
		if ( $query->is_singular() ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
	}

	/**
	 * @param array           $args    WP_Query args for the search.
	 * @param WP_REST_Request $request REST request.
	 * @return array
	 */
	public function ensure_rest_search_visibility( $args, $request ) {
		if ( ! is_array( $args ) ) {
			return $args;
		}

		$post_type        = $args['post_type'] ?? '';
		$includes_product = ( 'product' === $post_type )
			|| ( is_array( $post_type ) && in_array( 'product', $post_type, true ) );
		if ( ! $includes_product ) {
			return $args;
		}

		unset( $request );
		return $this->ensure_catalog_visibility_args( $args );
	}

	/**
	 * @param WP_Query $query Query.
	 */
	private function is_product_listing_query( WP_Query $query ): bool {
		if ( $query->is_singular() ) {
			return false;
		}
		if ( $query->is_search() ) {
			return true;
		}
		if ( function_exists( 'is_shop' ) && is_shop() ) {
			return true;
		}
		if ( function_exists( 'is_product_taxonomy' ) && is_product_taxonomy() ) {
			return true;
		}
		$post_type = $query->get( 'post_type' );
		if ( 'product' === $post_type || ( is_array( $post_type ) && in_array( 'product', $post_type, true ) ) ) {
			return true;
		}
		return false;
	}

	/**
	 * Shop-truth visibility: hide `exclude-from-catalog` (Blocksy search often skips WC_Query).
	 *
	 * @param WP_Query $query Query to mutate.
	 */
	private function ensure_catalog_visibility( WP_Query $query ): void {
		$args = array(
			'tax_query' => $query->get( 'tax_query' ),
		);
		$args = $this->ensure_catalog_visibility_args( $args );
		if ( isset( $args['tax_query'] ) ) {
			$query->set( 'tax_query', $args['tax_query'] );
		}
	}

	/**
	 * @param array $args Query args.
	 * @return array
	 */
	private function ensure_catalog_visibility_args( array $args ): array {
		$term = get_term_by( 'slug', 'exclude-from-catalog', 'product_visibility' );
		if ( ! ( $term instanceof WP_Term ) ) {
			return $args;
		}
		$tt_id = (int) $term->term_taxonomy_id;
		if ( $tt_id <= 0 ) {
			return $args;
		}

		$tax_query = isset( $args['tax_query'] ) && is_array( $args['tax_query'] )
			? $args['tax_query']
			: array();
		if ( $this->tax_query_already_excludes_tt( $tax_query, $tt_id ) ) {
			return $args;
		}

		$tax_query[] = array(
			'taxonomy' => 'product_visibility',
			'field'    => 'term_taxonomy_id',
			'terms'    => array( $tt_id ),
			'operator' => 'NOT IN',
		);
		$args['tax_query'] = $tax_query;
		return $args;
	}

	/**
	 * @param array $tax_query Tax query.
	 * @param int   $tt_id     term_taxonomy_id.
	 */
	private function tax_query_already_excludes_tt( array $tax_query, int $tt_id ): bool {
		foreach ( $tax_query as $clause ) {
			if ( ! is_array( $clause ) ) {
				continue;
			}
			if ( isset( $clause['taxonomy'] ) && 'product_visibility' === $clause['taxonomy'] ) {
				$operator = isset( $clause['operator'] ) ? strtoupper( (string) $clause['operator'] ) : 'IN';
				if ( 'NOT IN' === $operator && $this->terms_include_id( $clause['terms'] ?? null, $tt_id ) ) {
					return true;
				}
			}
			if ( $this->tax_query_already_excludes_tt( $clause, $tt_id ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Drop legacy LPS* product_cat terms and empty feed cats from front-end lists.
	 *
	 * @param array                $terms      Term results.
	 * @param array|string         $taxonomies Taxonomies requested.
	 * @param array|string|WP_Term $args       Query args.
	 * @return array
	 */
	public function filter_product_cat_term_lists( $terms, $taxonomies = array(), $args = array() ) {
		if ( is_admin() || is_wp_error( $terms ) || ! is_array( $terms ) ) {
			return $terms;
		}
		$tax_list = is_array( $taxonomies ) ? $taxonomies : array( $taxonomies );
		if ( ! in_array( 'product_cat', $tax_list, true ) ) {
			return $terms;
		}

		$hide_empty = true;
		if ( is_array( $args ) && array_key_exists( 'hide_empty', $args ) ) {
			$hide_empty = (bool) $args['hide_empty'];
		}

		$legacy = self::LEGACY_VENDOR_CAT_SLUGS;

		return array_values(
			array_filter(
				$terms,
				static function ( $term ) use ( $legacy, $hide_empty ) {
					if ( $term instanceof WP_Term ) {
						if ( in_array( (string) $term->slug, $legacy, true ) ) {
							return false;
						}
						if ( preg_match( '/^lps0[123]$/i', (string) $term->name ) ) {
							return false;
						}
						if ( $hide_empty && (int) $term->count <= 0 ) {
							return false;
						}
						return true;
					}
					if ( is_string( $term ) && in_array( $term, $legacy, true ) ) {
						return false;
					}
					return true;
				}
			)
		);
	}

	/**
	 * @param array $args Widget args.
	 * @return array
	 */
	public function filter_category_widget_args( array $args ): array {
		$args['hide_empty'] = 1;
		$exclude            = isset( $args['exclude'] ) ? (array) $args['exclude'] : array();
		foreach ( self::LEGACY_VENDOR_CAT_SLUGS as $slug ) {
			$term = get_term_by( 'slug', $slug, 'product_cat' );
			if ( $term instanceof WP_Term ) {
				$exclude[] = (int) $term->term_id;
			}
		}
		$args['exclude'] = array_values( array_unique( array_map( 'intval', $exclude ) ) );
		return $args;
	}

	/**
	 * @param array         $items Menu items.
	 * @param WP_Term|mixed $_menu Menu term (unused).
	 * @param array         $_args Menu args (unused).
	 * @return array
	 */
	public function hide_legacy_vendor_cats_from_nav( $items, $_menu = null, $_args = array() ) {
		if ( is_admin() || ! is_array( $items ) ) {
			return $items;
		}
		$legacy = self::LEGACY_VENDOR_CAT_SLUGS;

		return array_values(
			array_filter(
				$items,
				static function ( $item ) use ( $legacy ) {
					if ( ! is_object( $item ) ) {
						return true;
					}
					$object = isset( $item->object ) ? (string) $item->object : '';
					if ( 'product_cat' !== $object ) {
						return true;
					}
					$url = isset( $item->url ) ? (string) $item->url : '';
					foreach ( $legacy as $slug ) {
						if ( false !== strpos( $url, '/product-category/' . $slug ) ) {
							return false;
						}
					}
					$object_id = isset( $item->object_id ) ? (int) $item->object_id : 0;
					if ( $object_id > 0 ) {
						$term = get_term( $object_id, 'product_cat' );
						if ( $term instanceof WP_Term && in_array( (string) $term->slug, $legacy, true ) ) {
							return false;
						}
					}
					return true;
				}
			)
		);
	}

	/**
	 * @param mixed $terms Term list from a tax_query clause.
	 * @param int   $id    Expected numeric id.
	 */
	private function terms_include_id( $terms, int $id ): bool {
		if ( is_numeric( $terms ) && (int) $terms === $id ) {
			return true;
		}
		if ( is_array( $terms ) ) {
			foreach ( $terms as $term ) {
				if ( is_numeric( $term ) && (int) $term === $id ) {
					return true;
				}
			}
		}
		return false;
	}
}
