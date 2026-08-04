#!/usr/bin/env node
/**
 * Offline harness for the Director's round prompt builder.
 * No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS TO CATCH (2026-08-01, live in production):
 *
 *   services/aiCreativeDirectorService.js buildPromptRound() declares a
 *   parameter named `universe`, but its body read a bare `seededUniverse` —
 *   the name the CALLER uses for the same array. That is an undeclared free
 *   variable, so EVERY fresh Director round threw ReferenceError. Rounds served
 *   from a cached CreativeDirectionArtifact were unaffected, which is why
 *   generation looked intermittently broken rather than broken, and why three
 *   campaign runs finished as done/total:0 with no usable error.
 *
 * WHAT IS AND IS NOT COVERED — read this before trusting a green run.
 *
 *   COVERED: the function is actually CALLED, across every universe size that
 *   changes its arithmetic. A free variable on an executed path throws
 *   ReferenceError and D1 fails. That is what caught the real bug, and it is
 *   sound.
 *
 *   NOT COVERED: a free variable on a branch these inputs never execute.
 *   Catching that needs real scope analysis over an AST.
 *
 *   An earlier draft of this harness carried ~420 lines of hand-rolled
 *   tokenising that claimed to be a general free-variable net. It was removed
 *   after being measured, not on style grounds. It (a) did NOT flag a free
 *   `artifact` that D1 caught — its module-scope regex matched indented locals
 *   anywhere in the 1800-line service, so ~184 common names were treated as
 *   legitimately in scope — and (b) passed 33/33 on a free variable placed on a
 *   non-executed branch, which is the ONE case it existed for. A check that
 *   cannot fail is not a check (CLAUDE.md §5), and a large one that silently
 *   passes is worse than none because it manufactures confidence.
 *
 *   If a general net is ever wanted, use a real parser. `acorn` is present in
 *   node_modules but only TRANSITIVELY (via terser/escodegen) and is not in
 *   package.json — per CLAUDE.md §4 the vendored tree is demonstrably
 *   incomplete, so it must be added as an explicit dependency first rather than
 *   required opportunistically.
 *
 * Run: node scripts/verifyDirectorPrompt.js
 */
const fs = require('fs');
const path = require('path');

const director = require('../services/aiCreativeDirectorService');
const SERVICE_PATH = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── helpers ──────────────────────────────────────────────────────────────

function fakeMedia(i) {
  return {
    mediaId: `m${i}`,
    role: i === 0 ? 'hero' : 'alt',
    fileType: 'image',
    metadata: { shotType: 'lifestyle', imageRole: 'hero' }
  };
}

function universeOf(n) {
  return Array.from({ length: n }, (_, i) => fakeMedia(i + 1));
}

/** Expected pick-ceiling substring for a universe of length n. Mirrors the
 *  live formula: ceiling = min(4, max(1, n)). */
function expectedPickPhrase(n) {
  const ceiling = Math.min(4, Math.max(1, n));
  if (ceiling === 1) return 'Pick EXACTLY 1 media per concept';
  return `Pick 1-${ceiling}`;
}

