// Capability registry — SINGLE source of truth for what the home-page
// AI agent can do, AND what the UI can expose in menus. Both layers read
// the same array so they cannot drift.
//
// Every capability describes ONE user-facing action. Agent tools are
// generated from these entries via capabilitiesToTools(); UI menus are
// filtered by applicableCapabilities(scope, contextDoc). The `execute`
// block resolves to an in-process service call — no self-HTTP re-auth
// cycle — so tenant scoping stays on the authenticated `req`.
//
// RULES ENFORCED HERE:
// - id is globally unique.
// - tier ∈ [0, 4]:
//     0 = read-only, autonomous
//     1 = cheap write, inline confirm
//     2 = billable write, confirm + resource/spend estimate
//     3 = external / hard-to-reverse, explicit "I understand" confirm
//     4 = multi-step workflow, plan-first
// - scope ∈ {'ad', 'brand', 'advertiser', 'product', 'campaign', 'global'}
//   — the context shape the capability needs. UI filters by scope so a
//   brand-scoped menu never shows an ad-scoped capability.
// - args uses JSONSchema (OpenAI/Anthropic tool-schema compatible).
// - execute.kind ∈ {'service'}. HTTP kind reserved for cross-service
//   calls; not used yet.
// - when (optional) is an array of Mongo-style predicates evaluated
//   against the context doc — see applicableCapabilities.
//
// FORBIDDEN HERE:
// - Business logic. The registry describes actions, never implements
//   them. Every execute lands in an existing service.
// - Cross-tenant leaks. Services MUST tenant-scope; the executor only
//   forwards `req` (carrying advertiserId + user).
// - Bypassing spend caps. Tier 2+ capabilities MUST consult spendGuard
//   inside the service before dispatching billable work.

'use strict';

const VALID_TIERS   = new Set([0, 1, 2, 3, 4]);
const VALID_SCOPES  = new Set(['ad', 'brand', 'advertiser', 'product', 'campaign', 'global']);
const VALID_KINDS   = new Set(['service']);   // 'route' reserved for later

// ═══════════════════════════════════════════════════════════════════
// THE MANIFEST
// ═══════════════════════════════════════════════════════════════════
//
// Add entries here. Every entry is a plain object; no code in this file
// runs on load. Order is display order for the manifest render.

