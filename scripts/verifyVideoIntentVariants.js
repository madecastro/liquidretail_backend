#!/usr/bin/env node
// verifyVideoIntentVariants — every video surface ships 3 intent
// variations (awareness / consideration / conversion) without a second
// Omni submit, and without shifting a stored master digest.
//
// THE DELIVERED DEFECT (measured 2026-08-12, run_1786555875841_2ddf9739).
// Owner spec: 3 intent variations per surface. Delivered:
//   Static  — 3 concepts each, all funnelStage:null (unlabelled; out of
//             scope here — video only).
//   Meta video (4 surfaces) — 1. No intent variants at all.
//   PMax video (3 surfaces) — 4: an unstaged base PLUS three stages.
//
// ROOT CAUSE. funnelStage was appended to computeDeterministicVideoDigest
// for Google PMax formats only. Meta variants hashed identically to each
// other AND to the Stories master; insertMany({ordered:false}) swallowed
// the unique-index collisions, so two of the three free retitles vanished.
// PMax minted the unstaged row AND a separate awareness row, hence 4.
//
// THE FIX, and the money trap inside it.
//   1. Append funnelStage when — and only when — it is non-null. A master
//      (stage null) MUST hash exactly as it does today. Do NOT bump
//      det-video:v1. Do NOT push an empty placeholder.
//   2. Awareness is the unstaged row. Variants are consideration +
//      conversion only. PMax = 9/product (3×3), not 12.
//   3. Meta variants are FREE retitles of the one paid 9:16 master.
//      resolveDeriveFromMaster fail-closes on funnelStage for Meta too;
//      a dropped deriveFromMaster must not re-open Omni.
//
// These checks CALL the real digest / planner / derive-gate functions.
// A regex over the source cannot tell a working digest from one that
// merely still contains the word funnelStage.
//
// REVERT-PROOF RECIPE (each must fail this harness):
//   1. Re-scope funnelStage to Google-only          → M2 / M3 / C3
//   2. Append funnelStage unconditionally (even '') → M1
//   3. Bump the prefix to det-video:v2              → M5
//   4. Mint awareness as a separate staged row      → N1
//   5. Drop deriveFromMaster on a Meta variant      → D2 / D3
//   6. Leave resolveDeriveFromMaster Meta+stage=null → D2
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services/campaignAdsGenerationService'));

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyVideoIntentVariants\n');

const digest = svc.computeDeterministicVideoDigest;
const planAds = svc.planDeterministicVideoAds;
const resolveDerive = svc.resolveDeriveFromMaster;

const META_MASTER = 'meta_stories_9_16';
const META_DERIVES = ['meta_reels_9_16', 'meta_feed_1_1', 'meta_feed_4_5'];
const PMAX_9 = 'pmax_video_9_16';
const PMAX_16 = 'pmax_video_16_9';
const PMAX_1_1 = 'pmax_video_1_1';
const STAGES = ['awareness', 'consideration', 'conversion'];
const VARIANT_STAGES = ['consideration', 'conversion'];

const BASE = {
  campaignId: 'C1',
  productId: 'P1',
  referenceMediaIds: [],
  mediaId: 'M1',
  ctaText: 'SHOP NOW',
  ctaUrl: 'https://example.com',
  ctaUrlParams: '',
  videoPromptGuidance: null,
  videoPromptRaw: null
};

