#!/usr/bin/env bash
#
# nightly.sh — one bounded RPD experiment batch per night.
#
# Runs the candidates spec, grades it, publishes the gallery, announces it, and
# appends a LEARNINGS row. Designed to be run by launchd/cron with NO Claude
# session attached: it spends money, so every guard is in the script itself
# rather than in an agent's judgement.
#
#   ./scripts/rpd/loop/nightly.sh [--max-usd 2] [--spec path] [--dry]
#
# MONEY:
#   - Hard cap, default $2, passed straight to `rpd run --live --max-usd`.
#     The harness refuses the whole batch if the estimate exceeds it.
#   - IDEMPOTENT PER DAY: a stamp file means a second invocation on the same
#     date exits without spending. launchd re-fires a missed job on wake, and
#     "catch up" must not mean "generate twice".
#   - Recovery is `rpd resume` (free), never a second --live.
#
# Requires: ATLAS_API_KEY. Optional: CLOUDFLARE_API_TOKEN (+ACCOUNT_ID) to
# publish, SLACK_BOT_TOKEN + RPD_SLACK_CHANNEL to announce.
# Credentials come from the environment or ~/.rpd-nightly.env (chmod 600),
# never from this file.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_DIR" || exit 1

MAX_USD="2"
SPEC="scripts/rpd/loop/nightly-spec.json"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-usd) MAX_USD="${2:-2}"; shift 2 ;;
    --spec)    SPEC="${2:-$SPEC}"; shift 2 ;;
    --dry)     DRY=1; shift ;;
    *) echo "nightly: unknown arg $1" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1090
[ -f "$HOME/.rpd-nightly.env" ] && . "$HOME/.rpd-nightly.env"

STATE_DIR="$HOME/.rpd-nightly"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$LOG_DIR"
TODAY="$(date +%Y-%m-%d)"
STAMP="$STATE_DIR/last-run-$TODAY"
LOG="$LOG_DIR/$TODAY.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

if [ -f "$STAMP" ] && [ "$DRY" -eq 0 ]; then
  log "already ran today ($TODAY) — exiting without spending. Remove $STAMP to force."
  exit 0
fi

# MISCONFIGURATION vs NOTHING QUEUED — these must not look the same. A scheduled
# job pointed at a checkout without the harness would exit 0 every night and read
# as "quiet week" forever (which is exactly what happened: the launchd job was
# installed against the shared checkout, where scripts/rpd does not exist on main).
if [ ! -f scripts/rpd/rpd.js ]; then
  log "MISCONFIGURED: no scripts/rpd/rpd.js under $(pwd) — this checkout does not contain the harness."
  log "Point the scheduled job at a checkout/worktree that has it, or merge the harness to this branch."
  exit 2
fi

if [ ! -f "$SPEC" ]; then
  log "no spec at $SPEC — nothing queued for tonight. Exiting 0 (this is a legitimate no-op)."
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  log "DRY: dry-run only, nothing billable"
  node scripts/rpd/rpd.js run "$SPEC" --out rpd-runs 2>&1 | tee -a "$LOG"
  exit $?
fi

if [ -z "${ATLAS_API_KEY:-}" ]; then
  log "ATLAS_API_KEY is not set (env or ~/.rpd-nightly.env) — cannot run live. Exiting."
  exit 1
fi

# Claim the day BEFORE spending: if the box dies mid-run, the next invocation
# must not start a second billable batch. The receipts on disk plus `rpd resume`
# are how an interrupted run is finished.
touch "$STAMP"

log "live run, cap \$$MAX_USD, spec $SPEC"
RUN_OUT="$(node scripts/rpd/rpd.js run "$SPEC" --live --max-usd "$MAX_USD" --out rpd-runs 2>&1)"
echo "$RUN_OUT" | tee -a "$LOG"

# The run prints its directory; parse rather than guess (names are timestamped).
RUN_DIR="$(echo "$RUN_OUT" | sed -n 's/^Run dir: //p' | tail -1)"
if [ -z "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ]; then
  log "could not determine the run directory — stopping. Check the log; finish with: node scripts/rpd/rpd.js resume <runDir>"
  exit 1
fi

# Any cell left holding a receipt gets finished for free.
if grep -q "unsettled receipt" <<<"$RUN_OUT"; then
  log "unsettled receipts — resuming (free)"
  node scripts/rpd/rpd.js resume "$RUN_DIR" 2>&1 | tee -a "$LOG"
fi

log "auto-eval"
node scripts/rpd/rpd.js eval "$RUN_DIR" --eval-max-usd 0.5 2>&1 | tee -a "$LOG"

GALLERY_URL=""
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  log "publishing"
  PUB_OUT="$(node scripts/rpd/rpd.js publish "$RUN_DIR" --project rs-rpd 2>&1)"
  echo "$PUB_OUT" | tee -a "$LOG"
  GALLERY_URL="$(echo "$PUB_OUT" | sed -n 's/^Published: //p' | tail -1)"
else
  log "CLOUDFLARE_API_TOKEN unset — skipping publish (gallery is local only)"
fi

# Append one LEARNINGS row so the log stays the team's index. Marked auto so a
# human knows nobody has looked at it yet.
SETTLED="$(node -e '
  const m = require(process.argv[1] + "/manifest.json");
  const s = (m.cells||[]).filter(c=>c.costSource==="actual").reduce((a,c)=>a+c.costUsd,0);
  process.stdout.write("$" + s.toFixed(2));
' "$RUN_DIR" 2>/dev/null || echo 'unknown')"
SPEC_NAME="$(basename "$RUN_DIR")"
{
  printf '| %s | %s | %s | %s | _auto (nightly loop) — unreviewed; see the gallery notes for the auto-eval verdicts._ |\n' \
    "$TODAY" "$SPEC_NAME" "$SETTLED" "${GALLERY_URL:-local only}"
} >> scripts/rpd/LEARNINGS.md
log "appended a LEARNINGS row ($SETTLED settled)"

log "done: $RUN_DIR"
