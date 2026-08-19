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

// ── 7. Funnel variants are platform-agnostic and MUST stay free ──────────
// Widening isGoogleVideoMasterRun for mixed runs also opened the funnel-mint
// loop to whatever else was in masterFormats. That used to be a money hole
// because (a) funnelStage was not part of a Meta identity digest, so the
// rows collapsed onto the master, and (b) resolveDeriveFromMaster returned
// null for a Meta+stage row, so any that DID insert would have billed Omni.
// Both properties flipped together: a set stage is now identity on every
// format, and Meta+stage fail-closes to the Stories plate.
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

check('G2 [MONEY] funnel stage IS identity for Meta (null-stage master unchanged)', () => {
  const base  = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'meta_stories_9_16', funnelStage: null
  });
  const omit = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'meta_stories_9_16'
  });
  const aware = svc.computeDeterministicVideoDigest({
    campaignId: 'c1', productId: 'p1', mediaId: 'm1',
    platformFormat: 'meta_stories_9_16', funnelStage: 'awareness'
  });
  assert.strictEqual(base, omit, 'funnelStage:null shifted a Meta master digest — next Generate re-bills Omni');
  assert.notStrictEqual(
    base, aware,
    'Meta digest still ignores a set funnelStage — intent variants collapse onto the master'
  );
});

