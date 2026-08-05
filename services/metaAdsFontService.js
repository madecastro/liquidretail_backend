// Identifies the typeface families a brand uses in its own Meta (FB/IG) ads by
// running a vision LLM over ad creative images.
//
// WHY THIS EXISTS, AND WHAT IT IS NOT.
// Raster ad creatives do not embed font files — you cannot extract a .woff2 from
// a JPEG. So unlike brandFontIngestService (which parses @font-face off the
// brand's website and mirrors REAL FILES), this service only produces a NAME.
// That name is then fed to fontResolverService's normal ladder, which serves the
// family exactly when we already hold it (ingested file or a real Google family)
// and otherwise substitutes the closest library face. The distinction matters
// downstream: an identified name is EVIDENCE, not a font, and a low-confidence
// guess must never outrank a curated choice.
//
// Why bother, given the website scan exists: a premium DTC site often serves its
// typeface from a foundry CDN that 403s us, or injects the stack via JS so no
// @font-face is in the fetched HTML at all. The ads still SHOW the typeface.
// This is the second look for exactly those brands.
//
// NO MONGOOSE WRITES — pure function of (brand) → result. The caller persists
// (brandFontPersistenceService.applyMetaFontsResult), same split as the website
// ingest service.
//
// MONEY:
//   · The vision chatCompletion is billable. It is never called with zero
//     images — gathering that finds nothing returns before the LLM.
//   · The Apify Ad Library run is billable AND was previously unledgered
//     anywhere in this repo. It is ledgered here on success, before the images
//     are even used, because the run has already billed by then.
//   · maxImages caps `visionImages`, which is what the per-image ledger
//     surcharge is computed from. Do not raise it casually.

'use strict';

const axios = require('axios');
const Campaign = require('../models/Campaign');
const { resolveMetaAdsCred } = require('./metaAdsPushService');
const { chatCompletion } = require('./atlasLlmService');
const { recordFlatCost } = require('./costTracker');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT = `https://graph.facebook.com/${META_API_VERSION}`;
const APIFY_API_ROOT = 'https://api.apify.com/v2';

// Stop walking tiers once we hold this many images — enough to identify a face.
const MIN_USABLE_IMAGES = 2;
const DEFAULT_MAX_IMAGES = 4;
const MAX_IMAGES_CEILING = 8;
const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

