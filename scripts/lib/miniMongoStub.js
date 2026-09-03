'use strict';
//
// miniMongoStub — a minimal, dependency-free in-memory Mongo-like collection
// for verify harnesses that need to drive REAL query/claim/update logic
// (e.g. titlingResumeService.buildResumeFilter, its per-document CAS claim,
// brandScriptExecutor's stampTitlingFailureAndThrow $inc) without a real
// MongoDB connection. Chosen over a full mongodb-memory-server dependency
// (not installed in a bare worktree — see this repo's CLAUDE.md on
// npm ci/NODE_PATH hazards) and over hand-waving the DB layer entirely,
// which would leave the actual per-document CAS semantics (the thing that
// makes two racing claims safe) untested.
//
// SUPPORTS EXACTLY the operator surface the code under test actually uses:
// top-level field equality, $ne, $lt, $gt, $in, $nin, $exists, $or, $and. An
// operator outside that set throws rather than silently matching/no-matching,
// so a future filter shape this doesn't understand fails LOUD, not quiet.
//
// Chaining mirrors real Mongoose Query enough for the call shapes this repo
// uses: `.find(filter).sort().limit(n).lean()`, `.findById(id).select().lean()`,
// `.findOneAndUpdate(filter, update, opts).lean()`, `.updateOne(filter, update)`.
// sort() is a no-op (tests that need FIFO order construct docs pre-sorted).

// Resolve a possibly-DOTTED field path, the way Mongo does. Added 2026-08-26:
// without this, `matches` read `doc['imageGeneration.predictionId']` as a
// literal key, got undefined, and SILENTLY treated the condition as unmatched.
// That is the quiet-failure mode this file's header promises not to have, and it
// bit for real — spendReceipt.HAS_RECEIPT's image arm is exactly that dotted
// path, so every harness evaluating the real HAS_RECEIPT would have concluded a
// stranded IMAGE receipt is never selected, which is false in production.
function resolvePath(doc, key) {
  if (!key.includes('.')) return doc[key];
  return key.split('.').reduce((o, part) => (o == null ? undefined : o[part]), doc);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((sub) => matches(doc, sub));
    if (key === '$and') return cond.every((sub) => matches(doc, sub));
    const val = resolvePath(doc, key);
    const isOperatorObject = cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date);
    if (isOperatorObject) {
      return Object.entries(cond).every(([op, opVal]) => {
        switch (op) {
          case '$ne':  return val !== opVal;
          case '$lt':  return val != null && val < opVal;
          case '$gt':  return val != null && val > opVal;
          // Added 2026-09-02 for verifyRegenerateStatusPromotionAndCascade.js,
          // which evaluates campaignRunIds:{$in:[...]} against a real ARRAY
          // field — Mongo's $in against an array field matches when ANY
          // element of the array is in the list (array-contains-any), not
          // scalar equality of the whole array. Scalar fields (the pre-
          // existing callers) are unaffected: Array.isArray(val) is false for
          // them, so this falls through to the original scalar check.
          case '$in':  return Array.isArray(val)
            ? val.some((v) => opVal.includes(v))
            : opVal.includes(val === undefined ? null : val);
          // $nin added 2026-08-26 for verifyBootRecoveryClaimAware, which
          // evaluates the REAL spendReceipt.HAS_RECEIPT (`$nin: [null, '']`)
          // rather than a stubbed stand-in. A missing field is normalised to
          // null on both sides, matching Mongo: `$nin:[null]` does NOT match an
          // absent path. Array-field case mirrors $in above.
          case '$nin': return Array.isArray(val)
            ? !val.some((v) => opVal.includes(v))
            : !opVal.includes(val === undefined ? null : val);
          case '$exists': return opVal ? val !== undefined : val === undefined;
          // $size added 2026-09-03 for findDerivativesOfMaster's empty
          // referenceMediaIds arm (identity-family join). Mongo matches
          // arrays whose length equals opVal; a missing/non-array field
          // does not match.
          case '$size': return Array.isArray(val) && val.length === opVal;
          // $elemMatch / $not added 2026-09-03 for
          // verifyGeminiLeaseSweeperCollision.js, which evaluates the REAL
          // queuedArchiveSweeper.buildQueuedArchiveFilter. That filter's
          // ownership clause is `campaignRunIds: { $in: ids, $not: {
          // $elemMatch: { $nin: ids } } }` — "every element is in the
          // terminal set", not merely "any element is". Without these
          // operators the stub would throw (fail-loud, as designed) and
          // the harness could not execute the real filter at all.
          //
          // $elemMatch: any array element matches the subfilter. Scalar
          // elements (this repo's campaignRunIds is string[]) are wrapped
          // so operator-only subfilters like `{ $nin: ids }` apply to the
          // element value, matching Mongo.
          // $not: negate a nested operator object on the same field.
          case '$elemMatch': {
            if (!Array.isArray(val)) return false;
            return val.some((elem) => {
              const isDoc = elem !== null && typeof elem === 'object'
                && !Array.isArray(elem) && !(elem instanceof Date);
              return isDoc
                ? matches(elem, opVal)
                : matches({ __elem: elem }, { __elem: opVal });
            });
          }
          case '$not':
            return !matches({ __v: val }, { __v: opVal });
          default: throw new Error(`miniMongoStub: unsupported operator ${op}`);
        }
      });
    }
    // Mongo equality on arrays is by value (order-significant), not by
    // JS reference. Without this, `{ referenceMediaIds: [] }` in a filter
    // would never match a document that also has `[]` as a different
    // instance — which is exactly how mint-time empty stacks look.
    if (Array.isArray(cond)) {
      if (!Array.isArray(val) || val.length !== cond.length) return false;
      return val.every((v, i) => v === cond[i] || String(v) === String(cond[i]));
    }
    return val === cond;
  });
}

