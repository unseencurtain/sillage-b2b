#!/usr/bin/env bash
# One-shot on ovhe: rename wpf-* → wholesale-* and move earth_wpf / sillage_wpf
# off retail ecom-db onto wholesale-db.
#
#   cd ~/sillage && bash scripts/migrate-wholesale-own-db.sh
#
# Does not reinstall WordPress. Does not live-dispatch. Does not print secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DATA_DIR="${DATA_DIR:-$HOME/ecom_sites/data}"
USER_NAME="${USER:-ubuntu}"

copy_env_if_missing() {
  local dest="$1" src="$2"
  python3 - "$ENV_FILE" "$dest" "$src" <<'PY'
from pathlib import Path
import sys
path, dest, src = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
lines = text.splitlines()
vals = {}
for line in lines:
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    vals[k] = v
if dest in vals and vals[dest] != "":
    raise SystemExit(0)
if src not in vals or vals[src] == "":
    raise SystemExit(0)
# append dest from src without printing
with path.open("a") as f:
    if not text.endswith("\n"):
        f.write("\n")
    f.write(f"{dest}={vals[src]}\n")
print(f"    copied {src} → {dest}")
PY
}

set_env_key() {
  local key="$1" val="$2"
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
}

echo "==> Copying WHOLESALE_* keys from any leftover WPF_* (values not printed)"
copy_env_if_missing WHOLESALE_SHOP_DOMAIN WPF_SHOP_DOMAIN
copy_env_if_missing WHOLESALE_DASH_DOMAIN WPF_DASH_DOMAIN
copy_env_if_missing WHOLESALE_WP_BASE_URL WPF_WP_BASE_URL
copy_env_if_missing WHOLESALE_SILLAGE_SHARED_SECRET WPF_SILLAGE_SHARED_SECRET
copy_env_if_missing WHOLESALE_WP_ADMIN_PASS WPF_WP_ADMIN_PASS
copy_env_if_missing WHOLESALE_MYSQL_ROOT_PWD MYSQL_ROOT_PWD
copy_env_if_missing WHOLESALE_MYSQL_PWD MYSQL_PWD
set_env_key WHOLESALE_SHOP_DOMAIN "${WHOLESALE_SHOP_DOMAIN:-${WPF_SHOP_DOMAIN:-wholesale.mirainikki.xyz}}"
set_env_key WHOLESALE_DASH_DOMAIN "${WHOLESALE_DASH_DOMAIN:-${WPF_DASH_DOMAIN:-sillage-wholesale.mirainikki.xyz}}"
set_env_key WHOLESALE_WP_BASE_URL "${WHOLESALE_WP_BASE_URL:-https://wholesale.mirainikki.xyz}"
set_env_key WHOLESALE_WORDPRESS_INTERNAL_URL "http://wholesale-ecom"
set_env_key WHOLESALE_WORDPRESS_DB "${WHOLESALE_WORDPRESS_DB:-earth_wpf}"
set_env_key WHOLESALE_SILLAGE_DB "${WHOLESALE_SILLAGE_DB:-sillage_wpf}"
set_env_key WHOLESALE_ECOM_PORT "${WHOLESALE_ECOM_PORT:-${WPF_ECOM_PORT:-106}}"
set_env_key WHOLESALE_SILLAGE_PORT "${WHOLESALE_SILLAGE_PORT:-${WPF_SILLAGE_PORT:-4001}}"
set_env_key WHOLESALE_DB_HOST_PORT "3308"
set_env_key WHOLESALE_ECOM_BIND "127.0.0.1"
set_env_key WHOLESALE_SILLAGE_BIND "127.0.0.1"
set_env_key COMPOSE_PROFILES "wholesale"
set_env_key WHOLESALE_SITEMAP_HOST_DIR "${DATA_DIR}/sitemaps-wholesale"
set_env_key WHOLESALE_SILLAGE_SECRETS_FILE "$ROOT/sillage-core/data/secrets.overlay.wholesale.env"
set_env_key WHOLESALE_IMAGE_OVERRIDES_FILE "$ROOT/sillage-core/data/image_overrides.wholesale.json"
set_env_key WHOLESALE_LOGS_DIR "$ROOT/sillage-core/logs-wholesale"
set_env_key WHOLESALE_MARIADB_CNF "$ROOT/ecom_sites/config/mariadb.wholesale.cnf"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "==> Stopping leftover wpf-* containers (if any)"
for c in wpf-ecom wpf-core wpf-cron; do
  docker inspect "$c" >/dev/null 2>&1 && docker stop "$c" || true
