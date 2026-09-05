#!/usr/bin/env bash
#
# render-nightly.sh — the nightly RPD batch, shaped for a Render Cron Job.
#
# WHAT IS DIFFERENT FROM nightly.sh (and why it is a separate entrypoint):
# Render's filesystem is EPHEMERAL. manifest.json is the spend ledger, so the
# local-only assumptions of nightly.sh do not hold here:
#
#   1. The per-day stamp file cannot dedupe (fresh disk every run), so the
#      schedule itself is the only guard — keep it to ONE fire per day.
#   2. Receipts must leave the box the instant they exist → RPD_RECEIPT_SLACK=1
#      posts every predictionId to Slack at the charge point.
#   3. Artifacts AND the ledger must be mirrored → --upload sends media plus
#      manifest.json to Cloudinary. Without it a completed run leaves nothing.
#   4. `rpd resume` cannot help a dead box (the run dir is gone), which is the
#      real reason (2) and (3) are mandatory rather than nice-to-have.
#
# REQUIRED env (already present on both liquidretail_backend services):
#   ATLAS_API_KEY, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, SLACK_BOT_TOKEN
# REQUIRED extra:
#   RPD_SLACK_CHANNEL       — where receipts + the summary go
# OPTIONAL:
#   RPD_MAX_USD             — nightly cap, default 2
#   RPD_SPEC                — spec path, default the committed candidates spec
#   NETLIFY_AUTH_TOKEN      — publish the gallery from Render (token = account
#                             selector; an interactive `netlify login` is
#                             impossible here). Pair with RPD_NETLIFY_TEAM.
#   RPD_NETLIFY_TEAM        — team slug, e.g. decastro-mark85 (Flood QRF, Pro)
#   CLOUDFLARE_API_TOKEN    — only if RPD_PUBLISH_HOST=cloudflare
#   MONGODB_URI             — only if a spec uses seed.productId

set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" || exit 1

MAX_USD="${RPD_MAX_USD:-2}"
SPEC="${RPD_SPEC:-scripts/rpd/loop/nightly-spec.json}"
export RPD_RECEIPT_SLACK=1

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

# FAIL CLOSED on a host where results cannot survive. Spending money and then
# discarding the evidence is worse than not running: nobody could reconcile it.
missing=""
[ -z "${ATLAS_API_KEY:-}" ]           && missing="$missing ATLAS_API_KEY"
[ -z "${CLOUDINARY_API_KEY:-}" ]      && missing="$missing CLOUDINARY_API_KEY"
[ -z "${CLOUDINARY_API_SECRET:-}" ]   && missing="$missing CLOUDINARY_API_SECRET"
[ -z "${SLACK_BOT_TOKEN:-}" ]         && missing="$missing SLACK_BOT_TOKEN"
[ -z "${RPD_SLACK_CHANNEL:-}" ]       && missing="$missing RPD_SLACK_CHANNEL"
if [ -n "$missing" ]; then
  log "REFUSING to run — ephemeral host with no way to persist results or receipts. Missing:$missing"
  exit 1
fi

[ -f "$SPEC" ] || { log "no spec at $SPEC — nothing queued. Exiting 0."; exit 0; }

log "dry run first (free) — proves the spec parses and prices before any submit"
node scripts/rpd/rpd.js run "$SPEC" --out /tmp/rpd-runs || { log "dry run failed"; exit 1; }

log "live run, cap \$$MAX_USD"
RUN_OUT="$(node scripts/rpd/rpd.js run "$SPEC" --live --max-usd "$MAX_USD" --upload --out /tmp/rpd-runs 2>&1)"
echo "$RUN_OUT"
RUN_DIR="$(echo "$RUN_OUT" | command sed -n 's/^Run dir: //p' | command tail -1)"
[ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || { log "could not determine the run dir — receipts were posted to Slack; reconcile from there"; exit 1; }

if echo "$RUN_OUT" | command grep -q "unsettled receipt"; then
  log "unsettled receipts — resuming (free)"
  node scripts/rpd/rpd.js resume "$RUN_DIR" || true
fi

log "auto-eval"
node scripts/rpd/rpd.js eval "$RUN_DIR" --eval-max-usd "${RPD_EVAL_MAX_USD:-0.5}" || log "eval failed (non-fatal)"

PUB_HOST="${RPD_PUBLISH_HOST:-netlify}"
if { [ "$PUB_HOST" = "netlify" ] && [ -n "${NETLIFY_AUTH_TOKEN:-}" ]; } \
   || { [ "$PUB_HOST" = "cloudflare" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; }; then
  log "publishing gallery to $PUB_HOST"
  node scripts/rpd/rpd.js publish "$RUN_DIR" --host "$PUB_HOST" \
    --site "${RPD_PAGES_PROJECT:-rs-rpd}" ${RPD_NETLIFY_TEAM:+--team "$RPD_NETLIFY_TEAM"} \
    || log "publish failed (non-fatal)"
else
  log "no token for $PUB_HOST — gallery not published; media + ledger are mirrored to Cloudinary"
fi

# LEARNINGS.md cannot be appended from here (no writable checkout, and a cron job
# must not push to git). The Slack summary IS the record for hosted runs; a human
# promotes anything worth keeping into LEARNINGS.md by PR.
log "done: $RUN_DIR"
