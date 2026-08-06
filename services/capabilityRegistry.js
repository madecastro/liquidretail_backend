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
    id:       'ad.list',
    title:    'List recent ads',
    describe: 'List recent ads for the current brand, newest first. Filter by kind (\'image\' | \'video\'), status (queued/rendering/draft/live/archived/failed), and sinceHoursAgo (default 24, cap 168 = 7 days). Returns count + sample rows with renderUrl, template, aspect, status, and timestamps — enough to answer "what did I just generate?" without a follow-up ad.inspect on each.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        kind:    { type: 'string', enum: ['image', 'video'], description: 'Optional filter.' },
        status:  { type: 'string', enum: ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'], description: 'Optional filter.' },
        sinceHoursAgo: { type: 'integer', minimum: 1, maximum: 168, description: 'Window in hours (default 24). Cap 168 = 7 days.' },
        limit:   { type: 'integer', minimum: 1, maximum: 50, description: 'Row cap (default 10). The count is always the full total.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adList',
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
    id:       'platform.listFormats',
    title:    'List supported ad surfaces',
    describe: 'Enumerate every ad surface the platform supports (Meta feed 1:1 / 4:5, Meta reels 9:16, Meta stories 9:16, PMax 16:9, etc.). Returns per-format canvas dims, delivery dims, safe zones, aspect ratio, supported kinds (image / video), status (live / coming_soon), and a one-line creativeBrief describing the surface. Also groups by platform with each platform\'s presets (\'meta_static\', \'meta_video\', \'meta_all\', ...) so the agent can answer both "which formats exist?" and "what does the meta_all preset cover?" without a second call. Optional filters: platform (\'meta\' | \'google\') or formatKey (a specific format).',
    tier:     0,
    scope:    'global',
    args: {
      type: 'object',
      properties: {
        platform:  { type: 'string', description: 'Optional platform filter (e.g. "meta", "google").' },
        formatKey: { type: 'string', description: 'Optional specific format key (e.g. "meta_feed_4_5"). Returns just that row.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/platformListFormats',
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

  // ── Phase 1: Campaigns — reach-social lifecycle from chat ─────────

  {
    id:       'campaign.create',
    title:    'Create campaign',
    describe: 'Create a new reach-social campaign under a brand. Kind must be \'brand\', \'product\', or \'promotional\'. Optional productIds[] and mediaIds[] pre-populate the wizard\'s Step 2 selection; ids that don\'t belong to the same brand are silently dropped and reported. Blocked by the ad-readiness gate (every connected integration must have ≥1 completed DetectRun). Only creates reach-social campaigns; platform-synced ones (meta-ads / google-ads) originate on the platform side. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'name', 'kind'],
      properties: {
        brandId:    { type: 'string', description: 'Brand ObjectId the campaign belongs to.' },
        name:       { type: 'string', minLength: 1, maxLength: 200, description: 'Campaign display name.' },
        kind:       { type: 'string', enum: ['brand', 'product', 'promotional'], description: 'Campaign kind — drives Director + wizard behavior.' },
        productIds: { type: 'array', items: { type: 'string' }, description: 'Optional CatalogProduct ObjectIds to pre-select (mismatched brand → dropped).' },
        mediaIds:   { type: 'array', items: { type: 'string' }, description: 'Optional Media ObjectIds to pre-select (mismatched brand → dropped).' },
        promotionalDetails: {
          type: 'object',
          description: 'Only consulted when kind=\'promotional\'. Free-form: { startsAt?, endsAt?, discountType?, discountValue?, discountCode?, giveaway?, headline?, notes? }. Dates as ISO strings.',
          additionalProperties: true
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignCreate',
      method:  'run'
    }
  },

  {
    id:       'campaign.patch',
    title:    'Edit campaign',
    describe: 'Edit reach-social campaign fields (name, kind, promotionalDetails, useImageRefAsProduction). Refuses synced campaigns (meta-ads / google-ads) — their state mirrors the platform. Returns prior values as \'prior\' so the operator can revert. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId'],
      properties: {
        campaignId:   { type: 'string', description: 'Campaign ObjectId.' },
        name:         { type: 'string', minLength: 1, maxLength: 200, description: 'New campaign name.' },
        campaignKind: { type: 'string', enum: ['brand', 'product', 'promotional', 'collection'], description: 'New campaign kind (mapped to Campaign.kind).' },
        useImageRefAsProduction: { type: 'boolean', description: 'When true, display the gpt-image polished render as the production ad image.' },
        promotionalDetails: { type: ['object', 'null'], description: 'Merged over existing promotionalDetails (null clears). Dates as ISO strings.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignPatch',
      method:  'run'
    }
  },

  {
    id:       'campaign.delete',
    title:    'Delete campaign',
    describe: 'Hard-delete a reach-social campaign and its directly-owned children (Ads, CampaignRun rows, rendered Cloudinary PNGs). Shared artifacts (LayoutInput, AiCanvas, CreativeDirection, etc.) are preserved because they belong to media/brand, not campaign. Refuses synced campaigns. IRREVERSIBLE in the DB — surface the campaign name + rendered-ad count in confirmation before proceeding.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignDelete',
      method:  'run'
    }
  },

  {
    id:       'campaign.addProducts',
    title:    'Add products to campaign',
    describe: 'Add CatalogProduct ids to Campaign.matchedProductIds via $addToSet (idempotent — dupes are silently ignored). Products that don\'t belong to the campaign\'s brand are dropped and reported in droppedProductIds. Reports the pre-and-post totals so the operator sees exactly what changed. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId', 'productIds'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        productIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200,
                      description: 'CatalogProduct ObjectIds to add.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignAddProducts',
      method:  'run'
    }
  },

  {
    id:       'campaign.removeProduct',
    title:    'Remove product from campaign',
    describe: '$pull one CatalogProduct id from Campaign.matchedProductIds. Idempotent — removing an already-absent product is a no-op. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId', 'productId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        productId:  { type: 'string', description: 'CatalogProduct ObjectId to remove.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignRemoveProduct',
      method:  'run'
    }
  },

  {
    id:       'campaign.addMedia',
    title:    'Add media to campaign',
    describe: 'Add Media ids to Campaign.mediaIds via $addToSet (idempotent). Media that don\'t belong to the campaign\'s brand are dropped and reported. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId', 'mediaIds'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        mediaIds:   { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200,
                      description: 'Media ObjectIds to add.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignAddMedia',
      method:  'run'
    }
  },

  {
    id:       'campaign.removeMedia',
    title:    'Remove media from campaign',
    describe: '$pull one Media id from Campaign.mediaIds. Idempotent. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId', 'mediaId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        mediaId:    { type: 'string', description: 'Media ObjectId to remove.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignRemoveMedia',
      method:  'run'
    }
  },

  {
    id:       'campaign.removeAd',
    title:    'Unlink ad from campaign',
    describe: 'UNLINK an ad from a campaign (sets Ad.campaignId = null). The Ad doc and its rendered asset remain — only the campaign association is dropped. The ad still surfaces in ad.list (as an orphan) but no longer appears in the campaign\'s view. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId', 'adId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        adId:       { type: 'string', description: 'Ad ObjectId to unlink.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignRemoveAd',
      method:  'run'
    }
  },

  {
    id:       'campaign.patchBrief',
    title:    'Edit campaign creative brief',
    describe: 'Manually override Campaign.creativeBrief. Set to null to clear (a subsequent sync will re-derive automatically); set to an object to override the AI-derived brief. Stamps briefDerivedAt so the auto-refresh on sync treats the override as fresh. Returns priorBrief so the operator can revert. Requires operator confirmation.',
    tier:     1,
    scope:    'campaign',
    args: {
      type: 'object',
      required: ['campaignId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        brief: {
          type: ['object', 'null'],
          description: 'Full brief object or null to clear. Shape: { goal?, pitch?, focus?, audience?, tone?, cta_emphasis?, ... }.',
          additionalProperties: true
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignPatchBrief',
      method:  'run'
    }
  },

  // ── Phase 2: Ad curation — approve/patch/bulk-archive ─────────────

  {
    id:       'ad.approve',
    title:    'Approve ad',
    describe: 'Flip Ad.approved=true. Orthogonal to status (render lifecycle); approval drives the Draft / Approved / Exported grouping on the Product Ads page. Reversible via ad.unapprove. Idempotent — approving an already-approved ad is a no-op. Requires operator confirmation.',
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
      service: './capabilityExecutors/adApprove',
      method:  'run'
    }
  },

  {
    id:       'ad.unapprove',
    title:    'Un-approve ad',
    describe: 'Reverse of ad.approve. Clears Ad.approved + approvedAt + approvedBy. Idempotent. Requires operator confirmation.',
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
      service: './capabilityExecutors/adUnapprove',
      method:  'run'
    }
  },

  {
    id:       'ad.patch',
    title:    'Edit ad copy',
    describe: 'Edit Ad.copy fields (headline, cta_text, quote, productName, productPrice). Each field ≤300 chars; empty string clears; null clears. Refuses ads already synced to Meta (mutation would drift). The already-rendered PNG/MP4 still shows the OLD text — regenerate to update the pixels. Returns priorCopy so the operator can revert. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId', 'copy'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' },
        copy: {
          type: 'object',
          description: 'Fields to update. Provide only the keys you want changed. Send null or empty string to clear a field.',
          properties: {
            headline:      { type: ['string', 'null'], maxLength: 300 },
            cta_text:      { type: ['string', 'null'], maxLength: 300 },
            quote:         { type: ['string', 'null'], maxLength: 300 },
            productName:   { type: ['string', 'null'], maxLength: 300 },
            productPrice:  { type: ['string', 'null'], maxLength: 300 }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adPatch',
      method:  'run'
    }
  },

  {
    id:       'ad.bulkArchive',
    title:    'Archive many ads at once',
    describe: 'Archive up to 50 ads in one call. Each row is tenant-checked independently — a single mismatched-brand id doesn\'t abort the batch; it\'s reported in the per-row outcomes. Idempotent per row (alreadyArchived) and reversible per row via ad.restore. Great for cleaning up a batch of failed or draft ads without a per-row confirmation cycle.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['adIds'],
      properties: {
        adIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 50,
          description: 'Ad ObjectIds to archive. Max 50 per call.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adBulkArchive',
      method:  'run'
    }
  },

  // ── Phase 3: Brand config — create/patch/voice/uploadSettings ─────

  {
    id:       'brand.create',
    title:    'Create brand',
    describe: 'Create a Brand under the caller\'s advertiser. Idempotent on (advertiserId, nameNormalized) — returns a brand-exists error when a brand with the same normalized name already exists (returned brand._id so the operator can pivot). If websiteUrl is supplied, fires background enrichment (Brandfetch → scrape → LLM) which populates logo, tagline, summary, tone, hashtags, tags over the next 30-90s. Requires operator confirmation.',
    tier:     1,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['name'],
      properties: {
        name:         { type: 'string', minLength: 1, maxLength: 200, description: 'Brand display name.' },
        websiteUrl:   { type: 'string', description: 'Brand website — triggers background enrichment when set.' },
        tagline:      { type: 'string', maxLength: 200, description: 'Optional marketing tagline (locks the field as curated).' },
        primaryColor: { type: 'string', description: 'Optional hex like \'#ff5533\' (locks the field as curated).' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandCreate',
      method:  'run'
    }
  },

  {
    id:       'brand.patch',
    title:    'Edit brand fields',
    describe: 'Partial update for editable brand fields (name, websiteUrl, tagline, summary, logoUrl, primaryColor, secondaryColor, accentColor, fontColor, websiteBackground, fontFamily, tone, hashtags, tags). Any field set here is added to Brand.curatedFields so auto-enrichment leaves it alone. Voice edits go through brand.voice.patch. If websiteUrl changes, enrichment is retriggered in the background. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'updates'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        updates: {
          type: 'object',
          description: 'Fields to update. Provide only the keys you want changed. Send null to clear a field.',
          properties: {
            name:              { type: ['string', 'null'], maxLength: 500 },
            websiteUrl:        { type: ['string', 'null'], maxLength: 500 },
            tagline:           { type: ['string', 'null'], maxLength: 500 },
            summary:           { type: ['string', 'null'], maxLength: 500 },
            logoUrl:           { type: ['string', 'null'], maxLength: 500 },
            primaryColor:      { type: ['string', 'null'], maxLength: 500 },
            secondaryColor:    { type: ['string', 'null'], maxLength: 500 },
            accentColor:       { type: ['string', 'null'], maxLength: 500 },
            fontColor:         { type: ['string', 'null'], maxLength: 500 },
            websiteBackground: { type: ['string', 'null'], maxLength: 500 },
            fontFamily:        { type: ['string', 'null'], maxLength: 500 },
            tone:              { type: ['string', 'null'], maxLength: 500 },
            hashtags:          { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20 },
            tags:              { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20 }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandPatch',
      method:  'run'
    }
  },

  {
    id:       'brand.voice.patch',
    title:    'Override brand voice',
    describe: 'Manual override of Brand.derivedVoice. Set to null to clear (auto-refresh will re-derive later); set to an object to override the AI-derived voice profile. Stamps derivedVoiceAt fresh so the sweep treats it as recent. Returns priorVoice so the operator can revert. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        voice: {
          type: ['object', 'null'],
          description: 'Voice profile object or null to clear. Shape is free-form ({ tone_descriptors, principles, disallowed_phrases, ... }).',
          additionalProperties: true
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandVoicePatch',
      method:  'run'
    }
  },

  {
    id:       'brand.uploadSettings.patch',
    title:    'Edit brand upload settings',
    describe: 'Update Brand.uploadSettings. Currently only autoCreateFromDetect is supported — when true, confident review-detection matches auto-write draft CatalogProduct rows. Off by default. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'settings'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        settings: {
          type: 'object',
          required: [],
          properties: {
            autoCreateFromDetect: { type: 'boolean', description: 'When true, confident detect matches auto-write draft CatalogProduct rows.' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandUploadSettingsPatch',
      method:  'run'
    }
  },

  // ── Phase 4: Catalog & media — T1 patches ─────────────────────────

  {
    id:       'catalog.patchProduct',
    title:    'Edit catalog product',
    describe: 'Partial update for editable CatalogProduct fields (title, brand, category, price, currency, productUrl, imageUrl, description, draft). Send null or empty string to clear a text field. Setting draft=false on a previously-draft row promotes it — retroactively linking any unlinked ProductMatchArtifact evidence and collapsing detect-identified twins. LayoutInputArtifact caches carry the OLD values until re-derive; regenerate affected ads to see the change in rendered pixels. Requires operator confirmation.',
    tier:     1,
    scope:    'product',
    args: {
      type: 'object',
      required: ['productId', 'updates'],
      properties: {
        productId: { type: 'string', description: 'CatalogProduct ObjectId.' },
        updates: {
          type: 'object',
          description: 'Fields to update. Provide only the keys you want changed. Send null or empty string to clear a text field.',
          properties: {
            title:       { type: ['string', 'null'], maxLength: 2000 },
            brand:       { type: ['string', 'null'], maxLength: 2000 },
            category:    { type: ['string', 'null'], maxLength: 2000 },
            price:       { type: ['number', 'null'] },
            currency:    { type: ['string', 'null'], maxLength: 2000 },
            productUrl:  { type: ['string', 'null'], maxLength: 2000 },
            imageUrl:    { type: ['string', 'null'], maxLength: 2000 },
            description: { type: ['string', 'null'], maxLength: 2000 },
            draft:       { type: 'boolean', description: 'Flip false to promote a review-queue draft into the main catalog (retroactive match-link fires).' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogPatchProduct',
      method:  'run'
    }
  },

  {
    id:       'catalog.patchCategories',
    title:    'Edit category-level video / titling overrides',
    describe: 'Set per-category videoSettings (model slugs + reference count + promptGuidance) and/or titleStyleSpec on a Category row. Cascades to every CatalogProduct under the category on the NEXT ad generation — already-rendered ads are unaffected until they regenerate. videoSettings shallow-merges with any existing values so multiple partial patches do not clobber sibling keys; send null on a specific key to clear. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['categoryId', 'updates'],
      properties: {
        categoryId: { type: 'string', description: 'Category ObjectId.' },
        updates: {
          type: 'object',
          description: 'Fields to update. Provide only the keys you want changed. Send null to clear a field entirely.',
          properties: {
            videoSettings:  { type: ['object', 'null'], additionalProperties: true, description: 'videoSettings object ({ model?, modelByCanvas?, referenceImageCount?, promptGuidance? }). Shallow-merged with any existing value.' },
            titleStyleSpec: { type: ['object', 'null'], additionalProperties: true, description: 'titleStyleSpec object ({ vertical?, feed?, landscape? }). Replace semantics (not merged).' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogPatchCategories',
      method:  'run'
    }
  },

  {
    id:       'media.patchRights',
    title:    'Toggle media creator-rights approval',
    describe: 'Set Media.rights.approved (boolean). The layout generator refuses to ship ugc.rights_approved=true on creative inputs unless this is true. approvedBy defaults to the caller when omitted; approvedAt is stamped server-side on approve and cleared on unapprove. Ads that already assembled a LayoutInputArtifact carry the OLD rights state until they re-derive. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['mediaId', 'approved'],
      properties: {
        mediaId:    { type: 'string', description: 'Media ObjectId.' },
        approved:   { type: 'boolean', description: 'true → mark rights approved; false → clear approval.' },
        approvedBy: { type: ['string', 'null'], maxLength: 200, description: 'Optional approver identifier (email / license source). Defaults to the caller.' },
        notes:      { type: ['string', 'null'], maxLength: 2000, description: 'Optional free-text context (license source, negotiation notes).' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaPatchRights',
      method:  'run'
    }
  },

  {
    id:       'media.draftProduct',
    title:    'Save media match as draft catalog product',
    describe: 'Forces a draft CatalogProduct write from the media\'s latest ProductMatchArtifact — the manual escape hatch when the automatic path is off or the match was below the confidence floor. Requires an existing ProductMatchArtifact (run detect first). Bypasses the brand\'s autoCreateFromDetect flag and the certainty threshold. Draft rows surface in the catalog browser\'s drafts queue for the operator to fill in price + productUrl before they become matchable. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId: { type: 'string', description: 'Media ObjectId — must have at least one ProductMatchArtifact.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaDraftProduct',
      method:  'run'
    }
  },

  {
    id:       'media.delete',
    title:    'Soft-delete media',
    describe: 'Soft-delete a Media row — stamps Media.deletedAt so the row disappears from the Media Library list and the campaign wizard picker. Direct-id lookups still resolve, so any Ad or Campaign that already references this Media keeps rendering with the original asset (no orphaned renders). The Cloudinary asset is intentionally NOT destroyed — hard-delete + cascade lives on the REST DELETE /api/media/:id route and stays out of chat. Idempotent (alreadyDeleted:true if run twice). Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId: { type: 'string', description: 'Media ObjectId to soft-delete.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaDelete',
      method:  'run'
    }
  },

  {
    id:       'media.upload',
    title:    'Get signed Cloudinary upload credential',
    describe: 'Issue a short-lived signed Cloudinary direct-upload payload the frontend uses to POST a file straight to Cloudinary. The chat drawer renders an upload card from the returned endpoint + formFields; on success the frontend posts the resulting secure_url back through the media finalization endpoint to create the Media row. This capability itself creates NO Media doc — it only issues the credential. Signature expires in 10 min by default; folder is scoped to advertiser + brand so a leaked credential cannot upload into another tenant. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId:      { type: 'string', description: 'Brand ObjectId — folder scope for the upload.' },
        resourceType: { type: 'string', enum: ['image', 'video'], description: 'Cloudinary resource type. Defaults to image.' },
        ttlSec:       { type: 'integer', minimum: 60, maximum: 3600, description: 'Signature TTL in seconds (60-3600). Default 600.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaUpload',
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

  {
    id:       'campaign.deriveBrief',
    title:    'Derive campaign creative brief',
    describe: 'Run campaignBriefDerivationService against a campaign — an LLM call that extracts a structured creative brief (goal, pitch, focus, audience, tone, cta_emphasis, evidence) from the campaign\'s targeting, objective, matched products, and ad creatives. Threads into the Director as CAMPAIGN BRIEF context when generation is campaign-scoped. Billable (~$0.02, Sonnet). Respects a 7-day TTL by default; pass force=true to re-derive. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'campaign',
    estimateUsd: 0.02,
    args: {
      type: 'object',
      required: ['campaignId'],
      properties: {
        campaignId: { type: 'string', description: 'Campaign ObjectId.' },
        force:      { type: 'boolean', description: 'When true, re-derive even if the brief is younger than 7 days.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/campaignDeriveBrief',
      method:  'run'
    }
  },

  {
    id:       'brand.deriveVoice',
    title:    'Derive brand voice from ad history',
    describe: 'Run brandVoiceDerivationService — an LLM call against the brand\'s existing Meta/Google ad creatives to extract a structured voice profile (tone descriptors, voice principles, disallowed phrases). Threads into the Director. Billable (~$0.02, Sonnet). Respects a 7-day TTL by default; pass force=true to re-derive. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 0.02,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        force:   { type: 'boolean', description: 'When true, re-derive even if the voice is younger than 7 days.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandDeriveVoice',
      method:  'run'
    }
  },

  {
    id:       'brand.refreshEnrichment',
    title:    'Refresh brand enrichment (logo, tone, tagline, tags)',
    describe: 'Manually re-run the enrichment pipeline: Brandfetch (logo, colors, fonts) → website scrape (background) → LLM enrichment (tagline, summary, tone, hashtags, tags, demographics). Resets enrichmentSources and unlocks empty curated fields so the operator\'s intent to re-populate is respected. Requires brand.websiteUrl. Billable (~$0.15 aggregate). Runs synchronously — the SSE stream stays open ~30-90s. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 0.15,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandRefreshEnrichment',
      method:  'run'
    }
  },

  {
    id:       'catalog.inferCategories',
    title:    'Infer product categories from JSON-LD / page',
    describe: 'Run productCategoryInferenceService for one CatalogProduct — walks the product\'s public page (JSON-LD BreadcrumbList first; falls back to Gemini page-walk), resolves a Category leaf via findOrCreateCategoryTree, and stamps CatalogProduct.categoryRef + inferredBreadcrumb. Respects a 14-day TTL unless force=true. Requires product.productUrl. Billable (~$0.02 when the LLM fallback fires; free on JSON-LD hits). Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'product',
    // Bounded per-call — even the JSON-LD-miss LLM fallback caps around
    // $0.02 (short prompt, structured output). Overestimates rather
    // than underestimates for the spendGuard bookkeeping.
    estimateUsd: 0.02,
    args: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId: { type: 'string', description: 'CatalogProduct ObjectId. Must have productUrl set.' },
        force:     { type: 'boolean', description: 'When true, bypass the 14-day inference TTL and re-scrape.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogInferCategories',
      method:  'run'
    }
  },

  {
    id:       'media.refreshInsights',
    title:    'Refresh IG insights + comments for one media',
    describe: 'Re-pull platformStats (impressions, reach, engagement, saved, views/plays, likes, comments, shares) and top-level comments for one Instagram Media from the Meta Graph API. Same operation the /api/media/:id/refresh-insights route triggers. Refuses non-Instagram Media (other sources have no analytics endpoint). No per-call dollar cost, but Tier 2 gating so a runaway agent can\'t burn the app\'s daily IG token budget. Requires operator confirmation.',
    tier:     2,
    scope:    'brand',
    // Zero direct USD — Meta Graph API is free at reasonable volumes.
    // spendGuard still applies as a rate-limiter (agent can't call
    // this indefinitely against the advertiser's cap even at $0).
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId: { type: 'string', description: 'Media ObjectId. Must be source=\'instagram\' with an externalId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaRefreshInsights',
      method:  'run'
    }
  },

  {
    id:       'brand.ingestFonts',
    title:    'Ingest brand fonts from website',
    describe: 'Scan the brand\'s website for its custom typefaces via brandFontIngestService (Brandfetch + scrape). Persists resolved font files into Brand.customFonts and updates Brand.fontFamily. Billable (~$0.05 aggregate). Requires brand.websiteUrl. Runs synchronously. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 0.05,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandIngestFonts',
      method:  'run'
    }
  },

  // ── Tier 3: external / hard-to-reverse ────────────────────────────

  {
    id:       'ad.delete',
    title:    'Permanently delete ad',
    describe: 'HARD-DELETE an Ad doc + best-effort destroy of the Cloudinary render asset. IRREVERSIBLE — the Cloudinary asset is gone, and the render cannot be reconstituted without re-billing generation (~$0.15-$1.10 depending on kind). Prefer ad.archive for hide-until-later use cases. Refuses ads already synced to Meta (would leave a dangling Meta creative). Requires the explicit phrase "DELETE AD" typed in the confirmation UI.',
    tier:     3,
    scope:    'ad',
    explicitConfirmation: 'DELETE AD',
    estimateUsd: 0,
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
      service: './capabilityExecutors/adDelete',
      method:  'run'
    }
  },

  {
    id:       'brand.delete',
    title:    'Permanently delete brand + cascade',
    describe: 'FULL CASCADE DELETE — removes the brand and every downstream row: Media, CatalogProduct, Ad, Campaign, CampaignRun, IntegrationCredential, LayoutInputArtifact, AiCanvasArtifact, and every other brand-keyed collection. Also destroys Cloudinary assets (best-effort). IRREVERSIBLE and typically hundreds-to-thousands of rows. Requires TWO safety gates: (1) the explicit phrase "DELETE BRAND" typed in the confirmation UI, AND (2) confirmName arg must equal the brand\'s current name exactly.',
    tier:     3,
    scope:    'brand',
    explicitConfirmation: 'DELETE BRAND',
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId', 'confirmName'],
      properties: {
        brandId:     { type: 'string', description: 'Brand ObjectId.' },
        confirmName: { type: 'string', description: 'The brand\'s current name — must match exactly. Belt-and-braces safety gate.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandDelete',
      method:  'run'
    }
  },

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
  },

  {
    id:       'catalog.detectProductsFromMedia',
    title:    'Enqueue detect on a brand\'s undetected media',
    describe: 'Fan-out: for every Media under the brand that lacks a strong product match (no product_match / product_category outcome), enqueue a DetectRun with trigger=\'manual-rematch\' priority:1. The worker picks them up. Returns immediately with the runIds; actual pipeline execution (YOLO + Gemini identify + matching) happens in the worker. Skips catalog-product wrappers and soft-deleted rows. Capped at 50 media per run. Billable (~$0.05 per image); an operator receives a PLAN with target count + estimated cost before confirming.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogDetectProductsFromMedia',
      workflow: true
    },
    // MAX_STEPS_PER_RUN=50 * PER_UNIT_ESTIMATE_USD=$0.05 = $2.50 ceiling.
    estimateUsd: 2.50,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId:  { type: 'string', description: 'Brand ObjectId.' },
        fileType: { type: 'string', enum: ['image', 'video'], description: 'Optional filter — restrict enqueue to one fileType. Omit for both.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'catalog.syncFromShopifyPublic',
    title:    'Pull public Shopify catalog',
    describe: 'Fan-out: run shopifyPublicIngestService.syncBrandShopifyDirect against the brand\'s public storefront (Brand.shopifyUrl OR Brand.websiteUrl). Tries the resolver ladder — products.json → Storefront GraphQL → sitemap fallback — and upserts CatalogProduct rows by (brandId, externalId). Downstream detect + enrichment enqueue is fire-and-forget inside the service. Cap: SHOPIFY_DIRECT_LIMIT (default 200). Heavy sync (potentially minutes); the SSE stream stays open for the whole run. Non-billable at the API layer (downstream detect + LLM enrichment costs are separate).',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogSyncFromShopifyPublic',
      workflow: true
    },
    // Shopify products.json is free. Downstream detect ($0.05/image) +
    // enrichment (~$0.05/product) fire from separate workers under
    // separate spend gates.
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have shopifyUrl or websiteUrl set.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'catalog.pullFromApify',
    title:    'Pull demo-brand data via Apify',
    describe: 'Fan-out: run apifyIngestService.syncBrandApify for a DEMO BRAND (Brand.isDemo=true). Pulls IG posts (source=apify-ig → Media + DetectRun) and Shopify catalog (source=apify-shopify → CatalogProduct) per Brand.apifyDemo config. Actor selection is server-controlled by apifyDemo.method (shopify-direct | apify | generic-sitemap); the agent cannot pick arbitrary Apify actors. Rejects non-demo brands (Sales Demos advertiser bucket only). Billable — Apify actors + downstream enrichment. Heavy sync (usually 1-3 min).',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogPullFromApify',
      workflow: true
    },
    // Upper-bound estimate: IG pull ~$0.20 + Shopify pull ~$0.15 +
    // downstream enrichment can run $0.50+ on a fresh 200-product
    // catalog. $1.00 leaves headroom for the enrichment tail.
    estimateUsd: 1.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have isDemo=true and apifyDemo config set.' }
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