// ── Pre-change digest, reconstructed inline. ─────────────────────────
// This is computeDeterministicVideoDigest as it shipped on main before
// this change: duration for Google PMax only; funnelStage for Google
// PMax only, and only when non-empty. A live master (stage null) MUST
// still hash identically to this reconstruction. If it does not, the
// next Generate on any existing campaign re-bills every Omni master.
function isGooglePmaxVideoFormatPre(fmt) {
  return fmt === PMAX_9 || fmt === PMAX_16 || fmt === PMAX_1_1;
}
function preChangeDeterministicVideoDigest({
  campaignId, productId, referenceMediaIds, mediaId,
  platformFormat, ctaText, ctaUrl, ctaUrlParams,
  videoPromptGuidance, videoPromptRaw,
  videoDurationSec,
  funnelStage = null
}) {
  const refKey = (Array.isArray(referenceMediaIds) && referenceMediaIds.length
    ? referenceMediaIds
    : [mediaId]
  ).map(String).join(',');
  const parts = [
    'det-video:v1',
    String(campaignId),
    String(productId),
    refKey,
    String(platformFormat || ''),
    'video',
    String(ctaText || ''),
    String(ctaUrl || ''),
    String(ctaUrlParams || ''),
    String(videoPromptGuidance || ''),
    String(videoPromptRaw || '')
  ];
  if (isGooglePmaxVideoFormatPre(platformFormat)) {
    parts.push(videoDurationSec == null || videoDurationSec === ''
      ? ''
      : String(videoDurationSec));
  }
  if (isGooglePmaxVideoFormatPre(platformFormat)
      && funnelStage != null && String(funnelStage) !== '') {
    parts.push(String(funnelStage));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── A. Exports the harness actually calls ────────────────────────────
ok('A1 computeDeterministicVideoDigest is a function', () => {
  assert.strictEqual(typeof digest, 'function');
});
ok('A2 planDeterministicVideoAds is a function', () => {
  assert.strictEqual(typeof planAds, 'function');
});
ok('A3 resolveDeriveFromMaster is a function', () => {
  assert.strictEqual(typeof resolveDerive, 'function');
});
ok('A4 FUNNEL_VARIANT_STAGES is consideration + conversion only', () => {
  assert.deepStrictEqual([...svc.FUNNEL_VARIANT_STAGES], VARIANT_STAGES);
});
ok('A5 PMAX_FUNNEL_STAGES still names all three (awareness is the unstaged row)', () => {
  assert.deepStrictEqual([...svc.PMAX_FUNNEL_STAGES], STAGES);
});

// ── M. [MONEY] master digests stay byte-identical to pre-change ──────
console.log('M. master digest byte-identity (the re-bill guard)');

ok('M1 [MONEY] pre-existing Meta master digest is byte-identical to the pre-change implementation', () => {
  const live = digest({ ...BASE, platformFormat: META_MASTER });
  const prior = preChangeDeterministicVideoDigest({ ...BASE, platformFormat: META_MASTER });
  assert.strictEqual(live, prior,
    `Meta master shifted\n     live=${live}\n     prior=${prior}`);
});

ok('M1b [MONEY] Meta master + explicit funnelStage:null is still the pre-change hash', () => {
  const live = digest({ ...BASE, platformFormat: META_MASTER, funnelStage: null });
  const prior = preChangeDeterministicVideoDigest({ ...BASE, platformFormat: META_MASTER });
  assert.strictEqual(live, prior);
});

ok('M1c [MONEY] empty-string funnelStage does not shift a Meta master', () => {
  const omit = digest({ ...BASE, platformFormat: META_MASTER });
  const empty = digest({ ...BASE, platformFormat: META_MASTER, funnelStage: '' });
  assert.strictEqual(omit, empty,
    'pushing an empty funnel part re-mints every stored Meta digest');
});

ok('M2 [MONEY] pre-existing PMax 9:16 master digest is byte-identical to the pre-change implementation', () => {
  const args = { ...BASE, platformFormat: PMAX_9, videoDurationSec: 10 };
  const live = digest(args);
  const prior = preChangeDeterministicVideoDigest(args);
  assert.strictEqual(live, prior,
    `PMax 9:16 master shifted\n     live=${live}\n     prior=${prior}`);
});

ok('M2b [MONEY] pre-existing PMax 16:9 master digest is byte-identical to the pre-change implementation', () => {
  const args = { ...BASE, platformFormat: PMAX_16, videoDurationSec: 10 };
  assert.strictEqual(digest(args), preChangeDeterministicVideoDigest(args));
});

ok('M2c [MONEY] unstaged PMax 1:1 digest is byte-identical to the pre-change implementation', () => {
  const args = { ...BASE, platformFormat: PMAX_1_1, videoDurationSec: 10 };
  assert.strictEqual(digest(args), preChangeDeterministicVideoDigest(args));
});

ok('M3 [MONEY] the 3 stages produce 3 DISTINCT digests on the same Meta format', () => {
  const set = new Set(STAGES.map((s) => digest({
    ...BASE, platformFormat: META_MASTER, funnelStage: s
  })));
  assert.strictEqual(set.size, 3, 'Meta intent variants collapse on the unique index');
});

ok('M3b [MONEY] the 3 stages produce 3 DISTINCT digests on the same PMax format', () => {
  const set = new Set(STAGES.map((s) => digest({
    ...BASE, platformFormat: PMAX_9, videoDurationSec: 10, funnelStage: s
  })));
  assert.strictEqual(set.size, 3);
});

ok('M4 [MONEY] a stage digest differs from its Meta master', () => {
  const master = digest({ ...BASE, platformFormat: META_MASTER });
  for (const s of STAGES) {
    assert.notStrictEqual(
      digest({ ...BASE, platformFormat: META_MASTER, funnelStage: s }),
      master,
      `Meta ${s} collides with the unstaged master`
    );
  }
});

ok('M4b [MONEY] a stage digest differs from its PMax master', () => {
  const master = digest({ ...BASE, platformFormat: PMAX_9, videoDurationSec: 10 });
  for (const s of STAGES) {
    assert.notStrictEqual(
      digest({ ...BASE, platformFormat: PMAX_9, videoDurationSec: 10, funnelStage: s }),
      master,
      `PMax ${s} collides with the unstaged master`
    );
  }
});

ok('M5 [MONEY] digest prefix is still det-video:v1 (no blanket re-mint)', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8'
  );
  assert.ok(src.includes("'det-video:v1'"), 'prefix bump re-mints every stored video ad');
  assert.ok(!src.includes("'det-video:v2'"), 'a v2 prefix is a silent full remint');
});

