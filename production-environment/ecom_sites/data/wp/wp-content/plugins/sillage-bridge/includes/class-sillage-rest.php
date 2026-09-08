<?php
/**
 * REST endpoints sillage-core calls into.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The `sillage/v1` namespace.
 *
 * Authentication is an HMAC of the raw request body using a secret shared with sillage-core, not a
 * WordPress user. These calls come from another container on the Docker network, and giving the
 * sync engine a WordPress account with edit_products would be a much larger grant than it needs.
 */
final class Sillage_Rest {

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		$args = array(
			'permission_callback' => array( $this, 'authorize' ),
		);

		register_rest_route(
			'sillage/v1',
			'/finalize',
			array_merge(
				$args,
				array(
					'methods'  => 'POST',
					'callback' => array( $this, 'finalize' ),
				)
			)
		);

		register_rest_route(
			'sillage/v1',
			'/status',
			array_merge(
				$args,
				array(
					'methods'  => 'GET',
					'callback' => array( $this, 'status' ),
				)
			)
		);

		register_rest_route(
			'sillage/v1',
			'/order-update',
			array_merge(
				$args,
				array(
					'methods'  => 'POST',
					'callback' => array( new Sillage_Orders(), 'handle_order_update' ),
				)
			)
		);
	}

	/**
	 * Verify the HMAC signature over the raw body.
	 *
	 * A GET has no body, so the signature covers the empty string; that is still enough to prove
	 * possession of the secret, and the endpoint only reads.
	 *
	 * @param WP_REST_Request $request Incoming request.
	 */
	public function authorize( $request ): bool {
		if ( ! $request instanceof WP_REST_Request ) {
			return false;
		}
		return Sillage_Settings::verify_signature(
			(string) $request->get_body(),
			$request->get_header( 'x-sillage-signature' )
		);
	}

	/**
	 * Invalidate every cache that a bulk SQL import leaves stale.
	 *
	 * sillage-core writes products with raw SQL, so none of WooCommerce's invalidation hooks fire.
	 * Without this call the storefront keeps serving pre-import product queries, category counts
	 * and price ranges until the transients happen to expire.
	 */
	public function finalize(): WP_REST_Response {
		$started = microtime( true );
		$done    = array();

		// Bumping the transient version is how WooCommerce invalidates its own product query
		// caches wholesale.
		if ( class_exists( 'WC_Cache_Helper' ) ) {
			WC_Cache_Helper::get_transient_version( 'product', true );
			WC_Cache_Helper::get_transient_version( 'product_query', true );
			$done[] = 'wc_transient_version';

			if ( method_exists( 'WC_Cache_Helper', 'invalidate_cache_group' ) ) {
				WC_Cache_Helper::invalidate_cache_group( 'products' );
				$done[] = 'wc_product_group';
			}
		}

		// Attribute layered-nav counts are cached separately from product queries.
		delete_transient( 'wc_layered_nav_counts' );
		wp_cache_flush_group( 'wc_layered_nav_counts' );
		$done[] = 'layered_nav';

		// Price range for the price filter widget.
		delete_transient( 'wc_products_onsale' );
		delete_transient( 'wc_featured_products' );
		$done[] = 'wc_product_lists';

		// Term counts were recomputed in SQL, but the cached copies still hold the old numbers.
		foreach ( array( 'product_cat', 'product_brand', 'pa_gender', 'pa_item-type', 'pa_volume' ) as $taxonomy ) {
			if ( taxonomy_exists( $taxonomy ) ) {
				clean_taxonomy_cache( $taxonomy );
			}
		}
		$done[] = 'taxonomy_cache';

		// Some themes keep their own derived tables for product filtering, populated by hooks on
		// product save that a raw SQL import never fires.
		if ( $this->regenerate_theme_lookups() ) {
			$done[] = 'theme_lookup';
		}

		// Blocksy's Ajax category filter dumps a flat brand A–Z; swap those widgets for the
		// theme-agnostic [sillage_shop_categories] browse list (top-level BF/BTS feed cats).
		if ( $this->ensure_shop_category_browse_widgets() ) {
			$done[] = 'shop_category_browse';
		}

		// Blocksy's brand widget ships as logo-mode (showLabel=false, product_brands plural) and
		// renders empty checkboxes without logos. Swap for [sillage_shop_brands] (names+counts).
		if ( $this->ensure_shop_brand_browse_widgets() ) {
			$done[] = 'shop_brand_browse';
		}

		/**
		 * Fires after Sillage has invalidated WooCommerce's caches following a bulk import.
		 *
		 * The hook exists so a theme or plugin with its own derived data can rebuild it without
		 * this plugin needing to know about it.
		 *
		 * @param string[] $done Identifiers of the caches already invalidated.
		 */
		do_action( 'sillage_finalize', $done );

		// Object cache last, so nothing above repopulates a stale entry.
		wp_cache_flush();
		$done[] = 'object_cache';

		return new WP_REST_Response(
			array(
				'ok'         => true,
				'invalidated' => $done,
				'duration_ms' => (int) round( ( microtime( true ) - $started ) * 1000 ),
			),
			200
		);
	}

	/**
	 * Rebuild theme-owned product lookup tables.
	 *
	 * Blocksy keeps a taxonomy lookup table. Astra / Elementor may expose similar refresh entry
	 * points — each check is guarded so this is a no-op when those themes/plugins are absent.
	 *
	 * Prefer a direct SQL rebuild: Blocksy's `regenerate_inline` loads every product through
	 * `wc_get_products( limit=-1 )`, which OOMs / times out on a ~60k catalogue. The wrong
	 * action name (`blocksy:products:taxonomies-lookup:regenerate`) was also a no-op — the
	 * real hook is `blocksy:pro:woo-extra:filters:lookup-table:regenerate`.
	 */
	private function regenerate_theme_lookups(): bool {
		$did = false;

		if ( $this->rebuild_blocksy_taxonomy_lookup() ) {
			$did = true;
		} elseif (
			function_exists( 'blocksy_get_product_taxonomies_lookup_table' )
			|| class_exists( '\Blocksy\Extensions\WoocommerceExtra\FiltersTaxonomiesProductsLookupTable' )
			|| class_exists( '\Blocksy\ProductTaxonomiesLookup' )
		) {
			// Fallback for smaller installs / future Blocksy versions.
			do_action( 'blocksy:pro:woo-extra:filters:lookup-table:regenerate' );
			$did = true;
		}

		// Astra WooCommerce addon / Elementor Pro occasionally cache product card markup.
		if ( function_exists( 'astra_clear_all_assets_cache' ) ) {
			astra_clear_all_assets_cache();
			$did = true;
		}
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			$fm = \Elementor\Plugin::$instance->files_manager;
			if ( is_object( $fm ) && method_exists( $fm, 'clear_cache' ) ) {
				$fm->clear_cache();
				$did = true;
			}
		}
		if ( function_exists( 'elementor_theme_do_location' ) && class_exists( '\Elementor\Plugin' ) ) {
			do_action( 'elementor/core/files/clear_cache' );
			$did = true;
		}

		return $did;
	}

	/**
	 * Populate `wp_blocksy_product_taxonomies_lookup` from live term relationships.
	 *
	 * Without this, Blocksy's Ajax category filter only sees the handful of starter-site
	 * demo products that were indexed before the bulk SQL import.
	 */
	private function rebuild_blocksy_taxonomy_lookup(): bool {
		global $wpdb;
		$table = $wpdb->prefix . 'blocksy_product_taxonomies_lookup';

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
		if ( $table !== $exists ) {
			return false;
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query( "TRUNCATE TABLE {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		// Retail shop only: index BeautyFort/BTS browse taxonomies. Skip wholesale-perfumes and
		// anything already exclude-from-catalog so Blocksy's category filter matches /shop.
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$inserted = $wpdb->query(
			"INSERT INTO {$table} (product_id, taxonomy, term_id)
			SELECT DISTINCT p.ID, tt.taxonomy, tt.term_id
			FROM {$wpdb->posts} p
			INNER JOIN {$wpdb->term_relationships} tr ON tr.object_id = p.ID
			INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
			WHERE p.post_type = 'product'
			  AND p.post_status = 'publish'
			  AND tt.taxonomy IN ('product_cat', 'product_brand', 'product_brands')
			  AND NOT EXISTS (
			        SELECT 1 FROM {$wpdb->postmeta} pm_wpf
			         WHERE pm_wpf.post_id = p.ID
			           AND pm_wpf.meta_key = '_sillage_vendor'
			           AND pm_wpf.meta_value = 'wholesale-perfumes'
			      )
			  AND NOT EXISTS (
			        SELECT 1
			          FROM {$wpdb->term_relationships} tr_vis
			          INNER JOIN {$wpdb->term_taxonomy} tt_vis
			            ON tt_vis.term_taxonomy_id = tr_vis.term_taxonomy_id
			           AND tt_vis.taxonomy = 'product_visibility'
			          INNER JOIN {$wpdb->terms} t_vis ON t_vis.term_id = tt_vis.term_id
			         WHERE tr_vis.object_id = p.ID
			           AND t_vis.slug = 'exclude-from-catalog'
			      )"
		);

		if ( false === $inserted ) {
			return false;
		}

		update_option(
			'blocksy_taxonomy_lookup_regeneration_state',
			array(
				'state'   => 'idle',
				'enabled' => true,
			),
			false
		);

		return true;
	}

	/**
	 * Replace Blocksy product_cat Ajax filters with [sillage_shop_categories].
	 *
	 * Leaves attribute filters (volume, etc.) and brand widgets untouched (brands are handled
	 * by {@see ensure_shop_brand_browse_widgets()}).
	 */
	private function ensure_shop_category_browse_widgets(): bool {
		$widgets = get_option( 'widget_block', null );
		if ( ! is_array( $widgets ) ) {
			return false;
		}

		$replacement = '<!-- sillage-shop-cats -->'
			. '<!-- wp:heading {"level":6,"className":"widget-title","style":{"spacing":{"margin":{"top":"0","bottom":"15px"}}}} -->'
			. "\n"
			. '<h6 class="wp-block-heading widget-title" id="categories" style="margin-top:0;margin-bottom:15px">Categories</h6>'
			. "\n"
			. '<!-- /wp:heading -->'
			. "\n\n"
			. '<!-- wp:shortcode -->'
			. "\n"
			. '[sillage_shop_categories]'
			. "\n"
			. '<!-- /wp:shortcode -->';

		$changed = false;
		foreach ( $widgets as $key => $widget ) {
			if ( ! is_array( $widget ) || ! isset( $widget['content'] ) || ! is_string( $widget['content'] ) ) {
				continue;
			}
			$content = $widget['content'];
			if ( false !== strpos( $content, 'sillage-shop-cats' ) || false !== strpos( $content, '[sillage_shop_categories]' ) ) {
				continue;
			}
			if ( false === strpos( $content, 'wp:blocksy/woocommerce-filters' ) ) {
				continue;
			}
			// Skip attribute / brand filter widgets.
			if (
				false !== strpos( $content, '"type":"attributes"' )
				|| false !== strpos( $content, '"attribute"' )
				|| false !== strpos( $content, '"taxonomy":"product_brand' )
				|| false !== strpos( $content, 'Filter By Brand' )
			) {
				continue;
			}
			// Default Blocksy filter without type/taxonomy is product_cat.
			$widgets[ $key ]['content'] = $replacement;
			$changed                    = true;
		}

		if ( ! $changed ) {
			return false;
		}

		update_option( 'widget_block', $widgets, false );
		return true;
	}

	/**
	 * Replace Blocksy logo-mode brand filters with [sillage_shop_brands].
	 *
	 * Starter Blocksy config uses taxonomy `product_brands` (plural, unregistered),
	 * `showLabel:false`, and logo frames — so the storefront shows empty checkboxes.
	 */
	private function ensure_shop_brand_browse_widgets(): bool {
		$widgets = get_option( 'widget_block', null );
		if ( ! is_array( $widgets ) ) {
			return false;
		}

		$replacement = '<!-- sillage-shop-brands -->'
			. '<!-- wp:heading {"level":6,"className":"widget-title","style":{"spacing":{"margin":{"top":"0","bottom":"15px"}}}} -->'
			. "\n"
			. '<h6 class="wp-block-heading widget-title" id="brands" style="margin-top:0;margin-bottom:15px">Filter By Brand</h6>'
			. "\n"
			. '<!-- /wp:heading -->'
			. "\n\n"
			. '<!-- wp:shortcode -->'
			. "\n"
			. '[sillage_shop_brands]'
			. "\n"
			. '<!-- /wp:shortcode -->';

		$changed = false;
		foreach ( $widgets as $key => $widget ) {
			if ( ! is_array( $widget ) || ! isset( $widget['content'] ) || ! is_string( $widget['content'] ) ) {
				continue;
			}
			$content = $widget['content'];
			if ( false !== strpos( $content, 'sillage-shop-brands' ) || false !== strpos( $content, '[sillage_shop_brands]' ) ) {
				continue;
			}
			$is_brand_filter = (
				false !== strpos( $content, '"taxonomy":"product_brand' )
				|| false !== strpos( $content, 'Filter By Brand' )
				|| (
					false !== strpos( $content, 'wp:blocksy/woocommerce-filters' )
					&& false !== strpos( $content, 'logoMaxW' )
				)
			);
			if ( ! $is_brand_filter ) {
				continue;
			}
			$widgets[ $key ]['content'] = $replacement;
			$changed                    = true;
		}

		if ( ! $changed ) {
			return false;
		}

		update_option( 'widget_block', $widgets, false );
		return true;
	}

	/** Health and configuration snapshot, used by the dashboard's Overview page. */
	public function status(): WP_REST_Response {
		global $wpdb;

		$product_count = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'"
		);

		$attribute_taxonomies = array();
		if ( function_exists( 'wc_get_attribute_taxonomies' ) ) {
			foreach ( wc_get_attribute_taxonomies() as $attribute ) {
				$attribute_taxonomies[] = 'pa_' . $attribute->attribute_name;
			}
		}

		return new WP_REST_Response(
			array(
				'ok'                   => true,
				'plugin_version'       => SILLAGE_BRIDGE_VERSION,
				'wordpress_version'    => get_bloginfo( 'version' ),
				'woocommerce_version'  => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'currency'             => get_option( 'woocommerce_currency' ),
				'hpos_enabled'         => 'yes' === get_option( 'woocommerce_custom_orders_table_enabled' ),
				'published_products'   => $product_count,
				'attribute_taxonomies' => $attribute_taxonomies,
				'ean_index_readable'   => Sillage_Settings::ean_index_available(),
				'wp_cron_disabled'     => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			),
			200
		);
	}
}
