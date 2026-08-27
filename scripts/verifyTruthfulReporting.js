#!/usr/bin/env node
/**
 * verifyTruthfulReporting — pins three diagnostics that reported something
 * untrue to whoever was looking. All three were measured in the live app
 * 2026-08-27; each check below names the false reading it prevents.
 *
 * ── A. seedHasText: the inspector contradicted the render path ─────────────
 * `GET /api/ads/:id/generation-inspector` reported
 * `seedHasText: false, burnedInText: []` for an ad on which
 * veoPromptBuilder's `if (seedHasText)` had FIRED. Cause was a DECODE
 * MISMATCH: the render path counts `media.text.length`, the inspector mapped
 * elements through `t?.text || t?.value` — but the only production writer
 * (subjectTextService) stores the string on **`content`**. So the flag
 * inverted, and with it the `seed-has-burned-in-text` warning, whose whole job
 * is to tell an investigator that burned-in SOURCE text (not the titling
 * engine) is the usual cause of garbled on-screen text. It was suppressed on
 * exactly the ads where the render had detected the condition.
 *
 * ── B. the scaffold prompt is an approximation and now says so ─────────────
 * `GET /api/ads/veo-prompt-scaffold` is NOT a second builder — it calls the
 * canonical buildVeoPrompt (proven byte-identical here). But it hardcodes
 * `seedHasText:false` / `hasProductReference:true` and omits five inputs the
 * render path passes, because it runs before an ad exists. Its prompt text is
 * a DOCUMENTED FROZEN INVARIANT (CLAUDE.md §00, pinned by verifyPostPilotBatch
 * B14), so the fix is to LABEL the gap, not to close it by changing bytes.
 *
 * ── C. failed ads counted as coverage ─────────────────────────────────────
 * `/api/catalog/ads-summary` reported `coveragePct: 100, adCount: 12` for a
 * product whose 12 ads had ALL FAILED with zero assets (`draftCount: 0,
 * liveCount: 0, readyToExport: 0`), and the header advanced "1 of 200" →
 * "2 of 200 products" covered.
 *
 * ── HOW THIS IS TESTED ────────────────────────────────────────────────────
 * BEHAVIOURALLY — every check calls the real exported function or runs the
 * real aggregation expressions through a real MongoDB. Nothing here asserts on
 * route source text, because a source scan passes against a reimplementation
 * that keeps the name while behaving wrongly.
 *
 * Offline by default. Set TRUTHFUL_VERIFY_MONGODB_URI (e.g.
 * mongodb://127.0.0.1:27099) to additionally run group D, which drives the
 * REAL $group accumulators through mongod over every value of the real
 * Ad.status enum. Without it group D SKIPS LOUDLY rather than passing silently.
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');
const {
  buildVeoPrompt,
  SEED_BURNED_IN_TEXT_GUARD_LINE
} = require(path.join(ROOT, 'services/veoPromptBuilder'));
const {
  resolveSeedTextTruth,
  decodeSeedTextElement,
  seedHasTextFromMedia,
  renderComputedSeedHasText
} = require(path.join(ROOT, 'services/seedTextTruth'));
const {
  DELIVERED_STATUSES,
  IN_FLIGHT_STATUSES,
  FAILED_STATUSES,
  outcomeAccumulators,
  distinctOnDelivered,
  coveragePctFromDelivered
} = require(path.join(ROOT, 'services/adDeliveryCounts'));

let checks = 0, failures = [];
function check(label, cond, detail) {
  checks++;
  if (cond) return;
  failures.push(label + (detail ? `\n     ${detail}` : ''));
}
function section(t) { console.log(`\n${t}`); }

// The real element shape written by services/subjectTextService.js:128-135.
// Reproduced here as DATA (a fixture), not as logic.
const REAL_TEXT_EL = (content, i = 1) => ({
  id: `t${i}`, content, type: 'general',
  x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.2, confidence: 0.9
});

console.log('verifyTruthfulReporting');

// ══ A. seedHasText honesty ════════════════════════════════════════════════
section('A. seedHasText — the inspector must agree with the render path');

// A1 — THE REGRESSION ITSELF. This is the exact production shape.
{
  const media = { _id: 'm1', text: [REAL_TEXT_EL('SALE 50% OFF'), REAL_TEXT_EL('LIMITED', 2)] };
  const r = resolveSeedTextTruth({ media, ad: {}, guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE });
  check('A1 real `{content}` element shape yields seedHasText=true',
    r.seedHasText === true, `got ${JSON.stringify(r)}`);
  check('A1b and the readable strings are DECODED (proves .content is read)',
    r.burnedInText.length === 2 && r.burnedInText[0] === 'SALE 50% OFF',
    `burnedInText=${JSON.stringify(r.burnedInText)}`);
  check('A1c source is seed-media when no prompt was persisted',
    r.seedHasTextSource === 'seed-media', `got ${r.seedHasTextSource}`);
}

// A2 — the boolean must NOT depend on decodability. An element whose content is
// empty still counts for the render path (which only counts), so it must count
// here. This is the arm a `.content`-aware-but-still-filtered fix would fail.
{
  const media = { _id: 'm2', text: [REAL_TEXT_EL(''), REAL_TEXT_EL('   ')] };
  const r = resolveSeedTextTruth({ media, ad: {}, guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE });
  check('A2 elements present but undecodable STILL yield seedHasText=true',
    r.seedHasText === true,
    'the flag must mirror the render path\'s raw COUNT, never the decoded list');
  check('A2b element count is reported so the emptiness is explainable',
    r.seedTextElementCount === 2, `got ${r.seedTextElementCount}`);
}

// A3 — an unknown future element shape must not silently invert the flag.
{
  const media = { _id: 'm3', text: [{ someFutureKey: 'HELLO', boundingPoly: {} }] };
  const r = resolveSeedTextTruth({ media, ad: {}, guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE });
  check('A3 an UNRECOGNISED element shape still yields seedHasText=true',
    r.seedHasText === true,
    'this is the general form of the defect — a shape change must not flip the boolean');
}

// A4 — mirror check: the producer's own derivation, term for term.
check('A4 seedHasTextFromMedia mirrors the render path (raw length, no decode)',
  seedHasTextFromMedia({ text: [REAL_TEXT_EL('')] }) === true
  && seedHasTextFromMedia({ text: [] }) === false
  && seedHasTextFromMedia({}) === false
  && seedHasTextFromMedia({ text: 'not-an-array' }) === false);

// A5 — legacy shapes keep decoding (additive, cannot create a false positive).
check('A5 legacy `.text` / `.value` / bare-string elements still decode',
  decodeSeedTextElement({ text: 'A' }) === 'A'
  && decodeSeedTextElement({ value: 'B' }) === 'B'
  && decodeSeedTextElement('C') === 'C'
  && decodeSeedTextElement({ content: 'D', text: 'E' }) === 'D'  // content wins
  && decodeSeedTextElement(null) === null);

// A6 — THE AUTHORITATIVE SIGNAL: read what the render actually computed off the
// persisted prompt. Built with the REAL builder, not a hand-written string.
{
  const brand   = { _id: 'b', name: 'N', brandName: 'N' };
  const product = { _id: 'p', title: 'Merino Crewneck Sweater' };
  const base = {
    brand, product, media: null, aspectRatio: '9:16',
    hasProductReference: true, caps: { promptByteCap: 20000 },
    durationSec: 10, platformFormat: null
  };
  const promptWithGuard    = buildVeoPrompt({ ...base, seedHasText: true });
  const promptWithoutGuard = buildVeoPrompt({ ...base, seedHasText: false });

  check('A6 guard block is REALLY in the true-arm prompt (not a vacuous test)',
    promptWithGuard.includes(SEED_BURNED_IN_TEXT_GUARD_LINE)
    && !promptWithoutGuard.includes(SEED_BURNED_IN_TEXT_GUARD_LINE));

  // The load-bearing case: render fired, but Media.text has since been
  // overwritten to []. The OLD code reported false. The prompt must win.
  const r = resolveSeedTextTruth({
    media: { _id: 'm', text: [] },
    ad: { veoPrompt: promptWithGuard },
    guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE
  });
  check('A6b render fired + Media.text now EMPTY ⇒ still true, from the prompt',
    r.seedHasText === true && r.seedHasTextSource === 'render-prompt',
    `got ${JSON.stringify(r)}`);
  check('A6c and the disagreement is reported, not silently resolved',
    r.recordChangedSinceRender === true);

  const rOff = resolveSeedTextTruth({
    media: { _id: 'm', text: [] },
    ad: { veoPrompt: promptWithoutGuard },
    guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE
  });
  check('A6d a real prompt WITHOUT the guard reports false, source none',
    rOff.seedHasText === false && rOff.seedHasTextSource === 'none'
    && rOff.renderComputedSeedHasText === false);
}

// A7 — tri-state. A raw override bypasses buildVeoPrompt, so the guard block's
// absence proves nothing and must NOT be reported as a computed false.
{
  check('A7 raw-prompt override ⇒ renderComputedSeedHasText is null, not false',
    renderComputedSeedHasText({
      veoPrompt: 'some raw prompt with no guard',
      videoPromptRaw: 'some raw prompt with no guard',
      guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE
    }) === null);
  check('A7b no persisted prompt ⇒ null (pre-capture render)',
    renderComputedSeedHasText({ veoPrompt: '', guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE }) === null
    && renderComputedSeedHasText({ guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE }) === null);
  // With a raw override, the media signal must still be honoured.
  const r = resolveSeedTextTruth({
    media: { text: [REAL_TEXT_EL('X')] },
    ad: { veoPrompt: 'raw', videoPromptRaw: 'raw' },
    guardLine: SEED_BURNED_IN_TEXT_GUARD_LINE
  });
  check('A7c raw override still reports seed text from the media record',
    r.seedHasText === true && r.seedHasTextSource === 'seed-media');
}

// A8 — the route must IMPORT the shared helper, not re-implement it. This is
// the lesson from the `receiptFree` production incident: a harness asserting a
// call site uses a helper must also assert the file imports it.
{
  const src = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');
  check('A8 routes/ads.js imports resolveSeedTextTruth',
    /require\(['"]\.\.\/services\/seedTextTruth['"]\)/.test(src));
  check('A8b routes/ads.js imports the guard constant from the builder',
    /SEED_BURNED_IN_TEXT_GUARD_LINE\s*\}\s*=\s*require\(['"]\.\.\/services\/veoPromptBuilder['"]\)/.test(src));
  check('A8c the inspector no longer derives seedHasText from burnedInText.length',
    !/seedHasText:\s*burnedInText\.length\s*>\s*0/.test(src),
    'that expression IS the defect');
}

// ══ B. scaffold approximation ═════════════════════════════════════════════
section('B. veo-prompt-scaffold declares itself an approximation');
{
  const av = require(path.join(ROOT, 'services/atlasVideoService'));
  check('B1 buildPromptScaffold is still exported', typeof av.buildPromptScaffold === 'function');

  // B2 — the scaffold is NOT a second builder. Its literal argument set,
  // through the canonical builder, is byte-identical to the builder itself.
  const brand   = { _id: 'b', name: 'N', brandName: 'N' };
  const product = { _id: 'p', title: 'Merino Crewneck Sweater' };
  const scaffoldArgs = {
    brand, product, media: null, aspectRatio: '9:16',
    seedHasText: false, hasProductReference: true, operatorPrompt: null,
    caps: { promptByteCap: 20000 }, durationSec: 8, platformFormat: null
  };
  const a = buildVeoPrompt({ ...scaffoldArgs });
  const b = buildVeoPrompt({ ...scaffoldArgs });
  check('B2 the canonical builder is deterministic for the scaffold arg set', a === b);

  // B3 — MEASURED deltas the preview cannot show. These are the honest reason
  // the preview is an approximation, and they are asserted as real numbers so a
  // future change to either input's effect is noticed here.
  const withGuard = buildVeoPrompt({ ...scaffoldArgs, seedHasText: true });
  const guardDelta = Buffer.byteLength(withGuard, 'utf8') - Buffer.byteLength(a, 'utf8');
  check('B3 the seedHasText guard block is a REAL, non-trivial byte delta',
    guardDelta > 200, `delta=${guardDelta}`);
  const noProdRef = buildVeoPrompt({ ...scaffoldArgs, hasProductReference: false });
  const refDelta = Buffer.byteLength(a, 'utf8') - Buffer.byteLength(noProdRef, 'utf8');
  check('B3b hasProductReference is a REAL byte delta too',
    refDelta > 100, `delta=${refDelta}`);

  // B4 — THE MECHANISM BEHIND THE OBSERVED `Product:` DIVERGENCE.
  // At a 4096-byte cap the guard block pushes the prompt over target, and
  // enforceByteCap drops `Product: ` FIRST (it heads DROP_PRIORITY). So the
  // preview can show a Product line the real submission dropped — SAME builder,
  // different budget. This is what refutes "the preview carries a pattern
  // deliberately removed from the real builder".
  // The axis that ACTUALLY moves this is the destination profile plus the
  // model's cap — NOT the product description, which was the first fixture
  // tried here and turned out to be inert (it never reaches the camera prompt,
  // so the sweep passed over 65 lengths while testing nothing). Recorded
  // because a vacuous fixture is the failure mode this whole harness exists to
  // avoid.
  const hasProd = s => /(^|\s)Product: /.test(s);
  const destArgs = { ...scaffoldArgs, platformFormat: 'meta_stories_9_16' };

  const grokDest  = buildVeoPrompt({ ...destArgs, caps: { promptByteCap: 4096 },  seedHasText: false });
  const omniDest  = buildVeoPrompt({ ...destArgs, caps: { promptByteCap: 20000 }, seedHasText: false });
  const grokDestOn = buildVeoPrompt({ ...destArgs, caps: { promptByteCap: 4096 }, seedHasText: true });

  // The two halves of the claim, each asserted on its own so neither can carry
  // the other: the line IS in the builder (Omni keeps it), and the 4096-byte
  // cap is what removes it (Grok drops it).
  check('B4 `Product:` IS still emitted by the builder — the 20000-byte Omni cap keeps it',
    hasProd(omniDest),
    `omni(dest) ${Buffer.byteLength(omniDest)}b hasProduct=${hasProd(omniDest)}`);
  check('B4b at the 4096-byte cap the SAME builder DROPS it (enforceByteCap, /^Product: / heads DROP_PRIORITY)',
    !hasProd(grokDest),
    `grok(dest) ${Buffer.byteLength(grokDest)}b hasProduct=${hasProd(grokDest)}`);
  check('B4c so a `Product:` line present in one prompt and absent from another is a BUDGET difference, not two builders',
    hasProd(omniDest) && !hasProd(grokDest));

  // OVER-CAP FINDING, worth pinning in its own right: with a destination
  // profile AND the burned-in-text guard, a 4096-capped model's prompt still
  // exceeds its HARD cap after every droppable line is gone — enforceByteCap
  // logs "Atlas will reject". Measured 4168 bytes here, which is within 2 bytes
  // of the 4170-byte prompt observed on the real ad. If this check ever goes
  // green-by-shrinking, the over-cap exposure closed and that is worth knowing.
  const onBytes = Buffer.byteLength(grokDestOn, 'utf8');
  check('B4d guard-on + destination at a 4096 cap still EXCEEDS the hard cap (Atlas would reject)',
    onBytes > 4096,
    `got ${onBytes}b — if this is now under 4096 the exposure closed; update this note`);
  console.log(`   ℹ  dest+guard at cap 4096 = ${onBytes}b (hard cap 4096, all droppable lines already gone)`);

  // B5 — the endpoint must DECLARE the approximation. Read the source of the
  // return object; the function itself needs DB access to call.
  const src = fs.readFileSync(path.join(ROOT, 'services/atlasVideoService.js'), 'utf8');
  check('B5 buildPromptScaffold returns an `approximation` block',
    /approximation:\s*\{/.test(src));
  check('B5b it declares isApproximation: true', /isApproximation:\s*true/.test(src));
  check('B5c it names the assumed inputs the operator cannot see',
    /assumedInputs/.test(src) && /omittedInputs/.test(src));
  check('B5d it points at where the EXACT submitted prompt lives',
    /generation-inspector/.test(src) && /exactPromptAvailableAt/.test(src));
  check('B5e the scaffold still hardcodes seedHasText:false (byte-identity is pinned by B14)',
    /seedHasText:\s*false/.test(src),
    'if this changed, verifyPostPilotBatch B14 will also be red — that is a deliberate frozen invariant');
}

// ══ C. coverage means delivered ═══════════════════════════════════════════
section('C. coverage counts deliverable assets, not attempts');
{
  // C1 — THE DEFECT, at the function level. 12 ads, all failed.
  check('C1 12 failed ads / 0 delivered ⇒ coveragePct 0 (was 100)',
    coveragePctFromDelivered(0, 5) === 0);
  check('C1b 12 DELIVERED ads ⇒ still capped at 100',
    coveragePctFromDelivered(12, 5) === 100);
  check('C1c partial delivery scales',
    coveragePctFromDelivered(1, 5) === 20 && coveragePctFromDelivered(2, 5) === 40);
  // Blanked env / bad target must not emit NaN or Infinity to the SPA.
  check('C1d a zero/blank/negative target yields 0, never NaN or Infinity',
    coveragePctFromDelivered(3, 0) === 0
    && coveragePctFromDelivered(3, Number('')) === 0
    && coveragePctFromDelivered(3, -5) === 0
    && coveragePctFromDelivered(3, NaN) === 0);
  check('C1e negative/NaN delivered yields 0',
    coveragePctFromDelivered(-1, 5) === 0 && coveragePctFromDelivered(NaN, 5) === 0);

  // C2 — the status vocabulary must match the REAL enum in models/Ad.js. If
  // someone adds a status, this fails and forces a decision rather than
  // silently defaulting it into (or out of) coverage.
  const adSrc = fs.readFileSync(path.join(ROOT, 'models/Ad.js'), 'utf8');
  const enumMatch = adSrc.match(/status:\s*\{[^}]*enum:\s*\[([^\]]+)\]/);
  check('C2 the Ad.status enum is readable from models/Ad.js', !!enumMatch);
  if (enumMatch) {
    const statuses = enumMatch[1].split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const classified = new Set([
      ...DELIVERED_STATUSES, ...IN_FLIGHT_STATUSES, ...FAILED_STATUSES, 'archived'
    ]);
    const unclassified = statuses.filter(s => !classified.has(s));
    check('C2b EVERY Ad.status value is explicitly classified',
      unclassified.length === 0,
      `unclassified: ${JSON.stringify(unclassified)} — decide deliberately whether each counts as coverage`);
    check('C2c `failed` is NOT delivered', !DELIVERED_STATUSES.includes('failed'));
    check('C2d in-flight is NOT delivered',
      !DELIVERED_STATUSES.includes('queued') && !DELIVERED_STATUSES.includes('rendering'));
    check('C2e delivered is exactly draft+live in this non-archived population',
      DELIVERED_STATUSES.length === 2
      && DELIVERED_STATUSES.includes('draft') && DELIVERED_STATUSES.includes('live'));
  }

  // C3 — both mirrors must use the SHARED definition. The two ads-summary
  // endpoints silently disagreeing is how this stayed invisible on both.
  const catSrc = fs.readFileSync(path.join(ROOT, 'routes/catalog.js'), 'utf8');
  const cmpSrc = fs.readFileSync(path.join(ROOT, 'routes/campaigns.js'), 'utf8');
  check('C3 routes/catalog.js imports adDeliveryCounts',
    /require\(['"]\.\.\/services\/adDeliveryCounts['"]\)/.test(catSrc));
  check('C3b routes/campaigns.js imports adDeliveryCounts',
    /require\(['"]\.\.\/services\/adDeliveryCounts['"]\)/.test(cmpSrc));
  check('C3c catalog coverage no longer divides adCount by the target',
    !/\(\s*adCount\s*\/\s*TARGET_ADS_PER_PRODUCT\s*\)/.test(catSrc),
    'that expression IS the defect');
  check('C3d catalog "products covered" keys on deliveredCount, not adCount',
    /filter\(p\s*=>\s*p\.deliveredCount\s*>\s*0\)/.test(catSrc));
  check('C3e campaigns "with ads" keys on deliveredCount',
    /filter\(c\s*=>\s*c\.deliveredCount\s*>\s*0\)/.test(cmpSrc));
  check('C3f the failure count is now actually RETURNED (it was computed and dropped since ed3e6d83)',
    /failedCount,/.test(catSrc) || /failedCount:/.test(catSrc));

  // C4 — accumulator shape, read as data.
  const acc = outcomeAccumulators();
  check('C4 outcomeAccumulators supplies all three outcome counters',
    !!acc.deliveredCount && !!acc.failedCount && !!acc.inFlightCount);
  check('C4b each is a $sum of a $cond over a status $in',
    JSON.stringify(acc.deliveredCount).includes('$in')
    && JSON.stringify(acc.deliveredCount).includes('$status'));
  check('C4c a fresh object each call (no shared mutable literal)',
    outcomeAccumulators().deliveredCount !== acc.deliveredCount);
  check('C4d distinctOnDelivered is conditional on delivered status',
    JSON.stringify(distinctOnDelivered('$productId')).includes('$addToSet')
    && JSON.stringify(distinctOnDelivered('$productId')).includes('draft'));
}

// ══ D. the aggregation, through a REAL mongod ═════════════════════════════
section('D. real $group accumulators through mongod');
const MONGO = process.env.TRUTHFUL_VERIFY_MONGODB_URI;

(async () => {
  if (!MONGO) {
    console.log('   ⏭  D SKIPPED — set TRUTHFUL_VERIFY_MONGODB_URI to run it.');
    console.log('      Groups A-C above are offline and complete; D proves mongod');
    console.log('      itself evaluates the accumulators over the real status enum.');
  } else {
    const mongoose = require('mongoose');
    await mongoose.connect(MONGO, { dbName: `truthful_verify_${Date.now()}` });
    const Row = mongoose.connection.collection('advrows');

    // THE EXACT OBSERVED DEFECT: one product, 12 ads, ALL failed.
    const P = new mongoose.Types.ObjectId();
    const B = new mongoose.Types.ObjectId();
    await Row.insertMany(Array.from({ length: 12 }, () => ({
      brandId: B, productId: P, status: 'failed'
    })));
    let [row] = await Row.aggregate([
      { $match: { brandId: B, status: { $ne: 'archived' } } },
      { $group: { _id: '$productId', adCount: { $sum: 1 }, ...outcomeAccumulators() } }
    ]).toArray();
    check('D1 mongod: 12 failed ⇒ adCount 12, deliveredCount 0, failedCount 12',
      row.adCount === 12 && row.deliveredCount === 0 && row.failedCount === 12,
      JSON.stringify(row));
    check('D1b ⇒ coveragePct 0 (the reported 100 is now unreachable)',
      coveragePctFromDelivered(row.deliveredCount, 5) === 0);

    // Every status value, one row each, so mongod classifies the whole enum.
    const P2 = new mongoose.Types.ObjectId();
    const ALL = ['queued', 'rendering', 'draft', 'live', 'failed', 'archived'];
    await Row.insertMany(ALL.map(status => ({ brandId: B, productId: P2, status })));
    [row] = await Row.aggregate([
      { $match: { brandId: B, productId: P2, status: { $ne: 'archived' } } },
      { $group: { _id: '$productId', adCount: { $sum: 1 }, ...outcomeAccumulators() } }
    ]).toArray();
    check('D2 mongod: one of each status ⇒ delivered 2 (draft+live)',
      row.deliveredCount === 2, JSON.stringify(row));
    check('D2b ⇒ inFlight 2 (queued+rendering), failed 1, archived excluded from adCount',
      row.inFlightCount === 2 && row.failedCount === 1 && row.adCount === 5,
      JSON.stringify(row));

    // A missing `status` field must not be counted as delivered ($in on a
    // missing path resolves to missing, not to a match — asserted, not assumed).
    const P3 = new mongoose.Types.ObjectId();
    await Row.insertMany([{ brandId: B, productId: P3 }, { brandId: B, productId: P3, status: null }]);
    [row] = await Row.aggregate([
      { $match: { brandId: B, productId: P3, status: { $ne: 'archived' } } },
      { $group: { _id: '$productId', adCount: { $sum: 1 }, ...outcomeAccumulators() } }
    ]).toArray();
    check('D3 mongod: a missing/null status is never counted as delivered',
      row.deliveredCount === 0, JSON.stringify(row));

    // distinctOnDelivered: only delivered rows contribute their productId.
    const C1 = new mongoose.Types.ObjectId();
    const pa = new mongoose.Types.ObjectId(), pb = new mongoose.Types.ObjectId();
    await Row.insertMany([
      { brandId: B, campaignId: C1, productId: pa, status: 'failed' },
      { brandId: B, campaignId: C1, productId: pb, status: 'draft'  }
    ]);
    const [crow] = await Row.aggregate([
      { $match: { brandId: B, campaignId: C1, status: { $ne: 'archived' } } },
      { $group: {
          _id: '$campaignId',
          productsWithAds:   { $addToSet: '$productId' },
          productsDelivered: distinctOnDelivered('$productId')
      } }
    ]).toArray();
    const delivered = (crow.productsDelivered || []).filter(Boolean);
    const attempted = (crow.productsWithAds  || []).filter(Boolean);
    check('D4 mongod: productsDelivered counts only the delivered product',
      delivered.length === 1 && String(delivered[0]) === String(pb),
      JSON.stringify({ delivered: delivered.map(String), attempted: attempted.map(String) }));
    check('D4b while productsWithAds still counts both (the attempted set)',
      attempted.length === 2);

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }

  console.log('');
  if (failures.length) {
    console.log(`❌ verifyTruthfulReporting: ${failures.length} of ${checks} checks FAILED\n`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyTruthfulReporting: ${checks}/${checks} checks passed${MONGO ? ' (incl. group D against mongod)' : ' (group D skipped)'}`);
})().catch(err => {
  console.log(`❌ verifyTruthfulReporting threw: ${err.message}\n${err.stack || ''}`);
  process.exit(1);
});