ok('M6 duration is STILL Google-only (Meta 8s→10s must not fold in here)', () => {
  const a = digest({ ...BASE, platformFormat: META_MASTER });
  const b = digest({ ...BASE, platformFormat: META_MASTER, videoDurationSec: 10 });
  assert.strictEqual(a, b, 'duration joined a Meta digest — that is a costed remint');
});

// ── D. [MONEY] zero billable submits from any funnel variant ─────────
console.log('D. funnel variants never reach a billable submit');

ok('D1 every planner variant carries deriveFromMaster', () => {
  const prev = process.env.PMAX_FUNNEL_VARIANTS;
  process.env.PMAX_FUNNEL_VARIANTS = 'true';
  const mixed = planAds([META_MASTER, PMAX_9, PMAX_16]);
  const staged = mixed.filter((p) => p.funnelStage);
  assert.ok(staged.length > 0, 'planner minted no staged rows');
  for (const row of staged) {
    assert.ok(row.deriveFromMaster,
      `${row.platformFormat}:${row.funnelStage} has no deriveFromMaster`);
    assert.strictEqual(row.billable, false,
      `${row.platformFormat}:${row.funnelStage} is marked billable`);
  }
  if (prev == null) delete process.env.PMAX_FUNNEL_VARIANTS;
  else process.env.PMAX_FUNNEL_VARIANTS = prev;
});

ok('D2 [MONEY] Meta master + stage fail-closes to the Stories plate (marker dropped)', () => {
  for (const s of STAGES) {
    assert.strictEqual(
      resolveDerive({ platformFormat: META_MASTER, funnelStage: s }),
      META_MASTER,
      `Meta Stories + ${s} with no marker would take the Omni path`
    );
  }
});

ok('D2b [MONEY] Meta derive + stage still fail-closes to the Stories plate', () => {
  for (const fmt of META_DERIVES) {
    for (const s of VARIANT_STAGES) {
      assert.strictEqual(
        resolveDerive({ platformFormat: fmt, funnelStage: s }),
        META_MASTER,
        `${fmt}:${s} does not derive from the Stories master`
      );
    }
  }
});

