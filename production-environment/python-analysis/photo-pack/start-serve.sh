#!/usr/bin/env bash
# Start the photo-pack download server on 127.0.0.1 only.
# Stop with stop-serve.sh — do not leave it running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK="${PHOTO_PACK_DIR:-/workspace/photo-pack}"
BIND="${PHOTO_PACK_BIND:-127.0.0.1}"
PORT="${PHOTO_PACK_PORT:-18765}"
MINUTES="${PHOTO_PACK_MINUTES:-45}"
PID_FILE="${PACK}/.serve.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PID_FILE") — stop first: $ROOT/stop-serve.sh" >&2
  exit 1
fi

if [[ "$BIND" == "0.0.0.0" || "$BIND" == "::" ]]; then
  echo "Refusing $BIND. Last time a public http.server stayed open. Use 127.0.0.1 + SSH tunnel." >&2
  exit 2
fi

mkdir -p "$PACK"
cd "$PACK"
ZIP="${PHOTO_PACK_ZIP:-$PACK/sillage-photo-pack.zip}"
if [[ ! -f "$ZIP" ]]; then
  echo "zip not ready: $ZIP" >&2
  exit 1
fi
exec python3 "$ROOT/serve_zip.py" \
  --zip "$ZIP" \
  --bind "$BIND" \
  --port "$PORT" \
  --minutes "$MINUTES" \
  --pid-file "$PID_FILE"
