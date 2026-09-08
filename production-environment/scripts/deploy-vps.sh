#!/usr/bin/env bash
# Deploy / update the wholesale-perfumes shop on a Ubuntu VPS from one compose + one .env.
#
# Usage (from repo root):
#   ./production-environment/scripts/deploy-vps.sh --host ovhe
#   # Domains optional — defaults from production-environment/.env, else live-shop defaults:
#   #   shop=wholesale.mirainikki.xyz dash=sillage-wholesale.mirainikki.xyz
#   ./production-environment/scripts/deploy-vps.sh \
#       --host ovhe \
#       [--shop …] [--dash …] [--skip-dns-check] \
#       [--dash-user wildwest] [--wp-user orange] \
#       [--dns] [--ip 139.99.61.71] \
#       [--skip-build] [--fresh] [--core-only] [--keep-caddy] [--replace-caddy]
#
# Product photos are wholesale-perfumes catalog flask_front URLs. There is no
# images.* CDN and no wholesale-media container. ~/ecom_sites/data/media is Sillage.
#
# Flow (empty Ubuntu VPS — this is the default path):
#   0) Once, as root: bootstrap-host.sh (Docker, Caddy, ubuntu, unzip)
#   1) Hub images: rsync source onto the VPS and build+push THERE
#      (docker login lives on the host). Never docker build on the laptop/agent.
#      Default builds **core + WordPress** (Dockerfile pins WP 7.1 / PHP 8.3).
#      Pass --core-only only for a day-2 engine bump on an already-running shop.
#   2) rsync compose/config/plugin/overrides only
#   3) remote: docker compose pull && up -d && migrate + first-boot WordPress
#      (WooCommerce, HPOS, permalinks, Coming soon off, Blocksy).
#      Caddy is written for this shop. If the VPS already serves other hostnames,
#      the existing Caddyfile is left alone unless you pass --replace-caddy.
#
# Secrets live in remote ~/sillage-wholesale/.env (created once; preserved on update).
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
WITH_WORDPRESS=1
KEEP_CADDY=""
SKIP_DNS_CHECK=0
FINISH=0
DASH_USER=""
WP_USER=""

# Operator logins are chosen or generated, never "admin".
check_operator() {
  local flag="$1" name="$2"
  if [[ "${name,,}" == *admin* ]]; then
    echo "$flag must not contain \"admin\": $name" >&2
    exit 1
  fi
  if [[ ! "$name" =~ ^[a-z0-9][a-z0-9._-]{1,31}$ ]]; then
    echo "$flag must be 2-32 chars of a-z 0-9 . _ -: $name" >&2
    exit 1
  fi
}

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?}"; shift 2 ;;
    --shop) SHOP_DOMAIN="${2:?}"; shift 2 ;;
    --dash) DASH_DOMAIN="${2:?}"; shift 2 ;;
    --images) IMAGES_DOMAIN="${2:?}"; shift 2 ;;
    --dns) DO_DNS=1; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
    --finish) FINISH=1; shift ;;
    --dash-user) DASH_USER="${2:?}"; check_operator --dash-user "$DASH_USER"; shift 2 ;;
    --wp-user) WP_USER="${2:?}"; check_operator --wp-user "$WP_USER"; shift 2 ;;
    --ip) IP="${2:?}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --fresh) FRESH=1; shift ;;
    --core-only) WITH_WORDPRESS=0; shift ;;
    --with-wordpress) WITH_WORDPRESS=1; shift ;;
    --keep-caddy) KEEP_CADDY=1; shift ;;
    --replace-caddy) KEEP_CADDY=0; shift ;;
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
REMOTE_DIR=sillage-wholesale

# Fail on the tool, not on a bare "command not found" 200 lines in.
for _tool in ssh rsync; do
  command -v "$_tool" >/dev/null || {
    echo "$_tool is not installed — this script copies the stack to the VPS with it" >&2
    exit 1
  }
done
CHRONO="$ROOT/.deploy/deploy-CHRONOLOGY.md"
mkdir -p "$ROOT/.deploy"
CREDS="$ROOT/.deploy/vps-dashboard-${HOST}.txt"
START_EPOCH=$(date +%s)

