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

// Phase 1a knob — how long the mock renderer pretends work takes.
// Phase 1b replaces this with the real render implementation.
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
  isAdgenRendererEnabled
});
