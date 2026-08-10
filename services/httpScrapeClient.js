// services/httpScrapeClient.js
//
// Shared polite HTTP client for scraping external customer sites.
// Centralizes UA rotation, per-domain throttle, CF/429 handling,
// robots.txt checks, and conditional GET for all site scrapers
// (shopifyAccessResolver, headlessScrapeService, and future
// consolidation of shopifyPublicIngestService /
// productCategoryInferenceService).
//
// Node 18+ global fetch — no extra deps.
//
// Assumptions:
// - global fetch + AbortController available (Node 18+)
// - env HTTP_SCRAPE_DOMAIN_CONCURRENCY (default 3)
// - env HTTP_SCRAPE_MIN_GAP_MS (default 250)

'use strict';

const { classifyBlock, CF_BODY_RE } = require('./blockClassifier');

const FROM_HEADER = 'crawler@reach-social.io';

const DOMAIN_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.HTTP_SCRAPE_DOMAIN_CONCURRENCY || '3', 10) || 3
);
const MIN_GAP_MS = Math.max(
  0,
  parseInt(process.env.HTTP_SCRAPE_MIN_GAP_MS || '250', 10) || 250
);

// Realistic desktop browser UAs — many e-commerce hosts (Cloudflare-
// protected Shopify stores in particular) serve a managed-challenge
// page to generic bot UAs. Rotate so a single fingerprint doesn't
// stick. From header still identifies us.
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

let _uaIdx = 0;
function pickUA() {
  const ua = UA_POOL[_uaIdx % UA_POOL.length];
  _uaIdx = (_uaIdx + 1) % UA_POOL.length;
  return ua;
}

// ── Per-domain concurrency + min-gap throttle ────────────────────────
// Modelled on productCategoryInferenceService.throttledFetch's
// inFlightByDomain approach, generalized with an explicit wait queue
// and a minimum gap between slot releases per domain.

const inFlightByDomain = new Map(); // domain -> number
const queueByDomain = new Map();    // domain -> [{ resolve }]
const lastReleaseByDomain = new Map(); // domain -> timestamp ms

function _domainOf(url) {
  return new URL(url).hostname;
}

function _enqueue(domain) {
  return new Promise((resolve) => {
    const q = queueByDomain.get(domain) || [];
    q.push({ resolve });
    queueByDomain.set(domain, q);
  });
}

function _tryDrain(domain) {
  const q = queueByDomain.get(domain) || [];
  if (!q.length) return;
  const inFlight = inFlightByDomain.get(domain) || 0;
  if (inFlight >= DOMAIN_CONCURRENCY) return;

  const now = Date.now();
  const last = lastReleaseByDomain.get(domain) || 0;
  const wait = Math.max(0, MIN_GAP_MS - (now - last));

  // Schedule drain after gap; only one timer path needed — next caller
  // will re-check. We claim the slot immediately when wait is 0.
  if (wait > 0) {
    setTimeout(() => _tryDrain(domain), wait + 1);
    return;
  }

  const next = q.shift();
  if (!q.length) queueByDomain.delete(domain);
  else queueByDomain.set(domain, q);

  inFlightByDomain.set(domain, inFlight + 1);
  next.resolve();
}

async function acquireDomainSlot(url) {
  const domain = _domainOf(url);
  const inFlight = inFlightByDomain.get(domain) || 0;
  if (inFlight < DOMAIN_CONCURRENCY) {
    const now = Date.now();
    const last = lastReleaseByDomain.get(domain) || 0;
    const wait = Math.max(0, MIN_GAP_MS - (now - last));
    if (wait === 0) {
      inFlightByDomain.set(domain, inFlight + 1);
      return domain;
    }
    // Gap not elapsed — fall through to queue so ordering stays fair.
  }
  const waited = _enqueue(domain);
  // Kick drain in case we can run after gap (or immediately if slot free).
  _tryDrain(domain);
  await waited;
  return domain;
}

function releaseDomainSlot(domain) {
  lastReleaseByDomain.set(domain, Date.now());
  const inFlight = Math.max(0, (inFlightByDomain.get(domain) || 0) - 1);
  if (inFlight === 0) inFlightByDomain.delete(domain);
  else inFlightByDomain.set(domain, inFlight);

  if (MIN_GAP_MS > 0) {
    setTimeout(() => _tryDrain(domain), MIN_GAP_MS);
  } else {
    _tryDrain(domain);
  }
}

