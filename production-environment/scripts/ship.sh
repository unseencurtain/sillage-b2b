#!/usr/bin/env bash
# Ship this checkout to a box. One command, start to finish.
#
#   ./production-environment/scripts/ship.sh                 # gates → build → push → ovhe
#   ./production-environment/scripts/ship.sh --to ovhe --to ovh
#   ./production-environment/scripts/ship.sh --status        # what is each box running?
#   ./production-environment/scripts/ship.sh --rollback 82bd81e --to ovhe
#
# What it does, in order:
#   1. refuses a dirty tree (--dirty to override; the tag then says so)
#   2. typecheck + tests + dashboard build, locally, before anything leaves the laptop
#   3. builds the engine image on the builder box and pushes it to Hub, tagged with the commit
#      (skipped when that exact tag is already on Hub — re-shipping is then seconds)
#   4. for each target: pin the tag in that box's .env, pull, restart engine + scheduler
#   5. verifies /health, and that no operator setting changed across the deploy
#
# It never edits sil_settings, and it fails loudly if a deploy did. Each box's Sync enabled and
# cadence are that operator's — see docs/SYNC-RULES.md in unseencurtain/Sillage.
#
# Only the engine ships this way. WordPress, Caddy, media and the first-boot of an empty VPS are
# deploy-vps.sh's job — that runs once per box, this runs every time you change a line of code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE_DIR="$REPO_ROOT/production-environment/sillage-core"

# Wholesale. Retail ships from unseencurtain/Sillage with its own copy of this script.
IMAGE_REPO="${SILLAGE_SHIP_IMAGE_REPO:-unseencurtain/sillage-b2b}"
REMOTE_DIR="${SILLAGE_SHIP_REMOTE_DIR:-sillage-wholesale}"
BUILDER="${SILLAGE_SHIP_BUILDER:-ovhe}"
DEFAULT_TARGET="${SILLAGE_SHIP_TARGET:-ovhe}"

TARGETS=()
TAG=""
RUN_TESTS=1
ALLOW_DIRTY=0
FORCE_BUILD=0
MODE=deploy
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)        TARGETS+=("$2"); shift 2 ;;
    --tag)       TAG="$2"; shift 2 ;;
    --builder)   BUILDER="$2"; shift 2 ;;
    --rollback)  TAG="$2"; FORCE_BUILD=-1; RUN_TESTS=0; ALLOW_DIRTY=1; shift 2 ;;
    --no-test)   RUN_TESTS=0; shift ;;
    --dirty)     ALLOW_DIRTY=1; shift ;;
    --rebuild)   FORCE_BUILD=1; shift ;;
    --status)    MODE=status; shift ;;
    --prune)     MODE=prune; shift ;;
    -h|--help)   sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