function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  // Added 2026-09-02 for verifyRegenerateStatusPromotionAndCascade.js, which
  // drives the REAL recascadeDerivativeSibling — its stale-basePlate clear
  // is a genuine $unset, not a $set:null (the crop/detection code this
  // stub's callers stand in for distinguishes "absent" from "explicitly
  // null" the same way ensureFaceDetectionForKeepOut's sourceUrl match does
  // — see that function's own comment in brandScriptExecutor.js).
  if (update.$unset) {
    for (const k of Object.keys(update.$unset)) delete doc[k];
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
  }
  return doc;
}

class MiniCollection {
  constructor(docs = []) {
    this.docs = docs.map((d) => ({ ...d }));
    // Audit trail — every write, in order, so a harness can assert on the
    // ACTUAL persisted payload rather than re-deriving it from source text.
    this.calls = [];
  }

  _clone(doc) { return doc ? { ...doc } : doc; }

  find(filter) {
    const self = this;
    let limitN = null;
    const chain = {
      sort() { return chain; },
      limit(n) { limitN = n; return chain; },
      select() { return chain; },
      lean() {
        const matched = self.docs.filter((d) => matches(d, filter));
        const arr = limitN != null ? matched.slice(0, limitN) : matched;
        return Promise.resolve(arr.map((d) => self._clone(d)));
      }
    };
    return chain;
  }

  findById(id) {
    const self = this;
    return {
      select() { return this; },
      lean() {
        const doc = self.docs.find((d) => String(d._id) === String(id));
        return Promise.resolve(self._clone(doc));
      }
    };
  }

  updateOne(filter, update) {
    this.calls.push({ op: 'updateOne', filter: clonePlain(filter), update: clonePlain(update) });
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    applyUpdate(doc, update);
    return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
  }

  updateMany(filter, update) {
    this.calls.push({ op: 'updateMany', filter: clonePlain(filter), update: clonePlain(update) });
    const matched = this.docs.filter((d) => matches(d, filter));
    for (const doc of matched) applyUpdate(doc, update);
    return Promise.resolve({ matchedCount: matched.length, modifiedCount: matched.length });
  }

  findOneAndUpdate(filter, update, opts = {}) {
    this.calls.push({ op: 'findOneAndUpdate', filter: clonePlain(filter), update: clonePlain(update), opts: clonePlain(opts) });
    const self = this;
    return {
      lean() {
        const doc = self.docs.find((d) => matches(d, filter));
        if (!doc) return Promise.resolve(null);
        // MONGOOSE DEFAULT IS `new: false` — findOneAndUpdate returns the
        // PRE-update document unless the caller explicitly asks for the
        // post-update one. Getting this backwards is exactly the sign/timing
        // bug the $inc read-back in stampTitlingFailureAndThrow depends on
        // being right (adversarial review, 2026-08-25 — an earlier version
        // of this stub ignored `opts` entirely and always returned the
        // post-update doc, so a production bug that dropped `{new:true}`
        // would have stayed invisible: every attempt count would read one
        // low, silently allowing one extra retry past the cap, and the
        // harness would have stayed green throughout).
        const before = self._clone(doc);
        applyUpdate(doc, update);
        return Promise.resolve(opts.new ? self._clone(doc) : before);
      }
    };
  }
}

// Filters/updates can carry Dates and RegExps — JSON round-trip would break
// those, so the audit-trail clone is a shallow copy, not JSON.parse(JSON.stringify()).
// FIXED 2026-08-26: Date/RegExp instances were falling into the generic
// object-loop branch below, which iterates Object.entries() — both types
// have zero enumerable own properties, so every Date/RegExp in a filter or
// $set silently became `{}` in the audit trail. Harmless for a harness that
// never asserts on a cloned Date, but a `x instanceof Date` check on
// `.calls[...].filter.someField.$lt` (verifyTitlerClaimReclaim.js) failed
// against an object that used to hold a real staleness cutoff — caught by
// that new check, not previously exercised by any existing harness.
function clonePlain(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
  if (Array.isArray(obj)) return obj.map(clonePlain);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = clonePlain(v);
  return out;
}

module.exports = { MiniCollection, matches };
