#!/usr/bin/env bash
# EXAMPLE from the reference deployment. It runs `git reset --hard` in a fixed
# folder. Read it, change REPO/REMOTE/APP/PORT for your host, and do not run it
# unchanged. See AGENTS.md, "Safety items".
# programos VPS deploy — run ON the VPS:
#   ssh vps 'cd /opt/programos && ./scripts/deploy.sh'
# Generalized from _meta-optimization/scripts/vps-deploy.sh. Replaces the manual
# one-liner in CLAUDE.md, adding: lockfile-safe pull, build-before-restart,
# post-deploy health check, heartbeat sentinel. Pulls from remote `program`/main.
set -euo pipefail

REPO="/opt/programos"
REMOTE="program"; BRANCH="main"
APP="programos"          # pm2 process name
PORT=3003                    # shared HTTP server (webhook.ts routes by path)

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy:FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO"
log "Discarding lockfile churn so pull won't conflict…"
git checkout -- package-lock.json 2>/dev/null || true

log "Fetching $REMOTE/$BRANCH (authoritative reset)…"
git fetch "$REMOTE" "$BRANCH" --quiet
git reset --hard "$REMOTE/$BRANCH"

log "Installing + building (build MUST precede restart — stale dist footgun)…"
npm ci --silent 2>/dev/null || npm install --silent
npm run build

log "Restarting pm2 '$APP'…"
pm2 restart "$APP" --update-env

log "Health check: server responding on :$PORT ?"
sleep 2
for i in 1 2 3 4 5; do
  # No -f: any HTTP response (even 404) = server is up; only connection-refused fails.
  if curl -sS -o /dev/null --max-time 5 "http://localhost:$PORT/" 2>/dev/null; then
    log "Server up ✓  Deploy complete."
    mkdir -p "$HOME/.deploy-sentinels"; touch "$HOME/.deploy-sentinels/$APP"
    exit 0
  fi
  log "  no response yet ($i/5)…"; sleep 3
done
pm2 logs "$APP" --lines 30 --nostream 2>/dev/null || true
fail "Server never responded on :$PORT — process may have crashed. Logs above."
