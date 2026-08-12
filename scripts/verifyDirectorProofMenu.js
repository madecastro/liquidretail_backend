#!/usr/bin/env node
'use strict';
/**
 * verifyDirectorProofMenu — the Director proof-point MENU
 * (DIRECTOR_PROOF_MENU_ENABLED): category_signal, social_proof_signal
 * .proof_options[], routing.proof_pick.
 *
 * Split into two kinds of check, because assembleSignals() itself is
 * Mongoose-dependent (Brand/CatalogProduct/Category/Media/Comment reads) and
 * this harness runs with NO database connection, by design — every other
 * Director harness in this repo (verifyDirectorPrompt.js,
 * verifyDirectorJsonSalvage.js) tests the PURE functions directly, never
 * assembleSignals end-to-end.
 *
 *   A. buildDirectorProofOptions — pure, no I/O, exported specifically so this
 *      truthfulness-sensitive logic (which tier's number a copy-writing LLM
 *      may reference, and how it must be scoped) can be unit-tested without
 *      a database.
 *   B. buildPromptRound / buildResponseSchemaRound / validateConceptsRound —
 *      the existing pattern, exercised with hand-built inputSummary /
 *      concepts fixtures, same as verifyDirectorPrompt.js.
 *   C. Source-level structural checks (fs.readFileSync + regex) for the
 *      parts that genuinely cannot be exercised without Mongo — the
 *      category-fetch gate and the category_signal / proof_options
 *      attachment guards. Same idiom scripts/verifyBrandFieldNames.js uses
 *      for its E4/E5 precedence checks.
 *
 * Revert-proven (see bottom): the misattribution scoping check, the flag-off
 * gate, and the proof_pick bounds check were each confirmed to fail when the
 * guard they pin is removed.
 */
const fs = require('fs');
const path = require('path');

const director = require('../services/aiCreativeDirectorService');
const {
  buildDirectorProofOptions, buildPromptRound, buildResponseSchemaRound,
  validateConceptsRound, directorProofMenuEnabled
} = director;

