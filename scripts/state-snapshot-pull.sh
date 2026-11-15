#!/usr/bin/env bash
# EXAMPLE from the reference deployment. It connects to a fixed SSH host and
# pushes commits. Change the paths and hosts for your setup before use. See AGENTS.md.
# Mac-side runner for the VPS state snapshot (see scripts/state-snapshot.mjs).
#
# Runs from cron on an operator machine that has push rights (the server
# deploy key is read-only, so the server cannot push).
#
# Success path only touches the sentinel AFTER a clean push (or a verified
# no-change run) — a stranded local commit must read as stale, not healthy.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

REPO="${STATE_SNAPSHOT_REPO:-/home/operator/code/programos}"
OUT_DIR="$REPO/ops/state-snapshot"
OUT="$OUT_DIR/db-state.json"
SENTINEL="$HOME/.cron-sentinels/nanoclaw-state-snapshot"

cd "$REPO"

# Refuse to run on a non-main checkout — never commit snapshots to a feature
# branch mid-session.
branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "state-snapshot: repo on branch '$branch', not main — skipping" >&2
  exit 1
fi

# Never rebase: a rebase linearises unpushed merge commits and, on conflict,
# strands main mid-rebase on a detached HEAD. A diverged main
# needs a human; exit before the sentinel so the heartbeat reports it.
if ! git pull --quiet --ff-only; then
  echo "state-snapshot: main has diverged from its upstream and cannot fast-forward; push or reconcile by hand (not rebasing)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
tmp=$(mktemp)
# STATE_SNAPSHOT_CMD lets tests supply a fixture instead of reaching the VPS.
bash -c "${STATE_SNAPSHOT_CMD:-ssh vps 'node /opt/programos/scripts/state-snapshot.mjs'}" > "$tmp"
# Sanity: refuse to commit an empty/truncated dump over a good one.
node -e "const s=require('fs').readFileSync('$tmp','utf8');const j=JSON.parse(s);if(!Array.isArray(j.scheduled_tasks)||j.scheduled_tasks.length===0)process.exit(1)"
mv "$tmp" "$OUT"

# Every upstream query below checks its own exit status: a failed query
# prints nothing, and "nothing" must never read as "nothing unpushed".
fail() {
  echo "state-snapshot: $1 (sentinel left stale)" >&2
  exit 1
}

# rev-list --count prints a number on success, so 0 is distinguishable from
# a failure; anything but a number is a failure too.
unpushed_count() {
  local n
  n=$(git rev-list --count '@{u}..HEAD') || {
    echo "state-snapshot: cannot count commits not on origin (sentinel left stale)" >&2
    return 1
  }
  case "$n" in
    '' | *[!0-9]*)
      echo "state-snapshot: unexpected rev-list output '$n' (sentinel left stale)" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$n"
}

# Only snapshot commits are ever published from here; unpushed human work
# waits for a human.
# No `grep -q`: an early exit would SIGPIPE and, under pipefail, skip this.
subjects=$(git log --format=%s '@{u}..HEAD') || fail "cannot list commits not on origin"
nonsnap=$(printf '%s\n' "$subjects" | grep -v '^ops: state snapshot ' || true)
if [ -n "$nonsnap" ]; then
  fail "main has unpushed non-snapshot commits; not publishing them"
fi

if git diff --quiet -- "$OUT" && git ls-files --error-unmatch "$OUT" >/dev/null 2>&1; then
  : # no change — still a successful run
else
  git add "$OUT"
  git commit --quiet -m "ops: state snapshot $(date +%Y-%m-%d)"
fi

# Publish anything unpushed, including a snapshot commit stranded by an
# earlier failed push, and prove it reached origin before the sentinel.
ahead=$(unpushed_count) || exit 1
if [ "$ahead" -gt 0 ]; then
  git push --quiet || true
  git fetch --quiet
fi
ahead=$(unpushed_count) || exit 1
if [ "$ahead" -ne 0 ]; then
  fail "snapshot commit not on origin after push"
fi

mkdir -p "$HOME/.cron-sentinels"
touch "$SENTINEL"
echo "state-snapshot: ok $(date)"
