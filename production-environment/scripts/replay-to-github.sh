#!/usr/bin/env bash
# Replay this checkout onto GitHub `unseencurtain/Sillage` main.
#
# Cursor origin and GitHub have **parallel SHAs**. Do not `git merge` or add GitHub
# as a remote on the Cursor clone. Copy files onto a fresh GitHub `main` checkout.
#
#   GITHUB_TOKEN=ghp_... ./production-environment/scripts/replay-to-github.sh
#   # or SSH: ssh -T git@github.com  then run without a token
#
# Optional: REPLAY_B2B=1 also updates unseencurtain/sillage-b2b README to point here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${REPLAY_WORKDIR:-/tmp/sillage-github-replay}"
B2B_WORKDIR="${REPLAY_B2B_WORKDIR:-/tmp/sillage-b2b-replay}"
GITHUB_SILLAGE="${GITHUB_SILLAGE_REPO:-unseencurtain/Sillage}"
GITHUB_B2B="${GITHUB_B2B_REPO:-unseencurtain/sillage-b2b}"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout: $ROOT" >&2
  exit 1
fi

src_sha="$(git -C "$ROOT" rev-parse --short HEAD)"
src_subject="$(git -C "$ROOT" log -1 --format=%s)"

install_unseencurtain_key() {
  local keyfile="${HOME}/.ssh/unseencurtain"
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  if [[ -n "${UNSEENCURTAIN_SSH_PRIVATE_KEY:-}" && ! -f "$keyfile" ]]; then
    printf '%s\n' "$UNSEENCURTAIN_SSH_PRIVATE_KEY" >"$keyfile"
    chmod 600 "$keyfile"
  fi
  if [[ -f "$keyfile" ]]; then
    if [[ ! -f "${HOME}/.ssh/config" ]] || ! grep -q 'IdentityFile.*unseencurtain' "${HOME}/.ssh/config" 2>/dev/null; then
      cat >>"${HOME}/.ssh/config" <<'CFG'
Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/unseencurtain
    IdentitiesOnly yes
CFG
      chmod 600 "${HOME}/.ssh/config"
    fi
    export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i ${HOME}/.ssh/unseencurtain -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
  fi
}

push_url() {
  local repo="$1"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf 'https://x-access-token:%s@github.com/%s.git' "$GITHUB_TOKEN" "$repo"
  else
    printf 'git@github.com:%s.git' "$repo"
  fi
}

replay_sillage() {
  rm -rf "$WORKDIR"
  mkdir -p "$(dirname "$WORKDIR")"
  echo "==> clone github.com/${GITHUB_SILLAGE} (main only)"
  git clone --depth 1 --branch main "https://github.com/${GITHUB_SILLAGE}.git" "$WORKDIR"
  github_sha="$(git -C "$WORKDIR" rev-parse --short HEAD)"
  echo "    github HEAD ${github_sha}"
  echo "    source HEAD ${src_sha} (${src_subject})"

  echo "==> replace tree with tracked files from ${ROOT}"
  git -C "$WORKDIR" rm -r --quiet -f --ignore-unmatch .
  git -C "$ROOT" archive HEAD | tar -x -C "$WORKDIR"
  git -C "$WORKDIR" add -A

  if git -C "$WORKDIR" diff --cached --quiet; then
    echo "    GitHub main already matches this tree"
    return 0
  fi

  git -C "$WORKDIR" \
    -c user.name="${GIT_AUTHOR_NAME:-Cursor Agent}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-cursoragent@cursor.com}" \
    commit -m "$(cat <<EOF
Replay live wholesale storefront onto GitHub main

Cursor origin SHA ${src_sha} (${src_subject}). GitHub was still on ${github_sha}
(sitemap Hub note, 2026-09-03). Histories are parallel — files copied, remotes
not merged.

Wholesale shop is in this repo (SILLAGE_PROFILE=wholesale), not sillage-b2b.
EOF
)"
  echo "==> push ${GITHUB_SILLAGE} main"
  git -C "$WORKDIR" push "$(push_url "$GITHUB_SILLAGE")" HEAD:main
  echo "    pushed $(git -C "$WORKDIR" rev-parse --short HEAD)"
}

replay_b2b_pointer() {
  rm -rf "$B2B_WORKDIR"
  echo "==> clone github.com/${GITHUB_B2B}"
  git clone --depth 1 --branch main "https://github.com/${GITHUB_B2B}.git" "$B2B_WORKDIR"
  cat > "$B2B_WORKDIR/README.md" <<'EOF'
# Sillage B2B (archive)

**Do not deploy this repo.** Live wholesale is in
[unseencurtain/Sillage](https://github.com/unseencurtain/Sillage) as a second
WordPress on the same VPS (`SILLAGE_PROFILE=wholesale`).

| | Live |
|---|---|
| Shop | https://wholesale.mirainikki.xyz |
| Dashboard | https://sillage-wholesale.mirainikki.xyz |
| Spec | [`docs/WHOLESALE-SITE.md`](https://github.com/unseencurtain/Sillage/blob/main/docs/WHOLESALE-SITE.md) in **Sillage** |
| Vendor | wholesale-perfumes only, €300 MOQ, sandbox dispatch |

This tree was an August 2026 extract (`pre-scratch-20260808`) of the
wholesale-perfumes connector. The vendor code, compose profile, and shop now
live in Sillage. Cart/order API notes remain under `docs/` here for history.

Retail LPS ([unseencurtain/Sillage](https://github.com/unseencurtain/Sillage))
still sells BeautyFort + BTS only.
EOF
  cat > "$B2B_WORKDIR/sillage-vendor/README.md" <<'EOF'
# Archive extract — do not deploy

This folder is a snapshot of the wholesale-perfumes connector from August 2026.
Live code is in [unseencurtain/Sillage](https://github.com/unseencurtain/Sillage):

`production-environment/sillage-core/src/vendors/wholesale-perfumes/`

Shop: https://wholesale.mirainikki.xyz (`SILLAGE_PROFILE=wholesale`).
Do not wire this extract into a new stack.
EOF
  git -C "$B2B_WORKDIR" add README.md sillage-vendor/README.md
  if git -C "$B2B_WORKDIR" diff --cached --quiet; then
    echo "    sillage-b2b README already current"
    return 0
  fi
  git -C "$B2B_WORKDIR" \
    -c user.name="${GIT_AUTHOR_NAME:-Cursor Agent}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-cursoragent@cursor.com}" \
    commit -m "$(cat <<EOF
Point README at live wholesale in unseencurtain/Sillage

The extracted scaffold is not what runs on ovhe. Shop and engine are
SILLAGE_PROFILE=wholesale in the main Sillage repo.
EOF
)"
  echo "==> push ${GITHUB_B2B} main"
  git -C "$B2B_WORKDIR" push "$(push_url "$GITHUB_B2B")" HEAD:main
  echo "    pushed $(git -C "$B2B_WORKDIR" rev-parse --short HEAD)"
}

install_unseencurtain_key
replay_sillage
if [[ "${REPLAY_B2B:-1}" == "1" ]]; then
  replay_b2b_pointer
fi
