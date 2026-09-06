'use strict';
// Persist buyer-facing shortBenefits onto CatalogProduct at ingest
// (or via scripts/backfillProductBenefits.js). Billable: one
// gemini-2.5-flash chatCompletion per product that does not already have
// them (or whose title/description later changed), ledgered to CostLog
// under stage `product_benefits`.
//
// MONEY — all of these are load-bearing:
//   * Kill switch PRODUCT_BENEFITS_DERIVATION, strictly === 'true'
//     (file default true). Unset / "false" / "TRUE" are OFF.
//   * Idempotent on UNCHANGED text: callers skip when shortBenefits is
//     already non-empty; this module also refuses cheaply (no LLM) if
//     handed such a product, and refuses a second attempt once
//     shortBenefitsDerivedAt is set (covers "derived, genuinely nothing"
//     — empty array). A NORMALISED title/description change clears the
//     stamp and re-enqueues (~$0.002, bounded by the ingest cap).
//   * No retry loop around the billable call. atlasLlmService owns retries.
//   * Return [] on failure. NEVER throw into an ingest path.
//   * Callable ONLY from catalog ingest writers + the backfill script.
//     assembleSignals / expandWizardJob / any render path must never
//     require this file (pinned structurally by verifyProductBenefits.js).
//
// Prompt register mirrors layoutInputService.js:1276 so the ingest-time
// flash derivation and the render-time layout derivation agree:
//   "short_benefits" 3–5 items, each ≤ 6 words, concrete buyer benefits
//   (not specs).

const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
// Module object (not a destructured binding) so a harness can stub
// chatCompletion without a live LLM — the money guards are what we pin.
const atlasLlmService = require('./atlasLlmService');

const MODEL = 'gemini-2.5-flash';
const STAGE = 'product_benefits';
const ITEM_CAP = 5;
const ITEM_FLOOR = 3;
const WORD_CAP = 6;
// gemini-2.5-* spends HIDDEN REASONING TOKENS out of max_tokens — see
// services/atlasLlmService.js:17-19 ("verified live — finish_reason 'length'
// with an empty message at small budgets") and the real production MAX_TOKENS
// incident recorded at services/providers/geminiSearchProvider.js:465-470 on
// this exact model+transport. 400 was under-specified: the sibling caller of
// the same model through the same transport uses 12000. Matching a known-good
// value rather than inventing a smaller one — a high ceiling costs nothing
// when the answer is five short strings, since billing is per token USED.
const MAX_TOKENS = 12000;
const TEMPERATURE = 0.3;
const DEFAULT_CONCURRENCY = 4;

// Reasons whose result is the model's FINAL verdict and may be stamped
// (stamping is terminal — see deriveAndPersist). 'empty-content' and
// 'unparseable' are content failures and are deliberately NOT here.
const STAMPABLE_REASONS = new Set(['ok', 'below-floor']);

// Projected per-call figure for dry-run accounting. Comparable ledgered
// flash-class stages measured 2026-09 (n as given):
//   category_reviews        $0.00205  n=533
//   product_review_summary  $0.00287  n=734
//   product_reviews         $0.00187  n=1712
//   visual_catalog_match    $0.00124  n=2754
// Ungrounded gemini-2.5-flash should sit at the cheap end of that band.
// Quote $0.002 so a 2171-product backfill projects ~$4.34 rather than
// under-quoting. Actual spend is whatever CostLog records.
const PROJECTED_USD_PER_CALL = 0.002;

function isDerivationEnabled() {
  return process.env.PRODUCT_BENEFITS_DERIVATION === 'true';
}

function hasNonEmptyBenefits(product) {
  if (!Array.isArray(product?.shortBenefits)) return false;
  return product.shortBenefits.some((s) => typeof s === 'string' && s.trim());
}

function alreadyAttempted(product) {
  return product?.shortBenefitsDerivedAt != null;
}

// mongoose findOneAndUpdate({ upsert, new, includeResultMetadata: true }) — the same
// shape apifyIngestService / catalogSyncService already use. A missing
// lastErrorObject fails CLOSED (treat as update, do not derive): over-
// skipping a new product is a backfill, under-skipping is a resync bill.
function upsertWasInsert(result) {
  if (!result || !result.lastErrorObject) return false;
  return result.lastErrorObject.updatedExisting === false;
}

function productFromUpsert(result) {
  if (!result) return null;
  return result.value || null;
}

function collectIfNew(result, pending) {
  if (!Array.isArray(pending)) return;
  if (!upsertWasInsert(result)) return;
  const product = productFromUpsert(result);
  if (product) pending.push(product);
}