# Staging defaults when CLI + local .env omit domains (ovhe).
DEFAULT_SHOP_DOMAIN=wholesale.mirainikki.xyz
DEFAULT_DASH_DOMAIN=sillage-wholesale.mirainikki.xyz
DEFAULT_IMAGES_DOMAIN=""

log_step() {
  local msg="$1" now elapsed
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  elapsed=$(( $(date +%s) - START_EPOCH ))
  if [[ ! -f "$CHRONO" ]]; then
    printf '# Deploy chronology\n\n| UTC | Elapsed | Step |\n|---|---|---|\n' > "$CHRONO"
  fi
  printf '| %s | %dm%02ds | %s |\n' "$now" $((elapsed/60)) $((elapsed%60)) "$msg" | tee -a "$CHRONO"
}

# Domain precedence: CLI flags > remote ~/sillage-wholesale/.env > local .env (non-localhost) > live-shop defaults.
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

REMOTE_DOMAINS=$("${SSH[@]}" "$HOST" 'test -f ~/sillage-wholesale/.env && set -a && source ~/sillage-wholesale/.env && set +a && printf "%s\t%s\t%s" "${SHOP_DOMAIN:-}" "${DASH_DOMAIN:-}" "${IMAGES_DOMAIN:-}"' 2>/dev/null || true)
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

if [[ "$FINISH" -eq 1 ]]; then
  # Stage after the operator activates plugins and customises the shop: verify and repair the
  # settings the engine and orders depend on, then report. Activation is never changed here.
  echo "==> readiness check on ${HOST} (${SHOP_DOMAIN})"
  "${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/scripts"
  "${RSYNC[@]}" "$PE/scripts/wp-readiness.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-readiness.php"
  "${RSYNC[@]}" "$PE/scripts/apply-grants.sh" "$HOST:~/${REMOTE_DIR}/scripts/apply-grants.sh"
  "${SSH[@]}" "$HOST" "cd ~/${REMOTE_DIR} && bash scripts/apply-grants.sh --strict" || exit $?
  echo
  "${SSH[@]}" "$HOST" "docker cp ~/${REMOTE_DIR}/scripts/wp-readiness.php wholesale-ecom:/tmp/wp-readiness.php >/dev/null && docker exec -e SHOP_DOMAIN='${SHOP_DOMAIN}' -e WP_READINESS_FIX=1 wholesale-ecom php /tmp/wp-readiness.php"
  exit $?
fi

DASH_DOMAIN="$(pick_domain "$CLI_DASH" "$_R_DASH" "$LOCAL_DASH" "$DEFAULT_DASH_DOMAIN")"
if [[ -n "${CLI_IMAGES}" ]]; then
  echo "NOTE: --images is ignored. Wholesale photos are vendor flask_front URLs. ~/ecom_sites/data/media is the Sillage retail CDN."
fi
IMAGES_DOMAIN=""

log_step "START host=${HOST} shop=${SHOP_DOMAIN} dash=${DASH_DOMAIN} images=${IMAGES_DOMAIN:-none} skip_build=${SKIP_BUILD} wordpress=${WITH_WORDPRESS} keep_caddy=${KEEP_CADDY:-auto}"

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

# Check the names before spending twenty minutes on a stack that cannot get a certificate.
# Every DNS panel's host field appends the zone, so a pasted FQDN silently becomes
# wholesale.example.com.example.com: the doubled name resolves, the real one NXDOMAINs, and
# the only symptom is a browser connection failure once Let's Encrypt refuses to issue.
dns_of() {
  local name="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short +time=3 +tries=2 "$name" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1
  else
    getent ahostsv4 "$name" 2>/dev/null | awk '{print $1; exit}'
  fi
}