[[ ${#TARGETS[@]} -eq 0 ]] && TARGETS=("$DEFAULT_TARGET")

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Values the operator owns. Bookkeeping rows the engine writes on every run are excluded — they
# are supposed to move. Anything left must read identically before and after a deploy.
OPERATOR_KEYS_SQL="setting_key NOT LIKE 'last_%' AND setting_key NOT LIKE 'live_fetch_count_%' \
AND setting_key NOT LIKE 'pending_%' AND setting_key NOT IN ('sync_abort','sync_lock')"

# Service names differ per stack (sillage-core/sillage-cron vs wholesale-core/wholesale-cron) and
# will differ again on a shop nobody has built yet. Resolve them from compose instead of guessing.
remote_services() {
  local host="$1"
  "${SSH[@]}" "$host" "cd ~/${REMOTE_DIR} && docker compose ps --services 2>/dev/null" || true
}

settings_snapshot() {
  local host="$1"
  "${SSH[@]}" "$host" "cd ~/${REMOTE_DIR} 2>/dev/null || exit 0
    set -a; . ./.env; set +a
    db=\$(docker compose ps --services 2>/dev/null | grep -E '(^|-)db\$' | head -1)
    [ -n \"\$db\" ] || exit 0
    cid=\$(docker compose ps -q \"\$db\")
    docker exec \"\$cid\" mariadb -uroot -p\"\$MYSQL_ROOT_PWD\" -N -B -e \
      \"SELECT CONCAT(setting_key,'=',setting_value) FROM \${SILLAGE_DB}.sil_settings \
        WHERE ${OPERATOR_KEYS_SQL} ORDER BY setting_key;\" 2>/dev/null" || true
}

# ---------------------------------------------------------------------------------------- status
if [[ "$MODE" == status ]]; then
  printf '%-8s %-46s %-10s %s\n' HOST IMAGE HEALTH SIZE
  for host in "${TARGETS[@]}"; do
    read -r img health size < <("${SSH[@]}" "$host" "cd ~/${REMOTE_DIR} 2>/dev/null || { echo '- - -'; exit 0; }
      img=\$(grep -E '^SILLAGE_CORE_IMAGE=' .env | cut -d= -f2-)
      core=\$(docker compose ps --services 2>/dev/null | grep -E '(^|-)core\$' | head -1)
      cid=\$(docker compose ps -q \"\$core\" 2>/dev/null)
      h=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \"\$cid\" 2>/dev/null || echo unknown)
      s=\$(docker image ls --format '{{.Size}}' --filter reference=\"\$img\" | head -1)
      echo \"\$img \$h \${s:-?}\"")
    printf '%-8s %-46s %-10s %s\n' "$host" "$img" "$health" "$size"
  done
  exit 0
fi

# ----------------------------------------------------------------------------------------- prune
if [[ "$MODE" == prune ]]; then
  for host in "${TARGETS[@]}" "$BUILDER"; do
    step "prune $host"
    "${SSH[@]}" "$host" 'docker image prune -f >/dev/null; docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || docker builder prune -f >/dev/null; df -h / | tail -1; docker system df | tail -4'
  done
  exit 0
fi

# ------------------------------------------------------------------------------------------ gates
cd "$REPO_ROOT"
DIRTY=0
git diff --quiet && git diff --cached --quiet || DIRTY=1
if [[ "$DIRTY" -eq 1 && "$ALLOW_DIRTY" -eq 0 ]]; then
  die "uncommitted changes. Commit them (the tag is the commit) or pass --dirty."
fi
if [[ -z "$TAG" ]]; then
  TAG="$(git rev-parse --short=7 HEAD)"
  [[ "$DIRTY" -eq 1 ]] && TAG="${TAG}-dirty"
fi
IMAGE="${IMAGE_REPO}:${TAG}"

if [[ "$RUN_TESTS" -eq 1 ]]; then
  step "gates — typecheck, tests, dashboard build"
  cd "$CORE_DIR"
  [[ -d node_modules ]] || bun install
  bun run typecheck >/dev/null || die "typecheck failed"
  ok "typecheck"
  bun test 2>&1 | tail -3
  bun run web:build >/dev/null 2>&1 || die "dashboard build failed"
  ok "dashboard build"
  cd "$REPO_ROOT"
fi

# ------------------------------------------------------------------------------------------ build
ON_HUB=0
if [[ "$FORCE_BUILD" -ne 1 ]]; then
  if "${SSH[@]}" "$BUILDER" "docker manifest inspect '$IMAGE' >/dev/null 2>&1"; then ON_HUB=1; fi
fi
if [[ "$FORCE_BUILD" -eq -1 ]]; then
  [[ "$ON_HUB" -eq 1 ]] || die "$IMAGE is not on Hub — nothing to roll back to."
  step "rollback to $IMAGE (already on Hub)"
elif [[ "$ON_HUB" -eq 1 ]]; then
  step "$IMAGE already on Hub — skipping build"
else
  step "build $IMAGE on $BUILDER"
  rsync -a --delete --exclude node_modules --exclude .feedscratch --exclude logs \
    -e "${SSH[*]}" "$CORE_DIR/" "$BUILDER:/tmp/sillage-ship-${REMOTE_DIR}/"
  "${SSH[@]}" "$BUILDER" "set -e
    cd /tmp/sillage-ship-${REMOTE_DIR}
    docker build --build-arg SOURCE_SHA='${TAG}' -t '${IMAGE}' . >/tmp/ship-build.log 2>&1 || { tail -30 /tmp/ship-build.log; exit 1; }
    docker push -q '${IMAGE}' >/dev/null
    docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true"
  ok "pushed $IMAGE ($("${SSH[@]}" "$BUILDER" "docker image inspect --format '{{.Size}}' '$IMAGE'" | awk '{printf "%d MB", $1/1000000}'))"
fi

# ----------------------------------------------------------------------------------------- deploy
FAILED=()
for host in "${TARGETS[@]}"; do
  step "deploy $IMAGE → $host:~/$REMOTE_DIR"
  BEFORE="$(settings_snapshot "$host")"

  if ! "${SSH[@]}" "$host" "set -e
    cd ~/${REMOTE_DIR} || { echo 'no ~/${REMOTE_DIR} on this box — run deploy-vps.sh first' >&2; exit 1; }
    cp .env .env.ship-backup
    if grep -q '^SILLAGE_CORE_IMAGE=' .env; then
      sed -i 's|^SILLAGE_CORE_IMAGE=.*|SILLAGE_CORE_IMAGE=${IMAGE}|' .env
    else
      echo 'SILLAGE_CORE_IMAGE=${IMAGE}' >> .env
    fi
    core=\$(docker compose ps --services | grep -E '(^|-)core\$' | head -1)
    cron=\$(docker compose ps --services | grep -E '(^|-)cron\$' | head -1)
    docker compose pull -q \$core \$cron
    docker compose up -d \$core \$cron >/dev/null 2>&1
    for i in \$(seq 1 30); do
      cid=\$(docker compose ps -q \$core)
      st=\$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \$cid 2>/dev/null || echo starting)
      case \"\$st\" in healthy|running) break ;; esac
      sleep 2
    done
    docker compose exec -T \$core bun -e \"const r=await fetch('http://127.0.0.1:4000/health'); if(!r.ok) process.exit(1)\" \
      || { echo 'engine did not answer /health — rolling .env back' >&2; mv .env.ship-backup .env; docker compose up -d \$core \$cron >/dev/null 2>&1; exit 1; }
    rm -f .env.ship-backup
    # Keep the running tag and the one before it — enough to roll back without a pull, while a box
    # that has been shipped to fifty times does not carry fifty engine images.
    docker image ls --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' --filter reference='${IMAGE_REPO}' \
      | sort -rk2 | tail -n +3 | cut -d' ' -f1 \
      | xargs -r -n1 docker rmi >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true"
  then
    FAILED+=("$host"); printf '    \033[31m✗ %s\033[0m\n' "$host: deploy failed, .env restored"; continue
  fi
  ok "engine healthy"

  AFTER="$(settings_snapshot "$host")"
  if [[ -n "$BEFORE" && "$BEFORE" != "$AFTER" ]]; then
    printf '    \033[31m✗ operator settings changed across this deploy:\033[0m\n'
    diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | sed 's/^/      /' || true
    FAILED+=("$host")
  else
    ok "operator settings untouched ($(printf '%s\n' "$AFTER" | grep -c . ) rows identical)"
  fi

  REV="$("${SSH[@]}" "$host" "docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$IMAGE' 2>/dev/null" | tr -d '[:space:]')"
  [[ "$REV" == "$TAG" ]] && ok "image built from $REV" || printf '    \033[33m! image revision label says %s\033[0m\n' "${REV:-none}"
done

step "shipped $IMAGE"
"${BASH_SOURCE[0]}" --status $(printf -- '--to %s ' "${TARGETS[@]}")
[[ ${#FAILED[@]} -eq 0 ]] || die "failed on: ${FAILED[*]}"
