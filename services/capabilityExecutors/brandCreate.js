// Executor for capability brand.create (Tier 1, advertiser scope).
//
// Create a Brand under the caller's advertiser. Idempotent on
// (advertiserId, nameNormalized) — returns 409-shaped result when a
// brand with the same normalized name already exists.
//
// Always fires a fire-and-forget enrichment run (Brandfetch / scrape /
// LLM when websiteUrl is present; Meta-ads / Shopify-theme fonts even
// when it is not). Enrichment is orthogonal to the create call — the
// executor returns immediately with the newly-created brand.

'use strict';

const Brand = require('../../models/Brand');
const { normalizeBrandName } = require('../../models/Brand');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const name = String(args?.name || '').trim();
  if (!name) return { ok: false, error: 'name required (non-empty)' };
  if (name.length > 200) return { ok: false, error: `name too long (${name.length} > 200 chars)` };

  const normalized = normalizeBrandName(name);
  if (!normalized) return { ok: false, error: 'name produces empty slug — pick something with alphanumerics' };

  const existing = await Brand.findOne({
    advertiserId: req.advertiserId,
    nameNormalized: normalized
  }).select('_id name nameNormalized').lean();
  if (existing) {
    return {
      ok: false,
      error: 'brand already exists for this advertiser',
      code: 'brand-exists',
      brand: {
        _id: String(existing._id),
        name: existing.name,
        slug: existing.nameNormalized
      }
    };
  }

  const websiteUrl = args?.websiteUrl != null ? String(args.websiteUrl).trim() : null;
  const tagline    = args?.tagline    != null ? String(args.tagline).trim().slice(0, 200) : null;
  const primaryColor = args?.primaryColor != null ? String(args.primaryColor).trim() : null;

  const curatedFields = ['name'];
  if (tagline)      curatedFields.push('tagline');
  if (primaryColor) curatedFields.push('primaryColor');

  let brand;
  try {
    brand = await Brand.create({
      advertiserId:   req.advertiserId,
      name,
      nameNormalized: normalized,
      websiteUrl:     websiteUrl || null,
      tagline:        tagline || null,
      primaryColor:   primaryColor || null,
      source:         'curated',
      curatedFields
    });
  } catch (err) {
    if (err?.code === 11000) {
      return { ok: false, error: 'brand already exists (unique index race)', code: 'brand-exists' };
    }
    return { ok: false, error: err?.message || 'brand create failed' };
  }

  // Fire-and-forget enrichment. Same choke point as the route handler —
  // always queued, even with no websiteUrl: enrichBrandFromUrl records
  // the skip and still runs Meta-ads / Shopify-theme font tiers.
  try {
    require('../brandEnrichmentService')
      .queueBrandEnrichment(brand._id, 'brand.create', brand.name);
  } catch (_) { /* enrichment scheduler unavailable — non-fatal */ }

  return {
    ok: true,
    kind: 'brandUpdate',
    data: {
      _id:          String(brand._id),
      name:         brand.name,
      slug:         brand.nameNormalized,
      websiteUrl:   brand.websiteUrl,
      tagline:      brand.tagline,
      primaryColor: brand.primaryColor,
      source:       brand.source,
      enrichmentQueued: true,
      note: brand.websiteUrl
        ? 'Enrichment (Brandfetch → scrape → LLM + website/Meta-ads fonts) is running in the background — poll the brand for logo/summary/tone/font updates over the next 30-90s.'
        : 'No websiteUrl supplied — website enrichment is recorded as skipped; Meta-ads / Shopify-theme font ingest still runs. Set a websiteUrl via brand.patch to fill the rest.'
    }
  };
}

module.exports = { run };