// ── robots.txt cache ─────────────────────────────────────────────────
// Map keyed by origin → { rules, fetchedAt }. 1h TTL. FAIL-OPEN.

const ROBOTS_TTL_MS = 60 * 60 * 1000;
const robotsCache = new Map();

function _parseRobots(text) {
  // rules: Array<{ agents: string[], disallows: string[] }>
  const groups = [];
  let cur = null;

  const lines = String(text || '').split(/\r?\n/);
  for (let raw of lines) {
    // Strip comments
    const hash = raw.indexOf('#');
    if (hash !== -1) raw = raw.slice(0, hash);
    raw = raw.trim();
    if (!raw) continue;

    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const key = raw.slice(0, colon).trim().toLowerCase();
    const val = raw.slice(colon + 1).trim();

    if (key === 'user-agent') {
      const agent = val.toLowerCase();
      // If current group already has rules, start a new group;
      // consecutive User-agent lines share one group.
      if (!cur || cur.disallows.length > 0 || cur.allows.length > 0) {
        cur = { agents: [agent], disallows: [], allows: [] };
        groups.push(cur);
      } else {
        cur.agents.push(agent);
      }
    } else if (key === 'disallow') {
      if (!cur) {
        cur = { agents: ['*'], disallows: [], allows: [] };
        groups.push(cur);
      }
      // Empty Disallow means allow all — skip adding.
      if (val) cur.disallows.push(val);
    } else if (key === 'allow') {
      if (!cur) {
        cur = { agents: ['*'], disallows: [], allows: [] };
        groups.push(cur);
      }
      // Allow exceptions carve holes in broader Disallow rules.
      if (val) cur.allows.push(val);
    }
    // Crawl-delay / Sitemap intentionally ignored.
  }
  return groups;
}

function _pathDisallowed(rules, userAgent, pathname) {
  const ua = String(userAgent || '*').toLowerCase();
  // Collect matching groups: exact UA match preferred over '*'.
  let matched = rules.filter(g => g.agents.includes(ua));
  if (!matched.length) {
    matched = rules.filter(g => g.agents.includes('*'));
  }
  if (!matched.length) return false;

  // Longest-match wins; an Allow at least as specific as the longest
  // matching Disallow permits the path (standard robots precedence). Without
  // this, "Disallow: /" + "Allow: /products.json" would falsely deny the
  // explicitly-allowed path.
  let longestDis = '';
  let longestAllow = '';
  for (const g of matched) {
    for (const d of g.disallows) {
      if (d && pathname.startsWith(d) && d.length > longestDis.length) longestDis = d;
    }
    for (const a of (g.allows || [])) {
      if (a && pathname.startsWith(a) && a.length > longestAllow.length) longestAllow = a;
    }
  }
  if (!longestDis) return false;
  if (longestAllow.length >= longestDis.length) return false;
  return true;
}

// ── robots posture, system-wide ─────────────────────────────────────
//
// EVERY scrape this platform performs — catalog ingest, reviews, lifestyle
// imagery, enrichment — runs against storefronts the client has authorised
// under the engagement agreement, which also makes the client responsible for
// the legality of what ends up in a finished ad. So robots.txt is NOT treated
// as an access gate by default: it is a crawler-etiquette file, and we are
// operating with the site owner's permission rather than as an anonymous
// crawler.
//
// Set RESPECT_ROBOTS=true to restore gating for a deployment that needs it
// (e.g. prospecting a site before a contract is signed). Read at CALL time so
// the posture can change without a restart.
//
// WHAT IS DELIBERATELY NOT DISABLED: per-host throttling, the concurrency cap
// and Crawl-delay parsing (see parseRobotsForSitemaps / the pacing in
// _doFetch). Those exist to avoid degrading the client's own storefront and are
// a matter of not harming the site, not of permission. Removing them would put
// a client's site at risk, so they stay regardless of this flag.
function respectsRobots() {
  return process.env.RESPECT_ROBOTS === 'true';
}

