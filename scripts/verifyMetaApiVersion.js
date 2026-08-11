#!/usr/bin/env node
'use strict';
//
// verifyMetaApiVersion — fences the single-owner Meta Graph API version.
//
// WHY THIS EXISTS
// Graph API versions expire on a Meta-published cadence. Production ran an
// expired hardcoded fallback because ~12 call sites each inlined
// `process.env.META_API_VERSION || 'v…'` and the env var was set nowhere.
// All Graph / OAuth call sites must import services/metaApiVersion.js; no
// file may re-read the env or re-hardcode a version string.
//
// Also fences the fail-open posture: a malformed env typo must NOT crash
// boot (falls back to DEFAULT + fatal alert). A malformed DEFAULT still
// throws (developer error). KNOWN_EXPIRED tripwire covers the real outage
// class the format regex cannot see — and that list is Marketing-API-driven
// (v19.0–v25.0), not just the Graph-expired pair.
//
// Offline: no DB, no network, no API keys, no real Slack.
//   node scripts/verifyMetaApiVersion.js

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const OWNER = path.join(ROOT, 'services', 'metaApiVersion.js');
const OWNER_REL = path.join('services', 'metaApiVersion.js');
const HARNESS_REL = path.join('scripts', 'verifyMetaApiVersion.js');

// Every file that builds a Meta Graph / OAuth URL. Explicit so a future
// call site added without the shared import fails this harness.
const GRAPH_CALL_SITES = [
  'routes/integrations.js',
  'services/instagramOAuthService.js',
  'services/instagramWebhookService.js',
  'services/instagramCommentService.js',
  'services/postSyncService.js',
  'services/catalogSyncService.js',
  'services/mediaInsightsService.js',
  'services/metaAdsOAuthService.js',
  'services/metaAdsPushService.js',
  'services/metaAdsCampaignService.js',
  'services/metaAdsCreativeMatcher.js',
  'services/metaAdsFontService.js',
];

const SCAN_DIRS = ['services', 'routes', 'pipelines', 'models', 'scripts'];

// Places a Graph version *literal* is legitimate. Anywhere else a
// facebook.com/vN.N URL (or a version-ish assignment / `|| 'vN.N'` fallback)
// is the original regression class. Keep this list explicit and narrow.
const VERSION_LITERAL_ALLOWLIST = new Set([
  OWNER_REL,
  HARNESS_REL,
]);

// Expected KNOWN_EXPIRED tripwire (Marketing-API-driven; see owner module).
const EXPECTED_EXPIRED = [
  'v19.0', 'v20.0', 'v21.0', 'v22.0', 'v23.0', 'v24.0', 'v25.0',
];
const EXPECTED_EXPIRED_META = {
  'v19.0': { expires: '2025-02-04', level: 'fatal', surface: 'Marketing API' },
  'v20.0': { expires: '2026-09-24', level: 'fatal', surface: 'Marketing API' },
  'v21.0': { expires: 'elapsed (pre-v26.0)', level: 'fatal', surface: 'Marketing API' },
  'v22.0': { expires: 'elapsed (pre-v26.0)', level: 'fatal', surface: 'Marketing API' },
  'v23.0': { expires: 'elapsed (pre-v26.0)', level: 'fatal', surface: 'Marketing API' },
  'v24.0': { expires: 'elapsed (pre-v26.0)', level: 'fatal', surface: 'Marketing API' },
  'v25.0': { expires: '2026-10-27', level: 'warn', surface: 'Marketing API' },
};

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, acc);
    else if (/\.(js|json|md|env|ts)$/.test(ent.name) || !ent.name.includes('.')) {
      // only source-ish files; skip binaries
      if (/\.(js|cjs|mjs|ts|json|md|txt|env)$/.test(ent.name)) acc.push(full);
    }
  }
  return acc;
}

function clearModuleCache() {
  const modPath = require.resolve('../services/metaApiVersion');
  delete require.cache[modPath];
  try { delete require.cache[require.resolve('../services/alertService')]; } catch { /* ok */ }
}