const ROOT = path.join(__dirname, '..');
const svcSrc = fs.readFileSync(path.join(ROOT, 'services', 'aiCreativeDirectorService.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. buildDirectorProofOptions — pure function, no DB ──────────────────

{
  const empty = buildDirectorProofOptions({ product: null, category: null, brand: null });
  check('A0 all-empty tiers returns []', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty));
}

{
  const opts = buildDirectorProofOptions({
    product:  { rating: 4.7, reviewCount: 523, quotes: [] },
    category: null,
    brand:    null
  });
  check('A1 product-only tier: exactly one option', opts.length === 1, JSON.stringify(opts));
  const o = opts[0];
  check('A1 tier is "product"', o?.tier === 'product', JSON.stringify(o));
  check('A1 reviews_text is the unscoped product convention ("N reviews")', o?.reviews_text === '523 reviews', JSON.stringify(o));
  check('A1 rating rounds to one decimal', o?.rating === 4.7, JSON.stringify(o));
  check('A1 review_count passes through', o?.review_count === 523, JSON.stringify(o));
}

// THE LOAD-BEARING CHECK. This is the exact class of bug an adversarial pass
// caught as a BLOCKER earlier in this same feature area (brand numbers
// reaching a product-shaped template unscoped). Here the "template" is the
// Director's own prompt — the LLM cannot un-see an unscoped number.
{
  const opts = buildDirectorProofOptions({
    product:  null,
    category: null,
    brand:    { rating: 4.8, reviewCount: 41000, quotes: [] }
  });
  const o = opts[0];
  check('A2 brand tier reviews_text is present', typeof o?.reviews_text === 'string', JSON.stringify(o));
  check('A2 brand tier reviews_text NAMES "brand" — misattribution guard',
    /\bbrand\b/.test(String(o?.reviews_text)),
    `reviews_text=${JSON.stringify(o?.reviews_text)} — without the scope word a brand-wide count reads as this product's own`);
}
{
  const opts = buildDirectorProofOptions({
    product:  { rating: 4.7, reviewCount: 523, quotes: [] },
    category: null,
    brand:    null
  });
  check('A3 product tier reviews_text does NOT say "brand" or "category"',
    !/\b(brand|category)\b/.test(String(opts[0]?.reviews_text)),
    `reviews_text=${JSON.stringify(opts[0]?.reviews_text)}`);
}
{
  const opts = buildDirectorProofOptions({
    product: null, brand: null,
    category: { rating: null, reviewCount: 1500, quotes: [] }
  });
  const o = opts[0];
  check('A4 category tier: count-only reviews_text names "category"',
    o?.reviews_text === '1500 category reviews', JSON.stringify(o));
}
// A THIRD blocker/serious pair an adversarial pass caught, same shape as A6
// below but a DIFFERENT field: the count fix alone left a bare RATING with no
// count completely unscoped for non-product tiers. A star rating is one of
// the most natural numbers ad copy cites, so this was not a corner case.
{
  const opts = buildDirectorProofOptions({
    product: null, brand: null,
    category: { rating: 4.6, reviewCount: null, quotes: [] }
  });
  const o = opts[0];
  check('A5 category tier: bare rating (no count) IS scoped — "category-wide rating"',
    o?.reviews_text === 'category-wide rating' && o?.rating === 4.6, JSON.stringify(o));
}
{
  const opts = buildDirectorProofOptions({
    product: null, category: null,
    brand: { rating: 4.8, reviewCount: null, quotes: [] }
  });
  const o = opts[0];
  check('A5b brand tier: bare rating (no count) IS scoped — "brand-wide rating"',
    o?.reviews_text === 'brand-wide rating' && o?.rating === 4.8, JSON.stringify(o));
}
{
  // PRODUCT tier deliberately stays unscoped — matches the rendered ad's own
  // convention (no qualifier needed; it IS the ad's own product) and the
  // pre-existing formatProductReviewsText/formatBrandReviewsText contract,
  // which only ever names a COUNT, never a rating.
  const opts = buildDirectorProofOptions({
    product: { rating: 4.7, reviewCount: null, quotes: [] }, category: null, brand: null
  });
  const o = opts[0];
  check('A5c product tier: bare rating stays UNSCOPED (matches rendered-ad convention)',
    o?.reviews_text === null && o?.rating === 4.7, JSON.stringify(o));
}
// THE BLOCKER an adversarial pass caught: a below-floor rating with a count
// present used to null the WHOLE disclosure (count included), because the
// first version of this function routed reviews_text through
// resolveCoherentSocialProof — correct for what actually RENDERS on an ad,
// wrong here, since that function's job is "is the STAR worth printing," and
// it deletes the count as collateral. A raw, unscoped 41,000 then reached the
// Director with nothing telling it that number was brand-wide. Fixed: the
// count disclosure is built directly from formatBrandReviewsText /
// formatProductReviewsText, independent of the star floor. The RAW rating
// number staying visible even below the floor is UNCHANGED, correct,
// pre-existing behaviour (productRatingValue / brandRatingValue in
// assembleSignals were always gated only on `> 0`, never on the display
// floor — the Director has always seen true numbers to reason about weak
// proof, even though the ad itself never displays them below the bar).
{
  const opts = buildDirectorProofOptions({
    product: null, category: null, brand: { rating: 3.3, reviewCount: 41000, quotes: [] }
  });
  const o = opts[0];
  check('A6 below-floor BRAND rating + count: reviews_text is SCOPED, not withheld',
    o?.rating === 3.3 && o?.review_count === 41000 && o?.reviews_text === '41000 brand reviews',
    JSON.stringify(o));
}
{
  const opts = buildDirectorProofOptions({
    product: null, category: null, brand: { rating: null, reviewCount: 41000, quotes: [] }
  });
  const o = opts[0];
  check('A6b brand count with NO rating at all: still scoped, not withheld',
    o?.rating === null && o?.review_count === 41000 && o?.reviews_text === '41000 brand reviews',
    JSON.stringify(o));
}
{
  const opts = buildDirectorProofOptions({
    product: { rating: 3.0, reviewCount: 500, quotes: [] }, category: null, brand: null
  });
  const o = opts[0];
  check('A6c below-floor PRODUCT rating + count: reviews_text is scoped (unscoped convention), not withheld',
    o?.rating === 3.0 && o?.review_count === 500 && o?.reviews_text === '500 reviews',
    JSON.stringify(o));
}
{
  const many = Array.from({ length: 5 }, (_, i) => ({ text: `quote number ${i} is long enough to pass the length floor`, author: `A${i}` }));
  const opts = buildDirectorProofOptions({
    product: { rating: null, reviewCount: null, quotes: many }, category: null, brand: null
  });
  // Cap raised 2 → 4 (MAX_QUOTES_PER_TIER). Two quotes per tier could not
  // ground three distinct proof-led concepts, so the third had nothing new to
  // say and fell back to the shared brand tagline — the "same slogan in three
  // intent profiles" defect. The cap still matters (this rides in every
  // Director prompt, across three tiers), it is just no longer 2.
  check('A7 quotes capped at 4 per tier', opts[0]?.quotes?.length === 4, JSON.stringify(opts[0]));
}
// A7b — the property that actually matters, and which A7's count alone never
// checked: the pool is RANKED, so the Director sees the best material first.
// As of #157 the intake screen deliberately STORES generic praise instead of
// discarding it, so `brandReviews.quotes` now carries lines that clear the >30
// length filter and score 0. A first-N slice would hand the Director more
// filler; ranking lets the filler fall off the end of the slice by itself.
{
  const generic  = 'High quality, functional and fashionable products.';
  const specific = 'I wore these on a 12-hour offshore trip and they dried in minutes.';
  // Generic arrives FIRST, so arrival order would surface it first.
  const opts = buildDirectorProofOptions({
    product: { rating: null, reviewCount: null, quotes: [
      { text: generic, author: 'G' }, { text: specific, author: 'S' }
    ] },
    category: null, brand: null
  });
  const first = opts[0]?.quotes?.[0]?.text || '';
  check('A7b the ranked pool puts the SPECIFIC quote ahead of generic praise',
    first.startsWith('I wore these'),
    `first quote was ${JSON.stringify(first)} — arrival order would have given the generic one`);
  check('A7b-2 the generic quote is still offered (not discarded)',
    (opts[0]?.quotes || []).some(q => q.text === generic),
    'ranking must reorder, not filter — a brand whose whole pool is generic still needs its best-of');
}
{
  const opts = buildDirectorProofOptions({
    product: { rating: null, reviewCount: null, quotes: [{ text: 'x'.repeat(500), author: 'A' }] },
    category: null, brand: null
  });
  check('A8 quote-only tier (no numbers) still included, reviews_text null',
    opts.length === 1 && opts[0].reviews_text === null && opts[0].quotes[0].text.length <= 201,
    JSON.stringify(opts[0]));
}
{
  const opts = buildDirectorProofOptions({
    product:  { rating: 4.9, reviewCount: 12,    quotes: [] },
    category: { rating: null, reviewCount: 800,  quotes: [] },
    brand:    { rating: 4.6, reviewCount: 9000,  quotes: [] }
  });
  check('A9 all three tiers present, in product/category/brand order',
    opts.length === 3 && opts.map(o => o.tier).join(',') === 'product,category,brand',
    JSON.stringify(opts.map(o => o.tier)));
}

// ── B. buildPromptRound — the PROOF MENU instruction line ─────────────────

const SIGNALS_WITH_MENU = {
  brand_signal: { name: 'Acme', tagline: null, description: null, tone: [], brand_reviews_summary: null, has_logo: false },
  product_signal: { name: 'Widget', category: null, description: null, price: null, currency: null, availability: null, review_summary: null, priority: 'high' },
  ugc_signal: { media_strength: 'absent', shot_type_distribution: {}, content_nature_distribution: {}, file_type_distribution: {}, primary_subjects: [], top_creator: null },
  social_proof_signal: {
    rating: null, primary_quote: null, top_comments: [], strongest_signal: null, proof_density: 0,
    proof_options: [{ tier: 'brand', rating: 4.8, review_count: 41000, reviews_text: '41000 brand reviews', quotes: [] }]
  },
  performance_signal: { likes: null, comments: null, saves: null, shares: null, avg_engagement_rate: null, strength: 'absent', top_post: null }
};
const UNIVERSE_1 = [{ mediaId: 'm1', role: 'hero' }];

function withMenuFlag(value, fn) {
  const prev = process.env.DIRECTOR_PROOF_MENU_ENABLED;
  process.env.DIRECTOR_PROOF_MENU_ENABLED = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
    else process.env.DIRECTOR_PROOF_MENU_ENABLED = prev;
  }
}

