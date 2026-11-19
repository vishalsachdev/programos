#!/bin/bash
# EXAMPLE launcher, used by ecosystem.config.cjs (pm2). The documented recipe
# (docs/deployment.md) uses the systemd unit written by setup/service.ts,
# which starts `node dist/index.js` itself and does not use this file.
# Runs from the folder this script is in, wherever the repo was cloned.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec node dist/index.js 2>&1
