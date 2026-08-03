#!/usr/bin/env node
'use strict';

/**
 * verifyPostPilotBatch — offline pins for the three post-pilot deploy changes:
 *
 *   CHANGE 1 — atomic rating+count pair (product first, brand fallback with
 *              honest attribution; NEVER product count + brand rating).
 *   CHANGE 2 — THE FULL 134db56 (PR #61) CAMERA-PROMPT ROLLBACK. All THREE of
 *              that commit's prompt changes are pinned ABSENT: the Scene 3
 *              return-to-primary beat (+ its two PRODUCT FIDELITY sentences),
 *              the crossfade-vs-long-dissolve policy, AND the
 *              subjectContinuity directive. The prompt text must match
 *              134db56~1 byte-for-byte (pinned end-to-end by B14).
 *   CHANGE 3 — primary reference repeat: capability retained but DEFAULT OFF,
 *              so a default request ships exactly 3 distinct refs with nothing
 *              appended. Flag-on behaviour (append when room, not at cap,
 *              total cap 4 = 3 distinct + primary) is still pinned as opt-in.
 *
 * ── 2026-08-03 REVERT (owner) — why the CHANGE 2 pins are ABSENCE pins ─────
 * Owner, verbatim: "This is creating additional hallucinations and the
 * previous output was better." Every camera-prompt change 134db56 introduced
 * is rolled back, in both places each one lived (prompt text and, for the
 * primary repeat, the reference stack):
 *
 *   1. Scene 3 "RETURN TO THE PRIMARY VIEW" + the PRODUCT FIDELITY sentences
 *      claiming the FINAL reference repeats the primary view  → B9/B10/B11.
 *   2. The crossfade-allowance / "long dissolves" rewording   → B5/B6/B12/B13.
 *   3. The subjectContinuity directive                        → B1/B2/B3/B8.
 *
 * subjectContinuity is reverted for the same hallucination reason and one
 * specific mechanism: it demanded a single continuous person pose/orientation
 * across scenes, while the reference stack legitimately contains a BACK view
 * (the owner wants a back view for product fidelity). The only way to satisfy
 * both constraints is to invent intermediate body/face pixels — i.e. the
 * directive is itself a hallucination driver. So B1/B2/B3/B8 assert its
 * ABSENCE. Do not "restore" any of these pins: a green run here means the
 * prompt matches the known-good pre-#61 wording.
 *
 * That revert reinstates a KNOWN, OWNER-CONFIRMED CONTRADICTION: `transitions`
 * permits "Smooth crossfades only, ~0.25s" (pinned by B4) while `doNot`
 * bare-bans "dissolves" (pinned by B7), and a crossfade IS a short dissolve.
 * B4 and B7 are BOTH correct and are MEANT to disagree — matching the
 * known-good prompt outranks internal tidiness. This is not a bug; do not
 * resolve it by editing either string or either check.
 *
 * No network, no database, no API key.
 *   node scripts/verifyPostPilotBatch.js
 */

const path = require('path');

const {
  formatDisplayRating,
  resolveAtomicRatingPair,
  brandAttributionLabel,
  RATING_STAR_MIN,
} = require(path.join(__dirname, '..', 'services', 'ratingDisplay.js'));

const {
  buildVeoPrompt,
  OMNI_DIRECTIVES,
  GROK_DIRECTIVES,
} = require(path.join(__dirname, '..', 'services', 'veoPromptBuilder.js'));

const {
  appendPrimaryReferenceRepeat,
  referenceStackBudget,
  isRepeatPrimaryReferenceEnabled,
  REPEAT_PRIMARY_TOTAL_CAP,
  MAX_DISTINCT_REFERENCES,
  DEFAULT_REFERENCE_IMAGE_COUNT,
} = require(path.join(__dirname, '..', 'services', 'atlasVideoService.js'));

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function truthy(label, v) {
  check(label, !!v, true);
}

function falsy(label, v) {
  check(label, !!v, false);
}

console.log('\nverifyPostPilotBatch\n');

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 1 — atomic rating pair
// ═══════════════════════════════════════════════════════════════════════
console.log('A. atomic rating pair (product first, brand fallback, never mix)');

