// services/blockClassifier.js
//
// Pure, dependency-free vendor-aware bot-block classifier for scrape
// responses. No I/O. Used by httpScrapeClient (and headless CF detect)
// so a 403 is diagnosed as Cloudflare / Akamai / PX / DataDome / etc.
// instead of a generic "product pages failed validation".
//
// classifyBlock({ status, headers, bodyText, cookies }) → classification | null
// Returns null when the response is not a block.

'use strict';

// ── Exported marker tables / regexes (tests assert these) ───────────

/** Historical httpScrapeClient CF body sniff — keep byte-stable for cfChallenged back-compat. */
const CF_BODY_RE =
  /just a moment|__cf_chl|cdn-cgi\/challenge|cf-browser-verification|Attention Required/i;

const CF_COOKIE_NAMES = ['cf_clearance', '__cf_bm'];
const CF_STATUS = new Set([403, 503, 429]);

const AKAMAI_CUSTOM_DENY_RE = /\/_es_\/fo\/customdeny\//i;
const AKAMAI_ACCESS_DENIED_RE = /Access Denied/i;
/** fanatics-style Reference + RC / referenceId + rcId markers */
const AKAMAI_REF_RC_RE = /referenceId|rcId|Reference\s*<|RC\s*</i;
const AKAMAI_SERVER_RE = /AkamaiGHost/i;
const AKAMAI_HEADER_PREFIX = 'x-akamai-';

const PX_COOKIE_NAMES = ['_px3', '_pxvid', '_pxhd'];
const PX_BODY_RE = /_pxCaptcha|px-captcha/i;
const PX_HEADER = 'x-px-block-reason';

const DATADOME_COOKIE_NAMES = ['datadome'];
const DATADOME_BODY_RE = /geo\.captcha-delivery\.com|DataDome/i;
const DATADOME_HEADER = 'x-datadome';

const INCAPSULA_COOKIE_PREFIXES = ['visid_incap_', 'incap_ses_'];
const INCAPSULA_BODY_RE = /Incapsula incident ID/i;
const INCAPSULA_HEADER = 'x-iinfo';

// ── Header / cookie normalisation (never throws) ────────────────────

function normalizeHeaders(headers) {
  const map = new Map();
  if (headers == null) return map;
  try {
    if (typeof headers.forEach === 'function') {
      // Headers / Map
      headers.forEach((value, key) => {
        if (key == null) return;
        map.set(String(key).toLowerCase(), value == null ? '' : String(value));
      });
      return map;
    }
    if (typeof headers.get === 'function' && typeof headers.keys === 'function') {
      for (const key of headers.keys()) {
        if (key == null) continue;
        let value;
        try {
          value = headers.get(key);
        } catch {
          value = '';
        }
        map.set(String(key).toLowerCase(), value == null ? '' : String(value));
      }
      return map;
    }
    if (typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (key == null) continue;
        const value = headers[key];
        const str =
          value == null
            ? ''
            : Array.isArray(value)
              ? value.map((v) => (v == null ? '' : String(v))).join(', ')
              : String(value);
        map.set(String(key).toLowerCase(), str);
      }
    }
  } catch {
    // never throw on malformed input
  }
  return map;
}

function headerHas(map, name) {
  return map.has(String(name).toLowerCase());
}

function headerGet(map, name) {
  return map.get(String(name).toLowerCase());
}

