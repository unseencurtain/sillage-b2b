<?php
/**
 * Verify (and optionally repair) the WordPress settings this architecture depends on.
 *
 * Run inside the `wholesale-ecom` container after the operator has activated plugins and customised the
 * shop, and before the first catalogue import:
 *
 *   docker cp scripts/wp-readiness.php wholesale-ecom:/tmp/
 *   docker exec -e WP_READINESS_FIX=1 wholesale-ecom php /tmp/wp-readiness.php
 *
 * Two kinds of setting are deliberately treated differently:
 *
 *   - Options the engine and orders rely on (HPOS, permalinks, currency, shop visibility, front
 *     page) are repaired when WP_READINESS_FIX=1. Getting these wrong is not a style choice: HPOS
 *     decides which table orders live in, and permalinks decide whether product URLs and the
 *     sitemaps agree.
 *   - Plugin and theme activation is the operator's. It is reported, never changed, so a shop
 *     mid-customisation is never overridden.
 *
 * Exit code is non-zero when something required is still wrong, so a deploy can stop on it.
 */

$shopDomain = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['HTTP_HOST'] = $shopDomain;
$_SERVER['SERVER_NAME'] = $shopDomain;
$_SERVER['REQUEST_URI'] = '/';

require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$fix = getenv('WP_READINESS_FIX') === '1';
$rows = array();
$failed = 0;

/** Record one check. $required rows count towards the exit code. */
$check = static function (string $name, bool $ok, string $detail, bool $required = true) use (&$rows, &$failed): void {
    $rows[] = array($ok ? 'ok' : ($required ? 'FAIL' : 'note'), $name, $detail);
    if (!$ok && $required) {
        $failed++;
    }
};

/** Verify one option, repairing it when fixing is enabled. */
$option = static function (string $name, string $key, $want, string $label) use ($fix, $check): void {
    $have = get_option($key);
    if ((string) $have === (string) $want) {
        $check($name, true, $label . ' = ' . (string) $want);
        return;
    }
    if ($fix) {
        update_option($key, $want);
        $check($name, true, $label . ': ' . var_export($have, true) . ' → ' . (string) $want . ' (repaired)');
        return;
    }
    $check($name, false, $label . ' is ' . var_export($have, true) . ', expected ' . (string) $want);
};

// --- activation: reported, never changed -----------------------------------------------------
$wooActive = is_plugin_active('woocommerce/woocommerce.php');
$check(
    'woocommerce',
    $wooActive,
    $wooActive ? 'active' : 'INACTIVE — activate it before importing, or the catalogue has nowhere to land'
);
$bridge = is_plugin_active('sillage-bridge/sillage-bridge.php');
$check('sillage-bridge', $bridge, $bridge ? 'active' : 'inactive — cart rules, tracking and sitemap patches are off', false);
$redis = is_plugin_active('redis-cache/redis-cache.php');
$check('redis-cache', $redis, $redis ? 'active' : 'inactive — the shop will be slower but correct', false);
$theme = wp_get_theme();
$check('theme', true, $theme->get('Name') . ' ' . $theme->get('Version'), false);

// --- options the engine and orders depend on -------------------------------------------------
$option('permalinks', 'permalink_structure', '/%postname%/', 'permalink_structure');
$option('currency', 'woocommerce_currency', 'EUR', 'woocommerce_currency');
$option('shop visibility', 'woocommerce_coming_soon', 'no', 'woocommerce_coming_soon');
$option('hpos', 'woocommerce_custom_orders_table_enabled', 'yes', 'woocommerce_custom_orders_table_enabled');

// The option alone is a claim, not a fact. It is written before WooCommerce is ever activated, and
// setting it does not create anything: WooCommerce builds the order tables from its own installer.
// A shop can therefore report HPOS enabled with no order tables at all, and nothing notices until
// the first order has nowhere to go. Hard rule 4 says orders live in wp_wc_orders, so check that
// they can.
$wpdb = $GLOBALS['wpdb'];
$hpos = array('wc_orders', 'wc_orders_meta', 'wc_order_addresses', 'wc_order_operational_data');
$missingTables = static function () use ($wpdb, $hpos): array {
    $missing = array();
    foreach ($hpos as $suffix) {
        $table = $wpdb->prefix . $suffix;
        if (!$wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table))) {
            $missing[] = $suffix;
        }
    }
    return $missing;
};

