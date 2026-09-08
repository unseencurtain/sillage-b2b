<?php
/**
 * Plugin Name:       Sillage Bridge
 * Plugin URI:        https://github.com/sillage/sillage
 * Description:       Thin bridge between WooCommerce and the sillage-core sync engine. Renders vendor-hosted product images, resolves EAN searches, invalidates caches after a bulk import, and relays orders and tracking. All configuration lives in the sillage-core dashboard.
 * Version:           1.1.3
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * Author:            Sillage
 * License:           GPL-2.0-or-later
 * Text Domain:       sillage-bridge
 *
 * WC requires at least: 9.0
 * WC tested up to:      11.0
 *
 * @package Sillage_Bridge
 *
 * This plugin does as little as possible on purpose. Every bulk write into WooCommerce is
 * performed by sillage-core over raw SQL, because doing it through WordPress would be orders of
 * magnitude slower. What lives here is only the work that genuinely needs a WordPress request
 * context: render-time filters, the search query, WooCommerce's own cache invalidation, and
 * reading and writing orders through WooCommerce's API.
 *
 * If you find yourself wanting to add product write logic here, it belongs in sillage-core.
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SILLAGE_BRIDGE_VERSION', '1.1.3' );
define( 'SILLAGE_BRIDGE_FILE', __FILE__ );
define( 'SILLAGE_BRIDGE_PATH', plugin_dir_path( __FILE__ ) );
define( 'SILLAGE_BRIDGE_URL', plugin_dir_url( __FILE__ ) );

/** The sillage-core database. Plugin reads sil_ean_index, sil_settings, and sil_vendors. */
if ( ! defined( 'SILLAGE_DB' ) ) {
	define( 'SILLAGE_DB', 'sillage' );
}

require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-settings.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-images.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-catalog.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-seo.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-search.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-rest.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-orders.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-cart.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-cart-fee.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-tracking.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-admin.php';
require_once SILLAGE_BRIDGE_PATH . 'includes/class-sillage-activator.php';

/**
 * Declare compatibility with WooCommerce High-Performance Order Storage.
 *
 * HPOS is enabled on this install, so orders live in wp_wc_orders rather than wp_posts. Without
 * this declaration WooCommerce shows an incompatibility warning and can refuse to enable HPOS.
 */
add_action(
	'before_woocommerce_init',
	static function (): void {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
				'custom_order_tables',
				SILLAGE_BRIDGE_FILE,
				true
			);
		}
	}
);

add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! class_exists( 'WooCommerce' ) ) {
			add_action(
				'admin_notices',
				static function (): void {
					echo '<div class="notice notice-error"><p><strong>Sillage Bridge</strong> requires WooCommerce to be active.</p></div>';
				}
			);
			return;
		}

		// Ensure new attributes (pa_gender, …) exist without requiring a manual reactivation.
		Sillage_Activator::ensure_attributes();

		( new Sillage_Images() )->register();
		( new Sillage_Catalog() )->register();
		( new Sillage_Seo() )->register();
		( new Sillage_Search() )->register();
		( new Sillage_Rest() )->register();
		( new Sillage_Orders() )->register();
		( new Sillage_Cart() )->register();
		( new Sillage_Cart_Fee() )->register();
		( new Sillage_Tracking() )->register();

		if ( is_admin() ) {
			( new Sillage_Admin() )->register();
		}
	}
);

register_activation_hook( SILLAGE_BRIDGE_FILE, array( 'Sillage_Activator', 'activate' ) );
register_deactivation_hook( SILLAGE_BRIDGE_FILE, array( 'Sillage_Activator', 'deactivate' ) );