ok('D3 [MONEY] PMax master + stage fail-closes to itself (marker dropped)', () => {
  assert.strictEqual(
    resolveDerive({ platformFormat: PMAX_9, funnelStage: 'consideration' }),
    PMAX_9
  );
  assert.strictEqual(
    resolveDerive({ platformFormat: PMAX_16, funnelStage: 'conversion' }),
    PMAX_16
  );
});

ok('D4 [MONEY] pmax_video_1_1 never reaches Omni (with or without a stage)', () => {
  assert.strictEqual(resolveDerive({ platformFormat: PMAX_1_1 }), PMAX_9);
  assert.strictEqual(
    resolveDerive({ platformFormat: PMAX_1_1, funnelStage: 'consideration' }),
    PMAX_9
  );
});

ok('D5 unstaged masters stay billable (gate returns null)', () => {
  assert.strictEqual(resolveDerive({ platformFormat: META_MASTER }), null);
  assert.strictEqual(resolveDerive({ platformFormat: PMAX_9 }), null);
  assert.strictEqual(resolveDerive({ platformFormat: PMAX_16 }), null);
});

ok('D6 a legacy paid Meta 1:1 (receipt present, no stage) stays billable', () => {
  assert.strictEqual(
    resolveDerive({
      platformFormat: 'meta_feed_1_1',
      veoPredictionId: 'pred_legacy_123'
    }),
    null,
    'a receipted legacy Meta row was reclassified as a derivation'
  );
});