if [[ "$SKIP_DNS_CHECK" -eq 0 ]]; then
  dns_bad=()
  for name in "$SHOP_DOMAIN" "$DASH_DOMAIN"; do
    got="$(dns_of "$name")"
    [[ "$got" != "$IP" ]] && dns_bad+=("$name|${got:-NXDOMAIN}")
  done
  if [[ "${#dns_bad[@]}" -gt 0 ]]; then
    echo >&2
    echo "DNS is not ready for ${HOST} (${IP}):" >&2
    for entry in "${dns_bad[@]}"; do
      printf '  %-40s resolves to %s\n' "${entry%%|*}" "${entry##*|}" >&2
    done
    echo >&2
    echo "Add an A record per name. Enter the LABEL only — the panel appends the zone," >&2
    echo "so pasting the full name creates sub.domain.tld.domain.tld:" >&2
    zone="${SHOP_DOMAIN#*.}"
    for entry in "${dns_bad[@]}"; do
      name="${entry%%|*}"
      label="${name%".$zone"}"
      [[ "$label" == "$name" ]] && label="@"
      printf '  HOST %-22s TYPE A   VALUE %s\n' "$label" "$IP" >&2
    done
    echo >&2
    echo "Then re-run. Pass --skip-dns-check to deploy anyway (HTTPS will not work)." >&2
    exit 1
  fi
  log_step "DNS verified for shop/dash → ${IP}"
fi

TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
NAMESPACE="${DOCKERHUB_NAMESPACE:-}"
if [[ -z "$NAMESPACE" ]]; then
  NAMESPACE="$(docker info 2>/dev/null | sed -n 's/^ Username: //p' | head -1 || true)"
fi
NAMESPACE="${NAMESPACE:-unseencurtain}"
CORE_IMAGE="${NAMESPACE}/sillage-b2b:${TAG}"
WP_IMAGE="${NAMESPACE}/sillage-wordpress:${TAG}"
if [[ "$WITH_WORDPRESS" -eq 0 ]]; then
  WP_IMAGE="${NAMESPACE}/sillage-wordpress:latest"
fi

if [[ "$SKIP_BUILD" -eq 0 && "$WITH_WORDPRESS" -eq 0 ]]; then
  echo "NOTE: --core-only skips the WordPress image. Empty VPS first boot must omit --core-only."
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Hub build on ${HOST} (docker login lives there; this machine does not docker build)"
  "${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/sillage-core ~/${REMOTE_DIR}/scripts ~/${REMOTE_DIR}/wordpress-image"
  "${RSYNC[@]}" --delete \
    --exclude data --exclude logs --exclude node_modules --exclude web/dist \
    --exclude .feedscratch \
    "$PE/sillage-core/" "$HOST:~/${REMOTE_DIR}/sillage-core/"
  "${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
  BUILD_FLAGS=(--namespace "$NAMESPACE" --tag "$TAG")
  if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
    "${RSYNC[@]}" --delete "$PE/wordpress-image/" "$HOST:~/${REMOTE_DIR}/wordpress-image/"
    BUILD_FLAGS+=(--with-wordpress)
    log_step "Building core + WordPress ${CORE_IMAGE} ${WP_IMAGE}"
  else
    BUILD_FLAGS+=(--core-only)
    log_step "Building core-only ${CORE_IMAGE}"
  fi
  "${SSH[@]}" "$HOST" "bash ~/${REMOTE_DIR}/scripts/build-push-images.sh ${BUILD_FLAGS[*]}"
  log_step "Pushed Hub images from ${HOST}"
else
  log_step "Skipped image build; using ${CORE_IMAGE} ${WP_IMAGE}"
fi

# A Hub tag says nothing about the WordPress it carries: an old build can sit under a tag
# whose live datadir was upgraded in place afterwards, so the running shop reads newer than
# the image. Deploying it onto an empty VPS installs the old WordPress. Compare the bundled
# version against the Dockerfile pin before anything writes a datadir.
if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
  PIN_WP="$(sed -n 's/^FROM wordpress:\([0-9][0-9.]*\)-php.*/\1/p' "$PE/wordpress-image/Dockerfile" | head -1)"
  if [[ -z "$PIN_WP" ]]; then
    echo "Could not read the WordPress pin from wordpress-image/Dockerfile" >&2
    exit 1
  fi
  IMAGE_WP="$("${SSH[@]}" "$HOST" "docker pull -q '$WP_IMAGE' >/dev/null 2>&1 && docker run --rm --entrypoint php '$WP_IMAGE' -r 'include \"/usr/src/wordpress/wp-includes/version.php\"; echo \$wp_version;'" 2>/dev/null || true)"
  if [[ -z "$IMAGE_WP" ]]; then
    echo "Could not read WordPress version from ${WP_IMAGE} (missing on Hub?)" >&2
    exit 1
  fi
  if [[ "$IMAGE_WP" != "$PIN_WP" ]]; then
    echo "${WP_IMAGE} bundles WordPress ${IMAGE_WP}, Dockerfile pins ${PIN_WP}." >&2
    echo "Rebuild that tag (drop --skip-build) instead of shipping a stale image." >&2
    exit 1
  fi
  log_step "WordPress image carries ${IMAGE_WP} (matches pin)"
