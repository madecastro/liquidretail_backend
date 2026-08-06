#!/bin/bash
# ============================================================================
# DEVELOPER TOOLING — NOT PART OF THE REACH SOCIAL PRODUCT.
#
# This file exists ONLY to set up Claude Code sessions that work on this repo.
# It is not application code, it is not imported by anything the product runs,
# and it never executes in production:
#
#   * NOT on Render (web or worker). Render runs `npm install` + the
#     package.json "postinstall" from its own build pipeline and never reads
#     .claude/. Deleting this entire .claude/ directory would change nothing
#     about how the product builds, deploys, or behaves.
#   * NOT in the API, the worker, the render queue, or any billable path.
#   * NOT on a developer's local machine either — the CLAUDE_CODE_REMOTE guard
#     below makes it a no-op unless the session is a Claude Code web session.
#
# If you are auditing what the product does, skip this file. If you are
# removing Claude tooling from the repo, this file and .claude/settings.json
# go together and nothing else depends on them.
# ============================================================================
#
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
