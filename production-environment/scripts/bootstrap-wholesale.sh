#!/usr/bin/env bash
# Bootstrap the wholesale WordPress + sillage_wpf instance on the live VPS (or a laptop).
#
# Safe to re-run. Does not touch retail `earth` / `sillage` / `ecom` / `sillage-core`.
#
#   # On ovhe:
#   cd ~/sillage && bash scripts/bootstrap-wholesale.sh
#
# Requires: Docker stack already up (ecom, ecom-db, valkey). Wholesale gets its own
# MariaDB (`wholesale-db`). Unified ~/sillage/.env.
# wholesale.mirainikki.xyz (and ideally sillage-wholesale.mirainikki.xyz) pointing at this host.
#
# Dispatch stays sandbox-locked (SILLAGE_PROFILE=wholesale). Never places a live vendor order.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" && -f "$HOME/sillage/.env" ]]; then
  ENV_FILE="$HOME/sillage/.env"
  cd "$HOME/sillage"
  ROOT="$HOME/sillage"
fi
[[ -f "$ENV_FILE" ]] || { echo "Missing .env (expected $ENV_FILE)" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Container/folder names are wholesale-*. WPF is only the vendor SKU prefix in product codes.
# Infra env keys: WHOLESALE_*. Old WPF_* keys are still read as fallback.

WHOLESALE_SHOP_DOMAIN="${WHOLESALE_SHOP_DOMAIN:-${WPF_SHOP_DOMAIN:-wholesale.mirainikki.xyz}}"
WHOLESALE_DASH_DOMAIN="${WHOLESALE_DASH_DOMAIN:-${WPF_DASH_DOMAIN:-sillage-wholesale.mirainikki.xyz}}"
WHOLESALE_WP_BASE_URL="${WHOLESALE_WP_BASE_URL:-${WPF_WP_BASE_URL:-https://${WHOLESALE_SHOP_DOMAIN}}}"
WHOLESALE_WORDPRESS_DB="${WHOLESALE_WORDPRESS_DB:-${WPF_WORDPRESS_DB:-earth_wpf}}"
WHOLESALE_SILLAGE_DB="${WHOLESALE_SILLAGE_DB:-${WPF_SILLAGE_DB:-sillage_wpf}}"
WHOLESALE_ECOM_PORT="${WHOLESALE_ECOM_PORT:-${WPF_ECOM_PORT:-106}}"
WHOLESALE_SILLAGE_PORT="${WHOLESALE_SILLAGE_PORT:-${WPF_SILLAGE_PORT:-4001}}"
DATA_DIR="${DATA_DIR:-$HOME/ecom_sites/data}"
MYSQL_USER="${MYSQL_USER:-lime}"
WP_ADMIN_PASS="${WHOLESALE_WP_ADMIN_PASS:-${WPF_WP_ADMIN_PASS:-${WP_ADMIN_PASS:-}}}"
WHOLESALE_SILLAGE_SHARED_SECRET="${WHOLESALE_SILLAGE_SHARED_SECRET:-${WPF_SILLAGE_SHARED_SECRET:-}}"

ensure_env_key() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    return 0
  fi
  printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  echo "    appended $key to .env"
}

set_env_key() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$key" "$val" <<'PY'
from pathlib import Path
import sys
path, key, val = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines(True)
out, found = [], False
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={val}\n")
        found = True
    else:
        out.append(line)
if not found:
    if out and not out[-1].endswith("\n"):
        out.append("\n")
    out.append(f"{key}={val}\n")
path.write_text("".join(out))
PY
    echo "    updated $key in .env"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    echo "    appended $key to .env"
  fi
}

echo "==> Ensuring wholesale keys in .env"
if [[ -z "${WHOLESALE_SILLAGE_SHARED_SECRET:-}" ]]; then
  WHOLESALE_SILLAGE_SHARED_SECRET="$(openssl rand -hex 32)"
  ensure_env_key WHOLESALE_SILLAGE_SHARED_SECRET "$WHOLESALE_SILLAGE_SHARED_SECRET"