function loadResolverWithEnv(envValue) {
  clearModuleCache();
  if (envValue === undefined) delete process.env.META_API_VERSION;
  else process.env.META_API_VERSION = envValue;
  return require('../services/metaApiVersion');
}

function tryLoad(envValue) {
  try {
    const mod = loadResolverWithEnv(envValue);
    return { ok: true, mod };
  } catch (err) {
    return { ok: false, err };
  }
}

/**
 * Re-require the owner module with a stubbed alertService in the require
 * cache so we can assert notifyAsync was actually invoked — fully offline,
 * no real Slack. Installs the stub BEFORE the owner module loads so the
 * lazy require inside alertInvalidEnv / alertKnownExpired hits the stub.
 */
function loadWithStubbedAlerts(envValue) {
  clearModuleCache();
  const alertPath = require.resolve('../services/alertService');
  const calls = [];
  // Pre-seed the cache so the owner's lazy require('./alertService') returns
  // our spy. Mimic a fully-loaded Module entry so Node does not re-read disk.
  const stub = new Module(alertPath);
  stub.filename = alertPath;
  stub.loaded = true;
  stub.exports = {
    notifyAsync(payload) { calls.push(payload); },
    notify() { /* unused */ },
  };
  require.cache[alertPath] = stub;

  if (envValue === undefined) delete process.env.META_API_VERSION;
  else process.env.META_API_VERSION = envValue;

  let mod;
  let err = null;
  try {
    mod = require('../services/metaApiVersion');
  } catch (e) {
    err = e;
  }
  return { ok: !err, mod, err, calls };
}

// ── helpers for Finding 3 / 4 scans ──────────────────────────────────

/** facebook.com (graph. or www.) URL carrying a hardcoded vN.N segment. */
const FB_URL_VERSION_RE =
  /(?:https?:\/\/)?(?:graph\.|www\.)?facebook\.com\/v\d+\.\d+/;

/**
 * Assignment of a version-ish identifier to a hardcoded vN.N string.
 * Catches `const META_API_VERSION = 'v21.0'` and `DEFAULT_… = 'v19.0'`.
 * Deliberately does NOT match bare vN.N in unrelated strings (model ids,
 * SPEC versions, etc.).
 */
