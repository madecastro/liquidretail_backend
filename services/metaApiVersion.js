'use strict';
//
// Single owner of the Meta Graph API version string used by every
// Graph / OAuth call site in this repo.
//
// WHY THIS EXISTS
// Roughly a dozen files each inlined `process.env.META_API_VERSION || 'vNN.N'`
// with a hardcoded expired Graph API version. The env var was set nowhere, so
// production ran that expired version after Meta sunset it (2026-05-21).
// Centralising the string means one place to bump the version, and the
// resolution below keeps a bad env typo from taking down the whole platform.
//
// OVERRIDE: set META_API_VERSION in the environment (or config/defaults.env).
// Env always wins over the module default when well-formed.
//
// FAIL-OPEN ON ENV TYPOS
// A malformed META_API_VERSION must NOT crash web/worker boot — that turns a
// one-integration typo into an ad-generation outage. Fall back to the known-
// good DEFAULT and raise a fatal alert instead. A malformed DEFAULT itself
// still throws: that is a developer error the harness catches pre-deploy.

// Verified against Meta's own changelogs + versioning docs (2026-08-11).
//
// WHY v26.0 AND NOT v25.0 — the Marketing API clock, not the Graph API clock:
// Graph API core versions get a ~2-year support guarantee, but the MARKETING
// API (act_<id>/campaigns, /ads, /adimages, /advideos, insights — i.e. every
// money-facing call here) guarantees only ~90 DAYS past the next release.
// v26.0 shipped 2026-07-29, so v25.0's Marketing API guarantee lapses around
// 2026-10-27. Picking v25.0 would mean re-migrating in ~11 weeks. Graph and
// Marketing API ship in lockstep with identical version numbers, so this one
// constant covers both surfaces.
//
// The earlier concern that v26.0 "removed commerce endpoints we depend on" was
// checked and REFUTED: those ~47 blocked endpoints are Commerce ORDER
// Management (orders, line items, payments, refunds, shipments) — not product
// catalog. /{catalog_id}/products, items_batch and product sets are untouched.
//
// Note what expiry actually does: Meta does NOT error on an expired version, it
// silently defaults the call to the next oldest usable version (with an
// auto-upgrade response header). That silence is exactly why this drifted
// unnoticed — hence the KNOWN_EXPIRED tripwire below.
const DEFAULT_META_API_VERSION = 'v26.0';

/** Graph API version shape Meta publishes: `v` + major + `.` + minor. */
const META_API_VERSION_RE = /^v\d+\.\d+$/;

// Tripwire only — not a full Meta calendar. If the RESOLVED version is listed
// here, alert but still proceed (fail-open).
//
// WHY THIS LIST IS LONG — Graph vs Marketing API clocks (do not "simplify"):
// Graph API core versions get ~2 years of support. The MARKETING API
// (act_<id>/campaigns, /ads, /adimages, /advideos, insights — every money-
// facing call in this repo) guarantees only ~90 DAYS past the next release.
// Graph and Marketing ship in lockstep with the same version numbers, but
// their support windows do not: a version that is still "live" on the Graph
// clock can already be dead for ads. v26.0 shipped 2026-07-29, so every
// version from v19.0 through v25.0 is at or past its Marketing API window
// (v25.0 Marketing lapses ~2026-10-27). Narrowing this table back to the
// Graph-expired pair (v19/v20) is how v21–v25 would silently stop alerting
// while production kept calling a dead Marketing surface.
//
// `expires` is the tighter clock that drives the tripwire (Marketing when
// that is what bites; residual Graph date only when Marketing was already
// long gone and no tighter Marketing date is pinned). `surface` is named
// in alert text so the page is actionable.
//   version | Graph          | Marketing              | level
//   v19.0   | 2026-05-21     | 2025-02-04             | fatal
//   v20.0   | 2026-09-24     | long gone (pre-Graph)  | fatal
//   v21–24  | still open*    | elapsed (pre-v26.0)    | fatal
//   v25.0   | 2028-07-29     | ~2026-10-27            | warn
//   * Graph still viable for pure Graph calls; Marketing is what we ship.
const KNOWN_EXPIRED = Object.freeze([
  'v19.0', 'v20.0', 'v21.0', 'v22.0', 'v23.0', 'v24.0', 'v25.0',
]);
const KNOWN_EXPIRED_META = Object.freeze({
  'v19.0': {
    expires: '2025-02-04',
    graphExpires: '2026-05-21',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v20.0': {
    // Residual Graph clock; Marketing window long gone → still fatal.
    expires: '2026-09-24',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v21.0': {
    expires: 'elapsed (pre-v26.0)',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v22.0': {
    expires: 'elapsed (pre-v26.0)',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v23.0': {
    expires: 'elapsed (pre-v26.0)',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v24.0': {
    expires: 'elapsed (pre-v26.0)',
    level: 'fatal',
    surface: 'Marketing API',
  },
  'v25.0': {
    // Marketing ~90d after v26.0 (2026-07-29) ≈ 2026-10-27.
    // Graph still viable until 2028-07-29 — warn, not fatal, so pure-Graph
    // callers are not paged as hard while money-facing calls are flagged.
    expires: '2026-10-27',
    graphExpires: '2028-07-29',
    level: 'warn',
    surface: 'Marketing API',
  },
});