else
  ensure_env_key WHOLESALE_SILLAGE_SHARED_SECRET "$WHOLESALE_SILLAGE_SHARED_SECRET"
fi
ensure_env_key WHOLESALE_SHOP_DOMAIN "$WHOLESALE_SHOP_DOMAIN"
set_env_key WHOLESALE_DASH_DOMAIN "$WHOLESALE_DASH_DOMAIN"
set_env_key WHOLESALE_WP_BASE_URL "$WHOLESALE_WP_BASE_URL"
ensure_env_key WHOLESALE_WORDPRESS_INTERNAL_URL "http://wholesale-ecom"
ensure_env_key WHOLESALE_WORDPRESS_DB "$WHOLESALE_WORDPRESS_DB"
ensure_env_key WHOLESALE_SILLAGE_DB "$WHOLESALE_SILLAGE_DB"
ensure_env_key WHOLESALE_ECOM_PORT "$WHOLESALE_ECOM_PORT"
ensure_env_key WHOLESALE_SILLAGE_PORT "$WHOLESALE_SILLAGE_PORT"
ensure_env_key WHOLESALE_ECOM_BIND "127.0.0.1"
ensure_env_key WHOLESALE_SILLAGE_BIND "127.0.0.1"
ensure_env_key COMPOSE_PROFILES "wholesale"
set_env_key WHOLESALE_SITEMAP_HOST_DIR "${DATA_DIR}/sitemaps-wholesale"
ensure_env_key WHOLESALE_SILLAGE_SECRETS_FILE "$ROOT/sillage-core/data/secrets.overlay.wholesale.env"
ensure_env_key WHOLESALE_IMAGE_OVERRIDES_FILE "$ROOT/sillage-core/data/image_overrides.wholesale.json"
ensure_env_key WHOLESALE_LOGS_DIR "$ROOT/sillage-core/logs-wholesale"
ensure_env_key WHOLESALE_DB_HOST_PORT "3308"
ensure_env_key WHOLESALE_MYSQL_ROOT_PWD "${WHOLESALE_MYSQL_ROOT_PWD:-$MYSQL_ROOT_PWD}"
ensure_env_key WHOLESALE_MYSQL_PWD "${WHOLESALE_MYSQL_PWD:-$MYSQL_PWD}"

# Reload after appends
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p \
  "$DATA_DIR/wp-wholesale" \
  "$DATA_DIR/sitemaps-wholesale" \
  "$DATA_DIR/wholesale-db" \
  "$ROOT/sillage-core/logs-wholesale" \
  "$ROOT/.feedscratch"

OVERRIDES="${WHOLESALE_IMAGE_OVERRIDES_FILE:-$ROOT/sillage-core/data/image_overrides.wholesale.json}"
[[ -f "$OVERRIDES" ]] || echo '{}' > "$OVERRIDES"
SECRETS="${WHOLESALE_SILLAGE_SECRETS_FILE:-$ROOT/sillage-core/data/secrets.overlay.wholesale.env}"
[[ -f "$SECRETS" ]] || : > "$SECRETS"
chmod 600 "$SECRETS" 2>/dev/null || true

WS_MYSQL_PWD="${WHOLESALE_MYSQL_ROOT_PWD:-$MYSQL_ROOT_PWD}"

echo "==> Starting wholesale-db (own MariaDB, not ecom-db)"
docker compose --env-file "$ENV_FILE" --profile wholesale up -d wholesale-db
for i in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db healthcheck.sh --connect --innodb_initialized </dev/null 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "==> Creating wholesale databases + grants on wholesale-db"
GRANTS="$ROOT/ecom_sites/config/sillage-grants-wholesale.sql"
if [[ ! -f "$GRANTS" ]]; then
  GRANTS="$(dirname "$0")/../ecom_sites/config/sillage-grants-wholesale.sql"