const VERSION_ASSIGN_RE =
  /(?:META_API_VERSION|DEFAULT_META_API_VERSION|GRAPH_API_VERSION|META_GRAPH_VERSION|graphVersion|metaApiVersion|apiVersion)\s*=\s*['"`]v\d+\.\d+['"`]/;

/** Classic regression: `process.env.META_API_VERSION || 'v19.0'`. */
const VERSION_FALLBACK_RE =
  /\|\|\s*['"`]v\d+\.\d+['"`]/;

/** Import of the shared owner (services or sibling). */
const SHARED_IMPORT_RE =
  /require\(['"](?:\.\/metaApiVersion|\.\.\/services\/metaApiVersion)['"]\)/;

/**
 * META_API_VERSION is destructured (or namespaced) FROM the shared import —
 * not merely mentioned as an identifier next to an unrelated require.
 */
const ASSIGNED_FROM_SHARED_RE =
  /(?:const|let|var)\s*\{\s*[^}]*\bMETA_API_VERSION\b[^}]*\}\s*=\s*require\(['"](?:\.\/metaApiVersion|\.\.\/services\/metaApiVersion)['"]\)/;

/**
 * The imported identifier is actually USED to build a facebook URL
 * (template interpolation), not left as an unused import beside a
 * hardcoded `https://graph.facebook.com/v21.0`.
 */
const USES_IMPORTED_VERSION_RE =
  /(?:graph\.facebook\.com|www\.facebook\.com|facebook\.com)\/\$\{META_API_VERSION\}/;

function findVersionLiteralHits(text, rel) {
  const hits = [];
  if (FB_URL_VERSION_RE.test(text)) hits.push('facebook.com/vN.N URL');
  if (VERSION_ASSIGN_RE.test(text)) hits.push('version-ish assignment');
  // Fallback ban only outside the harness (harness fixtures exercise it).
  if (rel !== HARNESS_REL && VERSION_FALLBACK_RE.test(text)) {
    hits.push("`|| 'vN.N'` fallback");
  }
  return hits;
}

console.log('\nverifyMetaApiVersion\n');

// ── A. zero hardcoded Graph version literals outside allowlist ───────
// Finding 4: ban ANY vN.N adjacent to a facebook.com URL (or assigned to a
// version-ish identifier / classic `|| 'vN.N'` fallback), not just v19.0.
// Allowlist is exactly the owner module (default + KNOWN_EXPIRED table)
// and this harness's own fixtures/expectations.
{
  const hits = [];
  for (const d of SCAN_DIRS) {
    for (const f of walkFiles(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, f);
      if (VERSION_LITERAL_ALLOWLIST.has(rel)) continue;
      const text = fs.readFileSync(f, 'utf8');
      const kinds = findVersionLiteralHits(text, rel);
      if (kinds.length) hits.push(`${rel} (${kinds.join('; ')})`);
    }
  }
  check('A1 zero hardcoded Graph version literals outside allowlist',
    hits.length === 0,
    hits.length ? `found in: ${hits.join(', ')}` : '');
  check('A2 allowlist is explicit and narrow (owner + harness only)',
    VERSION_LITERAL_ALLOWLIST.size === 2 &&
      VERSION_LITERAL_ALLOWLIST.has(OWNER_REL) &&
      VERSION_LITERAL_ALLOWLIST.has(HARNESS_REL));
  // Sanity: owner itself DOES carry literals (default + KNOWN_EXPIRED) —
  // if the scanner ever went global without an allowlist it would self-fail.
  {
    const ownerSrc = fs.readFileSync(OWNER, 'utf8');
    check('A3 owner module carries the expected default literal v26.0',
      /DEFAULT_META_API_VERSION\s*=\s*'v26\.0'/.test(ownerSrc));
  }
}

// ── B. single owner of process.env.META_API_VERSION ──────────────────
{
  const readers = [];
  for (const d of SCAN_DIRS) {
    for (const f of walkFiles(path.join(ROOT, d))) {
      const text = fs.readFileSync(f, 'utf8');
      if (!/process\.env\.META_API_VERSION/.test(text)) continue;
      const rel = path.relative(ROOT, f);
      if (rel === OWNER_REL) continue;
      if (rel === HARNESS_REL) continue;
      readers.push(rel);
    }
  }
  check('B1 only services/metaApiVersion.js reads process.env.META_API_VERSION',
    readers.length === 0,
    readers.length ? `also reads env: ${readers.join(', ')}` : '');
  check('B2 owner module exists', fs.existsSync(OWNER));
  const ownerSrc = fs.readFileSync(OWNER, 'utf8');
  check('B3 owner reads process.env.META_API_VERSION',
    /process\.env\.META_API_VERSION/.test(ownerSrc));
  check('B4 owner DEFAULT_META_API_VERSION is the verified v26.0',
    /DEFAULT_META_API_VERSION\s*=\s*'v26\.0'/.test(ownerSrc) &&
    !/__META_VERSION_TBD__/.test(ownerSrc) &&
    !/TODO\(owner-verify\)/.test(ownerSrc));
  check('B5 owner exports resolveMetaApiVersion',
    /function resolveMetaApiVersion/.test(ownerSrc) &&
    /module\.exports/.test(ownerSrc));
}

// ── C. pure resolver: format + fallback + injected-default throw ─────
{
  // Unset env so module load uses the real default; pure fn still testable.
  const loaded = tryLoad(undefined);
  check('C0 module loads with unset env (valid default)', loaded.ok,
    loaded.ok ? '' : String(loaded.err && loaded.err.message));
  const resolve = loaded.ok ? loaded.mod.resolveMetaApiVersion : null;
  const re = loaded.ok ? loaded.mod.META_API_VERSION_RE : null;
  const DEFAULT = loaded.ok ? loaded.mod.DEFAULT_META_API_VERSION : null;

  // Malformed env → fall back to default, do NOT throw.
  check('C1 bare major.minor without v prefix falls back (no throw)',
    resolve ? (() => {
      try { return resolve('19.0') === DEFAULT; } catch { return false; }
    })() : false);
  check('C2 major-only (v19) falls back (no throw)',
    resolve ? (() => {
      try { return resolve('v19') === DEFAULT; } catch { return false; }
    })() : false);
  check('C3 empty string uses default (no throw)',
    resolve ? (() => {
      try { return resolve('') === DEFAULT; } catch { return false; }
    })() : false);
  check('C4 "latest" falls back (no throw)',
    resolve ? (() => {
      try { return resolve('latest') === DEFAULT; } catch { return false; }
    })() : false);
  // Well-formed but known-expired still *resolves* (fail-open); tripwire is
  // a separate callback, not a throw. v26.0 is the live default.
  check('C5 accepts well-formed v26.0',
    resolve ? resolve('v26.0') === 'v26.0' : false);
  check('C6 accepts well-formed v88.0 (unknown future)',
    resolve ? resolve('v88.0') === 'v88.0' : false);
  check('C7 accepts v3.14 (any digits)',
    resolve ? resolve('v3.14') === 'v3.14' : false);
  check('C8 VERSION_RE matches vN.N only',
    re ? (re.test('v21.0') && !re.test('19.0') && !re.test('v19') && !re.test('latest')) : false);
  check('C9 empty/null falls through to valid default (no throw)',
    resolve ? (() => {
      try {
        return resolve(null) === DEFAULT && resolve(undefined) === DEFAULT;
      } catch { return false; }
    })() : false);
  check('C10 whitespace-only falls through to valid default (no throw)',
    resolve ? (() => {
      try { return resolve('   ') === DEFAULT; } catch { return false; }
    })() : false);
  check('C11 trims well-formed env values',
    resolve ? resolve('  v26.0  ') === 'v26.0' : false);

  // Malformed DEFAULT (injected) still throws — developer error.
  check('C12 malformed injected default throws',
    resolve ? (() => {
      try {
        resolve('v26.0', { defaultVersion: 'not-a-version' });
        return false;
      } catch (err) {
        return /DEFAULT_META_API_VERSION/.test(String(err && err.message));
      }
    })() : false);
  check('C13 malformed injected default throws even when env empty',
    resolve ? (() => {
      try {
        resolve(null, { defaultVersion: '25.0' });
        return false;
      } catch (err) {
        return /DEFAULT_META_API_VERSION/.test(String(err && err.message));
      }
    })() : false);
  check('C14 onInvalidEnv callback fires on malformed env (pure seam)',
    resolve ? (() => {
      try {
        let seen = null;
        const out = resolve('25.0', {
          onInvalidEnv: (raw, fallback) => { seen = { raw, fallback }; },
        });
        return out === DEFAULT &&
          seen && seen.raw === '25.0' && seen.fallback === DEFAULT;
      } catch {
        // Regression: throw-on-malformed reintroduced. Must fail closed here.
        return false;
      }
    })() : false);
}

// ── D. env var overrides / fail-open at module load ──────────────────
{
  const a = tryLoad('v88.0');
  check('D1 env META_API_VERSION=v88.0 wins at load',
    a.ok && a.mod.META_API_VERSION === 'v88.0',
    a.ok ? `got ${a.mod.META_API_VERSION}` : String(a.err && a.err.message));

  // Malformed env must NOT throw at boot — fall back to default.
  for (const bad of ['25.0', 'v25', 'latest', ' ']) {
    const r = tryLoad(bad);
    check(`D2 malformed env "${bad}" falls back, does NOT throw`,
      r.ok && r.mod.META_API_VERSION === r.mod.DEFAULT_META_API_VERSION,
      r.ok
        ? `got ${r.mod.META_API_VERSION}`
        : `threw: ${r.err && r.err.message}`);
  }

  const c = tryLoad(undefined);
  check('D3 unset env uses DEFAULT (v26.0), loads successfully',
    c.ok &&
      c.mod.META_API_VERSION === 'v26.0' &&
      c.mod.DEFAULT_META_API_VERSION === 'v26.0',
    c.ok
      ? `got META=${c.mod.META_API_VERSION} DEFAULT=${c.mod.DEFAULT_META_API_VERSION}`
      : String(c.err && c.err.message));

  // Restore a valid env so any later accidental require does not poison
  // the process; then drop the cache again so we leave no stale module.
  tryLoad('v99.0');
  clearModuleCache();
  delete process.env.META_API_VERSION;
}

// ── E. every Graph call site imports AND USES the shared module ──────
// Finding 3: do not merely match the identifier name. An unused import
// plus a hardcoded `https://graph.facebook.com/v21.0` must fail.
{
  for (const rel of GRAPH_CALL_SITES) {
    const full = path.join(ROOT, rel);
    const exists = fs.existsSync(full);
    check(`E exists ${rel}`, exists);
    if (!exists) continue;
    const text = fs.readFileSync(full, 'utf8');

    check(`E imports shared module: ${rel}`,
      SHARED_IMPORT_RE.test(text),
      'must require services/metaApiVersion (or ./metaApiVersion)');

    check(`E assigns META_API_VERSION from shared import: ${rel}`,
      ASSIGNED_FROM_SHARED_RE.test(text),
      'META_API_VERSION must be destructured from the shared require, not merely mentioned');

    check(`E uses imported META_API_VERSION in facebook URL: ${rel}`,
      USES_IMPORTED_VERSION_RE.test(text),
      'must interpolate ${META_API_VERSION} into a graph/facebook.com URL');

    check(`E no hardcoded facebook.com/vN.N URL: ${rel}`,
      !FB_URL_VERSION_RE.test(text),
      'hardcoded Graph version literal in a facebook.com URL');

    check(`E no local env fallback: ${rel}`,
      !/process\.env\.META_API_VERSION\s*\|\|/.test(text),
      'still has process.env.META_API_VERSION || …');
  }
}

// ── F. owner is the only DEFAULT_META_API_VERSION definition ─────────
{
  const defs = [];
  for (const d of SCAN_DIRS) {
    for (const f of walkFiles(path.join(ROOT, d))) {
      const text = fs.readFileSync(f, 'utf8');
      if (!/DEFAULT_META_API_VERSION/.test(text)) continue;
      const rel = path.relative(ROOT, f);
      if (rel === HARNESS_REL) continue;
      defs.push(rel);
    }
  }
  check('F1 DEFAULT_META_API_VERSION only in owner module',
    defs.length === 1 && defs[0] === OWNER_REL,
    `found in: ${defs.join(', ') || '(none)'}`);
}

// ── G. verified default + KNOWN_EXPIRED tripwire (v19–v25) ───────────
// Finding 1: Marketing-API-driven list, not just Graph-expired v19/v20.
{
  const loaded = tryLoad(undefined);
  check('G0 loads offline with no Slack configured',
    loaded.ok,
    loaded.ok ? '' : String(loaded.err && loaded.err.message));
  if (loaded.ok) {
    const {
      DEFAULT_META_API_VERSION,
      META_API_VERSION_RE,
      KNOWN_EXPIRED,
      KNOWN_EXPIRED_META,
      resolveMetaApiVersion,
      META_API_VERSION,
    } = loaded.mod;

    check('G1 DEFAULT_META_API_VERSION === v26.0',
      DEFAULT_META_API_VERSION === 'v26.0');
    check('G2 DEFAULT matches META_API_VERSION_RE',
      META_API_VERSION_RE.test(DEFAULT_META_API_VERSION));
    check('G3 DEFAULT is NOT in KNOWN_EXPIRED',
      !KNOWN_EXPIRED.includes(DEFAULT_META_API_VERSION),
      `default ${DEFAULT_META_API_VERSION} is listed as expired — refuse to ship`);
    check('G4 resolved META_API_VERSION with unset env is v26.0',
      META_API_VERSION === 'v26.0');

    check('G5 KNOWN_EXPIRED covers v19.0 through v25.0',
      Array.isArray(KNOWN_EXPIRED) &&
        EXPECTED_EXPIRED.every((v) => KNOWN_EXPIRED.includes(v)) &&
        KNOWN_EXPIRED.length === EXPECTED_EXPIRED.length,
      `got [${(KNOWN_EXPIRED || []).join(', ')}]`);

    let metaOk = true;
    const metaDetail = [];
    for (const v of EXPECTED_EXPIRED) {
      const expected = EXPECTED_EXPIRED_META[v];
      const actual = KNOWN_EXPIRED_META && KNOWN_EXPIRED_META[v];
      if (!actual) {
        metaOk = false;
        metaDetail.push(`${v}: missing`);
        continue;
      }
      if (actual.expires !== expected.expires ||
          actual.level !== expected.level ||
          actual.surface !== expected.surface) {
        metaOk = false;
        metaDetail.push(
          `${v}: got expires=${actual.expires} level=${actual.level} ` +
          `surface=${actual.surface}`
        );
      }
    }
    check('G6 KNOWN_EXPIRED_META dates/levels/surfaces match Marketing-driven table',
      metaOk,
      metaDetail.join('; '));

    check('G7 v19–v24 are fatal; v25.0 is warn (Marketing near-expiry)',
      EXPECTED_EXPIRED.slice(0, 6).every(
        (v) => KNOWN_EXPIRED_META[v] && KNOWN_EXPIRED_META[v].level === 'fatal'
      ) && KNOWN_EXPIRED_META['v25.0'] && KNOWN_EXPIRED_META['v25.0'].level === 'warn');

    // Known-expired still resolves (fail-open) but fires callback.
    let expiredSeen = null;
    const out = resolveMetaApiVersion('v19.0', {
      onKnownExpired: (v, meta) => { expiredSeen = { v, meta }; },
    });
    check('G8 known-expired version still resolves (no throw)',
      out === 'v19.0');
    check('G9 onKnownExpired fires for v19.0 (fatal, Marketing API)',
      expiredSeen && expiredSeen.v === 'v19.0' &&
        expiredSeen.meta && expiredSeen.meta.level === 'fatal' &&
        expiredSeen.meta.surface === 'Marketing API');

    let midSeen = null;
    resolveMetaApiVersion('v22.0', {
      onKnownExpired: (v, meta) => { midSeen = { v, meta }; },
    });
    check('G10 onKnownExpired fires for v22.0 (was invisible under old v19/v20-only list)',
      midSeen && midSeen.v === 'v22.0' &&
        midSeen.meta && midSeen.meta.level === 'fatal');

    let warnSeen = null;
    resolveMetaApiVersion('v25.0', {
      onKnownExpired: (v, meta) => { warnSeen = { v, meta }; },
    });
    check('G11 onKnownExpired fires for v25.0 near-expiry as warn',
      warnSeen && warnSeen.v === 'v25.0' &&
        warnSeen.meta && warnSeen.meta.level === 'warn' &&
        warnSeen.meta.surface === 'Marketing API');

    // Owner source must document the Graph-vs-Marketing distinction so the
    // list is not "simplified" back to the Graph-expired pair.
    const ownerSrc = fs.readFileSync(OWNER, 'utf8');
    check('G12 owner comments name Graph vs Marketing API clocks',
      /Marketing API/.test(ownerSrc) &&
        /90\s*DAYS/i.test(ownerSrc) &&
        /Graph/.test(ownerSrc));
  } else {
    for (const id of [
      'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12',
    ]) check(`${id} skipped (module failed to load)`, false);
  }
}

// ── H. alert path: source shape + BEHAVIOURAL wiring proof ───────────
// Finding 2: H1–H6 source scans alone cannot catch deleting
// onInvalidEnv / onKnownExpired from the module-load resolve call.
// Behavioural spies (pure + stubbed alertService at load) pin the wiring.
{
  const ownerSrc = fs.readFileSync(OWNER, 'utf8');
  check('H1 owner source calls notifyAsync',
    /notifyAsync\s*\(/.test(ownerSrc));
  check('H2 owner never awaits notifyAsync',
    !/await\s+notifyAsync\s*\(/.test(ownerSrc));
  // Also catch `await alerts.notifyAsync` / assigned-then-awaited patterns
  // that would reintroduce a hard Slack dependency on the boot path.
  check('H3 no await on any notify* call in owner',
    !/await\s+[^\n;]*notify/.test(ownerSrc));
  check('H4 alertService is lazy-required (not top-level)',
    !/^const\s*\{[^}]*notifyAsync[^}]*\}\s*=\s*require\(['"]\.\/alertService['"]\)/m.test(ownerSrc) &&
    !/^const\s+\w+\s*=\s*require\(['"]\.\/alertService['"]\)/m.test(ownerSrc) &&
    /require\(['"]\.\/alertService['"]\)/.test(ownerSrc));
  check('H5 alert key meta-api-version:invalid present',
    /meta-api-version:invalid/.test(ownerSrc));
  check('H6 fatal level used for invalid env',
    /level:\s*'fatal'/.test(ownerSrc));

  // Fully offline: no SLACK_* env, harness still green after a load that
  // exercises the alert path (malformed env at module load).
  const prevToken = process.env.SLACK_BOT_TOKEN;
  const prevChan = process.env.SLACK_ALERT_CHANNEL;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ALERT_CHANNEL;
  const offline = tryLoad('not-a-version');
  check('H7 malformed env with no Slack still loads (offline)',
    offline.ok && offline.mod.META_API_VERSION === offline.mod.DEFAULT_META_API_VERSION,
    offline.ok
      ? `got ${offline.mod.META_API_VERSION}`
      : String(offline.err && offline.err.message));

  // ── H8/H9: pure resolver with injected spy callbacks ──────────────
  {
    const loaded = tryLoad(undefined);
    const resolve = loaded.ok ? loaded.mod.resolveMetaApiVersion : null;
    const DEFAULT = loaded.ok ? loaded.mod.DEFAULT_META_API_VERSION : null;

    check('H8 pure onInvalidEnv spy fires for malformed env',
      resolve ? (() => {
        let seen = null;
        const out = resolve('not-a-version', {
          onInvalidEnv: (raw, fallback) => { seen = { raw, fallback }; },
        });
        return out === DEFAULT &&
          seen && seen.raw === 'not-a-version' && seen.fallback === DEFAULT;
      })() : false);

    check('H9 pure onKnownExpired spy fires for a KNOWN_EXPIRED version',
      resolve ? (() => {
        let seen = null;
        const out = resolve('v19.0', {
          onKnownExpired: (v, meta) => { seen = { v, meta }; },
        });
        return out === 'v19.0' &&
          seen && seen.v === 'v19.0' &&
          seen.meta && seen.meta.level === 'fatal';
      })() : false);
  }

  // ── H10/H11: module load path actually invokes notifyAsync ────────
  // Stub alertService in the require cache, re-require the owner with a
  // bad env / expired env, and assert the real alert helpers fired.
  // Deleting onInvalidEnv / onKnownExpired from the load-site resolve
  // call is exactly the hole these catch (source scans of the helpers
  // stay green while boot fails open with no Slack alert at all).
  {
    const malformed = loadWithStubbedAlerts('not-a-version');
    check('H10 load-path notifyAsync fires for malformed env (wired onInvalidEnv)',
      malformed.ok &&
        malformed.mod.META_API_VERSION === malformed.mod.DEFAULT_META_API_VERSION &&
        malformed.calls.some(
          (c) => c && c.key === 'meta-api-version:invalid' && c.level === 'fatal'
        ),
      malformed.ok
        ? `calls=${JSON.stringify(malformed.calls)}`
        : String(malformed.err && malformed.err.message));

    const expired = loadWithStubbedAlerts('v19.0');
    check('H11 load-path notifyAsync fires for known-expired version (wired onKnownExpired)',
      expired.ok &&
        expired.mod.META_API_VERSION === 'v19.0' &&
        expired.calls.some(
          (c) => c &&
            c.key === 'meta-api-version:expired:v19.0' &&
            c.level === 'fatal'
        ),
      expired.ok
        ? `calls=${JSON.stringify(expired.calls)}`
        : String(expired.err && expired.err.message));

    // Also cover a mid-range expired version that the old list missed, to
    // pin that the load-path wiring is not accidentally v19-only.
    const mid = loadWithStubbedAlerts('v23.0');
    check('H12 load-path notifyAsync fires for v23.0 (Marketing-expired, not just v19)',
      mid.ok &&
        mid.mod.META_API_VERSION === 'v23.0' &&
        mid.calls.some(
          (c) => c && c.key === 'meta-api-version:expired:v23.0'
        ),
      mid.ok
        ? `calls=${JSON.stringify(mid.calls)}`
        : String(mid.err && mid.err.message));
  }

  // ── H13: source-level proof the load call passes both callbacks ────
  // Belt-and-braces beside the behavioural spies: the module-load
  // resolveMetaApiVersion(...) invocation must name both option keys.
  // (Behavioural H10/H11 are the real fence; this catches a rename that
  // still somehow invoked notifyAsync via a different path.)
  {
    // Match the top-level resolve call that seeds META_API_VERSION.
    const loadCall =
      /const\s+META_API_VERSION\s*=\s*resolveMetaApiVersion\s*\(\s*process\.env\.META_API_VERSION\s*,\s*\{([\s\S]*?)\}\s*\)/;
    const m = ownerSrc.match(loadCall);
    const body = m ? m[1] : '';
    check('H13 module-load resolve passes onInvalidEnv + onKnownExpired',
      !!m &&
        /onInvalidEnv\s*:/.test(body) &&
        /onKnownExpired\s*:/.test(body),
      m ? `load-call body: ${body.trim()}` : 'META_API_VERSION = resolveMetaApiVersion(...) not found');
  }

  // restore any prior Slack env (usually unset in harness)
  if (prevToken !== undefined) process.env.SLACK_BOT_TOKEN = prevToken;
  else delete process.env.SLACK_BOT_TOKEN;
  if (prevChan !== undefined) process.env.SLACK_ALERT_CHANNEL = prevChan;
  else delete process.env.SLACK_ALERT_CHANNEL;
}

// ── I. config/defaults.env is blank or v26.0, never the placeholder ──
{
  const envPath = path.join(ROOT, 'config', 'defaults.env');
  check('I1 config/defaults.env exists', fs.existsSync(envPath));
  if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, 'utf8');
    check('I2 defaults.env has META_API_VERSION key',
      /^META_API_VERSION=/m.test(envText));
    const m = envText.match(/^META_API_VERSION=(.*)$/m);
    const val = m ? m[1].trim() : null;
    check('I3 META_API_VERSION is blank or v26.0 (never placeholder)',
      val === '' || val === 'v26.0',
      `got META_API_VERSION=${JSON.stringify(val)}`);
    check('I4 defaults.env has no __META_VERSION_TBD__',
      !envText.includes('__META_VERSION_TBD__'));
  } else {
    check('I2 defaults.env has META_API_VERSION key', false);
    check('I3 META_API_VERSION is blank or v26.0 (never placeholder)', false);
    check('I4 defaults.env has no __META_VERSION_TBD__', false);
  }
}

// Leave process clean.
clearModuleCache();
delete process.env.META_API_VERSION;

if (failures.length) {
  console.error(`❌ verifyMetaApiVersion: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyMetaApiVersion: ${pass}/${pass} checks passed`);