fi

echo "==> rsync compose/config/plugin → ${HOST}:~/${REMOTE_DIR}"
"${SSH[@]}" "$HOST" "mkdir -p ~/${REMOTE_DIR}/ecom_sites/config ~/${REMOTE_DIR}/sillage-core/data ~/${REMOTE_DIR}/sillage-core/logs ~/${REMOTE_DIR}/wp-staging ~/ecom_sites/data/sitemaps ~/${REMOTE_DIR}/.feedscratch ~/${REMOTE_DIR}/scripts"

"${RSYNC[@]}" "$PE/compose.yaml" "$HOST:~/${REMOTE_DIR}/compose.yaml"
"${RSYNC[@]}" "$PE/.env.example" "$HOST:~/${REMOTE_DIR}/.env.example"
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/config/" "$HOST:~/${REMOTE_DIR}/ecom_sites/config/"
"${RSYNC[@]}" "$PE/scripts/vps-bootstrap.sh" "$HOST:~/${REMOTE_DIR}/scripts/vps-bootstrap.sh"
"${RSYNC[@]}" "$PE/scripts/wp-config-patch.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-config-patch.php"
"${RSYNC[@]}" "$PE/scripts/wp-readiness.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-readiness.php"
"${RSYNC[@]}" "$PE/scripts/apply-grants.sh" "$HOST:~/${REMOTE_DIR}/scripts/apply-grants.sh"
"${RSYNC[@]}" "$PE/scripts/build-push-images.sh" "$HOST:~/${REMOTE_DIR}/scripts/build-push-images.sh"
"${RSYNC[@]}" "$PE/scripts/fix-wp-content-perms.sh" "$HOST:~/${REMOTE_DIR}/scripts/fix-wp-content-perms.sh"
"${RSYNC[@]}" "$PE/scripts/wp-fresh-install.php" "$HOST:~/${REMOTE_DIR}/scripts/wp-fresh-install.php"
if [[ -f "$PE/sillage-core/data/image_overrides.wpf.json" ]]; then
  "${RSYNC[@]}" "$PE/sillage-core/data/image_overrides.wpf.json" \
    "$HOST:~/${REMOTE_DIR}/sillage-core/data/image_overrides.wpf.json"
elif [[ -f "$PE/sillage-core/data/image_overrides.json" ]]; then
  "${RSYNC[@]}" "$PE/sillage-core/data/image_overrides.json" \
    "$HOST:~/${REMOTE_DIR}/sillage-core/data/image_overrides.wpf.json"
fi
"${RSYNC[@]}" --delete \
  "$PE/ecom_sites/data/wp/wp-content/plugins/sillage-bridge/" \
  "$HOST:~/${REMOTE_DIR}/wp-staging/sillage-bridge/"
# Keep a zero-byte php.ini if missing so the bind mount succeeds.
"${SSH[@]}" "$HOST" "touch ~/${REMOTE_DIR}/ecom_sites/config/php.ini; mkdir -p ~/ecom_sites/data/sitemaps; touch ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env; [[ -f ~/${REMOTE_DIR}/sillage-core/data/image_overrides.wpf.json ]] || echo '{}' > ~/${REMOTE_DIR}/sillage-core/data/image_overrides.wpf.json; chmod 600 ~/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env"
log_step "Minimal rsync done"

if [[ -n "$CLONE_FROM" ]]; then
  echo "--clone-from is no longer supported: WordPress and MariaDB live in Docker volumes," >&2
  echo "and cloning a live shop's datadir is what let core drift from its image." >&2
  echo "Deploy a fresh install and let the operator set the theme up." >&2
  exit 1
