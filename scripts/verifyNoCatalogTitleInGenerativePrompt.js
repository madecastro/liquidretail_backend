#!/usr/bin/env node
'use strict';

/**
 * verifyNoCatalogTitleInGenerativePrompt — MONEY pin for the Vaportek bug.
 *
 * Incident (2026-08-26, visually proven on a delivered Pelagic Gear master):
 * `Product: Vaportek.` was interpolated into the Omni camera prompt from
 * CatalogProduct.title. Omni fabricated a complete "VAPORTEK" chest lockup
 * and a fake neck tag over the real small PELAGIC fish-mark. Vision-QC
 * correctly terminal-rejected the $0.90 master with no regeneration.
 *
 * `noText` already forbids generating new logos — it was not enough once a
 * brand-sounding catalog title sat in a labelled `Product:` field.
 * PRODUCT FIDELITY + the supplied images already identify the SKU.
 *
 * adgen closed the camera-prompt door (liquidretail_adgen#70). Backend's
 * generateForAd is the dormant ADGEN_RENDERER_ENABLED=true fallback, but a
 * flag-off revival, the Vertex storyboard arm, or any future backend submit
 * re-opens the same $0.90 hallucination. This harness pins BOTH builders:
 *
 *   services/veoPromptBuilder.js      — live camera prompt (buildVeoPrompt)
 *   services/veoStoryboardService.js  — GPT-storyboard user prompt
 *                                      (VIDEO_PROVIDER=vertex only)
 *
 * WHAT IS FORBIDDEN: a template literal interpolating into a labelled
 * `Product:` field (`Product: ${…}`). That is the construct Omni treated
 * as a brand-name render instruction.
 *
 * HOW IT IS SCANNED: comment-stripped, string-aware (regex-literal-aware
 * tokenizer). A bare substring over raw source would fail the moment a
 * comment documenting the incident wrote `Product: ${title}` — the exact
 * trap this repo has shipped on (`receiptFree`, tools: google_search).
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyNoCatalogTitleInGenerativePrompt.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(ROOT, 'services', 'veoPromptBuilder.js');
const STORYBOARD = path.join(ROOT, 'services', 'veoStoryboardService.js');

const { buildVeoPrompt } = require(BUILDER);

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// ── tokenizer (copied shape from verifyGroundedGeminiLedger.js) ──────────
// classifySource → Uint8Array parallel to src:
//   0 = real code     1 = string/template/regex-literal BODY     2 = comment
//
// Regex-literal aware: a naive quote-tracker desyncs on
//   .replace(/^['"]|['"]$/g, '')
// and then treats a later `//` as still-inside-a-string, so a comment
// containing the forbidden construct would survive "stripping" and the
// pin would go red on documentation. Same class as CLAUDE.md §4.
function classifySource(src) {
  const kind = new Uint8Array(src.length);
  let mode = null;
  let lastSig = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === "'" || c === '"' || c === '`') { mode = c; kind[i] = 1; continue; }
      if (c === '/' && n === '/') { mode = '//'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && !/[A-Za-z0-9_$)\]\}]/.test(lastSig)) { mode = 'regex'; kind[i] = 1; continue; }
      if (!/\s/.test(c)) lastSig = c;
      continue;
    }
    if (mode === '//') {
      kind[i] = 2;
      if (c === '\n') mode = null;
      continue;
    }
    if (mode === '/*') {
      kind[i] = 2;
      if (c === '*' && n === '/') { kind[i + 1] = 2; i++; mode = null; }
      continue;
    }
    if (mode === 'regex' || mode === 'regexClass') {
      kind[i] = 1;
      if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
      if (mode === 'regex' && c === '[') { mode = 'regexClass'; continue; }
      if (mode === 'regexClass' && c === ']') { mode = 'regex'; continue; }
      if (mode === 'regex' && c === '/') {
        mode = null; lastSig = '/';
        while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) { i++; kind[i] = 1; }
      }
      continue;
    }
    kind[i] = 1;
    if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
    if (c === mode) { mode = null; lastSig = c; }
  }
  return kind;
}

function stripComments(src) {
  const kind = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    out += kind[i] === 2 ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  }
  return out;
}

// Opening backtick of a labelled Product: template interpolation.
// Discriminates live code from comments documenting `Product: {title}` /
// `Product: Vaportek.` (neither has `${`).
const FORBIDDEN = /`Product:\s*\$\{/;

function catalogTitleInterpolations(src) {
  const stripped = stripComments(src);
  const hits = [];
  const re = new RegExp(FORBIDDEN.source, 'g');
  let m;
  while ((m = re.exec(stripped)) !== null) hits.push(m.index);
  return hits;
}

const FORBIDDEN_LIVE = 'lines.push(`Product: ${product.title}.`);';
const FORBIDDEN_STORYBOARD = 'lines.push(`Product: ${product?.title || \'(untitled product)\'}`);';

console.log('\nverifyNoCatalogTitleInGenerativePrompt\n');

console.log('A. scanner is comment-stripped and string-aware (not a bare substring)');

check('A1 a live `Product: ${` template is detected', () => {
  const hits = catalogTitleInterpolations(
    `function build() {\n  ${FORBIDDEN_LIVE}\n}\n`
  );
  assert.strictEqual(hits.length, 1, `expected 1 hit, got ${hits.length}`);
});

check('A2 the same construct inside a line-comment is NOT a hit', () => {
  const hits = catalogTitleInterpolations(
    `function build() {\n  // ${FORBIDDEN_LIVE}\n  return 1;\n}\n`
  );
  assert.strictEqual(hits.length, 0,
    'comment-strip failed: a documenting comment would fail the pin');
});

check('A3 the same construct inside a block-comment is NOT a hit', () => {
  const hits = catalogTitleInterpolations(
    `function build() {\n  /* ${FORBIDDEN_LIVE} */\n  return 1;\n}\n`
  );
  assert.strictEqual(hits.length, 0);
});

check('A4 a regex literal with quotes does not desync later comment-stripping', () => {
  // The productDetailsService.js:56 class: four quotes inside a regex.
  // If the tokenizer treats them as strings, the later `//` is no longer
  // a comment and A2-class documentation would leak into the scan.
  const src = [
    'const _key = _rawKey.trim().replace(/^[\x27"]|[\x27"]$/g, \'\');',
    `// ${FORBIDDEN_LIVE}`,
    'function build() { return 1; }',
    ''
  ].join('\n');
  assert.strictEqual(catalogTitleInterpolations(src).length, 0,
    'regex-literal desync: a later comment survived stripping');
});

