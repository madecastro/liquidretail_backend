// services/scrapeSession.js
//
// Per-HOST scrape session cache for replaying a browser-cleared
// Cloudflare (etc.) clearance on the cheap HTTP path.
//
// KEYING: exact scheme+host+port (URL.origin), NOT brand origin and NOT
// eTLD+1. Measured on fanatics.com: sitemaps live on S3 under
// www.fanatics.com while product URLs live on portal.fanatics.com — a
// session harvested for one host must not silently apply to the other.
//
// TTL: SCRAPE_SESSION_TTL_MS default 600000 (10 min). Cloudflare's
// cf_clearance duration is UNDOCUMENTED — 10 min is a conservative guess
// so a stale cookie is dropped rather than endlessly re-challenged.
//
// In-memory / per-process only — same limitation as pacedModelSubmit.
// A multi-instance deploy does not share sessions across processes.
//
// CRITICAL: harvest MUST use Puppeteer page.cookies(origin) (CDP
// Network.getCookies). document.cookie cannot see HttpOnly cookies
// (cf_clearance, __cf_bm) — measured on ubeauty.com: 78 names visible
// to JS and NEITHER of the two that matter. A document.cookie harvest
// looks large and plausible and fails every replay.

'use strict';

const { CF_COOKIE_NAMES } = require('./blockClassifier');

const DEFAULT_TTL_MS = 600000; // 10 min — guess; CF clearance is undocumented
const DEFAULT_MAX_REFRESH = 3;
const LRU_CAP = 50;

// ── env ────────────────────────────────────────────────────────────

function sessionReuseEnabled() {
  // Default ON — the whole point of the browser rung. Flag-off must be
  // byte-identical on the HTTP path (session never applied).
  return String(process.env.SCRAPE_SESSION_REUSE_ENABLED || 'true').toLowerCase() !== 'false';
}

