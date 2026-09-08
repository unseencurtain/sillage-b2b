#!/usr/bin/env bash
# Close the photo-pack download server. Safe to run when it is already stopped.
set -euo pipefail
PACK="${PHOTO_PACK_DIR:-/workspace/photo-pack}"
PID_FILE="${PACK}/.serve.pid"
PORT="${PHOTO_PACK_PORT:-18765}"

stopped=0
if [[ -f "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    echo "stopped pid $pid"
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

# Belt: anything still listening on the pack port on localhost only.
if command -v ss >/dev/null 2>&1; then
  extra="$(ss -lntp 2>/dev/null | grep ":${PORT} " || true)"
  if [[ -n "$extra" ]]; then
    echo "warning: something is still listening on :${PORT}:" >&2
    echo "$extra" >&2
  elif [[ "$stopped" -eq 0 ]]; then
    echo "not running (port ${PORT} is closed)"
  else
    echo "port ${PORT} is closed"
  fi
fi
rm -f "${PACK}/.serve.token"
