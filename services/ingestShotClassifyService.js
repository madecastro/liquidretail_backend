// Ingest-time packshot/lifestyle classification — off the paid DetectRun.
//
// WHY: imageShotHeuristicService is free (pure sharp) but previously only
// ran inside pipelines/detect.js applyMediaLibraryDerivations, which also
// fires billable subjects-text + YOLO. Classification needs image BYTES;
// the catalog ingest path is the earliest place we can afford a bounded
// fetch without coupling to DetectRun. materializeImage cannot host this:
// CATALOG_DETECT_PRECOMPUTE defaults false, so enqueueBrandProductDetects
// is a no-op at sync time and materialization is deferred to ad-time.
//
// This module is deliberately Mongoose-free: URLs in, results out. Writers
// own persistence onto CatalogProduct.imageShotStyles (URL-keyed).
//
// Architecture (load-bearing for merchant onboarding):
//   Writers UPSERT every product FIRST, then run classification as a
//   post-loop pass that cannot block or delay product saves. A hung DNS
//   or slow CDN must never truncate a brand's catalog.
//
// Bounding:
//   - concurrency cap (default 6, via concurrency.js)
//   - ONE per-URL deadline covering DNS + every redirect hop + body read
//   - per-session wall-clock budget (in-flight workers observe it too)
//   - idempotent skip of already-stored URLs
//   - never throws out to the caller (best-effort enrichment)
//
// SSRF (new surface, 2026-08): ingest fetches product <img> URLs on OUR
// server. Previously those URLs went only to Cloudinary (their infra). A
// scraped page can point at 169.254.169.254 / 127.0.0.1 / RFC1918 / file://.
// Guard lives HERE only — do NOT widen into httpScrapeClient without a
// separate audit (that client is shared by every scrape path and today has
// no private-range / protocol allowlist; pre-existing gap, separate work).
//
// Connection pin (closes DNS-rebinding TOCTOU): after resolving + validating
// addresses we connect via Node http/https with a custom `lookup` that returns
// ONLY the already-validated address(es). The socket cannot re-resolve to a
// different (private) IP. Each redirect hop re-validates and re-pins.

'use strict';

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { concurrency: CONC } = require('./concurrency');
const {
  classifyShotStyle: defaultClassifyShotStyle
} = require('./imageShotHeuristicService');

// NOTE: we intentionally do NOT use services/httpScrapeClient.fetchBuffer for
// this path. That client hardcodes `redirect: 'follow'` with no hop
// validation and no private-IP guard — using it after a pre-check on the
// *original* URL would still let a public 302 open an internal address.
// Follow-up: give httpScrapeClient its own SSRF + hop-validated redirects
// (blast radius: every scrape path). Until then, this module owns a local
// fetch with redirect: 'manual' and re-validates every Location target.

const dnsPromises = dns.promises;

// ── Tunables ──────────────────────────────────────────────────────────────
// Defaults are conservative starting points for a free path that must not
// turn a catalog sync into an unbounded image-download storm.
const DEFAULTS = Object.freeze({
  // Concurrent in-flight fetches. Mirrors CATALOG_ENRICHMENT_CONCURRENCY=6.
  concurrency: CONC.CATALOG_INGEST_SHOT_CLASSIFY_CONCURRENCY || 6,
  // Per-image HTTP timeout — a slow CDN must not stall a sync.
  // ONE deadline per URL covers DNS + every redirect hop + body read.
  timeoutMs: Math.max(
    500,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_TIMEOUT_MS, 10) || 5_000
  ),
  // Refuse to buffer a huge asset. Classification only needs a downscaled
  // working copy; multi-10MB product photos are not worth the RAM.
  maxBytes: Math.max(
    64_000,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_MAX_BYTES, 10) || 5_000_000
  ),
  // Per-session (per-sync) wall-clock budget for the CLASSIFY PHASE only.
  // Clock starts at beginClassifyPhase() — NOT createSession() — so Graph
  // pagination / product upserts cannot burn the budget before any image
  // work runs. After this, STOP and let the detect-time fallback cover
  // the rest. No silent caps: skipped count is always logged via
  // session.logSummary().
  budgetMs: Math.max(
    1_000,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_BUDGET_MS, 10) || 120_000
  ),
  // Wall-clock cap on the sharp decode / stats step AFTER bytes are in
  // hand. Fetch has its own timeout; without this, a pathological buffer
  // can pin a worker slot forever (libvips block). See classifyWithCpuGuard.
  cpuMs: Math.max(
    100,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_CPU_MS, 10) || 8_000
  ),
  // Optional cheap gate before full decode (0 disables). Refuse huge or
  // long-animated assets that are not worth a sharp pipeline.
  maxDecodePixels: Math.max(
    0,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_MAX_DECODE_PIXELS, 10) || 40_000_000
  ),
  maxAnimatedPages: Math.max(
    0,
    parseInt(process.env.CATALOG_INGEST_SHOT_CLASSIFY_MAX_ANIMATED_PAGES, 10) || 24
  ),
  // Max 3xx hops after each hop's destination is re-validated. Zero would
  // also be safe; a small budget keeps ordinary CDN http→https / edge hops
  // working without ever following an unvalidated Location.
  maxRedirects: 5
});

// Default ON: free of LLM cost. Explicit string 'false' disables
// (strict-string convention — same as CATALOG_SHOT_HEURISTIC_ENABLED).
function isEnabled() {
  return String(process.env.CATALOG_INGEST_SHOT_CLASSIFY_ENABLED ?? 'true')
    .toLowerCase() !== 'false';
}

// ── Abort helpers ─────────────────────────────────────────────────────────

function makeAbortError(message = 'The operation was aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/** Reject when `signal` aborts; resolves cleanup fn. */
function abortable(signal, promise) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(makeAbortError());
    };
    const cleanup = () => {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); }
    );
  });
}

// ── SSRF guard ────────────────────────────────────────────────────────────
// Protocol allowlist + credentials ban + POST-DNS private/reserved block.
// No host allowlist: product images are inherently cross-host (Shopify CDN,
// CloudFront, Fastly, Akamai, …). Block by destination address only.

