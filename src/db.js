'use strict';
// Mongo connection. Shared cluster with backend — bounded by service
// role, not by schema. Every model we define here targets the same
// collection backend writes to; strict:false on the schemas lets us
// read the full doc without needing to duplicate every field.
//
// Stale-topology self-heal: Atlas free-tier clusters run frequent
// maintenance events that advance the replica-set's electionId /
// setVersion. The Node driver's SDAM sometimes wedges on a specific
// mismatch shape ("primary marked stale due to electionId/setVersion
// mismatch") — every operation fails, and the driver's own heartbeats
// don't re-discover a fresh primary. Observed on 2026-08-21: a worker
// stayed wedged for 67 minutes on the same numbers with no recovery.
//
// The fix: detect that specific error via isStaleTopologyError() and
// force a full mongoose disconnect+reconnect. Fresh SDAM = current
// topology. Bounded by MAX_RECONNECT_ATTEMPTS so a real cluster outage
// doesn't spin forever.

const mongoose = require('mongoose');
const { MONGODB_URI } = require('./config');

const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;
let reconnecting = false;

const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,     // shorter than default 30s — fail fast, retry through mongoose
  heartbeatFrequencyMS:     10000,    // driver default; explicit for auditability
  retryReads:               true,     // default true, explicit; retryable-reads on driver errors
  retryWrites:              true,
  maxPoolSize:              20,       // per-instance connection pool
  minPoolSize:              1
};

async function connect() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(MONGODB_URI, CONNECT_OPTIONS);
  console.log(`✓ mongo connected: ${mongoose.connection.db.databaseName}`);
  return mongoose.connection;
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

// Detect the specific stale-topology error class. Matching on message text
// because the driver does not surface a stable error CODE for this case —
// it's a MongoServerSelectionError with a nested reason. Kept narrow so
// legitimate transient errors don't trigger a reconnect storm.
function isStaleTopologyError(err) {
  if (!err) return false;
  const msg = String(err.message || err.reason?.message || '');
  return /primary marked stale due to electionId\/setVersion mismatch/i.test(msg);
}

// Force a fresh SDAM by tearing down and re-establishing the connection.
// Idempotent under concurrent callers via the `reconnecting` guard —
// multiple poll loops hitting the wedged state at once will only trigger
// one reconnect cycle.
async function reconnectAfterStaleTopology() {
  if (reconnecting) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ mongo: ${MAX_RECONNECT_ATTEMPTS} reconnect attempts exhausted — exiting for orchestrator restart`);
    process.exit(1);
  }
  reconnecting = true;
  reconnectAttempts++;
  console.warn(`⚠️  mongo: stale-topology detected (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}), reconnecting…`);
  try {
    await mongoose.disconnect();
    await mongoose.connect(MONGODB_URI, CONNECT_OPTIONS);
    console.log(`✓ mongo reconnected: ${mongoose.connection.db.databaseName}`);
    // Only reset the counter on a fresh SUCCESSFUL poll (see resetReconnectAttempts).
    // A successful reconnect doesn't prove SDAM is healthy — the very next query might
    // fail with the same error. The reset happens when work actually proceeds.
  } catch (err) {
    console.error(`❌ mongo reconnect failed: ${err.message}`);
  } finally {
    reconnecting = false;
  }
}

// Called by poll loops after a successful query — proves SDAM is healthy
// and the reconnect budget can reset.
function resetReconnectAttempts() {
  if (reconnectAttempts > 0) {
    console.log(`✓ mongo: healthy poll, reconnect budget reset (was ${reconnectAttempts})`);
    reconnectAttempts = 0;
  }
}

module.exports = {
  connect,
  disconnect,
  isStaleTopologyError,
  reconnectAfterStaleTopology,
  resetReconnectAttempts
};
