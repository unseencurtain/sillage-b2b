#!/usr/bin/env bash
# Run **on ovhe** (`ssh ovhe`). That host is already `docker login` as unseencurtain.
# Do not build Hub images in a cloud-agent VM or on a laptop. Copy sillage-core
# source to ~/sillage/sillage-core (keep data/ and logs/), then:
#
#   ~/sillage/scripts/build-push-images.sh --core-only
#   ~/sillage/scripts/build-push-images.sh --core-only --namespace unseencurtain --tag abc1234
#
# Laptop git checkout (same script, still run it on ovhe after rsync):
#   production-environment/scripts/build-push-images.sh --core-only
#
# Default is **core-only**. Rebuilding sillage-wordpress from wordpress:latest can bump
# WooCommerce on the live shop — pass --with-wordpress only when an operator asked.
#
# Tags each image as :<git-sha> and :latest (unless --no-latest).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# VPS: ~/sillage/scripts → ~/sillage. Laptop: production-environment/scripts → production-environment.
PE="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_DIR="$PE/sillage-core"
WP_DIR="$PE/wordpress-image"
NAMESPACE=""
TAG=""
PUSH_LATEST=1
WITH_WORDPRESS=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --no-latest) PUSH_LATEST=0; shift ;;
    --core-only) WITH_WORDPRESS=0; shift ;;
    --with-wordpress) WITH_WORDPRESS=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unexpected arg: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$CORE_DIR/Dockerfile" ]]; then
  echo "Missing $CORE_DIR/Dockerfile — rsync sillage-core onto this host first." >&2
  exit 1
fi

if [[ -z "$NAMESPACE" ]]; then
  # Prefer docker login username; fall back to known operator namespace.
  NAMESPACE="$(docker info 2>/dev/null | sed -n 's/^ Username: //p' | head -1 || true)"
  if [[ -z "$NAMESPACE" ]] && [[ -f "${HOME}/.docker/config.json" ]]; then
    NAMESPACE="$(python3 - <<'PY'
import json, base64, pathlib
p = pathlib.Path.home()/".docker"/"config.json"
try:
    cfg = json.loads(p.read_text())
except Exception:
    raise SystemExit(0)
auths = cfg.get("auths") or {}
for key in ("https://index.docker.io/v1/", "https://index.docker.io/v1/access-token", "index.docker.io"):
    auth = (auths.get(key) or {}).get("auth")
    if auth:
        try:
            raw = base64.b64decode(auth).decode()
            print(raw.split(":", 1)[0])
            break
        except Exception:
            pass
PY
)"
  fi
  NAMESPACE="${NAMESPACE:-unseencurtain}"
fi

if [[ -z "$TAG" ]]; then
  if git -C "$PE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TAG="$(git -C "$PE" rev-parse --short HEAD)"
  elif git -C "$PE/.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    TAG="$(git -C "$PE/.." rev-parse --short HEAD)"
  else
    echo "No git SHA here; pass --tag <short-sha>." >&2
    exit 1
  fi
fi

CORE_REPO="${NAMESPACE}/sillage-b2b"
WP_REPO="${NAMESPACE}/sillage-wordpress"

echo "==> namespace=${NAMESPACE} tag=${TAG} wordpress=${WITH_WORDPRESS}"
echo "==> build ${CORE_REPO}:${TAG} from ${CORE_DIR}"
docker build -t "${CORE_REPO}:${TAG}" "$CORE_DIR"

if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
  if [[ ! -f "$WP_DIR/Dockerfile" ]]; then
    echo "Missing $WP_DIR/Dockerfile (needed for --with-wordpress)." >&2
    exit 1
  fi
  echo "==> build ${WP_REPO}:${TAG} from ${WP_DIR}"
  docker build -t "${WP_REPO}:${TAG}" "$WP_DIR"
fi

if [[ "$PUSH_LATEST" -eq 1 ]]; then
  docker tag "${CORE_REPO}:${TAG}" "${CORE_REPO}:latest"
  if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
    docker tag "${WP_REPO}:${TAG}" "${WP_REPO}:latest"
  fi
fi

echo "==> push ${CORE_REPO}:${TAG}"
docker push "${CORE_REPO}:${TAG}"
if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
  echo "==> push ${WP_REPO}:${TAG}"
  docker push "${WP_REPO}:${TAG}"
fi

if [[ "$PUSH_LATEST" -eq 1 ]]; then
  docker push "${CORE_REPO}:latest"
  if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
    docker push "${WP_REPO}:latest"
  fi
fi

echo
echo "SILLAGE_CORE_IMAGE=${CORE_REPO}:${TAG}"
if [[ "$WITH_WORDPRESS" -eq 1 ]]; then
  echo "WORDPRESS_IMAGE=${WP_REPO}:${TAG}"
fi
if [[ "$PUSH_LATEST" -eq 1 ]]; then
  echo "# also tagged :latest"
fi
