<?php
/**
 * First boot inside the WordPress image. Plugins and Blocksy are already in the image.
 *
 * Installs the site if needed, activates WooCommerce + redis-cache + sillage-bridge
 * + Blocksy companion, turns on HPOS, EUR, pretty permalinks, Coming soon off.
 *
 * WP_ADMIN_USER must be set and must not be "admin".
 */
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');

$shopDomain = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['HTTP_HOST'] = $shopDomain;
$_SERVER['SERVER_NAME'] = $shopDomain;
$_SERVER['REQUEST_URI'] = '/';

require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$base = getenv('WP_BASE_URL') ?: '';
$base = rtrim($base, '/');
if ($base === '') {
    $scheme = getenv('WP_HOME_SCHEME') ?: 'https';
    $base = $scheme . '://' . $shopDomain;
}

$wpUser = trim((string) getenv('WP_ADMIN_USER'));
if ($wpUser === '' || strcasecmp($wpUser, 'admin') === 0) {
    fwrite(STDERR, "WP_ADMIN_USER must be set and must not be admin\n");
    exit(1);
}

echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;

if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $title = getenv('SHOP_TITLE') ?: 'Shop';
    $email = getenv('WP_ADMIN_EMAIL') ?: ($wpUser . '@' . $shopDomain);
    $r = wp_install($title, $wpUser, $email, true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . ' login=' . $wpUser . PHP_EOL;
}

update_option('siteurl', $base);
update_option('home', $base);
update_option('woocommerce_currency', 'EUR');
update_option('permalink_structure', '/%postname%/');
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_onboarding_profile', array('skipped' => true));

// Activation belongs to the operator: they upload the paid Blocksy companion, activate what they
// want and customise the shop before any products exist. WP_ACTIVATE_PLUGINS=1 is for an
// unattended install that has to come up serving.
$activate = getenv('WP_ACTIVATE_PLUGINS') === '1';
foreach (array(
    'woocommerce/woocommerce.php',
    'redis-cache/redis-cache.php',
    'sillage-bridge/sillage-bridge.php',
    'blocksy-companion/blocksy-companion.php',
) as $p) {
    if (!file_exists(WP_PLUGIN_DIR . '/' . $p)) {
        echo "$p missing\n";
        continue;
    }
    if (!$activate) {
        echo $p . " present, left inactive for the operator\n";
        continue;
    }
    $res = activate_plugin($p);
    echo $p . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' activated') . PHP_EOL;
}

if (function_exists('wp_get_theme') && wp_get_theme('blocksy')->exists()) {
    if ($activate) {
        switch_theme('blocksy');
        echo "theme=blocksy activated\n";
    } else {
        echo "theme=blocksy present, left for the operator to activate\n";
    }
}

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

$secret = getenv('SILLAGE_SHARED_SECRET') ?: '';
$dash = getenv('SILLAGE_DASHBOARD_URL') ?: '';
$core = getenv('SILLAGE_CORE_INTERNAL_URL') ?: 'http://wholesale-core:4000';
$sillageDb = getenv('SILLAGE_DB') ?: 'sillage';
if ($secret !== '' && defined('ABSPATH')) {
    $wp = ABSPATH . 'wp-config.php';
    if (is_readable($wp)) {
        $text = file_get_contents($wp);
        if ($text !== false && strpos($text, "SILLAGE_SHARED_SECRET") === false) {
            $block = "\n/* Sillage bridge */\n"
                . "define( 'SILLAGE_SHARED_SECRET', '" . addcslashes($secret, "'\\") . "' );\n"
                . "define( 'SILLAGE_CORE_URL', '" . addcslashes($core, "'\\") . "' );\n"
                . "define( 'SILLAGE_DASHBOARD_URL', '" . addcslashes($dash, "'\\") . "' );\n"
                . "define( 'SILLAGE_DB', '" . addcslashes($sillageDb, "'\\") . "' );\n"
                . "define( 'DISABLE_WP_CRON', true );\n";
            $marker = "/* That's all, stop editing!";
            $text = strpos($text, $marker) !== false ? str_replace($marker, $block . $marker, $text) : ($text . $block);
            file_put_contents($wp, $text);
            echo "wp_config_sillage_patched\n";
        }
    }
}

echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
echo 'hpos=' . get_option('woocommerce_custom_orders_table_enabled') . PHP_EOL;
echo 'coming_soon=' . get_option('woocommerce_coming_soon') . PHP_EOL;
echo 'currency=' . get_option('woocommerce_currency') . PHP_EOL;
echo 'permalink=' . get_option('permalink_structure') . PHP_EOL;
echo 'WP_FRESH_INSTALL_DONE' . PHP_EOL;