check('A0 star floor is 4.5', RATING_STAR_MIN, 4.5);

// Product pair present and above gate → used (brand ignored)
{
  const r = resolveAtomicRatingPair({
    productRating: 4.8,
    productReviewCount: 120,
    brandRating: 4.9,
    brandReviewCount: 41000,
    brandAttribution: 'allbirds.com',
  });
  check('A1 product pair used when displayable', r.source, 'product');
  check('A1 rating is product display', r.rating, '4.8');
  check('A1 count is product count', r.reviewCount, 120);
  check('A1 reviewsText product style (no brand attribution)', r.reviewsText, '120 reviews');
}

// Product below gate + brand pair >4.5 → brand pair with attribution
{
  const r = resolveAtomicRatingPair({
    productRating: 4.2,
    productReviewCount: 41000, // would be the historical mix bug if used with brand rating
    brandRating: 4.7,
    brandReviewCount: 8900,
    brandAttribution: 'allbirds.com',
  });
  check('A2 brand pair when product fails gate', r.source, 'brand');
  check('A2 brand rating display', r.rating, '4.7');
  check('A2 brand count (NOT product 41000)', r.reviewCount, 8900);
  check('A2 honest attribution marker', r.reviewsText, '8900 reviews · allbirds.com');
}

// Product exactly 4.5 fails gate (strictly greater)
{
  const r = resolveAtomicRatingPair({
    productRating: 4.5,
    productReviewCount: 50,
    brandRating: 4.9,
    brandReviewCount: 100,
    brandAttribution: 'allbirds.com',
  });
  check('A3 product 4.5 fails gate → brand', r.source, 'brand');
  check('A3 brand rating', r.rating, '4.9');
}

// Brand rating without count → rating, no count (never product's count)
{
  const r = resolveAtomicRatingPair({
    productRating: null,
    productReviewCount: 41000,
    brandRating: 4.8,
    brandReviewCount: null,
    brandAttribution: 'allbirds.com',
  });
  check('A4 brand rating alone is allowed', r.source, 'brand');
  check('A4 rating shown', r.rating, '4.8');
  check('A4 NO count (product count must not leak)', r.reviewCount, null);
  check('A4 reviewsText null when no brand count', r.reviewsText, null);
}

// HISTORICAL BUG PIN: never product count with brand rating
{
  const r = resolveAtomicRatingPair({
    productRating: 3.3, // fails gate
    productReviewCount: 41000,
    brandRating: 4.6,
    brandReviewCount: null,
    brandAttribution: 'allbirds.com',
  });
  check('A5 source is brand', r.source, 'brand');
  check('A5 NEVER product 41000 with brand rating', r.reviewCount, null);
  falsy('A5 reviewsText does not contain product count',
    r.reviewsText && String(r.reviewsText).includes('41000'));
}

// Neither pair displayable
{
  const r = resolveAtomicRatingPair({
    productRating: 4.0,
    productReviewCount: 10,
    brandRating: 4.1,
    brandReviewCount: 20,
    brandAttribution: 'x.com',
  });
  check('A6 both below gate → null source', r.source, null);
  check('A6 no rating', r.rating, null);
  check('A6 no reviewsText', r.reviewsText, null);
}

// brandAttributionLabel prefers domain
check('A7 attribution prefers domain', brandAttributionLabel({
  websiteUrl: 'https://www.allbirds.com/products/foo',
  name: 'Allbirds',
}), 'allbirds.com');
check('A8 attribution falls back to name', brandAttributionLabel({
  name: 'Allbirds',
}), 'Allbirds');
check('A9 formatDisplayRating still gates 4.51 as withhold',
  formatDisplayRating(4.51), undefined);
// 4.55 → toFixed(1) is "4.5" under IEEE (withheld); 4.6 is the first clean pass.
check('A10 formatDisplayRating passes 4.6',
  formatDisplayRating(4.6), '4.6');

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 2 — camera prompt
// ═══════════════════════════════════════════════════════════════════════
console.log('\nB. camera prompt directives (both profiles)');

