#!/bin/bash
# Deploy site/public/ to Cloudflare Pages. Only that folder is sent, never the repo root.
#
# Usage: ./site/deploy.sh [--dry-run]
#   --dry-run: list the files that a deploy would send; send nothing
#
# The Pages project name comes from PAGES_PROJECT (default: programos).

set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC="$SITE_DIR/public"
PROJECT="${PAGES_PROJECT:-programos}"

[[ -f "$PUBLIC/index.html" ]] || { echo "No index.html in $PUBLIC" >&2; exit 1; }

# Refuse anything that is not a plain web file, and any symlink.
bad="$(find "$PUBLIC" \( -type l -o -type f ! \( -name '*.html' -o -name '*.css' -o -name '*.txt' -o -name '*.svg' -o -name '*.png' -o -name '*.ico' -o -name '*.xml' \) \) -print)"
if [[ -n "$bad" ]]; then
    echo "Refusing to deploy; unexpected files:" >&2
    echo "$bad" >&2
    exit 1
fi

echo "Files in $PUBLIC:"
(cd "$PUBLIC" && find . -type f | sort)

if [[ "${1:-}" == "--dry-run" ]]; then
    echo "Dry run: nothing was sent."
    exit 0
fi

# wrangler reads CLOUDFLARE_API_TOKEN. Without it, wrangler uses its own login.
npx wrangler pages deploy "$PUBLIC" --project-name "$PROJECT" --branch main --commit-dirty=true
