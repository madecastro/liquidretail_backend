'use strict';
//
// A counting semaphore, in-process.
//
// WHY (2026-08-05): the `veo` render lane gates ONE number over TWO workloads with
// opposite constraints. `routes/ads.js` dispatches VEO_CONCURRENCY ads at a time, and
// each ad both (a) submits to Omni and idles on a poll for ~2 minutes — cheap, remote,
// happily parallel — and then (b) runs Remotion `renderMedia`, a headless Chrome +
// ffmpeg 1080p encode IN THIS PROCESS, which is CPU- and memory-bound.
//
// So the one knob was pinned to whatever the EXPENSIVE half could survive, which
// throttled the cheap half for no reason. Worse, the documented reason for keeping it
// low pointed at the wrong thing: services/concurrency.js frames VEO_CONCURRENCY
// against Omni RPS ("unpublished/unmeasured", and "No Omni 429 was ever recorded"),
// when the real ceiling is local RAM/CPU. Raising it would have failed as an OOM →
// Render autoscale (60% CPU+mem) → process replacement → a stranded paid Omni master
// (~$1.00), not as a provider 429.
//
// This lets the lane run wide while a second, narrow permit protects Remotion.
//
// ── SCOPE, and why it is deliberately not more ─────────────────────────────
// IN-PROCESS ONLY, exactly like the limiters it sits beside (VEO_CONCURRENCY itself is
// per-process; `pacedModelSubmit`'s spacing map is per-process). With Render autoscale
// at min 1 / max 3 web instances, N instances each get their own permits. That is
// acceptable for a MEMORY guard — memory is per-instance, so a per-instance cap is
// the correct shape — but it would NOT be acceptable for a provider rate limit, which
// is global. Do not reuse this for one.
//
// No timeout and no queue cap: a permit is always released in a `finally`, and the
// callers are a bounded per-run dispatch (MAX_CREATIVES_PER_RUN=20), so the waiter
// list cannot grow without bound. Adding a timeout would mean *proceeding without a
// permit*, which defeats the guard at exactly the moment it matters.

class Semaphore {
  constructor(permits, name = 'semaphore') {
    const n = Number(permits);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`${name}: permits must be a positive number, got ${permits}`);
    }
    this.name = name;
    this.permits = Math.floor(n);
    this.available = Math.floor(n);
    this._waiters = [];
  }

  /** Current wait-queue depth — for logging/telemetry only. */
  get waiting() { return this._waiters.length; }

  acquire() {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  release() {
    const next = this._waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter rather than incrementing and
      // letting it re-race — otherwise a caller that acquires in a tight loop can
      // starve the queue.
      next();
      return;
    }
    // Guard against a double-release inflating the pool above its cap, which would
    // silently raise the concurrency this exists to hold down.
    if (this.available < this.permits) this.available++;
  }

  /**
   * Run fn while holding a permit. ALWAYS use this rather than acquire/release by
   * hand: the release is in a `finally`, so a throwing render cannot leak a permit
   * and shrink the pool to zero — which would wedge every later titling job.
   */
  async withPermit(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

module.exports = { Semaphore };
