// Brand enrichment from a user-supplied website URL. Fetches the homepage,
// strips it to readable text + a few critical meta tags, asks GPT-4.1 via
// structured output for:
//   - tagline          (the brand's own positioning line)
//   - tone[]           (voice descriptors: "rugged, practical, technical")
//   - demographics[]   (key target personas — names + one-liners + interests
//                       + pain points + tone hints, used downstream by the
//                       layout generator to author notional persona quotes)
//   - color guesses    (best-effort from meta theme-color, else vibe-based)
//
// Logo URL is set deterministically from Google's favicon service (always
// resolvable, no scraping heuristics).
//
// Fire-and-forget from brandCatalogService — the detect pipeline never
// awaits this. On failure the Brand stays a stub and gets another chance
// next time its website URL shows up on a new media upload.

const axios = require('axios');
const OpenAI = require('openai');

const Brand = require('../models/Brand');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_HTML_CHARS = 25000;

const ENRICHMENT_SCHEMA = {
  type: 'object',
  properties: {
    tagline:        { type: 'string' },
    tone:           { type: 'array', items: { type: 'string' } },
    primaryColor:   { type: 'string' },
    secondaryColor: { type: 'string' },
    accentColor:    { type: 'string' },
    demographics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string' },
          description: { type: 'string' },
          interests:   { type: 'array', items: { type: 'string' } },
          painPoints:  { type: 'array', items: { type: 'string' } },
          toneHint:    { type: 'string' }
        },
        required: ['name', 'description']
      }
    }
  },
  required: ['demographics']
};

async function enrichBrandFromUrl(brandId) {
  const brand = await Brand.findById(brandId);
  if (!brand)             return { ok: false, reason: 'brand not found' };
  if (!brand.websiteUrl)  return { ok: false, reason: 'no websiteUrl' };
  if (brand.source === 'curated') return { ok: false, reason: 'curated — refusing to overwrite' };
  if (brand.source === 'enriched') return { ok: false, reason: 'already enriched' };
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'OPENAI_API_KEY not set' };

  const t0 = Date.now();
  console.log(`🌐 brand enrichment: fetching ${brand.websiteUrl} for "${brand.name}"`);

  // ── Fetch homepage ──
  let html = '';
  let metaThemeColor = null;
  try {
    const res = await axios.get(brand.websiteUrl, {
      timeout: 20000,
      maxContentLength: 4 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LiquidRetailBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      },
      // Don't throw on 4xx/5xx — some brand sites block bots but still serve
      // enough meta; we'll inspect what we got.
      validateStatus: () => true
    });
    html = typeof res.data === 'string' ? res.data : String(res.data || '');
    const themeMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
    if (themeMatch) metaThemeColor = themeMatch[1];
  } catch (err) {
    console.warn(`   ⚠️  brand enrichment fetch failed for ${brand.websiteUrl}: ${err.message}`);
    return { ok: false, reason: `fetch failed: ${err.message}` };
  }

  const textContent = extractTextFromHtml(html).slice(0, MAX_HTML_CHARS);
  if (textContent.length < 200) {
    console.warn(`   ⚠️  brand enrichment: ${brand.websiteUrl} returned too little text (${textContent.length} chars) — likely bot-blocked`);
    return { ok: false, reason: 'too little text' };
  }

  // ── LLM extraction ──
  const prompt =
    `You are analyzing the homepage of "${brand.name}" (${brand.websiteUrl}) to fill a brand catalog entry.\n\n` +
    `Source text from the homepage (HTML stripped):\n"""\n${textContent}\n"""\n\n` +
    `Return JSON matching the schema. Rules:\n` +
    `- "tagline": one line, their own positioning if visible on the page; omit if you can't find it.\n` +
    `- "tone": 2–5 single-word descriptors of the brand's voice (e.g. ["rugged","practical","technical"]).\n` +
    `- "primaryColor" / "secondaryColor" / "accentColor": 6-digit hex strings (e.g. "#0a2540"). Use meta theme-color or visible brand colors when detectable; otherwise best-guess from positioning/category. Omit if truly no signal.\n` +
    `- "demographics": 3–5 key target customer personas this brand clearly serves. Each persona:\n` +
    `    • "name": short, memorable (e.g. "Saltwater Joe", "Weekend Warrior", "Urban Professional")\n` +
    `    • "description": one sentence (≤ 20 words) describing who they are\n` +
    `    • "interests": 3–5 one-word or short-phrase interests\n` +
    `    • "painPoints": 2–4 short phrases describing what they worry about that this brand solves\n` +
    `    • "toneHint": one sentence describing how this persona talks (informs notional quote generation)\n` +
    `Ground personas in the brand's actual positioning; don't invent irrelevant personas. If the brand is niche, 2 personas is fine.`;

  let enrichment;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.3
    });
    enrichment = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.warn(`   ⚠️  brand enrichment LLM failed for "${brand.name}": ${err.message}`);
    return { ok: false, reason: `LLM failed: ${err.message}` };
  }

  // ── Save enrichment (don't overwrite already-set colors if the LLM omits) ──
  const hostname = hostnameFromUrl(brand.websiteUrl);
  const logoUrl = hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=128` : brand.logoUrl;

  brand.tagline        = enrichment.tagline || brand.tagline;
  brand.tone           = Array.isArray(enrichment.tone) && enrichment.tone.length ? enrichment.tone : brand.tone;
  brand.primaryColor   = metaThemeColor || enrichment.primaryColor   || brand.primaryColor;
  brand.secondaryColor = enrichment.secondaryColor || brand.secondaryColor;
  brand.accentColor    = enrichment.accentColor    || brand.accentColor;
  brand.logoUrl        = brand.logoUrl || logoUrl;
  if (Array.isArray(enrichment.demographics) && enrichment.demographics.length) {
    brand.demographics = enrichment.demographics.slice(0, 6).map(d => ({
      name:        d.name,
      description: d.description || '',
      interests:   Array.isArray(d.interests)  ? d.interests.slice(0, 6)  : [],
      painPoints:  Array.isArray(d.painPoints) ? d.painPoints.slice(0, 4) : [],
      toneHint:    d.toneHint || ''
    }));
  }
  brand.source = 'enriched';
  brand.enrichedAt = new Date();
  await brand.save();

  console.log(`   ✓ brand enrichment done for "${brand.name}": ${brand.demographics?.length || 0} demographic(s) in ${Date.now() - t0}ms`);
  return { ok: true, brand };
}

function extractTextFromHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

module.exports = { enrichBrandFromUrl };
