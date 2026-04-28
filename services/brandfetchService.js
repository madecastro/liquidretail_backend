// Brandfetch v2 API client. Looks up a brand by domain and normalizes the
// response into the subset of fields the brand catalog cares about (logo,
// colors, fonts, tagline). Returns null on miss / error / no-API-key so
// callers can fall through to the next enrichment tier.
//
// API docs: https://docs.brandfetch.com/reference/brand-api
// Free tier covers most well-known consumer brands; obscure or very new
// brands typically 404 and we fall back to homepage scraping.

const axios = require('axios');

const BRANDFETCH_ENDPOINT = 'https://api.brandfetch.io/v2/brands';

async function lookupBrand(domain) {
  const apiKey = process.env.BRANDFETCH_API_KEY;
  if (!apiKey) return null;
  if (!domain || typeof domain !== 'string') return null;

  const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
  const t0 = Date.now();

  let data;
  try {
    const res = await axios.get(`${BRANDFETCH_ENDPOINT}/${encodeURIComponent(cleanDomain)}`, {
      timeout: 15000,
      headers: { Authorization: `Bearer ${apiKey}` },
      validateStatus: () => true
    });
    if (res.status === 404) {
      console.log(`   · brandfetch: 404 for ${cleanDomain} (${Date.now() - t0}ms)`);
      return null;
    }
    if (res.status !== 200) {
      console.warn(`   ⚠️  brandfetch: HTTP ${res.status} for ${cleanDomain}: ${JSON.stringify(res.data).slice(0, 200)}`);
      return null;
    }
    data = res.data;
  } catch (err) {
    console.warn(`   ⚠️  brandfetch fetch failed for ${cleanDomain}: ${err.message}`);
    return null;
  }

  const normalized = {
    name:           data.name || null,
    domain:         data.domain || cleanDomain,
    description:    data.description || null,
    longDescription: data.longDescription || null,
    logoUrl:        pickLogoUrl(data.logos),
    primaryColor:   pickColor(data.colors, ['brand', 'accent', 'dark']),
    secondaryColor: pickColor(data.colors, ['dark', 'secondary', 'brand']),
    accentColor:    pickColor(data.colors, ['accent', 'brand']),
    // Brand's text/copy color. Brandfetch tags this with type='text'
    // when known. Fall back to dark — brands without an explicit text
    // token nearly always use a dark color for body copy.
    fontColor:      pickColor(data.colors, ['text', 'dark']),
    fontFamily:     pickFont(data.fonts),
    socialLinks:    normalizeLinks(data.links)
  };

  const filledFieldCount = ['logoUrl','primaryColor','fontFamily']
    .filter(k => normalized[k]).length;
  console.log(`   ✓ brandfetch: ${cleanDomain} → ${filledFieldCount}/3 visual fields filled (${Date.now() - t0}ms)`);
  return normalized;
}

// Pick the best logo URL. Prefer wordmark "logo" type over icon-only,
// and PNG over SVG (renderers without SVG support get a usable raster).
// Light-theme (intended for dark backgrounds) is preferred for ads.
function pickLogoUrl(logos) {
  if (!Array.isArray(logos) || logos.length === 0) return null;
  // Order of preference for `type`
  const typeRank = { logo: 0, symbol: 1, icon: 2, other: 3 };
  // Prefer light-theme logos (white/inverted, sit nicely on dark images)
  // but accept dark-theme as fallback.
  const themeRank = { light: 0, dark: 1 };
  // Prefer PNG (no SVG-render dependency in Puppeteer); fall back to SVG.
  const formatRank = { png: 0, svg: 1, jpg: 2, webp: 3 };

  const candidates = [];
  for (const l of logos) {
    if (!Array.isArray(l.formats)) continue;
    for (const f of l.formats) {
      if (!f.src) continue;
      candidates.push({
        type:   typeRank[l.type]   ?? 99,
        theme:  themeRank[l.theme] ?? 99,
        format: formatRank[f.format] ?? 99,
        width:  f.width || 0,
        src:    f.src
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    a.type   - b.type   ||
    a.theme  - b.theme  ||
    a.format - b.format ||
    b.width  - a.width
  );
  return candidates[0].src;
}

// Pick a color matching one of the preferred semantic types (in order).
function pickColor(colors, preferredTypes) {
  if (!Array.isArray(colors) || colors.length === 0) return null;
  for (const t of preferredTypes) {
    const hit = colors.find(c => c.type === t && /^#[0-9a-f]{6}$/i.test(c.hex || ''));
    if (hit) return hit.hex;
  }
  // No match — return first valid hex as a last resort.
  const fallback = colors.find(c => /^#[0-9a-f]{6}$/i.test(c.hex || ''));
  return fallback?.hex || null;
}

// Pick the brand's headline font. Prefer "title" type over "body".
function pickFont(fonts) {
  if (!Array.isArray(fonts) || fonts.length === 0) return null;
  const title = fonts.find(f => f.type === 'title' && f.name);
  if (title) return title.name;
  const any = fonts.find(f => f.name);
  return any?.name || null;
}

// Normalize the social links array into a simple { platform: url } map.
// Keys we surface: instagram, tiktok, youtube, x (twitter), facebook.
function normalizeLinks(links) {
  if (!Array.isArray(links)) return {};
  const out = {};
  const map = {
    instagram: 'instagram',
    tiktok:    'tiktok',
    youtube:   'youtube',
    twitter:   'x',
    x:         'x',
    facebook:  'facebook'
  };
  for (const l of links) {
    if (!l?.name || !l?.url) continue;
    const key = map[String(l.name).toLowerCase()];
    if (key && !out[key]) out[key] = l.url;
  }
  return out;
}

module.exports = { lookupBrand };
