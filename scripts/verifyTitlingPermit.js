#!/usr/bin/env node
'use strict';
/**
 * Verify the veo lane's submit/titling split.
 * No DB, no network, no API key.
 *
 * WHAT THIS PROTECTS (2026-08-05). The `veo` render lane gated ONE number over TWO
 * workloads with opposite constraints: an Omni submit + ~2min poll (remote, idle,
 * happily parallel — measured p50 117s / p99 247s) and then Remotion renderMedia
 * (headless Chrome + ffmpeg 1080p, IN-PROCESS, CPU/RAM-bound). VEO_CONCURRENCY was
 * therefore pinned to what the expensive half could survive.
 *
 * The dangerous part is that it was DOCUMENTED against the wrong constraint:
 * services/concurrency.js framed it as Omni RPS ("unpublished/unmeasured", "No Omni
 * 429 was ever recorded"), so the obvious reading was "provider-limited, probably
 * safe to raise". It is not. Raising the combined number fails as CPU/RAM exhaustion
 * -> Render autoscale (60% CPU+mem) -> process replacement -> a stranded PAID Omni
 * master (~$1.00 each) — the exact leak bootRecoveryService exists to clean up.
 *
 * So the invariants here are: titling has its OWN permit, that permit is
 * process-wide, and it cannot leak.
 *
 * Run: node scripts/verifyTitlingPermit.js
 */

const fs = require('fs');
const path = require('path');
const { Semaphore } = require('../services/semaphore');
const { concurrency: CONC, SPEC } = require('../services/concurrency');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');

console.log('\nVEO SUBMIT/TITLING SPLIT\n');

