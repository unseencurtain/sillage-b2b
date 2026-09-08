<?php
/**
 * First boot on an empty VPS. Copied into the WordPress container and run with php.
 *
 * Installs the site if needed, activates WooCommerce + redis-cache + sillage-bridge,
 * turns on HPOS (orders in wp_wc_orders), EUR, pretty permalinks, and turns off
 * WooCommerce "Coming soon". Catalogue sync works without this; order dispatch does not.
 */
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');

$_SERVER['HTTP_HOST'] = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'];
$_SERVER['REQUEST_URI'] = '/';

require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$url = 'https://' . $_SERVER['HTTP_HOST'];
echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;

if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $title = getenv('SHOP_TITLE') ?: 'Shop';
    $r = wp_install($title, 'admin', 'admin@' . $_SERVER['HTTP_HOST'], true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . PHP_EOL;
}

update_option('siteurl', $url);
update_option('home', $url);
update_option('woocommerce_currency', 'EUR');
update_option('permalink_structure', '/%postname%/');
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_onboarding_profile', array('skipped' => true));

foreach (array(
    'woocommerce/woocommerce.php',
    'redis-cache/redis-cache.php',
    'sillage-bridge/sillage-bridge.php',
) as $p) {
    if (!file_exists(WP_PLUGIN_DIR . '/' . $p)) {
        echo "$p missing\n";
        continue;
    }
    $res = activate_plugin($p);
    echo $p . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' ok') . PHP_EOL;
}

if (function_exists('wp_get_theme') && wp_get_theme('blocksy')->exists()) {
    switch_theme('blocksy');
    echo "theme=blocksy\n";
}

// HPOS — WooCommerce 8+/11. Empty VPS must match live: wp_wc_orders, not shop_order posts.
update_option('woocommerce_custom_orders_table_enabled', 'yes');
update_option('woocommerce_custom_orders_table_data_sync_enabled', 'no');
update_option('woocommerce_feature_custom_order_tables_enabled', 'yes');
if (class_exists(\Automattic\WooCommerce\Internal\Features\FeaturesController::class)) {
    try {
        $features = wc_get_container()->get(\Automattic\WooCommerce\Internal\Features\FeaturesController::class);
        if (method_exists($features, 'change_feature_enabled')) {
            $features->change_feature_enabled('custom_order_tables', true);
        }
    } catch (Throwable $e) {
        echo 'hpos_feature_warn=' . $e->getMessage() . PHP_EOL;
    }
}

flush_rewrite_rules(false);

echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
echo 'hpos=' . get_option('woocommerce_custom_orders_table_enabled') . PHP_EOL;
echo 'coming_soon=' . get_option('woocommerce_coming_soon') . PHP_EOL;
echo 'currency=' . get_option('woocommerce_currency') . PHP_EOL;
echo 'permalink=' . get_option('permalink_structure') . PHP_EOL;
echo 'WP_FRESH_INSTALL_DONE' . PHP_EOL;