for (const [name, d] of [['OMNI', OMNI_DIRECTIVES], ['GROK', GROK_DIRECTIVES]]) {
  // ── B1–B3: subjectContinuity must stay GONE (owner revert 2026-08-03) ────
  // These were PRESENCE pins when 134db56 shipped the directive. They are now
  // ABSENCE pins, on owner instruction: the directive raised hallucination
  // ("this is creating additional hallucinations and the previous output was
  // better"), and mechanically it forced one continuous person
  // pose/orientation across scenes while the reference stack legitimately
  // carries a BACK view — satisfiable only by inventing body/face pixels.
  // A failure here means someone reintroduced the rolled-back directive.
  // Re-read the owner instruction in the docblock before "fixing" one.
  falsy(`B1 ${name} has NO subjectContinuity key (reverted — owner: raised hallucination)`,
    d.subjectContinuity !== undefined);
  falsy(`B2 ${name} NO directive demands person pose/orientation continuity (reverted — conflicts with the BACK reference view)`,
    Object.values(d).some(v => typeof v === 'string'
      && /keeps? (pose|pose\/orientation)|pose and orientation continuity|orientation continuity/i.test(v)));
  falsy(`B3 ${name} NO directive bans a turn-away closing beat (reverted — must stay absent)`,
    Object.values(d).some(v => typeof v === 'string'
      && /closing beat/i.test(v)));
  falsy(`B3b ${name} NO directive carries the SUBJECT CONTINUITY header (reverted — must stay absent)`,
    Object.values(d).some(v => typeof v === 'string' && /SUBJECT CONTINUITY/i.test(v)));

  // ── Transition policy: REVERTED to the pre-#61 text (owner 2026-08-03) ──
  // `transitions` was NOT changed by 134db56 (it only gained a comment), so B4
  // still passes against the restored 134db56~1 text. `doNot` went back to the
  // bare ban. B4 and B7 therefore CONTRADICT each other on purpose:
  // transitions permits a ~0.25s crossfade, doNot bans "dissolves", and a
  // crossfade IS a short dissolve. Owner-confirmed after the contradiction was
  // raised — the contradictory prompt is the version that produced the better
  // output. DO NOT "repair" this by softening either string or by flipping
  // either check back.
  truthy(`B4 ${name} transitions allow ~0.25s crossfade (unchanged by the revert; contradicts B7 BY DESIGN)`,
    /crossfade/i.test(d.transitions) && /0\.25/.test(d.transitions));
  falsy(`B5 ${name} doNot carries NO crossfade-allowance clause (reverted 2026-08-03 — must stay absent)`,
    /0\.25s crossfade|crossfades between scenes are allowed/i.test(d.doNot));
  falsy(`B6 ${name} doNot does NOT use the softened "morphing blends / long dissolves" wording (reverted — must stay absent)`,
    /morphing blend|long dissolve/i.test(d.doNot));
  truthy(`B7 ${name} doNot bare-bans "morphing, or dissolves" — DELIBERATE, owner-confirmed contradiction with B4, NOT a bug`,
    /,\s*or dissolves\.?$/i.test(d.doNot.trim()));
}

const BUILD_ARGS = {
  product: { title: 'Wool Runner' },
  hasProductReference: true,
  durationSec: 8,
};

// caps.family is NOT the profile selector — promptProfileFor() switches on
// caps.paramShape (veoPromptBuilder.js). Kept as-is because it exercises the
// grok/default fallthrough, and promptOmniReal below covers the real live
// omni caps shape so the OMNI directive set is genuinely built, not assumed.
const promptOmni = buildVeoPrompt({
  ...BUILD_ARGS,
  caps: { promptByteCap: 20000, family: 'gemini-omni' },
});
const promptOmniReal = buildVeoPrompt({
  ...BUILD_ARGS,
  caps: { promptByteCap: 20000, paramShape: 'gemini-omni' },
});
const promptDefault = buildVeoPrompt({ ...BUILD_ARGS });

