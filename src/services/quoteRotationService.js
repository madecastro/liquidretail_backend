// Shared quote rotation for static (directImageRenderService) and video
// (brandScriptExecutor). ONE helper, two flag gates. Never edits quote text
// and never calls an LLM — it only picks which already-assembled quote object
// becomes primary.
//
// Hash-only rotation (memory off) is the 2026-08-11 behaviour: index =
// hash(campaignRunId) % pool.length. Consecutive runs collide ~1/N.
// QUOTE_ROTATION_MEMORY (default false) skips the last N fingerprints
// stored on CatalogProduct.recentQuoteKeys until the eligible pool is
// exhausted, then wraps (still excluding the just-used quote). Fingerprint
// is the existing reviewKey convention (first-160-lowercased), reused from
// reviewAdapters/helpers — not invented.
//
// SAME-RUN INVARIANT (structural, not incidental):
//   Every size of one generation MUST print the same quote. The first size
//   to decide persists lastQuoteFingerprint + lastQuoteRunId. Every sibling
//   that sees lastQuoteRunId === this run REPLAYS that fingerprint from the
//   pool — it does not re-hash. Re-hashing is what inverted the latch:
//   first size hashed the unseen slice; a later sibling hashed the full
//   pool; hash(run) % 4 ≠ hash(run) % 6. Replay cannot diverge: there is
//   no second modulo.
//
// Persist is atomic and fire-and-forget. First writer for a run wins
// (update filter lastQuoteRunId !== thisRun). A Mongo blip is swallowed
// and logged; it must never fail a billed render.

'use strict';

const { reviewKey } = require('./reviewAdapters/helpers');

const MEMORY_N = Math.max(
  1,
  parseInt(process.env.QUOTE_ROTATION_MEMORY_N, 10) || 8
);

function staticRotationEnabled() {
  return process.env.STATIC_QUOTE_ROTATION !== 'false';
}

// Default FALSE — video has burned primary_quote.snippet forever; flipping
// this on is opt-in, not a silent change to delivered chrome.
function videoRotationEnabled() {
  return process.env.VIDEO_QUOTE_ROTATION === 'true';
}

function memoryEnabled() {
  return process.env.QUOTE_ROTATION_MEMORY === 'true';
}

/** Stable non-negative 32-bit FNV-1a. Deterministic across processes —
 *  Math.random and Date are deliberately absent so the same run always
 *  resolves the same quote, which is what keeps the sizes in agreement. */
