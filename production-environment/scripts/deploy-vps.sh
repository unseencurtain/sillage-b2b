#!/usr/bin/env bash
# Deploy / update Sillage on a Ubuntu VPS from one compose + one .env.
#
# Usage (from repo root):
#   ./production-environment/scripts/deploy-vps.sh --host ovhe
#   # Domains optional — defaults from production-environment/.env, else live-shop defaults:
#   #   shop=wholesale.mirainikki.xyz dash=sillage-wholesale.mirainikki.xyz images=images.prinscosmetic.eu
#   ./production-environment/scripts/deploy-vps.sh \
#       --host ovhe \
#       [--shop …] [--dash …] [--images …] \
#       [--dns] [--ip 139.99.61.71] \
#       [--skip-build] [--fresh]
#
# Flow:
#   1) Hub images: rsync sillage-core onto the VPS and build+push THERE
#      (docker login lives on the host — ovhe is unseencurtain). Never docker build
#      on the laptop/agent that invoked this script. Default is --core-only so we
#      do not bump the live WordPress image.
#   2) rsync compose/config/plugin/overrides only
#   3) remote: docker compose pull && up -d && migrate
#
# Secrets live in remote ~/sillage/.env (created once; preserved on update).
set -euo pipefail

HOST=""
SHOP_DOMAIN=""
DASH_DOMAIN=""
IMAGES_DOMAIN=""
DO_DNS=0
IP=""
SKIP_BUILD=0
FRESH=0
CLONE_FROM=""

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --shop) SHOP_DOMAIN="${2:?}"; shift 2 ;;
    --dash) DASH_DOMAIN="${2:?}"; shift 2 ;;
    --images) IMAGES_DOMAIN="${2:?}"; shift 2 ;;
    --dns) DO_DNS=1; shift ;;
    --ip) IP="${2:?}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --clone-from) CLONE_FROM="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *)
      if [[ -z "$HOST" ]]; then HOST="$1"
      elif [[ -z "$SHOP_DOMAIN" ]]; then SHOP_DOMAIN="$1"
      elif [[ -z "$DASH_DOMAIN" ]]; then DASH_DOMAIN="$1"
      else echo "Unexpected arg: $1" >&2; usage
      fi
      shift
      ;;
  esac
done

: "${HOST:?SSH host required}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PE="$ROOT/production-environment"
# Prefer unified .env; fall back to legacy sillage-core/.env for vendor keys.
LOCAL_ENV_CANDIDATES=("$PE/.env" "$PE/sillage-core/.env")
LOCAL_ENV=""
for f in "${LOCAL_ENV_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then LOCAL_ENV="$f"; break; fi
done
if [[ -z "$LOCAL_ENV" ]]; then
  echo "Missing $PE/.env (or sillage-core/.env) — copy .env.example and fill passwords." >&2
  exit 1
fi

SSH=(ssh -F "${HOME}/.ssh/config" -o BatchMode=yes)
SCP=(scp -F "${HOME}/.ssh/config" -o BatchMode=yes)
RSYNC=(rsync -az -e "ssh -F ${HOME}/.ssh/config -o BatchMode=yes")
REMOTE_DIR=sillage
CHRONO="$ROOT/.deploy/deploy-CHRONOLOGY.md"
mkdir -p "$ROOT/.deploy"
CREDS="$ROOT/.deploy/vps-dashboard-${HOST}.txt"
START_EPOCH=$(date +%s)

# Staging defaults when CLI + local .env omit domains (ovhe).
DEFAULT_SHOP_DOMAIN=wholesale.mirainikki.xyz
DEFAULT_DASH_DOMAIN=sillage-wholesale.mirainikki.xyz
DEFAULT_IMAGES_DOMAIN=images.prinscosmetic.eu

log_step() {
  local msg="$1" now elapsed
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  elapsed=$(( $(date +%s) - START_EPOCH ))
  if [[ ! -f "$CHRONO" ]]; then
    printf '# Deploy chronology\n\n| UTC | Elapsed | Step |\n|---|---|---|\n' > "$CHRONO"
  fi
  printf '| %s | %dm%02ds | %s |\n' "$now" $((elapsed/60)) $((elapsed%60)) "$msg" | tee -a "$CHRONO"
}

