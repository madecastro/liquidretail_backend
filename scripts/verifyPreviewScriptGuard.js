#!/usr/bin/env node
'use strict';
/**
 * verifyPreviewScriptGuard — no HTTP route may reach the brand-script VM escape (GEN-1).
 *
 * THE HOLE THIS PINS SHUT. POST /api/brand/:id/preview-script could render a "canvas" preview,
 * which used to hand a brand script to brandScriptRunner.child.js (deleted, STRIP-INVENTORY
 * PR-B2) `vm.compileFunction` with NO parsingContext, so the compiled body resolved free
 * identifiers against the LIVE V8 global. The route guard remains: restoring a canvas runner
 * without it would reopen GEN-1. Authentication does not mitigate it: the attacker supplies
 * the script for a brand they own.
 *
 * Adding `parsingContext` would NOT fix it — the injected params are parent-realm objects, so
 * `helpers.clamp.constructor("return process")()` escapes a fresh context anyway. The engine guard
 * is the control, not the VM options.
 *
 * THREE doors reached it, and a fix that closes only the first leaves a two-request exploit:
 *   1. body.script                -> forces engine 'canvas' outright
 *   2. body.engine:'canvas'       -> the bodyEngine escape hatch, which short-circuits BEFORE
 *                                    resolveTitlingEngine is ever consulted
 *   3. a styleScript* persisted via PATCH /api/brand/:id (routes/brand.js:264-267 allow-lists
 *      styleScript / styleScriptVertical / styleScriptLandscape with no validation), then
 *      previewed with {engine:'canvas'} and no body.script at all
 *
 * A single `engine !== 'remotion'` early return closes all three, and stays closed if
 * resolveTitlingEngine is ever un-hardwired.
 *
 * MIXED ASSERTION STYLE, DELIBERATELY. Section B is behavioural. Sections S/V are source-structure
 * assertions, following the existing W1/W2/W3 precedent at scripts/verifyBasePlateCrop.js:174-186.
 * The invariant here is "no HTTP path reaches this sink", which is a reachability property of the
 * route graph — exercising it behaviourally would mean standing up Express, Mongo and a spawned
 * child process, none of which belongs in an offline suite. Structural checks are weaker; the
 * header says so plainly rather than pretending otherwise.
 *
 * No DB, no network, no API key, no spawn. Safe in CI.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const brandSrc = fs.readFileSync(path.join(ROOT, 'routes/brand.js'), 'utf8');

// The preview-script handler only, so a guard elsewhere in the file cannot satisfy these.
const handler = brandSrc.split("router.post('/:id/preview-script'")[1].split('\nrouter.')[0];

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

console.log('\nverifyPreviewScriptGuard\n');

// ── A. the slice is real (guards against every S check going vacuous) ───────
check('A1 the preview-script handler was actually located and sliced', () => {
  assert.ok(handler && handler.length > 500,
    'could not slice the handler — the route was renamed or restructured, so every structural ' +
    'check below is vacuous and this suite is not protecting anything');
  assert.ok(handler.includes('runPreviewRender'),
    'the slice does not contain runPreviewRender — wrong region captured');
});

// ── B. behavioural: the production selector is hard-wired to remotion ───────
// This is door 3's precondition. If this ever changes, the guard becomes the ONLY thing
// standing between a persisted styleScript and the VM.
check('B1 resolveTitlingEngine returns remotion even for a canvas-preferring brand', () => {
  const { resolveTitlingEngine } = require('../services/brandScriptExecutor');
  for (const brand of [
    {},
    { videoSettings: { titlingEngine: 'canvas' } },
    { videoSettings: { titlingEngine: 'canvas' }, styleScript: 'module.exports=()=>{}' },
  ]) {
    const got = resolveTitlingEngine(brand, { aspectRatio: '4:5' });
    assert.strictEqual(got.engine, 'remotion',
      `resolveTitlingEngine returned '${got.engine}' for ${JSON.stringify(brand)} — canvas has been ` +
      're-enabled on the render path, and the preview guard is now load-bearing on its own');
  }
});

// ── S. the guard exists, and is positioned so it cannot be bypassed ─────────
const GUARD_RE = /if\s*\(\s*engine\s*!==\s*'remotion'\s*\)/;

check('S1 the handler refuses any non-remotion engine', () => {
  assert.ok(GUARD_RE.test(handler),
    "no `if (engine !== 'remotion')` guard in the preview-script handler — body.script, " +
    "body.engine:'canvas', or a persisted styleScript can reach vm.compileFunction");
});

check('S2 the guard returns BEFORE any render is dispatched', () => {
  const guardAt  = handler.search(GUARD_RE);
  const renderAt = handler.indexOf('runPreviewRender');
  assert.ok(guardAt >= 0 && renderAt >= 0, 'guard or dispatch missing');
  assert.ok(guardAt < renderAt,
    `the guard sits at ${guardAt} but runPreviewRender is dispatched at ${renderAt} — a guard ` +
    'after the side effect does not prevent execution');
  // and it must actually return, not merely log
  const afterGuard = handler.slice(guardAt, guardAt + 400);
  assert.ok(/return\s+res\s*\.\s*status\(\s*4\d\d\s*\)/.test(afterGuard),
    'the guard does not return a 4xx — execution falls through into the canvas branch');
});

check('S3 every canvas script SOURCE is downstream of the guard (all three doors)', () => {
  const guardAt = handler.search(GUARD_RE);
  // Assert the guard EXISTS before comparing positions. Without this, a missing guard yields
  // search() === -1 and every `assignment > -1` comparison passes vacuously — caught by
  // revert-proving this suite, which is the whole reason the repo requires it.
  assert.ok(guardAt >= 0, 'no guard present, so "downstream of the guard" is vacuously true');
  // door 1: body.script
  const d1 = handler.indexOf('styleScript = bodyScript');
  // door 3: the persisted brand field
  const d3 = handler.indexOf('styleScript = brand[brandScriptField]');
  assert.ok(d1 > guardAt, `body.script assignment at ${d1} is not after the guard at ${guardAt}`);
  assert.ok(d3 > guardAt, `persisted-script assignment at ${d3} is not after the guard at ${guardAt}`);
});

check('S4 door 2 (the body.engine escape hatch) still short-circuits the hard-wired selector', () => {
  // Not a defect on its own — it is WHY the guard has to key off the resolved `engine` rather
  // than off bodyScript. If this ever stops short-circuiting, S1's guard is still correct, but
  // the reasoning in its comment would be stale.
  assert.ok(/bodyEngine\s*\|\|\s*resolveTitlingEngine/.test(handler),
    'the bodyEngine escape hatch changed shape — re-derive which doors reach the canvas branch ' +
    'before trusting the guard comment');
});

// ── V. door 3 at the PATCH allow-list (the VM runner itself is deleted) ────
check('V2 the PATCH allow-list still persists styleScript unvalidated (door 3 stays open at the sink)', () => {
  // Documents the other half of door 3. The route guard is what makes it harmless; if someone
  // removes the guard believing the field is validated, this check tells them it is not.
  assert.ok(/'styleScript'/.test(brandSrc) && /'styleScriptVertical'/.test(brandSrc),
    'the styleScript* allow-list changed — re-check whether door 3 still exists');
});

function stripComments(src) {
  // Line comments first: a `//` line that mentions `/*.script.js` must not
  // be parsed as the start of a block comment (that swallowed R2's mutation).
  return src
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const RETIRED_410 = /return\s+res\s*\.\s*status\(\s*410\s*\)\s*\.json\(\s*\{\s*error:\s*'canvas script generation retired/;

check('R1 generate-script POST and GET return 410 before any runGenerateFullScript/LLM call', () => {
  const postH = brandSrc.split("router.post('/:id/generate-script'")[1]?.split('\nrouter.')[0] || '';
  const getH  = brandSrc.split("router.get('/:id/generate-script/:jobId'")[1]?.split('\nrouter.')[0] || '';
  assert.ok(postH.length > 40 && getH.length > 40, 'could not slice generate-script POST/GET handlers');
  assert.ok(RETIRED_410.test(postH), 'POST /generate-script does not 410 with the retired error before any work');
  assert.ok(RETIRED_410.test(getH), 'GET /generate-script/:jobId does not 410 with the retired error before any work');
  const postAt = postH.search(RETIRED_410);
  const getAt  = getH.search(RETIRED_410);
  for (const [name, h, at] of [['POST', postH, postAt], ['GET', getH, getAt]]) {
    const before = h.slice(0, at);
    assert.ok(!/runGenerateFullScript/.test(before), `${name} calls runGenerateFullScript before the 410`);
    assert.ok(!/atlasTextService/.test(before) && !/\.generate\s*\(/.test(before),
      `${name} reaches an LLM call before the 410`);
  }
});

check('R2 systemConfigService.js contains no readFileSync of a .script.js path', () => {
  const sysSrc = stripComments(fs.readFileSync(path.join(ROOT, 'services/systemConfigService.js'), 'utf8'));
  assert.ok(!/readFileSync[\s\S]{0,300}\.script\.js/.test(sysSrc),
    'systemConfigService still readFileSyncs a .script.js path — file fallback was supposed to be gone');
});

check('R3 brandScriptExecutor.js has no spawn of a brandScriptRunner path and no previewBrandScriptAsVideo export', () => {
  const bseSrc = stripComments(fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8'));
  assert.ok(!/spawn\s*\([^;]*brandScriptRunner/.test(bseSrc),
    'brandScriptExecutor still spawn()s brandScriptRunner');
  assert.ok(!/RUNNER_PATH/.test(bseSrc),
    'brandScriptExecutor still declares RUNNER_PATH');
  const exportsBlock = bseSrc.split('module.exports')[1] || '';
  assert.ok(!/previewBrandScriptAsVideo/.test(exportsBlock),
    'previewBrandScriptAsVideo is still exported');
});

if (failures.length) {
  console.error(`❌ verifyPreviewScriptGuard: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyPreviewScriptGuard: ${pass}/${pass} checks passed`);
console.log('   no HTTP route reaches a canvas VM (runner deleted; guard remains)');
