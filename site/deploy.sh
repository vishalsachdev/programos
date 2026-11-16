#!/bin/bash
# Deploy the public site to Cloudflare Pages. The repo root is never sent.
#
# Usage: ./site/deploy.sh [--dry-run]
#   --dry-run: list the files that a deploy would send; send nothing
#
# The Pages project name comes from PAGES_PROJECT (default: programos).
# SITE_THEME selects the CSS palette (default: neutral; also accepts illinois).

set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$SITE_DIR/public"
PROJECT="${PAGES_PROJECT:-programos}"
THEME="${SITE_THEME:-neutral}"

case "$THEME" in
    neutral|illinois) ;;
    *) echo "Unknown SITE_THEME: $THEME (expected neutral or illinois)" >&2; exit 1 ;;
esac

[[ -f "$PUBLIC/index.html" ]] || { echo "No index.html in $PUBLIC" >&2; exit 1; }

# Refuse anything that is not a plain web file, and any symlink.
bad="$(find "$PUBLIC" \( -type l -o -type f ! \( -name '*.html' -o -name '*.css' -o -name '*.txt' -o -name '*.svg' -o -name '*.png' -o -name '*.ico' -o -name '*.xml' \) \) -print)"
if [[ -n "$bad" ]]; then
    echo "Refusing to deploy; unexpected files:" >&2
    echo "$bad" >&2
    exit 1
fi

DEPLOY_DIR="$PUBLIC"
if [[ "$THEME" == illinois ]]; then
    DEPLOY_DIR="$(mktemp -d)"
    trap 'rm -rf -- "$DEPLOY_DIR"' EXIT
    cp -R "$PUBLIC/." "$DEPLOY_DIR/"
    cp "$SITE_DIR/themes/illinois.css" "$DEPLOY_DIR/theme.css"
fi

echo "Files to deploy ($THEME theme):"
(cd "$DEPLOY_DIR" && find . -type f | sort)

if [[ "${1:-}" == "--dry-run" ]]; then
    echo "Dry run: nothing was sent."
    exit 0
fi

# wrangler reads CLOUDFLARE_API_TOKEN. Without it, wrangler uses its own login.
npx wrangler pages deploy "$DEPLOY_DIR" --project-name "$PROJECT" --branch main --commit-dirty=true