check('G3 [MONEY] a Meta funnel row fail-closes to the Stories plate (never Omni)', () => {
  const derive = svc.resolveDeriveFromMaster({
    platformFormat: 'meta_stories_9_16', funnelStage: 'awareness', renderRoute: 'veo'
  });
  assert.strictEqual(
    derive, 'meta_stories_9_16',
    'Meta+funnelStage is still billable — a dropped deriveFromMaster would re-open Omni'
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

check('I5 a marker-less Meta derivative FAIL-CLOSES to its master (no receipt)', () => {
  // Re-derived 2026-08-11. This previously asserted the opposite — that a bare
  // Meta feed format stayed billable — which was true when the Meta fan-out
  // shipped and is why models/Ad.js claimed Meta "has no second gate, and
  // cannot". PR #173 found the discriminator that makes one possible:
  // `veoPredictionId` is the spend RECEIPT, set only when that ad itself
  // submitted to Omni. A derivation never submits, so its absence identifies a
  // derivative even with the marker gone.
  const derive = svc.resolveDeriveFromMaster({
    platformFormat: 'meta_feed_1_1', renderRoute: 'veo'
  });
  assert.strictEqual(
    derive, 'meta_stories_9_16',
    'a marker-less Meta derivative no longer fail-closes — it would take the BILLABLE Omni path'
  );
});

check('I6 a LEGACY paid Meta row keeps its billable path (receipt present)', () => {
  // The other half of the same discriminator, and the reason it is not simply
  // "this format ⇒ free": meta_feed_1_1 / 4_5 / reels WERE their own paid
  // masters before 919627a0, so rows exist that bought their own plate. If
  // those were treated as derivations, a regenerate would 409 on an ad that
  // paid, and a re-render would wait for a Stories sibling that never existed.
  const derive = svc.resolveDeriveFromMaster({
    platformFormat: 'meta_feed_1_1', renderRoute: 'veo', veoPredictionId: 'pred_legacy_123'
  });
  assert.strictEqual(
    derive, null,
    'a legacy Meta row that holds a spend receipt was reclassified as a derivation'
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

check('H1 mixed-run PMax funnel mint stays scoped to Google masters', () => {
  // Behavioural: a mixed plan must not stamp a PMax-style same-format
  // deriveFromMaster on the Meta master (that would be the old unscoped
  // loop). Meta variants derive from META_VIDEO_MASTER_KEY and live in
  // their own block.
  const prev = process.env.PMAX_FUNNEL_VARIANTS;
  process.env.PMAX_FUNNEL_VARIANTS = 'true';
  const mixed = svc.planDeterministicVideoAds([
    'meta_stories_9_16', 'pmax_video_9_16', 'pmax_video_16_9'
  ]);
  const metaStaged = mixed.filter((p) =>
    p.platformFormat === 'meta_stories_9_16' && p.funnelStage);
  const pmaxStaged = mixed.filter((p) =>
    (p.platformFormat === 'pmax_video_9_16' || p.platformFormat === 'pmax_video_16_9')
    && p.funnelStage);
  assert.ok(metaStaged.length > 0, 'mixed run dropped Meta intent variants');
  assert.ok(
    metaStaged.every((p) => p.deriveFromMaster === 'meta_stories_9_16' && p.billable === false),
    'a Meta funnel row in a mixed run is missing deriveFromMaster — that is the Omni path'
  );
  // A PMax funnel row retitles the plate that was actually PAID FOR, which
  // is NOT always its own format. Under the shared 9:16 master (owner
  // directive 2026-08-18) the portrait family rides the Meta Stories plate,
  // so pmax_video_9_16 staged rows carry deriveFromMaster='meta_stories_9_16'
  // while pmax_video_16_9 still points at itself. Both are free; what this
  // pins is that the target is a REAL master in the plan, never the row's
  // own format by reflex — pointing a staged row at a format that is itself
  // a derive is the "derivative of a derivative" hang.
  const trueMasters = new Set(
    mixed.filter((p) => !p.deriveFromMaster).map((p) => p.platformFormat)
  );
  assert.ok(
    pmaxStaged.every((p) => p.billable === false),
    'a PMax funnel row in a mixed run is marked billable'
  );
  assert.ok(
    pmaxStaged.every((p) => trueMasters.has(p.deriveFromMaster)),
    'a PMax funnel row derives from something that is not a paid master in this plan: '
      + JSON.stringify(pmaxStaged.map((p) => `${p.platformFormat}<-${p.deriveFromMaster}`))
  );
  assert.ok(
    /GOOGLE_VIDEO_MASTER_SET\.has\(f\)/.test(SRC),
    'the Google-only funnelMasters filter is gone — Meta rows could be minted twice'
  );
  if (prev == null) delete process.env.PMAX_FUNNEL_VARIANTS;
  else process.env.PMAX_FUNNEL_VARIANTS = prev;
});

check('H3 [MONEY] every Meta derivative is minted WITH deriveFromMaster', () => {
  const prev = process.env.PMAX_FUNNEL_VARIANTS;
  process.env.PMAX_FUNNEL_VARIANTS = 'true';
  const plan = svc.planDeterministicVideoAds(['meta_stories_9_16']);
  const derives = plan.filter((p) => p.platformFormat !== 'meta_stories_9_16'
    || p.funnelStage);
  assert.ok(derives.length > 0, 'Meta plan has no free rows');
  for (const row of derives) {
    assert.strictEqual(
      row.deriveFromMaster, 'meta_stories_9_16',
      `${row.platformFormat}:${row.funnelStage} missing deriveFromMaster — that row would bill Omni`
    );
    assert.strictEqual(row.billable, false, `${row.platformFormat}:${row.funnelStage} marked billable`);
  }
  assert.ok(
    /for \(const fmt of META_VIDEO_DERIVE_KEYS\)/.test(SRC),
    'the Meta derivative loop is gone from the planner'
  );
  assert.ok(
    /deriveFromMaster:\s*META_VIDEO_DERIVE_MAP\[fmt\]/.test(SRC),
    'MONEY: Meta derivatives are minted without deriveFromMaster'
  );
  if (prev == null) delete process.env.PMAX_FUNNEL_VARIANTS;
  else process.env.PMAX_FUNNEL_VARIANTS = prev;
});

check('H3b there is no second ungated Meta derivative mint', () => {
  // TWO gated loops inside the planner are expected (unstaged derives +
  // staged variants). What must not come back is the removed ungated
  // expandWizardJob copy that bypassed META_VIDEO_DERIVATIVES.
  assert.ok(
    !/const\s+metaDeriveSource\s*=/.test(SRC),
    'the removed ungated Meta mint block is back'
  );
  assert.ok(
    /const videoPlan = planDeterministicVideoAds\(masterFormats\)/.test(SRC),
    'expandWizardJob is not iterating the planner — a second handwritten mint can return'
  );
});

check('H4 the Meta dry-run count cannot drift from the mint', () => {
  assert.ok(
    /const dryPlan = planDeterministicVideoAds\(dryMasterFormats\)/.test(SRC),
    'dry-run no longer shares the planner with the live mint'
  );
  assert.ok(
    !/dryMetaDerives/.test(SRC),
    'the duplicate dry-run Meta term is back'
  );
});

check('H2 dry-run count uses the same planner as the live mint', () => {
  assert.ok(
    /const dryPlan = planDeterministicVideoAds\(dryMasterFormats\)/.test(SRC),
    'dry-run no longer calls the planner — delivered/billable will drift from the mint'
  );
  assert.ok(
    /const dryDetPerProduct = dryPlan\.length/.test(SRC),
    'dry-run is not using dryPlan.length'
  );
  assert.ok(
    /for \(const item of videoPlan\)/.test(SRC),
    'expandWizardJob is not iterating the planner — live mint and dry-run can drift'
  );
});

if (failures.length) {
  console.error(`\n❌ verifyMixedPlatformVideo: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`✅ verifyMixedPlatformVideo: ${pass}/${pass} checks passed`);
