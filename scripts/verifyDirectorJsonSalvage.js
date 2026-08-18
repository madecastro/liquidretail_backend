#!/usr/bin/env node
'use strict';
//
// verifyDirectorJsonSalvage — pins the Director round's JSON contract to the
// PROMPT plus a salvage parser, not to `response_format`.
//
// WHY THIS EXISTS (2026-08-04 production defect):
//   The director role maps to anthropic/claude-sonnet-5-ccmax
//   (atlasModelMap.js:95). The round call sets
//   response_format:{type:'json_object'} and TRUSTED it. Atlas SILENTLY
//   IGNORES that flag for Anthropic models — probed live 2026-08-04, both
//   with and without the flag, and both arms returned conversational prose.
//   The round system prompt never independently demanded JSON, so compliance
//   was luck. On thin-signal SKUs Claude answered with clarifying questions:
//     📦 conceptDriven[product=…]: failed (Director (round) response not
//        JSON: Unexpected token 'A', "A couple o"... is not valid JSON)
//   Measured over 24h on the web service: 10 failures, 1 success. Each
//   failure is a product that produced ZERO ads.
//
//   Worse, the handler was ASYMMETRIC: a schema-validation miss re-asked the
//   model once, but a JSON parse failure threw immediately with no salvage
//   and no retry — no recovery for the far more common failure.
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyDirectorJsonSalvage.js
//
// Revert-prove (three independent mutations, each must fail this harness):
//   1. In aiCreativeDirectorService.safeParseDirectorJSON, delete the
//      extractFirstBalancedObject branch and let a bare JSON.parse throw.
//      The P* prose-salvage assertions fail.
//   2. In the round loop, change the parse-failure branch back to an
//      unconditional `throw` (drop the re-ask). The R* assertions fail.
//   3. Delete the OUTPUT CONTRACT block from buildPromptRound's system
//      array. The C* assertions fail.
//   Restoring each makes them pass. Report failing output verbatim.
//
// Covered:
//   P*  safeParseDirectorJSON salvages fenced / prose-wrapped JSON, and is
//       string-aware so a brace or quote inside a string cannot end it early
//   N*  a pure refusal with NO JSON still throws (salvage must not invent)
//   C*  the system prompt carries an explicit JSON-only OUTPUT CONTRACT and
//       an explicit thin-data rule, since the gateway flag is a no-op
//   R*  the parse failure path re-asks EXACTLY ONCE, sharing the `attempt`
//       budget with the validation re-ask
//   M*  MONEY: worst case stays TWO paid Director calls per (product, round)

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const {
  safeParseDirectorJSON,
  extractFirstBalancedObject,
  buildPromptRound
} = require('../services/aiCreativeDirectorService');

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}
function checkDeep(label, actual, expected) {
  checkTrue(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
// Salvage assertions must report a FAIL, not crash the harness — a removed
// salvage branch throws, and a revert-proof has to stay readable.
function checkParse(label, input, expected) {
  let actual;
  try { actual = safeParseDirectorJSON(input); }
  catch (err) { failures.push(`${label} — threw: ${err.message}`); return; }
  checkDeep(label, actual, expected);
}
function checkThrows(label, fn) {
  try { fn(); failures.push(`${label} — expected a throw, got a value`); }
  catch { pass++; }
}

// ── P: salvage ───────────────────────────────────────────────────────

checkParse('P1 plain JSON object parses',
  ('{"concepts":[1]}'), { concepts: [1] });

checkParse('P2 ```json fenced object parses',
  ('```json\n{"concepts":[1]}\n```'), { concepts: [1] });

checkParse('P3 bare ``` fenced object parses',
  ('```\n{"concepts":[1]}\n```'), { concepts: [1] });

// The exact production shape: Claude preamble, then the object.
checkParse('P4 prose BEFORE the object is stripped',
  ('A couple of things first.\n\n{"concepts":[{"a":1}]}'),
  { concepts: [{ a: 1 }] });

checkParse('P5 prose AFTER the object is stripped',
  ('{"concepts":[{"a":1}]}\n\nHope that helps!'),
  { concepts: [{ a: 1 }] });

checkParse('P6 prose on BOTH sides is stripped',
  ('Before I generate:\n{"concepts":[{"a":1}]}\nLet me know.'),
  { concepts: [{ a: 1 }] });

// String-awareness — a greedy /\{[\s\S]*\}/ would mis-slice these.
checkParse('P7 a closing brace INSIDE a string does not end the object',
  ('{"concepts":[{"headline":"a } brace"}]}'),
  { concepts: [{ headline: 'a } brace' }] });

checkParse('P8 an ESCAPED QUOTE inside a string is handled',
  ('{"h":"say \\"hi\\" }"}'), { h: 'say "hi" }' });

checkParse('P9 nested objects close at the right depth',
  ('noise {"a":{"b":{"c":1}}} noise'),
  { a: { b: { c: 1 } } });

// An escaped BACKSLASH before a quote means the quote really does close.
checkParse('P10 escaped backslash does not swallow the closing quote',
  ('{"p":"C:\\\\"}'), { p: 'C:\\' });

// ── A: adversarial-review defects (2026-08-04) — must stay fixed ─────
//
// Committing to the FIRST '{' is defeated by prose that merely contains
// braces. All three of these were live defects in the first draft of the
// salvage and were caught by an adversarial review pass.

checkParse('A1 prose braces BEFORE the real object do not defeat salvage',
  ('I considered {option A} vs {option B}.\n{"concepts":[{"id":"good"}]}'),
  { concepts: [{ id: 'good' }] });

checkParse('A2 a leading decoy object does not win over the real payload',
  ('Sketch: {"concepts":[{"id":"decoy"}]}. Real: {"concepts":[{"id":"real"}]}'),
  { concepts: [{ id: 'real' }] });

// JSON5 permits single-quoted strings and this salvage falls back to JSON5,
// so the brace scanner must track BOTH quote characters or it cuts the span
// at a brace inside a single-quoted value.
checkParse('A3 a brace inside a SINGLE-quoted string does not end the object',
  ("{'note': 'use } here', 'concepts': []}"),
  { note: 'use } here', concepts: [] });

checkTrue('A4 the scanner tracks both quote characters',
  /c === '"' \|\| c === "'"/.test(SRC));
checkTrue('A5 salvage scans every candidate span, not just the first',
  /withConcepts\[withConcepts\.length - 1\]/.test(SRC));

// ── N: refusal must NOT be salvaged into something ───────────────────

checkThrows('N1 pure refusal prose throws',
  () => safeParseDirectorJSON("I don't have enough information to generate concepts."));
checkThrows('N2 empty string throws', () => safeParseDirectorJSON(''));
checkThrows('N3 whitespace-only throws', () => safeParseDirectorJSON('   \n  '));
checkThrows('N4 null throws', () => safeParseDirectorJSON(null));
checkThrows('N5 unterminated object throws', () => safeParseDirectorJSON('{"a":1'));

checkTrue('N6 extractFirstBalancedObject returns null when there is no object',
  extractFirstBalancedObject('no braces here') === null);
checkTrue('N7 extractFirstBalancedObject returns null on an unbalanced object',
  extractFirstBalancedObject('{"a":1') === null);

// ── C: the prompt, not the gateway flag, carries the contract ────────

const { system, user } = buildPromptRound({
  inputSummary: { product_signal: { name: 'Test Product' } },
  creativeIntent: null,
  platformFormat: 'meta_feed_1_1',
  universe: [],
  avoid: []
});

checkTrue('C1 system prompt declares an OUTPUT CONTRACT',
  /OUTPUT CONTRACT/.test(system));
checkTrue('C2 system prompt forbids prose around the JSON',
  /No prose before or after/i.test(system));
checkTrue('C3 system prompt forbids clarifying questions',
  /no clarifying questions/i.test(system) || /Do NOT ask the operator/i.test(system));
// The measured failure mode: the model opening with "I don't have enough
// information". The prompt must name that refusal explicitly.
checkTrue('C4 system prompt names the observed refusal openings',
  /don't have enough information/i.test(system));
checkTrue('C5 system prompt says thin data is NOT a reason to stop',
  /THIN DATA IS NOT A STOP/i.test(system));
checkTrue('C6 user turn also demands JSON only',
  /Return ONLY a JSON object/i.test(user));

// ── R: the parse-failure re-ask, sharing one budget ──────────────────

checkTrue('R1 a parse failure re-asks instead of throwing unconditionally',
  /response not JSON, re-asking once/.test(SRC));
checkTrue('R2 the re-ask tells the model it returned prose',
  /returned prose or clarifying questions/.test(SRC));
checkTrue('R3 the re-ask instructs best-effort output on thin signal',
  /still emit best-effort concepts/.test(SRC));
checkTrue('R4 salvage runs before the failure is treated as fatal',
  /parsed = safeParseDirectorJSON\(raw\)/.test(SRC));
checkTrue('R5 truncation stays a DISTINCT hard failure (a re-ask cannot fix it)',
  /finish_reason === 'length'/.test(SRC) && /response truncated at/.test(SRC));

// ── M: MONEY — worst case must stay TWO paid calls ───────────────────

// The parse-failure branch must be gated on the SAME `attempt >= 1` budget as
// the validation re-ask. Two independent budgets would allow 4 paid calls.
//
// REWRITTEN 2026-08-18 — and the first rewrite was WRONG, which is worth
// recording. The original pattern required byte-adjacency:
//     /if \(attempt >= 1\) \{\s*throw new Error\(`Director \(round\) response not JSON/
// That blocked giving this failure an LLM error code (`adoptLlmFailure(...)`),
// which is what makes a zero-ads content failure page instead of vanishing.
// The obvious loosening — allow up to 200 chars between the gate and the throw
// — was caught by its own revert-proof: a mutation that CLOSED the gate and
// moved the throw immediately after it still matched, so the pin no longer
// pinned anything. Proximity is not containment.
//
// So: find the gate, walk its braces, and require the throw to be INSIDE the
// block. Immune to a wrapper call, and fails the moment the throw escapes.
function gateBodyFor(src, gate) {
  const at = src.indexOf(gate);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + gate.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}
const parseGateBody = gateBodyFor(SRC, 'if (attempt >= 1) {');
checkTrue('M1 parse retry is gated on the shared attempt budget',
  !!parseGateBody && /`Director \(round\) response not JSON/.test(parseGateBody),
  parseGateBody ? 'gate found but the throw is not inside it' : 'no `if (attempt >= 1) {` gate at all');

// And the throw must exist exactly once overall — a second site outside the
// gate would double the ceiling while the check above still passed.
// Count THROW SITES, not mentions: the string also appears in the comment that
// explains this pin, and a naive count reads that as a second throw.
const parseThrows = (SRC.match(/throw [\s\S]{0,160}?`Director \(round\) response not JSON/g) || []).length;
checkTrue('M1b exactly one parse-failure throw site (a second would double the ceiling)',
  parseThrows === 1, `found ${parseThrows}`);

checkTrue('M2 validation retry still breaks at the same budget',
  /if \(!reasons\.length \|\| attempt >= 1\) break;/.test(SRC));

// Exactly ONE chatCompletion submit site in the round loop — a second submit
// site would silently double the ceiling.
const roundFn = SRC.slice(SRC.indexOf('creative_director_round') - 2000);
const submitSites = (roundFn.match(/await chatCompletion\(/g) || []).length;
checkTrue('M3 the round loop has exactly one chatCompletion submit site',
  submitSites === 1, `found ${submitSites}`);

// Both retry paths must increment the SAME counter, so the ledger can tell
// attempt 0 from attempt 1 and the loop cannot run forever.
const incs = (SRC.match(/\n\s*attempt\+\+;/g) || []).length;
checkTrue('M4 both retry paths increment the shared attempt counter',
  incs === 2, `found ${incs} attempt++ sites`);

// ── report ───────────────────────────────────────────────────────────

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyDirectorJsonSalvage: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyDirectorJsonSalvage: ${pass}/${total} passed`);
process.exit(0);
