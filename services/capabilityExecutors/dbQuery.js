// Executor for capability db.query (Tier 0, advertiser scope).
//
// Middle path between "no LLM DB access" and "raw Mongo access." Every
// invocation is:
//   1. Confined to a whitelisted collection (COLLECTIONS below).
//   2. Filtered by advertiserId INJECTED server-side — never accepted
//      from LLM args. Cross-tenant reads are structurally impossible.
//   3. Restricted to per-collection filterable field allowlists (dotted
//      paths only when explicitly listed).
//   4. Restricted to per-collection projection allowlists — the LLM
//      cannot request fields we deliberately hide (encrypted tokens,
//      large rawData blobs, PII).
//   5. Restricted to a small operator allowlist ($eq implicit, $ne,
//      $in, $nin, $exists, $gt, $gte, $lt, $lte). No $regex, $where,
//      $expr, $lookup, $or, $and, $not, $elemMatch — those would allow
//      bypassing tenant scope or run away on cost.
//   6. Hard-capped at 20 rows per response.
//
// If a REGRESSION removes any of these, an attacker who prompt-injects
// LLM output could read cross-tenant data. Verifier pins each rule.

'use strict';

const mongoose = require('mongoose');

const Media                = require('../../models/Media');
const CatalogProduct       = require('../../models/CatalogProduct');
const ProductMatchArtifact = require('../../models/ProductMatchArtifact');
const DetectionArtifact    = require('../../models/DetectionArtifact');
const DetectRun            = require('../../models/DetectRun');

const HARD_LIMIT       = 20;
const DEFAULT_LIMIT    = 10;
const MAX_FILTER_KEYS  = 6;
const MAX_ARRAY_VALUES = 20;

// Operators the LLM may use inside a filter clause. Anything else
// causes the request to reject. IMPORTANT — do not add $regex ($
// operators that accept regex strings are trivially DoS-able against
// non-indexed fields), $where (arbitrary JS), $expr (accepts $$ROOT +
// nested pipeline stages), or $lookup (would bypass tenant scope).
const ALLOWED_OPERATORS = new Set(['$eq', '$ne', '$in', '$nin', '$exists', '$gt', '$gte', '$lt', '$lte']);

