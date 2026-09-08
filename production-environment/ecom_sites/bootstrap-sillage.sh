#!/usr/bin/env bash
# One-time infrastructure bootstrap for Sillage. Safe to re-run.
#
#   ./bootstrap-sillage.sh
#
# Creates the sillage database and user, applies WordPress-side grants, configures WooCommerce for
# EUR, disables WP-Cron, and grants WordPress read access to the EAN index once it exists.

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source .env

CORE_ENV="../sillage-core/.env"
[[ -f "$CORE_ENV" ]] || { echo "Missing $CORE_ENV — copy sillage-core/.env.example first."; exit 1; }
SILLAGE_DB_PASSWORD="$(grep -E '^SILLAGE_DB_PASSWORD=' "$CORE_ENV" | cut -d= -f2-)"
[[ -n "$SILLAGE_DB_PASSWORD" ]] || { echo "SILLAGE_DB_PASSWORD is not set in $CORE_ENV"; exit 1; }

run_sql() { docker exec -i ecom-db mariadb -uroot -p"$MYSQL_ROOT_PWD" "$@"; }

echo "==> Creating sillage database, user and grants"
sed "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" config/sillage-grants.sql | run_sql
run_sql -e "ALTER USER 'sillage'@'%' IDENTIFIED BY '${SILLAGE_DB_PASSWORD}';"

echo "==> Configuring WooCommerce for EUR"
run_sql "$MYSQL_DB" <<'SQL'
UPDATE wp_options SET option_value = 'EUR' WHERE option_name = 'woocommerce_currency';
UPDATE wp_options SET option_value = 'left'  WHERE option_name = 'woocommerce_currency_pos';
UPDATE wp_options SET option_value = '2'     WHERE option_name = 'woocommerce_price_num_decimals';
SQL

echo "==> Disabling WP-Cron (sillage-core owns scheduling)"
docker exec ecom php -r '
$f = "/var/www/html/wp-config.php";
$s = file_get_contents($f);
if (strpos($s, "DISABLE_WP_CRON") === false) {
    $s = str_replace(
        "/* That'"'"'s all, stop editing!",
        "define( \"DISABLE_WP_CRON\", true );\n\n/* That'"'"'s all, stop editing!",
        $s
    );
    file_put_contents($f, $s);
    echo "added\n";
} else {
    echo "already present\n";
}'

echo "==> Publishing the shared secret to wp-config.php"
SHARED_SECRET="$(grep -E '^SILLAGE_SHARED_SECRET=' "$CORE_ENV" | cut -d= -f2-)"
docker exec -e SILLAGE_SECRET="$SHARED_SECRET" ecom php -r '
$f = "/var/www/html/wp-config.php";
$s = file_get_contents($f);
$block = "define( \"SILLAGE_SHARED_SECRET\", \"" . getenv("SILLAGE_SECRET") . "\" );\n"
       . "define( \"SILLAGE_CORE_URL\", \"http://sillage-core:4000\" );\n"
       . "define( \"SILLAGE_DASHBOARD_URL\", \"http://127.0.0.1:4000\" );\n\n";
if (strpos($s, "SILLAGE_SHARED_SECRET") === false) {
    $s = str_replace("/* That'"'"'s all, stop editing!", $block . "/* That'"'"'s all, stop editing!", $s);
    file_put_contents($f, $s);
    echo "added\n";
} else {
    // Keep the constant in step with .env if the secret was rotated.
    $s = preg_replace("/define\(\s*.SILLAGE_SHARED_SECRET.\s*,\s*.[^\"'"'"']*.\s*\);/",
        "define( \"SILLAGE_SHARED_SECRET\", \"" . getenv("SILLAGE_SECRET") . "\" );", $s);
    file_put_contents($f, $s);
    echo "updated\n";
}'

echo "==> Activating the sillage-bridge plugin"
docker exec ecom php -r '
define("WP_USE_THEMES", false);
require "/var/www/html/wp-load.php";
require_once ABSPATH . "wp-admin/includes/plugin.php";
$plugin = "sillage-bridge/sillage-bridge.php";
if (is_plugin_active($plugin)) {
    echo "already active\n";
} else {
    $result = activate_plugin($plugin);
    echo is_wp_error($result) ? "FAILED: " . $result->get_error_message() . "\n" : "activated\n";
}'

echo "==> Granting WordPress read access to sillage tables the plugin needs"
for tbl in sil_ean_index sil_settings sil_vendors; do
  if run_sql -e "SELECT 1 FROM information_schema.tables
                 WHERE table_schema='sillage' AND table_name='${tbl}';" | grep -q 1; then
    run_sql -e "GRANT SELECT ON sillage.${tbl} TO '${MYSQL_USER}'@'%'; FLUSH PRIVILEGES;"
    echo "    granted SELECT on sillage.${tbl}"
  else
    echo "    ${tbl} does not exist yet — run 'bun run migrate' then re-run this script"
  fi
done

echo "==> Done"
