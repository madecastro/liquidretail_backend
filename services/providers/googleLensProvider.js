// Google Lens visual search via SerpAPI. Accepts an image URL and returns
// visually-similar shopping results from across the web — no catalog required.
// Complements the text-based Gemini search: catches items where brand/name
// extraction missed but the visual match is strong.

const axios = require('axios');

const PROVIDER_NAME = 'google-lens';
const ENDPOINT = 'https://serpapi.com/search.json';
const COUNTRY  = process.env.SERPAPI_COUNTRY || 'us';

// Fingerprint the SerpAPI key at module load so the Render log tells us
// whether Render is actually delivering the env var (without logging the key).
const _rawKey = process.env.SERPAPI_API_KEY || '';
const _trimmedKey = _rawKey.trim().replace(/^['"]|['"]$/g, '');
if (_rawKey) {
  const fp = _trimmedKey.length > 8
    ? `${_trimmedKey.slice(0, 4)}…${_trimmedKey.slice(-4)}`
    : '<too short>';
  console.log(`🔑 SerpAPI key: length=${_trimmedKey.length} fingerprint=${fp}${_rawKey !== _trimmedKey ? ' (stripped quotes/whitespace)' : ''}`);
} else {
  console.log('🔑 SerpAPI key: NOT SET (SERPAPI_API_KEY env var empty)');
}

function isEnabled() { return !!_trimmedKey; }

async function match({ imageUrl, brand, category }) {
  if (!isEnabled()) throw new Error('SERPAPI_API_KEY not set');
  if (!imageUrl) throw new Error('Google Lens requires an imageUrl');

  const t0 = Date.now();
  const params = {
    engine: 'google_lens',
    url: imageUrl,
    country: COUNTRY,
    api_key: _trimmedKey
  };
  // Optional narrowing hint — SerpAPI supports a `q` param that filters lens results
  if (brand || category) {
    params.q = [brand, category].filter(Boolean).join(' ');
  }

  const res = await axios.get(ENDPOINT, { params, timeout: 30000 });

  const visual = res.data?.visual_matches || [];
  const matches = visual.slice(0, 12).map(v => ({
    title: v.title || '',
    url: v.link || '',
    retailer: v.source || extractDomain(v.link),
    priceHint: typeof v.price === 'object' ? (v.price?.value || v.price?.extracted_value || null) : (v.price || null),
    snippet: v.source_icon ? '' : (v.snippet || ''),
    thumbnail: v.thumbnail || null,
    source: PROVIDER_NAME
  })).filter(m => m.url);

  const reasoning =
    `Visually-similar matches from Google Lens` +
    ((params.q) ? ` filtered by "${params.q}".` : `.`) +
    ` Found ${visual.length} total results, returning top ${matches.length}.`;

  console.log(`   ✓ ${PROVIDER_NAME}: ${matches.length} match(es) in ${Date.now() - t0}ms`);

  return {
    provider: PROVIDER_NAME,
    reasoning,
    queryUsed: params.q || '(image-only)',
    matches,
    groundingUrls: []
  };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = { match, isEnabled, PROVIDER_NAME };
