#!/usr/bin/env bash
#
# Ask the bridge plugin to invalidate WooCommerce's caches for an import it slept through.
#
# Runs on the VPS, from the stack directory (needs .env).
#
# sillage-core writes products with raw SQL, so none of WooCommerce's invalidation hooks fire; the
# engine calls this same endpoint at the end of every sync. It only fails when the bridge plugin
# was inactive at the time — and with Valkey object caching on, WordPress's cached post counts have
# no expiry, so the shop then shows an empty catalogue indefinitely even though every row is
# committed. That is a cache to flush, not a 40-minute re-import.
#
# Safe to run at any time: it invalidates caches and writes no product data.
set -euo pipefail

[[ -f .env ]] || { echo "no .env in $PWD — run this from the stack directory" >&2; exit 1; }
set -a; . ./.env; set +a

: "${SILLAGE_SHARED_SECRET:?missing from .env}"
: "${SHOP_DOMAIN:?missing from .env}"
PORT="${ECOM_PORT:?missing from .env}"

# The plugin authenticates an HMAC of the raw body, so an empty body signs the empty string.
SIG="sha256=$(printf '' | openssl dgst -sha256 -hmac "$SILLAGE_SHARED_SECRET" | awk '{print $NF}')"

# Go straight at the container: the public hostname may still point at the old box mid-migration,
# and Caddy is not in the path for something this slow. X-Forwarded-Proto keeps WordPress from
# issuing an https redirect that curl would not follow.
code=$(curl -sS -o /tmp/wp-finalize.out -w '%{http_code}' --max-time 300 \
  -X POST "http://127.0.0.1:${PORT}/wp-json/sillage/v1/finalize" \
  -H "Host: ${SHOP_DOMAIN}" \
  -H "X-Forwarded-Proto: https" \
  -H "X-Sillage-Signature: ${SIG}" \
  -H 'Content-Length: 0')

if [[ "$code" == "404" ]]; then
  echo "finalize 404: the sillage-bridge plugin is not active — activate it in wp-admin, then re-run" >&2
  exit 1
fi
if [[ "$code" != "200" ]]; then
  echo "finalize failed with HTTP ${code}" >&2
  head -c 300 /tmp/wp-finalize.out >&2
  echo >&2
  exit 1
fi

echo "finalize ok: $(head -c 300 /tmp/wp-finalize.out)"
