#!/usr/bin/env node
/**
 * Offline harness for the 2026-08-10 social-proof restoration.
 * No DB, no network, no API key.
 *
 * WHAT BROKE, MEASURED IN PRODUCTION (Render logs, 2026-07-30..08-06):
 *   ai_brand_led 200+ renders · ai_editorial 111 · ai_promotional 38 ·
 *   ai_social_proof_led 18 · ai_ugc_led 2.
 *   And 7 of those 18 social-proof ads logged
 *   `intent=objection_resolved(fell back from social_proof_led)`.
 *
 * TWO INDEPENDENT CAUSES, one harness:
 *
 *   A. Ad.template is minted from the Director's routing.creative_style
 *      (CREATIVE_STYLE_TO_TEMPLATE, campaignAdsGenerationService) and anything
 *      unrecognised falls to 'ai_brand_led'. The live round prompt's ENTIRE
 *      guidance was one bare enum line — the string "social_proof_led" appeared
 *      exactly once in the whole service (the enum) and in ZERO guidance. The
 *      model had no criteria, so it defaulted.
 *
 *   B. resolveCoherentSocialProof hard-nulled brand numbers whenever a
 *      product/comment-tier quote was on frame (tier-coherence invariant #4).
 *      Most product ads have a comment-tier quote and no product rating, so
 *      social_proof_led — whose `core` IS the rating — went ineligible and fell
 *      back. Owner overruled this for the labelled static path on 2026-08-07.
 *
 * REVERT-PROVEN — 13 mutations, each confirmed to FAIL with the fix backed out,
 * and the suite confirmed to return to green after each restore:
 *   round 1 (original implementation)
 *   - delete the creative_style criteria block          → A1/A2
 *   - drop creative_style from the diversity line       → A4
 *   - make the reserved slot unconditional              → A6 (contradiction)
 *   - remove the honesty-rule proof_options clause      → A7
 *   - leave DIRECTOR_SIGNALS_VERSION at 3.1.0           → B1
 *   - default allowLabeledBrandNumbers to true          → C1 (video blast radius)
 *   - unwire the static opt-in                          → D1/D3
 *   round 2 (hardening, after two independent adversarial passes)
 *   - truthy gate instead of `=== true`                 → C7d (string "false" opted IN)
 *   - drop the brand-count requirement                  → C7b (unscoped "4.7 ★" printed)
 *   - re-enable allowBrandCountWithoutStars             → C7 (brand volume beside a product quote)
 *   - reserved slot back to any-proof                   → A5b (quote-only mints then falls back)
 *   - ungate proof_options from the menu flag           → A6b (flag-off contradiction)
 *   - remove the kill switch from defaults.env          → D6
 *
 * WHAT THE ADVERSARIAL PASSES CAUGHT that 28 green checks and my own read did
 * not — recorded because it is the argument for running them at all:
 *   HIGH  a stars-only brand pair (rating, no count) returned source:'brand' with
 *         reviewsText:null, so staticAdIntents rendered a BARE "4.7 ★" beside a
 *         product/comment testimonial — no "brand reviews" qualifier, i.e. exactly
 *         the misattribution the owner's instruction exists to prevent, and exactly
 *         what the code's own comment claimed was structurally impossible.
 *   HIGH  the original C3 only ever fixtured a brand pair WITH a count, so it could
 *         never have caught the above. A check that cannot fail is not a check.
 *   MED   the reserved slot treated a quote alone as proof, which would MINT
 *         ai_social_proof_led on products that then fall back at render — the very
 *         collapse this change exists to stop.
 *
 * Run: node scripts/verifySocialProofRestoration.js   (no DB, no network, no key)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const director = require('../services/aiCreativeDirectorService');
const rd = require('../services/ratingDisplay');

const SERVICE_DIR = path.join(__dirname, '..', 'services');
const DEFAULTS_ENV = path.join(__dirname, '..', 'config', 'defaults.env');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`   • ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
}

// ── fixtures ────────────────────────────────────────────────────────────
function summary({ rating = null, quote = null, comments = [], options = null } = {}) {
  const sp = {
    rating, primary_quote: quote, top_comments: comments,
    strongest_signal: quote ? 'testimonial' : rating ? 'rating' : comments.length ? 'creator' : null,
    proof_density: (quote ? 1 : 0) + comments.length,
  };
  if (options) sp.proof_options = options;
  return {
    brand_signal:   { name: 'Testbrand', tagline: 'Move better', description: 'A brand.', has_logo: true },
    product_signal: { name: 'Test Product', description: 'A product.', price: '$50' },
    social_proof_signal: sp,
    ugc_signal: { shot_type_distribution: {}, content_nature_distribution: {}, file_type_distribution: {} },
    performance_signal: {},
  };
}
const UNIVERSE = [
  { mediaId: 'm1', role: 'catalog', fileType: 'image', metadata: { shotType: 'lifestyle', imageRole: 'hero' } },
  { mediaId: 'm2', role: 'catalog', fileType: 'image', metadata: { shotType: 'on_model' } },
];
const buildRound = (inputSummary, platformFormat = 'meta_feed_1_1') => {
  const r = director.buildPromptRound({
    inputSummary, creativeIntent: 'conversion', platformFormat,
    universe: UNIVERSE, roundIndex: 0, avoidList: [],
  });
  return typeof r === 'string' ? r : r.system;
};
const FORMATS = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16', 'meta_reels_9_16'];
const SHAPES = {
  'no proof':            summary({}),
  'product rating':      summary({ rating: { value: 4.6, count: 120 } }),
  'quote only':          summary({ quote: { text: 'These run true to size and last.', author: 'Alex' } }),
  'comments only':       summary({ comments: [{ text: 'so comfortable', author: 'x', likes: 5 }] }),
  'brand proof_options': summary({ options: [{ tier: 'brand', rating: 4.6, review_count: 15000, reviews_text: '15000 brand reviews' }] }),
};
const shapeHasProof = (s) => {
  const p = s.social_proof_signal;
  return !!(p.rating || p.primary_quote || p.top_comments.length || (p.proof_options || []).length);
};
const ORIGINAL_HONESTY_PREFIX =
  '- HONESTY RULE: if social_proof_signal.primary_quote is null AND top_comments is empty AND rating is null, you MUST set';

// The menu flag is read at call time, so both arms are testable in-process.
// Defined here (not below the A group) because `const` is not hoisted and the
// A6b check calls it — an earlier revision had the definition after its first
// use, which surfaced as a ReferenceError swallowed into a check failure.
const withFlag = (val, fn) => {
  const prev = process.env.DIRECTOR_PROOF_MENU_ENABLED;
  if (val === null) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
  else process.env.DIRECTOR_PROOF_MENU_ENABLED = val;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.DIRECTOR_PROOF_MENU_ENABLED;
    else process.env.DIRECTOR_PROOF_MENU_ENABLED = prev;
  }
};

// ═══════════════ A. Director creative_style guidance ═══════════════
console.log('\nA. Director round prompt — creative_style guidance + reserved slot');
const withProof = () => buildRound(SHAPES['product rating']);

check('A1 creative_style criteria block present (not a bare enum)', () => {
  const p = withProof();
  assert.ok(p.includes('- CREATIVE STYLE: set routing.creative_style to the ONE style'),
    'criteria header missing');
  assert.ok(!p.includes('- CREATIVE STYLE: pick one of'),
    'the old bare-enum line is still there');
});
check('A2 social_proof_led AND brand_led both described; brand_led is last resort', () => {
  const p = withProof();
  assert.ok(p.includes('social_proof_led — the visual anchor IS proof'), 'social_proof_led criterion missing');
  assert.ok(p.includes('brand_led — brand voice'), 'brand_led criterion missing');
  assert.ok(p.includes('DEFAULT OF LAST RESORT'),
    'brand_led must be framed as last resort — it is the silent default downstream');
});
// AMENDED 2026-08-12: this used to iterate the full CREATIVE_STYLES_ENUM. That
// invariant ("the menu is the enum") was deliberately broken when `promotional`
// became opt-in — it is now offered only when Campaign.kind === 'promotional',
// on BOTH the prompt menu and the response-schema enum. See
// scripts/verifyPromotionalOptIn.js for the full contract.
//
// The check is retained in its stronger form rather than deleted: every style
// the run is ALLOWED to emit must still carry a criterion line, and a style it
// is NOT allowed to emit must NOT be advertised. Advertising an unselectable
// style is the exact defect that cost a paid Director round on 2026-08-12.
//
// SCOPE — do not mistake this for a policy guard. A3 derives `allowed` from the
// same creativeStylesFor() the prompt builder uses, so it verifies MENU/HELPER
// AGREEMENT and nothing more. Gutting creativeStylesFor to return the full enum
// leaves A3 green (measured), because both sides move together. The POLICY
// assertion — that promotional is withheld unless Campaign.kind==='promotional'
// — lives in scripts/verifyPromotionalOptIn.js groups A/B/C, which fails 10
// checks on exactly that mutation. Keep both; neither covers the other.
check('A3 every ALLOWED style gets a criterion, and no disallowed style is advertised', () => {
  const p = withProof();                         // campaignKind omitted => promotional withheld
  const allowed = director.creativeStylesFor(null);
  for (const style of allowed) {
    assert.ok(p.includes(`    ${style} — `), `no criterion line for allowed style ${style}`);
  }
  for (const style of director.CREATIVE_STYLES_ENUM.filter((s) => !allowed.includes(s))) {
    assert.ok(!p.includes(`    ${style} — `),
      `${style} is advertised in the menu but is not selectable for this run`);
  }
});
check('A3b the opt-in path restores the promotional criterion', () => {
  const p = director.buildPromptRound({
    inputSummary: SHAPES['product rating'], creativeIntent: 'conversion',
    platformFormat: 'meta_feed_1_1', universe: UNIVERSE, roundIndex: 0, avoidList: [],
    campaignKind: 'promotional'
  });
  const sys = typeof p === 'string' ? p : p.system;
  for (const style of director.CREATIVE_STYLES_ENUM) {
    assert.ok(sys.includes(`    ${style} — `), `no criterion line for ${style} on a promotional campaign`);
  }
});
check('A4 diversity rule includes creative_style as a variety axis', () => {
  assert.ok(withProof().includes('different creative_style'), 'creative_style not in the diversity axes');
});
check('A5 reserved slot fires on a RATING (all formats)', () => {
  for (const fmt of FORMATS) {
    assert.ok(buildRound(SHAPES['product rating'], fmt).includes('- PROOF-LED COVERAGE:'),
      `reserved slot missing for a rating-bearing product on ${fmt}`);
  }
});
check('A5b reserved slot does NOT fire on a quote or comment ALONE', () => {
  // Adversarial finding: INTENTS.social_proof_led.eligible is RATING-ONLY, so
  // forcing social_proof_led on a quote-only product mints the template and then
  // falls straight back to objection_resolved at render — amplifying the exact
  // collapse this change fixes. The slot must track render eligibility.
  for (const label of ['quote only', 'comments only']) {
    for (const fmt of FORMATS) {
      assert.ok(!buildRound(SHAPES[label], fmt).includes('- PROOF-LED COVERAGE:'),
        `reserved slot fired for "${label}" on ${fmt} — that ad cannot render as social_proof_led`);
    }
  }
});
check('A6 reserved slot ABSENT with zero proof — must not contradict the honesty rule', () => {
  for (const fmt of FORMATS) {
    const p = buildRound(SHAPES['no proof'], fmt);
    assert.ok(!p.includes('- PROOF-LED COVERAGE:'),
      `reserved slot fired with zero proof on ${fmt} — the prompt would demand a proof concept while forbidding proof`);
    assert.ok(p.includes('you MUST set routing.social_proof_type="none"'),
      'honesty rule should still fire with zero proof');
  }
});
check('A6b MUTUAL EXCLUSION holds even for an orphan proof_options with the menu OFF', () => {
  // Adversarial finding: hasUsableProof counted proof_options unconditionally
  // while the flag-OFF honesty rule never mentions them, so an injected or stale
  // summary could fire the reserved slot AND the "set none" rule at once.
  withFlag(null, () => {
    const p = buildRound(SHAPES['brand proof_options']);
    const honestyDemandsNone = p.includes('you MUST set routing.social_proof_type="none"')
      && !p.includes('proof_options is empty');
    const reserved = p.includes('- PROOF-LED COVERAGE:');
    assert.ok(!(honestyDemandsNone && reserved),
      'flag-off orphan proof_options produced a self-contradictory prompt');
  });
});

check('A7 menu ON: honesty rule gains the proof_options escape, original replaced', () => {
  withFlag('true', () => {
    const p = buildRound(SHAPES['no proof']);
    assert.ok(p.includes('AND social_proof_signal.proof_options is empty'),
      'amended honesty rule missing — brand proof would be offered and forbidden at once');
    assert.ok(p.includes('When proof_options IS non-empty, proof CAN be backed'),
      'escape clause missing');
    assert.ok(!p.includes(ORIGINAL_HONESTY_PREFIX),
      'both honesty-rule variants emitted — contradictory');
    assert.ok(p.includes('- PROOF MENU:'), 'proof menu line missing when flag on');
  });
});
check('A8 menu OFF: original honesty rule verbatim, no menu leakage (kill switch)', () => {
  withFlag(null, () => {
    for (const fmt of FORMATS) {
      const p = buildRound(SHAPES['no proof'], fmt);
      assert.ok(p.includes(ORIGINAL_HONESTY_PREFIX),
        `original honesty rule not preserved verbatim on ${fmt}`);
      assert.ok(!p.includes('proof_options is empty'), 'amended rule leaked with flag off');
      assert.ok(!p.includes('- PROOF MENU:'), 'proof menu leaked with flag off');
    }
  });
});
check('A9 brand-tier proof_options alone counts as proof (the whole point of the flip)', () => {
  withFlag('true', () => {
    assert.ok(buildRound(SHAPES['brand proof_options']).includes('- PROOF-LED COVERAGE:'),
      'brand-only proof did not trigger the reserved slot');
  });
});

// ═══════════════ B. Signals version / flag pairing ═══════════════
console.log('B. DIRECTOR_SIGNALS_VERSION ↔ proof-menu flag pairing');
const directorSrc = fs.readFileSync(path.join(SERVICE_DIR, 'aiCreativeDirectorService.js'), 'utf8');
const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
const versionMatch = directorSrc.match(/^const DIRECTOR_SIGNALS_VERSION = '([^']+)'/m);

check('B1 version bumped past 3.1.0 (cache must invalidate or the flip is a no-op)', () => {
  assert.ok(versionMatch, 'could not read DIRECTOR_SIGNALS_VERSION');
  const v = versionMatch[1];
  assert.notStrictEqual(v, '3.1.0',
    'flag flipped without bumping the version — every cached CreativeDirectionArtifact keeps serving the narrower brief and the fix looks deployed while doing nothing');
  const [maj, min] = v.split('.').map(Number);
  assert.ok(maj > 3 || (maj === 3 && min >= 2), `expected >= 3.2.0, got ${v}`);
});
check('B2 defaults.env enables the proof menu', () => {
  assert.ok(/^DIRECTOR_PROOF_MENU_ENABLED=true$/m.test(envSrc),
    'DIRECTOR_PROOF_MENU_ENABLED=true not found in config/defaults.env');
});
check('B3 the pairing is documented at the version constant', () => {
  assert.ok(/DIRECTOR_PROOF_MENU_ENABLED/.test(directorSrc.slice(0, 12000)),
    'version comment no longer explains the flag pairing');
});
check('B4 stale "DELIBERATELY NOT BUMPED" claim is gone', () => {
  assert.ok(!directorSrc.includes('DELIBERATELY NOT BUMPED'),
    'comment still says the version was deliberately not bumped — it now is');
});

// ═══════════════ C. Tier-lock exception (the money-adjacent one) ═══════════════
console.log('C. resolveCoherentSocialProof — labelled brand numbers beside a product/comment quote');

const commentQuote = { text: 'These are unbelievably comfortable for long days.', tier: 'comment' };
const productQuote = { text: 'Fits true to size and holds shape after washing.', tier: 'product' };
const BRAND_PAIR = { rating: 4.6, reviewCount: 15000 };
const PRODUCT_PAIR = { rating: 4.8, reviewCount: 240 };

const resolve = (over = {}) => rd.resolveCoherentSocialProof({
  quote: commentQuote,
  product: null,
  brand: BRAND_PAIR,
  brandAttribution: 'testbrand.com',
  renderedQuoteText: commentQuote.text,
  ...over,
});

check('C1 DEFAULT IS OFF — video/every existing caller unchanged by construction', () => {
  const r = resolve();                       // no allowLabeledBrandNumbers passed
  assert.strictEqual(r.rating, null,
    'brand stars leaked to a comment-tier quote WITHOUT opt-in — this is the video blast radius');
  assert.strictEqual(r.reviewCount, null, 'brand count leaked without opt-in');
});
check('C2 opt-in ON: comment-tier quote KEEPS printing and brand stars appear', () => {
  const r = resolve({ allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, '4.6', `expected brand stars 4.6, got ${r.rating}`);
  assert.ok(r.quote && r.quote.text === commentQuote.text, 'the quote must still print — owner: keep the comment');
  assert.strictEqual(r.quoteTier, 'comment', 'quote tier lost');
});
check('C3 the number is SCOPE-LABELLED — "brand reviews", never bare', () => {
  const r = resolve({ allowLabeledBrandNumbers: true });
  assert.ok(r.source === 'brand' || r.source === 'brand-count', `source must stay brand-side, got ${r.source}`);
  assert.ok(r.reviewsText && /brand review/i.test(r.reviewsText),
    `reviewsText must carry the brand scope label, got ${JSON.stringify(r.reviewsText)}`);
  assert.ok(r.reviewsTextShort && /brand review/i.test(r.reviewsTextShort),
    `short form must also carry the scope label, got ${JSON.stringify(r.reviewsTextShort)}`);
});
check('C4 ORDERING — product numbers still win when they exist (exception only ADDS)', () => {
  const r = resolve({ product: PRODUCT_PAIR, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.source, 'product', `product numbers must win, got ${r.source}`);
  assert.strictEqual(r.rating, '4.8', `expected product 4.8, got ${r.rating}`);
  assert.ok(!/brand review/i.test(r.reviewsText || ''), 'product tier must not be labelled brand');
});
check('C5 product-tier quote also benefits (owner: only comment-tier was contentious)', () => {
  const r = resolve({ quote: productQuote, renderedQuoteText: productQuote.text, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, '4.6', 'brand stars should back a product quote with no product numbers');
  assert.ok(/brand review/i.test(r.reviewsText || ''), 'still must be scope-labelled');
});
check('C6 no brand data → still withheld, no fabrication', () => {
  const r = resolve({ brand: null, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, null, 'invented a rating from nothing');
  assert.strictEqual(r.reviewCount, null, 'invented a count from nothing');
});
check('C7 weak brand rating below the floor prints NOTHING — not even a count', () => {
  const r = resolve({ brand: { rating: 3.1, reviewCount: 40 }, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, null, `a 3.1 must never print stars, got ${r.rating}`);
  // An earlier draft allowed allowBrandCountWithoutStars:true here, so this
  // returned source:'brand-count' with "40 brand reviews" beside a COMMENT
  // quote — a brand volume claim next to a product testimonial, which the
  // resolver's own contract forbids, and which did not even restore the intent
  // (eligibility is rating-only). Stars or nothing.
  assert.strictEqual(r.reviewCount, null,
    `a sub-floor brand pair must not print a count either, got ${r.reviewCount}`);
  assert.notStrictEqual(r.source, 'brand-count', 'brand-count must never win beside a product/comment quote');
});
check('C7b STARS-WITHOUT-COUNT is refused — no count means no scope label vehicle', () => {
  // THE HIGH FINDING both adversarial passes caught. packCoherentProof derives
  // reviewsText from the COUNT, so a stars-only brand pair yielded
  // source:'brand' with reviewsText:null, and staticAdIntents' RATING line then
  // rendered a bare "4.7 ★" beside a product/comment quote with no "brand
  // reviews" qualifier at all. C3 could never catch it (it only ever fixtured a
  // count), which is why this case is its own check.
  const r = resolve({ brand: { rating: 4.7, reviewCount: null }, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, null,
    `stars-only brand pair must be refused (no label vehicle), got rating=${r.rating} reviewsText=${JSON.stringify(r.reviewsText)}`);
});
check('C7c any brand-side win ALWAYS carries the scope label (label is inseparable)', () => {
  for (const brand of [{ rating: 4.6, reviewCount: 15000 }, { rating: 4.5, reviewCount: 12 }, { rating: 5, reviewCount: 1 }]) {
    const r = resolve({ brand, allowLabeledBrandNumbers: true });
    if (r.rating == null) continue;              // refused is fine
    assert.ok(r.reviewsText && /brand review/i.test(r.reviewsText),
      `brand win without a scope label for ${JSON.stringify(brand)} → reviewsText=${JSON.stringify(r.reviewsText)}`);
  }
});
check('C7d opt-in is STRICTLY boolean — a raw env string must not opt in', () => {
  // Probed: `if (allowLabeledBrandNumbers)` let the literal string "false" opt IN.
  for (const truthyString of ['false', 'FALSE', '0', 'no']) {
    const r = resolve({ brand: { rating: 4.6, reviewCount: 15000 }, allowLabeledBrandNumbers: truthyString });
    assert.strictEqual(r.rating, null,
      `the string ${JSON.stringify(truthyString)} opted in — gate must compare === true`);
  }
});
check('C7e product-count still wins over the exception (no displacement)', () => {
  // A product pair with a sub-floor rating but a real count returns
  // product-count and short-circuits the exception. That leaves
  // social_proof_led ineligible, which is a KNOWN, ACCEPTED residual: fixing it
  // would mean brand numbers displacing a product-tier number, which is a
  // second override nobody has approved. Pinned so the behaviour is a decision,
  // not an accident.
  const r = resolve({ product: { rating: 3.0, reviewCount: 12 }, brand: { rating: 4.8, reviewCount: 20000 }, allowLabeledBrandNumbers: true });
  assert.strictEqual(r.source, 'product-count', `expected product-count to win, got ${r.source}`);
  assert.strictEqual(r.rating, null, 'product-count carries no stars by design');
});
check('C8 fail-closed still holds: unverifiable rendered text withholds even with opt-in', () => {
  const r = resolve({ renderedQuoteText: 'a completely different line', allowLabeledBrandNumbers: true });
  assert.strictEqual(r.rating, null,
    'opt-in must not bypass the renderedQuoteText check — that guard stops a substituted quote earning numbers');
});
check('C9 brand/category quote path unchanged by the exception', () => {
  const bq = { text: 'Best outerwear brand I have bought from.', tier: 'brand' };
  const a = rd.resolveCoherentSocialProof({ quote: bq, product: null, brand: BRAND_PAIR, brandAttribution: 'testbrand.com', renderedQuoteText: bq.text });
  const b = rd.resolveCoherentSocialProof({ quote: bq, product: null, brand: BRAND_PAIR, brandAttribution: 'testbrand.com', renderedQuoteText: bq.text, allowLabeledBrandNumbers: true });
  assert.deepStrictEqual(b, a, 'the opt-in changed the brand-quote branch, which it must not touch');
});
check('C10 no-quote rating-only path unchanged by the exception', () => {
  const a = rd.resolveCoherentSocialProof({ quote: null, product: null, brand: BRAND_PAIR, brandAttribution: 'testbrand.com' });
  const b = rd.resolveCoherentSocialProof({ quote: null, product: null, brand: BRAND_PAIR, brandAttribution: 'testbrand.com', allowLabeledBrandNumbers: true });
  assert.deepStrictEqual(b, a, 'the opt-in changed the no-quote branch, which it must not touch');
});

// ═══════════════ D. Wiring + kill switch ═══════════════
console.log('D. Static wiring + kill switch');
const directImgSrc = fs.readFileSync(path.join(SERVICE_DIR, 'directImageRenderService.js'), 'utf8');
const ratingSrc = fs.readFileSync(path.join(SERVICE_DIR, 'ratingDisplay.js'), 'utf8');

check('D1 static path passes the opt-in', () => {
  assert.ok(/allowLabeledBrandNumbers:\s*STATIC_BRAND_STARS_WITH_QUOTE/.test(directImgSrc),
    'directImageRenderService does not wire the opt-in through the kill switch');
});
check('D2 kill switch defaults ON but is env-revertible without a deploy', () => {
  assert.ok(/STATIC_BRAND_STARS_WITH_QUOTE\s*=\s*\n?\s*String\(process\.env\.STATIC_BRAND_STARS_WITH_QUOTE\s*\?\?\s*'true'\)/.test(directImgSrc),
    'kill switch missing or not defaulted to true');
});
check('D3 ONLY the static path opts in — recursive over services/ AND routes/', () => {
  // Was a non-recursive readdir over services/ only, so a routes/ or nested
  // opt-in would never have been seen.
  const roots = [SERVICE_DIR, path.join(__dirname, '..', 'routes')];
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // Skip dotfiles/dotdirs — same convention as verifyMetaApiVersion.js's
      // fix (real, reproduced revertprove-race in CI: a sibling harness
      // briefly writes a `.__revertprove_*.js` transient into services/ or
      // routes/, both scanned here).
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (full === path.join(SERVICE_DIR, 'ratingDisplay.js')) continue;   // the definition itself
      if (/allowLabeledBrandNumbers/.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(path.join(__dirname, '..'), full));
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  assert.deepStrictEqual(hits, ['services/directImageRenderService.js'],
    `unexpected opt-in caller(s): ${hits.join(', ')} — video must never opt in`);
});
check('D6 the kill switch is COMMITTED to defaults.env, not just a code default', () => {
  // Adversarial finding: D2/D5 advertised a no-deploy revert while the key existed
  // only as `?? 'true'` in code, so flipping it would have meant a dashboard edit —
  // and per CLAUDE.md §4a non-secret config belongs in the committed file.
  assert.ok(/^STATIC_BRAND_STARS_WITH_QUOTE=true$/m.test(envSrc),
    'STATIC_BRAND_STARS_WITH_QUOTE missing from config/defaults.env');
});
check('D4 the parameter defaults to false at the definition', () => {
  assert.ok(/allowLabeledBrandNumbers\s*=\s*false/.test(ratingSrc),
    'default must be false so non-opting callers are byte-identical');
});
check('D5 the owner override is documented at the invariant it overrules', () => {
  assert.ok(/OWNER-APPROVED EXCEPTION/.test(ratingSrc), 'invariant #4 does not record the exception');
  assert.ok(/STATIC_BRAND_STARS_WITH_QUOTE=false/.test(ratingSrc),
    'the docs must name the revert path so a future session flips the flag instead of deleting the code');
});

// ── report ──────────────────────────────────────────────────────────────
const total = pass + fail;
if (fail === 0) {
  console.log(`\n✅ verifySocialProofRestoration: ${pass}/${total} checks passed\n`);
  process.exit(0);
}
console.log(`\n❌ verifySocialProofRestoration: ${fail} FAILED, ${pass} passed\n`);
process.exit(1);
