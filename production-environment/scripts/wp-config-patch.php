<?php
/**
 * Patch wp-config.php from inside the `wholesale-ecom` container.
 *
 * WordPress lives in a Docker volume, so the host cannot edit this file. Run it with:
 *
 *   docker cp scripts/wp-config-patch.php wholesale-ecom:/tmp/
 *   docker exec -e SILLAGE_SHARED_SECRET=… wholesale-ecom php /tmp/wp-config-patch.php
 *
 * Idempotent, and it refreshes as well as inserts — see the note on $set.
 */

$path = getenv('WP_CONFIG_PATH') ?: '/var/www/html/wp-config.php';
if (!is_file($path)) {
    fwrite(STDERR, "WP_CONFIG_MISSING — start wholesale-ecom first so WordPress can create wp-config.php\n");
    exit(1);
}

$secret = getenv('SILLAGE_SHARED_SECRET') ?: '';
$dash   = getenv('SILLAGE_DASHBOARD_URL') ?: '';
$core   = getenv('SILLAGE_CORE_INTERNAL_URL') ?: 'http://wholesale-core:4000';
$db     = getenv('SILLAGE_DB') ?: 'sillage_wpf';

if ($secret === '') {
    fwrite(STDERR, "SILLAGE_SHARED_SECRET is empty — refusing to write a broken bridge config\n");
    exit(1);
}

$text = file_get_contents($path);
$original = $text;
$marker = "/* That's all, stop editing!";

/**
 * Insert or refresh one constant.
 *
 * Refreshing matters as much as inserting. A wholesale shop was left pointing at the retail
 * `sillage` database because an early install wrote that default and nothing ever corrected it,
 * so every bridge query ran against a database that did not exist on that server and failed
 * quietly. A constant that is present but wrong has to converge on the next deploy.
 *
 * WP-CLI loads wp-config.php twice, so each define is guarded; bare ones warn on every run.
 */
$set = static function (string $text, string $name, string $literal) use ($marker): string {
    $pattern = "/define\(\s*'" . $name . "'\s*,\s*[^)]*\)\s*;/";
    if (preg_match($pattern, $text)) {
        return preg_replace($pattern, "define( '" . $name . "', " . $literal . " );", $text);
    }
    $block = "\nif ( ! defined( '" . $name . "' ) ) {\n"
        . "\tdefine( '" . $name . "', " . $literal . " );\n}\n";
    return strpos($text, $marker) !== false
        ? str_replace($marker, $block . $marker, $text)
        : $text . "\n" . $block;
};

$quote = static function (string $value): string {
    return "'" . addcslashes($value, "'\\") . "'";
};

$constants = array(
    'SILLAGE_SHARED_SECRET' => $quote($secret),
    'SILLAGE_CORE_URL' => $quote($core),
    'SILLAGE_DB' => $quote($db),
    // The engine's scheduler owns sync cadence, and wp-cron firing on visitor requests is what
    // makes a small box crawl. FS_METHOD keeps wp-admin plugin uploads from asking for FTP.
    'DISABLE_WP_CRON' => 'true',
    'FS_METHOD' => "'direct'",
);
if ($dash !== '') {
    $constants['SILLAGE_DASHBOARD_URL'] = $quote($dash);
}

foreach ($constants as $name => $literal) {
    $text = $set($text, $name, $literal);
}

if ($text === $original) {
    echo "WP_CONFIG_ALREADY\n";
    exit(0);
}

file_put_contents($path, $text);
echo "WP_CONFIG_PATCHED\n";