{
  const onProse = withMenuFlag('true', () => buildPromptRound({
    inputSummary: SIGNALS_WITH_MENU, creativeIntent: null, platformFormat: 'meta_feed_1_1',
    universe: UNIVERSE_1, roundIndex: 0, avoidList: []
  }));
  // The PROOF MENU instruction lives in the SYSTEM prompt (the rules block),
  // not the user prompt (which carries the per-call inputSummary JSON) —
  // confirmed against the real function before writing this assertion.
  check('B0 directorProofMenuEnabled() reads the env var (flag on)', withMenuFlag('true', directorProofMenuEnabled) === true);
  check('B1 flag ON: system prompt mentions PROOF MENU', onProse.system.includes('PROOF MENU'));
  check('B1 flag ON: system prompt explains routing.proof_pick', onProse.system.includes('routing.proof_pick'));
  check('B1 flag ON: system prompt states proof_pick does not change what renders',
    /does NOT change which (number|rating)/.test(onProse.system) || onProse.system.includes('decided separately'));

  const offProse = withMenuFlag('false', () => buildPromptRound({
    inputSummary: SIGNALS_WITH_MENU, creativeIntent: null, platformFormat: 'meta_feed_1_1',
    universe: UNIVERSE_1, roundIndex: 0, avoidList: []
  }));
  check('B0 directorProofMenuEnabled() reads the env var (flag off)', withMenuFlag('false', directorProofMenuEnabled) === false);
  check('B2 flag OFF: system prompt does NOT mention PROOF MENU', !offProse.system.includes('PROOF MENU'));
  check('B2 flag OFF: system prompt does NOT mention routing.proof_pick', !offProse.system.includes('proof_pick'));
}

