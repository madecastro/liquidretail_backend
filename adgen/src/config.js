'use strict';
// Central env loading. dotenv is imported here so every module that
// require()s config gets a consistent view. Everything else in src/*
// reads from this object, never process.env directly — one place to
// audit for env access.

// Two-tier env load, mirroring backend's index.js: process env wins (Render
// dashboard secrets), .env supplements for local dev, config/defaults.env
// provides non-secret defaults for every knob the copied services read.
// dotenv is called without `override:true` so process.env stays highest
// precedence (Render secrets shadow the file).
const path = require('path');
const crypto = require('crypto');
// Paths are anchored to this module, not process.cwd(). Docker WORKDIR /app
// + this file at /app/src/config.js resolve to the same absolute files as
// the previous cwd-relative loads (`/app/.env`, `/app/config/defaults.env`).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });                    // .env
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });  // committed defaults

const ROLE = String(process.env.ADGEN_ROLE || '').toLowerCase();
if (!['api', 'orchestrator', 'renderer', 'titler'].includes(ROLE)) {
  console.error(`❌ ADGEN_ROLE must be one of: api, orchestrator, renderer, titler (got "${ROLE}")`);
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI required');
  process.exit(1);
}

// Fail fast on a role that cannot do its job, instead of booting, claiming
// work, and failing the first render. Both renderer and titler upload the
// titled/derived asset to Cloudinary at the tail of every ad
// (cloudinaryService.js's module-level `cloudinary.config()` reads these
// once at require time) — a missing key here does not surface until that
// FIRST upload, on an already-paid master, exactly like the 2026-08-25
// "Must supply api_key" incident (7 titler ads, all with a preserved paid
// master, traced to a Cloudinary dashboard var not yet propagated to a
// freshly-launched titler instance — resolved operationally by the time it
// was investigated, but nothing at boot would have caught the NEXT one).
// CLOUDINARY_CLOUD_NAME ships a committed non-secret default
// (config/defaults.env) so it is included for completeness, not because
// it is expected to be the one that's actually missing in practice.
// ATLAS_API_KEY is deliberately NOT required for `titler` — the titler role
// must never call Atlas (see titlingResumeService's money invariant,
// scripts/verifyTitlingResumeNeverResubmits.js); requiring a key it must
// never use would be a lie about what this role does.
const REQUIRED_ENV_BY_ROLE = {
  renderer: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'ATLAS_API_KEY'],
  titler:   ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
};
const missingRoleEnv = (REQUIRED_ENV_BY_ROLE[ROLE] || []).filter((k) => !process.env[k]);
if (missingRoleEnv.length) {
  console.error(`❌ ADGEN_ROLE=${ROLE} is missing required env var(s): ${missingRoleEnv.join(', ')} — every upload/submit on this instance would fail. Refusing to boot rather than silently failing the first render.`);
  process.exit(1);
}

// Worker id — either operator-supplied for pinning, or auto for uniqueness.
// Renderer uses this as Ad.claimedByWorker so we can trace ownership.
const WORKER_ID = process.env.ADGEN_WORKER_ID
  || `${ROLE}-${crypto.randomBytes(4).toString('hex')}`;

// Handoff gate — same env name backend reads. When false, the renderer
// role sleeps (does not poll or claim) so it can be deployed without
// stealing work from backend's in-process render loop. Backend's
// runRenderLoop reads this same flag; both flip together.
function isAdgenRendererEnabled() {
  return String(process.env.ADGEN_RENDERER_ENABLED || '').toLowerCase() === 'true';
}

// Titler handoff gate — same shape as ADGEN_RENDERER_ENABLED. When false
// (default), the titler role sleeps and never polls. When true, it polls
// for { status:'rendering', veoVideoUrl:{$ne:null}, titlingNeeded:true,
// claimedByWorker:null } and does Remotion titling out-of-process from the
// renderer. Field `titlingNeeded` is stamped by the renderer's video path
// atomic with its claim-release, and only when the SAME env is true on the
// renderer side (single flag, two readers). The scaffold ships this gate
// off so the service can be deployed dark and prove it boots before we
// wire the handoff.
function isTitlerEnabled() {
  return String(process.env.ADGEN_TITLER_ENABLED || '').toLowerCase() === 'true';
}

// Per-instance in-process concurrency cap. The renderer's poll loop
// burst-claims up to this many ads and processes them concurrently as
// unawaited promises — one Node event loop, many I/O-bound waits in
// parallel. Static ad-gen is 99% I/O (Atlas gpt-image-2/edit poll ~45s
// + Cloudinary upload ~5s + Sharp composite ~5s), so cap can be high.
//
// Sizing to 2000 static/hr + 450 video/hr target (2026-08-22):
//   fleet needs ~28 concurrent statics + ~8 concurrent video masters
//   + ~10 concurrent Remotion renders (~76s each, RAM-bound at 4/inst
//   via remotionRenderService's own queue).
//   → per-instance MAX_INFLIGHT=32 with autoscale min:2 max:8
//   → peak fleet 256 slots, 32 concurrent Remotion (2.8x derive target)
//
// The BINDING constraint is Remotion RAM (1.5-2 GB per render × 4
// concurrent). Fits on Standard-Plus (8 GB); Standard (4 GB) OOMs.
// Cap on statics + video-polls at MAX_INFLIGHT is loose intentionally
// — they're I/O and cheap. Remotion self-limits.
//
// ⚠️ CORRECTED 2026-09-03 — the "×4 concurrent" above and the "32 concurrent
// Remotion fleet-wide" sizing math two paragraphs up assumed
// REMOTION_QUEUE_CONCURRENCY=4 per instance. The live default is **2**
// (`remotionRenderService.js` reads `REMOTION_QUEUE_CONCURRENCY || 2`), and
// that file's own boot warning plus `render.yaml`'s adgen-titler comments
// name 4 as the exact concurrency that OOM-killed adgen-titler three times
// in 44h (2026-08-26) — it was tried and reverted, not left in place. At the
// live value of 2, autoscale max:8 gives fleet Remotion capacity of **16**,
// not 32, and the "2.8x derive target" line above is stale by the same
// factor. This comment does not change MAX_INFLIGHT or any env default —
// see `render.yaml`'s adgen-titler section for the actual dashboard history.
const MAX_INFLIGHT = Number(process.env.ADGEN_MAX_INFLIGHT || 32);

// Phase 1a knob — how long the mock renderer pretends work takes.
// Kept for the shim path (unreachable in Phase 1b+); harmless to leave.
const MOCK_WORK_MS = Number(process.env.ADGEN_MOCK_WORK_MS || 5000);

module.exports = Object.freeze({
  ROLE,
  MONGODB_URI,
  PORT:          Number(process.env.PORT || 3100),
  POLL_MS:       Number(process.env.ADGEN_POLL_MS || 500),
  WORKER_ID,
  LOG_LEVEL:     process.env.ADGEN_LOG_LEVEL || 'info',
  SLACK_BOT_TOKEN:     process.env.SLACK_BOT_TOKEN || null,
  SLACK_ALERT_CHANNEL: process.env.SLACK_ALERT_CHANNEL || null,
  MOCK_WORK_MS,
  MAX_INFLIGHT,
  isAdgenRendererEnabled,
  isTitlerEnabled
});