const CAPABILITIES = [

  // ── Tier 0: read-only, autonomous ────────────────────────────────

  {
    id:       'catalog.listProducts',
    title:    'List products',
    describe: 'List products for the current brand. Filter by rough state — e.g. missing lifestyle image, missing on-site reviews, or none for a full list. Returns count plus up to 20 sample rows.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      properties: {
        brandId: {
          type: 'string',
          description: 'Brand ObjectId. Defaults to the caller-selected brand.'
        },
        missing: {
          type: 'string',
          enum: ['lifestyle_image', 'onsite_reviews', 'video_media'],
          description: 'Optional filter: only include products lacking this asset.'
        },
        limit: {
          type: 'integer',
          minimum: 1, maximum: 100,
          description: 'Row cap (default 20). The count is always the full total.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogListProducts',
      method:  'run'
    }
  },

  {
    id:       'ad.inspect',
    title:    'Inspect ad',
    describe: 'Return the generation-inspector payload for one ad — model, prompt, references, warnings, regen state. Same source the Generation Details modal reads.',
    tier:     0,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId:    { type: 'string', description: 'Ad ObjectId.' },
        brandId: { type: 'string', description: 'Optional — inferred from the ad if omitted.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adInspect',
      method:  'run'
    }
  },

  {
    id:       'campaign.list',
    title:    'List campaigns',
    describe: 'List campaigns for the current brand. Returns count + per-campaign summary (name, platform, kind, status, adsetCount). Filter by platform (\'meta-ads\', \'google-ads\', \'reach-social\') to narrow.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId:  { type: 'string', description: 'Brand ObjectId.' },
        platform: { type: 'string', enum: ['meta-ads', 'google-ads', 'reach-social'],
                    description: 'Optional platform filter.' },
        limit:    { type: 'integer', minimum: 1, maximum: 100,
                    description: 'Row cap (default 20). The count is always the full total.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignList',
      method:  'run'
    }
  },

  {
    id:       'run.status',
    title:    'Get CampaignRun status',
    describe: 'Return the current status of one CampaignRun (a generation batch) by runId string or ObjectId. Includes counts, ad-level status rollup ({queued, rendering, draft, failed, ...}), and up to 6 recent errors[] rows so the agent can answer "why is my run stuck?" without a second call.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string', description: 'Either the string runId (e.g. \'run_1785268035192_...\') or the CampaignRun ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/runStatus',
      method:  'run'
    }
  },

  {
    id:       'spend.today',
    title:    'Spend today',
    describe: 'Return the current advertiser\'s ad-generation spend since midnight UTC. Breaks down by provider (Atlas video, Atlas image, LLM) and returns a total in USD.',
    tier:     0,
    scope:    'advertiser',
    args: {
      type: 'object',
      properties: {
        sinceHoursAgo: {
          type: 'integer',
          minimum: 1, maximum: 168,
          description: 'Window in hours (default 24). Cap 168 = 7 days.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/spendToday',
      method:  'run'
    }
  },

  // ── Tier 1: cheap writes, inline confirmation required ───────────

  {
    id:       'ad.archive',
    title:    'Archive ad',
    describe: 'Move one ad to status \'archived\'. Reversible via ad.restore. Does not delete the render or the artifact — just hides the ad from active views. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adArchive',
      method:  'run'
    }
  },

  {
    id:       'ad.restore',
    title:    'Restore archived ad',
    describe: 'Move an archived ad back to status \'draft\'. Reverses ad.archive. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adRestore',
      method:  'run'
    }
  },

  {
    id:       'brand.updateTagline',
    title:    'Update brand tagline',
    describe: 'Set a brand\'s tagline (marketing one-liner used in generated ads and layout inputs). Reversible by calling again with the previous value. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'tagline'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        tagline: { type: 'string', minLength: 1, maxLength: 200,
                   description: 'New tagline text. Max 200 chars.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandUpdateTagline',
      method:  'run'
    }
  },

  {
    id:       'ad.updateCta',
    title:    'Update ad CTA',
    describe: 'Set an ad\'s CTA text, URL, or URL params. Reversible via a second call with the previous values (returned as priorCta). Refuses ads already synced to Meta (mutation would drift from the canonical Meta record). The already-rendered PNG/MP4 still shows the OLD CTA — regenerate to update the pixels. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId:         { type: 'string', description: 'Ad ObjectId.' },
        ctaText:      { type: 'string', maxLength: 60, description: 'New CTA button text (e.g. "Shop Now"). Empty string clears.' },
        ctaUrl:       { type: 'string', maxLength: 2000, description: 'New CTA destination URL (must start with http:// or https:// when non-empty). Empty string clears.' },
        ctaUrlParams: { type: 'string', maxLength: 500, description: 'Optional URL params suffix (e.g. "utm_source=meta&utm_campaign=…"). Empty string clears.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adUpdateCta',
      method:  'run'
    }
  },

  // ── Tier 2: billable writes — confirmation + spend-guard both apply ─

  {
    id:       'ad.regenerateWithPrompt',
    title:    'Regenerate image ad with edited prompt',
    describe: 'Re-run the gpt-image-2/edit render for one image ad using a verbatim prompt override the operator supplied. Billable (~$0.15 per call). Regeneration happens asynchronously (30-90s) — this capability kicks it off and returns immediately; poll ad.inspect for status. Image ads only; refuses ads that have been synced to Meta. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'ad',
    // Static cost estimate. Measured 2026-07-31: real openai/gpt-image-2/
    // edit call at quality:'medium' with 1 reference at 1024x1024
    // is ~$0.15 per call. spendGuard reads this + the advertiser's
    // rolling 24h spend to enforce AGENT_DAILY_CAP_USD.
    estimateUsd: 0.15,
    args: {
      type: 'object',
      required: ['adId', 'promptOverride'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId (must be a kind=\'image\' ad, not synced to Meta).' },
        promptOverride: {
          type: 'object',
          required: ['system', 'user'],
          properties: {
            system: { type: 'string', minLength: 1, maxLength: 40000,
                      description: 'System prompt sent to the image model verbatim.' },
            user:   { type: 'string', minLength: 1, maxLength: 40000,
                      description: 'User prompt sent to the image model verbatim.' }
          },
          additionalProperties: false,
          description: 'Verbatim {system, user} prompt pair. Both required, ≤40000 chars each.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adRegenerateWithPrompt',
      method:  'run'
    }
  },

  // ── Tier 3: external / hard-to-reverse ────────────────────────────

  {
    id:       'ads.publishToMeta',
    title:    'Publish ads to Meta',
    describe: 'Push a batch of rendered ads to a Meta Ads adset. Ads become live in Meta the moment they clear review — this is not reversible from here (an operator can pause the adset in Meta Ads Manager). Requires operator confirmation AND the explicit phrase "PUBLISH TO META" typed in the confirmation UI. Ads must have a renderUrl and cannot already be synced.',
    tier:     3,
    scope:    'brand',
    // Tier 3 machinery: the operator must type this exact string in
    // the client's confirmation UI. Endpoint checks
    // req.body.explicitConfirmations[tool_call_id] === explicitConfirmation
    // before dispatching, in addition to the id being in confirmations[].
    explicitConfirmation: 'PUBLISH TO META',
    // Zero USD cost — Meta API for ad creation is free (ad spend is
    // billed by Meta separately per the adset budget). Declared
    // explicitly to satisfy the validateManifest tier ≥ 2 rule.
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId', 'adsetId', 'adIds'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        adsetId: { type: 'string', description: 'Meta Ads adset external id (not our ObjectId).' },
        adIds:   {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: 'string' },
          description: 'Ad ObjectIds to publish. All must belong to the brand and have a renderUrl. Batch capped at 20 — split larger runs.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adsPublishToMeta',
      method:  'run'
    }
  },

  // ── Tier 4: multi-step workflows (plan-preview + confirm-then-execute) ─

  {
    id:       'catalog.refreshReviewsForBrand',
    title:    'Refresh on-site reviews for a brand',
    describe: 'Fan-out: for every product under a brand that hasn\'t been through the on-site scraper, invoke the 3-tier review engine (JSON-LD → vendor API → optional headless). Captures per-review star ratings that the gemini-search fallback drops. Non-billable (HTTP GETs only). On invocation you receive a PLAN (which products, estimated wall time); the operator must confirm before execution begins.',
    tier:     4,
    scope:    'brand',
    // Tier 4 executors export preview() + execute() instead of run().
    // The endpoint's gate calls preview when the tool_call is not yet
    // confirmed, execute when the operator has confirmed.
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogRefreshReviewsForBrand',
      // No single 'method' — two-phase Tier 4. Names locked as
      // 'preview' + 'execute' by the endpoint's gate logic.
      workflow: true
    },
    // Non-billable — HTTP scrape, no LLM/model cost. Declared explicitly
    // to satisfy the validateManifest tier ≥ 2 estimateUsd rule.
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Products under this brand missing on-site review data are the fan-out set.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'catalog.generateLifestyleImages',
    title:    'Generate lifestyle images for products missing one',
    describe: 'Fan-out: for every product under a brand that lacks a lifestyle_image AND has a hero image to ground the generation, call gpt-image-2/edit with a lifestyle-scene prompt and upload the result to Cloudinary as CatalogProduct.lifestyle_image. Billable (~$0.04 per image; batch capped at 50 products per run so max cost is ~$2). On invocation you receive a PLAN (which products, aggregate cost, wall time); the operator must confirm before execution begins.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogGenerateLifestyleImages',
      workflow: true
    },
    // Static UPPER-BOUND estimate — MAX_STEPS_PER_RUN (50) *
    // PER_UNIT_ESTIMATE_USD ($0.04) = $2.00. Overestimates rather than
    // underestimates: spendGuard rejects when spent + $2 > cap, even
    // if the brand has only 5 products with $0.20 real cost. A live
    // estimator (async query per dispatch) is a follow-up if the
    // overestimate rejects too aggressively; static is safer for MVP.
    estimateUsd: 2.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Products under this brand lacking lifestyle_image (and having a hero image) are the fan-out set.' }
      },
      additionalProperties: false
    }
  }
];

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert a capability list into OpenAI-compatible tool schemas —
 * accepted verbatim by Atlas's chat/completions gateway and, in the
 * follow-up streaming PR, by the native Anthropic SDK too.
 */