// ── B. buildResponseSchemaRound — proof_pick schema shape ─────────────────

{
  const schema = buildResponseSchemaRound(UNIVERSE_1, 'meta_feed_1_1');
  const routing = schema?.properties?.concepts?.items?.properties?.routing
    || schema?.items?.properties?.routing
    || (schema?.properties?.routing ? schema.properties : null)?.properties
    || null;
  // buildResponseSchemaRound's exact top-level shape varies by call site
  // convention in this file; locate `routing` by walking whatever object it
  // returned rather than assuming one fixed path — the property itself is
  // what's under test, not the schema's own nesting depth.
  function findRoutingSchema(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (node.properties && node.properties.proof_pick !== undefined) return node;
    if (node.properties && node.properties.archetype !== undefined && node.properties.media_picks !== undefined) return node;
    for (const v of Object.values(node)) {
      const found = findRoutingSchema(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const routingSchema = findRoutingSchema(schema);
  check('B3 routingSchema located in buildResponseSchemaRound output', !!routingSchema, JSON.stringify(Object.keys(schema || {})));
  if (routingSchema) {
    const pp = routingSchema.properties?.proof_pick;
    check('B4 proof_pick is declared on the routing schema', !!pp, JSON.stringify(routingSchema.properties && Object.keys(routingSchema.properties)));
    check('B5 proof_pick type is [integer, null]',
      Array.isArray(pp?.type) && pp.type.includes('integer') && pp.type.includes('null'), JSON.stringify(pp));
    check('B6 proof_pick is NOT in required (optional field, non-strict validator)',
      !Array.isArray(routingSchema.required) || !routingSchema.required.includes('proof_pick'),
      JSON.stringify(routingSchema.required));
  }
}

// ── B. validateConceptsRound — proof_pick bounds check ─────────────────────

const CONCEPT_BASE = {
  concept_id: 'c1',
  routing: {
    archetype: 'hero_quote_overlay', layout_family: 'overlay', emotional_hook: 'x',
    social_proof_type: 'rating', product_priority: 'high', ugc_priority: 'low',
    comment_priority: 'low', stat_priority: 'low', cta_emphasis: 'medium',
    creative_style: 'editorial', recommended_components: {},
    media_picks: [{ media_id: 'm1', role: 'hero', notes: null }],
    output_shape: { format: 'static_single', tile_count: 1 }
  },
  copy: { headline: 'H', subheadline: null, eyebrow: null, cta: 'SHOP' }
};

{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing } }; // no proof_pick at all
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C1 no proof_pick present → no warning', !w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: null } };
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C2 proof_pick: null → no warning', !w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 1 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C3 proof_pick: 1, menu has 3 options → no warning', !w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 5 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C4 proof_pick: 5, menu has 3 options → OUT OF RANGE warning', w.some(x => x.includes('proof_pick') && x.includes('out of range')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: -1 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C5 proof_pick: -1 → out of range warning', w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 0 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 3);
  check('C6 proof_pick: 0 (first option) → NOT flagged as absent/invalid', !w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 2 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 0); // menu was empty this round
  check('C7 proof_pick present but proofOptionsCount=0 → out of range', w.some(x => x.includes('proof_pick')), JSON.stringify(w));
}
// C6 alone could not distinguish the correct `!= null` bounds check from a
// regressed `if (proofPick)` (truthy) check — both pass when proof_pick:0 is
// paired with a non-empty menu, since 0 is legitimately in range either way.
// An adversarial pass found this by mutating the source to `if (proofPick)`
// and re-running: C6/C7 both stayed green. This case forces the two
// implementations apart: 0 against an EMPTY menu (0 >= 0) is out of range
// under `!= null`, but a truthy check treats `proof_pick: 0` as "absent" and
// never runs the comparison at all — so it would wrongly stay silent here.
{
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 0 } };
  const w = validateConceptsRound([c], UNIVERSE_1, 0);
  check('C6b proof_pick: 0 against an EMPTY menu (0) → out of range, not silently skipped',
    w.some(x => x.includes('proof_pick') && x.includes('out of range')), JSON.stringify(w));
}
{
  // Backward compatibility: proofOptionsCount param is optional (default 0).
  // A caller that never passes it must not crash, and any concept naming a
  // pick against a 0-count menu is correctly flagged.
  const c = { ...CONCEPT_BASE, routing: { ...CONCEPT_BASE.routing, proof_pick: 0 } };
  const w = validateConceptsRound([c], UNIVERSE_1);
  check('C8 validateConceptsRound(concepts, universe) — 2-arg call still works', Array.isArray(w));
}