function metaAdsFontsEnabled() {
  return String(process.env.META_ADS_FONTS_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

function coerceConfidence(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return CONFIDENCE_LEVELS.includes(s) ? s : 'low';
}

/**
 * Only a HIGH-confidence identification may be promoted as the brand's real
 * face (the exact-only ladder tier). A medium/low guess still lands in evidence
 * for the UI, but promoting it would let a hallucinated name outrank a curated
 * theme — the same failure the resolver's requireExact rule exists to prevent.
 */
function usableForExact(face) {
  return !!(
    face &&
    typeof face.family === 'string' &&
    face.family.trim() &&
    String(face.confidence).toLowerCase() === 'high'
  );
}

function parseFaceRole(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.family !== 'string' || !obj.family.trim()) return null;
  const closest =
    (typeof obj.closestGoogle === 'string' && obj.closestGoogle.trim()) ||
    (typeof obj.closest_google === 'string' && obj.closest_google.trim()) ||
    null;
  return {
    family: obj.family.trim(),
    confidence: coerceConfidence(obj.confidence),
    closestGoogle: closest || null,
  };
}

/**
 * Defensive parse of the vision JSON. NEVER throws — a malformed verdict must
 * degrade to "identified nothing", not crash an enrichment run. Measured
 * precedent: gemini-2.5-flash returned a bare boolean where adVisionQcService
 * asked for an object, so tolerating off-contract shapes is not hypothetical.
 */
function parseFontIdentification(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    const cleaned = String(raw)
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return { heading: null, body: null, notes: null, parseError: 'not JSON' };
      try {
        parsed = JSON.parse(m[0]);
      } catch (err) {
        return { heading: null, body: null, notes: null, parseError: err.message };
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { heading: null, body: null, notes: null, parseError: 'not an object' };
  }
  const notes = typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : null;
  // Hoisted shape: {family, confidence} with no heading/body wrapper.
  if (parsed.heading == null && parsed.body == null && typeof parsed.family === 'string') {
    return { heading: parseFaceRole(parsed), body: null, notes, parseError: null };
  }
  return {
    heading: parseFaceRole(parsed.heading),
    body: parseFaceRole(parsed.body),
    notes,
    parseError: null,
  };
}

function emptyResult(via, errors) {
  return {
    usage: { heading: null, body: null, evidence: [] },
    via: via || 'none',
    imagesUsed: 0,
    errors: Array.isArray(errors) ? errors : [],
  };
}

function domainFromWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    return new URL(String(websiteUrl)).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

/** Mirrors metaAdsCreativeMatcher's extraction; kept in field-priority order. */
function extractCreativeImageUrl(cre) {
  if (!cre || typeof cre !== 'object') return null;
  const linkData = cre.object_story_spec?.link_data || {};
  const feed = cre.asset_feed_spec || {};
  return (
    cre.image_url || linkData.picture || feed.images?.[0]?.url ||
    cre.thumbnail_url || null
  );
}

function pushImage(images, seen, { url, creativeId, via }, cap) {
  if (images.length >= cap) return;
  if (!isHttpUrl(url)) return;
  const key = String(url).trim();
  if (seen.has(key)) return;
  seen.add(key);
  images.push({ url: key, creativeId: creativeId ? String(creativeId) : null, via });
}

// ── Tier 1: already-persisted Campaign docs. Zero network, zero spend. ──────
// One query serves both purposes: the image URLs we can use directly, and the
// creative ids tier 2 needs. Querying twice for the same documents was the
// draft's shape and is pure overhead.
async function readCampaignAds(brand, deps) {
  const CampaignModel = deps.Campaign || Campaign;
  const brandId = brand._id || brand.id;
  if (!brandId) return { images: [], creativeIds: [] };
  const campaigns = await CampaignModel.find({ brandId, platform: 'meta-ads' })
    .select('adSets')
    .lean();

  const images = [];
  const seen = new Set();
  const creativeIds = new Set();
  for (const c of campaigns || []) {
    for (const set of c.adSets || []) {
      for (const ad of set.ads || []) {
        const cid = ad.creativeRef?.creativeId || null;
        if (cid) creativeIds.add(String(cid));
        pushImage(
          images, seen,
          { url: ad.creative?.imageUrl || null, creativeId: cid, via: 'campaign-docs' },
          MAX_IMAGES_CEILING
        );
      }
    }
  }
  return { images, creativeIds: Array.from(creativeIds) };
}

async function fetchCreativeBatch(creativeIds, token) {
  const fields = [
    'id', 'name', 'image_url', 'thumbnail_url',
    'object_story_spec', 'asset_feed_spec',
  ].join(',');
  const map = new Map();
  const ids = (creativeIds || []).map(String).filter(Boolean);
  if (!ids.length) return map;

  if (ids.length <= 4) {
    await Promise.all(ids.map(async (id) => {
      try {
        const res = await axios.get(`${META_GRAPH_ROOT}/${id}`, {
          params: { fields, access_token: token }, timeout: 20_000,
        });
        if (res.data) map.set(String(id), res.data);
      } catch (err) {
        console.warn(`   ⚠️  metaAdsFont creative ${id}: ${err.response?.data?.error?.message || err.message}`);
      }
    }));
    return map;
  }
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const batch = slice.map((id) => ({
      method: 'GET', relative_url: `${id}?fields=${encodeURIComponent(fields)}`,
    }));
    try {
      const res = await axios.post(META_GRAPH_ROOT, null, {
        params: { access_token: token, batch: JSON.stringify(batch) }, timeout: 30_000,
      });
      for (let j = 0; j < slice.length; j++) {
        const op = res.data?.[j];
        if (!op || op.code !== 200 || !op.body) continue;
        try {
          const body = JSON.parse(op.body);
          if (body?.id) map.set(String(body.id), body);
        } catch { /* malformed batch body — skip this one */ }
      }
    } catch (err) {
      console.warn(`   ⚠️  metaAdsFont creative batch: ${err.response?.data?.error?.message || err.message}`);
    }
  }
  return map;
}

