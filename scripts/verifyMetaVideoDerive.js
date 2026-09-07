#!/usr/bin/env node
'use strict';
/**
 * verifyMetaVideoDerive — the free Meta video derivations (1:1 / 4:5 / Reels).
 *
 * WHAT THIS PROTECTS, and why it is worth a harness of its own.
 *
 * Commit 919627a0 (2026-08-01) collapsed Meta video from one Ad per aspect to a
 * single 9:16 Stories master, because each aspect was minting its OWN Omni
 * submit — three paid masters per product where one would do. Correct fix. Its
 * commit message names the intended end state: "The other Meta video sizes are
 * derivations of that master (Phase 3), not separate Veo submits."
 *
 * The money half shipped; the derivation half did not, so for ten days a Meta
 * video run delivered ONE ad instead of four. This harness pins the restored
 * half, and the two failure directions it sits between:
 *
 *   UNDER-DELIVER — a derivative that is never minted (the bug being fixed).
 *   OVER-BILL     — a derivative that reaches the billable Omni path, which is
 *                   exactly the 3-paid-masters waste 919627a0 removed.
 *
 * The second is why the gate is checked on platformFormat ALONE, with the
 * `deriveFromMaster` marker deliberately absent: a dropped marker must not be
 * able to re-open spend on a surface the product sells as free.
 *
 * No DB, no network, no API keys.
 *   node scripts/verifyMetaVideoDerive.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pf = require(path.join(ROOT, 'services', 'platformFormats.js'));
const gen = require(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'));

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(label, actual, expected) {
  check(`${label} → ${JSON.stringify(expected)}`,
    JSON.stringify(actual) === JSON.stringify(expected));
}

const MASTER = 'meta_stories_9_16';
const DERIVES = ['meta_reels_9_16', 'meta_feed_1_1', 'meta_feed_4_5'];

// ── A. The derive set is defined ONCE and shared ────────────────────────
console.log('\nA. one definition of "which Meta video surfaces are free"');
eq('A1 META_VIDEO_MASTER', pf.META_VIDEO_MASTER, MASTER);
check('A2 META_VIDEO_DERIVE_ONLY is exported', Array.isArray(pf.META_VIDEO_DERIVE_ONLY));
check('A3 it is exactly the fan-out minus the master',
  JSON.stringify([...(pf.META_VIDEO_DERIVE_ONLY || [])].sort())
    === JSON.stringify([...DERIVES].sort()),
  `got ${JSON.stringify(pf.META_VIDEO_DERIVE_ONLY)}`);
check('A4 the master is NOT in the derive set (it is the thing being paid for)',
  !(pf.META_VIDEO_DERIVE_ONLY || []).includes(MASTER));
// Derived from META_VIDEO_FANOUT rather than hand-listed, so a surface added to
// the fan-out cannot silently miss the derive treatment.
check('A5 derive set is derived from META_VIDEO_FANOUT, not hand-listed',
  (pf.META_VIDEO_DERIVE_ONLY || []).every((k) => pf.META_VIDEO_FANOUT.includes(k)));

// ── B. Selection: ANY Meta video tick resolves to the MASTER ────────────
// Owner rule: "any time any derivation of a 9:16 is chosen, it should
// automatically trigger creation of all sizes that are nearly free ...
// including the charged 9:16 that's necessary."
console.log('\nB. any Meta video selection resolves to the paid master');
for (const k of [...DERIVES, MASTER]) {
  eq(`B1 explicit tick ${k}`,
    pf.resolveExplicitFormats({ videoFormats: [k] }).videoFormats, [MASTER]);
  eq(`B2 single preset ${k}`,
    pf.resolvePreset('single', k, { kinds: 'video' }).videoFormats, [MASTER]);
}
eq('B3 several Meta ticks still resolve to exactly one master',
  pf.resolveExplicitFormats({ videoFormats: [...DERIVES, MASTER] }).videoFormats, [MASTER]);
check('B4 MONEY: a Meta video selection never exceeds ONE billable master',
  [[...DERIVES], [MASTER], ['meta_feed_1_1'], [...DERIVES, MASTER]]
    .every((sel) => pf.resolveExplicitFormats({ videoFormats: sel })
      .videoFormats.filter((k) => pf.platformForFormat(k) === 'meta').length <= 1));
// A derive surface must never survive INTO the master list — that is the row
// that would take the paid path.
for (const k of DERIVES) {
  check(`B5 MONEY: ${k} never appears as a resolved master`,
    !pf.resolveExplicitFormats({ videoFormats: [k] }).videoFormats.includes(k));
}
// Mixed platform: Meta collapses to its master, Google keeps its two.
{
  const r = pf.resolveExplicitFormats({
    videoFormats: ['meta_feed_1_1', 'pmax_video_9_16', 'pmax_video_16_9']
  });
  eq('B6 mixed run: 1 Meta master + 2 Google masters',
    r.videoFormats, [MASTER, 'pmax_video_9_16', 'pmax_video_16_9']);
}

// ── C. The gate: derivatives are FREE, the master stays BILLABLE ────────
console.log('\nC. resolveDeriveFromMaster — fail-closed on platformFormat alone');
for (const k of DERIVES) {
  // Marker deliberately ABSENT — this is the fail-closed case.
  check(`C1 [MONEY] ${k} derives from the master with NO marker set`,
    gen.resolveDeriveFromMaster({ platformFormat: k }) === MASTER,
    'a dropped marker must not send a free surface down the billable Omni path');
  check(`C2 ${k} honours an explicit marker too`,
    gen.resolveDeriveFromMaster({ platformFormat: k, deriveFromMaster: MASTER }) === MASTER);
}
check('C3 [MONEY] the Meta MASTER is NOT routed to derive (it is the paid render)',
  gen.resolveDeriveFromMaster({ platformFormat: MASTER }) === null,
  'routing the master to derive would skip the render it paid for');
for (const k of ['pmax_video_9_16', 'pmax_video_16_9']) {
  check(`C4 Google master ${k} still billable`,
    gen.resolveDeriveFromMaster({ platformFormat: k }) === null);
}
check('C5 the PMax square still derives (unchanged by this work)',
  gen.resolveDeriveFromMaster({ platformFormat: 'pmax_video_1_1' }) === 'pmax_video_9_16');

// ── D. Digests stay distinct, and nothing pre-existing shifts ───────────
// The (campaignId, identityDigest) unique index is the only thing stopping a
// repeat Generate re-billing. Four Meta video rows must not collide, and the
// master's own digest must be byte-identical to before this change or every
// stored Meta ad re-mints.
console.log('\nD. identity digests');
{
  const base = {
    campaignId: 'C1', productId: 'P1', referenceMediaIds: [], mediaId: 'M1',
    ctaText: 'SHOP NOW', ctaUrl: 'https://example.com', ctaUrlParams: '',
    videoPromptGuidance: null, videoPromptRaw: null
  };
  const digest = gen.computeDeterministicVideoDigest;
  if (typeof digest === 'function') {
    const all = [MASTER, ...DERIVES].map((f) => digest({ ...base, platformFormat: f }));
    check('D1 the four Meta video rows have four DISTINCT digests',
      new Set(all).size === 4, JSON.stringify(all.map((d) => d.slice(0, 8))));
    // Duration stays Google-only (Meta rows have history at every length).
    // funnelStage joins when — and only when — it is set: a null-stage
    // master stays byte-identical; a set stage MUST differ or the three
    // intent variants collapse onto the master on the unique index.
    for (const f of [MASTER, ...DERIVES]) {
      check(`D2 [MONEY] duration does not alter the digest for ${f}`,
        digest({ ...base, platformFormat: f })
          === digest({ ...base, platformFormat: f, videoDurationSec: 10 }));
      check(`D3 [MONEY] funnelStage:null does not alter the digest for ${f}`,
        digest({ ...base, platformFormat: f })
          === digest({ ...base, platformFormat: f, funnelStage: null }));
      check(`D3b [MONEY] a SET funnelStage DOES alter the digest for ${f}`,
        digest({ ...base, platformFormat: f })
          !== digest({ ...base, platformFormat: f, funnelStage: 'consideration' }),
        'Meta intent variants collide with the unstaged row and insertMany drops them');
    }
  } else {
    check('D0 computeDeterministicVideoDigest is exported', false,
      'cannot verify digest distinctness without the export');
  }
}

// ── E. The expansion mints them, gated on the SOURCE master ─────────────
// Behavioural: planDeterministicVideoAds is what expandWizardJob iterates.
// Source pins remain for the kill switch + the master-list strip, which
// no planner call can see.
console.log('\nE. expansion block');
{
  const src = fs.readFileSync(
    path.join(ROOT, 'services', 'campaignAdsGenerationService.js'), 'utf8');
  const planFn = gen.planDeterministicVideoAds;
  check('E0 planDeterministicVideoAds is exported', typeof planFn === 'function');

  const prevFunnel = process.env.PMAX_FUNNEL_VARIANTS;
  process.env.PMAX_FUNNEL_VARIANTS = 'false';
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'))];
  const offFunnel = require(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'));
  const metaOnly = offFunnel.planDeterministicVideoAds(['meta_stories_9_16']);
  check('E1 Meta-only plan (funnel off) is 1 master + 3 unstaged derives',
    metaOnly.length === 4
      && metaOnly.filter((p) => p.billable).length === 1
      && metaOnly.filter((p) => !p.billable).length === 3,
    JSON.stringify(metaOnly.map((p) => `${p.platformFormat}:${p.funnelStage}`)));
  check('E3 [MONEY] every minted derivative carries deriveFromMaster',
    metaOnly.filter((p) => !p.billable).every((p) => p.deriveFromMaster === MASTER));
  check('E4 it iterates the shared derive list, not a local literal',
    DERIVES.every((d) => metaOnly.some((p) => p.platformFormat === d && !p.funnelStage)));
  check('E7 unstaged derives sit AFTER the master in the plan',
    metaOnly[0].platformFormat === MASTER && metaOnly[0].billable === true
      && metaOnly.slice(1).every((p) => !p.billable),
    'a derivative minted before its master has nothing to crop from');
  if (prevFunnel == null) delete process.env.PMAX_FUNNEL_VARIANTS;
  else process.env.PMAX_FUNNEL_VARIANTS = prevFunnel;
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'))];

  check('E2 [MONEY] it is gated on the SOURCE master being in the run',
    /function isMetaVideoMasterRun[\s\S]{0,400}includes\(META_VIDEO_MASTER_KEY\)/.test(src),
    'a derivative whose master is not generated can only wait, retry and fail');
  check('E5 a kill switch exists and defaults ON',
    /function isMetaVideoDerivativesEnabled\(\)[\s\S]{0,260}META_VIDEO_DERIVATIVES/.test(src)
      && /if \(v == null \|\| v === ''\) return true;/.test(src));
  check('E6 [MONEY] the master-format filter strips Meta derive surfaces',
    /META_VIDEO_DERIVE_SET\.has\(f\)\) return false;/.test(src),
    'a derive surface reaching the master list would queue a paid Omni submit');
  check('E8 expandWizardJob iterates the planner (one mint path)',
    /const videoPlan = planDeterministicVideoAds\(masterFormats\)/.test(src)
      && /for \(const item of videoPlan\)/.test(src));
}

// ── F. Flag off ⇒ byte-identical to the pre-change mint ─────────────────
console.log('\nF. kill switch');
{
  const prev = process.env.META_VIDEO_DERIVATIVES;
  process.env.META_VIDEO_DERIVATIVES = 'false';
  // Re-require with a clean cache so the flag is read fresh.
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'))];
  const off = require(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'));
  check('F1 flag off: the gate still classifies derivatives as free',
    off.resolveDeriveFromMaster({ platformFormat: 'meta_feed_1_1' }) === MASTER,
    'the flag stops MINTING them; it must never make an existing row billable');
  if (prev == null) delete process.env.META_VIDEO_DERIVATIVES;
  else process.env.META_VIDEO_DERIVATIVES = prev;
  delete require.cache[require.resolve(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'))];
}

// ── G. REMOVED (dormant render fallback deletion) ──────────────────────
// G1 located renderDeriveOnlyVideoAd; G2 scanned it for billable submits;
// G3 pinned that the in-process render loop consulted resolveDeriveFromMaster
// before the Omni submit. That function and the loop are gone. MONEY
// invariant "a Meta derivative must never reach a billable Omni submit"
// is still enforced by resolveDeriveFromMaster at mint/preflight — still
// pinned in this file's C-group (fail-closed on platformFormat alone) —
// plus adgen's renderer. The render-loop gate is gone because the loop
// is gone.
console.log('\nG. derive render path (ABSENCE — in-process derive renderer is gone)');
{
  const adsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8');
  check('G1 [ABSENCE] renderDeriveOnlyVideoAd is gone from routes/ads.js',
    !/async function renderDeriveOnlyVideoAd\s*\(/.test(adsSrc),
    'the in-process derive renderer came back — restore the G2 submit-free pins');
}


const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyMetaVideoDerive: ${pass}/${total} passed, ${failures.length} FAILED`);
  failures.forEach((f) => console.log(`   FAILED: ${f}`));
  process.exit(1);
}
console.log(`✅ verifyMetaVideoDerive: ${pass}/${total} checks passed`);