check('A5 a single-quoted string containing the characters is still a hit on the CODE template only', () => {
  const src = [
    "const note = 'never write Product: ${title} as a labelled field';",
    `function build() {\n  ${FORBIDDEN_LIVE}\n}`,
    ''
  ].join('\n');
  // The single-quoted string uses no opening backtick, so FORBIDDEN
  // (which requires a backtick) does not match it. The live template does.
  assert.strictEqual(catalogTitleInterpolations(src).length, 1);
});

console.log('\nB. both generative-prompt builders have zero interpolations');

const builderSrc = fs.readFileSync(BUILDER, 'utf8');
const storyboardSrc = fs.readFileSync(STORYBOARD, 'utf8');

check('B1 services/veoPromptBuilder.js has zero `Product: ${` templates', () => {
  const hits = catalogTitleInterpolations(builderSrc);
  assert.strictEqual(hits.length, 0,
    `forbidden template still present (${hits.length} hit(s)) — Vaportek door is open`);
});

check('B2 services/veoStoryboardService.js has zero `Product: ${` templates', () => {
  const hits = catalogTitleInterpolations(storyboardSrc);
  assert.strictEqual(hits.length, 0,
    `forbidden template still present (${hits.length} hit(s)) — Vertex arm still interpolates catalog title`);
});

check('B3 DROP_PRIORITY no longer leads with /^Product: /', () => {
  const stripped = stripComments(builderSrc);
  assert.ok(!/DROP_PRIORITY\s*=\s*\[[^\]]*\/\^Product:/.test(stripped),
    'Product: line was removed from the builder but left as the first droppable — do not put a titled Product line back just to have something cheap to drop');
});

check('B4 the Vaportek incident comment is still next to the removal site', () => {
  assert.ok(/Vaportek/.test(builderSrc),
    'the explanatory comment was dropped — port adgen\'s incident note, do not silently delete the line');
  assert.ok(/Catalog title is NEVER interpolated/i.test(builderSrc));
});

console.log('\nC. assembled camera prompt does not leak a catalog title (behavioural)');

{
  const TITLE = 'Vaportek Hooded Fishing Shirt';
  const args = {
    product: { title: TITLE },
    hasProductReference: true,
    durationSec: 10,
    seedHasText: false,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' },
    aspectRatio: '9:16',
    platformFormat: 'meta_stories_9_16',
  };
  const prompt = buildVeoPrompt(args);

  check('C1 Omni-cap Meta prompt does not contain the catalog title', () => {
    assert.ok(!new RegExp(TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(prompt),
      `catalog title leaked into the camera prompt: ${TITLE}`);
  });

  check('C2 Omni-cap Meta prompt has no labelled `Product:` field', () => {
    assert.ok(!/(^|\s)Product: /.test(prompt),
      'labelled Product: field is back — that is the Vaportek construct');
  });

  check('C3 4096-cap prompt also has no labelled `Product:` field (not a budget drop)', () => {
    const grok = buildVeoPrompt({ ...args, caps: { promptByteCap: 4096 } });
    assert.ok(!/(^|\s)Product: /.test(grok));
    assert.ok(!/vaportek/i.test(grok));
  });
}

console.log('\nD. revert-prove — re-inserting the line fails B1/B2 (in-memory, no file write)');

check('D1 re-inserting the camera-prompt line into a copy of veoPromptBuilder.js is detected', () => {
  const mutated = builderSrc.replace(
    'lines.push(d.productPreservation);',
    `lines.push(d.productPreservation);\n  ${FORBIDDEN_LIVE}`
  );
  assert.ok(mutated !== builderSrc, 'mutation did not take — anchor missing');
  const hits = catalogTitleInterpolations(mutated);
  assert.ok(hits.length >= 1,
    'scanner stayed green after the Vaportek line was put back — the pin cannot fail');
});

check('D2 re-inserting the storyboard line into a copy of veoStoryboardService.js is detected', () => {
  const mutated = storyboardSrc.replace(
    'const lines = [];',
    `const lines = [];\n  ${FORBIDDEN_STORYBOARD}`
  );
  assert.ok(mutated !== storyboardSrc, 'mutation did not take — anchor missing');
  const hits = catalogTitleInterpolations(mutated);
  assert.ok(hits.length >= 1,
    'scanner stayed green after the storyboard title interpolation was put back');
});

check('D3 a documenting comment of the forbidden construct does NOT fail B1', () => {
  const documented = builderSrc.replace(
    'lines.push(d.productPreservation);',
    `lines.push(d.productPreservation);\n  // ${FORBIDDEN_LIVE}`
  );
  assert.strictEqual(catalogTitleInterpolations(documented).length, 0,
    'a comment describing the removed line would fail a bare-substring pin');
});

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyNoCatalogTitleInGenerativePrompt: ${failures.length} of ${total} checks FAILED\n`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log(`\n✅ verifyNoCatalogTitleInGenerativePrompt: ${total}/${total} checks passed`);
