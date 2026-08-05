// Atlas-authoritative daily spend/usage buckets. The audit source that the
// internal CostLog ledger is reconciled against — never a replacement for it.
//
// WHY THIS EXISTS SEPARATELY FROM CostLog
// The Billing Public API returns daily aggregates by model / model_type /
// api_key. It has NO per-request cost, so it can never attribute spend to a
// brand / campaign / ad. CostLog remains the per-call attribution ledger;
// AtlasSpendDay is the independent total we check that ledger against.
//
// SCOPE IS LOAD-BEARING — never mix the two:
//   'liquidretail' — filtered to the api_key allowlist. ONLY valid basis for
//                    reconciliation against our CostLog rows (which are all
//                    spent under those keys).
//   'account'      — every key on the shared billing account. Balance/burn
//                    context ONLY. Mixing the two roughly doubles or halves
//                    every figure: liquidretail measured 53% of account spend
//                    on 2026-08-05.
//
// MONEY IS INTEGER MICRO-USD, never float dollars. Atlas returns money as
// fixed-6-decimal strings (e.g. "30.016346"); we store
// Math.round(Number(s) * 1e6). JS Numbers are exact for integers to 2^53 so
// micro-USD needs no BigInt; the Math.round is defensive against float
// representation error on other values (it is a no-op for many, e.g.
// Number('30.016346') * 1e6 is already exactly 30016346 — verified 2026-08-05).

'use strict';

const mongoose = require('mongoose');

const SCOPES = Object.freeze(['liquidretail', 'account']);
const GROUP_BYS = Object.freeze(['model', 'model_type', 'api_key']);

/**
 * Synthetic uniqueness key. Prefer a single string over a compound unique
 * index: several dimension fields are legitimately null depending on groupBy
 * (e.g. groupBy:'model_type' has no modelName / apiKeyId), and MongoDB
 * compound unique indexes treat each null as a distinct key value so two
 * "null modelName" rows collide awkwardly. One string with '_' placeholders
 * makes the identity explicit and stable.
 */
function buildKey({ date, scope, groupBy, modelType, modelName, apiKeyId } = {}) {
  return [
    date,
    scope,
    groupBy,
    modelType || '_',
    modelName || '_',
    apiKeyId || '_'
  ].join('|');
}

/**
 * Atlas money string → integer micro-USD. Null / undefined / non-finite → 0
 * so a missing amount never NaNs a sum.
 */
function usdStringToMicros(s) {
  if (s == null || s === '') return 0;
  const n = Number(s) * 1e6;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Integer micro-USD → Number dollars (for arithmetic / comparisons). */
function microsToUsd(m) {
  return (Number(m) || 0) / 1e6;
}

/** Integer micro-USD → fixed-6-decimal string matching Atlas's wire format. */
function microsToUsdString(m) {
  return ((Number(m) || 0) / 1e6).toFixed(6);
}

const atlasSpendDaySchema = new mongoose.Schema({
  // Atlas's own bucket identity, 'YYYY-MM-DD' UTC. Deliberately a String, not
  // a Date: it must not be subject to timezone reinterpretation on round-trip.
  date: { type: String, required: true, index: true },

  // See file header. liquidretail = reconciliation; account = context only.
  scope: { type: String, required: true, enum: SCOPES, index: true },

  groupBy: { type: String, required: true, enum: GROUP_BYS },

  // Dimension columns — null when the groupBy axis does not carry them.
  modelType: { type: String, default: null, index: true },  // 'text'|'image'|'video'
  // Atlas model slug e.g. 'google/gemini-2.5-flash'. THIS IS THE JOIN KEY TO
  // CostLog.model — the whole reconciliation hinge.
  modelName: { type: String, default: null, index: true },
  modelId:   { type: String, default: null },               // Atlas ms-... id
  apiKeyId:  { type: String, default: null },               // Atlas ak_... public id
  apiKeyName:{ type: String, default: null },

  // Integer micro-USD. See file header for why not float dollars.
  amountMicroUsd: { type: Number, default: 0 },

  // Usage counters. The `usage` object on a /model-usage result is NESTED and
  // MUTUALLY EXCLUSIVE by model_type — verified live 2026-08-05:
  //   text  → tokens:{input,input_audio,output,total,cache_creation,
  //                   cache_creation_1h,cache_read,cache_audio,
  //                   input_image,output_image}, images:null, video:null
  //   image → images:{count:17},   tokens:null, video:null
  //   video → video:{seconds:48},  tokens:null, images:null
  // So these are flattened out of three different sub-objects, and whichever
  // does not apply to the row's model_type stays 0. Reading `usage.images` or
  // `usage.video` as a bare number (the obvious guess) yields NaN — they are
  // objects, and `usage.tokens.total` is reported as 0 even when input/output
  // are populated, so never derive a total from it.
  requests:            { type: Number, default: 0 },
  tokensInput:         { type: Number, default: 0 },
  tokensOutput:        { type: Number, default: 0 },
  tokensCacheRead:     { type: Number, default: 0 },
  tokensCacheCreation: { type: Number, default: 0 },
  imageCount:          { type: Number, default: 0 },   // usage.images.count
  videoSeconds:        { type: Number, default: 0 },   // usage.video.seconds — SECONDS, not renders

  // Straight from the bucket. ONLY partial:false is final.
  // A partial:true bucket MUST still be persisted (so a day's live trend is
  // visible), but no reader may treat it as truth. Verified live 2026-08-05:
  // the current day returned partial:true, covered_until:'2026-08-05T20:22:33Z'.
  partial:      { type: Boolean, required: true },
  coveredUntil: { type: Date, default: null },

  currency: { type: String, default: 'usd' },
  fetchedAt:{ type: Date, default: Date.now },
  // Response request_id — Atlas support asks for this on tickets.
  atlasRequestId: { type: String, default: null },

  // Built by buildKey(); unique index is the sole identity constraint.
  // See buildKey comment for why not a compound unique on the dimensions.
  key: { type: String, required: true, unique: true }
});

// Reporting: recent days for a given scope.
atlasSpendDaySchema.index({ date: -1, scope: 1 });
// Per-model reconciliation join: CostLog.model ↔ modelName over a date range.
atlasSpendDaySchema.index({ scope: 1, modelName: 1, date: 1 });

// Always rebuild key from the dimensions so a .save() path cannot leave a stale
// unique key that no longer matches the row's identity.
//
// ⚠️ THIS HOOK DOES NOT RUN ON updateOne / bulkWrite / findOneAndUpdate.
// Mongoose document middleware fires only for document validation and .save().
// The sync writes via bulkWrite upserts for throughput, so it MUST pass
// `key` itself — use buildKey() as the upsert FILTER. If a writer forgets, the
// row inserts with key:undefined, and the very next such row collides on the
// unique index with a duplicate-key error on null. That failure is at least
// loud; a silently mismatched key would be worse. Do not "fix" it by dropping
// the unique index.
atlasSpendDaySchema.pre('validate', function (next) {
  this.key = buildKey(this);
  next();
});

const AtlasSpendDay = mongoose.model('AtlasSpendDay', atlasSpendDaySchema);

AtlasSpendDay.SCOPES = SCOPES;
AtlasSpendDay.GROUP_BYS = GROUP_BYS;
AtlasSpendDay.buildKey = buildKey;
AtlasSpendDay.usdStringToMicros = usdStringToMicros;
AtlasSpendDay.microsToUsd = microsToUsd;
AtlasSpendDay.microsToUsdString = microsToUsdString;

module.exports = AtlasSpendDay;