// ── C. Source-structural checks — the DB-touching parts ───────────────────

check(
  'D1 category fetch is gated on directorProofMenuEnabled() AND product.categoryRef',
  /const category = \(directorProofMenuEnabled\(\) && product\?\.categoryRef\)/.test(svcSrc),
  'a live Category read must never fire when the menu flag is off'
);
check(
  'D2 category_signal is attached via a conditional spread (absent, not null, when off)',
  /\.\.\.\(categorySignal \? \{ ?category_signal: ?categorySignal ?\} ?: ?\{\}\)/.test(svcSrc),
  'the key itself must be ABSENT with the flag off, not merely null-valued'
);
check(
  'D3 proof_options is only assigned inside an `if (directorProofMenuEnabled())` block',
  /if \(directorProofMenuEnabled\(\)\) \{\s*\n\s*socialProofSignal\.proof_options = buildDirectorProofOptions/.test(svcSrc),
  'proof_options must never be attached when the flag is off'
);
check(
  'D4 buildDirectorProofOptions itself does not import mongoose models',
  (() => {
    const fnStart = svcSrc.indexOf('function buildDirectorProofOptions');
    const fnEnd = svcSrc.indexOf('\n// ── Tunables', fnStart);
    const body = svcSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000);
    return !/CatalogProduct\.|Brand\.|Category\.|Media\.|ProductMatchArtifact\./.test(body);
  })(),
  'this function is asserted PURE — a DB read inside it would break the whole point of unit-testing it without Mongo'
);
check(
  'D5a the .select() call itself is unchanged (categoryReviews breadcrumb name)',
  /Category\.findById\(product\.categoryRef\)\.select\('categoryReviews breadcrumb name'\)/.test(svcSrc),
  'must not repeat the silent-.select()-of-an-undeclared-field trap this repo has hit twice already'
);

