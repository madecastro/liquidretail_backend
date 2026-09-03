#!/usr/bin/env node
/**
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
 * ⚠️ CONJUNCT 4 UPDATE, 2026-08-26 — conjunct 4 is now CAMERA EQUALITY, not
 * the hook-first env switch. History: the owner reverted the 2026-08-18
 * hook-first standardization on 2026-08-20 (`config/defaults.env` ships
 * VIDEO_HOOK_FIRST_PROMPT=false / PMAX_VIDEO_DIRECTIVES=false), which made
 * the old switch-based conjunct fail closed on every mixed run — THREE
 * billable masters / $2.70 instead of two / $1.80. That protection was
 * VACUOUS: the frozen (non-hook-first) timeline is destination-blind
 * (services/veoPromptBuilder.js:938-944 emits the same left→right pan for
 * Meta 9:16, PMax 9:16 AND PMax 16:9), so PMax 9:16 ALREADY received Meta's
 * pan with sharing off. The switch never prevented the framing it was
 * written to prevent; it only prevented the two surfaces from sharing one
 * render OF that framing, at +$0.90/product/mixed run.
 * Owner 2026-08-26, verbatim: "Decouple them but leave them sharing a plate
 * and prompt for now... right now they should share the plate and do a
 * single generation." So: the env defaults stay FALSE (do not flip them),
 * and sharing is gated on the two destinations actually resolving to the
 * same camera. On the shipped config that is TRUE, so a mixed run bills 2.
 * It self-disables (bills 3) the moment the two cameras genuinely diverge —
 * F1/F6 pin both arms.
 *
 * THE FOUR WAYS THIS CHANGE CAN COST MONEY OR BREAK DELIVERY, each pinned:
 *   1. UNDER-DELIVER — pmax_video_9_16 goes free on a PMax-ONLY run, where
 *      no Meta plate exists. The derive waits for a master that is never
 *      generated, fails, and the run ships NO 9:16 video at all. This is
 *      the single most important group here (B).
 *   2. HANG — the 1:1 crop and the staged 9:16 retitles keep pointing at
 *      pmax_video_9_16 after it became a derive. findSiblingMasterAd
 *      matches TRUE masters only, so they find nothing: a derivative of a
 *      derivative (group D).
 *   3. INVALID ASSET — the shared plate is minted at 8s. Google REJECTS
 *      PMax video under 10s, so the free 9:16 is a paid-for asset that
 *      cannot be used. Nothing offline can see this; only this harness can
 *      (group E).
 *   4. WRONG CAMERA — the plate is shared while it was NOT shot with the
 *      standardized hook-first camera, delivering Meta's pan to YouTube
 *      Shorts (group F). Note the subtle form: with the standardization
 *      switched off both destinations fall back to the SAME frozen profile,
 *      so "the profiles match" is TRUE in both switch states and is not a
 *      usable predicate. F6 pins that exact trap.
 *
 * REVERT-PROOF (each mutation individually, all against the real exports):
 *   1. Make resolvePortraitMasterFormat return META unconditionally  → B1/B2
 *   2. Drop the isGoogleVideoMasterRun conjunct                      → B3
 *   3. Drop the prompt-coherence conjunct                            → F1
 *   4. Drop the kill-switch conjunct                                 → F3
 *   5. Leave the 1:1 / staged rows pointing at PMAX_VIDEO_DERIVE_SOURCE → D2
 *   6. Remove the universal Meta 10s floor                           → E1/E2
 *   7. Drop the Meta-floor coupling conjunct                          → E3
 *   8. Add a platformFormat==='pmax_video_9_16' branch to
 *      resolveDeriveFromMaster                                       → C3
 *   9. Gate coherence on profile EQUALITY instead of the hook-first
 *      switch (vacuous — true in BOTH switch states)                  → F6
 *
 * Offline: no DB, no network, no API key.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const svc  = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
const pf   = require(path.join(ROOT, 'services/platformFormats'));

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
// The coherence gate is BEHAVIOURAL: it asks veoPromptBuilder whether the
// standardized hook-first camera is actually in force. Env is read at call
// time throughout, so these toggles drive the real code paths.
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
// ⚠️ THE PROMPT MODULE IS STUBBED, DELIBERATELY, AND NOT OUT OF LAZINESS.
// The camera standardization lands in services/veoPromptBuilder.js on its own
// branch, so which build of that module is on disk depends on merge ORDER. An
// env-only harness would therefore assert different things before and after
// that merge — and worse, the ONE env toggle available (PMAX_VIDEO_DIRECTIVES)
// stopped discriminating the moment the lane landed: with the switch off BOTH
// destinations fall to `gemini-omni`, so profiles are EQUAL in both states.
// Stubbing pins the two contracts this file actually depends on, in both
// positions, no matter what is on disk. The REAL module is still exercised by
// F2/F5 below, which pin that production imports it by name and that the gate
// survives it.
const PROMPT_MODULE = require.resolve(path.join(ROOT, 'services/veoPromptBuilder.js'));
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
// Standardization ON — both portrait destinations get the hook-first camera.
const HOOK_ON = {
  isHookFirstVideoPromptEnabled: () => true,
  promptProfileFor: () => 'hook_first',
  directivesForProfile: (p) => ({ profile: p })
};
// ⚠️ THE SHIPPED PRODUCTION CONFIGURATION (owner revert 2026-08-20).
// Standardization rolled back, so both destinations fall through to the SAME
// frozen `gemini-omni` profile — cameras EQUAL. Under the 2026-08-26 gate this
// SHARES, which is the owner's explicit instruction ("share the plate and
// prompt, single generation"). It is legitimate precisely because the frozen
// timeline is destination-blind (veoPromptBuilder.js:938-944): PMax 9:16
// already receives Meta's pan with sharing OFF, so sharing one render of it
// changes nothing creatively and saves ~$0.90/product/mixed run.
const HOOK_OFF_PROFILES_EQUAL = {
  isHookFirstVideoPromptEnabled: () => false,
  promptProfileFor: () => 'gemini-omni',
  directivesForProfile: (p) => ({ profile: p })
};
// Standardization on, but a destination escaped it (belt-and-braces arm).
const HOOK_ON_PROFILES_DIFFER = {
  isHookFirstVideoPromptEnabled: () => true,
  promptProfileFor: (caps, o) => (String(o && o.platformFormat).startsWith('pmax_')
    ? 'hook_first' : 'gemini-omni'),
  directivesForProfile: (p) => ({ profile: p })
};

// Comment-stripped view of the service source. Several checks below assert a
// retired symbol is absent from CODE while the history comment still names it.
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PROD_ENV = { PMAX_FUNNEL_VARIANTS: 'true', META_VIDEO_DERIVATIVES: 'true',
  UNIFIED_VIDEO_9_16_MASTER: 'true', META_VIDEO_DURATION_SEC: undefined,
  VIDEO_HOOK_FIRST_PROMPT: undefined, PMAX_VIDEO_DIRECTIVES: undefined };

// Shared-portrait ACTIVE: the state after the prompt lane lands.
const shared = (fn) => withPromptModule(HOOK_ON, () => withEnv(PROD_ENV, fn));
// Shared-portrait INACTIVE — via the rolled-back switch, which is also the
// hazard above. Every existing "unshared" assertion therefore now doubles as
// a guard on that configuration.
// ⚠️ RETARGETED 2026-08-26. "Unshared" must now mean CAMERAS GENUINELY
// DIFFER, because switch-off-with-equal-cameras SHARES under the new gate.
// Left pointing at HOOK_OFF_PROFILES_EQUAL, D4a/F3a would silently assert
// the SHARING plan and go green for the wrong reason.
const unshared = (fn) =>
  withPromptModule(HOOK_ON_PROFILES_DIFFER, () => withEnv(PROD_ENV, fn));

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
  path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8');
// The decision must be taken ONCE, inside the planner. A second call site
// is how the planner and the renderer start disagreeing.
const decisionCalls = (svcSrc.match(/resolvePortraitMasterFormat\s*\(/g) || []).length;
check('A4 [MONEY] resolvePortraitMasterFormat is DEFINED once and CALLED once',
  decisionCalls === 2,   // the definition + the single call in the planner
  `found ${decisionCalls} occurrences of "resolvePortraitMasterFormat(" `
  + '(want exactly 2: the function declaration and one call in '
  + 'planDeterministicVideoAds). A second caller can re-decide and drift.');

// ── B. [MONEY, THE BIG ONE] FAIL CLOSED on a PMax-only run ─────────────
// A derive whose master is never generated produces NOTHING. Paying $0.90
// is strictly better, so the absence of a Meta master in THIS RUN must
// keep pmax_video_9_16 billable.
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
  // MUST run under `shared()` — with prompts divergent the coherence
  // conjunct short-circuits and this passes without ever exercising the
  // master-list conjuncts (an earlier revision of this check did exactly
  // that and stayed green when the Google conjunct was deleted).
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
  // Sharing is per-RUN, never per-campaign: a Meta run yesterday must not
  // make today's PMax run free.
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

  // The shared gate must NOT gain a format-only branch. pmax_video_1_1 was
  // never a legitimate master so "this format ⇒ free" is safe there; the
  // 9:16 IS a legitimate master, so a format-only branch would zero out
  // every PMax-only run's portrait video. Highest-severity mistake here.
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
// findSiblingMasterAd matches TRUE masters only (no deriveFromMaster, no
// funnelStage). Any row still pointing at pmax_video_9_16 once that row is
// a derive will never resolve.
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

  // Unshared arm: the family must point back at PMax's own master.
  const q = unshared(() => plan(MIXED));
  const qMasters = new Set(q.filter((r) => !r.deriveFromMaster).map((r) => r.platformFormat));
  check('D4 unshared mixed run: no orphan derives either',
    q.filter((r) => r.deriveFromMaster && !qMasters.has(r.deriveFromMaster)).length === 0);
  check('D4a unshared mixed run: the 1:1 rides PMax\'s own 9:16',
    rowsOf(q, PMAX_1_1).every((r) => r.deriveFromMaster === PMAX_9));
}

// ── E. [SOUNDNESS] the shared plate clears Google's 10s floor ──────────
// Google rejects PMax video under 10s. resolveVideoDurationForFormat applies
// that floor to pmax_* only; a Meta master takes the operator's value
// verbatim, and the wizard posts 8 on every run.
// Owner directive 2026-08-18 made Meta video 10s UNIVERSALLY, so the floor is
// one rule in resolveVideoDurationForFormat rather than a mixed-run branch.
// What this group pins is that the rule is strong enough to keep the SHARED
// plate legal, and that switching it off stops the sharing instead of
// shipping an 8s PMax asset.
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

  // ⚠️ THE COUPLING. META_VIDEO_DURATION_SEC=0 is a documented no-deploy
  // revert of the Meta floor. With the floor off the shared plate would be
  // 8s — illegal for PMax — so sharing must REFUSE, not degrade.
  // ⚠️ MUST run under HOOK_ON. Every earlier conjunct has to PASS for this one
  // to be reachable — with the standardization off the gate short-circuits and
  // these two assert nothing (caught by revert-proof: deleting the Meta-floor
  // conjunct left them green).
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
  check('F1 [MONEY] cameras DIFFER ⇒ NO sharing (2 bills become 3)',
    unshared(() => bill(plan(MIXED)).length) === 3,
    'sharing a plate shot for a different camera delivers the wrong framing');
  check('F1a [MONEY] switch OFF but cameras EQUAL ⇒ SHARES, bills 2 (owner 2026-08-26)',
    withPromptModule(HOOK_OFF_PROFILES_EQUAL, () => withEnv(PROD_ENV, () =>
      svc.isSharedPortraitPlatePromptCoherent() === true
      && svc.resolvePortraitMasterFormat(MIXED) === META_MASTER
      && bill(plan(MIXED)).length === 2)),
    'this is the SHIPPED config: the hook-first switch is off and must no '
    + 'longer block sharing, or the company pays $2.70 for $1.80 of output');
  check('F1b switch ON + cameras EQUAL ⇒ still shares, bills 2 (no ON-arm regression)',
    shared(() => svc.isSharedPortraitPlatePromptCoherent() === true
      && bill(plan(MIXED)).length === 2));
  check('F2 the gate is a real probe of veoPromptBuilder, not a constant',
    /require\(['"]\.\/veoPromptBuilder['"]\)/.test(svcSrc)
      && /promptProfileFor\(/.test(svcSrc),
    'a hard-coded true here removes the only protection against a plate '
    + 'that was shot for the wrong destination');
  check('F2a the retired switch is GONE from code (a comment mention is fine)',
    !/isHookFirstVideoPromptEnabled/.test(stripComments(svcSrc)),
    'a leftover typeof/!==true check on the switch silently bills 3 again '
    + 'whenever an older veoPromptBuilder lacks that export');

  // ── F6 [MONEY] THE CROSS-BRANCH DEFECT THIS GROUP EXISTS FOR ──────────
  // Profile EQUALITY is not the right predicate and this is the proof.
  // With the standardization switched off, both destinations fall back to
  // the SAME frozen gemini-omni profile — equal profiles, incoherent plate.
  // An equality-only gate returns true here and keeps sharing a Ken Burns
  // master on YouTube Shorts, so the kill switch would revert the camera
  // and silently leave the sharing running. Restoring an equality-only gate
  // must turn THIS check red.
  check('F6 [MONEY] cameras genuinely DIFFER ⇒ refuses, bills 3 (the LIVE conjunct)',
    withPromptModule(HOOK_ON_PROFILES_DIFFER, () => withEnv(PROD_ENV, () => {
      const profilesDiffer =
        HOOK_ON_PROFILES_DIFFER.promptProfileFor(null, { platformFormat: META_MASTER })
        !== HOOK_ON_PROFILES_DIFFER.promptProfileFor(null, { platformFormat: PMAX_9 });
      // The premise of the check: this really is the differing-camera case.
      return profilesDiffer
        && svc.isSharedPortraitPlatePromptCoherent() === false
        && svc.resolvePortraitMasterFormat(MIXED) === PMAX_9
        && bill(plan(MIXED)).length === 3;
    })),
    'if camera inequality stops refusing, conjunct 4 is vacuous and a plate '
    + 'we cannot prove is the same camera gets shared across destinations');
  check('F6a the load-bearing predicate is CAMERA EQUALITY, not the switch',
    /promptProfileFor\(caps, \{ platformFormat: META_VIDEO_MASTER_KEY \}\)/.test(svcSrc)
      && !/isHookFirstVideoPromptEnabled\(\) !== true/.test(stripComments(svcSrc)),
    'restoring the switch comparison would refuse the frozen prompt the '
    + 'owner is actually running, re-breaking the $1.80 path');
  check('F6b [MONEY] switch export ABSENT but cameras equal ⇒ SHARES (switch truly dropped)',
    withPromptModule(
      { promptProfileFor: () => 'gemini-omni', directivesForProfile: (p) => ({ profile: p }) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())
    ) === true,
    'a surviving typeof-check on the retired switch would bill 3 whenever an '
    + 'older builder lacks that export — this is the canary for that');
  check('F6b2 a non-function promptProfileFor fails CLOSED',
    withPromptModule({ promptProfileFor: null, directivesForProfile: () => ({}) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false);
  check('F6c a throwing promptProfileFor fails CLOSED',
    withPromptModule(
      { promptProfileFor: () => { throw new Error('boom'); },
        directivesForProfile: () => ({}) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())
    ) === false);
  check('F6c2 a throwing directivesForProfile (names differ) fails CLOSED',
    withPromptModule(
      { promptProfileFor: (caps, o) => (String(o && o.platformFormat).startsWith('pmax_') ? 'a' : 'b'),
        directivesForProfile: () => { throw new Error('boom'); } },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())
    ) === false);
  check('F6g a falsy resolved profile fails CLOSED',
    withPromptModule({ promptProfileFor: () => null, directivesForProfile: () => ({}) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false);
  check('F6h missing directivesForProfile when names differ fails CLOSED',
    withPromptModule(
      { promptProfileFor: (caps, o) => (String(o && o.platformFormat).startsWith('pmax_') ? 'a' : 'b') },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false);
  check('F6i convergence for ONE caps shape only does NOT unlock sharing',
    withPromptModule(
      { promptProfileFor: (caps, o) => (caps && caps.paramShape === 'gemini-omni'
          ? 'gemini-omni'
          : (String(o && o.platformFormat).startsWith('pmax_') ? 'a' : 'b')),
        directivesForProfile: (p) => ({ profile: p }) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false,
    'both loop iterations must agree — a model-specific convergence must not '
    + 'unlock a plate shared across every model');
  check('F6j different profile NAMES with IDENTICAL directives ⇒ shares',
    withPromptModule(
      { promptProfileFor: (caps, o) => (String(o && o.platformFormat).startsWith('pmax_') ? 'a' : 'b'),
        directivesForProfile: () => ({ same: true }) },
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === true,
    'the directives arm must stay live, not be reduced to name equality');
  check('F6d switch ON but a destination escaped it ⇒ still refuses (belt-and-braces)',
    withPromptModule(HOOK_ON_PROFILES_DIFFER,
      () => withEnv(PROD_ENV, () => svc.isSharedPortraitPlatePromptCoherent())) === false,
    'the equality comparison is retained as a SECOND conjunct and must still bite');
  // The switch is owned by the prompt lane and reads TWO env names with a
  // fail-safe OR. We must call it, never re-implement it.
  // Scoped to actual process.env READS, not mentions: the gate's own comment
  // names both env vars to explain why it delegates, and a bare-substring
  // test would fail on the documentation rather than on a re-implementation.
  const svcCode = svcSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('F6e the two switch env names are NOT re-implemented here',
    !/process\.env\.VIDEO_HOOK_FIRST_PROMPT/.test(svcCode)
      && !/process\.env\.PMAX_VIDEO_DIRECTIVES/.test(svcCode)
      && !/process\.env\[/.test(svcCode),
    'duplicating the switch parsing is exactly the drift this file argues '
    + 'against — the legacy-alias fail-safe OR must have exactly one owner');
  // Exercise the REAL module: whatever build is on disk, the gate must
  // return a clean boolean rather than throwing.
  check('F5 the gate survives the REAL veoPromptBuilder on disk',
    typeof svc.isSharedPortraitPlatePromptCoherent() === 'boolean');
  // ⚠️ HOOK_ON again — the kill switch must be what refuses, not a coherence
  // short-circuit upstream of it (same vacuity trap as E3).
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
  // A throwing / missing prompt builder must read as "cannot prove" → bill.
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
  // Behavioural digest proof: the two rows whose duration/roles moved must
  // hash exactly as they did before.
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
{
  const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
  const start = adsSrc.indexOf('async function renderDeriveOnlyVideoAd');
  let body = null;
  if (start !== -1) {
    const open = adsSrc.indexOf('{', adsSrc.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < adsSrc.length; i++) {
      if (adsSrc[i] === '{') depth++;
      else if (adsSrc[i] === '}') { depth--; if (depth === 0) { body = adsSrc.slice(open, i + 1); break; } }
    }
  }
  check('H0 renderDeriveOnlyVideoAd body extracted (not the param list)',
    !!body && body.length > 2000 && /findSiblingMasterAd\s*\(/.test(body),
    `extracted ${body ? body.length : 0} chars`);
  if (body) {
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    check('H1 [MONEY] ZERO billable submits reachable for a derive row',
      !/veoGenerateForAd\s*\(/.test(code)
        && !/atlasVideoService/.test(code)
        && !/generateForAd\s*\(/.test(code),
      'the shared 9:16 makes FIVE more rows per mixed run take this path; a '
      + 'submit here is now a 5x hidden charge, not 1x');
    check('H1a comment-stripping left real code to assert against',
      /findSiblingMasterAd\s*\(/.test(code) && code.length > 1500);
  }
  // findSiblingMasterAd must keep matching TRUE masters only, and must NOT
  // have learned to roam across formats — a cross-format search would let a
  // PMax-only run silently adopt an old Meta plate instead of billing.
  const sibStart = adsSrc.indexOf('async function findSiblingMasterAd');
  let sibBody = null;
  if (sibStart !== -1) {
    const open = adsSrc.indexOf('{', adsSrc.indexOf(')', sibStart));
    let depth = 0;
    for (let i = open; i < adsSrc.length; i++) {
      if (adsSrc[i] === '{') depth++;
      else if (adsSrc[i] === '}') { depth--; if (depth === 0) { sibBody = adsSrc.slice(open, i + 1); break; } }
    }
  }
  check('H1b findSiblingMasterAd body extracted (not the param list)',
    !!sibBody && /platformFormat/.test(sibBody),
    `extracted ${sibBody ? sibBody.length : 0} chars`);
  // H2 used to regex the WHOLE routes/ads.js for these substrings, which is
  // individually vacuous: it passes on any occurrence anywhere in a
  // 4000-line file, so weakening the real clause while some unrelated
  // occurrence existed would not register. Scoped to the extracted function
  // body below (adversarial-review finding, folded in).
  check('H2 [MONEY] findSiblingMasterAd itself excludes derives and funnel rows',
    !!sibBody
      && /deriveFromMaster: null/.test(sibBody)
      && /funnelStage: null/.test(sibBody),
    'a master lookup that can return a derive or a funnel retitle hands the '
    + 'waiter a row that holds no plate of its own');
  check('H3 [MONEY] findSiblingMasterAd binds platformFormat EXACTLY ONCE',
    !!sibBody && (sibBody.match(/platformFormat/g) || []).length === 1,
    'a second platformFormat binding means a cross-format / fallback lookup. '
    + 'That would let a later PMax-only 9:16 adopt an OLDER Meta plate from a '
    + 'previous run and skip its Omni submit — the run silently ships a plate '
    + 'the operator never generated. Sharing is decided at MINT, per run; the '
    + 'renderer must never go looking for a substitute. '
    + `found ${sibBody ? (sibBody.match(/platformFormat/g) || []).length : 'no body'}`);
  check('H3a and it still takes the wanted format as its parameter',
    !!sibBody && /platformFormat: masterPlatformFormat/.test(sibBody));
  check('H4 the render loop reads the STAMP, not a re-derived condition',
    /const deriveFromFmt = resolveDeriveFromMaster\(ad\)/.test(adsSrc)
      && !/resolvePortraitMasterFormat/.test(adsSrc),
    'the renderer must never re-decide sharing; it reads what the mint wrote');
}

// ── I. Regenerate stays safe and names the right master ────────────────
{
  const regenSrc = fs.readFileSync(
    path.join(ROOT, 'services/adRegenerateService.js'), 'utf8');
  check('I1 [MONEY] regenerate preflight still uses the SHARED gate',
    /const \{[^}]*\bresolveDeriveFromMaster\b[^}]*\} = require\('\.\/campaignAdsGenerationService'\)/
      .test(regenSrc)
      && /resolveDeriveFromMaster\(ad\)/.test(regenSrc),
    'the destructure may grow additional names from the same module; dropping resolveDeriveFromMaster itself re-opens the regenerate hole');
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
// The acceptance bar for this change is a browser test that eyeballs the
// delivered creative on every surface. These pins make "correct shape for
// that surface" a CHECK rather than something only a human can catch, and
// they pin the PREMISE of the whole change: the two portrait masters are
// the same physical frame, differing only in titling.
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

  // THE PREMISE. If these ever differ, sharing one plate across both is
  // no longer sound and this whole change must be reconsidered.
  const a = pf.PLATFORM_FORMATS[META_MASTER].deliveryDims;
  const b = pf.PLATFORM_FORMATS[PMAX_9].deliveryDims;
  check('J2 [PREMISE] the two portrait masters deliver IDENTICAL dimensions',
    a.width === b.width && a.height === b.height,
    `meta=${a.width}x${a.height} pmax=${b.width}x${b.height} — one plate can `
    + 'only serve both surfaces while these match');
  check('J2a and their aspectRatio strings agree',
    pf.PLATFORM_FORMATS[META_MASTER].aspectRatio
      === pf.PLATFORM_FORMATS[PMAX_9].aspectRatio);

  // ...but the TITLING must stay per-surface. Same plate, different
  // burned-in treatment: Stories reserves 250/250, PMax portrait reserves
  // the YouTube Shorts bands 249/622. Equal safe areas here would mean one
  // of the two surfaces is being titled with the other's chrome.
  const sa = pf.PLATFORM_FORMATS[META_MASTER].safeArea;
  const sb = pf.PLATFORM_FORMATS[PMAX_9].safeArea;
  check('J3 [PREMISE] but their SAFE AREAS differ (titling is not shared)',
    sa.top !== sb.top || sa.bottom !== sb.bottom,
    `meta=${JSON.stringify(sa)} pmax=${JSON.stringify(sb)} — the plate is `
    + 'shared, the burned-in titling is not');

  // NEVER CROP UP. A derive is a window cut out of the master frame, so it
  // cannot exceed the master in either dimension. This is exactly why the
  // 16:9 stays a billable master: 1920 wide will not come out of a 1080-wide
  // portrait plate.
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
console.log('   mixed run = 21 ads / 2 billable ($1.80) whenever the two portrait ' +
  'destinations resolve to the SAME camera — which the shipped frozen prompt does; ' +
  '3 billable ($2.70) when the cameras genuinely differ, or UNIFIED_VIDEO_9_16_MASTER=false');
console.log('   PMax-only = 9 ads / 2 billable (fail-closed, unchanged)');
console.log('   Meta-only = 12 ads / 1 billable (unchanged)');
