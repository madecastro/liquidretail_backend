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
  // B2/B3/B5 RE-POINTED, not relaxed. Their intent — "the memory-bound knob is
  // small and honestly documented" — is unchanged; the knob it names moved.
  //
  // VEO_TITLING_CONCURRENCY never actually bounded Remotion renders.
  // remotionRenderService ran a concurrency-1 promise chain, so ONE render
  // happened regardless of this number and the other permit holders idled. That
  // is the measured 926s / 83%-idle titling tail. The permit is now wide (48,
  // owner-directed) and bounds only cheap prep; REMOTION_QUEUE_CONCURRENCY is
  // the real memory guard, so that is what these now protect.
  // 4 -> 8 on 2026-08-20, owner-approved, alongside VEO_CONCURRENCY 12->24 —
  // one doubling, not the 16 originally floated, precisely because 4 "is
  // the only concurrency this process has actually survived" and is not an
  // RSS measurement (see config/defaults.env / services/concurrency.js).
  // The pin stays a hard number, not a >= — this knob is deliberately the
  // one that must never drift silently.
  check('B2 [SAFETY] the MEMORY-BOUND render pool stays small — 8 is one '
      + 'doubling past 4, the only concurrency this process has actually survived (the old combined VEO_CONCURRENCY)',
    SPEC.REMOTION_QUEUE_CONCURRENCY
    && SPEC.REMOTION_QUEUE_CONCURRENCY.default === 8
    && CONC.REMOTION_QUEUE_CONCURRENCY === 8);
  check('B2b [SAFETY] the render pool can never be configured above the documented ceiling',
    SPEC.REMOTION_QUEUE_CONCURRENCY && SPEC.REMOTION_QUEUE_CONCURRENCY.max <= 16);
  check('B3 the memory-bound pool is the NARROWEST video knob — the cheap permit and '
      + 'the submit/poll lane may both run wider, the renderer may not',
    CONC.REMOTION_QUEUE_CONCURRENCY <= CONC.VEO_TITLING_CONCURRENCY
    && CONC.REMOTION_QUEUE_CONCURRENCY <= CONC.VEO_CONCURRENCY);
  check('B4 the lane stays within MAX_CREATIVES_PER_RUN — going non-binding is a '
      + 'separate, measured decision', CONC.VEO_CONCURRENCY <= CONC.MAX_CREATIVES_PER_RUN);
  check('B5 the RENDER POOL knob documents the REAL failure mode (memory/process death), '
      + 'not a provider 429 — the mis-documentation is what made the old number look safe to raise',
    /CPU\/RAM|RSS|memory/i.test(SPEC.REMOTION_QUEUE_CONCURRENCY.why)
    && /NOT a provider 429|not a provider 429/i.test(SPEC.REMOTION_QUEUE_CONCURRENCY.why));
  check('B5b the titling permit no longer CLAIMS to bound Remotion renders — that '
      + 'stale sentence is what hid a serial queue behind a number that read as 4-wide',
    !/^Simultaneous Remotion titling renders/.test(SPEC.VEO_TITLING_CONCURRENCY.why));

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
    && envNum('VEO_TITLING_CONCURRENCY') === SPEC.VEO_TITLING_CONCURRENCY.default
    // The new memory knob is the one it would hurt most to leave shadowed: a
    // SPEC bump that never reaches prod would read as "we raised throughput"
    // while the file still pins the pool.
    && envNum('REMOTION_QUEUE_CONCURRENCY') === SPEC.REMOTION_QUEUE_CONCURRENCY.default,
    `file=${envNum('VEO_CONCURRENCY')}/${envNum('VEO_TITLING_CONCURRENCY')} spec=${SPEC.VEO_CONCURRENCY.default}/${SPEC.VEO_TITLING_CONCURRENCY.default}`);
  check('B8 the render pool is the narrowest in the FILE values, which are what actually run',
    envNum('REMOTION_QUEUE_CONCURRENCY') <= envNum('VEO_TITLING_CONCURRENCY')
    && envNum('REMOTION_QUEUE_CONCURRENCY') <= envNum('VEO_CONCURRENCY'));

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
  // Extract EVERY withPermit CLOSURE by brace-matching, not a char window and
  // not only the first site. Phase A added renderDeriveOnlyVideoAd which also
  // titles under withPermit and appears EARLIER in the file than the Omni
  // path — indexOf(first) alone made C5 false-fail (and would miss a future
  // site that re-introduces a billable submit inside a permit).
  function extractAllPermitBodies(src) {
    const bodies = [];
    const needle = 'veoTitlingSemaphore.withPermit(';
    let from = 0;
    while (from < src.length) {
      const call = src.indexOf(needle, from);
      if (call === -1) break;
      const open = src.indexOf('{', call);
      if (open === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) break;
      bodies.push({ call, body: src.slice(open, end + 1) });
      from = end + 1;
    }
    return bodies;
  }
  const permitSites = extractAllPermitBodies(adsSrc);
  check('C4a at least one veoTitlingSemaphore.withPermit site exists',
    permitSites.length >= 1, `sites=${permitSites.length}`);
  check('C4 [THE POINT] EVERY permit site titles via renderBrandScriptAndSave',
    permitSites.length > 0 &&
    permitSites.every(({ body }) => /renderBrandScriptAndSave\(/.test(body)),
    `sites=${permitSites.length}; missing save in one or more permit bodies`);
  // True invariant across ALL permit sites (strictly stronger than the old
  // single-site check):
  //   (a) no permit body contains a billable Omni submit
  //   (b) at least one Omni submit exists OUTSIDE every permit body
  // Derive-only paths title under a permit with NO Omni call — that is fine;
  // the Omni path must still submit outside its permit.
  check('C5 [THE POINT] NO permit body contains veoGenerateForAd/generateForAd — '
      + 'gating the Omni submit would rebuild the single-knob bottleneck',
    permitSites.length > 0 &&
    permitSites.every(({ body }) => !/veoGenerateForAd\(|generateForAd\(/.test(body)));
  check('C5b [THE POINT] at least one veoGenerateForAd( call exists OUTSIDE every permit body',
    (() => {
      if (permitSites.length === 0) return false;
      // Build the source with every permit body zeroed so a call that only
      // lives inside a permit cannot satisfy the "outside" check.
      let outside = adsSrc;
      // Replace from the end so earlier indices stay valid.
      const ranges = permitSites
        .map(({ call, body }) => ({ start: call, end: call + ('veoTitlingSemaphore.withPermit(').length + body.length }))
        .sort((a, b) => b.start - a.start);
      // More precise: zero each extracted body span in the original source.
      const spans = permitSites
        .map(({ body }) => {
          const i = adsSrc.indexOf(body);
          return i === -1 ? null : { start: i, end: i + body.length };
        })
        .filter(Boolean)
        .sort((a, b) => b.start - a.start);
      for (const { start, end } of spans) {
        outside = outside.slice(0, start) + ' '.repeat(end - start) + outside.slice(end);
      }
      return /veoGenerateForAd\(/.test(outside);
    })());

  // ── Revert-proof (manual, per CLAUDE.md §5) ──────────────────────────────
  // 1. Move renderBrandScriptAndSave outside withPermit -> C4 fails.
  // 2. Swap withPermit for acquire()/release() -> C3 fails (and a throwing titling
  //    render would then leak a permit; A3 is the behavioral twin of that).
  // 3. Construct the Semaphore inside renderOne -> C2 fails.
  // 4. Change REMOTION_QUEUE_CONCURRENCY's default away from 8 -> B2 fails
  //    (pre-existing typo fixed 2026-08-20: this used to name
  //    VEO_TITLING_CONCURRENCY, the knob B2 stopped pinning when it was
  //    re-pointed to the real memory guard — see the B2 comment above).
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
