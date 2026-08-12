#!/usr/bin/env node
/**
 * verifyMixedPlatformVideo — pins the per-platform video master partition.
 *
 * WHY THIS EXISTS. The wizard offers "All video" per platform and the two are
 * designed to be combinable, so ticking both is the advertised flow. Before
 * this harness, `resolveDeterministicVideoMasterFormats` collapsed any run
 * containing a Google master down to Google masters ONLY:
 *
 *     const googleMasters = list.filter(f => GOOGLE_VIDEO_MASTER_SET.has(f));
 *     if (googleMasters.length) return googleMasters;   // Meta master gone
 *
 * A mixed run therefore billed two Omni submits, produced ZERO Meta video,
 * and the wizard's spend line quoted three — the operator paid for what they
 * asked for minus the ad they asked for, with nothing saying so. The whole
 * 103-script suite passed both before and after fixing it, which is exactly
 * why this file exists: nothing pinned the mixed case, so the regression was
 * invisible to the gate.
 *
 * The money invariants, all of which must hold simultaneously:
 *   1. A mixed run keeps EVERY platform's master — no cross-platform collapse.
 *   2. The derive-only surface (pmax_video_1_1) is NEVER a billable master,
 *      by any path including the fallbackFormat argument. It is a free crop;
 *      queueing it as a master is a ~$0.90/product double charge.
 *   3. The free 1:1 derives exactly when its SOURCE master (pmax_video_9_16)
 *      is in the run — including when Meta masters ride along, and never when
 *      only 16:9 was selected.
 *   4. Non-master Google video surfaces never become billable masters.
 *
 * REVERT-PROVEN against four mutations of
 * services/campaignAdsGenerationService.js:
 *   1. restore the cross-platform collapse   → A1, A3, A4 fail
 *   2. restore `.every(isGoogleMaster)` on the free-crop gate → D2 fails
 *   3. drop ONLY the explicit derive-only strip → still passes, ON PURPOSE
 *   4. drop BOTH derive-only guards          → C2, C3, E1, E2 fail
 *
 * Mutation 3 passing is recorded rather than hidden: the derive-only strip
 * and the "no unknown pmax_/google_ key becomes a master" fallback are
 * deliberately overlapping guards, and pmax_video_1_1 is caught by either
 * one. So no single-guard mutation can fail the C checks — which means the C
 * checks pin the PAIR, not each guard. Anyone tightening this file should
 * know that removing one guard is silent here; removing both is not.
 */

const assert = require('assert');
const pf = require('../services/platformFormats');
const svc = require('../services/campaignAdsGenerationService');

const {
  resolveDeterministicVideoMasterFormats: resolveMasters,
  isGoogleVideoMasterRun
} = svc;

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

// The exact arrays the wizard POSTs for each button combination, run through
// the real resolver rather than hand-written — so this harness tracks the
// wizard's real contract instead of a snapshot of it.
const META_VIDEO_TICKS = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16'];
const PMAX_VIDEO_TICKS = ['pmax_video_9_16', 'pmax_video_16_9'];

function queuedMasters(videoFormats) {
  const resolved = pf.resolvePreset('explicit', null, { staticFormats: [], videoFormats });
  return resolveMasters(resolved.videoFormats, null);
}

// ── 1. No cross-platform collapse ────────────────────────────────────────
check('A1 mixed run keeps the Meta master', () => {
  const m = queuedMasters([...META_VIDEO_TICKS, ...PMAX_VIDEO_TICKS]);
  assert.ok(
    m.includes('meta_stories_9_16'),
    `Meta master dropped from a mixed run — got ${JSON.stringify(m)}`
  );
});

check('A2 mixed run keeps BOTH Google masters', () => {
  const m = queuedMasters([...META_VIDEO_TICKS, ...PMAX_VIDEO_TICKS]);
  assert.ok(m.includes('pmax_video_9_16'), `missing 9:16 master: ${JSON.stringify(m)}`);
  assert.ok(m.includes('pmax_video_16_9'), `missing 16:9 master: ${JSON.stringify(m)}`);
});

