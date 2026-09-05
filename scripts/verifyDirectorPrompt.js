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
  'E5 assembleSignals reads product.shortBenefits (catalog field, already in memory)',
  /product\?\.shortBenefits/.test(fileSrc),
  'Part C source is CatalogProduct.shortBenefits — the findById().lean() already loaded it'
);
check(
  // Without the bump, the cache-hit test (cached.signalsVersion ===
  // DIRECTOR_SIGNALS_VERSION) keeps serving concepts derived from the starved
  // brief, and the fix above is a no-op on every existing artifact.
  'E6 DIRECTOR_SIGNALS_VERSION is 3.6.0 (brand_signal.personas)',
  /const DIRECTOR_SIGNALS_VERSION = '3\.6\.0'/.test(fileSrc),
  'signals version must be bumped so existing CreativeDirectionArtifacts re-derive'
);
check(
  'E7 a null copy.headline warns on its own',
  /cp\.headline == null\)/.test(fileSrc) && /headline is null/.test(fileSrc),
  'the all-four-null warning alone lets a headline-less concept log dirWarnings=0'
);

// ── F. DIRECTOR_PRODUCT_BENEFITS (optional colour, both arms) ────────────
// Drive the REAL buildPromptRound. Flag-off must be byte-identical on the
// HONESTY RULE and PROOF-LED strings (benefits are not proof — the
// self-contradictory-prompt class that forced the PR #61 rollback).

const EDITORIAL_OFF = '    editorial         → product_signal.specs. Name ONE concrete fact (fabric, construction, weight, dimension, care) and build the line on it. A specific verb about a real property beats two adjectives. This is the style that should read as reported, not sold.';
const COPY_OFF = '- COPY: write the final strings the renderer will ship under copy.{headline,subheadline,eyebrow,cta}. Pull from brand_signal.tagline / description / brand_reviews_summary, product_signal.description, product_signal.specs (real specification facts for THIS product — fabric, construction, weight, dimensions, care), social_proof_signal.primary_quote, and the wider quote pool in social_proof_signal.proof_options[].quotes when grounding. Use null for any role the concept intentionally omits (e.g. eyebrow=null when the design has no eyebrow rule). Storyboard beats reference copy by role — each beat\'s role MUST map to a non-null copy field (e.g. role=headline beat requires copy.headline non-null).';

function withBenefitsFlag(val, fn) {
  const prev = process.env.DIRECTOR_PRODUCT_BENEFITS;
  if (val === undefined) delete process.env.DIRECTOR_PRODUCT_BENEFITS;
  else process.env.DIRECTOR_PRODUCT_BENEFITS = val;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.DIRECTOR_PRODUCT_BENEFITS;
    else process.env.DIRECTOR_PRODUCT_BENEFITS = prev;
  }
}

function roundFor(flag, inputSummary) {
  return withBenefitsFlag(flag, () => director.buildPromptRound({
    inputSummary: inputSummary || { product_signal: { name: 'Test Tee' } },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: universeOf(1),
    roundIndex: 0,
    avoidList: []
  }));
}

