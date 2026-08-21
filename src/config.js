'use strict';
// Central env loading. dotenv is imported here so every module that
// require()s config gets a consistent view. Everything else in src/*
// reads from this object, never process.env directly — one place to
// audit for env access.

require('dotenv').config();
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

module.exports = Object.freeze({
  ROLE,
  MONGODB_URI,
  PORT:          Number(process.env.PORT || 3100),
  POLL_MS:       Number(process.env.ADGEN_POLL_MS || 500),
  WORKER_ID,
  LOG_LEVEL:     process.env.ADGEN_LOG_LEVEL || 'info',
  SLACK_BOT_TOKEN:     process.env.SLACK_BOT_TOKEN || null,
  SLACK_ALERT_CHANNEL: process.env.SLACK_ALERT_CHANNEL || null
});
