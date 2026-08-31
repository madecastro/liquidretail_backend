// Ingests REAL FONT FILES from a brand's Shopify THEME — a second, richer
// font source alongside the generic marketing-homepage scan
// (brandFontIngestService.js). Shopify themes NAME and SERVE their fonts as
// part of rendering the storefront (Liquid's `font_face` filter emits real
// `@font-face` rules with real CDN URLs — verified live, 2026-08-31, against
// a real production brand's storefront: see
// scripts/verifyShopifyThemeFontIngest.js's fixture header and this repo's
// PR description for the captured evidence), which is a strictly better
// signal than hoping a marketing page happens to expose the same CSS. This
// module exists to reach that signal EXPLICITLY, with a fallback ladder the
// generic scanner does not have (myshopify-backend discovery for a headless
// custom-domain frontend — see ingestShopifyThemeFonts's myshopify fallback
// below), rather than only
// picking it up as an accidental side effect of the generic scan.
//
// NOT gated on Brand.apifyDemo.method or Brand.isDemo. Any brand with a
// Shopify URL configured (Brand.apifyDemo.shopifyUrl, reusing
// shopifyAccessResolver.resolveStoreOrigin's exact cascade) is eligible,
// regardless of which catalog-ingest method (if any) that brand uses and
// regardless of whether it is a demo brand — owner directive 2026-08-31.
//
// TWO ACCESS PATHS, both independently functional (verify with either
// present or absent):
//   AUTHED  — Shopify Admin API (themes.json → themes/{id}/assets.json),
//             used ONLY when an Admin API access token resolves for this
//             brand's exact store host (resolveShopifyAdminCred). Lets us
//             enumerate EVERY CSS asset in the live theme by filename,
//             instead of only the ones a rendered homepage happens to
//             reference, and read config/settings_data.json's font-picker
//             selections (name-only evidence — see below).
//   PUBLIC  — no auth, always available: fetch the rendered storefront HTML
//             (reusing shopifyAccessResolver's origin resolution AND its
//             myshopify-backend discovery, for headless custom domains) and
//             parse @font-face out of it exactly like
//             brandFontIngestService does for a marketing page.
// AUTHED is tried first; on any failure (including "no credential resolves")
// this silently falls back to PUBLIC. Neither path is required for the
// other to work.
//
// ⚠️ NO PER-BRAND SHOPIFY OAUTH CREDENTIAL SYSTEM EXISTS IN THIS CODEBASE
// TODAY. Confirmed 2026-08-31: models/IntegrationCredential.js's `type` enum
// is `['instagram', 'meta-ads', 'google-ads']` — no 'shopify'. The only
// Admin API token anywhere in this repo is services/pushToShopify.js's
// single global `SHOPIFY_ACCESS_TOKEN`/`SHOPIFY_STORE_DOMAIN` env-var pair
// (one store, not per-brand). resolveShopifyAdminCred below reuses that same
// pair, scoped so it is NEVER sent to a brand whose resolved store host
// doesn't match it — so the AUTHED path is real, tested (via fixtures) code,
// but is DORMANT in production for essentially every brand until a real
// per-brand Shopify Admin/OAuth credential exists (the natural extension
// point: a fourth IntegrationCredential.type, exactly like meta-ads). Do not
// mistake "this code path exists" for "this code path is reachable today" —
// same class of trap CLAUDE.md §0 warns about for other features.
//
// LICENSING (owner directive 2026-08-31): Shopify's own curated font
// library is served from fonts.shopifycdn.com (confirmed live via DNS +
// HTTP — the host resolves and its CDN reports
// `source_app=cdn-shopify-fonts` in a CSP reporting-endpoint header) and
// includes faces licensed to the MERCHANT for their own storefront, not to
// us for re-rendering into ad creative. classifyShopifyFontSource treats
// ANY face served from that host as 'commercial' (same
// BRAND_FONT_ASSUME_LICENSED / needsLicense gate the existing commercial-
// foundry path already uses — see brandFontIngestService.js), regardless of
// whether the underlying face is itself open-licensed (e.g. Shopify
// self-hosts some Google fonts too) — we cannot tell the two apart from the
// URL alone, so this errs toward the license label, never toward silently
// mirroring. A theme SELF-hosting a face under the merchant's own domain
// (`cdn/shop/t/.../assets/*.woff2` — what Dawn-based themes typically do for
// the Google-fonts case) is NOT this host and is classified exactly like any
// other self-hosted face (brandFontIngestService.classifyFontSource —
// 'unknown', still ingested, license recorded for audit).
//
// RETRYABILITY matches the corrected website-path behaviour from 078dc07,
// NOT the billable meta-ads behaviour: both access paths here are free
// (plain HTTP), so a failure must NEVER permanently stamp the brand as done.
// See services/brandEnrichmentService.js's shopify-theme-fonts tier and
// services/brandFontPersistenceService.js's applyShopifyFontIngestResult —
// shopifyFontsIngestedAt is stamped ONLY on a call into that function, which
// only happens on the success path; the failure path only records
// shopifyFontsIngestError.
//
// Persists through the SAME Brand.customFonts / Brand.websiteFontUsage
// fields the website path uses (services/brandFontPersistenceService.js's
// applyShopifyFontIngestResult), so services/fontResolverService.js's
// existing ladder (buildFontLadders / resolveFamily / matchCustomFont) picks
// these faces up with NO resolver changes — a mirrored file here is
// indistinguishable to the resolver from a website-mirrored file except for
// the audit-only `source: 'shopify-theme'` tag on each customFonts entry.

