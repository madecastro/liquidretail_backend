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
require('dotenv').config();                                    // .env
require('dotenv').config({ path: 'config/defaults.env' });     // committed defaults
const crypto = require('crypto');

const ROLE = String(process.env.ADGEN_ROLE || '').toLowerCase();
if (!['api', 'orchestrator', 'renderer'].includes(ROLE)) {
  console.error(`❌ ADGEN_ROLE must be one of: api, orchestrator, renderer (got "${ROLE}")`);
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI required');
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
  isAdgenRendererEnabled
});