{
  const on = roundFor('true');
  const off = roundFor('false');
  check('F0 buildPromptRound returns on both arms',
    typeof on.system === 'string' && typeof off.system === 'string');

  check('F1 flag-on GROUNDING editorial mentions benefits MAY colour a line',
    on.system.includes('product_signal.benefits MAY colour a line'));
  check('F2 flag-on COPY lists product_signal.benefits as derived/optional',
    on.system.includes('product_signal.benefits (derived buyer-facing phrases — optional colour, not verified facts)'));
  // F2b: the PROVENANCE clause must describe where benefits actually come
  // from. It said "(Gemini-authored at layout derivation)" — true when Part C
  // read LayoutInputArtifact, FALSE once the source became
  // CatalogProduct.shortBenefits written by productBenefitsService at ingest.
  // An adversarial review caught it; nothing pinned it, so it could regress
  // silently. The "NOT verified catalog facts" half must survive too — that is
  // what stops the Director treating a derived phrase as substantiated proof.
  check('F2b flag-on names the REAL benefits provenance (catalog ingest, not layout derivation)',
    on.system.includes('derived once at catalog ingest') &&
    !on.system.includes('layout derivation'));
  check('F2c flag-on still labels benefits as NOT verified facts',
    /benefits[\s\S]{0,240}NOT verified catalog facts/.test(on.system));
  check('F2d flag-on COPY tells the Director benefits are optional colour, never invented',
    on.system.includes('Use product_signal.benefits only when they sharpen THIS concept') &&
    on.system.includes('Empty array = skip, never invent'));

  check('F3 flag-off editorial is byte-identical to the pre-change line',
    off.system.includes(EDITORIAL_OFF) && !off.system.includes('product_signal.benefits MAY colour'));
  check('F4 flag-off COPY is byte-identical to the pre-change line',
    off.system.includes(COPY_OFF) && !off.system.includes('product_signal.benefits (derived'));

  const honestyOn = (on.system.match(/- HONESTY RULE:[^\n]*/ ) || [null])[0];
  const honestyOff = (off.system.match(/- HONESTY RULE:[^\n]*/ ) || [null])[0];
  check('F5 HONESTY RULE is byte-identical across benefits-flag arms',
    honestyOn != null && honestyOn === honestyOff,
    `on=${honestyOn && honestyOn.slice(0, 80)} off=${honestyOff && honestyOff.slice(0, 80)}`);

  const proofOn = (on.system.match(/- PROOF-LED COVERAGE:[^\n]*/ ) || [null])[0];
  const proofOff = (off.system.match(/- PROOF-LED COVERAGE:[^\n]*/ ) || [null])[0];
  check('F6 PROOF-LED COVERAGE is byte-identical across benefits-flag arms',
    proofOn === proofOff,
    `on=${proofOn} off=${proofOff}`);

  check('F7 HONESTY RULE source does not mention benefits (benefits are not proof)',
    !/HONESTY RULE:[^\n]*benefits/.test(fileSrc));
  check('F8 NULLED HEADLINE escape hatch still names specs+description, not benefits',
    /you almost certainly still have product_signal\.specs or a product description/.test(on.system) &&
      /you almost certainly still have product_signal\.specs or a product description/.test(off.system) &&
      !/NULLED HEADLINE[\s\S]{0,400}product_signal\.benefits/.test(on.system));

  // assembleSignals: key present flag-on / ABSENT flag-off (source — the
  // behavioural attach is scripts/verifyDirectorBenefits.js).
  const assembleSrc = extractFunctionSource(fileSrc, 'assembleSignals') || '';
  check('F9 assembleSignals assigns productSignal.benefits only inside directorProductBenefitsEnabled()',
    /if \(directorProductBenefitsEnabled\(\)\)/.test(assembleSrc) &&
      /productSignal\.benefits =/.test(assembleSrc));
  check('F10 flag-off omits the key by not assigning it (no benefits: [])',
    !/benefits:\s*\[\]/.test(assembleSrc) &&
      !/benefits:\s*normalizeBenefitList/.test(assembleSrc));
}

{
  // Rating-bearing summary so PROOF-LED actually fires — still must not
  // disagree across the benefits flag (benefits are not proof).
  const withRating = {
    product_signal: { name: 'Test Tee' },
    social_proof_signal: { rating: { value: 4.8, count: 120 } }
  };
  const on = roundFor('true', withRating);
  const off = roundFor('false', withRating);
  const proofOn = (on.system.match(/- PROOF-LED COVERAGE:[^\n]*/ ) || [null])[0];
  const proofOff = (off.system.match(/- PROOF-LED COVERAGE:[^\n]*/ ) || [null])[0];
  check('F11 PROOF-LED fires on a rating and is byte-identical across arms',
    typeof proofOn === 'string' && proofOn === proofOff && /usable RATING/.test(proofOn),
    `on=${proofOn && proofOn.slice(0, 100)}`);
}

// ── G. DIRECTOR_BRAND_PERSONAS (item 4) ────────────────────────────────
const ORIG_PERSONAS = process.env.DIRECTOR_BRAND_PERSONAS;
function withPersonasFlag(val, fn) {
  if (val === undefined) delete process.env.DIRECTOR_BRAND_PERSONAS;
  else process.env.DIRECTOR_BRAND_PERSONAS = val;
  try { return fn(); }
  finally {
    if (ORIG_PERSONAS === undefined) delete process.env.DIRECTOR_BRAND_PERSONAS;
    else process.env.DIRECTOR_BRAND_PERSONAS = ORIG_PERSONAS;
  }
}