check('A3 mixed run bills exactly three masters — not two, not four', () => {
  const m = queuedMasters([...META_VIDEO_TICKS, ...PMAX_VIDEO_TICKS]);
  assert.strictEqual(m.length, 3, `expected 3 billable masters, got ${JSON.stringify(m)}`);
});

check('A4 one Meta tick + one Google master keeps both platforms', () => {
  const m = queuedMasters(['meta_feed_1_1', 'pmax_video_16_9']);
  assert.strictEqual(m.length, 2, `expected 2, got ${JSON.stringify(m)}`);
  // The Meta side is PRESERVED but PROMOTED to its master. meta_feed_1_1 is a
  // free crop of the 9:16 Stories plate, so it can never be the run's master —
  // resolveExplicitFormats substitutes the master, and the crop is then minted
  // for free by the expansion. The invariant this check exists to protect is
  // "the Meta side is not silently dropped on a mixed run", which still holds;
  // asserting the literal ticked key would now be asserting the bug.
  assert.ok(m.includes('meta_stories_9_16'), `Meta side dropped: ${JSON.stringify(m)}`);
  assert.ok(!m.includes('meta_feed_1_1'),
    `a derive-only surface must never queue as a billable master: ${JSON.stringify(m)}`);
  assert.ok(m.includes('pmax_video_16_9'), `Google master dropped: ${JSON.stringify(m)}`);
});

// ── 2. Single-platform runs are UNCHANGED ────────────────────────────────
// The fix must not alter the shapes that already worked; a "fix" that moves
// Meta-only or PMax-only spend is a regression wearing a fix's clothes.
check('B1 Meta-only still bills exactly one master', () => {
  const m = queuedMasters(META_VIDEO_TICKS);
  assert.deepStrictEqual(m, ['meta_stories_9_16'], `got ${JSON.stringify(m)}`);
});

check('B2 PMax-only still bills exactly the two masters', () => {
  const m = queuedMasters(PMAX_VIDEO_TICKS);
  assert.strictEqual(m.length, 2, `got ${JSON.stringify(m)}`);
  assert.ok(m.every(k => k.startsWith('pmax_video_')), `got ${JSON.stringify(m)}`);
});

check('B3 PMax 16:9 alone bills exactly one master', () => {
  const m = queuedMasters(['pmax_video_16_9']);
  assert.deepStrictEqual(m, ['pmax_video_16_9'], `got ${JSON.stringify(m)}`);
});

// ── 3. Derive-only can NEVER bill ────────────────────────────────────────
check('C1 derive-only alone resolves to zero billable masters', () => {
  const m = queuedMasters(['pmax_video_1_1']);
  assert.deepStrictEqual(m, [], `derive-only became billable: ${JSON.stringify(m)}`);
});

check('C2 derive-only is stripped even when passed directly', () => {
  const m = resolveMasters(['pmax_video_1_1', 'pmax_video_9_16'], null);
  assert.ok(!m.includes('pmax_video_1_1'), `derive-only survived: ${JSON.stringify(m)}`);
});

check('C3 derive-only cannot come back through the fallbackFormat argument', () => {
  // The documented trap: an empty list + a derive-only fallback would put the
  // free crop straight back as a paid submit.
  const m = resolveMasters([], 'pmax_video_1_1');
  assert.deepStrictEqual(m, [], `fallback reinstated derive-only: ${JSON.stringify(m)}`);
});

// ── 4. The free crop derives exactly when its source is generated ────────
check('D1 free 1:1 derives on a PMax-only run', () => {
  assert.strictEqual(isGoogleVideoMasterRun(queuedMasters(PMAX_VIDEO_TICKS)), true);
});