// Per-collection whitelist. Every collection MUST have advertiserId
// on its schema — the resolver forces the filter using the caller's
// req.advertiserId regardless of what the LLM sent.
const COLLECTIONS = {
  Media: {
    model: Media,
    tenantField: 'advertiserId',
    filterable: new Set([
      '_id', 'brandId', 'source', 'fileType', 'externalId',
      'classification.socialPostType',
      'classification.detectSummary.outcome',
      'classification.contentNature',
      'classification.shotType',
      'rights.approved',
      'deletedAt',
      'createdAt', 'updatedAt'
    ]),
    projection: {
      _id: 1, advertiserId: 1, brandId: 1,
      externalId: 1, source: 1, sourceUrl: 1,
      fileType: 1, fileUrl: 1, fileMimeType: 1, fileName: 1,
      width: 1, height: 1, durationSec: 1,
      'metadata.brand': 1, 'metadata.caption': 1, 'metadata.postedAt': 1,
      'metadata.permalink': 1, 'metadata.creatorHandle': 1, 'metadata.postType': 1,
      'metadata.hashtags': 1,
      platformStats: 1,
      'rights.approved': 1, 'rights.approvedAt': 1,
      primarySubjectLabel: 1, secondaryElementsTags: 1,
      'classification.socialPostType': 1,
      'classification.detectSummary.outcome': 1,
      'classification.detectSummary.detectedAt': 1,
      'classification.contentNature': 1,
      'classification.shotType': 1,
      'adSuitability.score': 1, 'adSuitability.reasons': 1,
      matchedProducts: 1, matchedCategories: 1,
      latestArtifacts: 1,
      lastDetectedAt: 1,
      createdAt: 1, updatedAt: 1, deletedAt: 1
    },
    sortable: new Set(['createdAt', 'updatedAt', '_id', 'lastDetectedAt'])
  },

  CatalogProduct: {
    model: CatalogProduct,
    tenantField: 'advertiserId',
    filterable: new Set([
      '_id', 'brandId', 'source', 'externalId', 'draft',
      'isPrimaryVariant', 'itemGroupId', 'primaryProductId',
      'gtin', 'mpn', 'category', 'categoryRef', 'currency',
      'availability',
      'inferredCategoryAt',
      'firstSeenAt', 'lastSyncedAt', 'detailsRefreshedAt'
    ]),
    projection: {
      _id: 1, advertiserId: 1, brandId: 1,
      source: 1, externalId: 1, retailerId: 1,
      title: 1, normalizedTitle: 1, description: 1,
      brand: 1, category: 1, price: 1, currency: 1, availability: 1,
      imageUrl: 1, additionalImages: 1, imageMediaId: 1, additionalImageMediaIds: 1,
      productUrl: 1,
      draft: 1, isPrimaryVariant: 1, primaryProductId: 1, itemGroupId: 1,
      gtin: 1, mpn: 1,
      rating: 1, ratingDistribution: 1,
      'productReviews.quotes': 1,
      'productReviews.rating': 1,
      'productReviews.reviewCount': 1,
      'productReviews.summary': 1,
      'productReviews.source': 1,
      'productReviews.fetchedAt': 1,
      categoryRef: 1, inferredBreadcrumb: 1, inferredCategoryAt: 1,
      matchedMedia: 1,
      detailsRefreshedAt: 1,
      firstSeenAt: 1, lastSyncedAt: 1
    },
    sortable: new Set(['createdAt', 'lastSyncedAt', 'firstSeenAt', '_id', 'price', 'title'])
  },

  ProductMatchArtifact: {
    model: ProductMatchArtifact,
    tenantField: 'advertiserId',
    filterable: new Set([
      '_id', 'brandId', 'mediaId', 'runId', 'outcome',
      'catalogProductId', 'categoryId', 'matchSource',
      'productIndex', 'createdAt'
    ]),
    projection: {
      _id: 1, advertiserId: 1, brandId: 1,
      mediaId: 1, runId: 1,
      productIndex: 1,
      outcome: 1, outcomeReasoning: 1, matchSource: 1,
      catalogProductId: 1, categoryId: 1,
      catalogCombinedScore: 1, catalogVisualScore: 1,
      catalogMatch: 1, winner: 1,
      identification: 1,
      recommendedProducts: 1,
      enrichmentTiers: 1,
      createdAt: 1
    },
    sortable: new Set(['createdAt', '_id'])
  },

  DetectionArtifact: {
    model: DetectionArtifact,
    tenantField: 'advertiserId',
    filterable: new Set([
      '_id', 'brandId', 'mediaId', 'runId', 'type', 'createdAt'
    ]),
    projection: {
      _id: 1, advertiserId: 1, brandId: 1,
      mediaId: 1, runId: 1,
      type: 1,
      imageUrl: 1,
      // Deliberately excluding the large detected-objects blob.
      // Callers who need it should fetch the artifact by id via a
      // dedicated cap; that's a future addition.
      createdAt: 1
    },
    sortable: new Set(['createdAt', '_id'])
  },

  DetectRun: {
    model: DetectRun,
    tenantField: 'advertiserId',
    filterable: new Set([
      '_id', 'brandId', 'mediaId', 'status', 'stage',
      'trigger', 'priority',
      'createdAt', 'updatedAt'
    ]),
    projection: {
      _id: 1, advertiserId: 1, brandId: 1,
      mediaId: 1, status: 1, stage: 1,
      trigger: 1, priority: 1,
      error: 1, errorStage: 1,
      flags: 1,
      startedAt: 1, endedAt: 1, createdAt: 1, updatedAt: 1
    },
    sortable: new Set(['createdAt', 'updatedAt', '_id'])
  }
};

// Sanitize a single filter clause value. LLM args can be a literal
// (string / number / boolean / null) OR an operator object like
// { $in: [...] }. Anything else rejects.
function sanitizeValue(fieldKey, raw) {
  if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { ok: true, value: raw };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `filter[${fieldKey}] must be a literal or operator object` };
  }
  // Operator object — validate every key.
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return { ok: false, error: `filter[${fieldKey}] operator object is empty` };
  }
  if (keys.length > 3) {
    return { ok: false, error: `filter[${fieldKey}] has too many operator keys (max 3)` };
  }
  const out = {};
  for (const op of keys) {
    if (!ALLOWED_OPERATORS.has(op)) {
      return { ok: false, error: `filter[${fieldKey}] uses disallowed operator ${op} — allowed: ${[...ALLOWED_OPERATORS].join(', ')}` };
    }
    const v = raw[op];
    if (op === '$in' || op === '$nin') {
      if (!Array.isArray(v)) return { ok: false, error: `filter[${fieldKey}].${op} requires an array` };
      if (v.length > MAX_ARRAY_VALUES) {
        return { ok: false, error: `filter[${fieldKey}].${op} array too long (max ${MAX_ARRAY_VALUES})` };
      }
      for (const item of v) {
        if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
          return { ok: false, error: `filter[${fieldKey}].${op} items must be scalars` };
        }
      }
      out[op] = v;
      continue;
    }
    if (op === '$exists') {
      if (typeof v !== 'boolean') return { ok: false, error: `filter[${fieldKey}].$exists must be boolean` };
      out[op] = v;
      continue;
    }
    // $eq / $ne / $gt / $gte / $lt / $lte — literal scalar.
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { ok: false, error: `filter[${fieldKey}].${op} must be a scalar` };
    }
    out[op] = v;
  }
  return { ok: true, value: out };
}

