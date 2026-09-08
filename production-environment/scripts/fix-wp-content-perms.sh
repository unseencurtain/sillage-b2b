#!/usr/bin/env bash
# WordPress in Docker runs Apache as www-data (uid 33). When wp-content is owned by anyone else,
# wp-admin uploads and updates fail with:
#   Could not create directory.: /var/www/html/wp-content/upgrade
#
# WordPress lives in a Docker volume, so ownership is fixed inside the container. The deploy does
# this itself; this script is the manual rescue after copying files in by hand.
#
#   bash ~/sillage-wholesale/scripts/fix-wp-content-perms.sh
#   bash ~/sillage-wholesale/scripts/fix-wp-content-perms.sh --container wholesale-ecom
set -euo pipefail

CONTAINERS=()

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINERS+=("${2:?}"); shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unexpected arg: $1" >&2; usage ;;
  esac
done

if [[ ${#CONTAINERS[@]} -eq 0 ]]; then
  CONTAINERS=(wholesale-ecom)
fi

for container in "${CONTAINERS[@]}"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "No such container: $container" >&2
    exit 1
  fi
  docker exec "$container" chown -R www-data:www-data /var/www/html/wp-content
  docker exec "$container" sh -c 'test -f /var/www/html/wp-config.php && chown www-data:www-data /var/www/html/wp-config.php' || true
  echo "${container}: wp-content owned by www-data"
done