done

echo "==> Renaming host dirs (idempotent)"
if [[ -d "$DATA_DIR/wp-wpf" && ! -d "$DATA_DIR/wp-wholesale" ]]; then
  mv "$DATA_DIR/wp-wpf" "$DATA_DIR/wp-wholesale"
  echo "    wp-wpf → wp-wholesale"
fi
if [[ -d "$DATA_DIR/sitemaps-wpf" && ! -d "$DATA_DIR/sitemaps-wholesale" ]]; then
  mv "$DATA_DIR/sitemaps-wpf" "$DATA_DIR/sitemaps-wholesale"
  echo "    sitemaps-wpf → sitemaps-wholesale"
fi
mkdir -p "$DATA_DIR/wp-wholesale" "$DATA_DIR/sitemaps-wholesale" "$DATA_DIR/wholesale-db" \
  "$ROOT/sillage-core/logs-wholesale"

if [[ -f "$ROOT/sillage-core/data/secrets.overlay.wpf.env" && ! -s "$ROOT/sillage-core/data/secrets.overlay.wholesale.env" ]]; then
  mv "$ROOT/sillage-core/data/secrets.overlay.wpf.env" "$ROOT/sillage-core/data/secrets.overlay.wholesale.env"
fi
if [[ -f "$ROOT/sillage-core/data/image_overrides.wpf.json" && ! -f "$ROOT/sillage-core/data/image_overrides.wholesale.json" ]]; then
  mv "$ROOT/sillage-core/data/image_overrides.wpf.json" "$ROOT/sillage-core/data/image_overrides.wholesale.json"
fi
[[ -f "$ROOT/sillage-core/data/secrets.overlay.wholesale.env" ]] || : > "$ROOT/sillage-core/data/secrets.overlay.wholesale.env"
[[ -f "$ROOT/sillage-core/data/image_overrides.wholesale.json" ]] || echo '{}' > "$ROOT/sillage-core/data/image_overrides.wholesale.json"
chmod 600 "$ROOT/sillage-core/data/secrets.overlay.wholesale.env" 2>/dev/null || true

echo "==> Pointing host Caddy sitemaps at sitemaps-wholesale (retail block untouched)"
if [[ -f /etc/caddy/Caddyfile ]] && grep -q 'sitemaps-wpf' /etc/caddy/Caddyfile; then
  sudo sed -i 's|sitemaps-wpf|sitemaps-wholesale|g' /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy
fi

WS_MYSQL_PWD="${WHOLESALE_MYSQL_ROOT_PWD:-$MYSQL_ROOT_PWD}"
RETAIL_MYSQL_PWD="${MYSQL_ROOT_PWD}"
DUMP_DIR="$(mktemp -d /tmp/wholesale-db-migrate.XXXXXX)"
chmod 700 "$DUMP_DIR"
cleanup() { rm -rf "$DUMP_DIR"; }
trap cleanup EXIT

have_db() {
  local container="$1" pwd="$2" db="$3"
  docker exec -e MYSQL_PWD="$pwd" "$container" mariadb -uroot -N -e "SHOW DATABASES LIKE '${db}';" 2>/dev/null | grep -qx "$db"
}

echo "==> Dumping wholesale schemas from ecom-db if they still live there"
if docker inspect ecom-db >/dev/null 2>&1 && have_db ecom-db "$RETAIL_MYSQL_PWD" earth_wpf; then
  docker exec -e MYSQL_PWD="$RETAIL_MYSQL_PWD" ecom-db \
    mariadb-dump -uroot --single-transaction --routines --triggers --databases earth_wpf > "$DUMP_DIR/earth_wpf.sql"
  docker exec -e MYSQL_PWD="$RETAIL_MYSQL_PWD" ecom-db \
    mariadb-dump -uroot --single-transaction --routines --triggers --databases sillage_wpf > "$DUMP_DIR/sillage_wpf.sql"
  echo "    dumped earth_wpf + sillage_wpf from ecom-db"
