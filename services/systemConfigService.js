// Thin accessor around the SystemConfig singleton. Encapsulates the
// "load canonical script — DB first, file fallback" pattern so
// callers don't reimplement it. Also lazy-creates the singleton on
// first access.

const fs   = require('fs');
const path = require('path');
const SystemConfig = require('../models/SystemConfig');

const CANONICAL_FEED_FILE            = path.join(__dirname, 'brandScripts', 'canonical.script.js');
const CANONICAL_VERTICAL_FILE        = path.join(__dirname, 'brandScripts', 'top_scrim_editorial.script.js');
const CANONICAL_VERTICAL_DR_V1_FILE  = path.join(__dirname, 'brandScripts', 'canonical_dr_v1_vertical.script.js');
const CANONICAL_LANDSCAPE_FILE       = path.join(__dirname, 'brandScripts', 'local_scrim_landscape.script.js');

// Which file backs the vertical canonical. The DR-v1 template is the
// new default when CANONICAL_DR_V1=true — a three-phase overlay (hook
// / proof / product endcard) that pairs with the fixed lifestyle beat
// template Grok now generates. The legacy top_scrim_editorial file
// stays on disk so the operator can revert via DB override without a
// redeploy.
function verticalCanonicalFile() {
  return String(process.env.CANONICAL_DR_V1 || '').toLowerCase() === 'true'
    ? CANONICAL_VERTICAL_DR_V1_FILE
    : CANONICAL_VERTICAL_FILE;
}

// One row per format: which DB field holds the override, which file
// backs the fallback. `file` may be a resolver function when the file
// picked depends on runtime state (env flag for vertical).
const CANONICAL_TABLE = {
  feed:      { dbField: 'canonicalScript',          file: CANONICAL_FEED_FILE },
  vertical:  { dbField: 'canonicalScriptVertical',  file: verticalCanonicalFile },
  landscape: { dbField: 'canonicalScriptLandscape', file: CANONICAL_LANDSCAPE_FILE }
};

async function ensureSingleton() {
  let doc = await SystemConfig.findOne({ key: 'default' });
  if (doc) return doc;
  doc = await SystemConfig.create({ key: 'default' });
  return doc;
}