'use strict';

const axios = require('axios');

const {
  UA,
  MAX_STYLESHEETS,
  collectStylesheets,
  parseFontFacesFromCss,
  dedupeFaces,
  aggregateFontUsageAcrossSheets,
  mirrorDiscoveredFace,
  classifyFontSource,
} = require('./brandFontIngestService');
const { resolveStoreOrigin, discoverMyshopifyDomain } = require('./shopifyAccessResolver');

const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_ADMIN_ASSETS = 12; // mirrors brandFontIngestService's MAX_STYLESHEETS budget

// Shopify's own curated font library CDN. See the licensing note above —
// substring-matched the same way COMMERCIAL_FOUNDRY_HOSTS is, in case of a
// regional/versioned subdomain (verified live: the bare host resolves and
// answers as a real CDN app today; a subdomain form has not been observed,
// this is defensive, not evidence of one existing).
const SHOPIFY_FONT_LIBRARY_HOSTS = ['fonts.shopifycdn.com'];

/**
 * classifyShopifyFontSource(url) → 'commercial' | 'google' | 'open' | 'unknown'
 *
 * Layers the Shopify-font-library licence rule on TOP of the existing
 * classifier rather than editing it — classifyFontSource must stay exactly
 * as it is for the website path (no behaviour change for existing brands).
 */