/**
 * True when `ip` is a private, loopback, link-local, or otherwise reserved
 * address we must never fetch. Covers IPv4, IPv6, and IPv4-mapped IPv6.
 *
 * Blocked ranges (exact contract pinned by the harness):
 *   IPv4:
 *     0.0.0.0/8          this network
 *     10.0.0.0/8         RFC1918
 *     100.64.0.0/10      shared address space (CGNAT)
 *     127.0.0.0/8        loopback
 *     169.254.0.0/16     link-local (incl. cloud metadata 169.254.169.254)
 *     172.16.0.0/12      RFC1918
 *     192.0.0.0/24       IETF protocol assignments
 *     192.0.2.0/24       TEST-NET-1
 *     192.168.0.0/16     RFC1918
 *     198.18.0.0/15      benchmarking
 *     198.51.100.0/24    TEST-NET-2
 *     203.0.113.0/24     TEST-NET-3
 *     224.0.0.0/4        multicast
 *     240.0.0.0/4        reserved
 *     255.255.255.255/32 broadcast
 *   IPv6:
 *     ::                unspecified
 *     ::1               loopback
 *     ::ffff:0:0/96     IPv4-mapped — embedded IPv4 re-checked via isBlockedIp
 *     fc00::/7          unique local
 *     fe80::/10         link-local
 *     2001:db8::/32     documentation
 *     ff00::/8          multicast
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isBlockedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // unparseable → refuse
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidrV4(ipInt, base, prefix) {
  if (ipInt == null) return true;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ipInt & mask) === (base & mask);
}

function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return true;
  // 0.0.0.0/8
  if (inCidrV4(n, 0x00000000, 8)) return true;
  // 10.0.0.0/8
  if (inCidrV4(n, 0x0a000000, 8)) return true;
  // 100.64.0.0/10 CGNAT
  if (inCidrV4(n, 0x64400000, 10)) return true;
  // 127.0.0.0/8 loopback
  if (inCidrV4(n, 0x7f000000, 8)) return true;
  // 169.254.0.0/16 link-local
  if (inCidrV4(n, 0xa9fe0000, 16)) return true;
  // 172.16.0.0/12
  if (inCidrV4(n, 0xac100000, 12)) return true;
  // 192.0.0.0/24
  if (inCidrV4(n, 0xc0000000, 24)) return true;
  // 192.0.2.0/24 TEST-NET-1
  if (inCidrV4(n, 0xc0000200, 24)) return true;
  // 192.168.0.0/16
  if (inCidrV4(n, 0xc0a80000, 16)) return true;
  // 198.18.0.0/15
  if (inCidrV4(n, 0xc6120000, 15)) return true;
  // 198.51.100.0/24 TEST-NET-2
  if (inCidrV4(n, 0xc6336400, 24)) return true;
  // 203.0.113.0/24 TEST-NET-3
  if (inCidrV4(n, 0xcb007100, 24)) return true;
  // 224.0.0.0/4 multicast
  if (inCidrV4(n, 0xe0000000, 4)) return true;
  // 240.0.0.0/4 reserved (+ 255.255.255.255)
  if (inCidrV4(n, 0xf0000000, 4)) return true;
  return false;
}

function parseIpv6(ip) {
  // Expand to 8 hextets. Handles :: compression and dotted IPv4 tail.
  let s = String(ip).toLowerCase();
  // Strip zone id (fe80::1%eth0)
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  // IPv4-mapped / IPv4-compatible dotted tail → two hextets
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    const v4n = ipv4ToInt(v4);
    if (v4n == null) return null;
    const hi = (v4n >>> 16) & 0xffff;
    const lo = v4n & 0xffff;
    s = `${s.slice(0, lastColon)}:${hi.toString(16)}:${lo.toString(16)}`;
  }

  const sides = s.split('::');
  if (sides.length > 2) return null;
  let head = sides[0] ? sides[0].split(':') : [];
  let tail = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  if (sides.length === 1) {
    head = s.split(':');
    tail = [];
  }
  if (head.length + tail.length > 8) return null;
  const mid = sides.length === 2 ? 8 - head.length - tail.length : 0;
  if (sides.length === 2 && mid < 0) return null;
  if (sides.length === 1 && head.length !== 8) return null;
  const hextets = [];
  for (const h of head) {
    if (h === '') hextets.push(0);
    else {
      const n = parseInt(h, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      hextets.push(n);
    }
  }
  for (let i = 0; i < mid; i++) hextets.push(0);
  for (const h of tail) {
    if (h === '') hextets.push(0);
    else {
      const n = parseInt(h, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
      hextets.push(n);
    }
  }
  if (hextets.length !== 8) return null;
  return hextets;
}

function isBlockedIpv6(ip) {
  const h = parseIpv6(ip);
  if (!h) return true;

  // :: unspecified
  if (h.every((x) => x === 0)) return true;
  // ::1 loopback
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 &&
      h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) {
    return true;
  }
  // ::ffff:0:0/96 IPv4-mapped — re-check embedded IPv4
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 &&
      h[4] === 0 && h[5] === 0xffff) {
    const v4 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isBlockedIpv4(v4);
  }
  // fc00::/7 unique local (fc00..fdff)
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  // 2001:db8::/32 documentation
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  // ff00::/8 multicast
  if ((h[0] & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * Default DNS lookup — returns [{ address, family }, ...] like dns.lookup
 * with { all: true }. Injectable for offline harnesses.
 */
async function defaultLookup(hostname, opts) {
  return dnsPromises.lookup(hostname, { all: true, verbatim: true, ...(opts || {}) });
}

/**
 * Validate a URL for server-side image fetch. Resolves the hostname and
 * rejects if ANY returned address is blocked. Does not fetch.
 *
 * DNS participates in `opts.signal` so a hung resolver cannot stall past
 * the per-URL deadline.
 *
 * @param {string} urlString
 * @param {object} [opts]
 * @param {function} [opts.lookup]  dns.lookup-compatible ({all:true} form)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:true, url:URL, addresses:string[], host:string}|{ok:false, reason:string}>}
 */