ok('D7 renderDeriveOnlyVideoAd still contains ZERO billable submits', () => {
  const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
  const start = adsSrc.indexOf('async function renderDeriveOnlyVideoAd(');
  assert.ok(start > 0, 'renderDeriveOnlyVideoAd not found');
  const end = adsSrc.indexOf('\nasync function ', start + 10);
  const body = adsSrc.slice(start, end > start ? end : start + 16000);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/veoGenerateForAd\s*\(/.test(code), 'derive path calls veoGenerateForAd');
  assert.ok(!/veoPrepareStoryboard\s*\(/.test(code), 'derive path calls veoPrepareStoryboard');
  assert.ok(!/atlasVideoService/.test(code), 'derive path mentions atlasVideoService');
});

// ── N. Counts: PMax = 9, Meta = 4×3 with exactly one master ──────────
console.log('N. per-product counts');

function withFunnel(on, fn) {
  const prev = process.env.PMAX_FUNNEL_VARIANTS;
  process.env.PMAX_FUNNEL_VARIANTS = on ? 'true' : 'false';
  try { return fn(); }
  finally {
    if (prev == null) delete process.env.PMAX_FUNNEL_VARIANTS;
    else process.env.PMAX_FUNNEL_VARIANTS = prev;
  }
}

ok('N1 [MONEY] PMax video = 9 per product (3 surfaces × 3 stages), 2 billable', () => {
  const plan = withFunnel(true, () => planAds([PMAX_9, PMAX_16]));
  assert.strictEqual(plan.length, 9,
    `PMax plan length ${plan.length} — still minting the extra awareness row?\n     ${
      plan.map((p) => `${p.platformFormat}:${p.funnelStage || 'base'}`).join(', ')}`);
  assert.strictEqual(plan.filter((p) => p.billable).length, 2);
  assert.strictEqual(plan.filter((p) => p.funnelStage === 'awareness').length, 0,
    'awareness is being minted as a separate staged row — that is the 4th ad');
  const surfaces = new Set(plan.map((p) => p.platformFormat));
  assert.deepStrictEqual([...surfaces].sort(), [PMAX_1_1, PMAX_16, PMAX_9].sort());
  for (const fmt of [PMAX_9, PMAX_16, PMAX_1_1]) {
    const rows = plan.filter((p) => p.platformFormat === fmt);
    assert.strictEqual(rows.length, 3, `${fmt} has ${rows.length} rows, want 3`);
  }
});

ok('N2 Meta video = 4 surfaces × 3 stages, exactly ONE billable master', () => {
  const plan = withFunnel(true, () => planAds([META_MASTER]));
  assert.strictEqual(plan.length, 12,
    `Meta plan length ${plan.length}\n     ${
      plan.map((p) => `${p.platformFormat}:${p.funnelStage || 'base'}`).join(', ')}`);
  const billable = plan.filter((p) => p.billable);
  assert.strictEqual(billable.length, 1);
  assert.strictEqual(billable[0].platformFormat, META_MASTER);
  assert.strictEqual(billable[0].funnelStage, null);
  assert.strictEqual(billable[0].deriveFromMaster, null);
  for (const fmt of [META_MASTER, ...META_DERIVES]) {
    const rows = plan.filter((p) => p.platformFormat === fmt);
    assert.strictEqual(rows.length, 3, `${fmt} has ${rows.length} rows, want 3`);
  }
});

ok('N3 [MONEY] every non-master Meta row is a free retitle of the Stories plate', () => {
  const plan = withFunnel(true, () => planAds([META_MASTER]));
  for (const row of plan) {
    if (row.billable) continue;
    assert.strictEqual(row.deriveFromMaster, META_MASTER,
      `${row.platformFormat}:${row.funnelStage} does not derive from the Stories master`);
    assert.strictEqual(
      resolveDerive({
        platformFormat: row.platformFormat,
        funnelStage: row.funnelStage,
        deriveFromMaster: row.deriveFromMaster
      }),
      META_MASTER
    );
  }
});

ok('N4 flag-off restores the pre-variant mint (PMax 3, Meta 4)', () => {
  const pmax = withFunnel(false, () => planAds([PMAX_9, PMAX_16]));
  const meta = withFunnel(false, () => planAds([META_MASTER]));
  assert.strictEqual(pmax.length, 3);
  assert.strictEqual(pmax.filter((p) => p.billable).length, 2);
  assert.ok(pmax.every((p) => !p.funnelStage));
  assert.strictEqual(meta.length, 4);
  assert.strictEqual(meta.filter((p) => p.billable).length, 1);
  assert.ok(meta.every((p) => !p.funnelStage));
});

ok('N5 mixed run keeps both platforms and does not double-mint Meta', () => {
  const plan = withFunnel(true, () => planAds([META_MASTER, PMAX_9, PMAX_16]));
  // Owner 2026-09-03: mixed runs share the 9:16 plate unconditionally
  // (hook-first is not a conjunct). Kill switch / 10s floor can still
  // refuse; this check tracks the same decision the planner made.
  const shared = svc.resolvePortraitMasterFormat([META_MASTER, PMAX_9, PMAX_16])
    === META_MASTER;
  assert.strictEqual(plan.filter((p) => p.billable).length, shared ? 2 : 3,
    shared
      ? 'shared 9:16 run must bill exactly 2 (Meta portrait plate + PMax 16:9)'
      : 'unshared mixed run must bill 3 (1 Meta + 2 PMax)');
  // The 16:9 master is billable in BOTH arms — it is a genuinely different
  // aspect and nothing can derive it from a portrait plate.
  assert.ok(
    plan.some((p) => p.platformFormat === PMAX_16 && !p.funnelStage && p.billable),
    'the PMax 16:9 master stopped being billable — that surface has no other source'
  );
  assert.strictEqual(
    plan.filter((p) => p.platformFormat === META_MASTER).length, 3,
    'mixed run Meta Stories count is not 3 (unstaged + 2 variants)'
  );
  assert.strictEqual(plan.length, 21,
    `mixed plan length ${plan.length}, want 9 PMax + 12 Meta`);
});

ok('N6 pmax_video_1_1 is never a billable plan entry', () => {
  const plan = withFunnel(true, () => planAds([PMAX_9, PMAX_16]));
  assert.ok(plan.every((p) => p.platformFormat !== PMAX_1_1 || p.billable === false));
  const asMaster = withFunnel(true, () => planAds([PMAX_1_1]));
  assert.ok(
    asMaster.every((p) => p.billable === false || p.platformFormat !== PMAX_1_1),
    'passing the derive-only key as a master still marked it billable'
  );
});

ok('N7 expandWizardJob iterates the planner (no second handwritten mint)', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8'
  );
  assert.ok(/const videoPlan = planDeterministicVideoAds\(masterFormats\)/.test(src));
  assert.ok(/for \(const item of videoPlan\)/.test(src));
});

