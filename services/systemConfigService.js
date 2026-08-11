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
// `undefined` from peek means "cache miss / expired — do not invent null".

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
 * Synchronous peek at the TTL cache. Returns:
 *   true | false | null  when a fresh entry is loaded
 *   undefined            on cache miss or expiry (caller must not treat as null)
 */
function peekAdVisionQcEnabled() {
  if (!_adVisionQcCache.loaded) return undefined;
  if (Date.now() >= _adVisionQcCache.expiresAt) return undefined;
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
