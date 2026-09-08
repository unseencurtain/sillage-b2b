#!/usr/bin/env bash
# Guard: an empty Ubuntu VPS must come up from this wholesale repo alone.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PE="$ROOT/production-environment"
fail=0

check() {
  local msg="$1"
  shift
  if "$@"; then
    echo "ok  $msg"
  else
    echo "FAIL  $msg" >&2
    fail=1
  fi
}

check "bootstrap-host installs unzip" \
  grep -qE 'apt-get install -y .*unzip' "$PE/scripts/bootstrap-host.sh"

check "WordPress image is pinned, not wordpress:latest" \
  grep -qE '^FROM wordpress:7\.1-php8\.3-apache$' "$PE/wordpress-image/Dockerfile"

check "build-push-images defaults to core+WordPress" \
  grep -qE '^WITH_WORDPRESS=1$' "$PE/scripts/build-push-images.sh"

check "build-push-images tags sillage-b2b not sillage-core" \
  grep -q 'CORE_REPO="${NAMESPACE}/sillage-b2b"' "$PE/scripts/build-push-images.sh"

check "deploy-vps defaults to core+WordPress" \
  grep -qE '^WITH_WORDPRESS=1$' "$PE/scripts/deploy-vps.sh"

check "deploy installs into ~/sillage-wholesale" \
  grep -qE '^REMOTE_DIR=sillage-wholesale$' "$PE/scripts/deploy-vps.sh"

check "remote first-boot runs wp-fresh-install.php inside wholesale-ecom" \
  grep -q 'wholesale-ecom php /tmp/wp-fresh-install.php' "$PE/scripts/deploy-vps.sh"

check "compose includes wholesale-media for empty-VPS CDN" \
  grep -q 'container_name: wholesale-media' "$PE/compose.yaml"

check "compose has no retail ecom-db" \
  grep -qv 'container_name: ecom-db' "$PE/compose.yaml"

check "first-boot PHP enables HPOS" \
  grep -q "woocommerce_custom_orders_table_enabled" "$PE/scripts/wp-fresh-install.php"

check "HANDOFF Memory treats empty-VPS WordPress as first-class" \
  grep -q 'Empty VPS' "$ROOT/docs/HANDOFF.md"

check "docs no longer claim fresh deploy leaves HPOS off" \
  grep -qv 'fresh deploy leaves HPOS' "$ROOT/docs/VPS-DEPLOY.md"

if [[ "$fail" -ne 0 ]]; then
  echo "empty-VPS contract failed" >&2
  exit 1
fi
echo "empty-VPS contract passed"
