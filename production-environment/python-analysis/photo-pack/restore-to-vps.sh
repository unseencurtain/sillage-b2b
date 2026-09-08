#!/usr/bin/env bash
# Restore CDN JPEGs + override map onto a new VPS from an unpacked photo pack.
# Does not start sync. Does not copy scraped/ until you pass --also-scraped (still does not apply).
set -euo pipefail
PACK="${1:-.}"
DEST_MEDIA="${DEST_MEDIA:-$HOME/ecom_sites/data/media}"
DEST_OVERRIDES="${DEST_OVERRIDES:-$HOME/sillage/sillage-core/data/image_overrides.json}"
DEST_BRASTY="${DEST_BRASTY:-$HOME/brasty}"

if [[ ! -d "$PACK/files/cdn" ]]; then
  echo "usage: restore-to-vps.sh /path/to/unpacked-photo-pack" >&2
  exit 1
fi

mkdir -p "$DEST_MEDIA"
echo "CDN → $DEST_MEDIA"
rsync -a "$PACK/files/cdn/" "$DEST_MEDIA/"

if [[ -f "$PACK/maps/image_overrides.json" ]]; then
  mkdir -p "$(dirname "$DEST_OVERRIDES")"
  cp -a "$PACK/maps/image_overrides.json" "$DEST_OVERRIDES"
  echo "overrides → $DEST_OVERRIDES"
fi

if [[ "${RESTORE_BRASTY:-0}" == "1" && -d "$PACK/files/brasty" ]]; then
  mkdir -p "$DEST_BRASTY"
  echo "Brasty dump → $DEST_BRASTY"
  rsync -a "$PACK/files/brasty/" "$DEST_BRASTY/"
fi

if [[ "${1:-}" == "--also-scraped" || "${RESTORE_SCRAPED:-0}" == "1" ]]; then
  echo "NOTE: scraped/ is unreviewed. Copying to $HOME/sillage/ean-image-scrape/scraped/ — not the CDN."
  mkdir -p "$HOME/sillage/ean-image-scrape/scraped"
  rsync -a "$PACK/files/scraped/" "$HOME/sillage/ean-image-scrape/scraped/"
fi

echo
echo "Next: recreate sillage-core and sillage-cron, then"
echo "  docker exec sillage-core bun run sync -- --mode=full --source=cache --rewrite-only"
echo "Do not --apply-to-shop scraped photos until a human has opened files/scraped/."
