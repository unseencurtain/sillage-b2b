#!/usr/bin/env bash
# Create/update Porkbun A records for Sillage shop + dashboard (+ optional images) domains.
#
# Usage:
#   ./production-environment/scripts/porkbun-dns.sh <shop.fqdn> <dash.fqdn> <ipv4> [images.fqdn]
#
# Credentials: .deploy/porkbun.env (PORKBUN_API_KEY, PORKBUN_SECRET_KEY)
set -euo pipefail

SHOP_FQDN="${1:?shop FQDN required}"
DASH_FQDN="${2:?dash FQDN required}"
IP="${3:?IPv4 required}"
IMAGES_FQDN="${4:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${PORKBUN_ENV:-$ROOT/.deploy/porkbun.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — write PORKBUN_API_KEY and PORKBUN_SECRET_KEY there." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${PORKBUN_API_KEY:?}" "${PORKBUN_SECRET_KEY:?}"

api() {
  local path="$1"
  shift
  curl -sS -X POST "https://api.porkbun.com/api/json/v3${path}" \
    -H 'Content-Type: application/json' \
    -d "$@"
}

split_host() {
  # echo apex  subdomain_or_empty
  local fqdn="$1"
  local labels
  IFS='.' read -r -a labels <<<"$fqdn"
  local n=${#labels[@]}
  if (( n < 2 )); then
    echo "Invalid FQDN: $fqdn" >&2
    exit 1
  fi
  local apex="${labels[n-2]}.${labels[n-1]}"
  local sub=""
  if (( n > 2 )); then
    sub=$(IFS='.'; echo "${labels[*]:0:n-2}")
  fi
  printf '%s %s\n' "$apex" "$sub"
}

upsert_a() {
  local fqdn="$1"
  local ip="$2"
  read -r apex name <<<"$(split_host "$fqdn")"
  echo "==> DNS A ${fqdn} → ${ip} (apex=${apex} name=${name:-@})"

  local list
  list=$(api "/dns/retrieve/${apex}" "{\"apikey\":\"${PORKBUN_API_KEY}\",\"secretapikey\":\"${PORKBUN_SECRET_KEY}\"}")
  if ! echo "$list" | grep -q '"status":"SUCCESS"'; then
    echo "$list" >&2
    echo "Cannot retrieve DNS for ${apex}. Is the domain registered + API access enabled?" >&2
    exit 1
  fi

  local match_name="${name}"
  [[ -z "$match_name" ]] && match_name="$apex"
  # Porkbun returns full hostname in "name" for subdomains
  local ids
  ids=$(echo "$list" | python3 -c "
import json,sys
d=json.load(sys.stdin)
want_sub=sys.argv[1]
apex=sys.argv[2]
fqdn=sys.argv[3]
for r in d.get('records',[]):
    if r.get('type')!='A': continue
    n=r.get('name','')
    if n==fqdn or n==want_sub or (want_sub=='' and n==apex):
        print(r['id'])
" "$match_name" "$apex" "$fqdn")

  if [[ -n "$ids" ]]; then
    while read -r id; do
      [[ -z "$id" ]] && continue
      api "/dns/edit/${apex}/${id}" "{\"apikey\":\"${PORKBUN_API_KEY}\",\"secretapikey\":\"${PORKBUN_SECRET_KEY}\",\"name\":\"${name}\",\"type\":\"A\",\"content\":\"${ip}\",\"ttl\":\"600\"}" | tee /dev/stderr | grep -q SUCCESS
      echo "    updated id=$id"
    done <<<"$ids"
  else
    api "/dns/create/${apex}" "{\"apikey\":\"${PORKBUN_API_KEY}\",\"secretapikey\":\"${PORKBUN_SECRET_KEY}\",\"name\":\"${name}\",\"type\":\"A\",\"content\":\"${ip}\",\"ttl\":\"600\"}" | tee /dev/stderr | grep -q SUCCESS
    echo "    created"
  fi
}

upsert_a "$SHOP_FQDN" "$IP"
upsert_a "$DASH_FQDN" "$IP"
if [[ -n "$IMAGES_FQDN" ]]; then
  upsert_a "$IMAGES_FQDN" "$IP"
fi
echo "DNS ready."