/** Index just past the closing paren of a parameter list starting at `fromParen`. */
function paramListEnd(fileSrc, fromParen) {
  let depth = 0;
  for (let i = fromParen; i < fileSrc.length; i++) {
    const ch = fileSrc[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Brace-match extract of `function <name>(...) {...}` from a source file.
 *
 * The body brace is located AFTER the parameter list closes — not as "the first
 * `{` following the name". buildPromptRound destructures its single argument,
 * so the first `{` is the DESTRUCTURING brace, and matching from there returns
 * at the end of the signature with no body at all. The first version of this
 * helper did exactly that, which silently reduced the D3 body assertion below
 * to a second check of the signature. It passed either way — the precise
 * failure mode this harness exists to prevent.
 */
function extractFunctionSource(fileSrc, fnName) {
  const start = fileSrc.indexOf(`function ${fnName}(`);
  if (start < 0) return null;
  const afterParams = paramListEnd(fileSrc, fileSrc.indexOf('(', start));
  if (afterParams < 0) return null;
  const open = fileSrc.indexOf('{', afterParams);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < fileSrc.length; i++) {
    const ch = fileSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return fileSrc.slice(start, i + 1); }
  }
  return null;
}

/** Drop line comments, block comments and quoted strings. Crude but adequate
 *  for the one narrow question below: does an identifier appear in CODE. */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// ── D1 / D2: runtime behaviour of the LIVE export ────────────────────────

const SIZES = [1, 2, 3, 4, 6, 0]; // 0 = empty array

for (const n of SIZES) {
  const label = n === 0 ? 'empty' : String(n);
  const universe = universeOf(n);
  let result = null;
  let threw = null;
  try {
    result = director.buildPromptRound({
      inputSummary: { product_signal: { name: 'Test Tee' } },
      creativeIntent: null,
      platformFormat: 'meta_feed_1_1',
      universe,
      roundIndex: 0,
      avoidList: []
    });
  } catch (err) {
    threw = err;
  }

  // D1 — must not throw. This is the exact failure mode of the live bug, and
  // the only check here that is sound against free variables generally.
  check(
    `D1 buildPromptRound does not throw for universe size ${label}`,
    threw === null,
    threw ? `${threw.constructor.name}: ${threw.message}` : ''
  );

  if (threw || !result) continue;

  check(
    `D1 size ${label} returns { system, user, visionImages }`,
    typeof result.system === 'string' &&
      typeof result.user === 'string' &&
      Array.isArray(result.visionImages),
    `got keys=${result && Object.keys(result)}`
  );

  // D2 — the pick-ceiling arithmetic is the expression the free variable lived
  // inside, so it is pinned rather than merely exercised.
  const expected = expectedPickPhrase(n);
  check(
    `D2 size ${label} system contains pick phrase ${JSON.stringify(expected)}`,
    result.system.includes(expected),
    `MEDIA PICKS line: ${
      (result.system.match(/MEDIA PICKS:[^\n]{0,160}/) || ['(no MEDIA PICKS line)'])[0]
    }`
  );

  if (n === 1 || n === 0) {
    check(
      `D2 size ${label} does not ask for a multi-pick range`,
      !/Pick 1-\d/.test(result.system),
      'found a Pick 1-N range for a 1-slot ceiling'
    );
  } else {
    const ceiling = Math.min(4, Math.max(1, n));
    check(
      `D2 size ${label} does not say EXACTLY 1`,
      !result.system.includes('Pick EXACTLY 1 media per concept'),
      'EXACTLY 1 on a multi-item universe'
    );
    // Cap is 4: a universe of 6 must still say 1-4, never 1-6.
    check(
      `D2 size ${label} ceiling is capped at 4 (got phrase for ${ceiling})`,
      result.system.includes(`Pick 1-${ceiling}`) && !result.system.includes('Pick 1-6'),
      `MEDIA PICKS: ${(result.system.match(/MEDIA PICKS:[^\n]{0,120}/) || [''])[0]}`
    );
  }
}

// ── D3: pin THIS bug's shape, and claim nothing more ─────────────────────
// Deliberately narrow. Not a free-variable analyser — see the header for why
// the general version was removed. This asserts only that the parameter is
// still named `universe` and that the caller-side name never reappears in the
// body as code, which is the precise mistake that was made.

const fileSrc = fs.readFileSync(SERVICE_PATH, 'utf8');
const fnSrc = extractFunctionSource(fileSrc, 'buildPromptRound');

check('D3 buildPromptRound source located in the service file', !!fnSrc);

/** The parameter list only, by balanced parens. NOT `slice(0, indexOf('{'))` —
 *  this function destructures, so the first `{` is the destructuring brace and
 *  that slice stops before any parameter name. (Written that way first; this
 *  harness's own D3 caught it.) */
function parameterList(fnSource) {
  const open = fnSource.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < fnSource.length; i++) {
    const ch = fnSource[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return fnSource.slice(open, i + 1); }
  }
  return '';
}

