# liquidretail_adgen

Ad-generation microservice, extracted from `liquidretail_backend` per the 2026-08-21 architecture plan. Owns end-to-end ad generation: expand → Director/Judge → Atlas submit → Remotion titling → upload → vision QC. Backend keeps the `/api/ads/generate` HTTP endpoint (validate + fingerprint gate + mint CampaignRun); this service picks it up from there.

**Status: Phase 0** — scaffold only. Boots on Render staging; does not process production traffic yet.

## Services

Three roles selected by `ADGEN_ROLE` env, one Docker image:

- **`api`** — Express HTTP. Health + inspect endpoints. Sync-only, no long work.
- **`orchestrator`** — singleton worker (distributed lease). Polls `CampaignRun.status='preparing'`, expands + claims, publishes work to the Ad queue.
- **`renderer`** — horizontally-scaled worker (N=2..16 autoscale). Claims individual Ad rows from `status='rendering' AND claimedByWorker=null`, does the actual generation work.

## Money invariants (Phase 1+, not yet ported)

Every invariant from `../liquidretail/server/CLAUDE.md` §2 that moves into this service is revert-proven by a `verify*.js` harness in the same commit that moves the code. Non-negotiable.

## Cutover

Backend gates on `ADGEN_SERVICE_ENABLED`:
- `false` (default) → backend runs the current in-process render loop.
- `true` → backend mints `CampaignRun.status='preparing'` and returns. Adgen picks up.

Flag flips per-phase during migration (`ADGEN_RENDERER_ENABLED` before Phase 1, `ADGEN_ORCHESTRATOR_ENABLED` before Phase 2, unified `ADGEN_SERVICE_ENABLED` after Phase 3 cleanup).

## Local dev

```
cp .env.example .env
# fill in MONGODB_URI (point at staging, NEVER prod)
npm install
ADGEN_ROLE=api npm start           # health check at :3100/health
ADGEN_ROLE=orchestrator npm start  # polls, logs, no-op
ADGEN_ROLE=renderer npm start      # polls, logs, no-op
```