// Normalise title/description for freshness comparison: trim, collapse
// interior whitespace, case-fold. Null/undefined/non-string → ''.
// Price / image / URL are NOT part of this fingerprint — a merchant
// fixing a photo must not re-bill gemini-2.5-flash.
function normalizeProductText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function productTextChanged(prevDoc, nextFields) {
  if (!prevDoc) return false;
  const next = nextFields || {};
  return normalizeProductText(prevDoc.title) !== normalizeProductText(next.title)
      || normalizeProductText(prevDoc.description) !== normalizeProductText(next.description);
}

// Shared helper for every catalog writer's upsert path (and manual/detect
// $set of title/description). Compare NORMALISED title+description.
//
// If different: caller must $unset shortBenefitsDerivedAt on the same
// write (applyBenefitsStaleToUpdate) and enqueue through collectIfStale.
// shortBenefits is KEPT on the Mongo doc so a generate during the
// derive window still has the old list; collectIfStale hands derive
// an in-memory view with the list cleared so already-has-benefits
// does not refuse. If identical: no write, no enqueue.
//
// prevDoc = the PRE-upsert row (or null on insert). nextFields = the
// title/description that will actually be $set (not the raw feed).
function markBenefitsStaleIfTextChanged(prevDoc, nextFields) {
  const changed = productTextChanged(prevDoc, nextFields);
  return { changed };
}

function applyBenefitsStaleToUpdate(update, changed) {
  if (!changed || !update) return update;
  update.$unset = { ...(update.$unset || {}), shortBenefitsDerivedAt: 1 };
  return update;
}

// In-memory view that lets deriveShortBenefits run even though Mongo
// still holds the previous list. Never persisted as-is — persistBenefits
// overwrites both fields on a stampable verdict.
function redriveView(product) {
  if (!product) return product;
  const plain = typeof product.toObject === 'function' ? product.toObject() : { ...product };
  return { ...plain, shortBenefits: [], shortBenefitsDerivedAt: null };
}

function collectIfStale(result, pending, changed) {
  if (!changed) return;
  if (!Array.isArray(pending)) return;
  if (upsertWasInsert(result)) return; // collectIfNew already kept the insert
  const product = productFromUpsert(result);
  if (product) pending.push(redriveView(product));
}

// One extra indexed read per upsert so we can compare against the
// PRE-write title/description. Fail-closed: a throw here looks like
// "no prev" → no stale write, no extra bill. Inserts still go through
// collectIfNew.
async function loadPrevForBenefits(brandId, externalId) {
  if (!brandId || externalId == null || externalId === '') return null;
  try {
    return await CatalogProduct.findOne({ brandId, externalId })
      .select('title description shortBenefits shortBenefitsDerivedAt')
      .lean();
  } catch (_) {
    return null;
  }
}

function collectAfterCatalogUpsert(result, pending, { changed } = {}) {
  collectIfNew(result, pending);
  collectIfStale(result, pending, changed);
}

function normalizeDerivedBenefits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= ITEM_CAP) break;
    if (typeof item !== 'string') continue;
    const trimmed = item.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const words = trimmed.split(/\s+/).filter(Boolean);
    // DROP an over-length item; never slice it. Slicing produced grammatical
    // fragments ("Keeps you dry in the heaviest") and the stamp made them
    // permanent — missingBenefitsFilter excludes any non-empty row, so no
    // path could repair them. Dropping instead lets the >=3 floor below
    // decide honestly: enough good items, or [] and try again later.
    // (Measured on the 2026-09-03 backfill: 24 of 8797 items were at the cap
    // and read as complete phrases, so this path was near-cold in practice —
    // the prompt asks for <=6 words and the model complies. Fixed anyway
    // because the failure is silent, permanent and unrepairable.)
    if (words.length > WORD_CAP) continue;
    out.push(trimmed);
  }
  // Owner: enforce ≥3 where the model can. Below the floor → [] (do not
  // persist a 1-2 item list the Director would then treat as real).
  if (out.length < ITEM_FLOOR) return [];
  return out;
}

function specsForPrompt(product) {
  // Lazy: this module must not create a load-time cycle with the Director.
  const { normalizeProductSpecs } = require('./aiCreativeDirectorService');
  return normalizeProductSpecs(product && product.specs);
}