async function isAllowedByRobots(url, { userAgent = '*' } = {}) {
  // Authorised-scraping posture: allow without fetching robots.txt at all,
  // which also saves a request per new host.
  if (!respectsRobots()) return true;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`isAllowedByRobots: bad URL: ${url}`);
  }

  const origin = parsed.origin;
  const now = Date.now();
  let entry = robotsCache.get(origin);

  if (!entry || now - entry.fetchedAt > ROBOTS_TTL_MS) {
    try {
      const robotsUrl = `${origin}/robots.txt`;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      let res;
      try {
        res = await fetch(robotsUrl, {
          method: 'GET',
          redirect: 'follow',
          signal: ac.signal,
          headers: {
            'User-Agent': pickUA(),
            From: FROM_HEADER,
            Accept: 'text/plain,*/*'
          }
        });
      } finally {
        clearTimeout(t);
      }

      if (!res.ok) {
        // FAIL-OPEN
        entry = { rules: [], fetchedAt: now };
      } else {
        const text = await res.text();
        entry = { rules: _parseRobots(text), fetchedAt: now };
      }
    } catch {
      // FAIL-OPEN on network/timeout
      entry = { rules: [], fetchedAt: now };
    }
    robotsCache.set(origin, entry);
  }

  if (!entry.rules || !entry.rules.length) return true;
  return !_pathDisallowed(entry.rules, userAgent, parsed.pathname || '/');
}

// ── CF / rate-limit helpers ──────────────────────────────────────────
// CF_BODY_RE lives in blockClassifier (single source of truth).
// cfChallenged back-compat: status 403/503 + body markers ONLY — header/
// cookie CF signals are exposed on `block` but must not flip cfChallenged.

function _isCfChallenged(status, bodyText) {
  if (status !== 403 && status !== 503) return false;
  if (!bodyText) return false;
  return CF_BODY_RE.test(bodyText);
}

function _setCookieList(headers) {
  if (!headers) return undefined;
  try {
    if (typeof headers.getSetCookie === 'function') {
      const list = headers.getSetCookie();
      return Array.isArray(list) && list.length ? list : undefined;
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = headers.get ? headers.get('set-cookie') : headers['set-cookie'];
    return raw == null || raw === '' ? undefined : raw;
  } catch {
    return undefined;
  }
}

function _parseRetryAfter(h) {
  if (!h) return null;
  const raw = h.get ? h.get('retry-after') : h['retry-after'];
  if (raw == null || raw === '') return null;
  const asInt = parseInt(String(raw).trim(), 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt;
  // HTTP-date form — convert to seconds from now
  const when = Date.parse(String(raw));
  if (!Number.isNaN(when)) {
    return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  }
  return null;
}

function _headerPick(h, name) {
  if (!h) return null;
  const v = h.get ? h.get(name) : h[name];
  return v == null || v === '' ? null : String(v);
}

// Full lowercase header map for platform fingerprinting (siteFingerprintService).
// The projection fields below stay for existing callers; `raw` is additive.
function _rawHeaderMap(h) {
  const out = Object.create(null);
  if (!h) return out;
  try {
    if (typeof h.forEach === 'function') {
      h.forEach((value, key) => {
        if (key == null) return;
        out[String(key).toLowerCase()] = value == null ? '' : String(value);
      });
      return out;
    }
  } catch { /* fall through */ }
  try {
    if (typeof h === 'object') {
      for (const k of Object.keys(h)) {
        const v = h[k];
        if (v == null || typeof v === 'object') continue;
        out[String(k).toLowerCase()] = String(v);
      }
    }
  } catch { /* empty */ }
  return out;
}

function _resultHeaders(h) {
  return {
    etag: _headerPick(h, 'etag'),
    lastModified: _headerPick(h, 'last-modified'),
    retryAfter: _parseRetryAfter(h),
    contentType: _headerPick(h, 'content-type'),
    // Additive: full map so generic-catalog auto-detect can read
    // powered-by / x-shopid / x-shopify-stage without a second request.
    raw: _rawHeaderMap(h)
  };
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Lenient JSON parse — on failure strip trailing commas and retry once.
function _parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Strip trailing commas before } or ]
    const repaired = String(text).replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(repaired);
  }
}

// Read a fetch Response body with a running byte cap. Streams via
// res.body when available (real Node fetch) and aborts the moment the cap
// is exceeded, so an absent or understated Content-Length can't buffer a
// multi-hundred-MB payload into memory and OOM the process. Falls back to
// arrayBuffer() for non-stream bodies (test stubs, empty responses).
async function _readBodyCapped(res, maxBytes, ac) {
  const cap = maxBytes == null ? Infinity : maxBytes;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;
        total += value.byteLength;
        if (total > cap) {
          try { await reader.cancel(); } catch { /* ignore */ }
          try { ac && ac.abort(); } catch { /* ignore */ }
          return { tooLarge: true, buffer: null };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock && reader.releaseLock(); } catch { /* ignore */ }
    }
    return { tooLarge: false, buffer: Buffer.concat(chunks, total) };
  }

  // Fallback: no streamable body — buffer whole, then check.
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > cap) return { tooLarge: true, buffer: null };
  return { tooLarge: false, buffer: buf };
}

