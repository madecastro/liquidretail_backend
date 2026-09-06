'use strict';
//
// SHARP CONCURRENCY — one-shot boot-time tuning for the libvips semaphore.
//
// WHY (2026-08-26, Phase 3). Every static ad's post-Atlas finishPlate does
// 3-5 sharp() operations. Sharp is native C via libvips and releases the JS
// event loop during native work, but submits WORK TO THE LIBUV THREADPOOL
// (default 4). At ADGEN_MAX_INFLIGHT=32, 28 Sharp ops queue behind 4
// threads. UV_THREADPOOL_SIZE=16 (env, must be set before process boot)
// widens that. This module adds the second half — Sharp's OWN semaphore
// (sharp.concurrency()) — for the cases where an operator wants to override
// Sharp's CPU-count autodetect.
//
// ── AT-BOOT, ONCE, IDEMPOTENT ─────────────────────────────────────────
// Sharp's concurrency setter is a module-global. Calling it multiple times
// is safe (idempotent), but doing it inside the render path would incur
// unnecessary overhead. This module is called ONCE from renderer.run()'s
// early init. If never called, Sharp's default (== CPU count) applies.
//
// ── NO-OP WHEN SHARP_CONCURRENCY IS UNSET ─────────────────────────────
// Absent/empty env means "trust Sharp's autodetect". Only an explicit
// numeric value overrides it. This keeps the surface area of this module
// small — no chance of a bad env value causing sharp to serialise every op.

const sharp = require('sharp');

function configureSharpConcurrency() {
  const raw = process.env.SHARP_CONCURRENCY;
  if (raw == null || String(raw).trim() === '') return { applied: false, reason: 'unset (Sharp autodetect)' };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return { applied: false, reason: `invalid: ${JSON.stringify(raw)}` };
  }
  const clamped = Math.min(64, Math.max(1, Math.round(n)));  // sanity: no >64
  sharp.concurrency(clamped);
  return { applied: true, value: clamped };
}

module.exports = {
  configureSharpConcurrency
};
