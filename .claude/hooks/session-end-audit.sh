#!/bin/bash
# ============================================================================
# DEVELOPER TOOLING — NOT PART OF THE REACH SOCIAL PRODUCT.
#
# This file exists ONLY to warn Claude Code sessions (and any human sitting
# in front of one) that work is about to be left stranded. It is not
# application code, is not imported by anything the product runs, and never
# executes in production — Render never invokes .claude/ hooks; deleting
# this whole directory changes nothing about how the service builds, deploys,
# or behaves.
#
# WHY THIS EXISTS: see CLAUDE.md's "Stranded-work tooling" section. Short
# version — a branch sat 5 days with 9 commits never pushed anywhere, inside
# a nested worktree locked by a dead PID, and nearly took a live production
# bug fix with it. A SessionEnd hook is the cheapest forcing function that
# catches this at the one moment a human is guaranteed to glance at the
# terminal: right as the session ends.
#
# CONTRACT WITH THE HARNESS — read before touching this file:
#   - MUST be non-blocking: the session is already ending, there is no later
#     turn to block, but this still must never hang or throw uncaught.
#   - MUST always exit 0. auditStrandedWork.js's own --hook mode already
#     guarantees this (try/catch around everything, always exit 0), but the
#     `|| true` here is a second, cheaper layer in case node itself is
#     missing/broken/times out — a hook script failing must never read as
#     "your session failed."
#   - Prints exactly one line of {"systemMessage": "..."} JSON on success,
#     which Claude Code surfaces to the user. See auditStrandedWork.js's own
#     --hook mode for the actual summary logic; this script is deliberately
#     a thin, auditable wrapper around it, not a reimplementation.
#
# $CLAUDE_PROJECT_DIR is populated by the harness (same pattern already used
# by this repo's own session-start hook, where one exists — see the sibling
# liquidretail_backend repo's .claude/hooks/session-start.sh for that
# precedent this file follows).
node "$CLAUDE_PROJECT_DIR/scripts/auditStrandedWork.js" --repo="$CLAUDE_PROJECT_DIR" --hook 2>/dev/null || true