// ── A. Semaphore correctness (behavioral — it is the whole guard) ─────────
(async () => {
  {
    const s = new Semaphore(2, 't');
    let cur = 0, peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => s.withPermit(async () => {
      cur++; peak = Math.max(peak, cur);
      await new Promise(r => setTimeout(r, 5));
      cur--;
    })));
    check('A1 never exceeds its permit count under contention', peak === 2, `peak=${peak}`);
    check('A2 all permits are returned when the work drains', s.available === 2 && s.waiting === 0);
  }
  {
    // THE LEAK THAT WOULD WEDGE TITLING FOREVER: a titling render CAN throw
    // (routes/ads.js catches scriptErr and records "master rendered; titling
    // failed"). If the permit were released outside a finally, each failure would
    // shrink the pool by one until nothing could ever title again.
    const s = new Semaphore(1, 't');
    await s.withPermit(async () => { throw new Error('titling failed'); }).catch(() => {});
    check('A3 [LEAK] a THROWING job still returns its permit', s.available === 1);
    // MUST be timeout-guarded. With the permit leaked, this await never settles —
    // and an unsettled promise with an empty event loop makes node exit SILENTLY
    // with status 0, so the harness "passed" while the pool was wedged forever.
    // Verified: that is exactly what happened when release was moved out of the
    // finally. A deadlock has to fail loudly, not vanish.
    let ran = false;
    const wedged = Symbol('wedged');
    const result = await Promise.race([
      s.withPermit(async () => { ran = true; }).then(() => 'ok'),
      new Promise((r) => setTimeout(() => r(wedged), 500))
    ]);
    check('A4 the pool still works after a throw (deadlock fails, does not hang)',
      ran === true && result === 'ok',
      result === wedged ? 'DEADLOCK — permit was leaked by the throwing job' : '');
  }
  {
    const s = new Semaphore(1, 't');
    s.release(); s.release();
    check('A5 a double-release cannot inflate the pool above its cap (that would '
        + 'silently raise the concurrency this exists to hold down)', s.available === 1);
  }
  {
    let threw = false;
    try { new Semaphore(0, 'bad'); } catch { threw = true; }
    check('A6 refuses a zero/invalid permit count rather than deadlocking', threw);
  }
  {
    // FIFO: a permit is handed straight to the next waiter, so a caller acquiring in
    // a loop cannot starve the queue.
    const s = new Semaphore(1, 't');
    const order = [];
    await s.acquire();
    const a = s.withPermit(async () => { order.push('a'); });
    const b = s.withPermit(async () => { order.push('b'); });
    s.release();
    await Promise.all([a, b]);
    check('A7 waiters are served FIFO', order.join(',') === 'a,b', order.join(','));
  }

  // ── B. The knobs ────────────────────────────────────────────────────────
  check('B1 VEO_TITLING_CONCURRENCY exists as its own knob', !!SPEC.VEO_TITLING_CONCURRENCY);
  check('B2 [SAFETY] titling default is still 4 — identical to the old combined '
      + 'VEO_CONCURRENCY, so the split cannot raise local memory pressure on its first outing',
    SPEC.VEO_TITLING_CONCURRENCY.default === 4 && CONC.VEO_TITLING_CONCURRENCY === 4);
  check('B3 the lane (submit+poll) is now wider than titling — otherwise the split '
      + 'bought nothing', CONC.VEO_CONCURRENCY > CONC.VEO_TITLING_CONCURRENCY);
  check('B4 the lane stays within MAX_CREATIVES_PER_RUN — going non-binding is a '
      + 'separate, measured decision', CONC.VEO_CONCURRENCY <= CONC.MAX_CREATIVES_PER_RUN);
  check('B5 the titling knob documents the REAL failure mode (memory/process death), '
      + 'not a provider 429 — the mis-documentation is what made the old number look safe to raise',
    /CPU\/RAM|memory/i.test(SPEC.VEO_TITLING_CONCURRENCY.why)
    && /NOT a provider 429|not a provider 429/i.test(SPEC.VEO_TITLING_CONCURRENCY.why));

  // ── B6/B7 — THE SHADOWING TRAP, and it bit this very change ──────────────
  // config/defaults.env is dotenv-loaded into process.env at boot, and
  // resolveKnob reads process.env FIRST, so a value in that file SHADOWS the SPEC
  // default. Raising the SPEC default alone is a silent no-op: this change shipped
  // with SPEC=12 while defaults.env still said 4, and the deployed boot log read
  // `VEO_CONCURRENCY=4` — the lane never widened. Same class as the
  // DIRECTOR_SIGNALS_VERSION cache trap: looks right, does nothing.
  const envFile = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
  const envNum = (k) => {
    const m = envFile.match(new RegExp(`^${k}=(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  check('B6 [TRAP] config/defaults.env declares BOTH knobs — otherwise the SPEC '
      + 'default is unreachable in prod for one of them, and the operator cannot '
      + 'retune it without a deploy',
    envNum('VEO_CONCURRENCY') !== null && envNum('VEO_TITLING_CONCURRENCY') !== null,
    `defaults.env VEO_CONCURRENCY=${envNum('VEO_CONCURRENCY')} VEO_TITLING_CONCURRENCY=${envNum('VEO_TITLING_CONCURRENCY')}`);
  check('B7 [TRAP] defaults.env agrees with the SPEC defaults — a SPEC-only change '
      + 'is silently shadowed by this file and never reaches production',
    envNum('VEO_CONCURRENCY') === SPEC.VEO_CONCURRENCY.default
    && envNum('VEO_TITLING_CONCURRENCY') === SPEC.VEO_TITLING_CONCURRENCY.default,
    `file=${envNum('VEO_CONCURRENCY')}/${envNum('VEO_TITLING_CONCURRENCY')} spec=${SPEC.VEO_CONCURRENCY.default}/${SPEC.VEO_TITLING_CONCURRENCY.default}`);
  check('B8 the split still holds in the FILE values, which are what actually run',
    envNum('VEO_CONCURRENCY') > envNum('VEO_TITLING_CONCURRENCY'));

  // ── C. Wiring in the veo lane ───────────────────────────────────────────
  check('C1 routes/ads.js builds a titling semaphore from the knob',
    /new Semaphore\(\s*CONC\.VEO_TITLING_CONCURRENCY/.test(adsSrc));
  check('C2 [SCOPE] the semaphore is MODULE-level, not created per run — a per-run '
      + 'pool would let two concurrent runs each open VEO_TITLING_CONCURRENCY renders',
    (() => {
      const i = adsSrc.indexOf('new Semaphore(');
      if (i === -1) return false;
      // Must appear before the first function/route definition that could scope it.
      const beforeRoutes = adsSrc.slice(0, i);
      return !/^\s*(async\s+)?function\s+renderOne/m.test(beforeRoutes)
        && !/router\.(get|post|patch|delete)\(/.test(beforeRoutes);
    })());
  check('C3 titling goes through withPermit (release-in-finally), not a bare acquire',
    /veoTitlingSemaphore\.withPermit\(/.test(adsSrc)
    && !/veoTitlingSemaphore\.acquire\(/.test(adsSrc));
  // Extract the withPermit CLOSURE by brace-matching, not a char window. A fixed
  // window overruns the closure and keeps matching code that has been moved OUT of
  // the permit — verified: relocating renderBrandScriptAndSave to just after the
  // block left the old window-based check green, i.e. it could not fail on the one
  // regression it exists to catch.
  const permitBody = (() => {
    const call = adsSrc.indexOf('veoTitlingSemaphore.withPermit(');
    if (call === -1) return null;
    const open = adsSrc.indexOf('{', call);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < adsSrc.length; i++) {
      const ch = adsSrc[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return adsSrc.slice(open, i + 1);
      }
    }
    return null;
  })();

  check('C4 [THE POINT] renderBrandScriptAndSave is INSIDE the permit closure',
    !!permitBody && /renderBrandScriptAndSave\(/.test(permitBody));
  check('C5 [THE POINT] the Omni submit/poll is OUTSIDE the permit — gating it too '
      + 'would rebuild the single-knob bottleneck this removes',
    (() => {
      const call = adsSrc.indexOf('veoTitlingSemaphore.withPermit(');
      if (call === -1 || !permitBody) return false;
      const before = adsSrc.slice(0, call);
      return /veoGenerateForAd\(|generateForAd\(/.test(before)
        && !/veoGenerateForAd\(|generateForAd\(/.test(permitBody);
    })());

  // ── Revert-proof (manual, per CLAUDE.md §5) ──────────────────────────────
  // 1. Move renderBrandScriptAndSave outside withPermit -> C4 fails.
  // 2. Swap withPermit for acquire()/release() -> C3 fails (and a throwing titling
  //    render would then leak a permit; A3 is the behavioral twin of that).
  // 3. Construct the Semaphore inside renderOne -> C2 fails.
  // 4. Set VEO_TITLING_CONCURRENCY default above 4 -> B2 fails.
  // 5. Release outside the finally in semaphore.js -> A3/A4 fail.
  // Each verified by hand before shipping this harness.

  if (failures.length) {
    console.error(`❌ verifyTitlingPermit: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyTitlingPermit: ${pass} checks passed`);
  console.log(`   lane(submit+poll)=${CONC.VEO_CONCURRENCY} titling=${CONC.VEO_TITLING_CONCURRENCY}`);
})();
