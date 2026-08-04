// Executor for capability platform.listFormats (Tier 0, global scope).
//
// Wraps services/platformFormats.formatCatalog() so the agent has a
// dedicated way to enumerate every supported ad surface (Meta feed 1:1,
// Meta reels 9:16, PMax 16:9, etc.) with their canvas dims, safe zones,
// aspect ratios, and kinds (image / video). The GET /api/ads/formats
// route serves the same data to the UI; this capability puts the same
// answer in agent context.
//
// Global scope: no advertiser/brand context needed — the format
// catalog is a static property of the platform integrations, not the
// caller's data. Tenant-scope check is still performed (a request that
// bypasses requireAuth shouldn't succeed even for a read of static
// data), just no per-record filter.
//
// Enrichment beyond formatCatalog: adds per-format creativeBrief text
// so the agent can quote a one-line surface positioning ("Reels — tall
// vertical video, chrome in the middle band, safe zones at top/bottom
// reserved for IG UI") when the operator asks about a specific format.

'use strict';

const { formatCatalog, creativeBriefForPlatformFormat, getFormatCaps } = require('../platformFormats');

async function run({ req, args }) {
  // Global scope: still require authenticated context so the endpoint
  // itself is gated. Executors that don't need tenant scope MUST still
  // refuse an unauthenticated request — the endpoint sits behind
  // requireAuth, but defence in depth.
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }

  const catalog = formatCatalog();

  // Optional filter: single platform ('meta', 'google') OR a specific
  // format key (e.g. 'meta_feed_4_5'). No filter → full catalog.
  const platformFilter = typeof args?.platform === 'string' ? args.platform : null;
  const formatKeyFilter = typeof args?.formatKey === 'string' ? args.formatKey : null;

  let platformsOut = catalog.platforms || [];
  if (platformFilter) {
    platformsOut = platformsOut.filter((p) => p.id === platformFilter);
  }

  // Flatten to a single "formats" list + platform grouping, enriched
  // with creativeBrief + safe-area detail from getFormatCaps.
  const formatsFlat = [];
  for (const p of platformsOut) {
    for (const f of p.formats || []) {
      if (formatKeyFilter && f.key !== formatKeyFilter) continue;
      const caps = getFormatCaps(f.key) || {};
      formatsFlat.push({
        key:          f.key,
        platform:     p.id,
        label:        f.label,
        aspectRatio:  f.aspectRatio,
        kinds:        f.kinds || [],
        status:       f.status,
        canvas:       caps.canvas ? { ...caps.canvas } : null,
        deliveryDims: f.deliveryDims || null,
        safeArea:     caps.safeArea ? { ...caps.safeArea } : null,
        creativeBrief: creativeBriefForPlatformFormat(f.key) || null
      });
    }
  }

  if (formatKeyFilter && !formatsFlat.length) {
    return { ok: false, error: `formatKey "${formatKeyFilter}" not found in the catalog` };
  }
  if (platformFilter && !platformsOut.length) {
    return { ok: false, error: `platform "${platformFilter}" not found (known: ${(catalog.platforms || []).map((p) => p.id).join(', ')})` };
  }

  return {
    ok: true,
    kind: 'platformFormatList',
    data: {
      filter: {
        platform:  platformFilter || null,
        formatKey: formatKeyFilter || null
      },
      totalFormats: formatsFlat.length,
      formats:      formatsFlat,
      // Preserve the grouped-by-platform shape too so the LLM can
      // answer both "list all Meta formats" (from formats[]) AND
      // "what presets does Meta expose?" (from platforms[].presets[])
      // without a second call.
      platforms: platformsOut.map((p) => ({
        id:     p.id,
        label:  p.label,
        presets: (p.presets || []).map((pr) => ({
          key:         pr.key,
          label:       pr.label,
          description: pr.description,
          formatKeys:  (pr.formats || []).map((f) => f.key)
        }))
      }))
    }
  };
}

module.exports = { run };