# Domain precedence: CLI flags > remote ~/sillage/.env > local .env (non-localhost) > live-shop defaults.
CLI_SHOP="$SHOP_DOMAIN"
CLI_DASH="$DASH_DOMAIN"
CLI_IMAGES="$IMAGES_DOMAIN"
CLI_IP="$IP"

# shellcheck disable=SC1090
set -a; source "$LOCAL_ENV"; set +a
LOCAL_SHOP="${SHOP_DOMAIN:-}"
LOCAL_DASH="${DASH_DOMAIN:-}"
LOCAL_IMAGES="${IMAGES_DOMAIN:-}"
[[ -n "$CLI_IP" ]] && IP="$CLI_IP"

is_placeholder_domain() {
  case "${1:-}" in
    ""|localhost|*.localhost|shop.example.com|ops.example.com|images.example.com) return 0 ;;
    *) return 1 ;;
  esac
}

REMOTE_DOMAINS=$("${SSH[@]}" "$HOST" 'test -f ~/sillage/.env && set -a && source ~/sillage/.env && set +a && printf "%s\t%s\t%s" "${SHOP_DOMAIN:-}" "${DASH_DOMAIN:-}" "${IMAGES_DOMAIN:-}"' 2>/dev/null || true)
_R_SHOP=""; _R_DASH=""; _R_IMAGES=""
if [[ -n "$REMOTE_DOMAINS" ]]; then
  IFS=$'\t' read -r _R_SHOP _R_DASH _R_IMAGES <<<"$REMOTE_DOMAINS"
fi

pick_domain() {
  local cli="$1" remote="$2" localv="$3" fallback="$4"
  if [[ -n "$cli" ]]; then echo "$cli"; return; fi
  if [[ "$FRESH" -eq 0 ]] && ! is_placeholder_domain "$remote"; then echo "$remote"; return; fi
  if ! is_placeholder_domain "$localv"; then echo "$localv"; return; fi
  echo "$fallback"
}

SHOP_DOMAIN="$(pick_domain "$CLI_SHOP" "$_R_SHOP" "$LOCAL_SHOP" "$DEFAULT_SHOP_DOMAIN")"
DASH_DOMAIN="$(pick_domain "$CLI_DASH" "$_R_DASH" "$LOCAL_DASH" "$DEFAULT_DASH_DOMAIN")"
IMAGES_DOMAIN="$(pick_domain "$CLI_IMAGES" "$_R_IMAGES" "$LOCAL_IMAGES" "$DEFAULT_IMAGES_DOMAIN")"

log_step "START host=${HOST} shop=${SHOP_DOMAIN} dash=${DASH_DOMAIN} images=${IMAGES_DOMAIN:-none} skip_build=${SKIP_BUILD}"

if [[ -z "$IP" ]]; then
  IP=$("${SSH[@]}" "$HOST" 'curl -4 -sS --max-time 5 ifconfig.me || curl -4 -sS --max-time 5 icanhazip.com' | tr -d '[:space:]')
fi
: "${IP:?could not detect public IP}"
log_step "Public IP ${IP}"

if [[ "$DO_DNS" -eq 1 ]]; then
  if [[ -n "$IMAGES_DOMAIN" ]]; then
    bash "$PE/scripts/porkbun-dns.sh" "$SHOP_DOMAIN" "$DASH_DOMAIN" "$IP" "$IMAGES_DOMAIN"
  else
    bash "$PE/scripts/porkbun-dns.sh" "$SHOP_DOMAIN" "$DASH_DOMAIN" "$IP"
  fi
  log_step "DNS A records updated"
fi

TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
NAMESPACE="${DOCKERHUB_NAMESPACE:-}"
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$(docker info 2>/dev/null | sed -n 's/^ Username: //p' | head -1 || true)"
fi
NAMESPACE="${NAMESPACE:-unseencurtain}"
CORE_IMAGE="${NAMESPACE}/sillage-b2b:${TAG}"
WP_IMAGE="${NAMESPACE}/sillage-wordpress:${TAG}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Hub build on ${HOST} (docker login lives there; this machine does not docker build)"
  "${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/sillage-core ~/${REMOTE_DIR}/scripts"
  "${RSYNC[@]}" --delete \
    --exclude data --exclude logs --exclude node_modules --exclude web/dist \
    --exclude .feedscratch \
    "$PE/sillage-core/" "$HOST:~/${REMOTE_DIR}/sillage-core/"
  "${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
  "${SSH[@]}" "$HOST" "bash ~/${REMOTE_DIR}/scripts/build-push-images.sh --core-only --namespace '$NAMESPACE' --tag '$TAG'"
  log_step "Pushed ${CORE_IMAGE} from ${HOST}"