{
  const summary = { product_signal: { name: 'Test Tee' }, brand_signal: { name: 'Acme' } };
  const offPrompt = withPersonasFlag('false', () => director.buildPromptRound({
    inputSummary: summary,
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: universeOf(1),
    roundIndex: 0,
    avoidList: []
  }));
  const unsetPrompt = withPersonasFlag(undefined, () => director.buildPromptRound({
    inputSummary: summary,
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: universeOf(1),
    roundIndex: 0,
    avoidList: []
  }));
  const onPrompt = withPersonasFlag('true', () => director.buildPromptRound({
    inputSummary: {
      ...summary,
      brand_signal: {
        name: 'Acme',
        personas: [{ name: 'Saltwater Joe', description: 'weekend angler', painPoints: ['sunburn'] }]
      }
    },
    creativeIntent: null,
    platformFormat: 'meta_feed_1_1',
    universe: universeOf(1),
    roundIndex: 0,
    avoidList: []
  }));

  check('G0 flag-off round prompt is byte-identical to unset (pre-change)',
    offPrompt.system === unsetPrompt.system && offPrompt.user === unsetPrompt.user);
  check('G1 flag-off omits PERSONAS rule',
    !offPrompt.system.includes('PERSONAS:') && !offPrompt.system.includes('quote author'));
  check('G2 flag-on PERSONAS rule forbids quote authors / invented testimonials',
    onPrompt.system.includes('PERSONAS:')
      && onPrompt.system.includes('quote author')
      && onPrompt.system.includes('never invent a testimonial')
      && onPrompt.system.includes('who the ad is FOR, not who is speaking'));
  check('G3 flag-on inputSummary can carry personas (user JSON)',
    onPrompt.user.includes('"personas"') && onPrompt.user.includes('Saltwater Joe'));
  check('G4 parser is strictly === \'true\'',
    /process\.env\.DIRECTOR_BRAND_PERSONAS === 'true'/.test(fileSrc));
  check('G5 defaults.env file default is true',
    /^DIRECTOR_BRAND_PERSONAS=true$/m.test(
      fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8')
    ));
  check('G6 normalizeBrandPersonas uses real demographicSchema fields',
    /function normalizeBrandPersonas/.test(fileSrc)
      && /d\.painPoints/.test(fileSrc)
      && /d\.toneHint/.test(fileSrc)
      && /d\.interests/.test(fileSrc)
      && !/avatarUrl/.test(extractFunctionSource(fileSrc, 'normalizeBrandPersonas') || ''));

  const personas = director.normalizeBrandPersonas([
    { name: 'Saltwater Joe', description: 'weekend angler', painPoints: ['sunburn'], interests: ['inshore'], toneHint: 'dry', avatarUrl: 'http://x' },
    { name: '  ' },
    { name: 'Second' },
    { name: 'Third' },
    { name: 'Fourth' },
    { name: 'Fifth dropped' }
  ]);
  check('G7 cap is 4 named personas; nameless dropped; avatarUrl omitted',
    personas.length === 4
      && personas[0].name === 'Saltwater Joe'
      && personas[0].painPoints[0] === 'sunburn'
      && personas[0].toneHint === 'dry'
      && personas[0].avatarUrl === undefined
      && personas[3].name === 'Fourth');
}

// ── H. ugc_signal.rights_approved (item 7) ───────────────────────────────
check('H0 source reads media.rights.approved (not platformStats.rights_approved)',
  /m\.rights\?\.approved/.test(fileSrc)
    && !/platformStats\?\.rights_approved/.test(fileSrc));
check('H1 Media.select includes rights',
  /\.select\('[^']*\brights\b/.test(fileSrc));

