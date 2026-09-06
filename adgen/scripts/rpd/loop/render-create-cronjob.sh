#!/usr/bin/env bash
#
# render-create-cronjob.sh — create the RPD nightly Cron Job on Render.
#
# NOTHING IS APPLIED UNTIL YOU RUN THIS. It is the "ready to deploy" artifact:
# one command, no dashboard clicking, and no render.yaml (a Blueprint would pull
# the existing dashboard-managed WEB and WORKER services under file control as a
# side effect of adding a cron job).
#
#   RENDER_API_KEY=...  ./scripts/rpd/loop/render-create-cronjob.sh [--dry]
#
# A SEPARATE service on purpose: experiment spend and a harness bug stay away
# from the production render queue, and only this service holds a Netlify token.
#
# Env it needs (the script refuses without them, so the service is never created
# half-configured and then silently unable to keep its receipts):
#   RENDER_API_KEY        Render API key (or ~/.render/cli.yaml)
#   ATLAS_API_KEY         billable generation
#   CLOUDINARY_API_KEY    mirror artifacts + the ledger off the ephemeral disk
#   CLOUDINARY_API_SECRET
#   SLACK_BOT_TOKEN       receipts must escape the box
#   RPD_SLACK_CHANNEL     where receipts + the summary land
# Optional:
#   NETLIFY_AUTH_TOKEN + RPD_NETLIFY_TEAM   publish galleries from Render
#   MONGODB_URI                             only for seed.productId specs
#   RPD_MAX_USD (default 2), RPD_BRANCH (default main)

set -uo pipefail

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

KEY="${RENDER_API_KEY:-$(grep -oE '[A-Za-z0-9_\-]{30,}' "$HOME/.render/cli.yaml" 2>/dev/null | head -1)}"
[ -n "$KEY" ] || { echo "need RENDER_API_KEY (or a ~/.render/cli.yaml)"; exit 1; }

OWNER="${RENDER_OWNER_ID:-tea-d1ved76mcj7s73fad3og}"   # Reach-Social team
REPO="${RENDER_REPO:-https://github.com/Emami-RS-Project/liquidretail_backend}"
BRANCH="${RPD_BRANCH:-main}"
SCHEDULE="${RPD_SCHEDULE:-17 2 * * *}"                  # 02:17 UTC, off the hour

missing=""
for v in ATLAS_API_KEY CLOUDINARY_API_KEY CLOUDINARY_API_SECRET SLACK_BOT_TOKEN RPD_SLACK_CHANNEL; do
  [ -z "${!v:-}" ] && missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "REFUSING: the cron job would be created unable to keep its receipts. Missing:$missing"
  echo "Set them in this shell (they are copied onto the service, never printed) and re-run."
  exit 1
fi

envvar() { printf '{"key":"%s","value":"%s"},' "$1" "$2"; }
ENVVARS="$(
  { envvar ATLAS_API_KEY "$ATLAS_API_KEY"
    envvar CLOUDINARY_API_KEY "$CLOUDINARY_API_KEY"
    envvar CLOUDINARY_API_SECRET "$CLOUDINARY_API_SECRET"
    envvar SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN"
    envvar RPD_SLACK_CHANNEL "$RPD_SLACK_CHANNEL"
    envvar RPD_MAX_USD "${RPD_MAX_USD:-2}"
    [ -n "${NETLIFY_AUTH_TOKEN:-}" ] && envvar NETLIFY_AUTH_TOKEN "$NETLIFY_AUTH_TOKEN"
    [ -n "${RPD_NETLIFY_TEAM:-}" ]   && envvar RPD_NETLIFY_TEAM "$RPD_NETLIFY_TEAM"
    [ -n "${MONGODB_URI:-}" ]        && envvar MONGODB_URI "$MONGODB_URI"
  } | sed 's/,$//'
)"

PAYLOAD=$(cat <<JSON
{
  "type": "cron_job",
  "name": "rpd-nightly",
  "ownerId": "$OWNER",
  "repo": "$REPO",
  "branch": "$BRANCH",
  "autoDeploy": "yes",
  "serviceDetails": {
    "runtime": "node",
    "region": "oregon",
    "plan": "starter",
    "schedule": "$SCHEDULE",
    "envSpecificDetails": {
      "buildCommand": "npm install",
      "startCommand": "./scripts/rpd/loop/render-nightly.sh"
    }
  },
  "envVars": [ $ENVVARS ]
}
JSON
)

if [ "$DRY" -eq 1 ]; then
  echo "DRY RUN — would POST this (secret VALUES redacted):"
  echo "$PAYLOAD" | sed -E 's/("value":")[^"]*/\1<redacted>/g'
  exit 0
fi

echo "creating cron job rpd-nightly (branch $BRANCH, schedule '$SCHEDULE')…"
RESP="$(curl -s -X POST "https://api.render.com/v1/services" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$PAYLOAD")"
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('service') or d
if s.get('id'):
    print('created:', s.get('id'), s.get('name'))
    print('dashboard: https://dashboard.render.com/cron/%s' % s['id'])
else:
    print('FAILED:', json.dumps(d)[:400])
    raise SystemExit(1)
"