// ── P. Presets: PMax → pmax10, Meta → generic 8s ─────────────────────
console.log('P. funnel preset mapping');

ok('P1 PMax stage → canonical-<stage>-pmax10', () => {
  assert.strictEqual(
    svc.resolveFunnelPresetOverride({ platformFormat: PMAX_9, funnelStage: 'consideration' }),
    'canonical-consideration-pmax10'
  );
});
ok('P2 Meta stage → canonical-<stage> (8s generic, not pmax10)', () => {
  assert.strictEqual(
    svc.resolveFunnelPresetOverride({ platformFormat: META_MASTER, funnelStage: 'conversion' }),
    'canonical-conversion'
  );
});
ok('P3 unstaged master → null (today cascade; unstaged IS awareness)', () => {
  assert.strictEqual(
    svc.resolveFunnelPresetOverride({ platformFormat: PMAX_9 }),
    null
  );
  assert.strictEqual(
    svc.resolveFunnelPresetOverride({ platformFormat: META_MASTER, funnelStage: null }),
    null
  );
});

// ── RP. In-process revert-proofs ─────────────────────────────────────
console.log('RP. revert-proofs (mutate a local copy, assert the hole, confirm live is closed)');

ok('RP1 [MONEY] Google-only funnelStage WOULD collapse Meta variants onto the master', () => {
  const broken = (args) => preChangeDeterministicVideoDigest(args);
  const master = broken({ ...BASE, platformFormat: META_MASTER });
  const staged = broken({ ...BASE, platformFormat: META_MASTER, funnelStage: 'consideration' });
  assert.strictEqual(master, staged, 'setup: pre-change Meta digest must ignore stage');
  assert.notStrictEqual(
    digest({ ...BASE, platformFormat: META_MASTER }),
    digest({ ...BASE, platformFormat: META_MASTER, funnelStage: 'consideration' }),
    'live digest still ignores Meta funnelStage'
  );
});

ok('RP2 [MONEY] unconditional empty funnel part WOULD shift every master', () => {
  const parts = [
    'det-video:v1', 'C1', 'P1', 'M1', META_MASTER, 'video',
    'SHOP NOW', 'https://example.com', '', '', '', ''
  ];
  const bad = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  const live = digest({ ...BASE, platformFormat: META_MASTER });
  assert.notStrictEqual(bad, live, 'setup: the bad mutation must actually shift the hash');
});

ok('RP3 three live Meta stage digests remain distinct', () => {
  const set = new Set(STAGES.map((s) => digest({
    ...BASE, platformFormat: 'meta_feed_1_1', funnelStage: s
  })));
  assert.strictEqual(set.size, 3);
});

ok('RP4 dropping the Meta+stage fail-closed WOULD re-open Omni', () => {
  const broken = function (ad) {
    if (!ad) return null;
    const explicit = ad.deriveFromMaster;
    if (typeof explicit === 'string' && explicit) return explicit;
    if (ad.platformFormat === PMAX_1_1) return PMAX_9;
    return null;
  };
  assert.strictEqual(
    broken({ platformFormat: META_MASTER, funnelStage: 'consideration' }),
    null,
    'setup: the mutation must open the hole'
  );
  assert.strictEqual(
    resolveDerive({ platformFormat: META_MASTER, funnelStage: 'consideration' }),
    META_MASTER,
    'live gate no longer fail-closes Meta+stage'
  );
});

if (process.exitCode) {
  console.error(`\nverifyVideoIntentVariants: FAILED after ${checks} passing checks`);
  process.exit(1);
}
console.log(`\nverifyVideoIntentVariants: ${checks} passed`);
console.log('OK');
