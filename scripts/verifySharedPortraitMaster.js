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
 * at byte-identical delivery dims. ONE portrait plate is minted and the
 * PMax portrait family derives from it for free, so a mixed run pays $1.80
 * instead of $2.70. 16:9 stays a separate billable master.
 *
 * ⚠️ CONJUNCT 4 REMOVED, 2026-09-03 — owner: mint a single 9:16 master
 * for Meta+PMax regardless of hook-first. The live (non-hook-first)
 * prompt is the shared camera; PMax vs Meta differences stay in TITLING.
 * VIDEO_HOOK_FIRST_PROMPT / PMAX_VIDEO_DIRECTIVES stay false and are
 * irrelevant to this decision. Sharing still fails closed on: kill
 * switch off, Meta master not in this run, PMax portrait not in this
 * run, Meta 10s floor off. Camera-prompt inequality no longer bills a
 * second 9:16.
 *
 * THE FOUR WAYS THIS CHANGE CAN COST MONEY OR BREAK DELIVERY, each pinned:
 *   1. UNDER-DELIVER — pmax_video_9_16 goes free on a PMax-ONLY run, where
 *      no Meta plate exists. The derive waits for a master that is never
 *      generated, fails, and the run ships NO 9:16 video at all. This is
 *      the single most important group here (B).
 *   2. HANG — the 1:1 crop and the staged 9:16 retitles keep pointing at
 *      pmax_video_9_16 after it became a derive. Backend used to look that
 *      up at render time via findSiblingMasterAd (true masters only). That
 *      lookup was deleted with the in-process render loop; adgen's renderer
 *      owns it now. The mint-time stamp is still the planner's job (group D):
 *      no row may derive from a non-master.
 *   3. INVALID ASSET — the shared plate is minted at 8s. Google REJECTS
 *      PMax video under 10s, so the free 9:16 is a paid-for asset that
 *      cannot be used. Nothing offline can see this; only this harness can
 *      (group E).
 *   4. (retired) WRONG CAMERA — owner 2026-09-03 accepted one shared
 *      camera for both platforms. Group F now pins that hook-first ON,
 *      hook-first OFF, and genuinely-different profile names ALL share
 *      on a mixed run. The kill switch and the 10s floor still refuse.
 *
 * REVERT-PROOF (each mutation individually, all against the real exports):
 *   1. Make resolvePortraitMasterFormat return META unconditionally  → B1/B2
 *   2. Drop the isGoogleVideoMasterRun conjunct                      → B3
 *   3. Re-add a camera-coherence / hook-first conjunct               → F1/F6
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
// Sharing no longer depends on the prompt module. PROD_ENV (kill switch
// on, Meta 10s floor on, both masters in the run) is sufficient.
const shared = (fn) => withEnv(PROD_ENV, fn);
const killed = (fn) => withEnv(
  { PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'false' }, fn);

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
// findSiblingMasterAd (deleted with the in-process render loop) used to
// match TRUE masters only (no deriveFromMaster, no funnelStage) at render
// time. That lookup moved to adgen's renderer. Backend still stamps
// deriveFromMaster at mint; any row still pointing at pmax_video_9_16
// once that row is a derive is a derivative of a derivative.
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

  // Kill-switch arm: the family must point back at PMax's own master.
  const q = killed(() => plan(MIXED));
  const qMasters = new Set(q.filter((r) => !r.deriveFromMaster).map((r) => r.platformFormat));
  check('D4 kill-switch mixed run: no orphan derives either',
    q.filter((r) => r.deriveFromMaster && !qMasters.has(r.deriveFromMaster)).length === 0);
  check('D4a kill-switch mixed run: the 1:1 rides PMax\'s own 9:16',
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

// ── F. [MONEY] sharing is unconditional on camera / hook-first ─────────
{
  const resolveFn = svcSrc.slice(
    svcSrc.indexOf('function resolvePortraitMasterFormat'),
    svcSrc.indexOf('function planDeterministicVideoAds')
  );
  check('F2 [MONEY] resolvePortraitMasterFormat does not call camera coherence',
    !/isSharedPortraitPlatePromptCoherent\s*\(/.test(stripComments(resolveFn)),
    're-adding the conjunct re-opens $2.70 mixed runs when cameras diverge');
  check('F2a hook-first switch is not read inside the sharing decision',
    !/isHookFirstVideoPromptEnabled/.test(stripComments(resolveFn))
      && !/VIDEO_HOOK_FIRST_PROMPT/.test(stripComments(resolveFn))
      && !/PMAX_VIDEO_DIRECTIVES/.test(stripComments(resolveFn)));

  check('F1 [MONEY] hook-first OFF + mixed ⇒ SHARES, bills 2 (shipped config)',
    withPromptModule(HOOK_OFF_PROFILES_EQUAL, () => withEnv(PROD_ENV, () =>
      svc.resolvePortraitMasterFormat(MIXED) === META_MASTER
      && bill(plan(MIXED)).length === 2)),
    'shipped VIDEO_HOOK_FIRST_PROMPT=false must not cost a second 9:16');
  check('F1b hook-first ON + mixed ⇒ still shares, bills 2',
    withPromptModule(HOOK_ON, () => withEnv(PROD_ENV, () =>
      svc.resolvePortraitMasterFormat(MIXED) === META_MASTER
      && bill(plan(MIXED)).length === 2)));
  check('F6 [MONEY] cameras genuinely DIFFER ⇒ still SHARES, bills 2',
    withPromptModule(HOOK_ON_PROFILES_DIFFER, () => withEnv(PROD_ENV, () => {
      const profilesDiffer =
        HOOK_ON_PROFILES_DIFFER.promptProfileFor(null, { platformFormat: META_MASTER })
        !== HOOK_ON_PROFILES_DIFFER.promptProfileFor(null, { platformFormat: PMAX_9 });
      return profilesDiffer
        && svc.resolvePortraitMasterFormat(MIXED) === META_MASTER
        && bill(plan(MIXED)).length === 2;
    })),
    'owner 2026-09-03: one 9:16 master regardless of hook-first / camera name');
  check('F6env VIDEO_HOOK_FIRST_PROMPT=false does not change the mixed bill',
    withEnv({ ...PROD_ENV, VIDEO_HOOK_FIRST_PROMPT: 'false', PMAX_VIDEO_DIRECTIVES: 'false' },
      () => bill(plan(MIXED)).length) === 2);
  check('F6envOn VIDEO_HOOK_FIRST_PROMPT=true does not change the mixed bill',
    withEnv({ ...PROD_ENV, VIDEO_HOOK_FIRST_PROMPT: 'true', PMAX_VIDEO_DIRECTIVES: 'true' },
      () => bill(plan(MIXED)).length) === 2);

  check('F3 [MONEY] UNIFIED_VIDEO_9_16_MASTER=false restores 3 billable masters',
    killed(() => bill(plan(MIXED)).length) === 3);
  check('F3b [PREMISE] the kill switch is genuinely what refuses in F3',
    withEnv(
      { PMAX_FUNNEL_VARIANTS: 'true', UNIFIED_VIDEO_9_16_MASTER: 'true' },
      () => svc.resolvePortraitMasterFormat(MIXED)) === META_MASTER,
    'with the switch back on the same config must SHARE, or F3 proves nothing');
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

// ── H. REMOVED (dormant render fallback deletion) ──────────────────────
// H0 extracted renderDeriveOnlyVideoAd; H1b/H2/H3/H3a extracted
// findSiblingMasterAd from routes/ads.js; H4 pinned that the in-process
// render loop reads the mint-time STAMP. findSiblingMasterAd was the
// render-time sibling lookup and is deleted with the in-process render
// loop (comment at routes/ads.js ~1834 confirms). The money invariant
// "true masters only, platformFormat bound once" now lives in adgen's
// renderer. Backend still stamps deriveFromMaster at mint via
// resolvePortraitMasterFormat / resolveDeriveFromMaster — pinned in this
// file's C3 / D-group / I-group. Do not silently drop this section
// without that explanation: the lookup moved, the mint-time stamp did not.
{
  const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
  check('H-abs [ABSENCE] routes/ads.js no longer defines renderDeriveOnlyVideoAd',
    !/async function renderDeriveOnlyVideoAd\s*\(/.test(adsSrc),
    'the in-process derive renderer came back — restore the H0/H1 money pins');
  check('H-abs2 [ABSENCE] routes/ads.js no longer defines findSiblingMasterAd',
    !/async function findSiblingMasterAd\s*\(/.test(adsSrc),
    'the in-process sibling lookup came back — that lookup moved to adgen');
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
console.log('   mixed run = 21 ads / 2 billable ($1.80) unconditionally ' +
  '(hook-first ON or OFF); 3 billable ($2.70) only when UNIFIED_VIDEO_9_16_MASTER=false ' +
  'or the Meta 10s floor is off');
console.log('   PMax-only = 9 ads / 2 billable (fail-closed, unchanged)');
console.log('   Meta-only = 12 ads / 1 billable (unchanged)');