fi

echo "==> ensure remote .env"
REMOTE_HAS_ENV=$("${SSH[@]}" "$HOST" "test -f ~/${REMOTE_DIR}/.env && echo yes || echo no")
if [[ "$REMOTE_HAS_ENV" != "yes" || "$FRESH" -eq 1 ]]; then
  new_operator() {
    local prefix="$1" id name
    while true; do
      id="$(openssl rand -hex 3)"
      name="${prefix}-${id}"
      [[ "${name,,}" != *admin* ]] && { printf '%s' "$name"; return; }
    done
  }
  DASH_USER="${DASH_USER:-$(new_operator desk)}"
  WP_USER="${WP_USER:-$(new_operator shop)}"
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

  # Vendor flask_front URLs. Do not invent a CDN that mounts Sillage's JPEGs.

  "${SSH[@]}" "$HOST" "cat > ~/${REMOTE_DIR}/.env" <<EOF
# Generated by deploy-vps.sh — do not commit
SILLAGE_CORE_IMAGE=${CORE_IMAGE}
WORDPRESS_IMAGE=${WP_IMAGE}
MARIADB_IMAGE=mariadb:latest
VALKEY_IMAGE=valkey/valkey:8-alpine

DATA_DIR=/home/ubuntu/ecom_sites/data
FEEDSCRATCH_DIR=/home/ubuntu/${REMOTE_DIR}/.feedscratch
SILLAGE_LOGS_DIR=/home/ubuntu/${REMOTE_DIR}/sillage-core/logs
IMAGE_OVERRIDES_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/image_overrides.wpf.json
SILLAGE_SECRETS_FILE=/home/ubuntu/${REMOTE_DIR}/sillage-core/data/secrets.overlay.env
MARIADB_CNF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/mariadb.wholesale.cnf
PHP_INI=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/php.ini
APACHE_HIDE_CONF=/home/ubuntu/${REMOTE_DIR}/ecom_sites/config/apache-hide-version.conf
SITEMAP_HOST_DIR=/home/ubuntu/ecom_sites/data/sitemaps

DB_BIND=127.0.0.1
DB_HOST_PORT=3308
ECOM_BIND=127.0.0.1
ECOM_PORT=106
SILLAGE_BIND=127.0.0.1
SILLAGE_PORT=4001

SHOP_DOMAIN=${SHOP_DOMAIN}
DASH_DOMAIN=${DASH_DOMAIN}
WP_BASE_URL=https://${SHOP_DOMAIN}
WORDPRESS_INTERNAL_URL=http://wholesale-ecom
SILLAGE_PROFILE=wholesale

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

DASHBOARD_USER=${DASH_USER}
DASHBOARD_PASSWORD=${PASS}
SESSION_SECRET=${SESSION}
FIXTURES_DIR=/app/.feedscratch
REDIS_URL=redis://wholesale-valkey:6379
EOF
  "${SSH[@]}" "$HOST" "chmod 600 ~/${REMOTE_DIR}/.env"

  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=${DASH_USER}
password=${PASS}
shop=https://${SHOP_DOMAIN}
wp_admin_user=${WP_USER}
wp_admin_password=${WP_ADMIN_PASS}
ip=${IP}
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Created ~/${REMOTE_DIR}/.env + ${CREDS}"
else
  # Update image tags + domains/vendor keys; keep DB/dashboard secrets.
  # Non-empty local values win; empty local values leave remote secrets untouched.
  "${SSH[@]}" "$HOST" "SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CORE_IMAGE='$CORE_IMAGE' WP_IMAGE='$WP_IMAGE' WITH_WORDPRESS='$WITH_WORDPRESS' LOCAL_WPF_USER='${WHOLESALE_PERFUMES_USER:-}' LOCAL_WPF_TOKEN='${WHOLESALE_PERFUMES_TOKEN:-}' LOCAL_WPF_CATALOG='${WHOLESALE_PERFUMES_CATALOG_URL:-}' LOCAL_WPF_STOCK='${WHOLESALE_PERFUMES_STOCK_URL:-}' LOCAL_WPF_API='${WHOLESALE_PERFUMES_API_BASE_URL:-}' LOCAL_BRASTY_PRODUCT='${BRASTY_PRODUCT_FEED_URL:-}' LOCAL_BRASTY_AVAIL='${BRASTY_AVAILABILITY_FEED_URL:-}' python3 -" <<'PY'