function classifyShopifyFontSource(url) {
  let host;
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch { return classifyFontSource(url); }
  if (SHOPIFY_FONT_LIBRARY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'commercial';
  return classifyFontSource(url);
}

// ── PUBLIC path: fetch a storefront's rendered HTML ─────────────────────

async function fetchHomepage(origin) {
  const res = await axios.get(origin, {
    timeout: 20_000,
    maxRedirects: 5,
    maxContentLength: MAX_HTML_BYTES,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
  });
  const html = typeof res.data === 'string' ? res.data : String(res.data || '');
  const pageUrl = res.request?.res?.responseUrl || origin;
  return { html, pageUrl };
}

/**
 * Resolve which origin(s) to try, richest-signal first. Reuses
 * shopifyAccessResolver's exact cascade (apifyDemo.shopifyUrl → shopifyUrl →
 * websiteUrl) so this module never disagrees with the catalog ingester about
 * which store a brand means. The myshopify-backend candidate is discovered
 * from the FIRST fetch's HTML (see ingestShopifyThemeFontsInner) rather than
 * a separate probe request — this module only fetches a homepage once per
 * candidate it actually tries.
 */
function primaryOrigin(brand) {
  return resolveStoreOrigin(brand);
}

// ── AUTHED path: Shopify Admin API ───────────────────────────────────────

/**
 * resolveShopifyAdminCred(originHostname) → {token, apiVersion} | null
 *
 * See the file header's licensing/credential note: there is no per-brand
 * Shopify OAuth store in this codebase today. This reuses the ONE existing
 * Admin API credential shape in the repo (services/pushToShopify.js's global
 * SHOPIFY_ACCESS_TOKEN / SHOPIFY_STORE_DOMAIN env pair), scoped so it is
 * NEVER used against a brand whose resolved store host doesn't match it —
 * a single configured token must not be replayed against an arbitrary
 * brand's arbitrary store.
 */
function resolveShopifyAdminCred(originHostname) {
  const configuredDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!configuredDomain || !token || !originHostname) return null;
  const configuredHost = String(configuredDomain).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (configuredHost !== String(originHostname).toLowerCase()) return null;
  return { token, apiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || '2023-07' };
}

async function adminGet(url, token) {
  return axios.get(url, {
    timeout: 20_000,
    headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' }
  });
}

/**
 * Best-effort extraction of font-picker family NAMES from a theme's
 * config/settings_data.json. This is NAME-ONLY EVIDENCE — Shopify's picker
 * value encodes a font handle (e.g. "assistant_n4"), not a URL, and there is
 * no verified public mapping from that handle to a downloadable file in this
 * codebase (no live authed credential exists to verify one against — see
 * the file header). Never treated as a file, never promoted to
 * Brand.fontFamily on its own; only ever added as `evidence` alongside real
 * @font-face-derived usage, same honesty rule metaAdsFontService's vision
 * names already follow.
 */
function extractShopifyPickerFontNames(settingsJsonText) {
  let data;
  try { data = JSON.parse(settingsJsonText); } catch { return []; }
  const current = data && typeof data.current === 'object' && data.current
    ? data.current
    : (data?.presets && typeof data.current === 'string' && data.presets[data.current]) || {};
  const out = [];
  for (const [key, val] of Object.entries(current || {})) {
    if (!/font/i.test(key) || typeof val !== 'string' || !val.trim()) continue;
    const m = val.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)_[nia]\d/i);
    const family = m ? m[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : val;
    out.push({ settingKey: key, rawValue: val, family });
  }
  return out;
}

/**
 * fetchViaAdmin(originHostname, cred, deps) → { sheets, pickerFonts, errors }
 *   sheets: [{css, baseUrl, from}] — same shape collectStylesheets returns,
 *     so callers can hand it straight to the same aggregation/parsing code
 *     the PUBLIC path and the website path both use.
 *
 * Only fetches CSS asset TEXT via the Admin API — actual font bytes are
 * always downloaded from the plain public CDN url() found inside that CSS
 * (mirrorDiscoveredFace → downloadFontFile, unauthenticated), never via an
 * Admin API attachment. That keeps exactly one, already-verified-live font-
 * download code path regardless of which route discovered the URL.
 */