// ── Core fetch (single attempt) ──────────────────────────────────────

async function _doFetch(url, {
  timeoutMs,
  headers,
  etag,
  lastModified,
  maxBytes,
  asBuffer,
  method = 'GET',
  body = null
}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`httpScrapeClient: bad URL: ${url}`);
  }
  // silence unused in non-throw path
  void parsed;

  const ua = headers['User-Agent'] || headers['user-agent'] || pickUA();
  const reqHeaders = {
    Accept: asBuffer
      ? '*/*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    From: FROM_HEADER,
    ...headers,
    'User-Agent': ua
  };

  if (etag) reqHeaders['If-None-Match'] = etag;
  if (lastModified) reqHeaders['If-Modified-Since'] = lastModified;

  // Arm the timeout only AFTER we hold the domain slot, so queue-wait time
  // never counts against the HTTP budget — on a busy domain (concurrency 1
  // + a long in-flight hold) the request would otherwise abort with a false
  // "timeout" before the round-trip even started.
  const domain = await acquireDomainSlot(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: ac.signal,
        headers: reqHeaders,
        ...(body != null ? { body } : {})
      });
    } catch (err) {
      const msg =
        err && err.name === 'AbortError'
          ? `timeout after ${timeoutMs}ms`
          : err && err.message
            ? err.message
            : String(err);
      return {
        status: 0,
        ok: false,
        text: asBuffer ? undefined : '',
        buffer: asBuffer ? null : undefined,
        json: undefined,
        headers: { etag: null, lastModified: null, retryAfter: null, contentType: null },
        notModified: false,
        cfChallenged: false,
        rateLimited: false,
        tooLarge: false,
        block: null,
        error: msg
      };
    }

    const status = res.status;
    const outHeaders = _resultHeaders(res.headers);
    const setCookies = _setCookieList(res.headers);

    // 304 conditional GET
    if (status === 304) {
      return {
        status,
        ok: true,
        text: asBuffer ? undefined : '',
        buffer: asBuffer ? Buffer.alloc(0) : undefined,
        headers: outHeaders,
        notModified: true,
        cfChallenged: false,
        rateLimited: false,
        tooLarge: false,
        block: null
      };
    }

    // content-length pre-check
    const clRaw = _headerPick(res.headers, 'content-length');
    if (clRaw != null && maxBytes != null) {
      const cl = parseInt(clRaw, 10);
      if (Number.isFinite(cl) && cl > maxBytes) {
        // Consume/cancel body so the socket can close.
        try { res.body && res.body.cancel && res.body.cancel(); } catch { /* ignore */ }
        const block = classifyBlock({
          status,
          headers: res.headers,
          bodyText: '',
          cookies: setCookies
        });
        return {
          status,
          ok: false,
          text: asBuffer ? undefined : '',
          buffer: asBuffer ? null : undefined,
          headers: outHeaders,
          notModified: false,
          cfChallenged: false,
          rateLimited: false,
          tooLarge: true,
          block,
          error: `content-length ${cl} exceeds maxBytes ${maxBytes}`
        };
      }
    }

    // Read body with a STREAMING maxBytes guard (aborts mid-stream once the
    // cap is hit — an absent/lying Content-Length can't OOM us).
    let bodyBuf;
    try {
      const capped = await _readBodyCapped(res, maxBytes, ac);
      if (capped.tooLarge) {
        const block = classifyBlock({
          status,
          headers: res.headers,
          bodyText: '',
          cookies: setCookies
        });
        return {
          status,
          ok: false,
          text: asBuffer ? undefined : '',
          buffer: asBuffer ? null : undefined,
          headers: outHeaders,
          notModified: false,
          cfChallenged: false,
          rateLimited: false,
          tooLarge: true,
          block,
          error: `body exceeds maxBytes ${maxBytes}`
        };
      }
      bodyBuf = capped.buffer;
    } catch (err) {
      return {
        status: 0,
        ok: false,
        text: asBuffer ? undefined : '',
        buffer: asBuffer ? null : undefined,
        headers: outHeaders,
        notModified: false,
        cfChallenged: false,
        rateLimited: false,
        tooLarge: false,
        block: null,
        error: err && err.message ? err.message : String(err)
      };
    }

    const text = bodyBuf.toString('utf8');
    // Full vendor classification (CF header/cookies, Akamai, PX, …).
    // Pass raw res.headers so cf-mitigated / x-akamai-* / server are visible
    // — outHeaders is the reduced etag/retryAfter projection only.
    const block = classifyBlock({
      status,
      headers: res.headers,
      bodyText: text,
      cookies: setCookies
    });
    // Back-compat: cfChallenged === old _isCfChallenged (body+403/503 only).
    // Header/cookie CF signals surface on `block` but do not flip this flag.
    const cfChallenged = _isCfChallenged(status, text);
    const rateLimited =
      status === 429 ||
      (status === 503 && outHeaders.retryAfter != null && !cfChallenged);

    const ok = status >= 200 && status < 300;

    if (asBuffer) {
      return {
        status,
        ok,
        buffer: bodyBuf,
        headers: outHeaders,
        notModified: false,
        cfChallenged,
        rateLimited,
        tooLarge: false,
        block,
        ...(ok ? {} : { error: cfChallenged ? 'cloudflare challenge' : `HTTP ${status}` })
      };
    }

    return {
      status,
      ok,
      text,
      headers: outHeaders,
      notModified: false,
      cfChallenged,
      rateLimited,
      tooLarge: false,
      block,
      ...(ok ? {} : { error: cfChallenged ? 'cloudflare challenge' : `HTTP ${status}` })
    };
  } finally {
    clearTimeout(timer);
    releaseDomainSlot(domain);
  }
}