// ── B8: subjectContinuity must be ABSENT from the BUILT prompt ─────────────
// Was a presence pin under 134db56. Inverted on owner instruction 2026-08-03:
// the directive and its `lines.push(d.subjectContinuity)` call site are both
// gone because the directive raised hallucination (it demanded one continuous
// person pose/orientation while a BACK reference view is deliberately in the
// stack, forcing the model to invent the frames in between). Asserted on the
// no-product-reference variant too, and on the real OMNI profile, so no build
// branch can smuggle it back.
for (const [variant, p] of [
  ['default/grok', promptDefault],
  ['omni(paramShape)', promptOmniReal],
  ['omni(family→grok)', promptOmni],
  ['no product ref', buildVeoPrompt({ ...BUILD_ARGS, hasProductReference: false })],
  ['seedHasText', buildVeoPrompt({ ...BUILD_ARGS, seedHasText: true })],
]) {
  falsy(`B8 ${variant} built prompt has NO "SUBJECT CONTINUITY" (reverted — owner: raised hallucination)`,
    /SUBJECT CONTINUITY/i.test(p));
  falsy(`B8b ${variant} built prompt has NO person pose/orientation-continuity demand (reverted — conflicts with the BACK reference view)`,
    /pose|orientation/i.test(p));
  falsy(`B8c ${variant} built prompt has NO "closing beat" instruction (reverted — must stay absent)`,
    /closing beat/i.test(p));
}

// ── B9–B11: the return-to-primary closing beat must stay GONE ─────────────
// Reverted on owner instruction 2026-08-03: instructing the model to end on
// the first reference view produced MORE hallucination than the older prompt.
// These are ABSENCE pins — if one fails, someone reintroduced the rolled-back
// behaviour. Re-read the owner instruction before "fixing" a failure here.
for (const [variant, p] of [['default/grok', promptDefault], ['omni(paramShape)', promptOmniReal]]) {
  falsy(`B9 ${variant} Scene 3 does NOT instruct a return to the PRIMARY / FIRST reference (reverted — raised hallucination)`,
    /RETURN TO THE PRIMARY VIEW|FIRST reference image/i.test(p));
  falsy(`B10 ${variant} PRODUCT FIDELITY does NOT claim the FINAL reference repeats the primary (reverted — stack no longer repeats it)`,
    /FINAL reference.*primary|final reference image repeats/i.test(p));
  falsy(`B11 ${variant} built prompt has NO closing-shot-matches-primary instruction (reverted — raised hallucination)`,
    /closing shot must match|end on that same primary/i.test(p));
}

// ── B12–B13: built-prompt side of the reverted crossfade policy ───────────
// Mirrors B7/B5 at the assembled-prompt level. The bare ban is what the
// known-good prompt shipped; the crossfade-allowance clause is gone. The
// contradiction with the `transitions` line is deliberate and owner-confirmed.
for (const [variant, p] of [['default/grok', promptDefault], ['omni(paramShape)', promptOmniReal]]) {
  truthy(`B12 ${variant} built prompt carries the bare "morphing, or dissolves" ban (restored; contradiction with transitions is DELIBERATE)`,
    /morphing, or dissolves/i.test(p));
  falsy(`B13 ${variant} built prompt carries NO crossfade-allowance clause (reverted — must stay absent)`,
    /0\.25s crossfade|crossfades between scenes are allowed/i.test(p));
}

// Declared OUTSIDE the B14 block so the final summary can tell the truth about
// whether byte-identity was actually proven in this run. Module scope on purpose:
// the block below is a bare `{ }`, so a `let` inside it would not be visible to
// the summary and the summary would go on overclaiming.
let b14Ran = false;
let b14SkipReason = null;