/**
 * Resolve + validate a Meta Graph API version string.
 *
 * Pure / offline-testable: no I/O, no Slack. Side effects (alerts, console)
 * are opt-in via callbacks so a config module stays easy to unit-test.
 *
 * @param {string|undefined|null} raw  env value or override; empty/null → default
 * @param {object} [opts]
 * @param {string} [opts.defaultVersion]  inject default (tests); else module default
 * @param {(raw: string, fallback: string) => void} [opts.onInvalidEnv]
 * @param {(version: string, meta: {expires: string, level: string}) => void} [opts.onKnownExpired]
 * @returns {string} well-formed version (e.g. 'v26.0')
 * @throws {Error} only when the DEFAULT itself is not `vN.N` (developer error)
 */
function resolveMetaApiVersion(raw, opts = {}) {
  const defaultVersion = (opts.defaultVersion != null)
    ? String(opts.defaultVersion)
    : DEFAULT_META_API_VERSION;

  // Malformed DEFAULT = build/dev bug. Throw immediately and clearly.
  if (!META_API_VERSION_RE.test(defaultVersion)) {
    throw new Error(
      `Invalid DEFAULT_META_API_VERSION "${defaultVersion}". Expected format vN.N ` +
      `(e.g. v26.0). Fix services/metaApiVersion.js — this is a developer error, ` +
      `not a config typo.`
    );
  }

  const trimmed = (raw == null) ? '' : String(raw).trim();
  let version;

  if (trimmed === '') {
    version = defaultVersion;
  } else if (!META_API_VERSION_RE.test(trimmed)) {
    // Malformed env → fail OPEN onto the known-good default. Do not throw.
    if (typeof opts.onInvalidEnv === 'function') {
      try { opts.onInvalidEnv(trimmed, defaultVersion); } catch { /* never block */ }
    }
    version = defaultVersion;
  } else {
    version = trimmed;
  }

  // Known-bad (expired / near-expiry) tripwire on the RESOLVED value.
  // Still proceed — the format guard cannot catch this class of failure.
  const expiredMeta = KNOWN_EXPIRED_META[version];
  if (expiredMeta && typeof opts.onKnownExpired === 'function') {
    try { opts.onKnownExpired(version, expiredMeta); } catch { /* never block */ }
  }

  return version;
}

/**
 * Fire-and-forget alert for a malformed env value. Lazy-requires alertService
 * so offline harnesses that only exercise the pure resolver never touch Slack.
 * Never throws; never awaited by callers.
 */
function alertInvalidEnv(raw, fallback) {
  const msg =
    `Invalid META_API_VERSION "${raw}". Expected format vN.N (e.g. v26.0). ` +
    `Falling back to DEFAULT_META_API_VERSION=${fallback}. Platform stays up; ` +
    `fix the env typo.`;
  try { console.error(`[metaApiVersion] ${msg}`); } catch { /* ignore */ }
  try {
    // Lazy require: keeps resolveMetaApiVersion pure and harnesses offline.
    const { notifyAsync } = require('./alertService');
    notifyAsync({
      level: 'fatal',
      title: 'Invalid META_API_VERSION — using default',
      key: 'meta-api-version:invalid',
      detail: msg,
      fields: {
        raw: String(raw),
        fallback: String(fallback),
      },
    });
  } catch (err) {
    try {
      console.error(
        `[metaApiVersion] alert failed (non-fatal): ${err && err.message}`
      );
    } catch { /* ignore */ }
  }
}

/**
 * Fire-and-forget alert when the resolved version is in KNOWN_EXPIRED.
 * warn = near-expiry (e.g. Marketing window lapsing while Graph still live);
 * fatal = already expired on the money-facing surface. Never throws; never awaited.
 */
function alertKnownExpired(version, meta) {
  const level = (meta && meta.level === 'fatal') ? 'fatal' : 'warn';
  const expires = (meta && meta.expires) || 'unknown';
  const surface = (meta && meta.surface) || 'Meta API';
  const graphExpires = meta && meta.graphExpires;
  const graphBit = graphExpires ? `; Graph API ${graphExpires}` : '';
  const msg =
    `META_API_VERSION=${version} is on the known-expired tripwire ` +
    `(${surface} expires/expired ${expires}${graphBit}). ` +
    `Bump services/metaApiVersion.js (and any env override) to a supported ` +
    `version — Marketing API money-facing calls need a live Marketing window, ` +
    `not only a live Graph clock.`;
  try {
    if (level === 'fatal') console.error(`[metaApiVersion] ${msg}`);
    else console.warn(`[metaApiVersion] ${msg}`);
  } catch { /* ignore */ }
  try {
    const { notifyAsync } = require('./alertService');
    notifyAsync({
      level,
      title: level === 'fatal'
        ? `META_API_VERSION ${version} is expired (${surface})`
        : `META_API_VERSION ${version} near expiry (${surface})`,
      key: `meta-api-version:expired:${version}`,
      detail: msg,
      fields: {
        version: String(version),
        expires: String(expires),
        surface: String(surface),
        level,
        ...(graphExpires ? { graphExpires: String(graphExpires) } : {}),
      },
    });
  } catch (err) {
    try {
      console.error(
        `[metaApiVersion] expired-version alert failed (non-fatal): ${err && err.message}`
      );
    } catch { /* ignore */ }
  }
}

// Resolved once at module load. Malformed env falls back + alerts; only a
// malformed DEFAULT (developer error) can throw and fail boot.
const META_API_VERSION = resolveMetaApiVersion(process.env.META_API_VERSION, {
  onInvalidEnv: alertInvalidEnv,
  onKnownExpired: alertKnownExpired,
});

module.exports = {
  META_API_VERSION,
  DEFAULT_META_API_VERSION,
  META_API_VERSION_RE,
  KNOWN_EXPIRED,
  KNOWN_EXPIRED_META,
  resolveMetaApiVersion,
  // exported for harness source scans / rare test injection
  alertInvalidEnv,
  alertKnownExpired,
};