else
  log_step "Skipped image build; using ${CORE_IMAGE}"
fi

echo "==> rsync compose/config/plugin → ${HOST}:~/${REMOTE_DIR}"
"${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/ecom_sites/config ~/${REMOTE_DIR}/sillage-core/data ~/${REMOTE_DIR}/sillage-core/logs ~/ecom_sites/data/media ~/ecom_sites/data/wp/wp-content/plugins ~/${REMOTE_DIR}/.feedscratch ~/sillage/scripts"

"${RSYNC[@]}" "$PE/compose.yaml" "$HOST:~/${REMOTE_DIR}/compose.yaml"
"${RSYNC[@]}" "$PE/.env.example" "$HOST:~/${REMOTE_DIR}/.env.example"
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/config/" "$HOST:~/${REMOTE_DIR}/ecom_sites/config/"
"${RSYNC[@]}" "$PE/scripts/vps-bootstrap.sh" "$HOST:~/${REMOTE_DIR}/scripts/vps-bootstrap.sh"
"${RSYNC[@]}" "$PE/scripts/bootstrap-wholesale.sh" "$HOST:~/${REMOTE_DIR}/scripts/bootstrap-wholesale.sh"
"${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
"${RSYNC[@]}" "$PE/scripts/migrate-wholesale-own-db.sh" "$HOST:~/${REMOTE_DIR}/scripts/migrate-wholesale-own-db.sh"
"${RSYNC[@]}" "$PE/scripts/fix-wp-content-perms.sh" "$HOST:~/${REMOTE_DIR}/scripts/fix-wp-content-perms.sh"
if [[ -f "$PE/sillage-core/data/image_overrides.json" ]]; then
  "${RSYNC[@]}" "$PE/sillage-core/data/image_overrides.json" \
    "$HOST:~/${REMOTE_DIR}/sillage-core/data/image_overrides.json"
fi
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/"
"${SSH[@]}" "$HOST" 'if [[ -d ~/ecom_sites/data/wp-wholesale/wp-content/plugins ]]; then mkdir -p ~/ecom_sites/data/wp-wholesale/wp-content/plugins/sillage-bridge; fi'
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/ecom_sites/data/wp-wholesale/wp-content/plugins/sillage-bridge/" || true
# Keep a zero-byte php.ini if missing so the bind mount succeeds.
"${SSH[@]}" "$HOST" "touch ~/${REMOTE_DIR}/ecom_sites/config/php.ini; mkdir -p ~/ecom_sites/data/media ~/ecom_sites/data/sitemaps-wholesale ~/ecom_sites/data/wp-wholesale ~/ecom_sites/data/wholesale-db; touch ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.wholesale.env; echo '{}' > ~/${REMOTE_DIR}/sillage-core/data/image_overrides.wholesale.json; chmod 600 ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.wholesale.env"
log_step "Minimal rsync done"

if [[ -n "$CLONE_FROM" ]]; then
  echo "==> clone WordPress+DB from ${CLONE_FROM} → ${HOST}"
  "${SSH[@]}" "$HOST" 'mkdir -p ~/ecom_sites/data/wp ~/ecom_sites/data/wp-db'
  "${SSH[@]}" "$CLONE_FROM" 'tar -C ~/ecom_sites/data/wp --exclude=wp-content/cache -cf - .' \
    | "${SSH[@]}" "$HOST" 'tar -C ~/ecom_sites/data/wp -xf -'
  "${SSH[@]}" "$CLONE_FROM" 'set -a; source ~/sillage/.env 2>/dev/null || source ~/ecom_sites/.env; set +a; docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" ecom-db mariadb-dump -uroot --single-transaction --routines --triggers --all-databases' \
    | "${SSH[@]}" "$HOST" 'cat > /tmp/sillage-clone.sql'
  "${RSYNC[@]}" --delete \
    "$PE/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
    "$HOST:~/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/"
  log_step "Cloned wp + SQL from ${CLONE_FROM}"