$missing = $missingTables();
if (!$missing) {
    $check('hpos tables', true, 'all four order tables present');
} elseif (!$wooActive) {
    $check('hpos tables', false, 'missing (' . implode(', ', $missing) . ') — activate WooCommerce first');
} elseif ($fix && class_exists('WC_Install')) {
    WC_Install::create_tables();
    if (method_exists('WC_Install', 'verify_base_tables')) {
        WC_Install::verify_base_tables(true, true);
    }
    $still = $missingTables();
    $check(
        'hpos tables',
        empty($still),
        empty($still)
            ? 'created by WC_Install (repaired)'
            : 'still missing after WC_Install: ' . implode(', ', $still)
    );
} else {
    $check('hpos tables', false, 'missing (' . implode(', ', $missing) . ') — re-run with WP_READINESS_FIX=1');
}

// "/" must resolve to a real page. Left on "latest posts", WordPress guesses a permalink for the
// homepage, and on a shop with 51,000 products that lands on whichever product owns it — that is
// how the homepage once redirected to a vitamin D listing. Which page is the operator's choice:
// the live shop uses a hand-built Home page, not the WooCommerce shop archive.
$front = (int) get_option('page_on_front');
$showOn = get_option('show_on_front');
$frontPost = $front > 0 ? get_post($front) : null;
$frontIsPage = $frontPost !== null && $frontPost->post_type === 'page' && $frontPost->post_status === 'publish';
$shopPage = (int) get_option('woocommerce_shop_page_id');

if ($showOn === 'page' && $frontIsPage) {
    $check('front page', true, '"' . $frontPost->post_title . '" (page #' . $front . ')');
} elseif ($fix && $shopPage > 0) {
    // Fall back to the shop archive only as a placeholder; the operator replaces it with their
    // own Home page during customisation and this check then accepts it.
    update_option('show_on_front', 'page');
    update_option('page_on_front', $shopPage);
    $check('front page', true, 'set to the shop page #' . $shopPage . ' as a placeholder (repaired)');
} else {
    $detail = 'show_on_front=' . var_export($showOn, true) . ' page_on_front=' . $front
        . ($frontPost !== null ? ' (a ' . $frontPost->post_type . ', not a page)' : '')
        . ' — set a published page as the homepage';
    $check('front page', false, $detail, $wooActive);
}

// --- container-level constants ---------------------------------------------------------------
$cron = defined('DISABLE_WP_CRON') && DISABLE_WP_CRON;
$check('wp-cron', $cron, $cron ? 'disabled (the engine owns cadence)' : 'ENABLED — visitor requests will run cron and the box will crawl');
$fsDirect = defined('FS_METHOD') && FS_METHOD === 'direct';
$check('fs_method', $fsDirect, $fsDirect ? 'direct (wp-admin uploads work)' : 'not direct — plugin uploads may ask for FTP credentials', false);
$check('bridge secret', defined('SILLAGE_SHARED_SECRET'), defined('SILLAGE_SHARED_SECRET') ? 'defined' : 'missing from wp-config.php');
$check('sillage db', defined('SILLAGE_DB'), defined('SILLAGE_DB') ? SILLAGE_DB : 'missing from wp-config.php');

$products = (int) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM {$GLOBALS['wpdb']->posts} WHERE post_type = 'product'");
$check('catalogue', true, $products === 0 ? 'empty — waiting for Rebuild catalogue' : number_format($products) . ' products', false);

foreach ($rows as $row) {
    printf("%-5s %-16s %s\n", $row[0], $row[1], $row[2]);
}

if ($failed > 0) {
    fwrite(STDERR, "\n{$failed} required check(s) failed" . ($fix ? "\n" : " — re-run with WP_READINESS_FIX=1 to repair the options\n"));
    exit(1);
}
echo "\nready\n";