import os, pathlib, re
p = pathlib.Path.home() / "sillage-wholesale" / ".env"
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
pairs = [
    ("SILLAGE_CORE_IMAGE", os.environ["CORE_IMAGE"]),
    ("SHOP_DOMAIN", shop),
    ("DASH_DOMAIN", dash),
    ("WP_BASE_URL", f"https://{shop}"),
    ("SITEMAP_HOST_DIR", "/home/ubuntu/ecom_sites/data/sitemaps"),
    ("WHOLESALE_PERFUMES_USER", os.environ.get("LOCAL_WPF_USER") or None),
    ("WHOLESALE_PERFUMES_TOKEN", os.environ.get("LOCAL_WPF_TOKEN") or None),
    ("WHOLESALE_PERFUMES_CATALOG_URL", os.environ.get("LOCAL_WPF_CATALOG") or None),
    ("WHOLESALE_PERFUMES_STOCK_URL", os.environ.get("LOCAL_WPF_STOCK") or None),
    ("WHOLESALE_PERFUMES_API_BASE_URL", os.environ.get("LOCAL_WPF_API") or None),
    ("BRASTY_PRODUCT_FEED_URL", os.environ.get("LOCAL_BRASTY_PRODUCT") or None),
    ("BRASTY_AVAILABILITY_FEED_URL", os.environ.get("LOCAL_BRASTY_AVAIL") or None),
]
if os.environ.get("WITH_WORDPRESS") == "1":
    pairs.insert(1, ("WORDPRESS_IMAGE", os.environ["WP_IMAGE"]))
for k, v in pairs:
    if v is not None and v != "":
        text = set_key(text, k, v)
p.write_text(text)
print("ENV_UPDATED")
PY
  # Refresh local creds file password from remote when possible
  REMOTE_PASS=$("${SSH[@]}" "$HOST" 'set -a; source ~/sillage-wholesale/.env; set +a; printf %s "$DASHBOARD_PASSWORD"')
  cat > "$CREDS" <<EOF
host=${HOST}
url=https://${DASH_DOMAIN}
user=${DASH_USER:-see ~/${REMOTE_DIR}/.env}
password=${REMOTE_PASS}
shop=https://${SHOP_DOMAIN}
ip=${IP}
updated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 600 "$CREDS"
  log_step "Updated image tags in existing .env"
fi

echo "==> remote pull + up"
"${SSH[@]}" "$HOST" "APP_DIR=\$HOME/${REMOTE_DIR} SHOP_DOMAIN='$SHOP_DOMAIN' DASH_DOMAIN='$DASH_DOMAIN' IMAGES_DOMAIN='$IMAGES_DOMAIN' CLONE_MODE='${CLONE_FROM:+1}' FRESH='$FRESH' WP_ADMIN_USER='${WP_USER:-}' WP_ADMIN_PASS='${WP_ADMIN_PASS:-}' KEEP_CADDY='${KEEP_CADDY:-}' bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
set -a; source .env; set +a

if [[ -f "$HOME/sillage/compose.yaml" ]] && grep -q "container_name: ecom" "$HOME/sillage/compose.yaml"; then
  if docker ps -a --format "{{.Names}}" | grep -qx wholesale-ecom; then
    echo "This VPS already runs wholesale-ecom from ~/sillage (combined live stack)." >&2
    echo "Empty-VPS deploy from sillage-b2b would collide on container names. Cut over first." >&2
    exit 1
  fi
fi

WP_PORT="${ECOM_PORT:-106}"