async function assertUrlSafeForFetch(urlString, opts = {}) {
  const lookup = opts.lookup || defaultLookup;
  const signal = opts.signal || null;

  if (!urlString || typeof urlString !== 'string') {
    return { ok: false, reason: 'invalid_url' };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  // 1. Protocol allowlist — http/https only.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme_not_allowed:${parsed.protocol}` };
  }

  // 2. Credentials in URL — reject (userinfo can hide intent / confuse parsers).
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, reason: 'missing_hostname' };
  }

  // Strip IPv6 brackets if present (URL.hostname already does for most Node versions).
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  // 3. Resolve then block by destination address (NOT a hostname string match).
  //    Literal IPs are checked directly; names go through DNS. A public name
  //    whose A/AAAA points at 169.254.169.254 is rejected — the check a pure
  //    string-match implementation fails.
  let addresses = [];
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    addresses = [host];
  } else {
    if (signal && signal.aborted) {
      return { ok: false, reason: 'dns_aborted' };
    }
    let records;
    try {
      records = await abortable(
        signal,
        Promise.resolve().then(() => lookup(host, { all: true, verbatim: true }))
      );
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        return { ok: false, reason: 'dns_aborted' };
      }
      return {
        ok: false,
        reason: `dns_failed:${err && err.code ? err.code : 'error'}`
      };
    }
    if (!records || !records.length) {
      return { ok: false, reason: 'dns_empty' };
    }
    // Normalise: Node returns {address,family}[]; some stubs may return strings.
    addresses = records.map((r) => (typeof r === 'string' ? r : r && r.address)).filter(Boolean);
    if (!addresses.length) {
      return { ok: false, reason: 'dns_empty' };
    }
  }

  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      return {
        ok: false,
        reason: `blocked_address:${addr}`,
        addresses
      };
    }
  }

  return { ok: true, url: parsed, addresses, host };
}

/**
 * Build a Node `lookup` function that returns ONLY the pre-validated
 * addresses — the socket cannot re-resolve to a different IP (closes
 * DNS-rebinding TOCTOU between validate and connect).
 */
function makePinnedLookup(addresses) {
  const list = (addresses || [])
    .map((a) => (typeof a === 'string' ? a : a && a.address))
    .filter(Boolean)
    .map((address) => ({ address, family: net.isIP(address) || 4 }));
  if (!list.length) {
    return (_hostname, opts, cb) => {
      if (typeof opts === 'function') cb = opts;
      cb(new Error('pinned_lookup_empty'));
    };
  }
  return function pinnedLookup(_hostname, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    // Node ≥20 often requests { all: true }.
    if (opts && opts.all) {
      cb(null, list.slice());
    } else {
      cb(null, list[0].address, list[0].family);
    }
  };
}

/**
 * Stream-cap a fetch Response body. Aborts once maxBytes is exceeded.
 */
async function readBodyCapped(res, maxBytes, ac) {
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
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > cap) return { tooLarge: true, buffer: null };
  return { tooLarge: false, buffer: buf };
}

/**
 * Read an IncomingMessage body with a byte cap. Honours abort signal.
 */
function readNodeBodyCapped(res, maxBytes, signal) {
  const cap = maxBytes == null ? Infinity : maxBytes;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      res.resume();
      reject(makeAbortError());
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const onAbort = () => {
      cleanup();
      res.destroy(makeAbortError());
      if (!settled) {
        settled = true;
        reject(makeAbortError());
      }
    };
    const cleanup = () => {
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
    const onData = (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > cap) {
        cleanup();
        res.destroy();
        settled = true;
        resolve({ tooLarge: true, buffer: null });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      cleanup();
      settled = true;
      resolve({ tooLarge: false, buffer: Buffer.concat(chunks, total) });
    };
    const onError = (err) => {
      if (settled) return;
      cleanup();
      settled = true;
      reject(err);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
  });
}

/**
 * One hop via Node http/https, pinned to pre-validated addresses.
 * Uses custom `lookup` so the TCP socket cannot re-resolve (SSRF pin).
 * TLS `servername` stays the original hostname (SNI + cert verify).
 */
