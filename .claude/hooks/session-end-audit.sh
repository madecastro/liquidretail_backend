#!/bin/bash
# ============================================================================
# DEVELOPER TOOLING — NOT PART OF THE REACH SOCIAL PRODUCT.
#
# This file exists ONLY to warn Claude Code sessions (and any human sitting
# in front of one) that work is about to be left stranded. It is not
# application code, is not imported by anything the product runs, and never
# executes in production — Render never invokes .claude/ hooks; deleting
# this whole directory changes nothing about how the service builds, deploys,
# or behaves. Same framing as the sibling session-start.sh in this same
# directory — read that file's own header if you're auditing what runs where.
#
# WHY THIS EXISTS: see CLAUDE.md's "Stranded-work tooling" section. Short
# version — a branch sat 5 days with 9 commits never pushed anywhere, inside
# a nested worktree locked by a dead PID, and nearly took a live production
# bug fix with it. A SessionEnd hook is the cheapest forcing function that
# catches this at the one moment a human is guaranteed to glance at the
# terminal: right as the session ends. This repo already had
# scripts/findOrphanedBranches.js / findStaleUncommittedWork.js sitting on
# main, unused, for exactly this reason — nothing pointed a session at them.
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
# $CLAUDE_PROJECT_DIR is populated by the harness (same variable
# session-start.sh already relies on in this directory).
#
# MONOREPO (2026-09-06): Claude Code only loads .claude/ at the project
# root, so this is the only SessionEnd hook that runs. One invocation is
# enough for the grafted tree: auditStrandedWork.js is git/filesystem-only
# against --repo, and git worktree/branch enumeration is repo-wide, so
# adgen/ branches, worktrees, and nested-inside-this-checkout paths are
# already in the same scan. The two copies of the script (scripts/ and
# adgen/scripts/) are byte-identical; adgen/ is not its own git repo, and
# a second run of adgen/scripts/auditStrandedWork.js is not needed.
# adgen/.claude/ is inert — see the comment in that hook.
#
# `|| echo` (not `2>/dev/null || true`): --hook already always-exits-0
# when node actually runs the script. The fallback is for the miss the
# graft created — CLAUDE_PROJECT_DIR pointing at a path with no script —
# so a broken path still prints a systemMessage instead of going silent.
AUDIT_SCRIPT="$CLAUDE_PROJECT_DIR/scripts/auditStrandedWork.js"
node "$AUDIT_SCRIPT" --repo="$CLAUDE_PROJECT_DIR" --hook || echo '{"systemMessage":"session-end stranded-work audit failed to run — check .claude/hooks/session-end-audit.sh"}'