# Empty VPS: write the Caddyfile for this shop. If the box already terminates
# TLS for other hostnames (shared retail+wholesale), leave it alone.
# Do not add an images.* site — those JPEGs belong to Sillage lps-media.
if [[ -z "${KEEP_CADDY:-}" && -f /etc/caddy/Caddyfile ]]; then
  while read -r site; do
    [[ -z "$site" ]] && continue
    ours=0
    for d in ${SHOP_DOMAIN:-} ${DASH_DOMAIN:-}; do
      [[ "$site" == "$d" ]] && ours=1
    done
    if [[ "$ours" -eq 0 ]]; then
      echo "Caddy already serves $site — leaving /etc/caddy/Caddyfile (pass --replace-caddy to overwrite)"
      KEEP_CADDY=1
      break
    fi
  done < <(grep -E '^[A-Za-z0-9._-]+\.[A-Za-z0-9.-]+ \{' /etc/caddy/Caddyfile | awk '{print $1}' || true)
fi

if [[ "${KEEP_CADDY:-0}" == "1" ]]; then
  echo "Skipping Caddyfile rewrite"
else
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${SHOP_DOMAIN} {
	# AI training crawlers walk every /product and /brand page. Prefork PHP
	# cannot survive that on a ~4 GB box. See docs/CRAWLER-SHIELD.md
	@heavybot header_regexp User-Agent (?i)(ClaudeBot|GPTBot|CCBot|Bytespider|Amazonbot|meta-externalagent)
	handle @heavybot {
		respond "Forbidden" 403
	}
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
	reverse_proxy localhost:${SILLAGE_PORT:-4001} {
		header_down -Server
		header_down -Via
	}
}
EOF
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile || sudo systemctl reload caddy
fi

docker network create ecom_network 2>/dev/null || true
docker network create redis_network 2>/dev/null || true

# Stop legacy split compose projects if they still own the container names.
if [[ -f "$HOME/redis/compose.yaml" ]]; then
  (cd "$HOME/redis" && docker compose down 2>/dev/null) || true
fi
if [[ -f "$HOME/ecom_sites/compose.yaml" ]]; then
  (cd "$HOME/ecom_sites" && docker compose down 2>/dev/null) || true
fi

mkdir -p "$DATA_DIR/sitemaps" \
  "$APP_DIR/sillage-core/logs" "$APP_DIR/.feedscratch"
# Ensure image overrides + secrets overlay files exist for bind mounts (file, not directory).
[[ -f "$APP_DIR/sillage-core/data/image_overrides.wpf.json" ]] \
  || echo '{}' > "$APP_DIR/sillage-core/data/image_overrides.wpf.json"
[[ -f "$APP_DIR/sillage-core/data/secrets.overlay.env" ]] \
  || : > "$APP_DIR/sillage-core/data/secrets.overlay.env"
chmod 600 "$APP_DIR/sillage-core/data/secrets.overlay.env" 2>/dev/null || true

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

# WordPress lives in a Docker volume, so every check and edit goes through the container. The
# host has no business holding WordPress core: that is how a datadir drifted to a newer version
# than the image it booted from.
wp_has_config() { docker exec wholesale-ecom test -f /var/www/html/wp-config.php 2>/dev/null; }
wp_chown() { docker exec wholesale-ecom chown -R www-data:www-data /var/www/html/wp-content 2>/dev/null || true; }

echo "Waiting for WordPress files..."
for i in $(seq 1 90); do
  wp_has_config && break
  sleep 2
done

# The bridge plugin ships on every deploy, into the volume rather than a host wp-content.
if [[ -d "$APP_DIR/wp-staging/sillage-bridge" ]]; then
  docker exec wholesale-ecom rm -rf /var/www/html/wp-content/plugins/sillage-bridge
  docker cp "$APP_DIR/wp-staging/sillage-bridge" wholesale-ecom:/var/www/html/wp-content/plugins/
  wp_chown
  echo "sillage-bridge copied into the WordPress volume"
fi