// D5's first version was a STATIC string match against this file's OWN source
// — it could never detect the actual trap (an undeclared field), because it
// never once read models/Category.js. An adversarial pass proved this by
// deleting `breadcrumb` from the Category schema entirely and re-running:
// D5 stayed green. Fixed by dynamically parsing the real schema, same
// technique scripts/verifyBrandFieldNames.js uses for Brand/CatalogProduct —
// this is that same brace-depth, comment/string-aware key parser, copied
// rather than imported (these scripts are standalone by this repo's own
// convention; `parseBrandSchemaFields` is not exported as a module).
function parseCategorySchemaFields(src, marker = 'const categorySchema = new mongoose.Schema({') {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`schema declaration not found for marker: ${marker}`);
  const openBrace = start + marker.length - 1;
  if (src[openBrace] !== '{') throw new Error('expected `{` at end of the Schema( marker');

  const keys = [];
  let depth = 0, bracketDepth = 0, i = openBrace;
  let inLineComment = false, inBlockComment = false, inSingle = false, inDouble = false, inTemplate = false, escape = false, expectKey = true;
  while (i < src.length) {
    const ch = src[i], next = src[i + 1];
    if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (escape) { escape = false; i++; continue; } if (ch === '\\') { escape = true; i++; continue; } if (ch === "'") inSingle = false; i++; continue; }
    if (inDouble) { if (escape) { escape = false; i++; continue; } if (ch === '\\') { escape = true; i++; continue; } if (ch === '"') inDouble = false; i++; continue; }
    if (inTemplate) { if (escape) { escape = false; i++; continue; } if (ch === '\\') { escape = true; i++; continue; } if (ch === '`') inTemplate = false; i++; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === '`') { inTemplate = true; i++; continue; }
    if (ch === '{') { depth++; expectKey = depth === 1; i++; continue; }
    if (ch === '}') { depth--; if (depth === 0) break; expectKey = false; i++; continue; }
    if (ch === '[') { bracketDepth++; i++; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); i++; continue; }
    if (ch === ',' && depth === 1 && bracketDepth === 0) { expectKey = true; i++; continue; }
    if (expectKey && depth === 1 && bracketDepth === 0) {
      if (/\s/.test(ch)) { i++; continue; }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
        let k = j;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === ':') { keys.push(src.slice(i, j)); expectKey = false; i = k + 1; continue; }
      }
      expectKey = false;
    }
    i++;
  }
  return keys;
}

const categorySrc = fs.readFileSync(path.join(ROOT, 'models', 'Category.js'), 'utf8');
const categorySchemaKeys = parseCategorySchemaFields(categorySrc);
check(
  'D5b categorySchema parse found a plausible field set',
  categorySchemaKeys.length >= 10 && categorySchemaKeys.includes('name') && categorySchemaKeys.includes('categoryReviews'),
  `got ${categorySchemaKeys.length} keys: ${categorySchemaKeys.slice(0, 10).join(', ')}…`
);
check(
  'D5c every field the .select() call names is a REAL declared categorySchema field',
  ['categoryReviews', 'breadcrumb', 'name'].every((f) => categorySchemaKeys.includes(f)),
  `declared fields sample: ${categorySchemaKeys.slice(0, 15).join(', ')}`
);

// ── summary ──────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n❌ verifyDirectorProofMenu: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyDirectorProofMenu: ${pass} checks passed`);
