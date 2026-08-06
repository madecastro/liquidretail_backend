#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Repo trap this closes (CLAUDE.md §4): node_modules is gitignored but a
# partial subset (~4.9k files, committed before the ignore rule existed) is
# still tracked in git. That subset is stale and incomplete relative to
# package-lock.json — a fresh clone is missing hundreds of packages
# (https-proxy-agent among them), so any script that pulls in axios throws
# MODULE_NOT_FOUND. `npm install` reconciles the tree against
# package-lock.json and fixes all of it in one pass, not just the one
# symptom that happened to be hit first.
#
# Production (Render) is unaffected either way — Render's own build step
# runs `npm install` from package.json/package-lock.json regardless of what
# is committed here (proven by the existing "postinstall" script, which only
# makes sense if npm install actually runs on deploy). This hook exists
# purely so local Claude Code sessions don't have to rediscover and
# hand-patch the same gap every time.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# --ignore-scripts: the package.json "postinstall" step downloads a Remotion
# headless-shell browser binary from remotion.media, which this
# environment's network egress policy can block (403 "Host not in
# allowlist"). That download is only needed for actually rendering video —
# irrelevant to fixing MODULE_NOT_FOUND — so it must not fail dependency
# install. Run it separately, best-effort, after the packages that code
# actually `require()` are safely on disk.
npm install --ignore-scripts
node scripts/ensurePuppeteerChrome.js || true
node scripts/ensureRemotionBrowser.js || true