NEED_FRESH=0
wp_has_config || NEED_FRESH=1
if [[ -z "${CLONE_MODE:-}" && ( "$NEED_FRESH" -eq 1 || "${FRESH:-0}" == "1" ) ]]; then
  echo "Fetching WooCommerce / redis-cache / Blocksy from wordpress.org..."
  STAGE="$(mktemp -d)"
  for item in "plugin:woocommerce" "plugin:redis-cache" "theme:blocksy"; do
    kind=${item%:*}; slug=${item##*:}
    if docker exec wholesale-ecom test -d "/var/www/html/wp-content/${kind}s/${slug}"; then
      echo "  $slug already present"
      continue
    fi
    curl -fsSL -o "$STAGE/${slug}.zip" "https://downloads.wordpress.org/${kind}/${slug}.latest-stable.zip"
    unzip -qo "$STAGE/${slug}.zip" -d "$STAGE"
    docker cp "$STAGE/${slug}" wholesale-ecom:/var/www/html/wp-content/${kind}s/
    rm -rf "$STAGE/${slug}" "$STAGE/${slug}.zip"
    echo "  $slug installed"
  done
  rm -rf "$STAGE"
  wp_chown

  # Wait again for wp-config from the official image entrypoint
  for i in $(seq 1 60); do
    wp_has_config && break
    sleep 2
  done

  if wp_has_config; then
    if [[ -f "$APP_DIR/ecom_sites/config/wordpress.htaccess" ]]; then
      docker cp "$APP_DIR/ecom_sites/config/wordpress.htaccess" wholesale-ecom:/var/www/html/.htaccess
      docker exec wholesale-ecom chown www-data:www-data /var/www/html/.htaccess || true
    fi
    INSTALL_PHP="$APP_DIR/scripts/wp-fresh-install.php"
    if [[ ! -f "$INSTALL_PHP" ]]; then
      echo "Missing $INSTALL_PHP — cannot finish empty-VPS WordPress install" >&2
      exit 1
    fi
    docker cp "$INSTALL_PHP" wholesale-ecom:/tmp/wp-fresh-install.php
    docker exec \
      -e SHOP_DOMAIN="$SHOP_DOMAIN" \
      -e WP_ADMIN_USER="${WP_ADMIN_USER:-}" \
      -e WP_ADMIN_PASS="${WP_ADMIN_PASS:-}" \
      -e SHOP_TITLE="${SHOP_TITLE:-Wholesale}" \
      wholesale-ecom php /tmp/wp-fresh-install.php
  fi
fi

export SILLAGE_DASHBOARD_URL="https://${DASH_DOMAIN}"
wp_chown
if wp_has_config; then
  # Creates the sillage DB user and grants, then patches wp-config inside the container:
  # the bridge constants, DISABLE_WP_CRON, and FS_METHOD for wp-admin plugin uploads.
  bash "$APP_DIR/scripts/vps-bootstrap.sh"
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

cd "$APP_DIR"
set -a; source .env; set +a
# Applies and then verifies. The retail file is not a usable fallback here — its grants name
# the `earth` database, which does not exist on wholesale-db — so a missing wholesale file is
# a hard error rather than something to paper over.
if [[ -f ecom_sites/config/sillage-grants-wholesale.sql ]]; then
  bash scripts/apply-grants.sh
else
  echo "missing ecom_sites/config/sillage-grants-wholesale.sql — the engine user would have no grants" >&2
  exit 1
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
if [[ "${WP_ACTIVATE_PLUGINS:-0}" == "1" ]]; then
  docker exec wholesale-ecom php -r 'require "/var/www/html/wp-load.php"; require_once ABSPATH."wp-admin/includes/plugin.php"; activate_plugin("sillage-bridge/sillage-bridge.php"); echo "plugin ok\n";' || true
fi

# The live box was hand-tuned with swap that no script created, so a rebuilt VPS OOM-killed
# the first import instead of finishing it. The WPF full sync alone peaks near 2 GB.
if ! swapon --show | grep -q '^/swapfile'; then
  echo "==> 4G swapfile (a full sync peaks near 2 GB)"
  sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
  sudo mkdir -p /etc/sysctl.d
  echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-sillage-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-sillage-swap.conf >/dev/null
fi
swapon --show

curl -sS "http://127.0.0.1:${SILLAGE_PORT:-4000}/health" || true
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
echo "Compose:   ${HOST}:~/${REMOTE_DIR}/compose.yaml"
echo "Env:       ${HOST}:~/${REMOTE_DIR}/.env"
echo "Creds:     $CREDS"
echo "Images:    ${CORE_IMAGE}  ${WP_IMAGE}"