function nodePinnedRequest(urlString, { addresses, signal, headers }) {
  const u = new URL(urlString);
  const lib = u.protocol === 'https:' ? https : http;
  const pinnedLookup = makePinnedLookup(addresses);
  const hostname = u.hostname.startsWith('[') && u.hostname.endsWith(']')
    ? u.hostname.slice(1, -1)
    : u.hostname;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }
    const opts = {
      protocol: u.protocol,
      hostname,
      servername: hostname, // TLS SNI + cert hostname — original name, not the IP
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname || '/'}${u.search || ''}`,
      method: 'GET',
      headers: {
        Host: u.host,
        ...(headers || {})
      },
      // PIN: socket connects only to addresses we already validated.
      lookup: pinnedLookup,
      // Do not follow redirects — caller re-validates each Location.
      // (http/https never auto-follow GETs to a new host the way fetch can.)
    };
    if (signal) opts.signal = signal;

    let req;
    try {
      req = lib.request(opts, (res) => {
        resolve(res);
      });
    } catch (err) {
      reject(err);
      return;
    }
    req.on('error', reject);
    if (signal) {
      const onAbort = () => {
        try { req.destroy(makeAbortError()); } catch { /* ignore */ }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      });
    }
    req.end();
  });
}

/**
 * Fetch image bytes with SSRF-safe semantics:
 *   - ONE AbortController / deadline for DNS + every hop + body read
 *   - DNS resolved once per hop; connection pinned to validated addresses
 *   - redirect: 'manual' — never follow an unvalidated Location
 *   - each 3xx Location is re-run through assertUrlSafeForFetch before hop
 *
 * Why not httpScrapeClient: that client follows redirects internally with no
 * hop validation (redirect:'follow'). We cannot see intermediate targets
 * without editing it, so this path owns its own fetch.
 *
 * Production path uses Node http/https + custom `lookup` pin (closes
 * DNS-rebinding TOCTOU). When `opts.fetchImpl` is provided (tests), that
 * implementation is used after the same per-hop validation; the pin is
 * still applied when the default path runs.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxRedirects]
 * @param {function} [opts.lookup]
 * @param {function} [opts.fetchImpl]  injectable fetch (tests)
 * @param {AbortSignal} [opts.signal]  optional outer signal (session budget)
 * @returns {Promise<{ok, buffer, tooLarge, status, error?, ssrfRejected?, ssrfReason?}>}
 */
async function safeFetchBuffer(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const lookup = opts.lookup || defaultLookup;
  const fetchImpl = opts.fetchImpl || null;
  const outerSignal = opts.signal || null;

  // ONE controller for the whole URL lifetime (DNS + all hops + body).
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(); } catch { /* ignore */ }
  }, timeoutMs);

  // Link outer (budget) abort into the per-URL controller.
  let unlinkOuter = null;
  if (outerSignal) {
    if (outerSignal.aborted) {
      clearTimeout(timer);
      return {
        ok: false,
        buffer: null,
        tooLarge: false,
        status: 0,
        error: `timeout after ${timeoutMs}ms`
      };
    }
    const onOuter = () => {
      try { ac.abort(); } catch { /* ignore */ }
    };
    outerSignal.addEventListener('abort', onOuter, { once: true });
    unlinkOuter = () => {
      try { outerSignal.removeEventListener('abort', onOuter); } catch { /* ignore */ }
    };
  }

  const signal = ac.signal;

  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // Resolve + validate ONCE per hop; reuse addresses for the pin.
      const safety = await assertUrlSafeForFetch(current, { lookup, signal });
      if (!safety.ok) {
        const aborted = safety.reason === 'dns_aborted';
        return {
          ok: false,
          buffer: null,
          tooLarge: false,
          status: 0,
          ssrfRejected: !aborted,
          ssrfReason: aborted ? undefined : safety.reason,
          error: aborted
            ? `timeout after ${timeoutMs}ms`
            : `ssrf_rejected:${safety.reason}`
        };
      }

      // ── Injected fetch (harness) — validation already done; no pin needed
      // for stubs that never open a socket. Still redirect:'manual'.
      if (typeof fetchImpl === 'function') {
        let res;
        try {
          res = await fetchImpl(current, {
            method: 'GET',
            redirect: 'manual',
            signal,
            // Expose pin material so a sophisticated test can assert it.
            pinnedAddresses: safety.addresses,
            headers: {
              Accept: 'image/*,*/*;q=0.8',
              'User-Agent': 'ReachSocial-IngestShotClassify/1.0'
            }
          });
        } catch (err) {
          const msg =
            err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
              ? `timeout after ${timeoutMs}ms`
              : err && err.message
                ? err.message
                : String(err);
          return {
            ok: false,
            buffer: null,
            tooLarge: false,
            status: 0,
            error: msg
          };
        }

        const status = res.status;
        if (status >= 300 && status < 400) {
          const loc = res.headers && (res.headers.get ? res.headers.get('location') : res.headers.location);
          try { res.body && res.body.cancel && res.body.cancel(); } catch { /* ignore */ }
          if (!loc) {
            return {
              ok: false,
              buffer: null,
              tooLarge: false,
              status,
              error: `redirect_missing_location:${status}`
            };
          }
          if (hop >= maxRedirects) {
            return {
              ok: false,
              buffer: null,
              tooLarge: false,
              status,
              error: `too_many_redirects:${maxRedirects}`
            };
          }
          let next;
          try {
            next = new URL(loc, current).toString();
          } catch {
            return {
              ok: false,
              buffer: null,
              tooLarge: false,
              status,
              error: 'redirect_bad_location',
              ssrfRejected: true,
              ssrfReason: 'redirect_bad_location'
            };
          }
          current = next;
          continue;
        }

        const clRaw = res.headers && (res.headers.get ? res.headers.get('content-length') : null);
        if (clRaw != null && maxBytes != null) {
          const cl = parseInt(clRaw, 10);
          if (Number.isFinite(cl) && cl > maxBytes) {
            try { res.body && res.body.cancel && res.body.cancel(); } catch { /* ignore */ }
            return {
              ok: false,
              buffer: null,
              tooLarge: true,
              status,
              error: `content-length ${cl} exceeds maxBytes ${maxBytes}`
            };
          }
        }

        const capped = await readBodyCapped(res, maxBytes, ac);
        if (capped.tooLarge) {
          return {
            ok: false,
            buffer: null,
            tooLarge: true,
            status,
            error: `body exceeds maxBytes ${maxBytes}`
          };
        }
        const ok = status >= 200 && status < 300;
        return {
          ok,
          buffer: capped.buffer,
          tooLarge: false,
          status,
          ...(ok ? {} : { error: `HTTP ${status}` })
        };
      }

      // ── Production path: Node http/https with pinned lookup ───────────
      // Closes rebinding: validate addresses → connect ONLY to those IPs
      // via custom lookup. Hostname stays on Host/servername for TLS.
      let res;
      try {
        res = await nodePinnedRequest(current, {
          addresses: safety.addresses,
          signal,
          headers: {
            Accept: 'image/*,*/*;q=0.8',
            'User-Agent': 'ReachSocial-IngestShotClassify/1.0'
          }
        });
      } catch (err) {
        const msg =
          err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
            ? `timeout after ${timeoutMs}ms`
            : err && err.message
              ? err.message
              : String(err);
        return {
          ok: false,
          buffer: null,
          tooLarge: false,
          status: 0,
          error: msg
        };
      }

      const status = res.statusCode || 0;
      // 3xx with Location → validate target, hop. Same controller continues
      // (deadline is NOT reset per hop — 6 hops cannot stack 6× timeoutMs).
      if (status >= 300 && status < 400) {
        const loc = res.headers && res.headers.location;
        res.resume(); // drain
        if (!loc) {
          return {
            ok: false,
            buffer: null,
            tooLarge: false,
            status,
            error: `redirect_missing_location:${status}`
          };
        }
        if (hop >= maxRedirects) {
          return {
            ok: false,
            buffer: null,
            tooLarge: false,
            status,
            error: `too_many_redirects:${maxRedirects}`
          };
        }
        let next;
        try {
          next = new URL(loc, current).toString();
        } catch {
          return {
            ok: false,
            buffer: null,
            tooLarge: false,
            status,
            error: 'redirect_bad_location',
            ssrfRejected: true,
            ssrfReason: 'redirect_bad_location'
          };
        }
        current = next;
        continue;
      }

      const clRaw = res.headers && res.headers['content-length'];
      if (clRaw != null && maxBytes != null) {
        const cl = parseInt(clRaw, 10);
        if (Number.isFinite(cl) && cl > maxBytes) {
          res.resume();
          return {
            ok: false,
            buffer: null,
            tooLarge: true,
            status,
            error: `content-length ${cl} exceeds maxBytes ${maxBytes}`
          };
        }
      }

      let capped;
      try {
        capped = await readNodeBodyCapped(res, maxBytes, signal);
      } catch (err) {
        const msg =
          err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
            ? `timeout after ${timeoutMs}ms`
            : err && err.message
              ? err.message
              : String(err);
        return {
          ok: false,
          buffer: null,
          tooLarge: false,
          status,
          error: msg
        };
      }
      if (capped.tooLarge) {
        return {
          ok: false,
          buffer: null,
          tooLarge: true,
          status,
          error: `body exceeds maxBytes ${maxBytes}`
        };
      }

      const ok = status >= 200 && status < 300;
      return {
        ok,
        buffer: capped.buffer,
        tooLarge: false,
        status,
        ...(ok ? {} : { error: `HTTP ${status}` })
      };
    }

    return {
      ok: false,
      buffer: null,
      tooLarge: false,
      status: 0,
      error: `too_many_redirects:${maxRedirects}`
    };
  } finally {
    clearTimeout(timer);
    if (unlinkOuter) unlinkOuter();
  }
}

/**
 * Look up a stored style entry by exact URL.
 *
 * Keying is exact-string on purpose (reorder-safety is correct). CDN
 * query/size churn (e.g. `?width=800` → `?width=1200`) re-downloads
 * rather than mislabels — that is the safe failure direction. Do NOT
 * add fuzzy matching.
 *
 * @param {Array|{url:string}[]|null|undefined} entries
 * @param {string} url
 * @returns {object|null}
 */
function storedStyleForUrl(entries, url) {
  if (!url || !Array.isArray(entries) || !entries.length) return null;
  for (const e of entries) {
    if (e && e.url === url && e.style) return e;
  }
  return null;
}

/**
 * Build Media.technicalInsights fields from a CatalogProduct-stored entry.
 * Used by materializeImage so Media consumers get the signal without a
 * re-fetch / re-sharp. Returns null when nothing to copy.
 */
function technicalInsightsFromStored(entry) {
  if (!entry || !entry.style) return null;
  if (entry.style !== 'packshot' && entry.style !== 'lifestyle' && entry.style !== 'ambiguous') {
    return null;
  }
  const at = entry.at ? new Date(entry.at) : new Date();
  return {
    shotStyle: entry.style,
    shotStyleConfidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    // Lean marker — full metrics live on detect-time recompute only when
    // needed. source:'ingest' lets calibration / debug tell arms apart.
    shotStyleMetrics: { source: 'ingest', at: at.toISOString() },
    updatedAt: at
  };
}

/**
 * Timestamp ms from a technicalInsights-shaped object (or null).
 * Prefers updatedAt, falls back to shotStyleMetrics.at.
 */
function technicalInsightsTimestampMs(ti) {
  if (!ti || typeof ti !== 'object') return null;
  const raw = ti.updatedAt || (ti.shotStyleMetrics && ti.shotStyleMetrics.at) || null;
  if (!raw) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether a CatalogProduct-derived storedShot should write onto Media.
 * Conservative newer-wins: apply when Media has no shotStyle, OR when the
 * product entry is strictly newer than Media's stored stamp. Equal/unknown
 * timestamps do NOT thrash (no refresh). Used by materializeImage so a
 * threshold retune / re-classify can supersede a stale Media value without
 * bouncing on every materialize.
 *
 * @param {object|null|undefined} existingTi  Media.technicalInsights
 * @param {object|null|undefined} storedShot  technicalInsightsFromStored(...)
 * @returns {boolean}
 */
function shouldApplyStoredShot(existingTi, storedShot) {
  if (!storedShot || !storedShot.shotStyle) return false;
  if (!existingTi || !existingTi.shotStyle) return true;
  const existingMs = technicalInsightsTimestampMs(existingTi);
  const storedMs = technicalInsightsTimestampMs(storedShot);
  // Missing either stamp → leave Media alone (never thrash).
  if (existingMs == null || storedMs == null) return false;
  return storedMs > existingMs;
}

/**
 * Merge URL-keyed style arrays. Later entries with the same URL replace
 * earlier ones.
 *
 * When `currentUrls` is provided (the product's live image set), entries
 * whose URL is NO LONGER in that set are pruned — otherwise
 * `imageShotStyles` grows forever across re-syncs as merchants rotate
 * photos. When omitted, all URLs are preserved (backward-compat / partial
 * merges).
 *
 * @param {Array} existing
 * @param {Array} incoming
 * @param {string[]|null} [currentUrls]
 */
function mergeStyleEntries(existing, incoming, currentUrls = null) {
  const map = new Map();
  for (const e of existing || []) {
    if (e && e.url && e.style) map.set(e.url, e);
  }
  for (const e of incoming || []) {
    if (e && e.url && e.style) map.set(e.url, e);
  }
  if (Array.isArray(currentUrls)) {
    const keep = new Set(currentUrls.filter((u) => typeof u === 'string' && u));
    for (const url of [...map.keys()]) {
      if (!keep.has(url)) map.delete(url);
    }
  }
  return [...map.values()];
}

/**
 * Collect unique product image URLs (hero + alts).
 */
function collectProductImageUrls(imageUrl, additionalImages) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || typeof u !== 'string') return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(imageUrl);
  if (Array.isArray(additionalImages)) {
    for (const u of additionalImages) push(u);
  }
  return out;
}

/**
 * Create a per-sync classification session. Shares concurrency, wall-clock
 * budget, and aggregate counters across every product in one ingest run.
 *
 * Writers must NOT await session work inside the product upsert loop —
 * use a post-loop pass (see each writer's pendingClassify pattern) so a
 * hung image fetch can never truncate a catalog.
 *
 * BUDGET CLOCK: createSession does NOT start the budget. Writers call
 * beginClassifyPhase() immediately before the post-loop classify pass.
 * That is what arms startedAt + the AbortController timer. Graph
 * pagination / category stamping / upserts that precede classification
 * must not burn the ceiling (Blocker 1).
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.cpuMs]          sharp/decode wall-clock cap
 * @param {function} [opts.fetchBuffer]   test double for safeFetchBuffer
 * @param {function} [opts.classifyShotStyle] test double for imageShotHeuristicService
 * @param {function} [opts.lookup]        DNS stub (tests)
 * @param {function} [opts.fetchImpl]     injectable low-level fetch (tests)
 * @param {function} [opts.now]           () => ms epoch (tests)
 * @param {function} [opts.metadataFn]    (buf) => Promise<meta> optional sharp.metadata stub
 */
function createSession(opts = {}) {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const budgetMs = opts.budgetMs ?? DEFAULTS.budgetMs;
  const cpuMs = opts.cpuMs ?? DEFAULTS.cpuMs;
  const maxDecodePixels = opts.maxDecodePixels ?? DEFAULTS.maxDecodePixels;
  const maxAnimatedPages = opts.maxAnimatedPages ?? DEFAULTS.maxAnimatedPages;
  const classifyShotStyle = opts.classifyShotStyle || defaultClassifyShotStyle;
  const now = opts.now || Date.now;
  const lookup = opts.lookup || defaultLookup;
  const metadataFn = opts.metadataFn || null;

  // Default path: safeFetchBuffer (DNS once + pin + single deadline).
  // Injected fetchBuffer (harnesses): gate SSRF once here, then call the
  // double — do NOT also run safeFetchBuffer (would double DNS).
  const hasInjectedFetch = typeof opts.fetchBuffer === 'function';

  async function fetchBuffer(url, fetchOpts = {}) {
    if (hasInjectedFetch) {
      // One DNS/validate for the original URL (injected stubs do not
      // redirect to private hosts). Signal races DNS.
      const safety = await assertUrlSafeForFetch(url, {
        lookup,
        signal: fetchOpts.signal || null
      });
      if (!safety.ok) {
        const aborted = safety.reason === 'dns_aborted';
        return {
          ok: false,
          buffer: null,
          tooLarge: false,
          status: 0,
          ssrfRejected: !aborted,
          ssrfReason: aborted ? undefined : safety.reason,
          error: aborted
            ? (fetchOpts.timeoutMs != null
              ? `timeout after ${fetchOpts.timeoutMs}ms`
              : 'timeout')
            : `ssrf_rejected:${safety.reason}`
        };
      }
      return opts.fetchBuffer(url, {
        ...fetchOpts,
        lookup,
        pinnedAddresses: safety.addresses
      });
    }
    // Production (and harnesses that exercise real safeFetchBuffer):
    // single resolve + pin + deadline inside safeFetchBuffer. No outer gate.
    return safeFetchBuffer(url, {
      ...fetchOpts,
      lookup,
      fetchImpl: opts.fetchImpl,
      maxBytes: fetchOpts.maxBytes ?? maxBytes,
      timeoutMs: fetchOpts.timeoutMs ?? timeoutMs
    });
  }

  // startedAt is null until beginClassifyPhase(). DO NOT set it here —
  // that was the Blocker 1 silent no-op (budget burned by Graph/upserts).
  let startedAt = null;
  let phaseStarted = false;
  const totals = {
    considered: 0,
    classified: 0,
    skippedExisting: 0,
    skippedBudget: 0,
    skippedAbandoned: 0, // pendingClassify never attempted (cancel/fatal)
    skippedFlagOff: 0,
    failed: 0,       // classify returned null / threw / cpu timeout
    fetchFailed: 0,
    ssrfRejected: 0, // distinct from fetchFailed — hostile/private URL
    timedOut: 0,
    tooLarge: 0,
    cpuTimedOut: 0,  // sharp/decode wall-clock exceeded
    maxInFlight: 0,
    abandonReason: null
  };
  let inFlight = 0;
  let budgetExhausted = false;

  // Session-level abort: when wall-clock budget expires, in-flight workers
  // observe it (not only the "claim next URL" check). Prevents a wave of
  // concurrency workers from overrunning by concurrency × worst-case.
  // Armed ONLY in beginClassifyPhase — not at createSession.
  const budgetAc = new AbortController();
  let budgetTimer = null;

  function armBudgetTimer() {
    if (budgetTimer != null) return;
    if (!phaseStarted || startedAt == null) return;
    // If now() is injectable (tests), poll rather than trusting setTimeout
    // wall clock — harnesses advance a fake clock without real delays.
    if (opts.now) {
      // Lazy: budgetOk() aborts when fake clock crosses the line.
      return;
    }
    const left = Math.max(0, budgetMs - (Date.now() - startedAt));
    budgetTimer = setTimeout(() => {
      budgetExhausted = true;
      try { budgetAc.abort(); } catch { /* ignore */ }
    }, left);
    if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
  }

  /**
   * Start the classify-phase budget clock. Call this immediately before
   * the post-loop classify pass — never at session creation.
   * Idempotent: a second call is a no-op (one ceiling per sync).
   */
  function beginClassifyPhase() {
    if (phaseStarted) return false;
    phaseStarted = true;
    startedAt = now();
    armBudgetTimer();
    return true;
  }

  function hasClassifyPhaseStarted() {
    return phaseStarted;
  }

  function budgetLeft() {
    if (!phaseStarted || startedAt == null) return budgetMs;
    return budgetMs - (now() - startedAt);
  }

  function budgetOk() {
    if (!phaseStarted || startedAt == null) {
      // classifyUrls auto-starts the phase (belt-and-braces for unit
      // tests). Writers MUST still call beginClassifyPhase explicitly
      // so abandonPending can tell "never attempted" from "ran" — the
      // harness fails any writer that omits the call.
      beginClassifyPhase();
    }
    if (budgetExhausted) return false;
    if (budgetLeft() <= 0) {
      budgetExhausted = true;
      try { budgetAc.abort(); } catch { /* ignore */ }
      return false;
    }
    return true;
  }

  /**
   * Count outstanding pendingClassify image URLs as abandoned when the
   * classify phase never runs (Meta fatal early-return, CancelledError,
   * or any exit that skips the post-loop pass). Distinguishes
   * "0 images needed classifying" from "N images were never attempted".
   *
   * No-op once beginClassifyPhase has been called (budget/skipBudget
   * own that path). Safe to call from finally.
   *
   * @param {Array<{imageUrl?, additionalImages?, existingStyles?}>} pendingItems
   * @param {string} [reason]
   * @returns {number} URLs counted as abandoned
   */
  function abandonPending(pendingItems, reason = 'phase_skipped') {
    if (phaseStarted) return 0;
    let n = 0;
    for (const item of pendingItems || []) {
      if (!item) continue;
      const urls = collectProductImageUrls(item.imageUrl, item.additionalImages);
      const existing = Array.isArray(item.existingStyles) ? item.existingStyles : [];
      for (const url of urls) {
        // Already-stored styles would have been skippedExisting, not attempted.
        if (storedStyleForUrl(existing, url)) continue;
        n++;
      }
    }
    if (n > 0) {
      totals.skippedAbandoned += n;
      totals.abandonReason = reason || 'phase_skipped';
    } else if (!totals.abandonReason && reason) {
      // Record reason even when zero outstanding (empty pending) so the
      // summary can still show why the phase was skipped if useful.
      totals.abandonReason = reason;
    }
    return n;
  }

  /**
   * Bound the sharp/decode step. HONEST LIMITATION: Promise.race frees
   * this worker slot when the wall-clock fires, but the underlying
   * libvips work started by sharp is NOT cancelled — it may continue on
   * a background thread until it finishes or the process exits. We only
   * guarantee the classify phase does not wait forever on one buffer.
   *
   * Optional cheap metadata pre-check (pages / pixel area) runs first
   * when enabled; failures degrade to unclassified (same as timeout).
   */
  async function classifyWithCpuGuard(buffer) {
    // Optional pre-check: refuse absurd animated/huge assets before the
    // full rotate→resize→stats pipeline. Soft-fail on metadata errors.
    if ((maxDecodePixels > 0 || maxAnimatedPages > 0) && buffer && buffer.length) {
      try {
        let meta;
        if (typeof metadataFn === 'function') {
          meta = await metadataFn(buffer);
        } else {
          // Lazy require so offline harnesses that inject classifyShotStyle
          // and never touch this branch need no sharp binary. Production
          // always has sharp (imageShotHeuristicService depends on it).
          // eslint-disable-next-line global-require
          const sharp = require('sharp');
          meta = await sharp(buffer, { failOn: 'none' }).metadata();
        }
        if (meta) {
          const pages = meta.pages || 1;
          if (maxAnimatedPages > 0 && pages > maxAnimatedPages) {
            return null;
          }
          const w = meta.width || 0;
          const h = meta.height || 0;
          if (maxDecodePixels > 0 && w > 0 && h > 0 && (w * h * pages) > maxDecodePixels) {
            return null;
          }
        }
      } catch (_) {
        // metadata failed — fall through to full classify (may also fail)
      }
    }

    // Wall-clock race. On timeout we return null (unclassified) and the
    // slot is free; sharp may still be chewing the buffer in the background.
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ __cpuTimeout: true });
      }, cpuMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      const raced = await Promise.race([
        Promise.resolve()
          .then(() => classifyShotStyle(buffer))
          .then((r) => ({ __result: r }))
          .catch(() => ({ __result: null })),
        timeoutPromise
      ]);
      if (raced && raced.__cpuTimeout) {
        totals.cpuTimedOut++;
        return null;
      }
      return raced && Object.prototype.hasOwnProperty.call(raced, '__result')
        ? raced.__result
        : null;
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /**
   * Classify a list of image URLs. Skips URLs already present in
   * `existingEntries` (idempotent re-sync). Never throws.
   *
   * @param {string[]} urls
   * @param {Array} [existingEntries] prior CatalogProduct.imageShotStyles
   * @returns {Promise<{
   *   entries: Array,      // full merged list (existing + newly classified), pruned to urls
   *   fresh: Array,        // only newly classified this call
   *   changed: boolean,
   *   stats: object
   * }>}
   */
  async function classifyUrls(urls, existingEntries = []) {
    const callStats = {
      considered: 0,
      classified: 0,
      skippedExisting: 0,
      skippedBudget: 0,
      failed: 0,
      fetchFailed: 0,
      ssrfRejected: 0,
      timedOut: 0,
      tooLarge: 0,
      cpuTimedOut: 0
    };

    const existing = Array.isArray(existingEntries) ? existingEntries : [];
    const existingByUrl = new Map();
    for (const e of existing) {
      if (e && e.url && e.style) existingByUrl.set(e.url, e);
    }

    const list = [];
    const seen = new Set();
    for (const u of urls || []) {
      if (!u || typeof u !== 'string' || seen.has(u)) continue;
      seen.add(u);
      list.push(u);
    }

    if (!isEnabled()) {
      totals.skippedFlagOff += list.length;
      return {
        entries: existing.slice(),
        fresh: [],
        changed: false,
        stats: { ...callStats, skippedFlagOff: list.length }
      };
    }

    // Ensure phase clock is running (writers should have called
    // beginClassifyPhase already; this is the safety net so unit tests
    // of classifyUrls alone still get a correct per-call budget).
    if (!phaseStarted) beginClassifyPhase();

    const pending = [];
    for (const url of list) {
      callStats.considered++;
      totals.considered++;
      if (existingByUrl.has(url)) {
        callStats.skippedExisting++;
        totals.skippedExisting++;
        continue;
      }
      if (!budgetOk()) {
        callStats.skippedBudget++;
        totals.skippedBudget++;
        continue;
      }
      pending.push(url);
    }

    const fresh = [];
    let cursor = 0;

    async function worker() {
      while (cursor < pending.length) {
        // Re-check budget before claiming the next URL so a long earlier
        // fetch doesn't let us start work after the deadline.
        if (!budgetOk()) {
          // Drain remainder as budget skips.
          while (cursor < pending.length) {
            cursor++;
            callStats.skippedBudget++;
            totals.skippedBudget++;
          }
          return;
        }
        const idx = cursor++;
        const url = pending[idx];
        // Cap this URL's deadline by remaining session budget so a wave
        // of `concurrency` workers cannot each run a full timeoutMs after
        // the budget is nearly gone (overrun ≤ one remaining-budget slice,
        // not concurrency × timeoutMs).
        const remaining = budgetLeft();
        if (remaining <= 0) {
          budgetExhausted = true;
          try { budgetAc.abort(); } catch { /* ignore */ }
          callStats.skippedBudget++;
          totals.skippedBudget++;
          // Put back? No — already claimed; count as budget skip.
          continue;
        }
        const urlTimeoutMs = Math.min(timeoutMs, Math.max(1, remaining));

        inFlight++;
        if (inFlight > totals.maxInFlight) totals.maxInFlight = inFlight;
        try {
          const result = await classifyOne(url, urlTimeoutMs);
          if (result) {
            fresh.push(result);
            callStats.classified++;
            totals.classified++;
          } else {
            callStats.failed++;
            totals.failed++;
          }
        } catch (_) {
          // classifyOne is not supposed to throw; belt-and-braces.
          callStats.failed++;
          totals.failed++;
        } finally {
          inFlight--;
        }
      }
    }

    async function classifyOne(url, urlTimeoutMs) {
      let fetched;
      try {
        fetched = await fetchBuffer(url, {
          timeoutMs: urlTimeoutMs,
          maxBytes,
          // Session budget signal — in-flight work aborts when budget expires.
          signal: budgetAc.signal
        });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (/aborted|timeout|Timeout|ABORT/i.test(msg) || (err && err.name === 'AbortError')) {
          callStats.timedOut++;
          totals.timedOut++;
        } else {
          callStats.fetchFailed++;
          totals.fetchFailed++;
        }
        return null;
      }

      if (!fetched) {
        callStats.fetchFailed++;
        totals.fetchFailed++;
        return null;
      }
      // SSRF rejection: degrade to unclassified, count SEPARATELY from
      // fetch failures, log at warn, never throw.
      if (fetched.ssrfRejected) {
        callStats.ssrfRejected++;
        totals.ssrfRejected++;
        console.warn(
          `⚠️ ingest-shot-classify SSRF rejected: ${fetched.ssrfReason || fetched.error || 'blocked'} url=${url}`
        );
        return null;
      }
      if (fetched.tooLarge) {
        callStats.tooLarge++;
        totals.tooLarge++;
        return null;
      }
      if (!fetched.ok || !fetched.buffer || !fetched.buffer.length) {
        // Distinguish timeout-ish statuses if the client surfaces them.
        if (fetched.error && /aborted|timeout|Timeout/i.test(fetched.error)) {
          callStats.timedOut++;
          totals.timedOut++;
        } else {
          callStats.fetchFailed++;
          totals.fetchFailed++;
        }
        return null;
      }

      // CPU/decode bound — see classifyWithCpuGuard (does NOT cancel libvips).
      const cpuBefore = totals.cpuTimedOut;
      let classified;
      try {
        classified = await classifyWithCpuGuard(fetched.buffer);
      } catch (_) {
        return null;
      }
      if (totals.cpuTimedOut > cpuBefore) {
        callStats.cpuTimedOut++;
        // Treat as failed/unclassified (already counted in totals.cpuTimedOut).
        return null;
      }
      if (!classified || !classified.style) return null;

      return {
        url,
        style: classified.style,
        confidence: classified.confidence,
        at: new Date(now())
      };
    }

    const workers = [];
    const nWorkers = Math.min(concurrency, Math.max(pending.length, 0));
    for (let i = 0; i < nWorkers; i++) workers.push(worker());
    if (workers.length) {
      try {
        await Promise.all(workers);
      } catch (_) {
        // individual workers swallow; this is defensive
      }
    }

    // Prune to the product's current image set so rotated-out URLs do not
    // accumulate forever across re-syncs.
    const entries = mergeStyleEntries(existing, fresh, list);
    // changed if we classified anything new OR pruned something
    const pruned =
      entries.length !== existing.length ||
      entries.some((e) => {
        const prev = existingByUrl.get(e.url);
        return !prev || prev.style !== e.style || prev.confidence !== e.confidence;
      }) ||
      existing.some((e) => e && e.url && !entries.find((x) => x.url === e.url));

    return {
      entries,
      fresh,
      changed: fresh.length > 0 || pruned,
      stats: callStats
    };
  }

  /**
   * Convenience: hero + alts → merged style entries.
   */
  async function classifyProductImages({ imageUrl, additionalImages, existingStyles } = {}) {
    const urls = collectProductImageUrls(imageUrl, additionalImages);
    return classifyUrls(urls, existingStyles || []);
  }

  function getTotals() {
    return {
      ...totals,
      budgetMs,
      cpuMs,
      // elapsed is relative to classify-phase start; 0 if phase never began
      elapsedMs: phaseStarted && startedAt != null ? now() - startedAt : 0,
      budgetExhausted,
      phaseStarted,
      concurrency,
      timeoutMs,
      maxBytes
    };
  }

  function logSummary(label = 'ingest-shot-classify') {
    const t = getTotals();
    console.log(
      `📷 ${label}: classified=${t.classified} ` +
      `skipExisting=${t.skippedExisting} skipBudget=${t.skippedBudget} ` +
      `abandoned=${t.skippedAbandoned}` +
      (t.abandonReason ? `(${t.abandonReason})` : '') + ' ' +
      `fetchFail=${t.fetchFailed} ssrfReject=${t.ssrfRejected} ` +
      `timeout=${t.timedOut} tooLarge=${t.tooLarge} ` +
      `cpuTimeout=${t.cpuTimedOut} ` +
      `classifyFail=${t.failed} considered=${t.considered} ` +
      `maxInFlight=${t.maxInFlight}/${concurrency} ` +
      `elapsedMs=${t.elapsedMs} budgetMs=${t.budgetMs}` +
      (t.budgetExhausted ? ' BUDGET_EXHAUSTED' : '') +
      (!t.phaseStarted && t.skippedAbandoned > 0
        ? ` — ${t.skippedAbandoned} URL(s) never attempted (classify phase skipped)`
        : '') +
      (t.skippedBudget > 0
        ? ` — ${t.skippedBudget} URL(s) deferred to detect-time fallback`
        : '')
    );
    return t;
  }

  function dispose() {
    if (budgetTimer != null) {
      clearTimeout(budgetTimer);
      budgetTimer = null;
    }
    try { budgetAc.abort(); } catch { /* ignore */ }
  }

  return {
    beginClassifyPhase,
    hasClassifyPhaseStarted,
    abandonPending,
    classifyUrls,
    classifyProductImages,
    getTotals,
    logSummary,
    dispose,
    // exposed for harnesses
    _config: { concurrency, timeoutMs, maxBytes, budgetMs, cpuMs }
  };
}

module.exports = {
  isEnabled,
  createSession,
  storedStyleForUrl,
  technicalInsightsFromStored,
  technicalInsightsTimestampMs,
  shouldApplyStoredShot,
  mergeStyleEntries,
  collectProductImageUrls,
  // SSRF surface (exported for harness + reuse)
  isBlockedIp,
  assertUrlSafeForFetch,
  safeFetchBuffer,
  makePinnedLookup,
  DEFAULTS
};