check('D2 free 1:1 STILL derives when a Meta master rides along', () => {
  const m = queuedMasters([...META_VIDEO_TICKS, ...PMAX_VIDEO_TICKS]);
  assert.strictEqual(
    isGoogleVideoMasterRun(m), true,
    'a Meta master in the run suppressed the free PMax square'
  );
});

check('D3 free 1:1 does NOT derive from 16:9 alone', () => {
  assert.strictEqual(
    isGoogleVideoMasterRun(queuedMasters(['pmax_video_16_9'])), false,
    'claimed a free square with no 9:16 master to crop it from'
  );
});

check('D4 free 1:1 does NOT derive on a Meta-only run', () => {
  assert.strictEqual(isGoogleVideoMasterRun(queuedMasters(META_VIDEO_TICKS)), false);
});

check('D5 free 1:1 does not derive from an empty run', () => {
  assert.strictEqual(isGoogleVideoMasterRun([]), false);
  assert.strictEqual(isGoogleVideoMasterRun(null), false);
});

// ── 5. Non-master Google surfaces never become masters ───────────────────
check('E1 a non-master Google video key is not queued as billable', () => {
  // google_shorts_9_16 is coming_soon today; passed directly it must still be
  // refused, so that flipping it live cannot silently mint a third submit.
  const m = resolveMasters(['pmax_video_9_16', 'google_shorts_9_16'], null);
  assert.ok(
    !m.includes('google_shorts_9_16'),
    `non-master Google surface became billable: ${JSON.stringify(m)}`
  );
});

check('E2 the frozen dual-kind pmax_16_9 is not queued as a video master', () => {
  const m = resolveMasters(['pmax_16_9'], null);
  assert.deepStrictEqual(m, [], `frozen key became a billable master: ${JSON.stringify(m)}`);
});

check('E3 a non-Google key passes through untouched', () => {
  const m = resolveMasters(['meta_stories_9_16'], null);
  assert.deepStrictEqual(m, ['meta_stories_9_16'], `got ${JSON.stringify(m)}`);
});

// ── 6. Every queued master is distinct — no unique-index collision ───────
check('F1 mixed-run masters are all distinct platformFormats', () => {
  const m = queuedMasters([...META_VIDEO_TICKS, ...PMAX_VIDEO_TICKS]);
  assert.strictEqual(new Set(m).size, m.length, `duplicate masters: ${JSON.stringify(m)}`);
});

// ── 7. PMax funnel variants stay scoped to PMax ──────────────────────────
// Widening isGoogleVideoMasterRun for mixed runs also opened the funnel-mint
// loop to whatever else was in masterFormats. A Meta funnel row is worse than
// wasteful: funnelStage is not part of a Meta identity digest, so the rows
// collapse onto the Meta master and are swallowed — but resolveDeriveFromMaster
// returns NULL for a Meta platformFormat even with a funnelStage set, so any
// that ever did insert would take the BILLABLE Omni path rather than the free
// retitle. These pin the two properties that keep that shut.
check('G1 funnel stage is identity for a Google master (variants can coexist)', () => {
  const base  = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'pmax_video_9_16', funnelStage: null
  });
  const aware = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'pmax_video_9_16', funnelStage: 'awareness'
  });
  assert.notStrictEqual(base, aware, 'Google funnel variants collide with their master');
});

check('G2 funnel stage is NOT identity for Meta — which is why Meta must never be minted', () => {
  const base  = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'meta_stories_9_16', funnelStage: null
  });
  const aware = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'meta_stories_9_16', funnelStage: 'awareness'
  });
  assert.strictEqual(
    base, aware,
    'Meta digest started honouring funnelStage — if that is intentional, the funnel '
    + 'loop scoping and resolveDeriveFromMaster fail-closed behaviour must be revisited together'
  );
});

check('G3 a Meta funnel row would take the BILLABLE path — the reason for the scope filter', () => {
  const derive = svc.resolveDeriveFromMaster({
    platformFormat: 'meta_stories_9_16', funnelStage: 'awareness', renderRoute: 'veo'
  });
  assert.strictEqual(
    derive, null,
    'Meta+funnelStage now resolves a master; if so the billable-path risk is gone and '
    + 'this check should be re-derived rather than deleted'
  );
});