fi

echo "==> ensure remote .env"
REMOTE_HAS_ENV=$("${SSH[@]}" "$HOST" "test -f ~/${REMOTE_DIR}/.env && echo yes || echo no")
if [[ "$REMOTE_HAS_ENV" != "yes" || "$FRESH" -eq 1 ]]; then
  SECRET=$(openssl rand -hex 32)
  SESSION=$(openssl rand -hex 32)
  PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  WP_ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  DBPASS=$(openssl rand -hex 16)
  MYSQL_ROOT=$(openssl rand -hex 16)
  MYSQL_PWD_GEN=$(openssl rand -hex 16)

  # Prefer existing DB passwords when updating an older split-env host.
  LEGACY_ECOM=$("${SSH[@]}" "$HOST" 'test -f ~/ecom_sites/.env && echo yes || echo no')
  if [[ "$LEGACY_ECOM" == "yes" && "$FRESH" -eq 0 ]]; then
    # shellcheck disable=SC2029
    eval "$("${SSH[@]}" "$HOST" 'set -a; source ~/ecom_sites/.env; set +a; printf "MYSQL_ROOT=%q\nMYSQL_PWD_GEN=%q\n" "$MYSQL_ROOT_PWD" "$MYSQL_PWD"')"
  fi
  LEGACY_CORE=$("${SSH[@]}" "$HOST" 'test -f ~/sillage-core/.env && echo yes || echo no')
  if [[ "$LEGACY_CORE" == "yes" && "$FRESH" -eq 0 ]]; then
    # shellcheck disable=SC2029
    eval "$("${SSH[@]}" "$HOST" 'set -a; source ~/sillage-core/.env; set +a; printf "DBPASS=%q\nSECRET=%q\nSESSION=%q\nPASS=%q\n" "$SILLAGE_DB_PASSWORD" "$SILLAGE_SHARED_SECRET" "$SESSION_SECRET" "$DASHBOARD_PASSWORD"')"
  fi

  LPS_URL="https://${IMAGES_DOMAIN:-images.${SHOP_DOMAIN#*.}}"
  if [[ -z "$IMAGES_DOMAIN" ]]; then
    LPS_URL="${LPS_MEDIA_BASE_URL:-https://images.prinscosmetic.eu}"
  else
    LPS_URL="https://${IMAGES_DOMAIN}"
  fi

  "${SSH[@]}" "$HOST" "cat > ~/${REMOTE_DIR}/.env" <<EOF
# Generated by deploy-vps.sh — do not commit
SILLAGE_CORE_IMAGE=${CORE_IMAGE}
WORDPRESS_IMAGE=${WP_IMAGE}
MARIADB_IMAGE=mariadb:latest
VALKEY_IMAGE=valkey/valkey:8-alpine
LPS_MEDIA_IMAGE=nginx:alpine

DATA_DIR=/home/ubuntu/ecom_sites/data
FEEDSCRATCH_DIR=/home/ubuntu/sillage/.feedscratch
SILLAGE_LOGS_DIR=/home/ubuntu/${REMOTE_DIR}/sillage-core/logs
IMAGE_OVERRIDES_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/image_overrides.json
SILLAGE_SECRETS_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env
MARIADB_CNF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/mariadb.vps.cnf
LPS_MEDIA_NGINX_CONF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/nginx-lps-media.conf
PHP_INI=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/php.ini

DB_BIND=127.0.0.1
DB_HOST_PORT=3308
ECOM_BIND=127.0.0.1
ECOM_PORT=106
MEDIA_BIND=127.0.0.1
MEDIA_PORT=105
SILLAGE_BIND=127.0.0.1
SILLAGE_PORT=4001

SHOP_DOMAIN=${SHOP_DOMAIN}
DASH_DOMAIN=${DASH_DOMAIN}
IMAGES_DOMAIN=${IMAGES_DOMAIN}
WP_BASE_URL=https://${SHOP_DOMAIN}
LPS_MEDIA_BASE_URL=${LPS_URL}

MYSQL_ROOT_PWD=${MYSQL_ROOT}
MYSQL_DB=earth_wpf
MYSQL_USER=lime
MYSQL_PWD=${MYSQL_PWD_GEN}