function rotationHash(key) {
  const s = String(key || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function quoteFingerprint(quoteOrText) {
  if (quoteOrText && typeof quoteOrText === 'object') {
    return reviewKey(quoteOrText.text);
  }
  return reviewKey(quoteOrText);
}

function normalizeRecentKeys(recentKeys) {
  if (!Array.isArray(recentKeys)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of recentKeys) {
    const key = typeof entry === 'string'
      ? reviewKey(entry)
      : reviewKey(entry && (entry.key || entry.text));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function nextRecentKeys(prev, fingerprint, { wrapped = false, max = MEMORY_N } = {}) {
  const key = reviewKey(fingerprint);
  if (!key) return wrapped ? [] : normalizeRecentKeys(prev);
  if (wrapped) return [key];
  const base = normalizeRecentKeys(prev).filter((k) => k !== key);
  base.push(key);
  return base.slice(-Math.max(1, max));
}

/**
 * True when this quote would survive the render-time gate
 * (toPrintableCustomerQuote + applyStrictQuoteScope). Rotation must not
 * reseat onto a line the gate will then drop — that is how flag-on lost
 * a testimonial flag-off would have printed.
 */
function passesRenderGate(quote, scope) {
  if (!quote) return false;
  const { toPrintableCustomerQuote, applyStrictQuoteScope } = require('./quoteProvenance');
  const printable = toPrintableCustomerQuote(quote);
  if (!printable) return false;
  if (!scope) return true;
  return applyStrictQuoteScope(printable, scope) != null;
}

/**
 * Eligible pool: same-tier + unique-by-text + quality floor + render gate.
 * Extracted so memory skip / wrap run AFTER the existing guards, never instead.
 * opts.scope  — forwarded to applyStrictQuoteScope (flag-off is identity).
 * opts.stage / opts.angleTerms — same soft bias pickStrongestQuote uses, so
 *   a later Q1 wire-up cannot be undone by an unstaged re-hash.
 */
function eligiblePool(proof, opts = {}) {
  const primary = proof?.primary_quote || null;
  if (!primary || !String(primary.text || '').trim()) return [];
  const { clearsQualityFloor, scoreQuote } = require('./layoutInputService');
  const tier = primary.tier || null;
  const seen = new Set();
  const quoteOpts = {
    stage: opts.stage || null,
    angleTerms: Array.isArray(opts.angleTerms) ? opts.angleTerms : null
  };
  const pool = [primary, ...(Array.isArray(proof.secondary_quotes) ? proof.secondary_quotes : [])]
    .filter((q) => q && String(q.text || '').trim())
    .filter((q) => (q.tier || null) === tier)
    .filter((q) => {
      const k = String(q.text).trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .filter((q) => clearsQualityFloor(q.text))
    .filter((q) => passesRenderGate(q, opts.scope));
  pool.sort((a, b) => (scoreQuote(b.text, quoteOpts) - scoreQuote(a.text, quoteOpts)) || (a.text < b.text ? -1 : 1));
  return pool;
}

/**
 * The run's already-decided fingerprint. Prefer the dedicated field; fall
 * back to the last key of recentQuoteKeys (docs written before the field
 * existed). Empty when this run has not decided yet.
 */
function lockedFingerprintForRun(opts, campaignRunId) {
  if (!opts || !campaignRunId) return '';
  if (!opts.lastRunId || String(opts.lastRunId) !== String(campaignRunId)) return '';
  const dedicated = reviewKey(opts.lastFingerprint);
  if (dedicated) return dedicated;
  const recent = normalizeRecentKeys(opts.recentKeys);
  return recent.length ? recent[recent.length - 1] : '';
}

function quoteMatchingFingerprint(pool, fingerprint) {
  const key = reviewKey(fingerprint);
  if (!key || !Array.isArray(pool)) return null;
  return pool.find((q) => quoteFingerprint(q) === key) || null;
}

/**
 * rotateQuote — the full result (quote + memory delta).
 *
 * opts.enabled        — caller-computed flag (static vs video). Required;
 *                       if omitted / false, returns the primary untouched.
 * opts.recentKeys     — CatalogProduct.recentQuoteKeys snapshot (strings).
 * opts.lastRunId      — CatalogProduct.lastQuoteRunId (same-run latch).
 * opts.lastFingerprint— CatalogProduct.lastQuoteFingerprint (replay key).
 * opts.memoryEnabled  — override; defaults to QUOTE_ROTATION_MEMORY.
 * opts.memoryN        — override; defaults to MEMORY_N (8).
 * opts.scope          — quoteProvenance scope (STRICT + printable).
 * opts.stage / opts.angleTerms — optional scorer bias.
 */
function rotateQuote(proof, campaignRunId, opts = {}) {
  const primary = proof?.primary_quote || null;
  const empty = {
    quote: primary,
    fingerprint: primary ? quoteFingerprint(primary) : '',
    wrapped: false,
    nextRecentKeys: normalizeRecentKeys(opts.recentKeys),
    poolSize: 0,
    skipped: 0,
    lockedSameRun: false
  };
  if (!primary || !primary.text) return empty;
  if (!opts.enabled || !campaignRunId) return empty;

  const pool = eligiblePool(proof, opts);
  if (pool.length < 2) {
    return { ...empty, poolSize: pool.length };
  }

  const useMemory = opts.memoryEnabled != null ? !!opts.memoryEnabled : memoryEnabled();
  const recent = useMemory ? normalizeRecentKeys(opts.recentKeys) : [];

  // STRUCTURAL same-run: replay the fingerprint this run already wrote.
  // Do not re-derive an index. A different working-set length is exactly
  // how 1:1 and 4:5 used to quote different customers.
  if (useMemory) {
    const lockedKey = lockedFingerprintForRun(opts, campaignRunId);
    const locked = lockedKey ? quoteMatchingFingerprint(pool, lockedKey) : null;
    if (locked) {
      const fingerprint = quoteFingerprint(locked);
      return {
        quote: locked,
        fingerprint,
        wrapped: false,
        nextRecentKeys: recent.length ? recent : nextRecentKeys(recent, fingerprint, {
          wrapped: false,
          max: opts.memoryN != null ? opts.memoryN : MEMORY_N
        }),
        poolSize: pool.length,
        skipped: 0,
        lockedSameRun: true
      };
    }
  }

  let working = pool;
  let wrapped = false;
  let skipped = 0;
  if (useMemory && recent.length) {
    const seen = new Set(recent);
    const unseen = pool.filter((q) => !seen.has(quoteFingerprint(q)));
    skipped = pool.length - unseen.length;
    if (unseen.length === 0) {
      // Exhaustion wrap must still exclude the quote the previous run just
      // used — otherwise wrap reprints it with probability 1/N, which is
      // the consecutive-run collision this lane exists to close.
      const lastUsed = recent[recent.length - 1];
      const wrapPool = lastUsed
        ? pool.filter((q) => quoteFingerprint(q) !== lastUsed)
        : pool;
      working = wrapPool.length ? wrapPool : pool;
      wrapped = true;
    } else {
      working = unseen;
    }
  }

  const idx = rotationHash(campaignRunId) % working.length;
  const picked = working[idx];
  if (picked !== primary) {
    console.log(
      `   · quote rotation: run ${campaignRunId} → candidate ${idx + 1}/${working.length}` +
      ` (tier=${(primary.tier || 'unstamped')}` +
      `${wrapped ? ', wrapped' : ''}` +
      `${skipped ? `, skipped ${skipped} seen` : ''})`
    );
  }

  const fingerprint = quoteFingerprint(picked);
  const nextKeys = useMemory
    ? nextRecentKeys(wrapped ? [] : recent, fingerprint, {
      wrapped,
      max: opts.memoryN != null ? opts.memoryN : MEMORY_N
    })
    : recent;

  return {
    quote: picked,
    fingerprint,
    wrapped,
    nextRecentKeys: nextKeys,
    poolSize: pool.length,
    skipped,
    lockedSameRun: false
  };
}

/** Backward-compatible: returns the quote object, same as the pre-extract helper. */
function selectRotatedQuote(proof, campaignRunId, opts = {}) {
  return rotateQuote(proof, campaignRunId, opts).quote;
}

function campaignRunIdFromAd(ad) {
  if (!ad) return null;
  if (ad.campaignRunId) return ad.campaignRunId;
  const ids = ad.campaignRunIds;
  if (Array.isArray(ids) && ids.length) return ids[ids.length - 1];
  return null;
}

/**
 * Reseat layoutInput.input.social_proof.primary_quote with the rotated pick.
 * Flag-off (VIDEO_QUOTE_ROTATION !== 'true') returns the SAME object —
 * byte-identity for the video path. Never mutates the input.
 *
 * When reseating, the original primary is prepended onto secondary_quotes
 * so the existing gate rescue can recover it if the rotated pick is later
 * withheld. Combined with the render-gate filter in eligiblePool, flag-on
 * cannot lose a testimonial flag-off would have printed.
 */
function rotateLayoutInputQuote(layoutInput, campaignRunId, opts = {}) {
  const enabled = opts.enabled != null ? !!opts.enabled : videoRotationEnabled();
  if (!enabled || !layoutInput?.input?.social_proof) return layoutInput;
  const current = layoutInput.input.social_proof.primary_quote;
  const result = rotateQuote(layoutInput.input.social_proof, campaignRunId, {
    ...opts,
    enabled: true
  });
  const picked = result.quote;
  if (!picked || picked === current) {
    return Object.assign(layoutInput, { _quoteRotation: result });
  }
  const prevSecondaries = Array.isArray(layoutInput.input.social_proof.secondary_quotes)
    ? layoutInput.input.social_proof.secondary_quotes
    : [];
  const pickedText = String(picked.text || '').trim();
  const currentText = String(current && current.text || '').trim();
  const secondaries = [
    current,
    ...prevSecondaries.filter((q) => {
      if (!q) return false;
      const t = String(q.text || '').trim();
      if (pickedText && t === pickedText) return false;
      if (currentText && t === currentText) return false;
      return true;
    })
  ].filter(Boolean);
  return {
    ...layoutInput,
    input: {
      ...layoutInput.input,
      social_proof: {
        ...layoutInput.input.social_proof,
        primary_quote: picked,
        secondary_quotes: secondaries
      }
    },
    _quoteRotation: result
  };
}

/**
 * Pure persist transition — the Mongo update and the harness concurrency
 * sim share this so a racy $set cannot pass the test that the atomic
 * write is supposed to pin.
 *
 * First writer for `campaignRunId` wins. A sibling of the same run is a
 * no-op (applied: false). Wrap replaces the skip list with [this pick];
 * otherwise the fingerprint is appended and sliced to N.
 */
function commitQuoteChoice(doc, { fingerprint, campaignRunId, wrapped = false, max = MEMORY_N } = {}) {
  const key = reviewKey(fingerprint);
  const runId = campaignRunId != null ? String(campaignRunId) : '';
  if (!key || !runId) return { applied: false, doc: doc || {} };
  const prev = doc && typeof doc === 'object' ? doc : {};
  if (prev.lastQuoteRunId != null && String(prev.lastQuoteRunId) === runId) {
    return { applied: false, doc: prev };
  }
  const next = {
    recentQuoteKeys: Array.isArray(prev.recentQuoteKeys) ? prev.recentQuoteKeys.slice() : [],
    lastQuoteRunId: prev.lastQuoteRunId,
    lastQuoteFingerprint: prev.lastQuoteFingerprint
  };
  next.lastQuoteRunId = runId;
  next.lastQuoteFingerprint = key;
  if (wrapped) {
    next.recentQuoteKeys = [key];
  } else {
    const keys = normalizeRecentKeys(next.recentQuoteKeys).filter((k) => k !== key);
    keys.push(key);
    next.recentQuoteKeys = keys.slice(-Math.max(1, max));
  }
  return { applied: true, doc: next };
}

/**
 * Atomic Mongo op matching commitQuoteChoice. Filter is first-writer-wins
 * per run. Non-wrap uses $push+$slice so overlapping *different* runs
 * cannot wipe each other's skip-list with a snapshot $set.
 */
function persistOp({ fingerprint, campaignRunId, wrapped = false, max = MEMORY_N } = {}) {
  const key = reviewKey(fingerprint);
  const runId = campaignRunId != null ? String(campaignRunId) : '';
  const filter = { lastQuoteRunId: { $ne: runId } };
  if (wrapped) {
    return {
      filter,
      update: {
        $set: {
          lastQuoteRunId: runId,
          lastQuoteFingerprint: key,
          recentQuoteKeys: [key]
        }
      }
    };
  }
  return {
    filter,
    update: {
      $set: {
        lastQuoteRunId: runId,
        lastQuoteFingerprint: key
      },
      $push: {
        recentQuoteKeys: { $each: [key], $slice: -Math.max(1, max) }
      }
    }
  };
}

/**
 * Persist last-N fingerprints + the run latch. Fire-and-forget from callers —
 * a failed write must never fail a billed render. No-ops when memory is off
 * or when there is no product to write to. Swallows Mongo errors.
 */
function persistQuoteChoice(productId, { fingerprint, campaignRunId, wrapped = false } = {}) {
  if (!memoryEnabled()) return Promise.resolve(false);
  if (!productId || !campaignRunId) return Promise.resolve(false);
  const key = reviewKey(fingerprint);
  if (!key) return Promise.resolve(false);
  let CatalogProduct;
  try {
    CatalogProduct = require('../models/CatalogProduct');
  } catch {
    return Promise.resolve(false);
  }
  const op = persistOp({ fingerprint: key, campaignRunId, wrapped });
  return CatalogProduct.updateOne(
    { _id: productId, ...op.filter },
    op.update
  ).then(() => true).catch((err) => {
    console.warn(`   ⚠️  quote rotation memory persist failed: ${err.message}`);
    return false;
  });
}

module.exports = {
  reviewKey,
  quoteFingerprint,
  rotationHash,
  staticRotationEnabled,
  videoRotationEnabled,
  memoryEnabled,
  MEMORY_N,
  normalizeRecentKeys,
  nextRecentKeys,
  eligiblePool,
  passesRenderGate,
  lockedFingerprintForRun,
  rotateQuote,
  selectRotatedQuote,
  campaignRunIdFromAd,
  rotateLayoutInputQuote,
  commitQuoteChoice,
  persistOp,
  persistQuoteChoice
};
