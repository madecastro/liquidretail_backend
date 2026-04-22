// Product reasoner — takes raw results from the match providers and asks
// GPT-4.1 to synthesize them into a single identified product with a
// certainty score. The per-provider URLs stay on the response as evidence,
// but the UI hero card is driven by this synthesis.

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function identifyProduct({
  brand,
  category,
  caption,
  primarySubject,
  textDetected = [],
  imageUrl,
  providers = {}
}) {
  // Flatten all provider matches into a single evidence list, preserving origin
  const evidence = [];
  for (const [providerName, data] of Object.entries(providers)) {
    for (const m of data?.matches || []) {
      if (!m.url) continue;
      evidence.push({
        provider: providerName,
        title: m.title || '',
        url: m.url,
        retailer: m.retailer || '',
        snippet: m.snippet || '',
        thumbnail: m.thumbnail || null,
        priceHint: m.priceHint || null
      });
    }
  }

  if (evidence.length === 0) {
    return {
      productName: null,
      variant: null,
      brand: brand || null,
      certainty: 0,
      certaintyLabel: 'unknown',
      reasoning: 'No web evidence available to identify a specific product.',
      primaryUrl: null,
      primaryRetailer: null,
      primaryThumbnail: null,
      evidenceUrls: []
    };
  }

  // Cap the evidence list we send to GPT to keep tokens sensible
  const MAX_EVIDENCE = 20;
  const trimmed = evidence.slice(0, MAX_EVIDENCE);
  const evidenceBlock = trimmed.map((e, i) =>
    `${i + 1}. [${e.provider}] ${e.title}\n   retailer: ${e.retailer}\n   url: ${e.url}${e.priceHint ? `\n   price: ${e.priceHint}` : ''}${e.snippet ? `\n   snippet: ${e.snippet.slice(0, 200)}` : ''}`
  ).join('\n\n');

  const hintsBlock = [];
  if (brand)          hintsBlock.push(`Brand (user-provided): ${brand}`);
  if (category)       hintsBlock.push(`Category (user-provided): ${category}`);
  if (caption)        hintsBlock.push(`Caption (user-provided): "${caption}"`);
  if (primarySubject) hintsBlock.push(`Visual description from computer vision: ${primarySubject}`);
  if (textDetected.length) hintsBlock.push(`Text visible on the product: ${textDetected.slice(0, 10).map(t => `"${t}"`).join(', ')}`);

  const prompt =
    `You are identifying a specific product from a brand's catalog based on image-derived hints ` +
    `and web search evidence. Triangulate across all signals and return a single best-match identification.\n\n` +
    `USER / VISION HINTS:\n${hintsBlock.join('\n')}\n\n` +
    `WEB SEARCH EVIDENCE (${trimmed.length} results, 1-indexed):\n${evidenceBlock}\n\n` +
    `TASK: Identify the specific product. Prefer the brand's own site as the authoritative source ` +
    `(e.g. ubeauty.com for U Beauty) when available. Then rank major retailers (Sephora, Nordstrom, etc.) ` +
    `over generic marketplaces. Only include evidence whose URL actually supports the identification.\n\n` +
    `CERTAINTY GUIDE:\n` +
    `  0.90–1.00 (high)    : brand site + at least one major retailer both show this exact product\n` +
    `  0.70–0.89 (high)    : multiple retailers agree; visible labels match product name\n` +
    `  0.50–0.69 (medium)  : one credible source matches; or retailer consensus with partial label match\n` +
    `  0.25–0.49 (low)     : plausible match, weak evidence (thumbnails only, or mixed signals)\n` +
    `  0.00–0.24 (unknown) : cannot identify confidently\n\n` +
    `Return ONLY JSON:\n` +
    `{\n` +
    `  "productName": "exact product name as the brand lists it, e.g. 'The SUPER Hydrator'",\n` +
    `  "variant": "size/color/edition if identifiable, e.g. '15 ml / 0.5 fl oz', else null",\n` +
    `  "brand": "confirmed brand name",\n` +
    `  "certainty": 0.00-1.00,\n` +
    `  "certaintyLabel": "high" | "medium" | "low" | "unknown",\n` +
    `  "reasoning": "2-3 sentences explaining the identification, naming which evidence items were decisive (by 1-indexed number)",\n` +
    `  "primaryUrl": "the single best URL from the evidence (brand site preferred)",\n` +
    `  "primaryRetailer": "domain of the primaryUrl",\n` +
    `  "primaryThumbnail": "thumbnail url from one of the evidence items, or null",\n` +
    `  "evidenceIndices": [\n` +
    `    { "index": 1, "weight": "strong" | "supporting" | "weak" }\n` +
    `  ]\n` +
    `}`;

  const messages = [
    {
      role: 'system',
      content: 'You are a precise product identification assistant. You read visible labels, brand marks, and web evidence to identify the specific SKU a user is looking at. You are conservative — if evidence is weak, you say so via the certainty score rather than inventing a product.'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...(imageUrl ? [{ type: 'image_url', image_url: { url: imageUrl } }] : [])
      ]
    }
  ];

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages,
    response_format: { type: 'json_object' },
    max_tokens: 1500,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Reasoner returned no JSON');
    parsed = JSON.parse(m[0]);
  }

  // Normalize + project evidence back to full entries (URL, title, etc.)
  const evidenceUrls = (parsed.evidenceIndices || [])
    .map(e => ({ ...trimmed[(e.index || 0) - 1], weight: e.weight || 'supporting' }))
    .filter(e => e.url);

  // If the model didn't supply primaryThumbnail but the primaryUrl matches one of the
  // evidence items, reuse that item's thumbnail.
  let primaryThumbnail = parsed.primaryThumbnail || null;
  if (!primaryThumbnail && parsed.primaryUrl) {
    const match = evidence.find(e => e.url === parsed.primaryUrl);
    if (match?.thumbnail) primaryThumbnail = match.thumbnail;
  }

  const certainty = Math.min(1, Math.max(0, Number(parsed.certainty) || 0));
  const certaintyLabel = parsed.certaintyLabel ||
    (certainty >= 0.7 ? 'high' : certainty >= 0.5 ? 'medium' : certainty >= 0.25 ? 'low' : 'unknown');

  return {
    productName:      parsed.productName || null,
    variant:          parsed.variant || null,
    brand:            parsed.brand || brand || null,
    certainty,
    certaintyLabel,
    reasoning:        parsed.reasoning || '',
    primaryUrl:       parsed.primaryUrl || null,
    primaryRetailer:  parsed.primaryRetailer || null,
    primaryThumbnail,
    evidenceUrls
  };
}

module.exports = { identifyProduct };