// Single page, no pagination: we need a handful of creatives to read type from,
// not a full account inventory.
async function fetchCreativeIdsFromAccount(adAccountId, token, limit) {
  const fields = `id,adsets.limit(25){id,ads.limit(25){id,creative{id}}}`;
  const res = await axios.get(`${META_GRAPH_ROOT}/${adAccountId}/campaigns`, {
    params: { fields, access_token: token, limit: 25 }, timeout: 30_000,
  });
  const ids = [];
  for (const camp of res.data?.data || []) {
    for (const set of camp.adsets?.data || []) {
      for (const ad of set.ads?.data || []) {
        const cid = ad.creative?.id;
        if (cid) ids.push(String(cid));
        if (ids.length >= limit) return ids;
      }
    }
  }
  return ids;
}

// ── Tier 2: the brand's connected ad account. Free (Graph API). ─────────────
async function gatherFromConnected(brand, cap, knownCreativeIds, errors, deps) {
  const resolve = deps.resolveMetaAdsCred || resolveMetaAdsCred;
  const fetchBatch = deps.fetchCreativeBatch || fetchCreativeBatch;
  const fetchIds = deps.fetchCreativeIdsFromAccount || fetchCreativeIdsFromAccount;

  let token, adAccountId;
  try {
    ({ token, adAccountId } = await resolve(brand._id || brand.id));
  } catch (err) {
    // no-meta-ads-cred / no-ad-account / decrypt are expected for brands that
    // never connected Meta — a recorded soft failure, not an exception.
    errors.push(`connected: ${err.code || 'error'}: ${err.message}`);
    return [];
  }

  let creativeIds = knownCreativeIds;
  if (!creativeIds.length) {
    try {
      creativeIds = await fetchIds(adAccountId, token, Math.max(cap * 4, 12));
    } catch (err) {
      errors.push(`connected: creative id walk failed: ${err.response?.data?.error?.message || err.message}`);
      return [];
    }
  }
  if (!creativeIds.length) {
    errors.push('connected: account has no ad creatives');
    return [];
  }

  let map;
  try {
    map = await fetchBatch(creativeIds.slice(0, Math.max(cap * 4, 12)), token);
  } catch (err) {
    errors.push(`connected: creative batch failed: ${err.message}`);
    return [];
  }
  const images = [];
  const seen = new Set();
  for (const [id, cre] of map) {
    pushImage(images, seen, { url: extractCreativeImageUrl(cre), creativeId: id, via: 'connected' }, cap);
    if (images.length >= cap) break;
  }
  return images;
}

