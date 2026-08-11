#!/usr/bin/env node
'use strict';
/**
 * verifyPromptCapGuard — the video prompt cap is checked in BYTES, at every layer that has one,
 * and the layer that actually knows the resolved model refuses to submit a known-over-cap prompt.
 *
 * THE BUG. Three independent length checks on the same conceptual field all used `.length`
 * (UTF-16 code units) against a byte-oriented policy number:
 *   - routes/ads.js parsePhase3WizardFields (the wizard's videoPromptRaw)
 *   - services/adRegenerateService.js parseRegenVideoPromptFields (the regenerate screen's copy)
 *   - services/veoPromptBuilder.js's enforceByteCap / enforceRawByteCap already used bytes
 *     correctly for the COMPOSED prompt — but that only matters after routing decides a Grok-
 *     class model was picked, and it fails OPEN (warns "Atlas will reject", returns the over-cap
 *     string anyway) rather than refusing.
 *
 * A char count under-protects non-ASCII text: 4000 CJK characters can be well over 4096 bytes.
 * The two route-layer checks are NOT model-aware (a single wizard run can resolve different
 * models per ad/product via the cascade in resolveVideoModel), so they can only enforce a shared
 * FLOOR under the tightest selectable model's policy — not a per-model cap. That floor's numeric
 * value (4000) was already correctly derived (veoPromptBuilder's DEFAULT_BYTE_CAP 4096 minus its
 * BYTE_CAP_MARGIN 96); only the unit was wrong.
 *
 * THE REAL GATE is atlasVideoService.promptCapViolation, called inside submitGeneration — the one
 * place a model IS resolved and the actual bytes that would be POSTed are known. It throws before
 * any HTTP call, so refusing here costs nothing and creates no billing ambiguity, whatever Atlas's
 * exact accept-vs-charge behavior turns out to be.
 *
 * No DB, no network, no API key. Safe in CI.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ads   = require(path.join(__dirname, '..', 'routes/ads.js'));
const regen = require(path.join(__dirname, '..', 'services/adRegenerateService.js'));
const avs   = require(path.join(__dirname, '..', 'services/atlasVideoService.js'));

const avsPath = path.join(__dirname, '..', 'services/atlasVideoService.js');
const avsSrc  = fs.readFileSync(avsPath, 'utf8');
// submitGeneration is deliberately unexported (C8), so the wiring between it and
// promptCapViolation can only be checked structurally, not behaviourally. This is exactly the
// gap a first draft of this suite missed: C2-C6 exercise promptCapViolation in isolation, which
// still pass even if submitGeneration never calls it — proven by revert-proving this file
// (removing only the call site inside submitGeneration left every check above C8 green).
const sgStart = avsSrc.indexOf('async function submitGeneration');
const sgEnd   = sgStart >= 0 ? avsSrc.indexOf('\nasync function ', sgStart + 10) : -1;
const submitGenerationSrc = sgStart >= 0 && sgEnd > sgStart ? avsSrc.slice(sgStart, sgEnd) : '';

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// 1334 * 3 bytes ('龍' is a 3-byte UTF-8 codepoint) = 4002 bytes, but 1334 CODE UNITS — under the
// old char-based 4000 ceiling, over the correct byte one. This is the fixture that actually
// distinguishes the bug from the fix; an ASCII-only fixture cannot, since 1 char == 1 byte there.
const cjkChar = '龍';
const cjkOverBudget   = cjkChar.repeat(1334);  // 4002 bytes, 1334 chars
const cjkUnderBudget  = cjkChar.repeat(1000);  // 3000 bytes, 1000 chars

console.log('\nverifyPromptCapGuard\n');

// ── A. routes/ads.js — the wizard's videoPromptRaw ──────────────────────────
check('A1 parsePhase3WizardFields is exported and callable', () => {
  assert.strictEqual(typeof ads.parsePhase3WizardFields, 'function');
});
check('A2 exactly at the ASCII byte boundary (4000) is accepted', () => {
  assert.strictEqual(ads.parsePhase3WizardFields({ videoPromptRaw: 'a'.repeat(4000) }).ok, true);
});
check('A3 one byte over (4001 ASCII) is rejected', () => {
  const r = ads.parsePhase3WizardFields({ videoPromptRaw: 'a'.repeat(4001) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bytes/, 'error message must name bytes, not characters — units matter here');
});
check('A4 THE BUG FIXTURE — a CJK string under the char ceiling but over the byte one is rejected', () => {
  const r = ads.parsePhase3WizardFields({ videoPromptRaw: cjkOverBudget });
  assert.strictEqual(cjkOverBudget.length < 4000, true, 'fixture is not actually under the old char ceiling');
  assert.strictEqual(Buffer.byteLength(cjkOverBudget, 'utf8') > 4000, true, 'fixture is not actually over the byte ceiling');
  assert.strictEqual(r.ok, false,
    'a 1334-character CJK string (4002 bytes) was accepted — the check is STILL counting ' +
    'characters, not bytes, and non-ASCII overrides are unprotected');
});
check('A5 a CJK string genuinely under both ceilings is accepted (no false positive)', () => {
  assert.strictEqual(ads.parsePhase3WizardFields({ videoPromptRaw: cjkUnderBudget }).ok, true);
});
check('A6 non-string input is rejected, not coerced', () => {
  assert.strictEqual(ads.parsePhase3WizardFields({ videoPromptRaw: 12345 }).ok, false);
});
check('A7 the guidance field (unrelated to this bug) is untouched — still char-based, still 1000', () => {
  // Deliberately NOT converted (see the corrected design's rationale): it desyncs from the
  // frontend's maxLength=1000 counting .length, and it never reaches Atlas directly the way the
  // raw override does. This check pins that scope boundary so a future "harmonize everything to
  // bytes" pass doesn't silently break the guidance field's contract.
  assert.strictEqual(ads.parsePhase3WizardFields({ videoPromptGuidance: 'a'.repeat(1000) }).ok, true);
  assert.strictEqual(ads.parsePhase3WizardFields({ videoPromptGuidance: 'a'.repeat(1001) }).ok, false);
});

// ── B. services/adRegenerateService.js — the regenerate screen's copy of the same field ────
check('B1 parseRegenVideoPromptFields is exported and callable', () => {
  assert.strictEqual(typeof regen.parseRegenVideoPromptFields, 'function');
});
check('B2 exactly at the ASCII byte boundary (4000) is accepted', () => {
  assert.strictEqual(regen.parseRegenVideoPromptFields({ videoPromptRaw: 'a'.repeat(4000) }).ok, true);
});
check('B3 one byte over (4001 ASCII) is rejected', () => {
  assert.strictEqual(regen.parseRegenVideoPromptFields({ videoPromptRaw: 'a'.repeat(4001) }).ok, false);
});
check('B4 THE BUG FIXTURE, second copy — same CJK case must be rejected here too', () => {
  const r = regen.parseRegenVideoPromptFields({ videoPromptRaw: cjkOverBudget });
  assert.strictEqual(r.ok, false,
    'the regenerate screen has its OWN copy of this validator (parseRegenVideoPromptFields) — ' +
    'fixing routes/ads.js alone leaves this path open');
});
check('B5 the two validators agree at the boundary (wizard and regenerate must not diverge)', () => {
  for (const len of [3998, 3999, 4000, 4001, 4002]) {
    const a = ads.parsePhase3WizardFields({ videoPromptRaw: 'a'.repeat(len) }).ok;
    const b = regen.parseRegenVideoPromptFields({ videoPromptRaw: 'a'.repeat(len) }).ok;
    assert.strictEqual(a, b, `wizard and regenerate disagree at length=${len}: wizard=${a} regen=${b}`);
  }
});
check('B6 VIDEO_PROMPT_RAW_MAX is still exactly 4000 (unchanged — only the unit was wrong)', () => {
  // Pins the corrected-design constraint: this was a byte/char bug, not a "the number was wrong"
  // bug. scripts/verifyRegeneration.js:470 (R4b) already asserts this independently; restated
  // here so a reader of THIS suite doesn't have to cross-reference to see the value held.
  assert.strictEqual(regen.VIDEO_PROMPT_RAW_MAX, 4000);
});

// ── C. services/atlasVideoService.js — the real gate, at the resolved model ─────────────────
check('C1 promptCapViolation is exported and callable', () => {
  assert.strictEqual(typeof avs.promptCapViolation, 'function');
});
check('C2 under the resolved model\'s cap -> null (no violation)', () => {
  assert.strictEqual(avs.promptCapViolation('short prompt', { promptByteCap: 4096 }), null);
});
check('C3 over the resolved model\'s cap -> a violation with the real numbers', () => {
  const v = avs.promptCapViolation('x'.repeat(5000), { promptByteCap: 4096 });
  assert.ok(v, 'expected a violation object, got null');
  assert.strictEqual(v.bytes, 5000);
  assert.strictEqual(v.cap, 4096);
});
check('C4 exactly at the cap is NOT a violation (off-by-one must favour the caller)', () => {
  assert.strictEqual(avs.promptCapViolation('x'.repeat(4096), { promptByteCap: 4096 }), null);
});
check('C5 one byte over is a violation', () => {
  assert.ok(avs.promptCapViolation('x'.repeat(4097), { promptByteCap: 4096 }));
});
check('C6 a model with NO known cap (promptByteCap missing/non-finite) never violates', () => {
  // Absence of a cap is "nothing to enforce", not "cap of 0". A model MODEL_CAPS entry that
  // omits promptByteCap must not brick every submit to it.
  assert.strictEqual(avs.promptCapViolation('x'.repeat(999999), {}), null);
  assert.strictEqual(avs.promptCapViolation('x'.repeat(999999), { promptByteCap: null }), null);
  assert.strictEqual(avs.promptCapViolation('x'.repeat(999999), { promptByteCap: NaN }), null);
  assert.strictEqual(avs.promptCapViolation('x'.repeat(999999), null), null);
});
check('C7 the two Omni video slugs really do carry a 20000 cap (the number this all protects)', () => {
  // Re-derives MODEL_CAPS from the module rather than restating the number, so a future change to
  // Omni's cap fails here instead of silently drifting from the comment claiming 20000. Anchored
  // on the OBJECT KEY (`'<slug>': {`), not any mention of the slug — the slug also appears in a
  // header comment and in BUILT_IN_DEFAULT_MODEL, neither of which is near promptByteCap.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'services/atlasVideoService.js'), 'utf8');
  for (const slug of [
    'google/gemini-omni-flash/image-to-video-developer',
    'google/gemini-omni-flash/reference-to-video-developer',
  ]) {
    const keyAt = src.indexOf(`'${slug}': {`);
    assert.ok(keyAt >= 0, `MODEL_CAPS no longer has an entry for ${slug}`);
    const block = src.slice(keyAt, src.indexOf('\n  },', keyAt));
    assert.ok(/promptByteCap:\s*20000/.test(block), `${slug} no longer declares a 20000 promptByteCap`);
  }
});
check('C8 submitGeneration itself is NOT exported (network path must stay out of this harness)', () => {
  assert.strictEqual(avs.submitGeneration, undefined,
    'submitGeneration got exported — this suite should still work through promptCapViolation ' +
    'alone; exporting the network-calling function widens what a test double could accidentally ' +
    'reach');
});

// ── D. THE WIRING — submitGeneration must actually call the gate, and call it early ────────
check('D1 the slice was located (else D2/D3 are checking nothing)', () => {
  assert.ok(submitGenerationSrc.length > 500,
    'could not slice submitGeneration — it was renamed or restructured, so D2/D3 prove nothing');
});
check('D2 submitGeneration calls promptCapViolation and throws on a violation', () => {
  assert.ok(/promptCapViolation\s*\(/.test(submitGenerationSrc),
    'submitGeneration no longer calls promptCapViolation — C2-C6 test the predicate in ' +
    'isolation and will stay green even though nothing wires it in. This is not hypothetical: ' +
    'removing only this call site (leaving the predicate function intact) leaves every check ' +
    'above D1 passing.');
  const callAt  = submitGenerationSrc.search(/promptCapViolation\s*\(/);
  const throwAt = submitGenerationSrc.indexOf('throw', callAt);
  assert.ok(callAt >= 0 && throwAt > callAt,
    'promptCapViolation is called but no throw follows it — a violation would be computed and ignored');
});
check('D3 the throw happens BEFORE buildSubmissionBody / the axios POST, not after', () => {
  const throwAt = submitGenerationSrc.search(/promptCapViolation\s*\([\s\S]*?throw/);
  const bodyAt  = submitGenerationSrc.indexOf('buildSubmissionBody');
  const postAt  = submitGenerationSrc.indexOf('axios.post');
  assert.ok(throwAt >= 0 && bodyAt > throwAt && postAt > throwAt,
    'the cap check runs after the submission body is built or after the POST — refusing late ' +
    'still risks the side effect this guard exists to prevent');
});

if (failures.length) {
  console.error(`❌ verifyPromptCapGuard: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyPromptCapGuard: ${pass}/${pass} checks passed`);
console.log('   prompt-length checks are byte-based end to end; the resolved-model gate refuses before submit');