async function fetchViaAdmin(originHostname, cred, deps = {}) {
  const get = deps.adminGet || adminGet;
  const errors = [];
  const base = `https://${originHostname}/admin/api/${cred.apiVersion}`;

  let themes = [];
  try {
    const res = await get(`${base}/themes.json`, cred.token);
    themes = res?.data?.themes || [];
  } catch (err) {
    throw new Error(`admin themes.json failed: ${err.message}`);
  }
  const live = themes.find((t) => t.role === 'main') || themes[0];
  if (!live) throw new Error('admin: store has no theme');

  let assets = [];
  try {
    const res = await get(`${base}/themes/${live.id}/assets.json`, cred.token);
    assets = res?.data?.assets || [];
  } catch (err) {
    throw new Error(`admin assets.json failed: ${err.message}`);
  }

  const cssKeys = assets
    .map((a) => a.key)
    .filter((k) => typeof k === 'string' && /\.css(\.liquid)?$/i.test(k))
    .slice(0, MAX_ADMIN_ASSETS);
  const hasSettings = assets.some((a) => a.key === 'config/settings_data.json');

  const sheets = [];
  for (const key of cssKeys) {
    try {
      const res = await get(`${base}/themes/${live.id}/assets.json?asset[key]=${encodeURIComponent(key)}`, cred.token);
      const text = res?.data?.asset?.value;
      if (typeof text === 'string' && text.includes('@font-face')) {
        // baseUrl: relative url()s inside a theme CSS asset resolve against
        // the storefront origin's CDN path, same convention the rendered
        // page itself uses — the public homepage origin is the correct base.
        sheets.push({ css: text, baseUrl: `https://${originHostname}/`, from: `admin:${key}` });
      }
    } catch (err) {
      errors.push(`admin asset fetch failed (${key}): ${err.message}`);
    }
  }

  let pickerFonts = [];
  if (hasSettings) {
    try {
      const res = await get(`${base}/themes/${live.id}/assets.json?asset[key]=config/settings_data.json`, cred.token);
      const text = res?.data?.asset?.value;
      if (typeof text === 'string') pickerFonts = extractShopifyPickerFontNames(text);
    } catch (err) {
      errors.push(`admin settings_data.json fetch failed: ${err.message}`);
    }
  }

  return { sheets, pickerFonts, errors };
}

// ── Main ingest ───────────────────────────────────────────────────────

/**
 * Ingest a brand's Shopify theme font files. Pure of (brand) — no mongoose
 * writes; the caller persists via
 * brandFontPersistenceService.applyShopifyFontIngestResult.
 *
 * @param {object} brand  needs .apifyDemo?.shopifyUrl (or .shopifyUrl /
 *   .websiteUrl — resolveStoreOrigin's cascade); ._id/.name used for public
 *   IDs + logs.
 * @param {object} [deps]  injection points for tests:
 *   resolveShopifyAdminCred(hostname), adminGet(url, token),
 *   fetchHomepage(origin) — each defaults to the real implementation.
 * @returns {Promise<{ingested, flagged, errors, usage}>}  same shape as
 *   brandFontIngestService.ingestBrandFonts.
 * @throws when no Shopify URL is configured for this brand at all.
 */