// Coerce string ObjectId scalars to actual ObjectIds for _id-like
// fields. Without this, filter { _id: 'abc123...' } would silently
// return zero rows because Mongoose won't cast a string against an
// ObjectId column with a scalar $eq alias.
function coerceObjectIds(fieldKey, value) {
  const isObjectIdField = /(^_id$|Id$|\.mediaId$|\.brandId$)/.test(fieldKey);
  if (!isObjectIdField) return value;
  if (value === null) return value;
  if (typeof value === 'string') {
    return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [op, v] of Object.entries(value)) {
      if (op === '$in' || op === '$nin') {
        out[op] = v.map((item) => (typeof item === 'string' && mongoose.isValidObjectId(item)) ? new mongoose.Types.ObjectId(item) : item);
      } else if (typeof v === 'string' && mongoose.isValidObjectId(v)) {
        out[op] = new mongoose.Types.ObjectId(v);
      } else {
        out[op] = v;
      }
    }
    return out;
  }
  return value;
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const collection = args?.collection;
  if (!collection) return { ok: false, error: `collection required — allowed: ${Object.keys(COLLECTIONS).join(', ')}` };
  const spec = COLLECTIONS[collection];
  if (!spec) {
    return { ok: false, error: `collection "${collection}" not in the allowlist — allowed: ${Object.keys(COLLECTIONS).join(', ')}` };
  }

  const rawFilter = args?.filter || {};
  if (typeof rawFilter !== 'object' || Array.isArray(rawFilter)) {
    return { ok: false, error: 'filter must be an object (or omit for no additional filter)' };
  }
  const filterKeys = Object.keys(rawFilter);
  if (filterKeys.length > MAX_FILTER_KEYS) {
    return { ok: false, error: `filter has too many keys (${filterKeys.length} > ${MAX_FILTER_KEYS})` };
  }

  const safeFilter = {};
  for (const key of filterKeys) {
    // Reject $-prefixed root keys — $or, $and, $where, $expr all live
    // here and are all disallowed.
    if (key.startsWith('$')) {
      return { ok: false, error: `filter root key "${key}" is disallowed — root filter cannot use $or / $and / $expr / $where` };
    }
    if (!spec.filterable.has(key)) {
      return { ok: false, error: `filter key "${key}" not in the allowlist for ${collection} — allowed: ${[...spec.filterable].sort().join(', ')}` };
    }
    const sanitized = sanitizeValue(key, rawFilter[key]);
    if (!sanitized.ok) return { ok: false, error: sanitized.error };
    safeFilter[key] = coerceObjectIds(key, sanitized.value);
  }

  // TENANCY: force the advertiserId filter regardless of what the LLM
  // sent. Even if the LLM tries to include advertiserId in its args,
  // sanitized value gets clobbered by this line. Load-bearing —
  // verifier pins the pattern via a source-scan (checkDbQueryInvariants
  // in scripts/verifyAgentRegistry.js).
  safeFilter[spec.tenantField] = new mongoose.Types.ObjectId(req.advertiserId);

  const limit = Math.min(Math.max(parseInt(args?.limit, 10) || DEFAULT_LIMIT, 1), HARD_LIMIT);

  let sort = { createdAt: -1 };
  if (args?.sort && typeof args.sort === 'object' && !Array.isArray(args.sort)) {
    const sortKeys = Object.keys(args.sort);
    if (sortKeys.length > 2) return { ok: false, error: `sort has too many keys (max 2)` };
    const sortOut = {};
    for (const key of sortKeys) {
      if (!spec.sortable.has(key)) {
        return { ok: false, error: `sort key "${key}" not sortable on ${collection} — allowed: ${[...spec.sortable].sort().join(', ')}` };
      }
      const v = args.sort[key];
      if (v !== 1 && v !== -1 && v !== 'asc' && v !== 'desc') {
        return { ok: false, error: `sort[${key}] must be 1, -1, "asc", or "desc"` };
      }
      sortOut[key] = (v === 1 || v === 'asc') ? 1 : -1;
    }
    sort = sortOut;
  }

  let rows;
  try {
    rows = await spec.model.find(safeFilter)
      .sort(sort)
      .limit(limit + 1)   // +1 to detect truncation
      .select(spec.projection)
      .lean();
  } catch (err) {
    return { ok: false, error: `query failed: ${err.message}` };
  }

  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;

  return {
    ok: true,
    kind: 'dbQueryResult',
    data: {
      collection,
      count: rows.length,
      truncated,
      rows,
      note: truncated
        ? `Result set was truncated at limit=${limit}. Refine the filter to narrow, or paginate by _id via {$gt: lastId}.`
        : 'All matching rows returned.'
    }
  };
}

// Exported for the verifier's regression tests. Do not import from
// production code paths — the executor's run() is the sanctioned
// entry point.
module.exports = { run, COLLECTIONS, ALLOWED_OPERATORS, HARD_LIMIT };
