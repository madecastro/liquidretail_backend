// Distributed lease for singleton tasks across N worker instances.
//
// Problem: the WORKER service runs setInterval-driven housekeeping —
// scheduledSyncService.startScheduler, backlogWatchdog.runWatchdog —
// that must fire on exactly ONE instance at a time. Before this lease,
// each worker started its own copy, so scaling to N=2+ instances
// duplicated demo Apify syncs (paid credit) and Slack alerts (annoying).
//
// Shape: one Mongo doc per named lease. `holder` is the worker id;
// `expiresAt` is when the lease auto-releases if the holder crashes.
// Renewal happens on every heartbeat (safer than counting on graceful
// shutdown, which Render's SIGTERM does not always give).
//
// Usage:
//   const lease = createSingletonLease('scheduler', { ttlMs: 90_000, heartbeatMs: 30_000 });
//   const acquired = await lease.acquire();     // true if this instance holds it now
//   if (acquired) lease.startHeartbeat();       // renew every heartbeatMs
//   // ...run the singleton work...
//   await lease.release();                      // optional; expiresAt handles crash

'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

// Kept small on purpose — the collection holds one doc per named lease
// (a handful across the whole codebase). Indexed on _id (primary key).
const leaseSchema = new mongoose.Schema({
  _id:       { type: String, required: true },     // lease name
  holder:    { type: String, required: true },     // worker id
  expiresAt: { type: Date,   required: true, index: true }
}, { collection: 'singleton_leases' });

const SingletonLease = mongoose.models.SingletonLease
  || mongoose.model('SingletonLease', leaseSchema);

const INSTANCE_ID = process.env.RENDER_INSTANCE_ID
  || `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function createSingletonLease(name, { ttlMs = 90_000, heartbeatMs = 30_000 } = {}) {
  let heartbeatTimer = null;
  let currentlyHolds = false;

  async function acquire() {
    const now  = new Date();
    const till = new Date(now.getTime() + ttlMs);
    try {
      // Take-if-expired-or-mine. Two workers racing at expiry: whichever
      // hits Mongo first wins; the other's update has 0 matches and
      // returns null.
      const res = await SingletonLease.findOneAndUpdate(
        {
          _id: name,
          $or: [
            { expiresAt: { $lt: now } },
            { holder: INSTANCE_ID }
          ]
        },
        { holder: INSTANCE_ID, expiresAt: till },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      currentlyHolds = res?.holder === INSTANCE_ID;
      return currentlyHolds;
    } catch (err) {
      // 11000 on upsert race — someone else won the create. That's fine.
      if (err?.code === 11000) return false;
      console.warn(`⚠️  singletonLease[${name}] acquire failed: ${err.message}`);
      return false;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      const till = new Date(Date.now() + ttlMs);
      try {
        const res = await SingletonLease.findOneAndUpdate(
          { _id: name, holder: INSTANCE_ID },
          { expiresAt: till },
          { new: true }
        );
        if (!res) {
          // Lost the lease (another worker took it — probably we stalled).
          currentlyHolds = false;
          console.warn(`⚠️  singletonLease[${name}] heartbeat lost — no longer holder`);
        }
      } catch (err) {
        console.warn(`⚠️  singletonLease[${name}] heartbeat failed: ${err.message}`);
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  async function release() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (!currentlyHolds) return;
    try {
      await SingletonLease.updateOne(
        { _id: name, holder: INSTANCE_ID },
        { expiresAt: new Date(0) }
      );
    } catch (_) { /* best-effort */ }
    currentlyHolds = false;
  }

  function holds() { return currentlyHolds; }

  return { acquire, startHeartbeat, release, holds, INSTANCE_ID };
}

module.exports = { createSingletonLease, INSTANCE_ID };