function sessionTtlMs() {
  const n = parseInt(process.env.SCRAPE_SESSION_TTL_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function sessionMaxRefresh() {
  const n = parseInt(process.env.SCRAPE_SESSION_MAX_REFRESH, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_REFRESH;
}

// ── origin keying (exact host, no eTLD+1 widening) ─────────────────

/**
 * originKey(urlOrOrigin) → 'https://www.fanatics.com' | null
 * scheme+host+port only. www and portal are DIFFERENT keys.
 */
function originKey(urlOrOrigin) {
  if (!urlOrOrigin) return null;
  try {
    const s = String(urlOrOrigin).trim();
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

// ── cookie helpers ─────────────────────────────────────────────────

function parseCookieNames(cookieHeader) {
  const names = new Set();
  if (!cookieHeader || typeof cookieHeader !== 'string') return names;
  for (const part of cookieHeader.split(';')) {
    const name = part.split('=')[0].trim();
    if (name) names.add(name);
  }
  return names;
}

/**
 * A usable CF-style clearance must include at least one HttpOnly
 * cookie that document.cookie cannot see. Without this gate, a
 * document.cookie harvest (dozens of names, zero clearance) would
 * cache as "valid" and every HTTP replay would re-challenge.
 */
function hasClearanceCookies(cookieHeader) {
  const names = parseCookieNames(cookieHeader);
  for (const want of CF_COOKIE_NAMES) {
    if (names.has(want)) return true;
    // case-insensitive fallback
    const lower = want.toLowerCase();
    for (const n of names) {
      if (String(n).toLowerCase() === lower) return true;
    }
  }
  return false;
}

/**
 * Vendor-aware usability. Cloudflare (and unknown/default after a CF
 * clear) require cf_clearance/__cf_bm. Other vendors require a non-empty
 * Cookie header (their own tokens differ).
 */
function cookiesUsableForVendor(cookieHeader, vendor) {
  if (!cookieHeader || !String(cookieHeader).trim()) return false;
  const v = vendor == null ? 'cloudflare' : String(vendor).toLowerCase();
  if (
    v === 'cloudflare' ||
    v === 'unknown' ||
    v === '' ||
    v === 'browser-session'
  ) {
    return hasClearanceCookies(cookieHeader);
  }
  // perimeterx / datadome / incapsula — non-empty is enough for validity
  // shape; the harvest path still prefers real vendor cookies when present.
  return true;
}

// ── ScrapeSession ──────────────────────────────────────────────────

class ScrapeSession {
  /**
   * @param {object} opts
   * @param {string} opts.origin - scheme+host+port
   * @param {string} opts.cookieHeader - Cookie request header value
   * @param {string} opts.userAgent - MUST match the UA that cleared CF
   * @param {string} [opts.acceptLanguage]
   * @param {number} [opts.capturedAt] - ms epoch
   * @param {string} [opts.vendor] - e.g. 'cloudflare'
   * @param {() => number} [opts.now] - injectable clock for tests
   */
  constructor({
    origin,
    cookieHeader,
    userAgent,
    acceptLanguage = 'en-US,en;q=0.9',
    capturedAt = null,
    vendor = 'cloudflare',
    now = null
  } = {}) {
    this.origin = originKey(origin) || origin || null;
    this.cookieHeader = cookieHeader != null ? String(cookieHeader) : '';
    this.userAgent = userAgent != null ? String(userAgent) : '';
    this.acceptLanguage = acceptLanguage != null
      ? String(acceptLanguage)
      : 'en-US,en;q=0.9';
    this.capturedAt = capturedAt != null ? Number(capturedAt) : Date.now();
    this.vendor = vendor || 'cloudflare';
    this.refreshCount = 0;
    this.refreshInFlight = null;
    this._now = typeof now === 'function' ? now : null;
  }

  _clock() {
    return this._now ? this._now() : Date.now();
  }

  isValid() {
    if (!this.origin) return false;
    if (!this.userAgent || !String(this.userAgent).trim()) return false;
    if (!Number.isFinite(this.capturedAt)) return false;
    if (this._clock() - this.capturedAt > sessionTtlMs()) return false;
    if (!cookiesUsableForVendor(this.cookieHeader, this.vendor)) return false;
    return true;
  }

  /**
   * Headers to merge into an HTTP scrape request. Caller must still pin
   * User-Agent to this.userAgent (httpScrapeClient does when session is
   * supplied). Cookie + Accept-Language only here.
   */
  toHeaders() {
    const h = {};
    if (this.cookieHeader) h.Cookie = this.cookieHeader;
    if (this.acceptLanguage) h['Accept-Language'] = this.acceptLanguage;
    return h;
  }

  /**
   * refresh(harvestFn) → Promise<boolean>
   *
   * N concurrent callers share ONE in-flight harvest (refreshInFlight).
   * refreshCount is capped by SCRAPE_SESSION_MAX_REFRESH so a host that
   * blocks even a fresh browser session falls through instead of
   * relaunching Chrome forever.
   *
   * harvestFn() → { cookieHeader, userAgent, acceptLanguage?, vendor? }
   * or null on failure. Does NOT launch the browser itself — the caller
   * supplies the harvest (usually headlessScrapeService.harvestSession).
   */
  async refresh(harvestFn) {
    if (typeof harvestFn !== 'function') return false;
    if (this.refreshCount >= sessionMaxRefresh()) return false;
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const data = await harvestFn();
        if (!data || typeof data !== 'object') return false;
        const cookieHeader =
          data.cookieHeader != null ? String(data.cookieHeader) : '';
        const userAgent =
          data.userAgent != null ? String(data.userAgent) : this.userAgent;
        const vendor = data.vendor != null ? data.vendor : this.vendor;
        if (!cookiesUsableForVendor(cookieHeader, vendor)) return false;
        if (!userAgent || !String(userAgent).trim()) return false;

        this.cookieHeader = cookieHeader;
        this.userAgent = userAgent;
        if (data.acceptLanguage != null) {
          this.acceptLanguage = String(data.acceptLanguage);
        }
        this.vendor = vendor;
        this.capturedAt = this._clock();
        this.refreshCount += 1;
        return true;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }
}

// ── module-level LRU Map ───────────────────────────────────────────

/** @type {Map<string, ScrapeSession>} */
const _cache = new Map();

function _touch(key, session) {
  // Re-insert to mark most-recently-used (Map insertion order).
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, session);
  while (_cache.size > LRU_CAP) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * getSession(origin) → ScrapeSession | null
 * Returns a still-valid cached session for the exact origin, or null.
 */
function getSession(origin) {
  const key = originKey(origin);
  if (!key) return null;
  const s = _cache.get(key);
  if (!s) return null;
  if (!s.isValid()) {
    _cache.delete(key);
    return null;
  }
  _touch(key, s);
  return s;
}

/**
 * putSession(fields) → ScrapeSession | null
 * Caches only when the harvest is usable (clearance cookies present for
 * CF). Rejects the document.cookie trap rather than caching it.
 */
function putSession(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const key = originKey(fields.origin);
  if (!key) return null;
  const session = new ScrapeSession({ ...fields, origin: key });
  if (!session.isValid()) return null;
  _touch(key, session);
  return session;
}

/**
 * getOrCreateSession(fields) → ScrapeSession | null
 * Returns a valid cached session if present; otherwise putSession.
 */
function getOrCreateSession(fields) {
  const key = originKey(fields && fields.origin);
  if (!key) return null;
  const existing = getSession(key);
  if (existing) return existing;
  return putSession(fields);
}

/** Test / ops: drop one host or clear all. */
function clearSession(origin) {
  if (origin == null) {
    _cache.clear();
    return;
  }
  const key = originKey(origin);
  if (key) _cache.delete(key);
}

function sessionCacheSize() {
  return _cache.size;
}

module.exports = {
  ScrapeSession,
  originKey,
  getSession,
  putSession,
  getOrCreateSession,
  clearSession,
  sessionCacheSize,
  sessionReuseEnabled,
  sessionTtlMs,
  sessionMaxRefresh,
  hasClearanceCookies,
  cookiesUsableForVendor,
  parseCookieNames,
  // constants for harnesses
  DEFAULT_TTL_MS,
  DEFAULT_MAX_REFRESH,
  LRU_CAP,
  CF_COOKIE_NAMES
};