else
  echo "    ecom-db has no earth_wpf (already moved, or never created)"
fi

echo "==> Starting wholesale-db"
docker compose --env-file "$ENV_FILE" --profile wholesale up -d wholesale-db
for i in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db healthcheck.sh --connect --innodb_initialized </dev/null 2>/dev/null; then
    break
  fi
  sleep 2
done
docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db healthcheck.sh --connect --innodb_initialized </dev/null

if [[ -s "$DUMP_DIR/earth_wpf.sql" ]]; then
  echo "==> Importing dumps into wholesale-db"
  docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot < "$DUMP_DIR/earth_wpf.sql"
  docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot < "$DUMP_DIR/sillage_wpf.sql"
fi

echo "==> Grants on wholesale-db"
GRANTS="$ROOT/ecom_sites/config/sillage-grants-wholesale.sql"
sed -e "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" \
    -e "s|__MYSQL_USER__|${MYSQL_USER:-lime}|g" \
    "$GRANTS" \
  | docker exec -i -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot

WP_CONFIG="$DATA_DIR/wp-wholesale/wp-config.php"
if [[ -f "$WP_CONFIG" ]]; then
  echo "==> Pointing WordPress DB_HOST at wholesale-db"
  sudo chown "$USER_NAME:$USER_NAME" "$WP_CONFIG" 2>/dev/null || true
  sudo chmod 664 "$WP_CONFIG" 2>/dev/null || true
  python3 - "$WP_CONFIG" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text = path.read_text()
new = re.sub(
    r"define\(\s*'DB_HOST'\s*,\s*'[^']*'\s*\)",
    "define( 'DB_HOST', 'wholesale-db' )",
    text,
    count=1,
)
# Redis prefix leftover from wpf-* bring-up
new = new.replace("'wpf:'", "'wholesale:'")
new = new.replace("http://wpf-core:4000", "http://wholesale-core:4000")
new = new.replace("http://wpf-ecom", "http://wholesale-ecom")
if new != text:
    path.write_text(new)
    print("    patched wp-config.php")
else:
    print("    wp-config.php already pointed at wholesale-db")
PY
fi

echo "==> Removing leftover wpf-* containers"
for c in wpf-ecom wpf-core wpf-cron; do
  docker rm -f "$c" 2>/dev/null || true
done

echo "==> Starting wholesale-* stack"
docker compose --env-file "$ENV_FILE" --profile wholesale up -d \
  wholesale-db wholesale-ecom wholesale-core wholesale-cron

echo "==> Dropping wholesale schemas from retail ecom-db (if still present)"
if docker inspect ecom-db >/dev/null 2>&1 && have_db ecom-db "$RETAIL_MYSQL_PWD" earth_wpf; then
  docker exec -e MYSQL_PWD="$RETAIL_MYSQL_PWD" ecom-db mariadb -uroot -e \
    "DROP DATABASE IF EXISTS earth_wpf; DROP DATABASE IF EXISTS sillage_wpf;"
  echo "    dropped earth_wpf + sillage_wpf from ecom-db"
fi

echo "==> Health"
sleep 8
echo "    docker ps (expect wholesale-* not wpf-*):"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'NAMES|ecom|sillage|wholesale|wpf|valkey' || true
echo -n "    retail shop: "
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 20 https://prinscosmetic.eu/ || true
echo -n "    wholesale shop: "
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 20 https://wholesale.mirainikki.xyz/ || true
echo -n "    wholesale health: "
curl -sS --max-time 10 http://127.0.0.1:4001/health || true
echo
echo -n "    ecom-db databases: "
docker exec -e MYSQL_PWD="$RETAIL_MYSQL_PWD" ecom-db mariadb -uroot -N -e "SHOW DATABASES;" | tr '\n' ' '
echo
echo -n "    wholesale-db databases: "
docker exec -e MYSQL_PWD="$WS_MYSQL_PWD" wholesale-db mariadb -uroot -N -e "SHOW DATABASES;" | tr '\n' ' '
echo
echo "Done. docker ps must show wholesale-ecom / wholesale-core / wholesale-db, not wpf-*."