function buildPrompt({ product, brand }) {
  const specs = specsForPrompt(product);
  const specLines = specs.slice(0, 12).map((r) => (
    r.label ? `${r.label}: ${r.value}` : String(r.value)
  ));
  const tone = Array.isArray(brand?.tone) ? brand.tone.slice(0, 6).join(', ') : '';
  // Wording at services/layoutInputService.js:1276, mirrored on purpose.
  const system = [
    'You write SHORT buyer-facing product benefits for ads.',
    'Output JSON only: { "short_benefits": [string, ...] }.',
    `"short_benefits" ${ITEM_FLOOR}–${ITEM_CAP} items, each ≤ ${WORD_CAP} words, concrete buyer benefits (not specs).`,
    'Benefits are what the buyer gets (stays dry, packs small, feels broken-in on day one). Specs are materials, weights, SKUs — do not restate them as benefits.',
    'No brand name. No product name. No emoji. Sentence case.',
    `If you cannot produce at least ${ITEM_FLOOR} honest benefits from the input, return { "short_benefits": [] }.`,
  ].join('\n');
  const user = [
    `PRODUCT TITLE: ${product?.title || '(untitled)'}`,
    `DESCRIPTION: ${typeof product?.description === 'string' ? product.description.slice(0, 600) : '(none)'}`,
    specLines.length ? `SPECS:\n${specLines.map((s) => `- ${s}`).join('\n')}` : 'SPECS: (none)',
    brand?.name ? `BRAND: ${brand.name}` : '',
    tone ? `BRAND TONE: ${tone}` : '',
    brand?.summary ? `BRAND SUMMARY: ${String(brand.summary).slice(0, 240)}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

// One LLM call. Never throws. skipped=true means we did not bill.
async function deriveShortBenefits({ product, brand } = {}) {
  if (!isDerivationEnabled()) {
    return { benefits: [], skipped: true, reason: 'flag-off', charged: false };
  }
  if (!product) {
    return { benefits: [], skipped: true, reason: 'no-product', charged: false };
  }
  if (hasNonEmptyBenefits(product)) {
    const kept = product.shortBenefits
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, ITEM_CAP);
    return { benefits: kept, skipped: true, reason: 'already-has-benefits', charged: false };
  }
  if (alreadyAttempted(product)) {
    return { benefits: [], skipped: true, reason: 'already-attempted', charged: false };
  }

  try {
    const { system, user } = buildPrompt({ product, brand });
    const completion = await atlasLlmService.chatCompletion(
      {
        stage: STAGE,
        service: 'productBenefitsService',
        brandId: product.brandId || brand?._id || null,
        productId: product._id || null,
      },
      {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'product_benefits',
            strict: false,
            schema: {
              type: 'object',
              properties: {
                short_benefits: { type: 'array', items: { type: 'string' } },
              },
              required: ['short_benefits'],
            },
          },
        },
      }
    );
    const raw = completion && completion.choices && completion.choices[0]
      && completion.choices[0].message && completion.choices[0].message.content;
    if (!raw) {
      return { benefits: [], skipped: false, reason: 'empty-content', charged: true };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      return { benefits: [], skipped: false, reason: 'unparseable', charged: true };
    }
    const benefits = normalizeDerivedBenefits(parsed && parsed.short_benefits);
    return {
      benefits,
      skipped: false,
      reason: benefits.length ? 'ok' : 'below-floor',
      charged: true,
    };
  } catch (err) {
    console.warn(
      `   ⚠️  product-benefits: derive failed for ${product && product._id}: ${err && err.message}`
    );
    // Transport/throw: do NOT stamp derivedAt — backfill can retry. Not a
    // second attempt in this call (no retry loop).
    return {
      benefits: [],
      skipped: false,
      reason: 'error',
      charged: false,
      error: err && err.message,
    };
  }
}

async function persistBenefits(productId, benefits) {
  if (!productId) return;
  await CatalogProduct.updateOne(
    { _id: productId },
    { $set: { shortBenefits: benefits, shortBenefitsDerivedAt: new Date() } }
  );
}

async function deriveAndPersist({ product, brand, brandId } = {}) {
  try {
    if (!isDerivationEnabled()) {
      return { skipped: true, reason: 'flag-off', benefits: [], charged: false };
    }
    if (!product) {
      return { skipped: true, reason: 'no-product', benefits: [], charged: false };
    }
    if (hasNonEmptyBenefits(product) || alreadyAttempted(product)) {
      const out = await deriveShortBenefits({ product, brand });
      return out;
    }
    let brandDoc = brand;
    if (!brandDoc && (brandId || product.brandId)) {
      try {
        brandDoc = await Brand.findById(brandId || product.brandId)
          .select('name tone summary')
          .lean();
      } catch (_) {
        brandDoc = null;
      }
    }
    const out = await deriveShortBenefits({ product, brand: brandDoc });
    // Stamp only on an answer we can TRUST as final: real benefits ('ok') or
    // an honest "cannot produce 3 from this input" ('below-floor'). Those are
    // the model's verdict and re-billing them buys nothing.
    //
    // Do NOT stamp 'empty-content' or 'unparseable'. We paid for those, but
    // they are content FAILURES (a truncated or malformed response), not a
    // verdict — and the stamp is terminal: missingBenefitsFilter excludes any
    // stamped row and the backfill had no --force, so stamping here wrote off
    // the product forever while reporting success. Leaving them unstamped
    // costs one retry's tokens and keeps them recoverable.
    if (out.charged && STAMPABLE_REASONS.has(out.reason) && product._id) {
      try {
        await persistBenefits(product._id, out.benefits);
      } catch (err) {
        console.warn(
          `   ⚠️  product-benefits: persist failed for ${product._id}: ${err && err.message}`
        );
      }
    }
    return out;
  } catch (err) {
    console.warn(`   ⚠️  product-benefits: deriveAndPersist threw: ${err && err.message}`);
    return { benefits: [], skipped: false, reason: 'error', charged: false, error: err && err.message };
  }
}

async function mapLimit(items, limit, fn) {
  const n = Math.max(1, limit | 0);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(n, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }
  );
  await Promise.all(workers);
}

async function deriveForProducts({ products, brand, brandId, concurrency, onProgress } = {}) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const stats = {
    attempted: 0,
    derived: 0,
    skipped: 0,
    failed: 0,
    charged: 0,
    spendUsd: 0,
  };
  if (!isDerivationEnabled() || !list.length) return stats;
  const limit = Math.max(1, concurrency || DEFAULT_CONCURRENCY);
  await mapLimit(list, limit, async (p) => {
    stats.attempted += 1;
    const out = await deriveAndPersist({ product: p, brand, brandId });
    // 'empty-content' and 'unparseable' are FAILURES, not derivations. They
    // used to land in stats.derived, so a run that content-failed on every
    // product printed "derived: N, failed: 0" and read as a clean success.
    if (out.skipped) stats.skipped += 1;
    else if (out.reason === 'error' || !STAMPABLE_REASONS.has(out.reason)) stats.failed += 1;
    else stats.derived += 1;
    stats.byReason = stats.byReason || {};
    stats.byReason[out.reason || 'unknown'] = (stats.byReason[out.reason || 'unknown'] || 0) + 1;
    if (out.charged) {
      stats.charged += 1;
      stats.spendUsd += PROJECTED_USD_PER_CALL;
    }
    if (typeof onProgress === 'function') {
      try { onProgress(stats, p, out); } catch (_) { /* progress must never fail the batch */ }
    }
  });
  return stats;
}

// Fire-and-forget for a single new product (manual create / detect mint).
// Returns a promise the caller MUST NOT await on an ingest/HTTP path.
function scheduleForProduct({ product, brand, brandId } = {}) {
  return deriveAndPersist({ product, brand, brandId }).catch((err) => {
    console.warn(`   ⚠️  product-benefits schedule failed: ${err && err.message}`);
    return { benefits: [], skipped: false, reason: 'error', charged: false };
  });
}

// Start a bounded batch. If `backgroundWork` is an array, push the promise
// onto it (same convention as catalog enrichment) so a short-lived caller
// can await before disconnecting. HTTP/executor callers ignore that field
// and this never stalls the ingest return.
function enqueueFromPending({ pending, brand, brandId, backgroundWork, concurrency } = {}) {
  if (!Array.isArray(pending) || !pending.length) return null;
  if (!isDerivationEnabled()) return null;
  const work = deriveForProducts({ products: pending, brand, brandId, concurrency })
    .catch((err) => {
      console.warn(`   ⚠️  product-benefits batch failed: ${err && err.message}`);
      return { attempted: 0, derived: 0, skipped: 0, failed: pending.length, charged: 0, spendUsd: 0 };
    });
  if (Array.isArray(backgroundWork)) backgroundWork.push(work);
  return work;
}

// Backfill / resume query: never derived (field absent) AND never stamped.
// An empty array WITH derivedAt is "tried, nothing" and is excluded.
function missingBenefitsFilter() {
  return {
    deletedAt: null,
    $and: [
      {
        $or: [
          { shortBenefits: { $exists: false } },
          { shortBenefits: null },
          { shortBenefits: { $size: 0 } },
        ],
      },
      {
        $or: [
          { shortBenefitsDerivedAt: null },
          { shortBenefitsDerivedAt: { $exists: false } },
        ],
      },
    ],
  };
}

module.exports = {
  isDerivationEnabled,
  hasNonEmptyBenefits,
  alreadyAttempted,
  upsertWasInsert,
  productFromUpsert,
  collectIfNew,
  normalizeProductText,
  productTextChanged,
  markBenefitsStaleIfTextChanged,
  applyBenefitsStaleToUpdate,
  redriveView,
  collectIfStale,
  loadPrevForBenefits,
  collectAfterCatalogUpsert,
  normalizeDerivedBenefits,
  buildPrompt,
  deriveShortBenefits,
  deriveAndPersist,
  deriveForProducts,
  scheduleForProduct,
  enqueueFromPending,
  missingBenefitsFilter,
  MODEL,
  STAGE,
  ITEM_CAP,
  ITEM_FLOOR,
  WORD_CAP,
  DEFAULT_CONCURRENCY,
  PROJECTED_USD_PER_CALL,
};