fi
sed -e "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" \
    -e "s|__MYSQL_USER__|${MYSQL_USER}|g" \
    "$GRANTS" \
  | docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot

echo "==> Starting wholesale containers"
docker compose --env-file "$ENV_FILE" --profile wholesale up -d wholesale-db wholesale-ecom wholesale-core wholesale-cron

echo "==> Waiting for WordPress files in $DATA_DIR/wp-wholesale"
for i in $(seq 1 90); do
  if [[ -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
    break
  fi
  sleep 2
done
if [[ ! -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
  echo "wp-config.php never appeared — is wholesale-ecom running?" >&2
  docker ps --filter name=wholesale-ecom
  exit 1
fi

echo "==> WooCommerce / redis-cache / Blocksy + sillage-bridge"
# unzip as ubuntu, then give wp-content back to Apache (uid 33). Leaving it as
# ubuntu:ubuntu 755 makes wp-admin Updates fail: "Could not create directory
# /var/www/html/wp-content/upgrade".
sudo chown -R "${USER:-ubuntu}:${USER:-ubuntu}" "$DATA_DIR/wp-wholesale/wp-content" 2>/dev/null || true
mkdir -p "$DATA_DIR/wp-wholesale/wp-content/plugins" "$DATA_DIR/wp-wholesale/wp-content/themes"
cd /tmp
for item in "plugin:woocommerce" "plugin:redis-cache" "theme:blocksy"; do
  kind=${item%%:*}; slug=${item##*:}
  dest="$DATA_DIR/wp-wholesale/wp-content/${kind}s/${slug}"
  if [[ -d "$dest" ]]; then
    echo "  $slug already present"
    continue
  fi
  curl -fsSL -o "${slug}.zip" "https://downloads.wordpress.org/${kind}/${slug}.latest-stable.zip"
  unzip -qo "${slug}.zip" -d "$DATA_DIR/wp-wholesale/wp-content/${kind}s"
  rm -f "${slug}.zip"
done

BRIDGE_SRC=""
for candidate in \
  "$DATA_DIR/wp/wp-content/plugins/sillage-bridge" \
  "$ROOT/ecom_sites/data/wp/wp-content/plugins/sillage-bridge"; do
  if [[ -f "$candidate/sillage-bridge.php" && -d "$candidate/includes" ]]; then
    BRIDGE_SRC="$candidate"
    break
  fi
done
if [[ -z "$BRIDGE_SRC" ]]; then
  echo "sillage-bridge plugin not found (need includes/)" >&2
  exit 1
fi
mkdir -p "$DATA_DIR/wp-wholesale/wp-content/plugins/sillage-bridge"
rsync -a --delete "$BRIDGE_SRC/" "$DATA_DIR/wp-wholesale/wp-content/plugins/sillage-bridge/"
if [[ ! -f "$DATA_DIR/wp-wholesale/wp-content/plugins/sillage-bridge/includes/class-sillage-settings.php" ]]; then
  echo "plugin copy missing includes — aborting" >&2
  exit 1
fi

echo "==> Installing WordPress + WooCommerce + HPOS + Redis drop-in"
cat > /tmp/wpf-fresh-install.php <<'PHP'
<?php
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');
$_SERVER['HTTP_HOST'] = getenv('WHOLESALE_SHOP_DOMAIN') ?: 'wholesale.mirainikki.xyz';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'];
$_SERVER['REQUEST_URI'] = '/';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
$url = 'https://' . $_SERVER['HTTP_HOST'];
echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;
if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $r = wp_install('Wholesale', 'admin', 'admin@' . $_SERVER['HTTP_HOST'], true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . PHP_EOL;
    echo 'admin_pass_set=yes' . PHP_EOL;
}
update_option('siteurl', $url);
update_option('home', $url);
update_option('blogname', 'Wholesale');
update_option('woocommerce_currency', 'EUR');
update_option('woocommerce_currency_pos', 'left');
update_option('woocommerce_price_num_decimals', '2');
update_option('permalink_structure', '/%postname%/');
require_once ABSPATH . 'wp-admin/includes/plugin.php';
foreach (['woocommerce/woocommerce.php', 'redis-cache/redis-cache.php', 'sillage-bridge/sillage-bridge.php'] as $p) {
    if (!file_exists(WP_PLUGIN_DIR . '/' . $p)) { echo "$p missing\n"; continue; }
    $res = activate_plugin($p);
    echo $p . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' ok') . PHP_EOL;
}
if (wp_get_theme('blocksy')->exists()) {
    switch_theme('blocksy');
    echo "theme=blocksy\n";
}

// HPOS — dispatch reads wp_wc_orders, not wp_posts.
update_option('woocommerce_custom_orders_table_enabled', 'yes');
update_option('woocommerce_custom_orders_table_data_sync_enabled', 'no');
update_option('woocommerce_feature_custom_order_tables_enabled', 'yes');
if (function_exists('wc_get_container')) {
    try {
        $sync = wc_get_container()->get(
            Automattic\WooCommerce\Internal\DataStores\Orders\DataSynchronizer::class
        );
        if ($sync && method_exists($sync, 'create_database_tables')) {
            $sync->create_database_tables();
            echo "hpos_tables=ok\n";
        }
    } catch (Throwable $e) {
        echo 'hpos_tables_skip=' . $e->getMessage() . PHP_EOL;
    }
}

$dropin_src = WP_PLUGIN_DIR . '/redis-cache/includes/object-cache.php';
$dropin_dst = WP_CONTENT_DIR . '/object-cache.php';
if (is_readable($dropin_src) && !is_file($dropin_dst)) {
    copy($dropin_src, $dropin_dst);
    echo "redis_dropin=copied\n";
} elseif (is_file($dropin_dst)) {
    echo "redis_dropin=present\n";
}

if (class_exists('WC_Install')) {
    WC_Install::create_pages();
    echo "wc_pages=ok\n";
}
$shopId = (int) get_option('woocommerce_shop_page_id');
if ($shopId > 0) {
    update_option('show_on_front', 'page');
    update_option('page_on_front', $shopId);
    echo "front=shop:$shopId\n";
}
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_pages_only', 'no');

flush_rewrite_rules(true);
echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
echo 'hpos=' . get_option('woocommerce_custom_orders_table_enabled') . PHP_EOL;
PHP

docker cp /tmp/wpf-fresh-install.php wholesale-ecom:/tmp/wpf-fresh-install.php
docker exec \
  -e WHOLESALE_SHOP_DOMAIN="$WHOLESALE_SHOP_DOMAIN" \
  -e WP_ADMIN_PASS="$WP_ADMIN_PASS" \
  wholesale-ecom php /tmp/wpf-fresh-install.php

# Pretty permalinks need Apache to hand /shop/ and /product/… to index.php.
# The official image has AllowOverride All, but wp_install does not write .htaccess
# when the web root is owned by uid 1000 and PHP runs as www-data.
HTACCESS_SRC="$ROOT/ecom_sites/config/wordpress.htaccess"
if [[ -f "$HTACCESS_SRC" ]]; then
  install -m 644 "$HTACCESS_SRC" "$DATA_DIR/wp-wholesale/.htaccess"
  echo "==> Wrote $DATA_DIR/wp-wholesale/.htaccess"
else
  echo "missing $HTACCESS_SRC — /shop/ will 404 until rewrite rules exist" >&2
fi

echo "==> HPOS tables fallback (copy empty table defs from retail earth, apply on wholesale-db)"
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb-dump -uroot --no-data \
  earth wp_wc_orders wp_wc_orders_meta wp_wc_order_addresses wp_wc_order_operational_data \
  | docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot "${WHOLESALE_WORDPRESS_DB}"

echo "==> Patching wp-config.php Sillage + Redis constants (idempotent)"
sudo chown "${USER:-ubuntu}:${USER:-ubuntu}" "$DATA_DIR/wp-wholesale/wp-config.php" 2>/dev/null || true
sudo chmod 664 "$DATA_DIR/wp-wholesale/wp-config.php" 2>/dev/null || true
python3 - "$DATA_DIR/wp-wholesale/wp-config.php" \
  "${WHOLESALE_SILLAGE_SHARED_SECRET}" \
  "https://${WHOLESALE_DASH_DOMAIN}" \
  "${WHOLESALE_SILLAGE_DB}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
secret, dash, sil_db = sys.argv[2], sys.argv[3], sys.argv[4]
text = path.read_text()
# Official WordPress image evals WORDPRESS_CONFIG_EXTRA (compose env) on every
# request. Inserting the same define()s before "That's all" duplicates them.
config_extra = "eval($configExtra)" in text
defines = {
    "SILLAGE_SHARED_SECRET": secret,
    "SILLAGE_CORE_URL": "http://wholesale-core:4000",
    "SILLAGE_DASHBOARD_URL": dash,
    "SILLAGE_DB": sil_db,
    "SILLAGE_STOREFRONT_PROFILE": "wholesale",
    "DISABLE_WP_CRON": "true",
    "WP_REDIS_HOST": "valkey",
    "WP_REDIS_PORT": "6379",
    "WP_REDIS_PREFIX": "wholesale:",
    "WP_REDIS_DATABASE": "1",
    "WP_CACHE_KEY_SALT": "wholesale:",
}
changed = False
for key, val in defines.items():
    php_val = "true" if val == "true" else f"'{val}'"
    pattern = rf"define\(\s*'{re.escape(key)}'\s*,\s*[^)]+\)\s*;"
    repl = f"define( '{key}', {php_val} );"
    if re.search(pattern, text):
        new = re.sub(pattern, repl, text, count=1)
        if new != text:
            text = new
            changed = True
    elif config_extra:
        continue
    else:
        marker = "/* That's all, stop editing!"
        block = f"define( '{key}', {php_val} );\n"
        if marker in text:
            text = text.replace(marker, block + marker)
        else:
            text += "\n" + block
        changed = True
if changed:
    path.write_text(text)
    print("WP_CONFIG_PATCHED")
elif config_extra:
    print("WP_CONFIG_VIA_DOCKER_EXTRA")
else:
    print("WP_CONFIG_ALREADY")
PY

echo "==> Table-level grants now that Woo tables exist (skip missing)"
grant_if_table() {
  local db="$1" table="$2" sql="$3"
  local exists
  exists="$(docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot -N -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${db}' AND table_name='${table}'")"
  if [[ "$exists" == "1" ]]; then
    docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot -e "$sql"
  else
    echo "    skip ${db}.${table} (missing)"
  fi
}
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_posts "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_posts TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_postmeta "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_postmeta TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_terms "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_terms TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_termmeta "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_termmeta TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_term_taxonomy "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_term_taxonomy TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_term_relationships "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_term_relationships TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_product_meta_lookup "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_product_meta_lookup TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_product_attributes_lookup "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_product_attributes_lookup TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_category_lookup "GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_category_lookup TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_options "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_options TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_woocommerce_attribute_taxonomies "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_woocommerce_attribute_taxonomies TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_orders "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_orders TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_order_addresses "GRANT SELECT, INSERT, UPDATE ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_order_addresses TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_order_operational_data "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_order_operational_data TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_wc_orders_meta "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_wc_orders_meta TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_woocommerce_order_items "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_woocommerce_order_items TO 'sillage'@'%';"
grant_if_table "$WHOLESALE_WORDPRESS_DB" wp_woocommerce_order_itemmeta "GRANT SELECT ON \`${WHOLESALE_WORDPRESS_DB}\`.wp_woocommerce_order_itemmeta TO 'sillage'@'%';"
docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot -e "FLUSH PRIVILEGES;"

echo "==> Migrate sillage_wpf + apply wholesale profile"
docker exec wholesale-core bun run migrate
docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot "${WHOLESALE_SILLAGE_DB}" -e \
  "INSERT INTO sil_settings (setting_key, setting_value) VALUES ('wp_base_url', '${WHOLESALE_WP_BASE_URL}')
   ON DUPLICATE KEY UPDATE setting_value = IF(setting_value = '', VALUES(setting_value), setting_value);"

echo "==> lime SELECT on sillage_wpf plugin tables"
docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot <<SQL
GRANT SELECT ON \`${WHOLESALE_SILLAGE_DB}\`.sil_ean_index TO '${MYSQL_USER}'@'%';
GRANT SELECT ON \`${WHOLESALE_SILLAGE_DB}\`.sil_settings TO '${MYSQL_USER}'@'%';
GRANT SELECT ON \`${WHOLESALE_SILLAGE_DB}\`.sil_vendors TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL

echo "==> Caddy sites for wholesale shop + dashboard"
if [[ -f /etc/caddy/Caddyfile ]]; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  if ! grep -q "$WHOLESALE_SHOP_DOMAIN" /etc/caddy/Caddyfile; then
    MEDIA_PORT="${MEDIA_PORT:-105}"
    sudo tee -a /etc/caddy/Caddyfile >/dev/null <<EOF

${WHOLESALE_SHOP_DOMAIN} {
	@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
	handle @heavybot {
		respond "Forbidden" 403
	}
	handle_path /lps-media/* {
		header {
			-Server
			-Via
		}
		reverse_proxy localhost:${MEDIA_PORT} {
			header_down -Server
			header_down -Via
		}
	}
	handle /robots.txt {
		root * ${DATA_DIR}/sitemaps-wholesale
		file_server
		header Cache-Control "public, max-age=3600"
		header -Server
	}
	handle /wp-sitemap* {
		root * ${DATA_DIR}/sitemaps-wholesale
		file_server
		header Cache-Control "public, max-age=86400"
		header -Server
	}
	header {
		-Server
		-Via
		-X-Powered-By
	}
	reverse_proxy localhost:${WHOLESALE_ECOM_PORT} {
		header_down -Server
		header_down -Via
		header_down -X-Powered-By
	}
}
${WHOLESALE_DASH_DOMAIN} {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:${WHOLESALE_SILLAGE_PORT} {
		header_down -Server
		header_down -Via
	}
}
EOF
    echo "    appended Caddy sites"
  else
    echo "    Caddy already has $WHOLESALE_SHOP_DOMAIN"
  fi
  sudo caddy fmt --overwrite /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy
else
  echo "    /etc/caddy/Caddyfile not found — skip (laptop?)"
fi

echo "==> Recreate wholesale core/cron so env + secrets bind mounts apply"
docker compose --env-file "$ENV_FILE" --profile wholesale up -d wholesale-db wholesale-ecom wholesale-core wholesale-cron

# Apache (www-data uid 33) must own wp-content or dashboard core/plugin updates fail.
if [[ -x "$ROOT/scripts/fix-wp-content-perms.sh" ]]; then
  bash "$ROOT/scripts/fix-wp-content-perms.sh" --dir "$DATA_DIR/wp-wholesale"
fi

echo "==> Health"
sleep 2
curl -sS "http://127.0.0.1:${WHOLESALE_SILLAGE_PORT}/health" || true
echo
docker ps --filter name=wholesale- --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "Wholesale shop:      https://${WHOLESALE_SHOP_DOMAIN}"
echo "Wholesale dashboard: https://${WHOLESALE_DASH_DOMAIN}"
echo "  (add a DNS A record for ${WHOLESALE_DASH_DOMAIN} if it is not already pointing here)"
echo "Valkey prefix:       wpf:  database 1"
echo "Orders:              sandbox only (dry-run locked). Min order €300."
echo "DONE"