// ── 7b. META free derivatives ────────────────────────────────────────────
// The Meta pipeline is ONE billable 9:16 submit plus free crops of it. The
// crops were specified from the start and only became buildable when PMax's
// derive path landed. The money invariant is that they carry deriveFromMaster
// — without it, three free crops become three ~$0.90 charges per product.

check('I1 Meta derivatives never appear as billable masters', () => {
  const m = queuedMasters(META_VIDEO_TICKS);
  for (const d of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16']) {
    // The only Meta key that may bill is whichever single master survives the
    // clamp; a derivative must never be queued as a second paid submit.
    if (m.includes(d)) {
      assert.strictEqual(
        m.length, 1,
        `${d} queued alongside another master — that is a second billable submit`
      );
    }
  }
  assert.strictEqual(m.length, 1, `Meta must bill exactly one master, got ${JSON.stringify(m)}`);
});

check('I2 every Meta derivative is a shape a 9:16 frame can actually yield', () => {
  const src = pf.aspectRatioForPlatformFormat('meta_stories_9_16');
  assert.strictEqual(src, '9:16');
  // A derivative must be no WIDER than its source; cropping up is dishonest.
  const srcRatio = 9 / 16;
  for (const d of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16']) {
    const a = pf.aspectRatioForPlatformFormat(d);
    const [w, h] = a.split(':').map(Number);
    assert.ok(
      (w / h) >= srcRatio - 1e-9,
      `${d} (${a}) is narrower than its 9:16 source — not derivable`
    );
    assert.ok(
      (w / h) <= 1 + 1e-9,
      `${d} (${a}) is wider than square; a portrait master cannot yield it`
    );
  }
});

check('I3 each Meta derivative digests distinctly from the master — no index collapse', () => {
  const base = { campaignId: 'c1', productId: 'p1', mediaId: 'm1' };
  const master = svc.computeDeterministicVideoDigest({ ...base, platformFormat: 'meta_stories_9_16' });
  const seen = new Set([master]);
  for (const d of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16']) {
    const dig = svc.computeDeterministicVideoDigest({ ...base, platformFormat: d });
    assert.ok(!seen.has(dig), `${d} collides with an earlier Meta video digest — it would not insert`);
    seen.add(dig);
  }
});

check('I4 a Meta derivative routes FREE when it carries deriveFromMaster', () => {
  const derive = svc.resolveDeriveFromMaster({
    platformFormat: 'meta_feed_1_1',
    deriveFromMaster: 'meta_stories_9_16',
    renderRoute: 'veo'
  });
  assert.strictEqual(
    derive, 'meta_stories_9_16',
    'a Meta derivative did not resolve a master — it would take the BILLABLE Omni path'
  );
});

check('I5 a Meta derivative WITHOUT the marker is billable — why the field is load-bearing', () => {
  const derive = svc.resolveDeriveFromMaster({ platformFormat: 'meta_feed_1_1', renderRoute: 'veo' });
  assert.strictEqual(
    derive, null,
    'bare Meta feed formats now self-derive; if intentional, the fan-out no longer needs '
    + 'deriveFromMaster and this check should be re-derived rather than deleted'
  );
});

// ── 8. SOURCE PINS for the funnel-mint scoping ───────────────────────────
// The funnel loop lives inside expandWizardJob's async expansion path, which
// this offline harness cannot execute (it mints Ads against Mongo). Verified
// by mutation: unscoping the loop leaves every behavioural check above green.
// So the scoping is pinned at the source level instead — the same technique
// verifyBrandFieldNames uses for its `.select()` trap. A source pin is weaker
// than an execution check and is used here only because the alternative is no
// coverage at all for a latent billable path.
const SRC = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'),
  'utf8'
);