NODE_ENV=production
PORT=4000
LOG_LEVEL=info
DB_HOST=wholesale-db
DB_PORT=3306
DB_USER=sillage
SILLAGE_DB_PASSWORD=${DBPASS}
SILLAGE_DB=sillage_wpf
WORDPRESS_DB=earth_wpf
WP_TABLE_PREFIX=wp_
DB_CONNECTION_LIMIT=10
SILLAGE_SHARED_SECRET=${SECRET}

WHOLESALE_PERFUMES_USER=${WHOLESALE_PERFUMES_USER:-}
WHOLESALE_PERFUMES_TOKEN=${WHOLESALE_PERFUMES_TOKEN:-}
WHOLESALE_PERFUMES_CATALOG_URL=${WHOLESALE_PERFUMES_CATALOG_URL:-https://www.wholesale-perfumes.eu/xml/catalog/LovelyXml/en}
WHOLESALE_PERFUMES_STOCK_URL=${WHOLESALE_PERFUMES_STOCK_URL:-https://www.wholesale-perfumes.eu/xml/store/LovelyXml/EUR}
WHOLESALE_PERFUMES_API_BASE_URL=${WHOLESALE_PERFUMES_API_BASE_URL:-https://www.wholesale-perfumes.eu/api/v1}
BRASTY_PRODUCT_FEED_URL=${BRASTY_PRODUCT_FEED_URL:-}
BRASTY_AVAILABILITY_FEED_URL=${BRASTY_AVAILABILITY_FEED_URL:-}

DASHBOARD_USER=admin
DASHBOARD_PASSWORD=${PASS}
SESSION_SECRET=${SESSION}
FIXTURES_DIR=/app/.feedscratch
REDIS_URL=redis://wholesale-valkey:6379
EOF
  "${SSH[@]}" "$HOST" "chmod 600 ~/${REMOTE_DIR}/.env"

  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=admin
password=${PASS}
shop=https://${SHOP_DOMAIN}
wp_admin_user=admin
wp_admin_password=${WP_ADMIN_PASS}
ip=${IP}
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Created ~/${REMOTE_DIR}/.env + ${CREDS}"
else
  # Update image tags + domains/vendor keys; keep DB/dashboard secrets.
  # Non-empty local values win; empty local values leave remote secrets untouched.
  "${SSH[@]}" "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CORE_IMAGE='$CORE_IMAGE' WP_IMAGE='$WP_IMAGE' LOCAL_WPF_USER='${WHOLESALE_PERFUMES_USER:-}' LOCAL_WPF_TOKEN='${WHOLESALE_PERFUMES_TOKEN:-}' LOCAL_WPF_CATALOG='${WHOLESALE_PERFUMES_CATALOG_URL:-}' LOCAL_WPF_STOCK='${WHOLESALE_PERFUMES_STOCK_URL:-}' LOCAL_WPF_API='${WHOLESALE_PERFUMES_API_BASE_URL:-}' LOCAL_BRASTY_PRODUCT='${BRASTY_PRODUCT_FEED_URL:-}' LOCAL_BRASTY_AVAIL='${BRASTY_AVAILABILITY_FEED_URL:-}' python3 -" <<'PY'
import os, pathlib, re
p = pathlib.Path.home() / "sillage" / ".env"
text = p.read_text()
def set_key(text, key, value):
    if value is None:
        return text
    pat = re.compile(rf"^{re.escape(key)}=.*$", re.M)
    line = f"{key}={value}"
    if pat.search(text):
        return pat.sub(line, text)
    return text.rstrip() + "\n" + line + "\n"
shop = os.environ["SHOP_DOMAIN"]
dash = os.environ["DASH_DOMAIN"]
images = os.environ.get("IMAGES_DOMAIN") or ""
lps = f"https://{images}" if images else None
for k, v in [
    ("SILLAGE_CORE_IMAGE", os.environ["CORE_IMAGE"]),
    ("WORDPRESS_IMAGE", os.environ["WP_IMAGE"]),
    ("SHOP_DOMAIN", shop),
    ("DASH_DOMAIN", dash),
    ("IMAGES_DOMAIN", images),
    ("WP_BASE_URL", f"https://{shop}"),
    ("LPS_MEDIA_BASE_URL", lps),
    ("WHOLESALE_PERFUMES_USER", os.environ.get("LOCAL_WPF_USER") or None),
    ("WHOLESALE_PERFUMES_TOKEN", os.environ.get("LOCAL_WPF_TOKEN") or None),
    ("WHOLESALE_PERFUMES_CATALOG_URL", os.environ.get("LOCAL_WPF_CATALOG") or None),
    ("WHOLESALE_PERFUMES_STOCK_URL", os.environ.get("LOCAL_WPF_STOCK") or None),
    ("WHOLESALE_PERFUMES_API_BASE_URL", os.environ.get("LOCAL_WPF_API") or None),
    ("BRASTY_PRODUCT_FEED_URL", os.environ.get("LOCAL_BRASTY_PRODUCT") or None),
    ("BRASTY_AVAILABILITY_FEED_URL", os.environ.get("LOCAL_BRASTY_AVAIL") or None),
]:
    if v is not None and v != "":
        text = set_key(text, k, v)
p.write_text(text)
print("ENV_UPDATED")
PY
  # Refresh local creds file password from remote when possible
  REMOTE_PASS=$("${SSH[@]}" "$HOST" 'set -a; source ~/sillage/.env; set +a; printf %s "$DASHBOARD_PASSWORD"')
  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=admin
password=${REMOTE_PASS}
shop=https://${SHOP_DOMAIN}
ip=${IP}
updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Updated image tags in existing .env"
fi

echo "==> remote pull + up"
"${SSH[@]}" "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CLONE_MODE='${CLONE_FROM:+1}' FRESH='$FRESH' WP_ADMIN_PASS='${WP_ADMIN_PASS:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$HOME/sillage"
set -a; source .env; set +a

WP_PORT="${ECOM_PORT:-104}"
MEDIA_PORT="${MEDIA_PORT:-105}"

IMAGES_SITE_BLOCK=""
if [[ -n "${IMAGES_DOMAIN:-}" ]]; then
  IMAGES_SITE_BLOCK="${IMAGES_DOMAIN} {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:${MEDIA_PORT} {
		header_down -Server
		header_down -Via
	}
}"
fi

WPF_SITE_BLOCK=""
if [[ -n "${WHOLESALE_SHOP_DOMAIN:-${WPF_SHOP_DOMAIN:-}}" ]]; then
  WHOLESALE_SHOP_DOMAIN="${WHOLESALE_SHOP_DOMAIN:-${WPF_SHOP_DOMAIN}}"
  WHOLESALE_ECOM_PORT="${WHOLESALE_ECOM_PORT:-${WPF_ECOM_PORT:-106}}"
  WHOLESALE_SILLAGE_PORT="${WHOLESALE_SILLAGE_PORT:-${WPF_SILLAGE_PORT:-4001}}"
  WHOLESALE_DASH_DOMAIN="${WHOLESALE_DASH_DOMAIN:-${WPF_DASH_DOMAIN:-sillage-wholesale.mirainikki.xyz}}"
  WPF_SITE_BLOCK="${WHOLESALE_SHOP_DOMAIN} {
	@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
	handle @heavybot {
		respond \"Forbidden\" 403
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
		root * /home/ubuntu/ecom_sites/data/sitemaps-wholesale
		file_server
		header Cache-Control \"public, max-age=3600\"
		header -Server
	}
	handle /wp-sitemap* {
		root * /home/ubuntu/ecom_sites/data/sitemaps-wholesale
		file_server
		header Cache-Control \"public, max-age=86400\"
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
}"
fi

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${SHOP_DOMAIN} {
	# AI training crawlers walk every /product and /brand page. Prefork PHP
	# cannot survive that on a ~4 GB box. Images CDN stays open (cheap files).
	# See docs/CRAWLER-SHIELD.md
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
	# Product listing for Google: static files from Bun, not PHP.
	# Fast price/stock sync does not rewrite these. See docs/SEO.md
	handle /robots.txt {
		root * /home/ubuntu/ecom_sites/data/sitemaps
		file_server
		header Cache-Control "public, max-age=3600"
		header -Server
	}
	handle /wp-sitemap* {
		root * /home/ubuntu/ecom_sites/data/sitemaps
		file_server
		header Cache-Control "public, max-age=86400"
		header -Server
	}
	header {
		-Server
		-Via
		-X-Powered-By
	}
	reverse_proxy localhost:${WP_PORT} {
		header_down -Server
		header_down -Via
		header_down -X-Powered-By
	}
}
${DASH_DOMAIN} {
	header {
		-Server
		-Via
	}
	reverse_proxy localhost:4000 {
		header_down -Server
		header_down -Via
	}
}
${IMAGES_SITE_BLOCK}
${WPF_SITE_BLOCK}
EOF
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy

docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

# Stop legacy split compose projects if they still own the container names.
if [[ -f "$HOME/redis/compose.yaml" ]]; then
  (cd "$HOME/redis" && docker compose down 2>/dev/null) || true
fi
if [[ -f "$HOME/ecom_sites/compose.yaml" ]]; then
  (cd "$HOME/ecom_sites" && docker compose down 2>/dev/null) || true
fi

mkdir -p "$DATA_DIR/media" "$DATA_DIR/wp-wholesale" "$DATA_DIR/wholesale-db" \
  "$HOME/sillage/sillage-core/logs" "$HOME/sillage/.feedscratch"
# Ensure image overrides + secrets overlay files exist for bind mounts (file, not directory).
[[ -f "$HOME/sillage/sillage-core/data/image_overrides.json" ]] \
  || echo '{}' > "$HOME/sillage/sillage-core/data/image_overrides.json"
[[ -f "$HOME/sillage/sillage-core/data/secrets.overlay.env" ]] \
  || : > "$HOME/sillage/sillage-core/data/secrets.overlay.env"
chmod 600 "$HOME/sillage/sillage-core/data/secrets.overlay.env" 2>/dev/null || true

docker compose --env-file .env pull
docker compose --env-file .env up -d wholesale-db wholesale-valkey
echo "Waiting for MariaDB..."
for i in $(seq 1 60); do
  if docker exec -i wholesale-db healthcheck.sh --connect --innodb_initialized </dev/null 2>/dev/null; then
    break
  fi
  sleep 2
done

if [[ -f /tmp/sillage-clone.sql ]]; then
  echo "Importing cloned SQL..."
  docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" wholesale-db mariadb -uroot < /tmp/sillage-clone.sql
  rm -f /tmp/sillage-clone.sql
fi

docker compose --env-file .env up -d

echo "Waiting for WordPress files..."
for i in $(seq 1 90); do
  if [[ -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
    break
  fi
  sleep 2
done

NEED_FRESH=0
if [[ ! -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
  NEED_FRESH=1
fi
if [[ -z "${CLONE_MODE:-}" && ( "$NEED_FRESH" -eq 1 || "${FRESH:-0}" == "1" ) ]]; then
  echo "Fetching WooCommerce / redis-cache / Blocksy from wordpress.org..."
  sudo chown -R "$USER":"$USER" "$DATA_DIR/wp-wholesale/wp-content" 2>/dev/null || true
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

  # Wait again for wp-config from the official image entrypoint
  for i in $(seq 1 60); do
    [[ -f "$DATA_DIR/wp-wholesale/wp-config.php" ]] && break
    sleep 2
  done

  if [[ -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
    cat > /tmp/wp-fresh-install.php <<'PHP'
<?php
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');
$_SERVER['HTTP_HOST'] = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['SERVER_NAME'] = $_SERVER['HTTP_HOST'];
$_SERVER['REQUEST_URI'] = '/';
require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
$url = 'https://' . $_SERVER['HTTP_HOST'];
echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;
if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $r = wp_install('Cosmetic', 'admin', 'admin@' . $_SERVER['HTTP_HOST'], true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . PHP_EOL;
}
update_option('siteurl', $url);
update_option('home', $url);
update_option('woocommerce_currency', 'EUR');
require_once ABSPATH . 'wp-admin/includes/plugin.php';
foreach (['woocommerce/woocommerce.php', 'redis-cache/redis-cache.php', 'sillage-bridge/sillage-bridge.php'] as $p) {
    if (!file_exists(WP_PLUGIN_DIR . '/' . $p)) { echo "$p missing\n"; continue; }
    $res = activate_plugin($p);
    echo $p . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' ok') . PHP_EOL;
}
if (wp_get_theme('blocksy')->exists()) {
    switch_theme('blocksy');
}
echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
PHP
    docker cp /tmp/wp-fresh-install.php wholesale-ecom:/tmp/wp-fresh-install.php
    docker exec -e SHOP_DOMAIN="$SHOP_DOMAIN" -e WP_ADMIN_PASS="${WP_ADMIN_PASS:-}" wholesale-ecom php /tmp/wp-fresh-install.php
  fi
fi

export SILLAGE_DASHBOARD_URL="https://${DASH_DOMAIN}"
if [[ -f "$HOME/sillage/scripts/fix-wp-content-perms.sh" ]]; then
  bash "$HOME/sillage/scripts/fix-wp-content-perms.sh" --dir "$DATA_DIR/wp-wholesale" || true
fi
if [[ -f "$DATA_DIR/wp-wholesale/wp-config.php" ]]; then
  sudo chown "$USER":"$USER" "$DATA_DIR/wp-wholesale/wp-config.php" || true
  sudo chmod 664 "$DATA_DIR/wp-wholesale/wp-config.php" || true
  # Point bootstrap at unified env
  bash "$HOME/sillage/scripts/vps-bootstrap.sh"
  WP="$DATA_DIR/wp-wholesale/wp-config.php"
  grep -q DISABLE_WP_CRON "$WP" || python3 - <<PY
from pathlib import Path
p = Path("$WP")
t = p.read_text()
b = "\\ndefine( 'DISABLE_WP_CRON', true );\\n"
m = "/* That's all, stop editing!"
p.write_text(t.replace(m, b+m) if m in t else t+b)
PY
fi

if [[ -n "${CLONE_MODE:-}" ]]; then
  docker exec wholesale-ecom php -r "
    require '/var/www/html/wp-load.php';
    \$url = 'https://${SHOP_DOMAIN}';
    update_option('siteurl', \$url);
    update_option('home', \$url);
    echo \"urls=\$url\\n\";
  " || true
fi

cd "$HOME/sillage"
set -a; source .env; set +a
if [[ -f ecom_sites/config/sillage-grants.sql ]]; then
  sed "s|__SILLAGE_DB_PASSWORD__|${SILLAGE_DB_PASSWORD}|g" ecom_sites/config/sillage-grants.sql \
    | docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PWD" wholesale-db mariadb -uroot
fi
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" wholesale-db mariadb -uroot \
  -e "GRANT SELECT, INSERT, UPDATE ON earth_wpf.wp_wc_order_addresses TO 'sillage'@'%'; FLUSH PRIVILEGES;" || true

docker compose --env-file .env up -d
docker exec wholesale-core bun run migrate
# Drop unused Hub tags / dangling layers so day-2 deploys do not pile up 20+ images.
docker image prune -af
echo "Images after prune:"
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PWD" wholesale-db mariadb -uroot \
  -e "GRANT SELECT ON sillage_wpf.sil_ean_index TO 'lime'@'%'; GRANT SELECT ON sillage_wpf.sil_settings TO 'lime'@'%'; GRANT SELECT ON sillage_wpf.sil_vendors TO 'lime'@'%'; FLUSH PRIVILEGES;" || true
docker exec wholesale-ecom php -r 'require "/var/www/html/wp-load.php"; require_once ABSPATH."wp-admin/includes/plugin.php"; activate_plugin("sillage-bridge/sillage-bridge.php"); echo "plugin ok\n";' || true

curl -sS "http://127.0.0.1:${SILLAGE_PORT:-4001}/health" || true
echo
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
echo "Deploy finished. Open https://${DASH_DOMAIN}"
REMOTE

log_step "Remote bring-up finished"
TOTAL=$(( $(date +%s) - START_EPOCH ))
log_step "DONE total=${TOTAL}s (~$((TOTAL/60))m$((TOTAL%60))s)"

echo
echo "==> done"
echo "Shop:      https://${SHOP_DOMAIN}"
echo "Dashboard: https://${DASH_DOMAIN}"
[[ -n "$IMAGES_DOMAIN" ]] && echo "Images:    https://${IMAGES_DOMAIN}"
echo "Compose:   ${HOST}:~/${REMOTE_DIR}/compose.yaml"
echo "Env:       ${HOST}:~/${REMOTE_DIR}/.env"
echo "Creds:     $CREDS"
echo "Images:    ${CORE_IMAGE}  ${WP_IMAGE}"