// Load one canonical variant by format. DB value wins when set;
// otherwise falls back to the bundled file.
async function loadCanonical(format) {
  const entry = CANONICAL_TABLE[format];
  if (!entry) {
    const e = new Error(`unknown canonical format: ${format}`);
    e.status = 400;
    throw e;
  }
  const cfg = await SystemConfig.findOne({ key: 'default' }).select(entry.dbField).lean();
  const dbValue = cfg?.[entry.dbField];
  if (dbValue && String(dbValue).trim()) {
    return { source: 'db', script: dbValue };
  }
  const filePath = typeof entry.file === 'function' ? entry.file() : entry.file;
  try {
    return { source: 'file', script: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    const e = new Error(`canonical script (${format}) not found in DB or at ${filePath}: ${err.message}`);
    e.status = 500;
    throw e;
  }
}

// Feed canonical (4:5 / 1:1). Preserves the legacy signature so existing
// callers keep working without change.
async function getCanonicalScript() {
  return loadCanonical('feed');
}

// Vertical canonical (9:16 — Reels, Shorts, Stories).
async function getCanonicalScriptVertical() {
  return loadCanonical('vertical');
}

// Landscape canonical (16:9 — pmax, YouTube pre-roll).
async function getCanonicalScriptLandscape() {
  return loadCanonical('landscape');
}

async function setCanonical(format, source, updatedBy = null) {
  const entry = CANONICAL_TABLE[format];
  if (!entry) {
    const e = new Error(`unknown canonical format: ${format}`);
    e.status = 400;
    throw e;
  }
  const doc = await ensureSingleton();
  doc[entry.dbField] = source || null;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

async function setCanonicalScript(source, updatedBy = null) {
  return setCanonical('feed', source, updatedBy);
}

async function setCanonicalScriptVertical(source, updatedBy = null) {
  return setCanonical('vertical', source, updatedBy);
}

async function setCanonicalScriptLandscape(source, updatedBy = null) {
  return setCanonical('landscape', source, updatedBy);
}

// ── Ad vision QC flag (tri-state, short TTL cache) ───────────────────
//
// Why a cache: the QC path can run once per static surface (meta_static =
// 3 surfaces × N products). A Mongo read per render is wasteful; a flip
// still must land without a process restart. 5s is short enough that an
// operator flip is felt on the next render cycle, long enough that a
// multi-surface product only hits Mongo once.
//
// Cache value is the raw tri-state: true | false | null.
// `null` means "DB has no override — caller falls through to env".
// `undefined` from peek means "never loaded in this process" — see
// peekAdVisionQcEnabled's doc comment below for why that is now the ONLY
// thing undefined means (it used to also mean "expired", which was a live
// production bug — CLAUDE.md / session notes 2026-08-20).

const AD_VISION_QC_CACHE_TTL_MS = 5000;

let _adVisionQcCache = {
  loaded: false,
  value: null,       // true | false | null when loaded
  expiresAt: 0
};
let _adVisionQcRefresh = null; // in-flight promise, if any

function resetAdVisionQcEnabledCache() {
  _adVisionQcCache = { loaded: false, value: null, expiresAt: 0 };
  _adVisionQcRefresh = null;
}

/**
 * Synchronous peek at the last LOADED value. Returns:
 *   true | false | null  — a real SystemConfig read has completed at least
 *                           once in this process (possibly stale past its
 *                           TTL — see below for why that is fine).
 *   undefined             — no SystemConfig read has EVER completed in this
 *                            process (true cold start). Caller falls through
 *                            to the env default, same as "no override set".
 *
 * FIXED 2026-08-20 — this used to also return `undefined` once `expiresAt`
 * elapsed, i.e. on almost every call in production: real renders are spaced
 * far more than 5s apart, so by the time the NEXT render asked, the TTL had
 * always already expired. The only caller of this function,
 * adVisionQcService.isEnabled(), calls `refreshAdVisionQcEnabledCache()` —
 * fire-and-forget — immediately before peeking, IN THE SAME synchronous
 * tick, so that refresh can never have landed yet. Gating the peek on
 * `expiresAt` therefore meant "I have not re-fetched THIS INSTANT" was read
 * as "unknown", and the caller fell through to the env default — silently
 * treating a merely-stale cache the same as never having read the DB at
 * all. Measured effect: SystemConfig.adVisionQcEnabled=true, but the sync
 * gate answered `false` on the large majority of real render calls.
 *
 * The fix: a value that has been loaded at least once is trusted until it
 * is explicitly reset or re-read — `expiresAt` still exists and still drives
 * `refreshAdVisionQcEnabledCache` below (that half of the TTL contract, "go
 * get a fresher answer in the background once stale", is unchanged). What
 * changed is only the SYNCHRONOUS answer handed back while that refresh is
 * in flight: a few-seconds-stale real DB value, not a manufactured
 * "unknown". A `resetAdVisionQcEnabledCache()` (e.g. right after
 * `setAdVisionQcEnabled`, which also write-throughs the new value
 * immediately) is what makes an operator flip felt without waiting on
 * staleness at all.
 *
 * FAIL-SAFE DIRECTION, decided deliberately: serving the last known real
 * value (even stale) is preferred over collapsing to the env default,
 * because QC existing to catch is a documented ~1-in-3 competitor-logo /
 * product-fidelity defect rate (CLAUDE.md §"Known open"), and an operator
 * who just turned the flag ON is trusting that decision to take effect —
 * silently failing OFF defeats the switch they just flipped. The ~$0.05/ad
 * QC cost the other direction could occasionally over-spend by (continuing
 * to run one extra check on a value that, unbeknownst to the stale cache,
 * had just been flipped OFF) is bounded and small next to that. This
 * reasoning does NOT extend to a truly cold cache (never loaded at all,
 * e.g. the first call after a process boot) — there we have no signal
 * whatsoever, not even a stale one, so `undefined` still falls through to
 * the pre-existing "no override configured" → env → default-false
 * precedence. That is not a staleness failure, it is genuine absence of
 * data, and the existing default-OFF-when-unconfigured contract is correct
 * for it.
 */
function peekAdVisionQcEnabled() {
  if (!_adVisionQcCache.loaded) return undefined;
  return _adVisionQcCache.value;
}

function _storeAdVisionQcCache(value) {
  _adVisionQcCache = {
    loaded: true,
    value: (value === true || value === false) ? value : null,
    expiresAt: Date.now() + AD_VISION_QC_CACHE_TTL_MS
  };
}

/**
 * Read SystemConfig.adVisionQcEnabled with a short TTL cache.
 * Returns true | false | null. Does not interpret env — that is the
 * caller's job (adVisionQcService.resolveEnabled).
 */
async function getAdVisionQcEnabled() {
  const now = Date.now();
  if (_adVisionQcCache.loaded && now < _adVisionQcCache.expiresAt) {
    return _adVisionQcCache.value;
  }
  const cfg = await SystemConfig.findOne({ key: 'default' })
    .select('adVisionQcEnabled')
    .lean();
  const raw = cfg ? cfg.adVisionQcEnabled : null;
  const value = (raw === true || raw === false) ? raw : null;
  _storeAdVisionQcCache(value);
  return value;
}

/**
 * Fire-and-forget cache refresh so sync callers (isEnabled) can stay
 * warm without awaiting Mongo on the render path. Errors are swallowed
 * — a failed refresh leaves the previous entry expired and the next
 * async get will retry.
 */
function refreshAdVisionQcEnabledCache() {
  if (_adVisionQcRefresh) return;
  if (_adVisionQcCache.loaded && Date.now() < _adVisionQcCache.expiresAt) return;
  _adVisionQcRefresh = getAdVisionQcEnabled()
    .catch(() => { /* fail-soft: leave cache unloaded */ })
    .finally(() => { _adVisionQcRefresh = null; });
}

/**
 * Persist the tri-state override. Pass null to clear (fall back to env).
 * Invalidates the TTL cache immediately so the next read sees the flip.
 */
async function setAdVisionQcEnabled(enabled, updatedBy = null) {
  if (enabled !== null && enabled !== true && enabled !== false) {
    const e = new Error('adVisionQcEnabled must be true, false, or null');
    e.status = 400;
    throw e;
  }
  const doc = await ensureSingleton();
  doc.adVisionQcEnabled = enabled;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  // Write-through so a same-process set is visible immediately, and so
  // a concurrent render does not briefly re-read the old value.
  _storeAdVisionQcCache(enabled);
  return doc;
}

module.exports = {
  ensureSingleton,
  getCanonicalScript,
  getCanonicalScriptVertical,
  getCanonicalScriptLandscape,
  setCanonicalScript,
  setCanonicalScriptVertical,
  setCanonicalScriptLandscape,
  getAdVisionQcEnabled,
  setAdVisionQcEnabled,
  peekAdVisionQcEnabled,
  refreshAdVisionQcEnabledCache,
  resetAdVisionQcEnabledCache,
  AD_VISION_QC_CACHE_TTL_MS,
  CANONICAL_FEED_FILE,
  CANONICAL_VERTICAL_FILE,
  CANONICAL_VERTICAL_DR_V1_FILE,
  CANONICAL_LANDSCAPE_FILE,
  verticalCanonicalFile,
  // Deprecated alias for the feed-only constant — kept for callers that
  // still reference it. New code should use CANONICAL_FEED_FILE.
  CANONICAL_FILE: CANONICAL_FEED_FILE
};
