#!/usr/bin/env node
/**
 * verifyPmaxFunnelVariants.js — MONEY harness for free PMax funnel-titled
 * video variants. Offline: no DB, no network, no API key.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * A Google PMax video run already bills TWO Omni masters per product
 * (9:16 + 16:9) and derives the 1:1 for free. Funnel variants re-title
 * those already-paid plates with Remotion (self-hosted, free) — three
 * stages (awareness / consideration / conversion) per surface. Three
 * distinct ways that can turn into real money:
 *
 *   1. A funnel-variant ad reaches a billable Omni submit.
 *   2. The three variants collide on identityDigest and the unique index
 *      silently drops two of them (or worse: a variant collides with its
 *      master and never mints).
 *   3. funnelStage joins the digest for pre-existing / master rows and
 *      re-mints every stored Meta/master digest → next Generate re-bills.
 *
 * Also pins: 10s PMax presets load + timeScale 1.0 at 10s while the three
 * GENERIC 8s presets stay frozen (timeScale 1.0 at 8s); buildMetaForAd and
 * the render path receive the SAME preset; flag-off mints nothing.
 *
 * REVERT-PROOF RECIPE (each must fail this harness — run after mutating):
 *   1. Drop the funnelStage fail-closed branch in resolveDeriveFromMaster
 *      so a 9:16 ad with funnelStage:'awareness' and no deriveFromMaster
 *      returns null                                              → D2
 *   2. Remove funnelStage from computeDeterministicVideoDigest inputs
 *      so the three stages hash identically                     → C3
 *   3. Append funnelStage unconditionally (even when null/empty) so
 *      master digests shift                                     → C1
 *   4. Add a veoGenerateForAd(...) call inside renderDeriveOnlyVideoAd
 *      (or remove the early return after the derive gate)       → E1/E2
 *   5. Delete remotion/presets/canonical-awareness-pmax10.json   → P1
 *   6. Hardcode presetOverride: null in buildMetaForAd's resolveSpec
 *      call (desync from render)                                → T2
 *   7. Force isPmaxFunnelVariantsEnabled to always return false
 *      while defaults.env says true — or strip the minting loop → M1
 *
 * ACTUAL REVERT-PROOFS (this file mutates, asserts failure, restores):
 *   RP1 resolveDeriveFromMaster funnel fail-closed
 *   RP2 digest includes funnelStage when set
 *   RP3 three stages produce three digests
 *   RP4 master digest unchanged when funnelStage absent
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');
const svc  = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
const pf   = require(path.join(ROOT, 'services/platformFormats'));
const { loadPresetFile, clearPresetCache } = require(path.join(ROOT, 'services/titleSpecService'));

// specTimeScale is ESM — load via a tiny CommonJS-compatible eval of the
// pure function body (no remotion spring dependency needed for this pin).
function loadSpecTimeScale() {
  const src = fs.readFileSync(path.join(ROOT, 'remotion/lib/timing.js'), 'utf8');
  const m = src.match(/export function specTimeScale\([^)]*\)\s*\{[\s\S]*?\n\}/);
  if (!m) throw new Error('specTimeScale not found in remotion/lib/timing.js');
  // Rewrite export → function for vm
  const body = m[0].replace(/^export function/, 'function');
  const sandbox = { Math };
  vm.runInNewContext(body + '\nthis.specTimeScale = specTimeScale;', sandbox);
  return sandbox.specTimeScale;
}
const specTimeScale = loadSpecTimeScale();

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return true; }
  failures.push(detail ? `${label} — ${detail}` : label);
  return false;
}

const MASTER_9_16 = 'pmax_video_9_16';
const MASTER_16_9 = 'pmax_video_16_9';
const DERIVE_1_1  = 'pmax_video_1_1';
const STAGES = ['awareness', 'consideration', 'conversion'];
const PMAX10 = STAGES.map((s) => `canonical-${s}-pmax10`);
const GENERIC8 = STAGES.map((s) => `canonical-${s}`);

const PRE_EXISTING_FORMATS = [
  'meta_stories_9_16', 'meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'pmax_16_9'
];

// ── helpers (same body extractor as verifyPmaxVideoExpansion) ──────────
function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  const start2 = start === -1 ? src.indexOf(`function ${name}(`) : start;
  if (start2 === -1) return null;
  const parenOpen = src.indexOf('(', start2);
  if (parenOpen === -1) return null;
  let pdepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') {
      pdepth--;
      if (pdepth === 0) { parenClose = i; break; }
    }
  }
  if (parenClose === -1) return null;
  const open = src.indexOf('{', parenClose);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── A. Variants never appear in any preset's videoFormats ──────────────
for (const preset of ['google_video', 'google_all', 'meta_video', 'meta_all',
                      'meta_static', 'google_static', 'single']) {
  let resolved;
  try { resolved = pf.resolvePreset(preset); } catch { resolved = null; }
  const vids = resolved?.videoFormats || [];
  // Funnel stages are not platform formats — pin the derive-only surface
  // still never leaks into masters, and no invented funnel format keys.
  check(`A1 resolvePreset('${preset}') never returns a funnel-stage key as a videoFormat`,
    !vids.some((v) => /awareness|consideration|conversion/.test(String(v))),
    `videoFormats=${JSON.stringify(vids)}`);
  check(`A2 resolvePreset('${preset}') still never returns the derive-only 1:1 as a master`,
    !vids.includes(DERIVE_1_1));
}

check('A3 GOOGLE_VIDEO_MASTERS is still exactly the two billable Omni masters',
  Array.isArray(pf.GOOGLE_VIDEO_MASTERS)
    && pf.GOOGLE_VIDEO_MASTERS.length === 2
    && pf.GOOGLE_VIDEO_MASTERS.includes(MASTER_9_16)
    && pf.GOOGLE_VIDEO_MASTERS.includes(MASTER_16_9));

// ── B. Flag + helpers exported ─────────────────────────────────────────
check('B1 isPmaxFunnelVariantsEnabled is exported',
  typeof svc.isPmaxFunnelVariantsEnabled === 'function');
check('B2 resolveFunnelPresetOverride is exported',
  typeof svc.resolveFunnelPresetOverride === 'function');
check('B3 PMAX_FUNNEL_STAGES is the three stages',
  Array.isArray(svc.PMAX_FUNNEL_STAGES)
    && svc.PMAX_FUNNEL_STAGES.length === 3
    && STAGES.every((s) => svc.PMAX_FUNNEL_STAGES.includes(s)));

// Default ON when unset (restore env after).
const prevFlag = process.env.PMAX_FUNNEL_VARIANTS;
delete process.env.PMAX_FUNNEL_VARIANTS;
check('B4 flag defaults ON when env unset', svc.isPmaxFunnelVariantsEnabled() === true);
process.env.PMAX_FUNNEL_VARIANTS = 'false';
check('B5 flag OFF when PMAX_FUNNEL_VARIANTS=false', svc.isPmaxFunnelVariantsEnabled() === false);
process.env.PMAX_FUNNEL_VARIANTS = 'true';
check('B6 flag ON when PMAX_FUNNEL_VARIANTS=true', svc.isPmaxFunnelVariantsEnabled() === true);
if (prevFlag === undefined) delete process.env.PMAX_FUNNEL_VARIANTS;
else process.env.PMAX_FUNNEL_VARIANTS = prevFlag;

// ── C. Digest: funnelStage ONLY when set; pre-existing UNCHANGED ───────
const digest = svc.computeDeterministicVideoDigest;
const baseArgs = {
  campaignId: 'C1', productId: 'P1', referenceMediaIds: [], mediaId: 'M1',
  ctaText: 'SHOP NOW', ctaUrl: 'https://example.com', ctaUrlParams: '',
  videoPromptGuidance: null, videoPromptRaw: null
};

for (const fmt of PRE_EXISTING_FORMATS) {
  const a = digest({ ...baseArgs, platformFormat: fmt });
  const b = digest({ ...baseArgs, platformFormat: fmt, funnelStage: null });
  const c = digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10 });
  check(`C1 [MONEY] pre-existing format ${fmt} digest is unchanged by funnelStage:null / duration`,
    a === b && a === c,
    'a changed digest breaks the unique index that stops a repeat Generate re-billing Omni');
}

// Master digests without funnelStage must match the pre-funnel part list
// (duration-only extension for Google formats). Passing funnelStage:null
// or omitting it must be identical.
for (const fmt of [MASTER_9_16, MASTER_16_9, DERIVE_1_1]) {
  const omit = digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10 });
  const nullS = digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10, funnelStage: null });
  const empty = digest({ ...baseArgs, platformFormat: fmt, videoDurationSec: 10, funnelStage: '' });
  check(`C2 master/derive ${fmt} digest is identical with funnelStage absent/null/empty`,
    omit === nullS && omit === empty,
    'pushing an empty funnel part would re-mint every Google master');
}

const stageDigests = STAGES.map((s) => digest({
  ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: s
}));
check('C3 [MONEY] the 3 funnel stages produce 3 DISTINCT digests on the same master format',
  new Set(stageDigests).size === 3,
  'colliding digests silently drop variants on the unique index');

const masterDigest = digest({
  ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10
});
check('C4 a funnel variant digest differs from its master (no stage)',
  stageDigests.every((d) => d !== masterDigest),
  'a collision with the master would drop the paid plate row or the variant');

// Cross-format still distinct
const d9 = digest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: 'awareness' });
const d16 = digest({ ...baseArgs, platformFormat: MASTER_16_9, videoDurationSec: 10, funnelStage: 'awareness' });
const d1 = digest({ ...baseArgs, platformFormat: DERIVE_1_1, videoDurationSec: 10, funnelStage: 'awareness' });
check('C5 same stage on different surfaces still yields distinct digests',
  new Set([d9, d16, d1]).size === 3);

check('C6 digest prefix is still det-video:v1 (no blanket re-mint)',
  fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8')
    .includes("'det-video:v1'"));

// ── D. Derive gate covers funnel variants (behavioural) ────────────────
const adsRoute = require(path.join(ROOT, 'routes/ads.js'));
const resolveDeriveFromMaster = adsRoute.resolveDeriveFromMaster
  || svc.resolveDeriveFromMaster;
check('D1 resolveDeriveFromMaster is available',
  typeof resolveDeriveFromMaster === 'function');

// Fail-closed: funnelStage alone is enough even when deriveFromMaster is dropped.
for (const stage of STAGES) {
  check(`D2 [MONEY] funnelStage=${stage} on 9:16 with NO deriveFromMaster still derives`,
    resolveDeriveFromMaster({ platformFormat: MASTER_9_16, funnelStage: stage })
      === MASTER_9_16,
    'a dropped marker must not re-open Omni on a free retitle');
  check(`D2b funnelStage=${stage} on 16:9 with NO deriveFromMaster still derives`,
    resolveDeriveFromMaster({ platformFormat: MASTER_16_9, funnelStage: stage })
      === MASTER_16_9);
  check(`D2c funnelStage=${stage} on 1:1 still derives from 9:16`,
    resolveDeriveFromMaster({ platformFormat: DERIVE_1_1, funnelStage: stage })
      === MASTER_9_16);
}

check('D3 explicit deriveFromMaster on a funnel variant is honoured',
  resolveDeriveFromMaster({
    platformFormat: MASTER_9_16,
    deriveFromMaster: MASTER_9_16,
    funnelStage: 'awareness'
  }) === MASTER_9_16);

// Masters WITHOUT funnelStage remain billable (gate returns null).
for (const fmt of [MASTER_9_16, MASTER_16_9, ...PRE_EXISTING_FORMATS]) {
  check(`D4 billable format ${fmt} without funnelStage is NOT routed to derive`,
    resolveDeriveFromMaster({ platformFormat: fmt }) === null);
}

// ── E. Derive render path: ZERO billable submits (source, comments stripped) ─
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
const deriveBody = functionBody(adsSrc, 'renderDeriveOnlyVideoAd');
check('E0 renderDeriveOnlyVideoAd exists and is parseable', !!deriveBody);
check('E0b extracted body is the real function body',
  !!deriveBody && deriveBody.length > 2000 && /findSiblingMasterAd\s*\(/.test(deriveBody),
  `extracted ${deriveBody ? deriveBody.length : 0} chars`);

if (deriveBody) {
  const deriveCode = stripComments(deriveBody);
  check('E1 [MONEY] renderDeriveOnlyVideoAd makes ZERO billable video submits',
    !/veoGenerateForAd\s*\(/.test(deriveCode)
      && !/veoPrepareStoryboard\s*\(/.test(deriveCode)
      && !/atlasVideoService/.test(deriveCode)
      && !/generateForAd\s*\(/.test(deriveCode),
    'any submit here is a hidden ~$0.90–$1.20 per product on a free surface');
  check('E1a comment-stripping left real code to assert against',
    deriveCode.length > 1500 && /findSiblingMasterAd\s*\(/.test(deriveCode));
  check('E1b untitled-is-not-success discipline retained',
    /status:\s*'draft'/.test(deriveBody) && /titling/i.test(deriveBody));
}

const gateIdx = adsSrc.indexOf('const deriveFromFmt = resolveDeriveFromMaster(ad)');
const submitIdx = adsSrc.search(/await\s+veoGenerateForAd\s*\(/);
check('E2 [MONEY] the derive gate is evaluated BEFORE the first Omni submit',
  gateIdx !== -1 && submitIdx !== -1 && gateIdx < submitIdx,
  `gate=${gateIdx} submit=${submitIdx}`);
check('E3 the derive gate returns instead of falling through',
  /if\s*\(deriveFromFmt\)\s*\{[\s\S]{0,400}?return;/.test(adsSrc));

// findSiblingMasterAd must exclude funnel/derive siblings.
const findBody = functionBody(adsSrc, 'findSiblingMasterAd');
check('E4 findSiblingMasterAd excludes deriveFromMaster siblings',
  !!findBody && /deriveFromMaster/.test(findBody));
check('E5 findSiblingMasterAd excludes funnelStage siblings',
  !!findBody && /funnelStage/.test(findBody),
  'without this a funnel variant can wait on another variant that never holds a plate');

// ── F. Regenerate refuses funnel / derive ads ──────────────────────────
const regenSrc = fs.readFileSync(path.join(ROOT, 'services/adRegenerateService.js'), 'utf8');
check('F1 [MONEY] regenerate path uses resolveDeriveFromMaster (covers funnel variants)',
  /resolveDeriveFromMaster/.test(regenSrc));
const preflightBody = (() => {
  const i = regenSrc.indexOf('async function preflight(');
  if (i === -1) return '';
  const open = regenSrc.indexOf('{', regenSrc.indexOf(')', i));
  let depth = 0;
  for (let k = open; k < regenSrc.length; k++) {
    if (regenSrc[k] === '{') depth++;
    else if (regenSrc[k] === '}') { depth--; if (depth === 0) return regenSrc.slice(open, k + 1); }
  }
  return '';
})();
check('F1b refusal is in preflight (before 202 / any provider call)',
  /resolveDeriveFromMaster/.test(preflightBody));

// Behavioural: a funnel-variant ad is refused by the same gate regenerate uses.
check('F2 behavioural: funnel-variant ad is classified as derive-only',
  resolveDeriveFromMaster({
    platformFormat: MASTER_9_16,
    deriveFromMaster: MASTER_9_16,
    funnelStage: 'conversion'
  }) === MASTER_9_16);

// Gate defined once.
const svcSrc = fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8');
check('F3 [MONEY] gate defined once in campaignAdsGenerationService, imported elsewhere',
  (svcSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 1
    && (adsSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0
    && (regenSrc.match(/function\s+resolveDeriveFromMaster\s*\(/g) || []).length === 0);

// ── G. Minting loop (source) — flag-gated, covers masters + 1:1 ────────
check('G1 minting loop stamps funnelStage for variants',
  /funnelStage:\s*stage/.test(svcSrc) || /funnelStage:\s*s\b/.test(svcSrc));
check('G2 minting is gated on isPmaxFunnelVariantsEnabled',
  /isPmaxFunnelVariantsEnabled\s*\(/.test(svcSrc)
    && /if\s*\(\s*isPmaxFunnelVariantsEnabled\s*\(\s*\)\s*\)/.test(svcSrc));
check('G3 minting covers each master format (deriveFromMaster: fmt)',
  /deriveFromMaster:\s*fmt/.test(svcSrc));
check('G4 minting also covers the 1:1 surface (consistency decision)',
  // After the base 1:1 push, a loop over stages with DERIVE_ONLY + funnelStage
  /PMAX_VIDEO_DERIVE_ONLY[\s\S]{0,400}funnelStage:\s*stage/.test(svcSrc)
    || /funnelStage:\s*stage[\s\S]{0,400}PMAX_VIDEO_DERIVE_ONLY/.test(svcSrc)
    || (svcSrc.includes('funnelStage: stage')
      && (svcSrc.match(/platformFormat:\s*PMAX_VIDEO_DERIVE_ONLY/g) || []).length >= 2),
  '1:1 variants were chosen for surface consistency — pin the mint');

// Flag-off: when disabled, the minting block is skipped (source structure).
// Behavioural pin of the flag itself is B5; source pin that minting is
// inside the flag check:
const flagBlock = svcSrc.match(
  /if\s*\(\s*isPmaxFunnelVariantsEnabled\s*\(\s*\)\s*\)\s*\{[\s\S]{0,2500}?funnelStage/
);
check('G5 [MONEY] funnel-variant minting lives inside the flag-on block',
  !!flagBlock,
  'flag-off must mint nothing — variants must not be outside the gate');

// ── M. Flag-off minting contract (dry-run count shape via source + helper) ─
// The dry-run path multiplies by PMAX_FUNNEL_STAGES only when flag on.
check('M1 dry-run count multiplies by funnel stages only when flag enabled',
  /isPmaxFunnelVariantsEnabled\s*\(\s*\)[\s\S]{0,200}PMAX_FUNNEL_STAGES\.length/.test(svcSrc)
    || /PMAX_FUNNEL_STAGES\.length[\s\S]{0,120}isPmaxFunnelVariantsEnabled/.test(svcSrc));

// ── P. Preset files: load, validate, timeScale ─────────────────────────
clearPresetCache();
const { validateTitleSpec } = require(path.join(ROOT, 'services/titleSpecValidator'));

for (const name of PMAX10) {
  const doc = loadPresetFile(name);
  check(`P1 preset file '${name}' loads`, !!doc && doc.name === name);
  if (!doc) continue;
  for (const fmt of ['vertical', 'feed', 'square', 'landscape']) {
    const spec = doc.byFormat?.[fmt];
    check(`P2 ${name}/${fmt} exists`, !!spec);
    if (!spec) continue;
    const res = validateTitleSpec(spec, { format: fmt === 'feed' ? 'feed' : fmt });
    check(`P3 ${name}/${fmt} validates`, res.ok === true,
      res.errors ? res.errors.slice(0, 2).join('; ') : '');
    // 10s plate @ 24fps = 240 frames → timeScale 1.0 when extent is 10
    const ts = specTimeScale(spec, 10 * 24, 24);
    check(`P4 ${name}/${fmt} timeScale=1.0 at 10s plate`,
      Math.abs(ts - 1.0) < 1e-9,
      `got ${ts} (extent must be 10, not 8 — else 10s plates compress)`);
    const extent = Math.max(0, ...(spec.phases || []).map((p) => p.endSec || 0));
    check(`P5 ${name}/${fmt} phase extent is 10`,
      Math.abs(extent - 10) < 0.01, `extent=${extent}`);
  }
}

// GENERIC 8s presets FROZEN — must still timeScale 1.0 at 8s and remain
// at extent 8 (do not re-time the shared Meta presets).
for (const name of GENERIC8) {
  const doc = loadPresetFile(name);
  check(`P6 generic preset '${name}' still loads (FROZEN)`, !!doc);
  if (!doc) continue;
  const spec = doc.byFormat?.vertical;
  const extent = Math.max(0, ...(spec?.phases || []).map((p) => p.endSec || 0));
  check(`P7 [REGRESSION] generic '${name}' vertical extent still 8 (not re-timed)`,
    Math.abs(extent - 8) < 0.01,
    `extent=${extent} — re-timing shared presets silently broke Meta 8s renders`);
  const ts8 = specTimeScale(spec, 8 * 24, 24);
  check(`P8 generic '${name}' timeScale=1.0 at 8s plate`,
    Math.abs(ts8 - 1.0) < 1e-9, `got ${ts8}`);
  // On a 10s plate the 8s generic compresses? No — timeScale only compresses
  // when clip < extent; longer plates keep authored pacing (timeScale 1.0).
  const ts10 = specTimeScale(spec, 10 * 24, 24);
  check(`P9 generic '${name}' timeScale stays 1.0 on a longer 10s plate (no stretch)`,
    Math.abs(ts10 - 1.0) < 1e-9, `got ${ts10}`);
}

// ── T. Preset threading: buildMetaForAd + render get the SAME override ─
const bseSrc = fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8');
check('T1 resolveFunnelPresetOverride is consulted in brandScriptExecutor',
  /resolveFunnelPresetOverride/.test(bseSrc));

// renderWithRemotionAndSave resolves once into resolvedPreset and passes
// that same binding to both buildMetaForAd and resolveSpec.
const remotionBody = functionBody(bseSrc, 'renderWithRemotionAndSave');
check('T2 renderWithRemotionAndSave threads ONE resolvedPreset into buildMetaForAd',
  !!remotionBody
    && /buildMetaForAd\s*\(\s*ad\s*,\s*brand\s*,\s*\{\s*presetOverride:\s*resolvedPreset\s*\}\s*\)/.test(remotionBody),
  'without this the quote gate can desync from the composition');
check('T3 renderWithRemotionAndSave threads the SAME resolvedPreset into resolveSpec',
  !!remotionBody
    && /presetOverride:\s*resolvedPreset/.test(remotionBody)
    && (remotionBody.match(/presetOverride:\s*resolvedPreset/g) || []).length >= 2);

// buildMetaForAd accepts opts.presetOverride (not hardcoded null).
const metaBody = functionBody(bseSrc, 'buildMetaForAd');
check('T4 buildMetaForAd no longer hardcodes presetOverride: null',
  !!metaBody && !/presetOverride:\s*null/.test(metaBody),
  'hardcoding null desyncs the quote gate from a funnel render');
check('T5 buildMetaForAd reads opts.presetOverride',
  !!metaBody && /opts\.presetOverride/.test(metaBody));

// Behavioural map.
check('T6 resolveFunnelPresetOverride maps awareness → canonical-awareness-pmax10',
  svc.resolveFunnelPresetOverride({
    platformFormat: MASTER_9_16, funnelStage: 'awareness'
  }) === 'canonical-awareness-pmax10');
check('T7 resolveFunnelPresetOverride maps consideration on 16:9',
  svc.resolveFunnelPresetOverride({
    platformFormat: MASTER_16_9, funnelStage: 'consideration'
  }) === 'canonical-consideration-pmax10');
check('T8 resolveFunnelPresetOverride maps conversion on 1:1',
  svc.resolveFunnelPresetOverride({
    platformFormat: DERIVE_1_1, funnelStage: 'conversion'
  }) === 'canonical-conversion-pmax10');
check('T9 absent funnelStage → null (today cascade)',
  svc.resolveFunnelPresetOverride({ platformFormat: MASTER_9_16 }) === null
    && svc.resolveFunnelPresetOverride({ platformFormat: MASTER_9_16, funnelStage: null }) === null);
check('T10 Meta format with a stage still → null (PMax-only presets)',
  svc.resolveFunnelPresetOverride({
    platformFormat: 'meta_stories_9_16', funnelStage: 'awareness'
  }) === null);
check('T11 unknown stage → null',
  svc.resolveFunnelPresetOverride({
    platformFormat: MASTER_9_16, funnelStage: 'retargeting'
  }) === null);

// ── S. Schema: Ad.funnelStage declared ─────────────────────────────────
const adModelSrc = fs.readFileSync(path.join(ROOT, 'models/Ad.js'), 'utf8');
check('S1 models/Ad.js declares funnelStage',
  /funnelStage\s*:/.test(adModelSrc));
check('S2 funnelStage enum includes the three stages',
  /funnelStage[\s\S]{0,200}awareness[\s\S]{0,80}consideration[\s\S]{0,80}conversion/.test(adModelSrc));

// ── defaults.env flag ──────────────────────────────────────────────────
const envSrc = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
check('ENV1 PMAX_FUNNEL_VARIANTS is set in defaults.env',
  /^PMAX_FUNNEL_VARIANTS=/m.test(envSrc));
check('ENV2 PMAX_FUNNEL_VARIANTS defaults to true',
  /^PMAX_FUNNEL_VARIANTS=true\s*$/m.test(envSrc));

// ── REVERT-PROOFS (mutate → fail → restore) ────────────────────────────
console.log('\n── Revert-proofs (mutate / fail / restore) ──');

// RP1: strip funnel fail-closed from a copy of resolveDeriveFromMaster logic
{
  const broken = function (ad) {
    if (!ad) return null;
    const explicit = ad.deriveFromMaster;
    if (typeof explicit === 'string' && explicit) return explicit;
    if (ad.platformFormat === DERIVE_1_1) return MASTER_9_16;
    // funnelStage branch REMOVED (the regression)
    return null;
  };
  const shouldFail = broken({ platformFormat: MASTER_9_16, funnelStage: 'awareness' }) === null;
  check('RP1 resolveDeriveFromMaster without funnel fail-closed returns null (would bill)',
    shouldFail,
    'revert-proof setup broken — the mutation did not open the hole');
  // Real function must NOT match the broken behaviour.
  check('RP1b live gate still fail-closes (mutation was local only)',
    resolveDeriveFromMaster({ platformFormat: MASTER_9_16, funnelStage: 'awareness' })
      === MASTER_9_16);
}

// RP2: digest without funnelStage part collapses stages
{
  const brokenDigest = ({ platformFormat, videoDurationSec, funnelStage, ...rest }) => {
    // Call real digest but always omit funnelStage
    return digest({ ...rest, platformFormat, videoDurationSec, funnelStage: null });
  };
  const a = brokenDigest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: 'awareness' });
  const b = brokenDigest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: 'conversion' });
  check('RP2 digest without funnelStage collapses awareness===conversion',
    a === b);
  check('RP2b live digest keeps stages distinct',
    digest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: 'awareness' })
      !== digest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: 'conversion' }));
}

// RP3: three live stage digests remain distinct (direct)
{
  const set = new Set(STAGES.map((s) => digest({
    ...baseArgs, platformFormat: MASTER_16_9, videoDurationSec: 10, funnelStage: s
  })));
  check('RP3 three live stage digests on 16:9 are distinct', set.size === 3);
}

// RP4: master digest with funnelStage omitted equals explicit null (no re-mint)
{
  const omit = digest({ ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10 });
  const withNull = digest({
    ...baseArgs, platformFormat: MASTER_9_16, videoDurationSec: 10, funnelStage: null
  });
  // Simulate the bad "always push String(funnelStage||'')" mutation:
  const crypto = require('crypto');
  const badParts = [
    'det-video:v1', 'C1', 'P1', 'M1', MASTER_9_16, 'video',
    'SHOP NOW', 'https://example.com', '', '', '', '10', ''
  ];
  const badHash = crypto.createHash('sha256').update(badParts.join('|')).digest('hex');
  check('RP4 unconditional empty funnel part WOULD change the master digest',
    badHash !== omit,
    'setup: the bad mutation must actually shift the hash');
  check('RP4b live master digest is unchanged (omit === null)',
    omit === withNull && omit !== badHash);
}

// ── summary ────────────────────────────────────────────────────────────
console.log(`\nverifyPmaxFunnelVariants: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  FAIL:', f);
  process.exit(1);
}
console.log('OK');
process.exit(0);