function headerHasPrefix(map, prefix) {
  const p = String(prefix).toLowerCase();
  for (const key of map.keys()) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

/**
 * cookies may be:
 *   - array of cookie names, or "name=value" / Set-Cookie segments
 *   - raw Set-Cookie string
 *   - undefined
 */
function normalizeCookieNames(cookies) {
  const names = new Set();
  if (cookies == null) return names;
  try {
    if (Array.isArray(cookies)) {
      for (const c of cookies) {
        if (c == null) continue;
        if (typeof c === 'string') {
          // Set-Cookie line or bare name
          const first = c.split(';')[0] || '';
          const name = first.split('=')[0].trim();
          if (name) names.add(name);
        } else if (typeof c === 'object' && c.name != null) {
          names.add(String(c.name));
        }
      }
      return names;
    }
    if (typeof cookies === 'string') {
      // One or more Set-Cookie lines (joined) or Cookie request header.
      // Split on commas that look like cookie-pair boundaries, then ';'.
      const segments = cookies.split(/,(?=\s*[^;,\s]+=)/);
      for (const seg of segments) {
        const first = seg.split(';')[0] || '';
        const name = first.split('=')[0].trim();
        if (name) names.add(name);
      }
    }
  } catch {
    // never throw
  }
  return names;
}

function cookieHas(names, want) {
  if (names.has(want)) return true;
  // case-insensitive fallback
  const lower = want.toLowerCase();
  for (const n of names) {
    if (String(n).toLowerCase() === lower) return true;
  }
  return false;
}

function cookieHasPrefix(names, prefix) {
  const p = prefix.toLowerCase();
  for (const n of names) {
    if (String(n).toLowerCase().startsWith(p)) return true;
  }
  return false;
}

// ── Per-vendor detectors ────────────────────────────────────────────

function detectCloudflare(status, headerMap, bodyText, cookieNames) {
  if (!CF_STATUS.has(status)) return null;
  const signals = [];

  if (headerHas(headerMap, 'cf-mitigated')) {
    signals.push('header:cf-mitigated');
  }
  if (bodyText && CF_BODY_RE.test(bodyText)) {
    // name which body markers hit (short tokens)
    if (/just a moment/i.test(bodyText)) signals.push('body:just a moment');
    if (/__cf_chl/i.test(bodyText)) signals.push('body:__cf_chl');
    if (/cdn-cgi\/challenge/i.test(bodyText)) signals.push('body:cdn-cgi/challenge');
    if (/cf-browser-verification/i.test(bodyText)) signals.push('body:cf-browser-verification');
    if (/Attention Required/i.test(bodyText)) signals.push('body:Attention Required');
    // fallback if RE matched a future alt that we didn't name
    if (!signals.some((s) => s.startsWith('body:'))) signals.push('body:CF_BODY_RE');
  }
  for (const name of CF_COOKIE_NAMES) {
    if (cookieHas(cookieNames, name)) signals.push(`cookie:${name}`);
  }

  if (!signals.length) return null;
  const confidence = signals.some((s) => s === 'header:cf-mitigated') ? 'high' : 'medium';
  return {
    vendor: 'cloudflare',
    confidence,
    remedy: 'browser-session',
    signals
  };
}

function detectAkamai(headerMap, bodyText) {
  const signals = [];
  let high = false;

  if (bodyText) {
    const accessDenied = AKAMAI_ACCESS_DENIED_RE.test(bodyText);
    if (accessDenied) {
      if (AKAMAI_CUSTOM_DENY_RE.test(bodyText)) {
        signals.push('body:Access Denied');
        signals.push('body:/_es_/fo/customdeny/');
        high = true;
      } else if (/reference/i.test(bodyText) && AKAMAI_REF_RC_RE.test(bodyText)) {
        signals.push('body:Access Denied');
        signals.push('body:reference+rcId');
      }
    }
  }

  const server = headerGet(headerMap, 'server');
  if (server && AKAMAI_SERVER_RE.test(server)) {
    signals.push('header:server:AkamaiGHost');
  }
  if (headerHasPrefix(headerMap, AKAMAI_HEADER_PREFIX)) {
    signals.push('header:x-akamai-*');
  }

  if (!signals.length) return null;
  return {
    vendor: 'akamai',
    confidence: high ? 'high' : 'medium',
    remedy: 'needs-unblocker',
    signals
  };
}

function detectPerimeterX(headerMap, bodyText, cookieNames) {
  const signals = [];
  for (const name of PX_COOKIE_NAMES) {
    if (cookieHas(cookieNames, name)) signals.push(`cookie:${name}`);
  }
  if (bodyText && PX_BODY_RE.test(bodyText)) {
    if (/_pxCaptcha/i.test(bodyText)) signals.push('body:_pxCaptcha');
    if (/px-captcha/i.test(bodyText)) signals.push('body:px-captcha');
  }
  if (headerHas(headerMap, PX_HEADER)) {
    signals.push(`header:${PX_HEADER}`);
  }
  if (!signals.length) return null;
  return {
    vendor: 'perimeterx',
    confidence: 'medium',
    remedy: 'browser-session-then-proxy',
    signals
  };
}

function detectDatadome(headerMap, bodyText, cookieNames) {
  const signals = [];
  for (const name of DATADOME_COOKIE_NAMES) {
    if (cookieHas(cookieNames, name)) signals.push(`cookie:${name}`);
  }
  if (bodyText && DATADOME_BODY_RE.test(bodyText)) {
    if (/geo\.captcha-delivery\.com/i.test(bodyText)) {
      signals.push('body:geo.captcha-delivery.com');
    }
    if (/DataDome/i.test(bodyText)) signals.push('body:DataDome');
  }
  if (headerHas(headerMap, DATADOME_HEADER)) {
    signals.push(`header:${DATADOME_HEADER}`);
  }
  if (!signals.length) return null;
  return {
    vendor: 'datadome',
    confidence: 'medium',
    remedy: 'browser-session-then-proxy',
    signals
  };
}

function detectIncapsula(headerMap, bodyText, cookieNames) {
  const signals = [];
  for (const prefix of INCAPSULA_COOKIE_PREFIXES) {
    if (cookieHasPrefix(cookieNames, prefix)) {
      signals.push(`cookie:${prefix}*`);
    }
  }
  if (bodyText && INCAPSULA_BODY_RE.test(bodyText)) {
    signals.push('body:Incapsula incident ID');
  }
  if (headerHas(headerMap, INCAPSULA_HEADER)) {
    signals.push(`header:${INCAPSULA_HEADER}`);
  }
  if (!signals.length) return null;
  return {
    vendor: 'incapsula',
    confidence: 'medium',
    remedy: 'browser-session-then-proxy',
    signals
  };
}

/**
 * classifyBlock({ status, headers, bodyText, cookies }) → BlockClassification | null
 *
 * First confident vendor wins; a specific vendor always beats generic-403.
 * Returns null for 2xx/3xx and for plain 5xx that are not 503+Retry-After
 * and carry no vendor marker.
 */
function classifyBlock(input) {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const status = Number(opts.status);
    const headerMap = normalizeHeaders(opts.headers);
    const bodyText =
      opts.bodyText == null || opts.bodyText === undefined
        ? ''
        : String(opts.bodyText);
    const cookieNames = normalizeCookieNames(opts.cookies);

    // Non-finite / missing status: still allow vendor body/header detection
    // only when we have a block-ish status; otherwise null.
    const statusOk = Number.isFinite(status);

    // 2xx / 3xx are never blocks (even with CF cookies sitting on a 200).
    if (statusOk && status >= 200 && status < 400) return null;

    // Ordered vendor cascade — first match wins.
    if (statusOk) {
      const cf = detectCloudflare(status, headerMap, bodyText, cookieNames);
      if (cf) return cf;
    }

    // Remaining vendors: any non-2xx/3xx status (incl. missing treated below).
    // For missing/0 status, only fire if vendor markers are strong — but
    // callers always pass a real status from _doFetch. Keep defensive.
    const allowVendor =
      !statusOk || status === 0 || status === 401 || status === 403 ||
      status === 429 || status === 503 || status >= 400;

    if (allowVendor) {
      const akamai = detectAkamai(headerMap, bodyText);
      if (akamai) return akamai;

      const px = detectPerimeterX(headerMap, bodyText, cookieNames);
      if (px) return px;

      const dd = detectDatadome(headerMap, bodyText, cookieNames);
      if (dd) return dd;

      const inc = detectIncapsula(headerMap, bodyText, cookieNames);
      if (inc) return inc;
    }

    // rate-limited: 429, or 503 + Retry-After with no vendor marker above
    if (statusOk && status === 429) {
      return {
        vendor: 'rate-limited',
        confidence: 'high',
        remedy: 'backoff-retry',
        signals: ['status:429']
      };
    }
    if (statusOk && status === 503 && headerHas(headerMap, 'retry-after')) {
      return {
        vendor: 'rate-limited',
        confidence: 'high',
        remedy: 'backoff-retry',
        signals: ['status:503', 'header:retry-after']
      };
    }

    // generic-403: 401/403 with nothing above matched
    if (statusOk && (status === 401 || status === 403)) {
      return {
        vendor: 'generic-403',
        confidence: 'low',
        remedy: 'needs-unblocker',
        signals: [`status:${status}`]
      };
    }

    // Plain 5xx (not 503+Retry-After) / other codes → not a bot block
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  classifyBlock,
  // marker tables / regexes for harnesses
  CF_BODY_RE,
  CF_COOKIE_NAMES,
  CF_STATUS,
  AKAMAI_CUSTOM_DENY_RE,
  AKAMAI_ACCESS_DENIED_RE,
  AKAMAI_REF_RC_RE,
  AKAMAI_SERVER_RE,
  PX_COOKIE_NAMES,
  PX_BODY_RE,
  DATADOME_COOKIE_NAMES,
  DATADOME_BODY_RE,
  INCAPSULA_COOKIE_PREFIXES,
  INCAPSULA_BODY_RE,
  // helpers (optional test surface)
  normalizeHeaders,
  normalizeCookieNames
};
