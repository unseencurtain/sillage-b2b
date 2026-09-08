#!/usr/bin/env bash
# Run on the VPS as ubuntu. Creates sillage DB user, patches wp-config.
# Expects unified env at ~/sillage/.env (falls back to legacy split envs).
set -euo pipefail

set -a
# shellcheck disable=SC1090
if [[ -f "$HOME/sillage/.env" ]]; then
  source "$HOME/sillage/.env"
elif [[ -f "$HOME/ecom_sites/.env" && -f "$HOME/sillage-core/.env" ]]; then
  source "$HOME/ecom_sites/.env"
  source "$HOME/sillage-core/.env"
else
  echo "Missing ~/sillage/.env" >&2
  exit 1
fi
set +a

WP_DB="${WORDPRESS_DB:-earth}"
DATA_DIR="${DATA_DIR:-$HOME/ecom_sites/data}"

docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${SILLAGE_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'sillage'@'%' IDENTIFIED BY '${SILLAGE_DB_PASSWORD}';
ALTER USER 'sillage'@'%' IDENTIFIED BY '${SILLAGE_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${SILLAGE_DB}\`.* TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_posts TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_postmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_terms TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_termmeta TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_term_taxonomy TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_term_relationships TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_product_meta_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_product_attributes_lookup TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${WP_DB}\`.wp_wc_category_lookup TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_options TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_wc_orders TO 'sillage'@'%';
GRANT SELECT, INSERT, UPDATE ON \`${WP_DB}\`.wp_wc_order_addresses TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_wc_order_operational_data TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_order_items TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_order_itemmeta TO 'sillage'@'%';
GRANT SELECT ON \`${WP_DB}\`.wp_woocommerce_attribute_taxonomies TO 'sillage'@'%';
FLUSH PRIVILEGES;
SQL
echo "DB_USER_OK"

WPCONFIG="$DATA_DIR/wp/wp-config.php"
DASH_URL="${SILLAGE_DASHBOARD_URL:-https://${DASH_DOMAIN:-sillage.prinscosmetic.eu}}"
if [[ ! -f "$WPCONFIG" ]]; then
  echo "WP_CONFIG_MISSING — start ecom first so WordPress can create wp-config.php" >&2
  exit 1
fi
python3 - "$WPCONFIG" "$SILLAGE_SHARED_SECRET" "$DASH_URL" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
secret = sys.argv[2]
dash = sys.argv[3]
text = path.read_text()
block = f"""
/* Sillage bridge */
define( 'SILLAGE_SHARED_SECRET', '{secret}' );
define( 'SILLAGE_CORE_URL', 'http://sillage-core:4000' );
define( 'SILLAGE_DASHBOARD_URL', '{dash}' );
define( 'SILLAGE_DB', 'sillage' );

"""
changed = False
if "SILLAGE_SHARED_SECRET" not in text:
    marker = "/* That's all, stop editing!"
    if marker in text:
        text = text.replace(marker, block + marker)
    else:
        text += "\n" + block
    changed = True
else:
    import re
    new = re.sub(
        r"define\(\s*'SILLAGE_DASHBOARD_URL'\s*,\s*'[^']*'\s*\)\s*;",
        f"define( 'SILLAGE_DASHBOARD_URL', '{dash}' );",
        text,
    )
    new2 = re.sub(
        r"define\(\s*'SILLAGE_SHARED_SECRET'\s*,\s*'[^']*'\s*\)\s*;",
        f"define( 'SILLAGE_SHARED_SECRET', '{secret}' );",
        new,
    )
    if new2 != text:
        text = new2
        changed = True
if changed:
    path.write_text(text)
    print("WP_CONFIG_PATCHED")
else:
    print("WP_CONFIG_ALREADY")
PY

mkdir -p "${SILLAGE_LOGS_DIR:-$HOME/sillage/sillage-core/logs}"
echo "BOOTSTRAP_DONE"