function capabilitiesToTools(caps = CAPABILITIES) {
  return caps.map((c) => ({
    type: 'function',
    function: {
      name:        c.id.replace(/\./g, '__'),   // OpenAI: [a-zA-Z0-9_-]{1,64}
      description: `[tier=${c.tier}, scope=${c.scope}] ${c.describe}`,
      parameters:  c.args || { type: 'object', properties: {}, additionalProperties: false }
    }
  }));
}

/**
 * Reverse of capabilitiesToTools' name-munging. Tool call names arrive
 * as 'catalog__listProducts'; the registry keys them as 'catalog.listProducts'.
 */
function capabilityById(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

function capabilityByToolName(name) {
  const id = String(name || '').replace(/__/g, '.');
  return capabilityById(id);
}

/**
 * Filter capabilities by scope and evaluate `when` predicates against a
 * context doc. Returns { ok, why? } tuples so the UI can show WHY a
 * capability is disabled (e.g. "ad is exported — read-only").
 *
 * A capability with no `when` array is always applicable within scope.
 * A `when` array is AND-joined; every clause must pass.
 */
function applicableCapabilities(scope, contextDoc = {}) {
  return CAPABILITIES
    .filter((c) => c.scope === scope)
    .map((c) => {
      const failing = (c.when || []).find((clause) => !evalClause(clause, contextDoc));
      return failing
        ? { capability: c, ok: false, why: describeClause(failing) }
        : { capability: c, ok: true };
    });
}

/**
 * Render a compact human-readable manifest for injection into the agent's
 * system prompt. Deliberately terse — the LLM only needs id, tier, scope,
 * and a one-sentence describe to route intents. Full args live in the
 * tool schemas via capabilitiesToTools.
 */
function describeManifest(caps = CAPABILITIES) {
  return caps.map((c) =>
    `- id=${c.id} tier=${c.tier} scope=${c.scope}: ${c.describe}`
  ).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL — where the sift-lite matcher would live
// ═══════════════════════════════════════════════════════════════════

// Tiny Mongo-style operator evaluator. Supports $eq (implicit), $ne, $in,
// $nin, $exists. Dot-path field lookup. NO regex / no arbitrary code.
// Kept in-file so the registry file has zero deps.
function getPath(doc, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
}
function evalClause(clause, doc) {
  return Object.entries(clause).every(([field, cond]) => {
    const actual = getPath(doc, field);
    if (cond == null || typeof cond !== 'object') return actual === cond;
    if ('$eq'     in cond) return actual === cond.$eq;
    if ('$ne'     in cond) return actual !== cond.$ne;
    if ('$in'     in cond) return Array.isArray(cond.$in)  && cond.$in.includes(actual);
    if ('$nin'    in cond) return Array.isArray(cond.$nin) && !cond.$nin.includes(actual);
    if ('$exists' in cond) return cond.$exists ? actual != null : actual == null;
    return false;   // unknown operator — fail closed
  });
}
function describeClause(clause) {
  return Object.entries(clause).map(([field, cond]) => {
    if (cond == null || typeof cond !== 'object') return `${field}=${JSON.stringify(cond)}`;
    const [op, val] = Object.entries(cond)[0] || [];
    return `${field} ${op} ${JSON.stringify(val)}`;
  }).join(' AND ');
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION (verifier consumes this)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return structural problems with the manifest. Empty array means clean.
 * Called by scripts/verifyAgentRegistry.js in CI and at boot when
 * AGENT_ENABLED=true.
 */
function validateManifest(caps = CAPABILITIES) {
  const problems = [];
  const seen = new Set();
  for (const c of caps) {
    const at = `[${c.id || '<no-id>'}]`;
    if (!c.id || typeof c.id !== 'string') problems.push(`${at} missing id`);
    if (seen.has(c.id)) problems.push(`${at} duplicate id`);
    seen.add(c.id);
    if (!c.title)                            problems.push(`${at} missing title`);
    if (!c.describe)                         problems.push(`${at} missing describe`);
    if (!VALID_TIERS.has(c.tier))            problems.push(`${at} invalid tier ${c.tier}`);
    if (!VALID_SCOPES.has(c.scope))          problems.push(`${at} invalid scope ${c.scope}`);
    if (!c.execute)                          problems.push(`${at} missing execute block`);
    if (c.execute && !VALID_KINDS.has(c.execute.kind))
      problems.push(`${at} execute.kind='${c.execute.kind}' invalid (want one of ${[...VALID_KINDS].join(',')})`);
    // Two execute shapes: standard (kind:'service', service, method) OR
    // workflow (kind:'service', service, workflow:true) for two-phase
    // Tier 4 executors that export preview() + execute() instead of
    // a single method.
    if (c.execute?.kind === 'service') {
      if (!c.execute.service) {
        problems.push(`${at} execute.service required`);
      } else if (c.execute.workflow === true) {
        if (c.execute.method) {
          problems.push(`${at} workflow executors must not declare method (they export preview/execute)`);
        }
      } else if (!c.execute.method) {
        problems.push(`${at} execute service+method required (or set workflow:true for two-phase Tier 4 executors)`);
      }
    }
    if (c.args && c.args.type !== 'object')
      problems.push(`${at} args.type must be 'object' (got '${c.args.type}')`);
    // Tier ≥ 2 needs a cost estimator — spendGuard rejects capabilities
    // without one. Enforce here so a new Tier 2+ entry can't be added
    // without spend-guard coverage.
    if (typeof c.tier === 'number' && c.tier >= 2) {
      const e = c.estimateUsd;
      const hasEstimator = (typeof e === 'number' && e >= 0) || typeof e === 'function';
      if (!hasEstimator) {
        problems.push(`${at} tier ${c.tier} requires estimateUsd (number ≥ 0 or function returning one)`);
      }
    }
    // Tier 3 needs an explicit-confirmation phrase — the "type YES"
    // ceremony that separates external / hard-to-reverse actions from
    // ordinary Tier 1/2 confirmations. Tier 4 workflows use the
    // plan-preview + confirm cycle as their ceremony instead; they MAY
    // additionally declare a phrase (a workflow that publishes to Meta
    // in bulk, say), but it's optional. Endpoint's phraseCheck honours
    // the declaration when present regardless of tier.
    if (c.tier === 3) {
      const p = c.explicitConfirmation;
      if (typeof p !== 'string' || p.length < 4 || p.length > 100) {
        problems.push(`${at} tier 3 requires explicitConfirmation (4-100 char phrase the operator must type)`);
      }
    }
    // Any capability that DID declare a phrase must meet the shape rule
    // regardless of tier — a length-2 phrase or a non-string would
    // slip past the endpoint check silently.
    if (c.explicitConfirmation != null) {
      const p = c.explicitConfirmation;
      if (typeof p !== 'string' || p.length < 4 || p.length > 100) {
        problems.push(`${at} explicitConfirmation must be a 4-100 char string when declared`);
      }
    }
  }
  return problems;
}

module.exports = {
  CAPABILITIES,
  capabilitiesToTools,
  capabilityById,
  capabilityByToolName,
  applicableCapabilities,
  describeManifest,
  validateManifest,
  // exported for the verifier's precondition tests
  __test: { evalClause, describeClause, getPath }
};