// ══ B14 — THE REAL ACCEPTANCE TEST: same prompt in, same prompt out ════════
// The three CHANGE 2 pins above are keyword pins; they cannot prove the prompt
// is byte-identical to the known-good pre-#61 text, only that specific phrases
// are gone. B14 closes that gap: it builds the prompt from the 134db56~1 source
// (read straight out of git, never checked out into the tree) and asserts the
// current builder emits the SAME STRING for every branch that matters.
//
// Hermetic: `git show` only, no network, no DB, no API key. If git or that
// commit is unavailable (shallow clone, rewritten history, exported tarball)
// the pin SKIPs loudly instead of failing — a missing baseline is an
// environment fact, not a regression. Every SKIP is printed and counted.
//
// The one mutation applied to the old source is rewriting its single relative
// require('./platformFormats') to an absolute path so the temp copy can live
// outside services/. If that rewrite does not apply, we SKIP rather than guess.
{
  const fs   = require('fs');
  const os   = require('os');
  const cp   = require('child_process');
  const REPO = path.join(__dirname, '..');
  const BASELINE = '134db56~1:services/veoPromptBuilder.js';
  const REL_REQUIRE = "require('./platformFormats')";

  let oldMod = null;
  let skipReason = null;
  let tmpDir = null;

  try {
    const src = cp.execFileSync('git', ['-C', REPO, 'show', BASELINE], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!src.includes(REL_REQUIRE)) {
      skipReason = `baseline source does not contain ${REL_REQUIRE} — cannot relocate it safely`;
    } else {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veoRevertPin-'));
      const tmpFile = path.join(tmpDir, 'veoPromptBuilder.baseline.js');
      fs.writeFileSync(tmpFile, src.replace(
        REL_REQUIRE,
        `require(${JSON.stringify(path.join(REPO, 'services', 'platformFormats'))})`
      ));
      oldMod = require(tmpFile);
      if (typeof oldMod.buildVeoPrompt !== 'function') {
        oldMod = null;
        skipReason = 'baseline module does not export buildVeoPrompt';
      }
    }
  } catch (e) {
    skipReason = `git unavailable or ${BASELINE} not in this clone (${e.code || e.message})`;
  }

  if (!oldMod) {
    // A silent skip here used to be a LIE BY OMISSION: the run still printed
    // "prompt byte-identical to 134db56~1" in its summary even though the one
    // check that proves it never executed. B14 is the whole acceptance test for
    // an owner-directed revert whose entire justification is "the previous
    // output was better" — so the summary must never claim byte-identity it did
    // not verify. Record the skip and let the summary degrade its own wording.
    b14Ran = false;
    b14SkipReason = skipReason;
    console.log(`   ⏭  B14 SKIP (baseline unavailable): ${skipReason}`);
    console.log('      ⚠️  byte-identity to 134db56~1 was NOT verified in this run.');
  } else {
    b14Ran = true;
    // Cover both directive profiles, both reference-stack shapes, both
    // seed-text branches, and the short/canonical/long durations, because the
    // reverted text lived in Scene 3, in PRODUCT FIDELITY (both branches) and
    // in a line pushed unconditionally after physicalAccuracy.
    const CAPSETS = [
      ['default/grok',      null],
      ['omni(paramShape)',  { promptByteCap: 20000, paramShape: 'gemini-omni' }],
      ['omni-r2v',          { promptByteCap: 20000, paramShape: 'gemini-omni-r2v' }],
    ];
    for (const [capName, caps] of CAPSETS) {
      for (const hasProductReference of [true, false]) {
        for (const durationSec of [4, 8, 15]) {
          for (const seedHasText of [false, true]) {
            const args = {
              product: { title: 'Wool Runner' },
              hasProductReference, durationSec, seedHasText, caps,
            };
            const label = `caps=${capName} productRef=${hasProductReference} dur=${durationSec} seedText=${seedHasText}`;
            check(`B14 built prompt is byte-identical to the 134db56~1 prompt (${label})`,
              buildVeoPrompt({ ...args }), oldMod.buildVeoPrompt({ ...args }));
          }
        }
      }
    }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}
void promptOmni;

// ═══════════════════════════════════════════════════════════════════════
// CHANGE 3 — primary reference repeat
// ═══════════════════════════════════════════════════════════════════════
console.log('\nC. primary reference repeat (stack budget + append)');

check('C0 REPEAT_PRIMARY_TOTAL_CAP is 4', REPEAT_PRIMARY_TOTAL_CAP, 4);
check('C1 DEFAULT_REFERENCE_IMAGE_COUNT is 3', DEFAULT_REFERENCE_IMAGE_COUNT, 3);

// Budget: flag ON (OPT-IN path, no longer the default), 3-image request →
// distinct 3, total 4. "default" deliberately does NOT name this path any more.
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 7, repeatEnabled: true });
  check('C2 flag-ON (opt-in) budget distinctCap=3', b.distinctCap, 3);
  check('C2 flag-ON (opt-in) budget totalCap=4', b.totalCap, 4);
}