async function ingestShopifyThemeFonts(brand, deps = {}) {
  const t0 = Date.now();
  const brandId = String(brand?._id || brand?.id || 'brand');
  const origin = primaryOrigin(brand);
  if (!origin) throw new Error('shopify theme font ingest: no shopifyUrl configured on brand');

  const resolveCred = deps.resolveShopifyAdminCred || resolveShopifyAdminCred;
  const fetchHome = deps.fetchHomepage || fetchHomepage;
  const errors = [];
  let pickerFonts = [];

  // Try one origin candidate via AUTHED-then-PUBLIC. Returns { sheets,
  // pageUrl, html } — html/pageUrl only set when the public fetch ran (used
  // by the caller to discover a myshopify fallback candidate).
  async function tryOrigin(candidateOrigin) {
    let hostname;
    try { hostname = new URL(candidateOrigin).hostname; } catch { return { sheets: [] }; }

    const cred = resolveCred(hostname);
    if (cred) {
      try {
        const admin = await fetchViaAdmin(hostname, cred, deps);
        errors.push(...admin.errors);
        if (admin.pickerFonts.length) pickerFonts = pickerFonts.concat(admin.pickerFonts);
        if (admin.sheets.length) return { sheets: admin.sheets, via: 'authed' };
        // Admin resolved but no CSS asset had @font-face — fall through to
        // public below rather than reporting a false "nothing found".
      } catch (err) {
        errors.push(`authed: ${err.message}`);
      }
    }

    try {
      const { html, pageUrl } = await fetchHome(candidateOrigin);
      const { sheets, errors: sheetErrors } = await collectStylesheets(html, pageUrl);
      errors.push(...sheetErrors);
      return { sheets, via: 'public', html, pageUrl };
    } catch (err) {
      errors.push(`public: could not fetch ${candidateOrigin}: ${err.message}`);
      return { sheets: [] };
    }
  }

  let attempt = await tryOrigin(origin);
  let via = attempt.via || 'none';

  // No usable signal from the primary origin — try the myshopify backend IF
  // this brand's storefront is headless on its custom domain (same
  // discovery shopifyAccessResolver.resolveShopifyAccess uses for catalog
  // sync, applied here for the first time to font ingest). Only worth
  // attempting when we actually have HTML to discover it from.
  if (!attempt.sheets.length && attempt.html) {
    const found = discoverMyshopifyDomain(attempt.html);
    let customHost = '';
    try { customHost = new URL(origin).hostname.toLowerCase(); } catch { /* */ }
    if (found && found !== customHost) {
      const fallbackOrigin = `https://${found}`;
      const fallbackAttempt = await tryOrigin(fallbackOrigin);
      if (fallbackAttempt.sheets.length) {
        attempt = fallbackAttempt;
        via = `${fallbackAttempt.via}(myshopify-fallback)`;
      } else {
        errors.push(...(fallbackAttempt.errors || []));
      }
    }
  }

  const sheets = attempt.sheets || [];
  let faces = [];
  for (const sheet of sheets) {
    try {
      faces.push(...parseFontFacesFromCss(sheet.css, sheet.baseUrl));
    } catch (err) {
      errors.push(`font-face parse failed (${sheet.from}): ${err.message}`);
    }
  }
  faces = dedupeFaces(faces);
  const usage = aggregateFontUsageAcrossSheets(sheets.map((s) => s.css));
  // Fold in name-only picker evidence for a family with NO real file among
  // the parsed faces — never overwrite/duplicate a family we actually hold.
  if (pickerFonts.length) {
    const haveFamilies = new Set(faces.map((f) => f.family.toLowerCase()));
    const nameOnly = pickerFonts.filter((p) => p.family && !haveFamilies.has(p.family.toLowerCase()));
    if (nameOnly.length) {
      usage.evidence = [
        ...(usage.evidence || []),
        ...nameOnly.map((p) => ({ family: p.family, role: 'picker-setting', generic: null, selector: p.settingKey, score: 1, nameOnly: true }))
      ].slice(0, 30);
    }
  }

  const ingested = [];
  const flagged = [];
  const mirrorCounts = { open: 0, commercial: 0 };
  const pageUrl = attempt.pageUrl || origin;
  for (const face of faces) {
    const { ingested: gotIngested, flagged: gotFlagged, error: gotError } =
      await mirrorDiscoveredFace(face, {
        pageUrl,
        brandId,
        mirrorCounts,
        source: 'shopify-theme',
        classify: classifyShopifyFontSource,
      });
    if (gotIngested) ingested.push(gotIngested);
    if (gotFlagged) flagged.push(gotFlagged);
    if (gotError) errors.push(gotError);
  }

  console.log(
    `🛍🔤 shopify theme font ingest for "${brand?.name || brandId}": via=${via} ` +
    `${ingested.length} ingested, ${flagged.length} flagged, ${errors.length} error(s) ` +
    `from ${sheets.length} sheet(s) (${faces.length} unique face(s)) in ${Date.now() - t0}ms`
  );

  return { ingested, flagged, errors, usage, via };
}

module.exports = {
  ingestShopifyThemeFonts,
  classifyShopifyFontSource,
  resolveShopifyAdminCred,
  extractShopifyPickerFontNames,
  fetchViaAdmin,
  SHOPIFY_FONT_LIBRARY_HOSTS,
};
