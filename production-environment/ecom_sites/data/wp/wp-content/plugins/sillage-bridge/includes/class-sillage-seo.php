<?php
/**
 * SEO helpers that must run in a WordPress request.
 *
 * Product listing for Google is **not** built here. Bun writes static XML
 * (`sillage-core` `writeProductSitemaps`) and Caddy serves `/wp-sitemap*.xml`
 * + `/robots.txt` as files. PHP must not query 40k products on a sitemap hit —
 * that is the same prefork pressure the AI crawlers caused.
 *
 * This class only:
 *   - turns WordPress core sitemaps off (so PHP never builds them)
 *   - sends noindex on catalogue-hidden product HTML if Google still opens the URL
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Seo {

	public function register(): void {
		add_filter( 'wp_sitemaps_enabled', array( $this, 'disable_core_sitemaps' ) );
		add_filter( 'wp_robots', array( $this, 'robots_for_hidden_products' ), 20 );
	}

	/**
	 * Core WP sitemaps run a WP_Query per page through Apache/PHP.
	 * Static files from Bun + Caddy replace them.
	 */
	public function disable_core_sitemaps(): bool {
		return false;
	}

	/**
	 * Catalogue-hidden products remain published (Sillage sync) but should not rank.
	 * Cheap: one product already loaded for the HTML request. No catalogue scan.
	 *
	 * @param array<string, bool|string> $robots Robots directives.
	 * @return array<string, bool|string>
	 */
	public function robots_for_hidden_products( array $robots ): array {
		if ( ! function_exists( 'is_product' ) || ! is_product() ) {
			return $robots;
		}
		$product = wc_get_product( get_queried_object_id() );
		if ( ! $product ) {
			return $robots;
		}
		if ( ! $product->is_visible() ) {
			$robots['noindex']  = true;
			$robots['nofollow'] = true;
			unset( $robots['max-image-preview'] );
		}
		return $robots;
	}
}