// Budget: flag OFF — THIS IS THE DEFAULT PATH since 2026-08-03. No slot is
// reserved and no duplicate is appended: exactly the first 3 distinct refs.
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 7, repeatEnabled: false });
  check('C3 DEFAULT (flag off) distinctCap=3', b.distinctCap, 3);
  check('C3 DEFAULT (flag off) totalCap=3 — nothing reserved for a repeat', b.totalCap, 3);
}

// Budget: model max 1 → no room for repeat
{
  const b = referenceStackBudget({ effectiveMax: 3, modelMax: 1, repeatEnabled: true });
  check('C4 modelMax=1 totalCap=1', b.totalCap, 1);
  check('C4 modelMax=1 distinctCap=1', b.distinctCap, 1);
}

// Budget: operator 5 picks with flag ON (opt-in) → cap at 4 total, distinct 3
{
  const b = referenceStackBudget({ effectiveMax: 5, modelMax: 7, repeatEnabled: true });
  check('C5 flag-ON (opt-in) 5 picks → totalCap 4', b.totalCap, 4);
  check('C5 flag-ON (opt-in) 5 picks → distinctCap 3 (leave room for primary)', b.distinctCap, 3);
}

// Append when room
{
  const urls = ['u0', 'u1', 'u2'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: true, totalCap: 4 });
  check('C6 append primary when room', out, ['u0', 'u1', 'u2', 'u0']);
}

// Not when at cap
{
  const urls = ['u0', 'u1', 'u2', 'u3'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: true, totalCap: 4 });
  check('C7 no append at cap (never evict)', out, ['u0', 'u1', 'u2', 'u3']);
}

// Flag off
{
  const urls = ['u0', 'u1', 'u2'];
  const out = appendPrimaryReferenceRepeat(urls, { enabled: false, totalCap: 4 });
  check('C8 flag off → no repeat', out, ['u0', 'u1', 'u2']);
}

// Empty / single
{
  check('C9 empty stays empty',
    appendPrimaryReferenceRepeat([], { enabled: true, totalCap: 4 }), []);
  check('C10 single + room → [u0,u0]',
    appendPrimaryReferenceRepeat(['u0'], { enabled: true, totalCap: 4 }), ['u0', 'u0']);
}

// Smoke that the reader function exists and returns boolean.
truthy('C11 isRepeatPrimaryReferenceEnabled returns boolean',
  typeof isRepeatPrimaryReferenceEnabled() === 'boolean');

