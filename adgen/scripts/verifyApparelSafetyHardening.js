'use strict';
// Pins the apparel-category safety hardening — a paired change:
//   1. Prompt-side (staticAdIntents.buildPrompt): apparel products get an
//      editorial commercial-catalog framing appended to the role preamble.
//      This changes the string sent to the model but not the semantics of
//      any other slot — the goal is REDUCED moderation false-positive rate
//      from OpenAI gpt-image-2/edit, which measured trigger-happy on
//      Pelagic swimwear catalog images (run_1787684512013_e5feaf12, 4/9
//      statics flagged safety_violations=[sexual]).
//   2. Reference-side (opt-in): shotTypeRank exports APPAREL_SHOT_TYPE_RANK
//      and rankByShotType({ apparelSafe:true }) prefers flat_lay /
//      product_only over on_model / lifestyle. Gated on APPAREL_SAFE_SEED
//      env for opt-in per environment — a change to seed policy is a
//      creative decision that deserves owner sign-off before default-on.
//
// Byte-identical for non-apparel products in both halves. That's the whole
// point — the fix is targeted and conservative.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  const ok = typeof cond === 'function' ? tryCall(cond) : !!cond;
  if (ok === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}${ok !== false ? ` — threw: ${ok}` : ''}`);
}
function tryCall(fn) {
  try { return fn() === false ? false : true; }
  catch (e) { return e.message; }
}

// ── A. apparelCategory helper ──────────────────────────────────────────────
const { isApparelCategory, isApparelSafeSeedEnabled, APPAREL_TOKENS } =
  require(path.join(REPO, 'src', 'services', 'apparelCategory.js'));

check('A1 detects "Swimwear"',            isApparelCategory('Swimwear'));
check('A2 detects "Apparel & Accessories > Clothing > Swimwear"',
  isApparelCategory('Apparel & Accessories > Clothing > Swimwear'));
check('A3 detects "Swim Tops"',           isApparelCategory('Swim Tops'));
check('A4 detects "Bikini"',              isApparelCategory('Bikini'));
check('A5 detects "fishing shirt"',       isApparelCategory('performance fishing shirt'));
check('A6 detects "Activewear"',          isApparelCategory('Activewear'));
check('A7 detects "Lingerie"',            isApparelCategory('Lingerie'));
check('A8 does NOT match "Fishing Rods"', isApparelCategory('Fishing Rods') === false);
check('A9 does NOT match "Home & Garden"', isApparelCategory('Home & Garden') === false);
check('A10 does NOT match "Electronics"', isApparelCategory('Electronics') === false);
check('A11 null/undefined/empty return false',
  isApparelCategory(null) === false
  && isApparelCategory(undefined) === false
  && isApparelCategory('') === false);
check('A12 non-string arg is safe',
  isApparelCategory(42) === false
  && isApparelCategory({}) === false);

// Env flag
const priorFlag = process.env.APPAREL_SAFE_SEED;
delete process.env.APPAREL_SAFE_SEED;
check('A13 seed flag defaults OFF (env absent)', isApparelSafeSeedEnabled() === false);
process.env.APPAREL_SAFE_SEED = 'true';
check('A14 seed flag ON when env=true', isApparelSafeSeedEnabled() === true);
process.env.APPAREL_SAFE_SEED = 'TRUE';
check('A15 seed flag ON when env=TRUE (case-insensitive)', isApparelSafeSeedEnabled() === true);
process.env.APPAREL_SAFE_SEED = '1';
check('A16 seed flag OFF when env=1 (strict "true" only)', isApparelSafeSeedEnabled() === false);
if (priorFlag == null) delete process.env.APPAREL_SAFE_SEED; else process.env.APPAREL_SAFE_SEED = priorFlag;

check('A17 token list is not empty', Array.isArray(APPAREL_TOKENS) && APPAREL_TOKENS.length >= 20);

// ── B. shotTypeRank apparel-safe variant ──────────────────────────────────
const {
  SHOT_TYPE_RANK,
  APPAREL_SHOT_TYPE_RANK,
  rankByShotType,
  rankOf
} = require(path.join(REPO, 'src', 'services', 'shotTypeRank.js'));

check('B1 default ranks lifestyle first',
  SHOT_TYPE_RANK.lifestyle < SHOT_TYPE_RANK.flat_lay);
check('B2 apparel-safe ranks flat_lay first',
  APPAREL_SHOT_TYPE_RANK.flat_lay < APPAREL_SHOT_TYPE_RANK.on_model
  && APPAREL_SHOT_TYPE_RANK.flat_lay < APPAREL_SHOT_TYPE_RANK.lifestyle);
check('B3 apparel-safe ranks product_only above on_model',
  APPAREL_SHOT_TYPE_RANK.product_only < APPAREL_SHOT_TYPE_RANK.on_model);
check('B4 apparel-safe ranks lifestyle LAST of the human tiers',
  APPAREL_SHOT_TYPE_RANK.lifestyle > APPAREL_SHOT_TYPE_RANK.on_model);
check('B5 both maps preserve the low tiers (detail/packaging/unknown)',
  SHOT_TYPE_RANK.detail    === APPAREL_SHOT_TYPE_RANK.detail
  && SHOT_TYPE_RANK.packaging === APPAREL_SHOT_TYPE_RANK.packaging
  && SHOT_TYPE_RANK.unknown === APPAREL_SHOT_TYPE_RANK.unknown);

// Behavioural: sort a real pool
const pool = [
  { _id: 'A', classification: { shotType: 'on_model'    }, createdAt: new Date('2026-01-01') },
  { _id: 'B', classification: { shotType: 'flat_lay'    }, createdAt: new Date('2026-01-02') },
  { _id: 'C', classification: { shotType: 'lifestyle'   }, createdAt: new Date('2026-01-03') },
  { _id: 'D', classification: { shotType: 'product_only'}, createdAt: new Date('2026-01-04') },
];
const defaultOrder  = rankByShotType(pool).map((m) => m._id);
const apparelOrder  = rankByShotType(pool, { apparelSafe: true }).map((m) => m._id);
check('B6 default order: C(lifestyle), A(on_model), B(flat_lay), D(product_only)',
  JSON.stringify(defaultOrder) === JSON.stringify(['C', 'A', 'B', 'D']),
  `got ${JSON.stringify(defaultOrder)}`);
check('B7 apparel-safe order: B(flat_lay), D(product_only), A(on_model), C(lifestyle)',
  JSON.stringify(apparelOrder) === JSON.stringify(['B', 'D', 'A', 'C']),
  `got ${JSON.stringify(apparelOrder)}`);
check('B8 rankByShotType default arg preserves legacy signature',
  JSON.stringify(rankByShotType(pool).map((m) => m._id))
  === JSON.stringify(rankByShotType(pool, {}).map((m) => m._id)),
  'a call without options must equal a call with empty options');

// ── C. prompt-side integration ─────────────────────────────────────────────
const intentsPath = path.join(REPO, 'src', 'services', 'staticAdIntents.js');
const intents = fs.readFileSync(intentsPath, 'utf8');

check('C1 buildPrompt requires isApparelCategory (lazy require inside the fn)',
  /require\(['"]\.\/apparelCategory['"]\)[\s\S]{0,80}?isApparelCategory/.test(intents),
  'lazy inside buildPrompt avoids a circular require at module load');
check('C2 apparelClause reads product?.category (not a hard property access)',
  /apparelClause\s*=\s*\(FIDELITY_HARDENING\s*&&\s*isApparelCategory\(product\?\.category\)\)/.test(intents),
  'a plain product.category access would throw when buildPrompt is called with product:null in tests');
check('C3 apparelClause is EMPTY when non-apparel or FIDELITY_HARDENING off',
  /apparelClause\s*=[\s\S]{0,300}?:\s*['"]{2}\s*;/.test(intents),
  'the fallback string must be "" — a truthy fallback would change every non-apparel prompt');
check('C4 rolePreamble concats apparelClause verbatim inside the FIDELITY_HARDENING arm',
  /rolePreamble\s*=\s*FIDELITY_HARDENING[\s\S]{0,400}?apparelClause[\s\S]{0,50}?\\n\\n/.test(intents),
  'must interpolate inside the SAME template literal so flag-off arm stays byte-identical to baseline');
check('C5 apparel clause mentions "catalog photography" (semantic anchor)',
  /apparel catalog photography/i.test(intents),
  'the exact phrase the model reads — moving away from it needs a re-measured A/B');

// ── D. renderer wires product.category through ─────────────────────────────
const dirImg = fs.readFileSync(
  path.join(REPO, 'src', 'services', 'directImageRenderService.js'),
  'utf8'
);
check('D1 renderer includes category alongside desc/look/logoCorner',
  /product:\s*\{[\s\S]{0,600}?logoCorner:\s*['"]bottom-right['"][\s\S]{0,800}?category:\s*resolvedProduct\?\.category/.test(dirImg),
  'without this thread, buildPrompt sees product.category=undefined and the apparel clause never fires');
check('D2 renderer falls back to layoutInput.product.category',
  /category:\s*resolvedProduct\?\.category[\s\S]{0,200}?effectiveLayout\?\.input\?\.product\?\.category/.test(dirImg),
  'CatalogProduct.category may be missing on legacy rows; layoutInput has its own copy');

// ── E. behavioural prompt check via buildPrompt ────────────────────────────
// Byte-identical output for non-apparel, extended for apparel — proves the
// SEMANTIC contract, not just the regex on source. Uses the real function.
process.env.STATIC_PROMPT_FIDELITY_HARDENING = 'true';
delete require.cache[require.resolve(path.join(REPO, 'src', 'services', 'staticAdIntents.js'))];
const rebuiltIntents = require(path.join(REPO, 'src', 'services', 'staticAdIntents.js'));

// Minimal data shape sufficient for buildPrompt not to crash. Real callers
// pass much more, but this proves the apparel branch fires / doesn't fire.
const commonArgs = {
  intentKey: 'product_first_lifestyle',
  data: {
    core:     ['HERO PHRASE'],
    optional: [],
    strings:  {},
    // Empty rating so we don't hit rating-furniture branches.
    rating:   null,
    ratingSource: null,
    ratingScope: 'brand',
    reviewsText:  null
  },
  surface: 'meta_feed_1_1',
  seedStyle: 'lifestyle',
  variantKind: 'product_image',
  seedAspect: '1_1'
};

// Same desc — vary ONLY the category so any prompt-string delta MUST be the
// apparel clause, not the product description.
const SAME_DESC = 'a garment';
let apparelPrompt, nonApparelPrompt, nullCategoryPrompt;
try {
  apparelPrompt = rebuiltIntents.buildPrompt({
    ...commonArgs,
    product: { desc: SAME_DESC, logoCorner: 'bottom-right', category: 'Swimwear' }
  }).prompt;
  nonApparelPrompt = rebuiltIntents.buildPrompt({
    ...commonArgs,
    product: { desc: SAME_DESC, logoCorner: 'bottom-right', category: 'Fishing Rods' }
  }).prompt;
  nullCategoryPrompt = rebuiltIntents.buildPrompt({
    ...commonArgs,
    product: { desc: SAME_DESC, logoCorner: 'bottom-right', category: null }
  }).prompt;
} catch (e) {
  check('E0 buildPrompt runs against minimal fixture', false, e.message);
}

if (apparelPrompt && nonApparelPrompt) {
  check('E1 apparel prompt contains "apparel catalog photography"',
    /apparel catalog photography/.test(apparelPrompt));
  check('E2 non-apparel prompt does NOT contain "apparel catalog photography"',
    !/apparel catalog photography/.test(nonApparelPrompt));
  // With same desc, the two prompts should differ ONLY by the apparel
  // clause. Strip it from apparel prompt and confirm equality with non-
  // apparel.
  const stripped = apparelPrompt.replace(
    / This is professional apparel catalog photography for a legitimate retailer[^.]*\./,
    ''
  );
  check('E3 the two prompts differ ONLY on the apparel clause',
    stripped === nonApparelPrompt,
    `stripped-apparel length=${stripped.length}, non-apparel length=${nonApparelPrompt.length}`);
  check('E4 null category ⇒ no apparel clause',
    !/apparel catalog photography/.test(nullCategoryPrompt));
  check('E5 null category prompt is byte-identical to non-apparel',
    nullCategoryPrompt === nonApparelPrompt,
    'category:null and category:"Fishing Rods" both fail the apparel check, so both must produce the identical baseline prompt');
}

// ── report
console.log(`\nverifyApparelSafetyHardening: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ apparel-category safety hardening in place — prompt clause + apparel-safe rank export');