// ── Public fetch wrappers ────────────────────────────────────────────

async function fetchText(url, {
  timeoutMs = 15000,
  headers = {},
  etag = null,
  lastModified = null,
  maxBytes = 4_000_000,
  method = 'GET',
  body = null
} = {}) {
  const maxAttempts = 3; // 1 initial + 2 retries
  let attempt = 0;
  let last;

  while (attempt < maxAttempts) {
    last = await _doFetch(url, {
      timeoutMs,
      headers,
      etag,
      lastModified,
      maxBytes,
      asBuffer: false,
      method,
      body
    });

    if (!last.rateLimited) return last;

    attempt += 1;
    if (attempt >= maxAttempts) break;

    // Honor Retry-After, capped at 60s; default 1s if missing.
    let delaySec = last.headers && last.headers.retryAfter != null
      ? last.headers.retryAfter
      : 1;
    delaySec = Math.min(60, Math.max(0, delaySec));
    await _sleep(delaySec * 1000);
  }

  return last;
}

async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  if (r.notModified) {
    return {
      status: r.status,
      ok: true,
      json: null,
      headers: r.headers,
      notModified: true,
      cfChallenged: false,
      rateLimited: false
    };
  }
  if (!r.ok) {
    return {
      status: r.status,
      ok: false,
      json: null,
      headers: r.headers,
      notModified: false,
      cfChallenged: r.cfChallenged,
      rateLimited: r.rateLimited,
      error: r.error
    };
  }
  try {
    const json = _parseJsonLenient(r.text || '');
    return {
      status: r.status,
      ok: true,
      json,
      headers: r.headers,
      notModified: false,
      cfChallenged: false,
      rateLimited: false
    };
  } catch (err) {
    return {
      status: r.status,
      ok: false,
      json: null,
      headers: r.headers,
      notModified: false,
      cfChallenged: false,
      rateLimited: false,
      error: err && err.message ? err.message : 'JSON parse failed'
    };
  }
}

async function fetchBuffer(url, {
  timeoutMs = 20000,
  maxBytes = 20_000_000,
  headers = {}
} = {}) {
  // No auto-retry for buffers.
  const r = await _doFetch(url, {
    timeoutMs,
    headers,
    etag: null,
    lastModified: null,
    maxBytes,
    asBuffer: true
  });

  return {
    status: r.status,
    ok: r.ok,
    buffer: r.buffer,
    tooLarge: !!r.tooLarge,
    cfChallenged: !!r.cfChallenged,
    rateLimited: !!r.rateLimited,
    ...(r.error ? { error: r.error } : {})
  };
}

module.exports = {
  UA_POOL,
  pickUA,
  fetchText,
  fetchJson,
  fetchBuffer,
  isAllowedByRobots,
  respectsRobots
};