async function runActorSync(actorId, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set — cannot invoke Apify actors');
  const res = await axios.post(
    `${APIFY_API_ROOT}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`,
    input,
    { params: { token }, timeout: 5 * 60 * 1000 + 15_000, headers: { 'content-type': 'application/json' } }
  );
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Harvest image URLs from an unknown Ad Library actor's item shape. Community
 * actors disagree on field names and none of them is a stable contract, so this
 * accepts several spellings rather than pinning one.
 */
function extractUrlsFromAdLibraryItem(item) {
  if (!item || typeof item !== 'object') return [];
  const KEYS = [
    'imageUrl', 'image_url', 'image', 'thumbnailUrl', 'thumbnail_url',
    'snapshotUrl', 'snapshot_url', 'creativeImageUrl', 'creative_image_url',
    'originalImageUrl', 'mediaUrl', 'media_url', 'displayUrl', 'display_url', 'url',
  ];
  const out = [];
  const push = (v) => {
    if (isHttpUrl(v)) { out.push(String(v).trim()); return; }
    if (!Array.isArray(v)) return;
    for (const x of v) {
      if (isHttpUrl(x)) out.push(String(x).trim());
      else if (x && typeof x === 'object') {
        const nested = x.url || x.imageUrl || x.image_url || x.src;
        if (isHttpUrl(nested)) out.push(String(nested).trim());
      }
    }
  };
  const scan = (obj) => { for (const k of KEYS) if (obj[k] != null) push(obj[k]); };
  scan(item);
  if (item.snapshot && typeof item.snapshot === 'object') scan(item.snapshot);
  if (item.images) push(item.images);
  for (const card of Array.isArray(item.cards) ? item.cards : []) {
    if (card && typeof card === 'object') scan(card);
  }
  return out;
}

// ── Tier 3: public Ad Library via Apify. BILLABLE. ─────────────────────────
async function gatherFromAdLibrary(brand, cap, errors, deps) {
  const actorId = process.env.APIFY_ADLIB_ACTOR;
  if (!actorId) {
    errors.push('adlibrary: skipped (APIFY_ADLIB_ACTOR not set)');
    return [];
  }
  const runSync = deps.runActorSync || runActorSync;
  const recordCost = deps.recordFlatCost || recordFlatCost;
  const domain = domainFromWebsite(brand.websiteUrl);
  const name = brand.name || domain || null;
  if (!name) {
    errors.push('adlibrary: brand has neither name nor website to search by');
    return [];
  }

  // Community actors take different input keys for the same search; extras are
  // ignored by whichever one is configured.
  const input = {
    searchTerms: name, query: name, keyword: name,
    pageUrl: brand.websiteUrl || null, domain: domain || null,
    startUrls: brand.websiteUrl ? [{ url: brand.websiteUrl }] : [],
    resultsLimit: Math.max(cap * 3, 10), maxItems: Math.max(cap * 3, 10),
    country: 'US',
  };

  let items;
  try {
    items = await runSync(actorId, input);
  } catch (err) {
    errors.push(`adlibrary: ${err.message}`);
    return [];
  }

  // MONEY: ledger BEFORE using the items. The run has already billed by the
  // time it returns, so an early return on a useless item shape must not skip
  // the row. Apify runs are unledgered everywhere else in this repo; this path
  // does not inherit that gap.
  try {
    await recordCost({
      provider: 'apify',
      model: actorId,
      stage: 'meta_ads_fonts',
      purposeTag: 'adlibrary_pull',
      brandId: brand._id || brand.id || null,
      costUsd: Number(process.env.APIFY_ADLIB_COST_USD || 0.25),
      costSource: 'estimated',
    });
  } catch (err) {
    errors.push(`adlibrary cost ledger failed: ${err.message}`);
  }

  const images = [];
  const seen = new Set();
  for (const item of items || []) {
    const creativeId = item?.adArchiveID || item?.ad_archive_id || item?.adId || item?.id || null;
    for (const url of extractUrlsFromAdLibraryItem(item)) {
      pushImage(images, seen, { url, creativeId, via: 'adlibrary' }, cap);
      if (images.length >= cap) return images;
    }
  }
  if (!images.length) errors.push('adlibrary: actor returned no usable image URLs');
  return images;
}

function buildVisionUserContent(images) {
  const prompt = [
    'Identify the typeface families used in the TEXT of these Meta ad creatives.',
    '',
    'Distinguish two roles:',
    '  heading — large display/hero text',
    '  body    — smaller paragraph, caption or disclaimer text',
    '',
    'For each role report:',
    '  family        best-guess typeface name (e.g. "Futura", "Oswald", "Helvetica Neue")',
    '  confidence    "high" only if you can name the specific typeface with real',
    '                certainty; "medium" if you are confident only of the class;',
    '                "low" if guessing. Do not inflate confidence.',
    '  closestGoogle nearest Google Fonts family name',
    '',
    'IGNORE: logos and wordmarks (usually custom lettering, not a text face),',
    'watermarks, and any interface chrome Meta draws around the ad.',
    'Return null for a role whose text is not present.',
    '',
    'Reply with JSON only, no prose:',
    '{"heading":{"family":"...","confidence":"high|medium|low","closestGoogle":"..."},',
    ' "body":{"family":"...","confidence":"high|medium|low","closestGoogle":"..."},',
    ' "notes":"short note"}',
  ].join('\n');

  const parts = [{ type: 'text', text: prompt }];
  images.forEach((img, i) => {
    // Labels in adjacent text parts so the model cannot silently reorder them.
    parts.push({ type: 'text', text: `IMAGE ${i + 1} — AD CREATIVE:` });
    parts.push({ type: 'image_url', image_url: { url: img.url } });
  });
  return parts;
}

function buildEvidence(heading, body, images, via) {
  const anchor = images[0] || {};
  const rows = [];
  for (const [role, face] of [['heading', heading], ['body', body]]) {
    if (!face) continue;
    rows.push({
      family: face.family,
      role,
      confidence: face.confidence,
      closestGoogle: face.closestGoogle,
      creativeId: anchor.creativeId || null,
      via: anchor.via || via,
      usableForExact: usableForExact(face),
    });
  }
  return rows;
}

/**
 * Identify the fonts in a brand's Meta ads.
 * `deps` is an injection seam for the offline harness only.
 */
async function identifyBrandAdFonts(brand, { maxImages = DEFAULT_MAX_IMAGES } = {}, deps = {}) {
  if (!metaAdsFontsEnabled()) return emptyResult('none', ['disabled: META_ADS_FONTS_ENABLED=false']);
  if (!brand || !(brand._id || brand.id)) return emptyResult('none', ['brand has no id']);

  const errors = [];
  const cap = Math.max(1, Math.min(Number(maxImages) || DEFAULT_MAX_IMAGES, MAX_IMAGES_CEILING));
  const images = [];
  const seen = new Set();
  let knownCreativeIds = [];

  // Tier 1 — persisted docs.
  try {
    const fromDocs = await readCampaignAds(brand, deps);
    knownCreativeIds = fromDocs.creativeIds;
    for (const img of fromDocs.images) pushImage(images, seen, img, cap);
  } catch (err) {
    errors.push(`campaign-docs: ${err.message}`);
  }

  // Tier 2 — live Graph. Catalog/DPA ad sets never persist a creative URL
  // (metaAdsCreativeMatcher skips creative fetch once a product set resolves),
  // so the docs tier legitimately comes up short for the most product-shaped
  // campaigns and this tier is the normal path, not a rare fallback.
  if (images.length < MIN_USABLE_IMAGES) {
    try {
      const fromConnected = await gatherFromConnected(brand, cap, knownCreativeIds, errors, deps);
      for (const img of fromConnected) pushImage(images, seen, img, cap);
    } catch (err) {
      errors.push(`connected: ${err.message}`);
    }
  }

  // Tier 3 — billable public scrape, only when nothing free worked at all.
  if (images.length === 0) {
    try {
      const fromLib = await gatherFromAdLibrary(brand, cap, errors, deps);
      for (const img of fromLib) pushImage(images, seen, img, cap);
    } catch (err) {
      errors.push(`adlibrary: ${err.message}`);
    }
  }

  // ZERO SPEND ON NOTHING. The vision call is billable; without a creative
  // there is nothing to look at.
  if (images.length === 0) {
    return emptyResult('none', errors.length ? errors : ['no ad creatives found']);
  }

  // The reported path is whichever tier actually supplied the most images.
  const counts = images.reduce((m, i) => m.set(i.via, (m.get(i.via) || 0) + 1), new Map());
  const via = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const chat = deps.chatCompletion || chatCompletion;
  const model = process.env.META_ADS_FONTS_MODEL || 'font-vision';

  let raw = null;
  try {
    // ── MONEY: billable vision call. visionImages drives the ledger's
    // per-image surcharge, so it must match the real count. ──
    const res = await chat(
      {
        stage: 'meta_ads_fonts',
        service: 'metaAdsFontService',
        purposeTag: 'font_identification',
        visionImages: images.length,
        brandId: brand._id || brand.id || null,
      },
      {
        model,
        messages: [{ role: 'user', content: buildVisionUserContent(images) }],
        temperature: 0.0,
        max_tokens: 1200,
        // json_object, never json_schema: strict schema 400s on Anthropic routes.
        response_format: { type: 'json_object' },
      }
    );
    raw = res?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    errors.push(`vision: ${err.message}`);
    return { ...emptyResult(via, errors), imagesUsed: images.length };
  }

  const parsed = parseFontIdentification(raw);
  if (parsed.parseError) errors.push(`vision parse: ${parsed.parseError}`);
  if (parsed.notes) errors.push(`vision notes: ${parsed.notes}`);

  return {
    usage: {
      heading: parsed.heading,
      body: parsed.body,
      evidence: buildEvidence(parsed.heading, parsed.body, images, via),
    },
    via,
    imagesUsed: images.length,
    errors,
  };
}

module.exports = {
  identifyBrandAdFonts,
  metaAdsFontsEnabled,
  // Pure helpers, exported for scripts/verifyMetaAdsFonts.js
  parseFontIdentification,
  parseFaceRole,
  coerceConfidence,
  usableForExact,
  extractCreativeImageUrl,
  extractUrlsFromAdLibraryItem,
  isHttpUrl,
  MIN_USABLE_IMAGES,
  DEFAULT_MAX_IMAGES,
  MAX_IMAGES_CEILING,
};