// ── C12: the CODE default is OFF ──────────────────────────────────────────
// Owner 2026-08-03: the repeated primary raised hallucination, so an unset or
// empty REPEAT_PRIMARY_REFERENCE must yield FALSE. This harness does NOT load
// dotenv, so the code default is tested explicitly by deleting the env var —
// the assertion must not depend on whether config/defaults.env happened to be
// loaded (that file is pinned separately at C14). The capability is retained,
// so an explicit truthy value must still turn it on for a future A/B.
{
  const saved = process.env.REPEAT_PRIMARY_REFERENCE;
  try {
    delete process.env.REPEAT_PRIMARY_REFERENCE;
    check('C12 CODE default with env UNSET is OFF (false)',
      isRepeatPrimaryReferenceEnabled(), false);

    process.env.REPEAT_PRIMARY_REFERENCE = '';
    check('C12 CODE default with env EMPTY STRING is OFF (false)',
      isRepeatPrimaryReferenceEnabled(), false);

    process.env.REPEAT_PRIMARY_REFERENCE = 'true';
    check('C13 explicit "true" still enables it (capability retained for A/B)',
      isRepeatPrimaryReferenceEnabled(), true);

    process.env.REPEAT_PRIMARY_REFERENCE = 'false';
    check('C13 explicit "false" is OFF',
      isRepeatPrimaryReferenceEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.REPEAT_PRIMARY_REFERENCE;
    else process.env.REPEAT_PRIMARY_REFERENCE = saved;
  }
}

// ── C14: config/defaults.env agrees with the code default ─────────────────
// defaults.env is committed and dotenv-loaded at boot, so it is the REAL
// production default. Changing only the code default would leave prod on the
// old behaviour, so pin both.
{
  const fs = require('fs');
  const env = fs.readFileSync(
    path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8');
  truthy('C14 config/defaults.env sets REPEAT_PRIMARY_REFERENCE=false (real prod default)',
    /^REPEAT_PRIMARY_REFERENCE=false\s*$/m.test(env));
  falsy('C14 config/defaults.env does NOT still set it true',
    /^REPEAT_PRIMARY_REFERENCE=true\s*$/m.test(env));
}

// ── C15: end-to-end DEFAULT stack — exactly three refs, no duplicate ──────
// The owner's stated default behaviour: "first three images". Budget + append
// composed, so a regression in either one is caught here rather than only in
// the isolated unit pins above.
{
  const { distinctCap, totalCap } =
    referenceStackBudget({ effectiveMax: 3, modelMax: 7, repeatEnabled: false });
  const ids = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const stack = appendPrimaryReferenceRepeat(
    ids.slice(0, distinctCap), { enabled: false, totalCap });
  check('C15 DEFAULT stack is exactly the first three images', stack, ['u0', 'u1', 'u2']);
  check('C15 DEFAULT stack length is 3', stack.length, 3);
  check('C15 DEFAULT stack has NO appended duplicate of the primary',
    stack.filter(u => u === 'u0').length, 1);
  check('C15 DEFAULT stack is all-distinct', new Set(stack).size, stack.length);
}

// ── C16 — the DISTINCT-reference ceiling (owner-set to 5, 2026-08-03) ──────
// Turning the primary repeat off removed the only clamp on that branch: the
// repeat path caps at REPEAT_PRIMARY_TOTAL_CAP, the off path did not clamp at
// all, so referenceImageCount=7 (or 7 operator seed picks) would have shipped
// seven refs against the owner's measured "too many images hallucinated"
// finding. Found by adversarial review of the flag flip itself.
{
  check('C16 MAX_DISTINCT_REFERENCES is 5', MAX_DISTINCT_REFERENCES, 5);
  const off = (eff, model = 7) => referenceStackBudget({ effectiveMax: eff, modelMax: model, repeatEnabled: false });
  check('C16 default request (3) is untouched by the ceiling', off(3).distinctCap, 3);
  check('C16 five is allowed in full',                        off(5).distinctCap, 5);
  check('C16 six clamps to five',                             off(6).distinctCap, 5);
  check('C16 seven clamps to five',                           off(7).distinctCap, 5);
  check('C16 totalCap tracks distinctCap when the repeat is off (no appended dup)',
    off(7).totalCap, 5);
  // The model's own limit must still win when it is TIGHTER than the ceiling.
  check('C16 a 1-ref model still caps at 1, not 5', off(7, 1).distinctCap, 1);
  // And the opt-in repeat path keeps its own, older ceiling untouched.
  check('C16 the opt-in repeat path still caps at 3 distinct + primary',
    JSON.stringify(referenceStackBudget({ effectiveMax: 5, modelMax: 7, repeatEnabled: true })),
    JSON.stringify({ distinctCap: 3, totalCap: 4 }));
}

// ── Report ────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPostPilotBatch: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
  process.exit(1);
}
console.log(`\n✅ verifyPostPilotBatch: ${total}/${total} checks passed`);
console.log('   CHANGE 1 atomic rating pair · CHANGE 2 the FULL 134db56 prompt rollback:');
console.log('   subject continuity + return-to-primary + crossfade policy all pinned ABSENT,');
// Never assert byte-identity the run did not actually prove — B14 skips when the
// 134db56~1 baseline is unreachable (shallow clone / rewritten history / tarball).
if (b14Ran) {
  console.log('   prompt byte-identical to 134db56~1 (owner revert 2026-08-03 — hallucination)');
} else {
  console.log(`   ⚠️  byte-identity NOT verified this run — B14 skipped: ${b14SkipReason}`);
  console.log('      keyword pins passed, but "is the old prompt" was NOT proven.');
}
console.log('   · CHANGE 3 primary repeat DEFAULT OFF (3 distinct refs), opt-in cap 4');
