#!/usr/bin/env node
/**
 * PORTED from liquidretail_backend/scripts/verifySharedPortraitMaster.js
 * (pre-2026-08-24 snapshot) into liquidretail_adgen.
 *
 * PORTING NOTE — same structural adaptation as verifyPmaxVideoExpansion.js
 * (read that file's porting note for the full explanation). Groups A-G, J
 * test PURE, EXPORTED functions of services/campaignAdsGenerationService.js,
 * services/platformFormats.js and services/veoPromptBuilder.js directly —
 * those three modules are vendored byte-identical to the backend originals
 * (verified 2026-08-24) — so those groups port with require-path fixes only.
 *
 * Group H reaches into routes/ads.js, which does not exist in adgen.
 * `renderDeriveOnlyVideoAd` is adgen's `if (deriveFromFmt) { … return; }`
 * branch inside services/renderer.js's `renderVideo(ad)`; `findSiblingMasterAd`
 * exists in adgen under the SAME name, as its own standalone function in the
 * same file (confirmed 2026-08-24) — so H's structural checks on that
 * function port with a path fix, and its checks on the derive branch reuse
 * the same extractor verifyPmaxVideoExpansion.js already built for that
 * branch.
 *
 * Group I (regenerate stays safe) reaches into services/adRegenerateService.js,
 * which exists in adgen at the same import + call shape — ports with a path
 * fix only.
 *
 * No assertion this file DOES run had its expected value changed — only
 * WHICH FILE a source-level check reads, exactly as in
 * verifyPmaxVideoExpansion.js.
 *
 * ── ORIGINAL HEADER (backend) ──────────────────────────────────────────────
 * verifySharedPortraitMaster.js — the SHARED 9:16 master (owner directive
 * 2026-08-18: "use the PMax prompt for Meta also, and standardize on that
 * but maintain a single minting for 9x16 across both formats. Continue to
 * mint a 16x9.").
 *
 * WHAT THIS PROTECTS. A mixed Meta+PMax run used to pay for THREE Omni
 * masters per product — meta_stories_9_16, pmax_video_9_16, pmax_video_16_9
 * — at a measured $0.90 each ($2.70). Two of those are the same 9:16 plate
 * at byte-identical delivery dims. When conjunct 4 (the hook-first camera
 * switch) is ON, ONE portrait plate is minted and the PMax portrait family
 * derives from it for free, so a mixed run pays $1.80 instead.
 *
 * Offline: no DB, no network, no API key.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc  = require(path.join(ROOT, 'src/services/campaignAdsGenerationService'));
const pf   = require(path.join(ROOT, 'src/services/platformFormats'));

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(detail ? `${label} — ${detail}` : label);
}

const META_MASTER = 'meta_stories_9_16';
const PMAX_9      = 'pmax_video_9_16';
const PMAX_16     = 'pmax_video_16_9';
const PMAX_1_1    = 'pmax_video_1_1';

const MIXED = [META_MASTER, PMAX_9, PMAX_16];
const PMAX_ONLY = [PMAX_9, PMAX_16];
const META_ONLY = [META_MASTER];

// ── env scaffolding ────────────────────────────────────────────────────
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
// STUBBED for the same reason the backend original stubs it: pin the two
// contracts this file depends on in both positions regardless of what build
// of veoPromptBuilder.js is on disk. F2/F5 below exercise the REAL module.
const PROMPT_MODULE = require.resolve(path.join(ROOT, 'src/services/veoPromptBuilder.js'));
function withPromptModule(stubExports, fn) {
  const had = Object.prototype.hasOwnProperty.call(require.cache, PROMPT_MODULE);
  const prev = require.cache[PROMPT_MODULE];
  require.cache[PROMPT_MODULE] = {
    id: PROMPT_MODULE, filename: PROMPT_MODULE, loaded: true, exports: stubExports
  };
  try { return fn(); }
  finally {
    if (had) require.cache[PROMPT_MODULE] = prev;
    else delete require.cache[PROMPT_MODULE];
  }
}
const HOOK_ON = {
  isHookFirstVideoPromptEnabled: () => true,
  promptProfileFor: () => 'hook_first',
  directivesForProfile: (p) => ({ profile: p })
};
const HOOK_OFF_PROFILES_EQUAL = {
  isHookFirstVideoPromptEnabled: () => false,
  promptProfileFor: () => 'gemini-omni',
  directivesForProfile: (p) => ({ profile: p })
};
const HOOK_ON_PROFILES_DIFFER = {
  isHookFirstVideoPromptEnabled: () => true,
  promptProfileFor: (caps, o) => (String(o && o.platformFormat).startsWith('pmax_')
    ? 'hook_first' : 'gemini-omni'),
  directivesForProfile: (p) => ({ profile: p })
};

const PROD_ENV = { PMAX_FUNNEL_VARIANTS: 'true', META_VIDEO_DERIVATIVES: 'true',
  UNIFIED_VIDEO_9_16_MASTER: 'true', META_VIDEO_DURATION_SEC: undefined,
  VIDEO_HOOK_FIRST_PROMPT: undefined, PMAX_VIDEO_DIRECTIVES: undefined };

const shared = (fn) => withPromptModule(HOOK_ON, () => withEnv(PROD_ENV, fn));
const unshared = (fn) =>
  withPromptModule(HOOK_OFF_PROFILES_EQUAL, () => withEnv(PROD_ENV, fn));

const plan  = (masters) => svc.planDeterministicVideoAds(masters);
const bill  = (p) => p.filter((r) => r.billable);
const rowsOf = (p, fmt) => p.filter((r) => r.platformFormat === fmt);
const unstaged = (p, fmt) => p.find((r) => r.platformFormat === fmt && !r.funnelStage);

// ── A. The decision function exists and is the ONLY decider ────────────
check('A1 resolvePortraitMasterFormat is exported',
  typeof svc.resolvePortraitMasterFormat === 'function');
check('A2 isSharedPortraitPlatePromptCoherent is exported',
  typeof svc.isSharedPortraitPlatePromptCoherent === 'function');
check('A3 isUnifiedNineSixteenMasterEnabled is exported',
  typeof svc.isUnifiedNineSixteenMasterEnabled === 'function');

const svcSrc = fs.readFileSync(
  path.join(ROOT, 'src/services/campaignAdsGenerationService.js'), 'utf8');
const decisionCalls = (svcSrc.match(/resolvePortraitMasterFormat\s*\(/g) || []).length;
check('A4 [MONEY] resolvePortraitMasterFormat is DEFINED once and CALLED once',
  decisionCalls === 2,
  `found ${decisionCalls} occurrences of "resolvePortraitMasterFormat(" `
  + '(want exactly 2: the function declaration and one call in '
  + 'planDeterministicVideoAds). A second caller can re-decide and drift.');

// ── B. [MONEY, THE BIG ONE] FAIL CLOSED on a PMax-only run ─────────────
{
  const p = shared(() => plan(PMAX_ONLY));
  const m9 = unstaged(p, PMAX_9);
  check('B1 [MONEY] PMax-only run: pmax_video_9_16 is BILLABLE',
    !!m9 && m9.billable === true && m9.deriveFromMaster == null,
    JSON.stringify(m9));
  check('B2 [MONEY] PMax-only run bills exactly 2 masters (9:16 + 16:9)',
    bill(p).length === 2,
    JSON.stringify(bill(p).map((r) => r.platformFormat)));
  check('B2a PMax-only ad count is unchanged at 9', p.length === 9, `got ${p.length}`);
  check('B3 [MONEY] resolvePortraitMasterFormat refuses to share without the PMax master',
    shared(() => svc.resolvePortraitMasterFormat(META_ONLY)) === PMAX_9,
    'a Meta-only run must not claim to be sharing a portrait plate — the '
    + 'isGoogleVideoMasterRun conjunct is what stops it');
  check('B3a and refuses to share without the Meta master',
    shared(() => svc.resolvePortraitMasterFormat(PMAX_ONLY)) === PMAX_9);
  check('B3b and refuses on an empty / garbage master list',
    shared(() => svc.resolvePortraitMasterFormat([])) === PMAX_9
      && shared(() => svc.resolvePortraitMasterFormat(null)) === PMAX_9
      && shared(() => svc.resolvePortraitMasterFormat(['nonsense'])) === PMAX_9);
  check('B4 [MONEY] the decision reads ONLY this run\'s master list',
    shared(() => svc.resolvePortraitMasterFormat([PMAX_9])) === PMAX_9,
    'a PMax-only list resolved to the Meta master — that is cross-run plate theft');
}

// ── C. Mixed run: 2 billable, 21 ads, correct stamps ───────────────────
{
  const p = shared(() => plan(MIXED));
  check('C1 [MONEY] mixed run bills exactly 2 masters', bill(p).length === 2,
    JSON.stringify(bill(p).map((r) => `${r.platformFormat}:${r.funnelStage || 'base'}`)));
  check('C1a the two billable are the Meta portrait plate + the PMax 16:9',
    bill(p).length === 2
      && bill(p).some((r) => r.platformFormat === META_MASTER && !r.funnelStage)
      && bill(p).some((r) => r.platformFormat === PMAX_16 && !r.funnelStage));
  check('C1b [MONEY] TOTAL AD COUNT IS UNCHANGED at 21', p.length === 21,
    `got ${p.length} — the operator must lose no creative for the saving`);
  const m9 = unstaged(p, PMAX_9);
  check('C2 [MONEY] mixed run: pmax_video_9_16 derives from meta_stories_9_16',
    !!m9 && m9.billable === false && m9.deriveFromMaster === META_MASTER,
    JSON.stringify(m9));
  check('C2a pmax_video_9_16 KEEPS its own platformFormat (digest untouched)',
    !!m9 && m9.platformFormat === PMAX_9,
    'rewriting the format would re-key the identity digest and re-bill the corpus');
  check('C2b the 16:9 master stays BILLABLE in the mixed run',
    (unstaged(p, PMAX_16) || {}).billable === true,
    'owner directive: continue to mint a 16x9 — nothing can derive it from portrait');
  check('C2c every surface still has 3 rows (unstaged + 2 stages)',
    [META_MASTER, PMAX_9, PMAX_16, PMAX_1_1, 'meta_reels_9_16',
      'meta_feed_1_1', 'meta_feed_4_5']
      .every((f) => rowsOf(p, f).length === 3),
    JSON.stringify([META_MASTER, PMAX_9, PMAX_16, PMAX_1_1]
      .map((f) => `${f}=${rowsOf(p, f).length}`)));

  check('C3 [MONEY] resolveDeriveFromMaster has NO format-only branch for pmax_video_9_16',
    svc.resolveDeriveFromMaster({ platformFormat: PMAX_9 }) === null,
    'an unmarked pmax_video_9_16 must stay billable — a format-only branch '
    + 'produces ZERO 9:16 video on every PMax-only run');
  check('C3a but it DOES honour the explicit stamp the planner wrote',
    svc.resolveDeriveFromMaster({
      platformFormat: PMAX_9, deriveFromMaster: META_MASTER
    }) === META_MASTER);
  check('C3b the 1:1 stays fail-closed on format alone (unchanged)',
    svc.resolveDeriveFromMaster({ platformFormat: PMAX_1_1 }) === PMAX_9);
  check('C3c funnelDeriveSource(pmax_video_9_16) still returns itself',
    svc.funnelDeriveSource(PMAX_9) === PMAX_9,
    'the pure per-row helper cannot know the run; changing it would make an '
    + 'unmarked staged row point at a plate that may not exist');
}

// ── D. The WHOLE PMax portrait family is retargeted ────────────────────
{
  const p = shared(() => plan(MIXED));
  const trueMasters = new Set(p.filter((r) => !r.deriveFromMaster)
    .map((r) => r.platformFormat));
  check('D1 the plan\'s true masters are exactly the two billable rows',
    trueMasters.size === 2 && trueMasters.has(META_MASTER) && trueMasters.has(PMAX_16),
    JSON.stringify([...trueMasters]));
  const orphans = p.filter((r) => r.deriveFromMaster
    && !trueMasters.has(r.deriveFromMaster));
  check('D2 [MONEY/DELIVERY] no row derives from a non-master ("derivative of a derivative")',
    orphans.length === 0,
    JSON.stringify(orphans.map((r) => `${r.platformFormat}:${r.funnelStage || 'base'}<-${r.deriveFromMaster}`)));
  check('D2a specifically: pmax_video_1_1 rows point at the shared portrait plate',
    rowsOf(p, PMAX_1_1).every((r) => r.deriveFromMaster === META_MASTER),
    JSON.stringify(rowsOf(p, PMAX_1_1).map((r) => r.deriveFromMaster)));
  check('D2b specifically: staged pmax_video_9_16 rows point at the shared plate',
    rowsOf(p, PMAX_9).filter((r) => r.funnelStage)
      .every((r) => r.deriveFromMaster === META_MASTER),
    JSON.stringify(rowsOf(p, PMAX_9).map((r) => r.deriveFromMaster)));
  check('D2c the 16:9 family still retitles ITSELF (not the portrait plate)',
    rowsOf(p, PMAX_16).filter((r) => r.funnelStage)
      .every((r) => r.deriveFromMaster === PMAX_16),
    'a 16:9 retitle off a portrait plate would be a crop-up');
  check('D3 [MONEY] exactly one row in the whole mixed plan is an unstaged Meta master',
    p.filter((r) => r.platformFormat === META_MASTER && !r.funnelStage).length === 1,
    'two portrait masters would be the double-mint this change exists to remove');

  const q = unshared(() => plan(MIXED));
  const qMasters = new Set(q.filter((r) => !r.deriveFromMaster).map((r) => r.platformFormat));
  check('D4 unshared mixed run: no orphan derives either',
    q.filter((r) => r.deriveFromMaster && !qMasters.has(r.deriveFromMaster)).length === 0);
  check('D4a unshared mixed run: the 1:1 rides PMax\'s own 9:16',
    rowsOf(q, PMAX_1_1).every((r) => r.deriveFromMaster === PMAX_9));
}

// ── E. [SOUNDNESS] the shared plate clears Google's 10s floor ──────────
{
  const dur = (row) => svc.resolveVideoDurationForFormat(row.platformFormat, 8);

  const p = shared(() => plan(MIXED));
  check('E1 [SOUNDNESS] shared portrait master is minted at >= 10s',
    dur(unstaged(p, META_MASTER)) >= 10,
    'an 8s plate is a PAID asset Google will not accept on the derived '
    + 'pmax_video_9_16 surface');
  check('E1a every row riding the shared plate reports the plate\'s duration',
    p.filter((r) => (r.deriveFromMaster || r.platformFormat) === META_MASTER)
      .every((r) => dur(r) >= 10));
  check('E2 the derived pmax_video_9_16 still resolves to 10s (digest unchanged)',
    dur(unstaged(p, PMAX_9)) === 10);
  check('E2a the floor is UNIVERSAL — a Meta-only run is 10s too',
    dur(unstaged(shared(() => plan(META_ONLY)), META_MASTER)) === 10,
    'owner: "make meta videos 10 sec also" — not just on shared runs');
  check('E2b the wizard\'s posted 8 is lifted on every Meta video format',
    ['meta_stories_9_16', 'meta_reels_9_16', 'meta_feed_1_1', 'meta_feed_4_5']
      .every((f) => svc.resolveVideoDurationForFormat(f, 8) === 10));
  check('E2c a value ABOVE the floor still wins (it lifts, it does not cap)',
    svc.resolveVideoDurationForFormat(META_MASTER, 12) === 12);

  const floorOff = { META_VIDEO_DURATION_SEC: '0',
    PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'true' };
  const withFloorOff = (fn) => withPromptModule(HOOK_ON, () => withEnv(floorOff, fn));
  check('E3 [MONEY/SOUNDNESS] Meta floor OFF ⇒ sharing refuses (bills 3, ships nothing broken)',
    withFloorOff(() => svc.resolvePortraitMasterFormat(MIXED)) === PMAX_9,
    'with no Meta floor a shared plate is an 8s PAID render Google rejects — '
    + 'the gate must fall back to PMax minting its own portrait master');
  check('E3a and that arm really does bill 3 again',
    withFloorOff(() => bill(plan(MIXED)).length) === 3);
  check('E3a2 [PREMISE] and every OTHER conjunct is satisfied in that arm',
    withPromptModule(HOOK_ON, () => withEnv(
      { PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'true' },
      () => svc.resolvePortraitMasterFormat(MIXED))) === META_MASTER,
    'if this fails, E3/E3a are passing for the wrong reason — something other '
    + 'than the Meta floor is already blocking the share');
  check('E3b the Meta floor is still revertible with no deploy',
    withEnv({ META_VIDEO_DURATION_SEC: '0' },
      () => svc.resolveVideoDurationForFormat(META_MASTER, 8)) === 8);
  check('E3c reverting the Meta floor never touches PMax',
    withEnv({ META_VIDEO_DURATION_SEC: '0' },
      () => svc.resolveVideoDurationForFormat(PMAX_9, 8)) === 10);

  check('E4 no mixed-run-only duration branch survives in the planner',
    !/durationFormat/.test(svcSrc),
    'the universal floor replaced it; two duration rules would drift');
}

// ── F. [MONEY] every conjunct of the gate fails closed ─────────────────
{
  check('F1 [MONEY] camera standardization OFF ⇒ NO sharing (2 bills become 3)',
    unshared(() => bill(plan(MIXED)).length) === 3,
    'sharing a plate that was not shot with the standardized camera delivers '
    + 'Meta\'s pan to YouTube Shorts');
  check('F1a and the coherence probe reports it honestly',
    unshared(() => svc.isSharedPortraitPlatePromptCoherent()) === false
      && shared(() => svc.isSharedPortraitPlatePromptCoherent()) === true);
  check('F2 the gate is a real probe of veoPromptBuilder, not a constant',
    /require\(['"]\.\/veoPromptBuilder['"]\)/.test(svcSrc)
      && /isHookFirstVideoPromptEnabled/.test(svcSrc),
    'a hard-coded true here removes the only protection against a plate '
    + 'that was shot for the wrong destination');

  check('F6 [MONEY] switch OFF but profiles EQUAL ⇒ still refuses to share',
    withPromptModule(HOOK_OFF_PROFILES_EQUAL, () => withEnv(PROD_ENV, () => {
      const profilesAgree =
        HOOK_OFF_PROFILES_EQUAL.promptProfileFor(null, { platformFormat: META_MASTER })
        === HOOK_OFF_PROFILES_EQUAL.promptProfileFor(null, { platformFormat: PMAX_9 });
      return profilesAgree
        && svc.isSharedPortraitPlatePromptCoherent() === false
        && svc.resolvePortraitMasterFormat(MIXED) === PMAX_9
        && bill(plan(MIXED)).length === 3;
    })),
    'equality-only gating is vacuous — it is TRUE in both switch states, so '
    + 'it gates nothing at all once the prompt lane lands');
  check('F6a the load-bearing conjunct is the SWITCH, not profile equality',
    /isHookFirstVideoPromptEnabled\(\) !== true/.test(svcSrc),
    'the gate must ask "did both get the standardized camera?", not merely '
    + '"do both agree?"');
  check('F6b a missing switch export fails CLOSED (bills rather than shares)',
    withPromptModule(
      { promptProfileFor: () => 'hook_first', directivesForProfile: () => ({}) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())
    ) === false,
    'an older veoPromptBuilder without the export must not unlock free 9:16');
  check('F6c a throwing switch fails CLOSED',
    withPromptModule(
      { isHookFirstVideoPromptEnabled: () => { throw new Error('boom'); },
        promptProfileFor: () => 'hook_first', directivesForProfile: () => ({}) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())
    ) === false);
  check('F6d switch ON but a destination escaped it ⇒ still refuses (belt-and-braces)',
    withPromptModule(HOOK_ON_PROFILES_DIFFER,
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false,
    'the equality comparison is retained as a SECOND conjunct and must still bite');
  const svcCode = svcSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('F6e the two switch env names are NOT re-implemented here',
    !/process\.env\.VIDEO_HOOK_FIRST_PROMPT/.test(svcCode)
      && !/process\.env\.PMAX_VIDEO_DIRECTIVES/.test(svcCode)
      && !/process\.env\[/.test(svcCode),
    'duplicating the switch parsing is exactly the drift this file argues '
    + 'against — the legacy-alias fail-safe OR must have exactly one owner');
  check('F5 the gate survives the REAL veoPromptBuilder on disk',
    typeof svc.isSharedPortraitPlatePromptCoherent() === 'boolean');
  const killed = (fn) => withPromptModule(HOOK_ON, () => withEnv(
    { PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'false' }, fn));
  check('F3 [MONEY] UNIFIED_VIDEO_9_16_MASTER=false restores 3 billable masters',
    killed(() => bill(plan(MIXED)).length) === 3);
  check('F3a and flag-off is byte-identical to the unshared plan',
    JSON.stringify(killed(() => plan(MIXED)))
      === JSON.stringify(unshared(() => plan(MIXED))));
  check('F3b [PREMISE] the kill switch is genuinely what refuses in F3',
    withPromptModule(HOOK_ON, () => withEnv(
      { PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'true' },
      () => svc.resolvePortraitMasterFormat(MIXED))) === META_MASTER,
    'with the switch back on the same config must SHARE, or F3 proves nothing');
  check('F4 [MONEY] the coherence probe is wrapped so a throw means DO NOT SHARE',
    /catch\s*\([\s\S]{0,40}\)\s*\{\s*return false;/.test(svcSrc),
    'an exception must not be able to unlock free 9:16');
}

// ── G. Untouched neighbours ────────────────────────────────────────────
{
  const metaPlan = shared(() => plan(META_ONLY));
  check('G1 Meta-only run is completely unchanged (12 ads / 1 billable)',
    metaPlan.length === 12 && bill(metaPlan).length === 1,
    `got ${metaPlan.length} ads / ${bill(metaPlan).length} billable`);
  check('G2 [MONEY] computeDeterministicVideoDigest is NOT touched by this change',
    !/isGooglePmaxVideoFormat\(platformFormat\)\s*\|\|/.test(svcSrc)
      && /parts\.push\(videoDurationSec == null/.test(svcSrc),
    'the (campaignId, identityDigest) index is the only guard against a '
    + 'repeat Generate re-billing Omni');
  const digestArgs = {
    campaignId: 'C1', productId: 'P1', referenceMediaIds: [], mediaId: 'M1',
    ctaText: 'SHOP NOW', ctaUrl: 'https://e.com', ctaUrlParams: '',
    videoPromptGuidance: null, videoPromptRaw: null
  };
  const metaAt8  = svc.computeDeterministicVideoDigest({
    ...digestArgs, platformFormat: META_MASTER, videoDurationSec: 8 });
  const metaAt10 = svc.computeDeterministicVideoDigest({
    ...digestArgs, platformFormat: META_MASTER, videoDurationSec: 10 });
  check('G3 [MONEY] lifting the Meta master 8s→10s does NOT change its digest',
    metaAt8 === metaAt10,
    'if this ever fails, the shared-plate duration lift re-keys every stored '
    + 'Meta video ad and the next Generate re-bills the whole corpus');
  const pmaxAt10 = svc.computeDeterministicVideoDigest({
    ...digestArgs, platformFormat: PMAX_9, videoDurationSec: 10 });
  const pmaxAt8  = svc.computeDeterministicVideoDigest({
    ...digestArgs, platformFormat: PMAX_9, videoDurationSec: 8 });
  check('G3a and duration IS still identity for the Google formats',
    pmaxAt10 !== pmaxAt8);
  check('G4 pmax_video_9_16 is still listed as a Google master',
    pf.GOOGLE_VIDEO_MASTERS.includes(PMAX_9),
    'removing it from the list stops isGoogleVideoMasterRun firing, which '
    + 'silently stops pmax_video_1_1 being minted at all');
  check('G4a resolvePreset(google_video) still returns both surfaces',
    (pf.resolvePreset('google_video').videoFormats || []).length === 2);
}

// ── H. [MONEY] the derive render path still cannot submit ──────────────
// ADAPTED (see PORTING NOTE): reads services/renderer.js instead of
// routes/ads.js. renderDeriveOnlyVideoAd -> the `if (deriveFromFmt)` branch
// inside renderVideo(); findSiblingMasterAd exists under the same name.
{
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');

  function extractDeriveBranch(src) {
    const anchor = src.indexOf('const deriveFromFmt = resolveDeriveFromMaster(ad);');
    if (anchor === -1) return null;
    const ifIdx = src.indexOf('if (deriveFromFmt)', anchor);
    if (ifIdx === -1) return null;
    const open = src.indexOf('{', ifIdx);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  }

  const body = extractDeriveBranch(rendererSrc);
  check('H0 the derive branch inside renderVideo() extracted (not a stub)',
    !!body && body.length > 1500 && /findSiblingMasterAd\s*\(/.test(body),
    `extracted ${body ? body.length : 0} chars`);
  if (body) {
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const SUBMIT_TOKENS_H = [
      /atlasVideo\.generateForAd\s*\(/, /veoPrepareStoryboard\s*\(/,
      /atlasVideoService/, /generateForAd\s*\(/
    ];
    check('H1 [MONEY] ZERO billable submits reachable for a derive row',
      SUBMIT_TOKENS_H.every((t) => !t.test(code)),
      'the shared 9:16 makes FIVE more rows per mixed run take this path; a '
      + 'submit here is now a 5x hidden charge, not 1x');
    check('H1a comment-stripping left real code to assert against',
      /findSiblingMasterAd\s*\(/.test(code) && code.length > 1200);
  }
  // findSiblingMasterAd exists as its own named function in adgen (unlike
  // backend, where it is also defined in routes/ads.js) — extract it the
  // same way.
  const sibStart = rendererSrc.indexOf('async function findSiblingMasterAd');
  let sibBody = null;
  if (sibStart !== -1) {
    const open = rendererSrc.indexOf('{', rendererSrc.indexOf(')', sibStart));
    let depth = 0;
    for (let i = open; i < rendererSrc.length; i++) {
      if (rendererSrc[i] === '{') depth++;
      else if (rendererSrc[i] === '}') { depth--; if (depth === 0) { sibBody = rendererSrc.slice(open, i + 1); break; } }
    }
  }
  check('H1b findSiblingMasterAd body extracted (not the param list)',
    !!sibBody && /platformFormat/.test(sibBody),
    `extracted ${sibBody ? sibBody.length : 0} chars`);
  check('H2 [MONEY] findSiblingMasterAd itself excludes derives and funnel rows',
    !!sibBody
      && /deriveFromMaster:\s*null/.test(sibBody)
      && /funnelStage:\s*null/.test(sibBody),
    'a master lookup that can return a derive or a funnel retitle hands the '
    + 'waiter a row that holds no plate of its own');
  // ADAPTED bound: adgen's findSiblingMasterAd takes masterPlatformFormat as
  // its parameter name (backend's was also platformFormat-bound, but reused
  // the base filter object across two queries) — the money invariant is the
  // same: exactly ONE binding of the requested format inside the base filter
  // object, so a stale/cross-format fallback cannot creep in.
  const baseFilterBody = (() => {
    if (!sibBody) return '';
    const i = sibBody.indexOf('const base = {');
    if (i === -1) return '';
    const open = sibBody.indexOf('{', i);
    let depth = 0;
    for (let k = open; k < sibBody.length; k++) {
      if (sibBody[k] === '{') depth++;
      else if (sibBody[k] === '}') { depth--; if (depth === 0) return sibBody.slice(open, k + 1); }
    }
    return '';
  })();
  check('H3 [MONEY] the base filter binds platformFormat EXACTLY ONCE',
    !!baseFilterBody && (baseFilterBody.match(/platformFormat/g) || []).length === 1,
    'a second platformFormat binding means a cross-format / fallback lookup, '
    + `found ${baseFilterBody ? (baseFilterBody.match(/platformFormat/g) || []).length : 'no body'}`);
  check('H3a and it still takes the wanted format as its parameter',
    !!sibBody && /platformFormat:\s*masterPlatformFormat/.test(sibBody));
  check('H4 the render loop reads the STAMP, not a re-derived condition',
    /const deriveFromFmt = resolveDeriveFromMaster\(ad\)/.test(rendererSrc)
      && !/resolvePortraitMasterFormat/.test(rendererSrc),
    'the renderer must never re-decide sharing; it reads what the mint wrote');
}

// ── I. Regenerate stays safe and names the right master ────────────────
{
  const regenSrc = fs.readFileSync(
    path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8');
  check('I1 [MONEY] regenerate preflight still uses the SHARED gate',
    /const \{[^}]*resolveDeriveFromMaster[^}]*\} = require\('\.\/campaignAdsGenerationService'\)/
      .test(regenSrc)
      && /resolveDeriveFromMaster\(ad\)/.test(regenSrc));
  check('I2 [MONEY] a shared-plate PMax 9:16 is refused by preflight',
    svc.resolveDeriveFromMaster({
      platformFormat: PMAX_9, deriveFromMaster: META_MASTER
    }) === META_MASTER,
    'without the 409 this row calls veoService.generateForAd and bills a '
    + 'full Omni on a now-free surface');
  check('I3 the 409 names the ACTUAL master rather than "its 9:16 master"',
    /\$\{derivedFrom\}/.test(regenSrc),
    'sending the operator to the wrong row costs a third Omni charge');
  check('I4 an unmarked pmax_video_9_16 is still regenerable (it paid)',
    svc.resolveDeriveFromMaster({ platformFormat: PMAX_9 }) === null);
}

// ── J. [SHAPE] delivered dimensions per surface ────────────────────────
{
  const EXPECTED = {
    meta_stories_9_16: [1080, 1920],
    meta_reels_9_16:   [1080, 1920],
    meta_feed_1_1:     [1080, 1080],
    meta_feed_4_5:     [1080, 1350],
    pmax_video_9_16:   [1080, 1920],
    pmax_video_16_9:   [1920, 1080],
    pmax_video_1_1:    [1080, 1080]
  };
  for (const [k, [w, h]] of Object.entries(EXPECTED)) {
    const d = pf.PLATFORM_FORMATS[k] && pf.PLATFORM_FORMATS[k].deliveryDims;
    check(`J1 ${k} delivers exactly ${w}x${h}`,
      !!d && d.width === w && d.height === h,
      d ? `${d.width}x${d.height}` : 'format missing');
  }

  const a = pf.PLATFORM_FORMATS[META_MASTER].deliveryDims;
  const b = pf.PLATFORM_FORMATS[PMAX_9].deliveryDims;
  check('J2 [PREMISE] the two portrait masters deliver IDENTICAL dimensions',
    a.width === b.width && a.height === b.height,
    `meta=${a.width}x${a.height} pmax=${b.width}x${b.height} — one plate can `
    + 'only serve both surfaces while these match');
  check('J2a and their aspectRatio strings agree',
    pf.PLATFORM_FORMATS[META_MASTER].aspectRatio
      === pf.PLATFORM_FORMATS[PMAX_9].aspectRatio);

  const sa = pf.PLATFORM_FORMATS[META_MASTER].safeArea;
  const sb = pf.PLATFORM_FORMATS[PMAX_9].safeArea;
  check('J3 [PREMISE] but their SAFE AREAS differ (titling is not shared)',
    sa.top !== sb.top || sa.bottom !== sb.bottom,
    `meta=${JSON.stringify(sa)} pmax=${JSON.stringify(sb)} — the plate is `
    + 'shared, the burned-in titling is not');

  const p = shared(() => plan(MIXED));
  const master = pf.PLATFORM_FORMATS[META_MASTER].deliveryDims;
  const cropUps = p.filter((r) => {
    if (r.deriveFromMaster !== META_MASTER) return false;
    const d = pf.PLATFORM_FORMATS[r.platformFormat].deliveryDims;
    return d.width > master.width || d.height > master.height;
  });
  check('J4 [SHAPE] no row derives a frame LARGER than the shared plate',
    cropUps.length === 0,
    JSON.stringify(cropUps.map((r) => r.platformFormat)));
  check('J4a and that is precisely why the 16:9 must stay billable',
    pf.PLATFORM_FORMATS[PMAX_16].deliveryDims.width > master.width,
    '1920 wide cannot be cropped out of a 1080-wide portrait plate');
}

// ── report ─────────────────────────────────────────────────────────────
const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifySharedPortraitMaster: ${failures.length}/${total} FAILED\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifySharedPortraitMaster: ${passed}/${total} checks passed`);
console.log('   mixed run = 21 ads / 2 billable when hook-first is ON ($1.80); ' +
  '3 billable when OFF ($2.70)');
console.log('   PMax-only = 9 ads / 2 billable (fail-closed, unchanged)');
console.log('   Meta-only = 12 ads / 1 billable (unchanged)');