{
  const os = require('os');
  function withTempMutation(filePath, find, replace, runCheck) {
    const original = fs.readFileSync(filePath, 'utf8');
    if (!original.includes(find)) {
      check(`RP mutate target found: ${find.slice(0, 40)}`, false);
      return;
    }
    const mutated = original.replace(find, replace);
    const tmp = path.join(os.tmpdir(), `verifyDirectorPrompt-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(tmp, mutated);
    try { runCheck(fs.readFileSync(tmp, 'utf8')); }
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* tmp */ } }
  }
  let failedPersonas = false;
  withTempMutation(
    SERVICE_PATH,
    '- PERSONAS: brand_signal.personas (when present) inform voice and objection framing ONLY.',
    '- PERSONAS_REMOVED: brand_signal.personas (when present) inform voice and objection framing ONLY.',
    (mutSrc) => {
      failedPersonas = !/- PERSONAS:/.test(mutSrc);
    }
  );
  check('RP-G2 [REVERT-PROOF] dropping PERSONAS rule fails G2 source', failedPersonas);

  let failedRights = false;
  withTempMutation(
    SERVICE_PATH,
    'm.rights?.approved',
    'm.platformStats?.rights_approved',
    (mutSrc) => {
      failedRights = /platformStats\?\.rights_approved/.test(mutSrc)
        && !/m\.rights\?\.approved/.test(mutSrc);
    }
  );
  check('RP-H0 [REVERT-PROOF] restoring platformStats.rights_approved fails H0', failedRights);
}

function query(value) {
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    select() { return chain; },
    lean() { return Promise.resolve(value); },
  };
  return chain;
}

async function runAsyncDirectorDataForward() {
  const Brand = require('../models/Brand');
  const CatalogProduct = require('../models/CatalogProduct');
  const ProductMatchArtifact = require('../models/ProductMatchArtifact');
  const Media = require('../models/Media');
  const Comment = require('../models/Comment');
  const orig = {
    brand: Brand.findById,
    product: CatalogProduct.findById,
    pma: ProductMatchArtifact.find,
    media: Media.find,
    comment: Comment.find
  };
  function restore() {
    Brand.findById = orig.brand;
    CatalogProduct.findById = orig.product;
    ProductMatchArtifact.find = orig.pma;
    Media.find = orig.media;
    Comment.find = orig.comment;
    if (ORIG_PERSONAS === undefined) delete process.env.DIRECTOR_BRAND_PERSONAS;
    else process.env.DIRECTOR_BRAND_PERSONAS = ORIG_PERSONAS;
  }

  try {
    process.env.DIRECTOR_BRAND_PERSONAS = 'true';
    Brand.findById = () => query({
      name: 'Acme',
      summary: 'A test brand',
      tagline: 'Go forth',
      tone: ['calm'],
      logoUrl: null,
      demographics: [
        { name: 'Saltwater Joe', description: 'weekend angler', painPoints: ['sunburn'] }
      ]
    });
    CatalogProduct.findById = () => query({ title: 'Test Tee' });
    ProductMatchArtifact.find = () => query([]);
    Media.find = () => query([]);
    Comment.find = () => query([]);
    const on = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: []
    });
    check('G8 assembleSignals flag-on attaches brand_signal.personas',
      Array.isArray(on.brand_signal.personas)
        && on.brand_signal.personas[0]
        && on.brand_signal.personas[0].name === 'Saltwater Joe');

    process.env.DIRECTOR_BRAND_PERSONAS = 'false';
    const off = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: []
    });
    check('G9 assembleSignals flag-off OMITS brand_signal.personas key',
      !Object.prototype.hasOwnProperty.call(off.brand_signal, 'personas'));

    process.env.DIRECTOR_BRAND_PERSONAS = 'false';
    Brand.findById = () => query({ name: 'Acme', summary: 's', tagline: 't', tone: [], logoUrl: null });
    ProductMatchArtifact.find = () => query([{ mediaId: '0000000000000000000000aa' }]);
    Media.find = () => query([{
      source: 'instagram',
      rights: { approved: true },
      platformStats: { rights_approved: null },
      classification: {},
      fileType: 'image'
    }]);
    const rights = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: []
    });
    check('H2 stub Media.rights.approved=true → ugc_signal.rights_approved is true',
      rights.ugc_signal.rights_approved === true,
      `got ${rights.ugc_signal && rights.ugc_signal.rights_approved}`);

    Media.find = () => query([{
      source: 'instagram',
      rights: { approved: false },
      platformStats: { rights_approved: true },
      classification: {},
      fileType: 'image'
    }]);
    const rightsOff = await director.assembleSignals({
      brandId: '000000000000000000000001',
      productId: '000000000000000000000002',
      campaignKind: 'product',
      seededUniverse: []
    });
    check('H3 platformStats.rights_approved is ignored (still null/falsey)',
      rightsOff.ugc_signal.rights_approved == null,
      `got ${rightsOff.ugc_signal && rightsOff.ugc_signal.rights_approved}`);
  } finally {
    restore();
  }
}

runAsyncDirectorDataForward()
  .then(() => {
    if (failures.length) {
      console.error(`\n❌ director prompt: ${failures.length} FAILED, ${pass} passed\n`);
      failures.forEach((f) => console.error(`   • ${f}`));
      process.exit(1);
    }
    console.log(`✅ director prompt: ${pass} checks passed`);
    console.log('   scope: runtime calls across every universe size; free vars on non-executed branches are NOT covered (see header)');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
