// Product reasoner — takes raw results from the match providers and asks
// GPT-4.1 to synthesize them into a single identified product with a
// certainty score. The per-provider URLs stay on the response as evidence,
// but the UI hero card is driven by this synthesis.

const { chatCompletion } = require('./atlasLlmService');

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

  // ── Evidence blocks (2026-08-17 rewrite) ──────────────────────────
  //
  // Prior version put every signal into a single USER / VISION HINTS
  // block positioned below WEB SEARCH EVIDENCE. Measured over 500 UGC
  // matches on 2026-08-13: 76% landed in brand_match, with the model
  // treating captions and OCR text as background instead of as
  // first-class evidence. This split lifts them into their own
  // evidence categories the model is told to weight explicitly.
  //
  // VISION SIGNALS are hints (what CV saw). CAPTION + OCR are stronger
  // — direct authorial signal from the source content. The old
  // "user-provided" framing implied they were untrusted; now they are
  // named evidence categories with weight instructions in the task.
  const visionHints = [];
  if (brand)          visionHints.push(`Brand (context): ${brand}`);
  if (category)       visionHints.push(`Category (context): ${category}`);
  if (primarySubject) visionHints.push(`Vision label: ${primarySubject}`);

  const captionBlock = caption && String(caption).trim()
    ? `CAPTION (posted alongside the image, first-class evidence):\n"${String(caption).trim()}"`
    : null;

  const ocrBlock = textDetected.length
    ? `VISIBLE TEXT ON PRODUCT (OCR — SKU-grade signal when present):\n${textDetected.slice(0, 10).map(t => `- "${t}"`).join('\n')}`
    : null;

  const prompt =
    `You are identifying a specific product from a brand's catalog. Multiple evidence streams are available; ` +
    `use them together and return a single best-match identification.\n\n` +
    `VISION SIGNALS:\n${visionHints.join('\n')}\n\n` +
    (captionBlock ? `${captionBlock}\n\n` : '') +
    (ocrBlock ? `${ocrBlock}\n\n` : '') +
    `WEB SEARCH EVIDENCE (${trimmed.length} results, 1-indexed):\n${evidenceBlock}\n\n` +
    `TASK — how to weigh the evidence (be decisive, not defensive):\n` +
    `  1. If the CAPTION or OCR text names a product on the brand, that is STRONG evidence on its own —\n` +
    `     independent of web hit count. A caption like "@brand chore jacket in indigo" identifies the SKU.\n` +
    `  2. Look at the attached IMAGE and cross-reference against retailer thumbnails in the evidence list.\n` +
    `     If the crop and a thumbnail depict the same object, cite that evidenceIndex as "strong".\n` +
    `  3. Any URL that resolves to a product page (retailer OR brand — e.g. /products/, /dp/, /p/) is\n` +
    `     authoritative for identification. Do NOT downweight retailer product pages relative to brand.com;\n` +
    `     they name the SAME SKU. The brand's own site is a tiebreaker, not a requirement.\n` +
    `  4. Editorial URLs (/blog/, /pages/, /collections/) are brand-level evidence — never product-level.\n` +
    `  5. When multiple signals converge on the same identification, add them; do not average them down.\n\n` +
    `Only include evidence whose URL actually supports the identification.\n\n` +
    `CERTAINTY GUIDE (align to the strongest evidence, don't hedge for missing weaker signals):\n` +
    `  0.90–1.00 (high)    : caption/OCR names it AND at least one product-page URL confirms\n` +
    `  0.70–0.89 (high)    : product-page URL(s) match; OR caption/OCR names it; OR image↔thumbnail match\n` +
    `  0.50–0.69 (medium)  : one credible source matches; or retailer consensus with partial label match\n` +
    `  0.25–0.49 (low)     : plausible match, weak evidence (brand-level only, no product-page URL)\n` +
    `  0.00–0.24 (unknown) : truly nothing to work with\n\n` +
    `When a plausible identification exists, name it and let the certainty score reflect residual doubt. ` +
    `Do NOT default to null productName when evidence supports a candidate — that is fabrication avoidance ` +
    `taken too far. Fabrication protection is the URL-type guard downstream; your job here is to identify.\n\n` +
    `Return ONLY JSON:\n` +
    `{\n` +
    `  "productName": "exact product name as the brand lists it, e.g. 'The SUPER Hydrator'",\n` +
    `  "variant": "size/color/edition if identifiable, e.g. '15 ml / 0.5 fl oz', else null",\n` +
    `  "brand": "confirmed brand name",\n` +
    `  "certainty": 0.00-1.00,\n` +
    `  "certaintyLabel": "high" | "medium" | "low" | "unknown",\n` +
    `  "reasoning": "2-3 sentences explaining the identification, naming which evidence items were decisive (by 1-indexed number). Cite the caption/OCR/image-match if used.",\n` +
    `  "primaryUrl": "the single best product-page URL from the evidence",\n` +
    `  "primaryRetailer": "domain of the primaryUrl",\n` +
    `  "primaryThumbnail": "thumbnail url from one of the evidence items, or null",\n` +
    `  "evidenceIndices": [\n` +
    `    { "index": 1, "weight": "strong" | "supporting" | "weak" }\n` +
    `  ]\n` +
    `}`;

  const messages = [
    {
      role: 'system',
      content:
        'You are a precise product identification assistant. You read captions, visible labels, brand marks, ' +
        'attached images, and web evidence to identify the specific SKU a user is looking at. You are decisive: ' +
        'when the available evidence supports a plausible identification, name the product and use the certainty ' +
        'score to reflect residual uncertainty. Do not default to unnamed when a plausible identification exists — ' +
        'fabrication protection is enforced downstream by URL and brand-mismatch guards. Under-attribution costs ' +
        'the same as over-attribution here; the certainty score is the honest signal for callers.'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...(imageUrl ? [{ type: 'image_url', image_url: { url: imageUrl } }] : [])
      ]
    }
  ];

  const response = await chatCompletion({ stage: 'product_reasoning', service: 'productReasoner' }, {
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