check('H1 funnel mint iterates a Google-filtered master list, not masterFormats', () => {
  assert.ok(
    /const\s+funnelMasters\s*=\s*masterFormats\.filter\(\s*\(f\)\s*=>\s*GOOGLE_VIDEO_MASTER_SET\.has\(f\)\s*\)/.test(SRC),
    'funnelMasters filter is gone — the funnel loop can mint Meta funnel rows on a mixed run, '
    + 'and resolveDeriveFromMaster returns null for those, which is the billable Omni path'
  );
  assert.ok(
    /for\s*\(const\s+fmt\s+of\s+funnelMasters\)/.test(SRC),
    'the funnel loop no longer iterates funnelMasters'
  );
  assert.ok(
    !/if\s*\(isPmaxFunnelVariantsEnabled\(\)\)\s*\{\s*for\s*\(const\s+fmt\s+of\s+masterFormats\)/.test(SRC),
    'the funnel loop iterates masterFormats directly again'
  );
});

check('H3 [MONEY] every Meta derivative is minted WITH deriveFromMaster', () => {
  // The single most expensive line in this change. The Meta derivatives are
  // free ONLY because they carry deriveFromMaster, which routes them through
  // renderDeriveOnlyVideoAd; without it resolveDeriveFromMaster returns null
  // (pinned by I5) and all three take the billable Omni path — three extra
  // ~$0.90 submits per product, on the default "All Meta video" flow.
  //
  // Verified by mutation that the behavioural checks above CANNOT see this:
  // the mint is inside expandWizardJob's async expansion, so deleting the
  // field leaves 29/29 green. Hence a source pin.
  assert.ok(
    /const\s+metaDeriveSource\s*=\s*masterFormats\.find\(\s*\(f\)\s*=>\s*f\s*===\s*META_VIDEO_DERIVE_SOURCE\s*\)/.test(SRC),
    'the Meta derive source lookup is gone'
  );
  assert.ok(
    /for\s*\(const\s+fmt\s+of\s+META_VIDEO_DERIVATIVES\)/.test(SRC),
    'the Meta derivative loop is gone'
  );
  assert.ok(
    /deriveFromMaster:\s*metaDeriveSource/.test(SRC),
    'MONEY: Meta derivatives are minted without deriveFromMaster — each one is now a '
    + 'billable Omni submit instead of a free crop'
  );
});

check('H4 Meta derivatives are gated on the 9:16 master being in the run', () => {
  // Deriving 1:1/4:5 from a non-portrait master would be cropping up. The
  // gate is the `.find(f => f === META_VIDEO_DERIVE_SOURCE)` above plus the
  // truthiness check on it; assert the constant still names the 9:16 master.
  assert.strictEqual(
    pf.aspectRatioForPlatformFormat('meta_stories_9_16'), '9:16',
    'META_VIDEO_DERIVE_SOURCE no longer names a 9:16 surface'
  );
  assert.ok(
    /if\s*\(metaDeriveSource\)\s*\{/.test(SRC),
    'the Meta derivative mint is no longer gated on the 9:16 master being present'
  );
});

check('H2 dry-run funnel count is scoped to Google masters too', () => {
  assert.ok(
    /const\s+dryFunnelMasters\s*=\s*dryMasterFormats\.filter\(\s*\(f\)\s*=>\s*GOOGLE_VIDEO_MASTER_SET\.has\(f\)\s*\)/.test(SRC),
    'dry-run funnel count is not Google-scoped — it will over-quote delivered ads on a mixed run'
  );
  assert.ok(
    !/PMAX_FUNNEL_STAGES\.length\s*\*\s*\(dryMasterFormats\.length\s*\+\s*1\)/.test(SRC),
    'dry-run still multiplies funnel stages by the unscoped master count'
  );
});

if (failures.length) {
  console.error(`\n❌ verifyMixedPlatformVideo: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ verifyMixedPlatformVideo: ${pass}/${pass} checks passed`);