if (fnSrc) {
  const signature = parameterList(fnSrc);
  check(
    'D3 buildPromptRound still declares the parameter `universe`',
    /\buniverse\b/.test(signature),
    `signature: ${signature.slice(0, 160)}`
  );
  check(
    'D3 buildPromptRound does NOT declare `seededUniverse` as a parameter',
    !/\bseededUniverse\b/.test(signature),
    'the caller-side name is a parameter again — the two names have re-diverged'
  );

  const code = stripCommentsAndStrings(fnSrc);
  check(
    'D3 body never references the caller-side name `seededUniverse`',
    !/\bseededUniverse\b/.test(code),
    'the exact 2026-08-01 defect is back: a free `seededUniverse` inside a function whose param is `universe`'
  );

  // The body must actually USE its parameter — a rename that silently orphaned
  // `universe` would leave the ceiling permanently at 1 without throwing.
  check(
    'D3 body actually reads the `universe` parameter',
    /\buniverse\b/.test(code),
    'parameter is declared but never read'
  );
}

// ── E. brand_signal reads fields that EXIST on models/Brand.js ───────────
/**
 * Source-level, not runtime: `assembleSignals` does DB reads, so the field
 * names are pinned by scanning the source the way verifyConceptContract.js
 * scans services/ + routes/.
 *
 * THE DEFECT (2026-08-04): `brandSignal.description` read `brand.description`
 * and `has_logo` read `brand.logo`. Neither exists on `brandSchema`
 * (models/Brand.js:31) — `description` belongs to `demographicSchema` (:24),
 * and the real fields are `summary` (:47) and `logoUrl` (:48).
 * `Brand.findById(brandId).lean()` is unprojected, so both reads were
 * permanently null/false while the round prompt told the model to "Pull from
 * brand_signal.tagline / description / brand_reviews_summary" and to null any
 * ungrounded copy role. That starved brief is how static ads shipped with no
 * copy at all.
 */
check(
  'E1 brand_signal.description sources brand.summary',
  /description:\s*snippetText\(brand\?\.summary,/.test(fileSrc),
  'brand.description does not exist on brandSchema — the field is summary'
);
check(
  'E2 no read of the non-existent brand.description',
  !/brand\?\.description/.test(fileSrc),
  'brand.description is demographicSchema\'s field, not brandSchema\'s — permanently null'
);
check(
  'E3 has_logo sources brand.logoUrl',
  /has_logo:\s*!!brand\?\.logoUrl/.test(fileSrc),
  'the Brand field is logoUrl'
);
check(
  // Negative lookahead is load-bearing: `brand?.logoUrl` CONTAINS the literal
  // `brand?.logo`, so a plain substring test would pass on the correct code
  // and never be able to fail. Match `brand?.logo` only when NOT followed by
  // another identifier character.
  'E4 no read of the non-existent brand.logo',
  !/brand\?\.logo(?![A-Za-z0-9_])/.test(fileSrc),
  'brand.logo never existed — has_logo was permanently false'
);
check(
  'E5 dead product.shortBenefits read is gone',
  !/product\?\.shortBenefits/.test(fileSrc),
  'shortBenefits is not on models/CatalogProduct.js — it always sent []'
);
check(
  // Without the bump, the cache-hit test (cached.signalsVersion ===
  // DIRECTOR_SIGNALS_VERSION) keeps serving concepts derived from the starved
  // brief, and the fix above is a no-op on every existing artifact.
  'E6 DIRECTOR_SIGNALS_VERSION bumped past the starved-brief 3.0.0',
  /const DIRECTOR_SIGNALS_VERSION = '(?!3\.0\.0')/.test(fileSrc),
  'signals version must be bumped so existing CreativeDirectionArtifacts re-derive'
);
check(
  'E7 a null copy.headline warns on its own',
  /cp\.headline == null\)/.test(fileSrc) && /headline is null/.test(fileSrc),
  'the all-four-null warning alone lets a headline-less concept log dirWarnings=0'
);

if (failures.length) {
  console.error(`\n❌ director prompt: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ director prompt: ${pass} checks passed`);
console.log('   scope: runtime calls across every universe size; free vars on non-executed branches are NOT covered (see header)');
