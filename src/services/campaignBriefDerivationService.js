// Campaign-level creative-brief derivation.
//
// For ONE existing Meta/Google campaign, walks its targeting + objective
// + adSets.ads.creative + matchedProductIds + insights and asks
// GPT-4o-mini to extract a structured brief: goal, pitch, focus,
// audience, tone, cta_emphasis. Stamped on Campaign.creativeBrief +
// Campaign.briefDerivedAt and threaded into aiCreativeDirectorService
// as CAMPAIGN BRIEF context whenever generation is campaign-scoped.
//
// Independent of Brand.derivedVoice (which is brand-global) — the brief
// is the per-campaign INTENT layer that sits between brand voice and
// product specifics. Triggered manually via
// POST /api/campaigns/:id/derive-brief and on campaign sync (debounced).

const Campaign       = require('../models/Campaign');
const CatalogProduct = require('../models/CatalogProduct');
const Brand          = require('../models/Brand');
const { trackLlmCall } = require('./costTracker');

const { chatCompletion } = require('./atlasLlmService');

const MODEL_ID       = 'gpt-4o-mini';
const PROMPT_VERSION = '1.0.0';
const TEMPERATURE    = 0.4;
const MAX_TOKENS     = 1200;
const TTL_DAYS       = 7;

const RESPONSE_SCHEMA = {
  name:   'campaign_creative_brief',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'pitch', 'focus', 'audience', 'tone', 'cta_emphasis'],
    properties: {
      goal: {
        type:        'string',
        description: 'What this campaign is actually trying to do — one sentence. E.g. "drive sales of Summer Sale SKUs", "introduce the new fall collection", "retarget cart-abandoners".'
      },
      pitch: {
        type:        'string',
        description: 'The single argument this campaign makes to the audience — 1–2 sentences. The "because" behind the ask.'
      },
      focus: {
        type:        'string',
        description: 'What the campaign leans on hardest — one of: "price", "scarcity", "lifestyle", "social_proof", "performance", "novelty", "transformation", "trust", "discovery". Pick the dominant lever.'
      },
      audience: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'segments', 'geo', 'ageRange', 'interests'],
        properties: {
          description: { type: 'string', description: '1–2 sentence portrait of who this is for.' },
          segments:    { type: 'array', items: { type: 'string' }, description: 'Discrete segment labels — "young men 25-34", "outdoor enthusiasts", etc.' },
          geo:         { type: 'array', items: { type: 'string' }, description: 'Geographic targeting from the campaign — "US", "CA-ON", etc.' },
          ageRange:    { type: 'string', description: 'Age range — "25–45" or "all".' },
          interests:   { type: 'array', items: { type: 'string' }, description: 'Interest categories from targeting.' }
        }
      },
      tone: {
        type:     'array',
        minItems: 1,
        maxItems: 6,
        items:    { type: 'string', description: 'One word — "urgent", "warm", "confident", etc.' }
      },
      cta_emphasis: {
        type:        'string',
        description: 'CTA energy — one of: "urgent", "aspirational", "low_friction", "informational", "playful".'
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are a creative strategist reverse-engineering a single ad campaign\'s creative brief from its targeting, objective, and live creatives.',
    'Your output is fed to a Creative Director GPT that will generate NEW ads for this campaign — accuracy here means new ads inherit the same intent.',
    '',
    'RULES:',
    '- Anchor every field to evidence in the campaign data — targeting block, objective, creative copy, matched products. Do NOT invent.',
    '- "goal" should reflect the platform objective (PURCHASE / TRAFFIC / AWARENESS) combined with what the creatives actually say. A purchase-objective campaign whose copy is all aspirational lifestyle is "introduce the brand to new audiences via purchase intent", not just "drive sales".',
    '- "pitch" is the ARGUMENT, not a slogan. Read the body copy across the ads and identify the through-line.',
    '- "focus" picks ONE dominant lever. Don\'t list multiple.',
    '- "audience.description" should read like a portrait of a person, not a list of demographics.',
    '- If targeting is broad / interest-based with no geo restriction, say so — don\'t over-specify.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

function formatTargeting(targeting) {
  if (!targeting) return '(no targeting data)';
  const parts = [];
  if (targeting.ageMin != null || targeting.ageMax != null) {
    parts.push(`Age: ${targeting.ageMin ?? '?'}–${targeting.ageMax ?? '?'}`);
  }
  if (Array.isArray(targeting.geo) && targeting.geo.length) {
    parts.push(`Geo: ${targeting.geo.slice(0, 10).join(', ')}`);
  }
  if (Array.isArray(targeting.interests) && targeting.interests.length) {
    parts.push(`Interests: ${targeting.interests.slice(0, 12).join(', ')}`);
  }
  if (Array.isArray(targeting.audiences) && targeting.audiences.length) {
    parts.push(`Audiences: ${targeting.audiences.slice(0, 8).join(', ')}`);
  }
  if (Array.isArray(targeting.devices) && targeting.devices.length) {
    parts.push(`Devices: ${targeting.devices.join(', ')}`);
  }
  return parts.length ? parts.join('\n  ') : '(no structured targeting fields)';
}

function buildUserPrompt({ campaign, productTitles, brand = null }) {
  const lines = [];
  lines.push(`Campaign: ${campaign.name}`);
  if (campaign.objective)      lines.push(`Platform objective: ${campaign.objective}`);
  if (campaign.kind)           lines.push(`Derived kind: ${campaign.kind}`);
  if (campaign.platform)       lines.push(`Source: ${campaign.platform}`);
  if (campaign.status)         lines.push(`Status: ${campaign.status}`);
  if (campaign.schedule?.start || campaign.schedule?.end) {
    lines.push(`Schedule: ${campaign.schedule.start || '?'} → ${campaign.schedule.end || 'open'}`);
  }
  lines.push('');
  lines.push('TARGETING:');
  lines.push(`  ${formatTargeting(campaign.targeting)}`);
  lines.push('');

  if (productTitles.length) {
    lines.push(`PRODUCTS PROMOTED (${productTitles.length}):`);
    for (const t of productTitles.slice(0, 20)) lines.push(`  - ${t}`);
    lines.push('');
  }

  if (campaign.insights && campaign.insights.impressions) {
    const ins = campaign.insights;
    lines.push('PERFORMANCE SIGNAL:');
    lines.push(`  Impressions: ${ins.impressions}, CTR: ${ins.ctr ? (ins.ctr * 100).toFixed(2) + '%' : '-'}, Conversions: ${ins.conversions ?? '-'}`);
    lines.push('');
  }

  // Walk every ad's creative for the LLM to read. Empty for
  // platform-native (reach-social) campaigns.
  const creatives = [];
  for (const adSet of (campaign.adSets || [])) {
    for (const ad of (adSet.ads || [])) {
      const c = ad.creative || {};
      const body  = String(c.body  || '').trim();
      const title = String(c.title || '').trim();
      const cta   = String(c.callToAction || '').trim();
      if (!body && !title && !cta) continue;
      creatives.push({ title, body, cta, linkUrl: c.linkUrl || null });
    }
  }
  lines.push(`AD CREATIVES (${creatives.length}):`);
  for (const cr of creatives.slice(0, 30)) {
    lines.push('---');
    if (cr.title)   lines.push(`Title: ${cr.title}`);
    if (cr.body)    lines.push(`Body:  ${cr.body.slice(0, 500)}`);
    if (cr.cta)     lines.push(`CTA:   ${cr.cta}`);
    if (cr.linkUrl) lines.push(`Link:  ${cr.linkUrl}`);
  }
  lines.push('');

  // Platform-native campaigns arrive with no ad creatives to
  // reverse-engineer from. Fall back to brand voice + campaign
  // metadata (kind, name, objective, products) as the LLM's evidence
  // for the brief. Same output shape either way.
  if (creatives.length === 0 && brand) {
    lines.push('NO AD CREATIVES AVAILABLE — this is a platform-native campaign created inside the operator app. Synthesize the brief from the campaign metadata above and the brand voice below.');
    lines.push('');
    lines.push('BRAND VOICE:');
    if (brand.name)    lines.push(`  Brand: ${brand.name}`);
    if (brand.tagline) lines.push(`  Tagline: "${brand.tagline}"`);
    if (Array.isArray(brand.tone) && brand.tone.length) {
      lines.push(`  Tone: ${brand.tone.slice(0, 8).join(', ')}`);
    }
    if (brand.websiteUrl) lines.push(`  Website: ${brand.websiteUrl}`);
    const dv = brand.derivedVoice || {};
    if (dv.voice_summary) lines.push(`  Voice summary: ${dv.voice_summary}`);
    if (Array.isArray(dv.value_props) && dv.value_props.length) {
      lines.push(`  Recurring value props: ${dv.value_props.slice(0, 5).join('; ')}`);
    }
    if (Array.isArray(dv.hooks) && dv.hooks.length) {
      lines.push(`  Hook patterns: ${dv.hooks.slice(0, 5).join('; ')}`);
    }
    if (Array.isArray(dv.common_phrases) && dv.common_phrases.length) {
      lines.push(`  Recurring phrases: ${dv.common_phrases.slice(0, 5).map(p => `"${p}"`).join(', ')}`);
    }
    lines.push('');
    if (campaign.kind === 'brand') {
      lines.push('KIND-DRIVEN GUIDANCE (kind=brand): No specific product to sell — the brief should anchor on brand identity, positioning, and top-of-funnel discovery. focus lever should favor "trust", "discovery", or "lifestyle". cta_emphasis should favor "aspirational" or "informational", NOT "urgent".');
    } else if (campaign.kind === 'promotional') {
      lines.push('KIND-DRIVEN GUIDANCE (kind=promotional): Deal / sale campaign. focus lever should favor "price" or "scarcity". cta_emphasis should favor "urgent".');
    } else if (campaign.kind === 'collection') {
      lines.push('KIND-DRIVEN GUIDANCE (kind=collection): Multi-product launch or grouping. focus lever should favor "novelty" or "discovery". cta_emphasis should favor "informational" or "aspirational".');
    } else {
      lines.push('KIND-DRIVEN GUIDANCE (kind=product): Single-product performance campaign. focus lever should favor "performance", "social_proof", or "transformation" depending on brand positioning. cta_emphasis should favor "low_friction" or "urgent".');
    }
    lines.push('');
  }

  lines.push('Derive the creative brief for this campaign.');
  return lines.join('\n');
}

// Public API — derive brief for one campaign. force=true bypasses TTL.
async function deriveCampaignBrief(campaignId, { force = false, derivedFrom = 'manual' } = {}) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  if (!force && campaign.briefDerivedAt) {
    const ageMs = Date.now() - new Date(campaign.briefDerivedAt).getTime();
    if (ageMs < TTL_DAYS * 24 * 60 * 60 * 1000) {
      return { skipped: true, reason: 'TTL', ageMs, brief: campaign.creativeBrief };
    }
  }

  // Resolve matched product titles for the prompt — gives the LLM
  // context on what's actually being promoted (a campaign with
  // "Summer Sale Tee" + "Beach Shorts" reads differently than one
  // with "Premium Leather Wallet" + "Steel Watch").
  let productTitles = [];
  if (Array.isArray(campaign.matchedProductIds) && campaign.matchedProductIds.length) {
    const products = await CatalogProduct.find({
      _id: { $in: campaign.matchedProductIds }
    }).select('title').lean();
    productTitles = products.map(p => p.title).filter(Boolean);
  }

  // Load brand voice — used as fallback signal for platform-native
  // (reach-social) campaigns that have no ad creatives to
  // reverse-engineer from. Cheap select; buildUserPrompt no-ops the
  // brand block when creatives are present.
  const brand = await Brand.findById(campaign.brandId)
    .select('name tagline tone websiteUrl derivedVoice').lean();

  const system = buildSystemPrompt();
  const user   = buildUserPrompt({ campaign, productTitles, brand });

  const t0 = Date.now();
  const completion = await chatCompletion(
    {
      stage:      'campaign_brief',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: 'brief_derivation',
      brandId:    campaign.brandId,
      visionImages: 0,
      cacheKey:   null
    },
    {
      model:           MODEL_ID,
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: TEMPERATURE,
      max_tokens:  MAX_TOKENS
    }
  );

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('brief derivation returned no content');

  const parsed = JSON.parse(raw);
  const elapsedMs = Date.now() - t0;

  // Count ads we actually evidenced from + flag top performer creative
  // ids. Top performer = whichever ad's parent campaign had any
  // insights; we treat all ads of THIS campaign as equally weighted for
  // now (brief is per-campaign already — no need to re-weight inside).
  let adCount = 0;
  const topCreativeIds = [];
  for (const adSet of (campaign.adSets || [])) {
    for (const ad of (adSet.ads || [])) {
      const c = ad.creative || {};
      if (c.body || c.title || c.callToAction) {
        adCount++;
        if (ad.externalId) topCreativeIds.push(ad.externalId);
      }
    }
  }

  const brief = {
    ...parsed,
    evidence: {
      adCount,
      topPerformerCreativeIds: topCreativeIds.slice(0, 10),
      productCount: productTitles.length,
      hasInsights:  !!(campaign.insights && campaign.insights.impressions)
    },
    derivedFrom,
    model:         MODEL_ID,
    promptVersion: PROMPT_VERSION
  };

  await Campaign.updateOne(
    { _id: campaignId },
    { $set: { creativeBrief: brief, briefDerivedAt: new Date() } }
  );

  console.log(
    `📋 campaignBrief: campaign=${campaignId} ads=${adCount} focus=${parsed.focus} cta=${parsed.cta_emphasis} took=${elapsedMs}ms`
  );

  return { ok: true, brief, elapsedMs };
}

module.exports = {
  deriveCampaignBrief,
  TTL_DAYS,
  PROMPT_VERSION
};
