#!/usr/bin/env bash
# WordPress in Docker runs Apache as www-data (uid 33). The shop is a host bind-mount.
# If wp-content is owned by ubuntu, wp-admin Updates fail with:
#   Could not create directory.: /var/www/html/wp-content/upgrade
#
# Run on ovhe:
#   bash ~/sillage-wholesale/scripts/fix-wp-content-perms.sh
#   bash ~/sillage-wholesale/scripts/fix-wp-content-perms.sh --dir ~/ecom_sites/data/wp-wholesale
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/ecom_sites/data}"
TARGETS=()

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) TARGETS+=("${2:?}"); shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unexpected arg: $1" >&2; usage ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("$DATA_DIR/wp-wholesale")
fi

# Container www-data is always uid/gid 33 on the official WordPress image.
fix_one() {
  local root="$1"
  local content="$root/wp-content"
  if [[ ! -d "$root" ]]; then
    echo "skip missing $root"
    return 0
  fi
  mkdir -p "$content/upgrade" "$content/upgrade-temp-backup" "$content/uploads" \
    "$content/plugins" "$content/themes"
  sudo chown -R 33:33 "$content"
  sudo chmod -R u+rwX,g+rwX "$content"
  if [[ -f "$root/wp-config.php" ]]; then
    sudo chown 33:33 "$root/wp-config.php"
    sudo chmod 664 "$root/wp-config.php"
  fi
  echo "writable: $content (www-data uid 33)"
}

for t in "${TARGETS[@]}"; do
  fix_one "$t"
done
