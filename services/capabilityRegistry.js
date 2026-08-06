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

  // ── Ingestion coverage: P1 finalize + P3 URL-based product create ──

  {
    id:       'media.finalizeUpload',
    title:    'Finalize a signed Cloudinary upload into a Media row',
    describe: 'Pair with media.upload — once the frontend has POSTed the file to Cloudinary using the signed credential media.upload issued, hand the resulting secure_url back here to create the Media doc. Refuses secureUrls that are not under this deployment\'s Cloudinary cloud (CLOUDINARY_CLOUD_NAME) so an operator cannot smuggle an arbitrary external URL into the Media collection. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'secureUrl'],
      properties: {
        brandId:   { type: 'string', description: 'Brand ObjectId — Media inherits its tenant scope from this.' },
        secureUrl: { type: 'string', description: 'Cloudinary secure_url returned by the direct-upload POST. Must be under our own cloud name.' },
        fileType:  { type: 'string', enum: ['image', 'video'], description: 'Defaults to image.' },
        fileName:  { type: 'string', maxLength: 300, description: 'Optional original filename.' },
        metadata:  { type: 'object', additionalProperties: true, description: 'Optional metadata object (caption, hashtags, etc.).' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaFinalizeUpload',
      method:  'run'
    }
  },

  {
    id:       'catalog.createProduct',
    title:    'Create a catalog product from an image URL',
    describe: 'URL-based single-product create — Cloudinary mirrors the imageUrl into our own CDN and upserts a CatalogProduct row with source=\'manual-upload\'. Idempotent on (brandId, externalId) where externalId=\'manual:<title-slug>\'. draft=true unless BOTH price AND productUrl are supplied. Mirrors POST /api/upload/product but without the multipart file — pass any http/https imageUrl (Meta CDN, IG display_url, etc.) and Cloudinary pulls it. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'title', 'imageUrl'],
      properties: {
        brandId:    { type: 'string', description: 'Brand ObjectId.' },
        title:      { type: 'string', minLength: 1, maxLength: 500, description: 'Product title.' },
        imageUrl:   { type: 'string', maxLength: 2000, description: 'Remote image URL — must be http:// or https://. Cloudinary mirrors it into our CDN.' },
        price:      { type: ['number', 'null'], description: 'Optional non-negative number.' },
        currency:   { type: ['string', 'null'], maxLength: 3, description: 'Optional 3-letter ISO code (USD, EUR, ...).' },
        productUrl: { type: ['string', 'null'], maxLength: 2000, description: 'Optional http/https product page URL.' },
        gtin:       { type: ['string', 'null'], maxLength: 20, description: 'Optional GTIN (8/12/13/14-digit barcode); non-digits are stripped.' },
        mpn:        { type: ['string', 'null'], maxLength: 200, description: 'Optional manufacturer part number.' },
        category:   { type: ['string', 'null'], maxLength: 500 },
        description: { type: ['string', 'null'], maxLength: 4000 }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogCreateProduct',
      method:  'run'
    }
  },

  // ── Phase 6: Detection + layouts — T0 read ───────────────────────

  {
    id:       'aiLayouts.getSession',
    title:    'Poll AI layout session status',
    describe: 'Read-only poll of an AiLayoutSession — companion to aiLayouts.generate. Returns status, totalCombos, and up to 20 references (completed layout reference images). Once status is \'completed\' or \'failed\', no further changes will happen. Tenant-scoped via advertiserId on the session.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'AiLayoutSession ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/aiLayoutsGetSession',
      method:  'run'
    }
  },

  // ── Phase 6: Detection + layouts — T1 rematch ────────────────────

  {
    id:       'detect.rematch',
    title:    'Rematch detect on one media',
    describe: 'Create a new DetectRun with trigger=\'manual-rematch\' priority:1 for one Media — jumps ahead of routine catalog / IG-sync runs. Meant for the "the previous outcome was wrong, try again" flow. Refuses catalog-product wrapper Media and soft-deleted rows. Requires operator confirmation. Kept Tier 1 by design — the operator\'s explicit rematch intent implies acceptance of a potential cost hit, and per-image detect billing lands on separate spendGuard rows.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId: { type: 'string', description: 'Media ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/detectRematch',
      method:  'run'
    }
  },

  // ── Phase 10: Sales demos — T1 CRUD + abort ───────────────────────

  {
    id:       'sales.bootstrap',
    title:    'Bootstrap Sales Demos advertiser + membership',
    describe: 'Seed the Sales Demos advertiser row (idempotent) and grant the caller an active owner membership. Only callers whose email is on the SALES_DEMOS_ADMINS allowlist may invoke this. Runs even when the caller\'s current advertiser is NOT sales-demos — this is the way IN, so the standard scope guard is skipped. Requires operator confirmation.',
    tier:     1,
    scope:    'global',
    args: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBootstrap',
      method:  'run'
    }
  },

  {
    id:       'sales.brand.create',
    title:    'Create demo brand',
    describe: 'Create a new demo Brand under the Sales Demos advertiser. Sets isDemo=true + Brand.apifyDemo config (igHandle, shopifyUrl, method). Caller must be scoped to Sales Demos (use sales.bootstrap first if needed). Requires operator confirmation.',
    tier:     1,
    scope:    'global',
    args: {
      type: 'object',
      required: ['name'],
      properties: {
        name:       { type: 'string', minLength: 1, maxLength: 200, description: 'Brand display name.' },
        igHandle:   { type: ['string', 'null'], maxLength: 200, description: 'Optional Instagram handle (with or without @).' },
        shopifyUrl: { type: ['string', 'null'], maxLength: 500, description: 'Optional Shopify storefront URL.' },
        method:     { type: 'string', enum: ['shopify-direct', 'apify', 'generic-sitemap'], description: 'Catalog pull method. Defaults to shopify-direct when shopifyUrl is set.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandCreate',
      method:  'run'
    }
  },

  {
    id:       'sales.brand.patch',
    title:    'Patch demo brand Apify config',
    describe: 'Update the Apify config (igHandle, shopifyUrl, method) on an existing demo brand. Only these three fields are editable via this capability — use brand.patch (Phase 3) for the general brand surface. Requires operator confirmation.',
    tier:     1,
    scope:    'global',
    args: {
      type: 'object',
      required: ['brandId', 'updates'],
      properties: {
        brandId: { type: 'string', description: 'Demo Brand ObjectId.' },
        updates: {
          type: 'object',
          description: 'Apify-config fields to update.',
          properties: {
            igHandle:   { type: ['string', 'null'] },
            shopifyUrl: { type: ['string', 'null'] },
            method:     { type: 'string', enum: ['shopify-direct', 'apify', 'generic-sitemap'] }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandPatch',
      method:  'run'
    }
  },

  {
    id:       'sales.brand.abort',
    title:    'Abort in-flight demo brand pipeline',
    describe: 'Cooperative cancellation — sets Brand.apifyDemo.aborted=true. The in-flight ingest loop reads this flag between records and bails on next check. Already-ingested Media + CatalogProduct rows are preserved. Requires operator confirmation.',
    tier:     1,
    scope:    'global',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Demo Brand ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandAbort',
      method:  'run'
    }
  },

  // ── Phase 9: getContext + cross-brand search ─────────────────────

  {
    id:       'agent.getContext',
    title:    'Snapshot the caller\'s advertiser context',
    describe: 'Read-only snapshot: caller\'s advertiser (id, name, status, plan), all brands under it (id, name, slug, websiteUrl, source, per-brand integrations + campaign counts), rolling 24h spend + daily cap. Meant to be called at the start of a chat turn to answer "which of my brands …" without pre-selection. Every leg is advertiser-scoped — cross-advertiser discovery is a permanent non-goal. Cheap enough to call repeatedly (covering-projection queries only).',
    tier:     0,
    scope:    'advertiser',
    args: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/agentGetContext',
      method:  'run'
    }
  },

  {
    id:       'agent.searchAcrossBrands',
    title:    'Search across every brand under the caller\'s advertiser',
    describe: 'Case-insensitive substring search across the caller\'s advertiser\'s brands + products + campaigns + ads. Every leg is advertiser-scoped or resolves through advertiser-scoped parents; cross-advertiser discovery is impossible from this capability. Results capped at 20 rows per resource type to keep the tool_result under the LLM\'s 12KB payload budget — narrow the query when a leg reports truncated:true.',
    tier:     0,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200, description: 'Substring to match (case-insensitive). Escaped for regex safety server-side.' },
        resourceTypes: {
          type: 'array',
          items: { type: 'string', enum: ['brand', 'product', 'campaign', 'ad'] },
          maxItems: 4,
          description: 'Optional subset of resource types to search. Defaults to all four.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/agentSearchAcrossBrands',
      method:  'run'
    }
  },

  // ── Phase 8a: Integrations OAuth — T0 list ────────────────────────

  {
    id:       'integrations.instagram.listCredentials',
    title:    'List Instagram credentials on a brand',
    describe: 'Enumerate active + pending Instagram IntegrationCredentials for a brand. Read-only. Returns per-row status, Page name, IG username, catalog id, and connection metadata. Never returns tokens.',
    tier:     0,
    scope:    'brand',
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
      service: './capabilityExecutors/integrationsInstagramListCredentials',
      method:  'run'
    }
  },

  {
    id:       'integrations.metaAds.listCredentials',
    title:    'List Meta Ads credentials on a brand',
    describe: 'Enumerate active + pending Meta Ads IntegrationCredentials for a brand. Read-only. Returns per-row status + ad account / business / currency / timezone metadata. Never returns tokens.',
    tier:     0,
    scope:    'brand',
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
      service: './capabilityExecutors/integrationsMetaAdsListCredentials',
      method:  'run'
    }
  },

  {
    id:       'integrations.googleAds.listCredentials',
    title:    'List Google Ads credentials on a brand',
    describe: 'Enumerate active + pending Google Ads IntegrationCredentials for a brand. Read-only. Returns per-row status + customer id / login customer id / connection metadata. Never returns tokens.',
    tier:     0,
    scope:    'brand',
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
      service: './capabilityExecutors/integrationsGoogleAdsListCredentials',
      method:  'run'
    }
  },

  // ── Phase 8a: Integrations OAuth — T1 connectUrl + disconnect ─────

  {
    id:       'integrations.instagram.connectUrl',
    title:    'Get Instagram connect URL',
    describe: 'Return a short-lived (15-min) signed OAuth authorize URL for connecting an Instagram account to the brand. Per coverage-plan §D1: the agent cannot complete the redirect flow — the operator opens the URL in a browser to finish handshake + picker in the UI. Refuses if Meta OAuth is not configured on the server. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId — the OAuth state binds the resulting credential to this brand.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/integrationsInstagramConnectUrl',
      method:  'run'
    }
  },

  {
    id:       'integrations.metaAds.connectUrl',
    title:    'Get Meta Ads connect URL',
    describe: 'Return a short-lived (15-min) signed OAuth authorize URL for connecting a Meta Ads account to the brand. Per coverage-plan §D1: the agent cannot complete the redirect flow — the operator opens the URL in a browser to finish handshake + ad-account picker in the UI. Refuses if Meta Ads OAuth is not configured on the server. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
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
      service: './capabilityExecutors/integrationsMetaAdsConnectUrl',
      method:  'run'
    }
  },

  {
    id:       'integrations.googleAds.connectUrl',
    title:    'Get Google Ads connect URL',
    describe: 'Return a short-lived (15-min) signed OAuth authorize URL for connecting a Google Ads account to the brand. Per coverage-plan §D1: the agent cannot complete the redirect flow — the operator opens the URL in a browser to finish handshake + customer picker in the UI. Refuses if Google Ads OAuth is not configured on the server. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
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
      service: './capabilityExecutors/integrationsGoogleAdsConnectUrl',
      method:  'run'
    }
  },

  {
    id:       'integrations.instagram.disconnect',
    title:    'Disconnect Instagram credential',
    describe: 'Soft-revoke one Instagram IntegrationCredential (status:\'active\' → \'revoked\'). Downstream sync services filter on active status, so revoked rows are skipped next tick. Refuses if the credential is already revoked or doesn\'t exist under this advertiser. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['credentialId'],
      properties: {
        credentialId: { type: 'string', description: 'IntegrationCredential ObjectId (must be type:\'instagram\', status:\'active\').' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/integrationsInstagramDisconnect',
      method:  'run'
    }
  },

  {
    id:       'integrations.metaAds.disconnect',
    title:    'Disconnect Meta Ads credential',
    describe: 'Soft-revoke one Meta Ads IntegrationCredential (status:\'active\' → \'revoked\'). Downstream campaign sync stops picking it up on the next tick. Refuses if the credential is already revoked or doesn\'t exist under this advertiser. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['credentialId'],
      properties: {
        credentialId: { type: 'string', description: 'IntegrationCredential ObjectId (must be type:\'meta-ads\', status:\'active\').' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/integrationsMetaAdsDisconnect',
      method:  'run'
    }
  },

  {
    id:       'integrations.googleAds.disconnect',
    title:    'Disconnect Google Ads credential',
    describe: 'Soft-revoke one Google Ads IntegrationCredential (status:\'active\' → \'revoked\'). Downstream campaign sync stops picking it up on the next tick. Refuses if the credential is already revoked or doesn\'t exist under this advertiser. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['credentialId'],
      properties: {
        credentialId: { type: 'string', description: 'IntegrationCredential ObjectId (must be type:\'google-ads\', status:\'active\').' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/integrationsGoogleAdsDisconnect',
      method:  'run'
    }
  },

  // ── Phase 7: Team — T1 revoke invite / patch member / accept ─────

  {
    id:       'team.invite.delete',
    title:    'Revoke pending invitation',
    describe: 'Revoke a pending AdvertiserMembership invitation (status:\'pending\' → \'revoked\'). Idempotent: refuses non-pending rows with a "not found" error rather than a stateful re-revoke. Requires operator confirmation.',
    tier:     1,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['invitationId'],
      properties: {
        invitationId: { type: 'string', description: 'AdvertiserMembership ObjectId (must be status:\'pending\').' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/teamInviteDelete',
      method:  'run'
    }
  },

  {
    id:       'team.member.patch',
    title:    'Change member role',
    describe: 'Change a member\'s role (owner | admin | editor | viewer). Refuses to demote the ONLY owner — every advertiser must retain at least one owner. Returns priorRole so the operator can revert. Requires operator confirmation.',
    tier:     1,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['userId', 'role'],
      properties: {
        userId: { type: 'string', description: 'User ObjectId whose active membership will be changed.' },
        role:   { type: 'string', enum: ['owner', 'admin', 'editor', 'viewer'], description: 'New role.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/teamMemberPatch',
      method:  'run'
    }
  },

  {
    id:       'team.invite.accept',
    title:    'Accept an invitation by token',
    describe: 'Accept a pending invitation. The caller\'s email (from auth) must match the invitation\'s email exactly. Flips status to active + binds userId + stamps acceptedAt. This can grant the caller a membership on an advertiser OTHER than their current req.advertiserId — invites are advertiser-agnostic by design. Requires operator confirmation.',
    tier:     1,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['token'],
      properties: {
        token: { type: 'string', description: 'AdvertiserMembership.inviteToken from the invite URL / share link.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/teamInviteAccept',
      method:  'run'
    }
  },

  // ── Phase 5: Onboarding — dispatch syncs ──────────────────────────

  {
    id:       'onboarding.dispatchSyncs',
    title:    'Dispatch post-connect sync fan-out',
    describe: 'Fire the same sync fan-out that POST /api/onboarding/dispatch-syncs runs after an operator completes the connect step: IG catalog + posts (if an Instagram credential exists), Meta Ads campaigns, Google Ads campaigns. Each dispatched via setImmediate so it survives client navigation. Debounces catalog + posts syncs when the last run is within 5 minutes so it does not double-fire the IG picker\'s auto-run. Returns which kinds were dispatched vs skipped. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId — must have at least one connected IntegrationCredential to produce a non-empty dispatch list.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/onboardingDispatchSyncs',
      method:  'run'
    }
  },

  // ── Tier 2: billable writes — confirmation + spend-guard both apply ─

  {
    id:       'ad.regenerate',
    title:    'Regenerate a failed or unsatisfactory ad',
    describe: 'Retry a rendered ad AS-IS — no new prompt, no model swap. Kicks the same adRegenerateService the POST /api/ads/:id/regenerate route uses. Works for BOTH image (~$0.15) and video (~$3.00) ads; cost varies by kind at gate time. Billable per generation. Optional note carries a short refinement hint the renderer surfaces in prompts. Modes: full (default), video-only (skip static crops), title-only (chrome retitle only, uses cached master). Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'ad',
    // Function estimator — resolves ad.kind to price image vs video
    // accurately. See executor comment for the money-invariant
    // reasoning (over-reserve is safe, under-reserve is a bug).
    estimateUsd: require('./capabilityExecutors/adRegenerate').estimateUsd,
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' },
        note: { type: 'string', maxLength: 4000, description: 'Optional short refinement note surfaced to the renderer prompts.' },
        mode: { type: 'string', enum: ['full', 'video-only', 'title-only'], description: 'Render scope. Default full. Use title-only to retitle a video without re-billing the master.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adRegenerate',
      method:  'run'
    }
  },

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
    id:       'catalog.refreshReviewsForProduct',
    title:    'Refresh on-site reviews for ONE catalog product',
    describe: 'Single-product analog of catalog.refreshReviewsForBrand. Runs the 3-tier scraper (JSON-LD → vendor API → optional headless) for one CatalogProduct — HTTP-only, no LLM cost. Refuses products without a productUrl. Tier 2 gates only as a rate limiter (spendGuard $0 estimate) so a runaway agent cannot loop refresh-one on the same row. Reviews upsert in place; LayoutInputArtifact + CreativeDirectionArtifact cache keys are invalidated so downstream regenerations see the new signal.',
    tier:     2,
    scope:    'product',
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['productId'],
      properties: {
        productId:     { type: 'string', description: 'CatalogProduct ObjectId. Must have productUrl set.' },
        allowHeadless: { type: 'boolean', description: 'When true, allow the tier-3 headless-browser fallback (~10-25s). Off by default because it costs a browser per call.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogRefreshReviewsForProduct',
      method:  'run'
    }
  },

  {
    id:       'media.sourceSummary',
    title:    'Summarise how a brand\'s Media was ingested',
    describe: 'Cheap read-only lookup — for a brand, aggregate Media count grouped by ingestion source (instagram OAuth vs apify-ig vs manual_upload etc.). Returns a per-source remedy string naming the correct refresh capability. This is the AUTHORITATIVE way to decide which refresh path applies to existing media — DO NOT infer from integrations.instagram.listCredentials (credentials can be revoked AFTER ingest and leave orphan Media rows behind). Skips catalog-product wrappers + soft-deleted rows.',
    tier:     0,
    scope:    'brand',
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
      service: './capabilityExecutors/mediaSourceSummary',
      method:  'run'
    }
  },

  {
    id:       'catalog.listProductsWithoutAds',
    title:    'List products lacking an ad (optionally by kind / aspect)',
    describe: 'Cross-reference a brand\'s catalog against its ads and return the products that have NO counted ad matching the shape filter. Server-side aggregation — one call answers "which products need a 9:16 reels ad?" without needing 25+ paginated db.query invocations. Optional filters: kind (image | video), aspectRatio (e.g. "9:16", "1:1", "4:5"), statuses (defaults to the "counted as real" set: ok / draft / queued / rendering — failed and archived are ignored). Bounded: enumerates up to 500 catalog products, returns up to 100 missing.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId:     { type: 'string', description: 'Brand ObjectId.' },
        kind:        { type: 'string', enum: ['image', 'video'], description: 'Optional — only look for ads of this kind. Omit to match any kind.' },
        aspectRatio: { type: 'string', description: 'Optional aspect ratio (e.g. "9:16"). Omit to match any.' },
        statuses:    { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Ad statuses that count as "real" for coverage. Default: ["ok","draft","queued","rendering"].' },
        limit:       { type: 'integer', minimum: 1, maximum: 100, description: 'Cap on missing-products rows in the response (default 20).' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogListProductsWithoutAds',
      method:  'run'
    }
  },

  {
    id:       'db.query',
    title:    'Structured read-only DB query (whitelisted)',
    describe: 'Read-only structured query against a whitelisted set of collections (Media, CatalogProduct, ProductMatchArtifact, DetectionArtifact, DetectRun, Ad). Tenant scope is INJECTED server-side (advertiserId directly, or via-brand clamp for Ad) — cross-tenant reads are impossible. Filter keys must be in the per-collection allowlist; operators limited to $eq (implicit), $ne, $in, $nin, $exists, $gt, $gte, $lt, $lte (no $regex, $where, $expr, $lookup, $or, $and). Results capped at 20 rows with a per-collection field projection so hidden fields (raw blobs, encrypted tokens, PII, prompt IP) are never returned. Use this for ad-hoc questions like "most popular products by rating" or "products without a 9:16 reels ad" (two calls: list products + list ads filtered by aspectRatio/kind, then cross-reference by productId).',
    tier:     0,
    scope:    'advertiser',
    args: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: {
          type: 'string',
          enum: ['Media', 'CatalogProduct', 'ProductMatchArtifact', 'DetectionArtifact', 'DetectRun', 'Ad'],
          description: 'Collection to read from.'
        },
        filter: {
          type: 'object',
          additionalProperties: true,
          description: 'Mongoose-style filter. Keys must be in the per-collection allowlist; operators limited to $eq / $ne / $in / $nin / $exists / $gt / $gte / $lt / $lte. advertiserId is force-set by the server — do not include it here.'
        },
        sort:  { type: 'object', additionalProperties: true, description: 'Optional sort object (e.g. { createdAt: -1 }). Keys must be in the per-collection sortable allowlist. Max 2 keys.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Row cap. Defaults to 10, hard max 20.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/dbQuery',
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

  // ── Media comment refresh — bulk workflows ────────────────────────

  {
    id:       'media.refreshInsightsForBrand',
    title:    'Bulk refresh IG insights + comments across a brand',
    describe: 'Fan-out of media.refreshInsights over every OAuth-sourced (source=\'instagram\') Media on a brand. Cap of 100 per run at concurrency 3. Zero direct USD (Meta Graph is free) but Tier-4 gating so the operator sees the target count + wall time first. DOES NOT handle apify-ig Media — the Meta Graph API refuses non-OAuth external ids. For Apify-scraped IG posts, use media.refreshCommentsFromApify instead.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaRefreshInsightsForBrand',
      workflow: true
    },
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have at least one source=\'instagram\' Media row.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'media.refreshCommentsFromApify',
    title:    'Refresh IG comments for Apify-scraped media',
    describe: 'Fan-out over every apify-ig Media on a brand, re-pulling comments via the SAME apify/instagram-scraper actor (resultsType=\'comments\') used at ingest. Upserts Comment docs by (mediaId, externalId). Runs one Apify sync-run per post — hence per-run cost. Cap of 100 per run. This is the parallel path to media.refreshInsightsForBrand for the Apify pipeline; post metadata itself is NOT touched (that lives on the Media row and is only refreshed at re-ingest).',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/mediaRefreshCommentsFromApify',
      workflow: true
    },
    // Per-unit ~$0.02 × 100-cap = $2 upper bound. Env-overridable
    // via APIFY_COMMENTS_PER_UNIT_USD if the operator has a different
    // Apify pricing tier.
    estimateUsd: 2.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have at least one source=\'apify-ig\' Media row with a metadata.permalink.' }
      },
      additionalProperties: false
    }
  },

  // ── Phase 6: Detection + layouts — T2 billable ──────────────────

  {
    id:       'detect.process',
    title:    'Run detect on one media',
    describe: 'Enqueue a fresh DetectRun with trigger=\'manual\' for one Media. Worker runs YOLO → subjects/text → smart-crops → product-match → overlay zones. Refuses catalog-product wrapper Media (pipeline-internal) and soft-deleted rows. Billable (~$0.05 per image via YOLO microservice + Gemini identify). Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 0.05,
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId: { type: 'string', description: 'Media ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/detectProcess',
      method:  'run'
    }
  },

  {
    id:       'aiCanvas.testSpec',
    title:    'Generate + cache AI canvas spec',
    describe: 'Generate an AI canvas spec (layout composition) for one Media at a given aspect ratio + creative style. Mirrors POST /api/ai-layouts/spec/test — the underlying LLM call is Sonnet. Idempotent on the (mediaId, template, aspectRatio, productId, variantKind, paletteSource) partition: a cached artifact returns cached:true; pass refresh=true to force a re-derive. Billable (~$0.02, Sonnet). Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 0.02,
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId:       { type: 'string', description: 'Media ObjectId.' },
        creativeStyle: { type: 'string', enum: ['brand_led', 'ugc_led', 'editorial'], description: 'Creative style. Defaults to brand_led.' },
        aspectRatio:   { type: 'string', enum: ['1:1', '4:5', '9:16'], description: 'Target aspect. Defaults to 1:1.' },
        productId:     { type: 'string', description: 'Optional CatalogProduct ObjectId — seeds product_image variants.' },
        refresh:       { type: 'boolean', description: 'When true, invalidate the cache + regenerate.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/aiCanvasTestSpec',
      method:  'run'
    }
  },

  {
    id:       'aiLayouts.generate',
    title:    'Kick off AI layout studio session',
    describe: 'Create an AiLayoutSession — an async LLM + gpt-image-1 pass across N variants × M aspect ratios. Returns sessionId immediately; the worker runs the combos and writes back references[] as they complete. Poll aiLayouts.getSession for status. Cost scales with (variants × aspectRatios × quality) — low ~$0.02/combo, medium ~$0.05, high ~$0.15. estimateUsd sizes for the upper bound at default 3 × 3 × low ~= $1.00. Requires operator confirmation AND advertiser daily spend cap headroom.',
    tier:     2,
    scope:    'brand',
    estimateUsd: 1.00,
    args: {
      type: 'object',
      required: ['mediaId'],
      properties: {
        mediaId:      { type: 'string', description: 'Media ObjectId — the source Media for the layout studio pass.' },
        variants:     { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Optional list of variant names. Defaults to the studio\'s DEFAULT_VARIANTS.' },
        aspectRatios: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Optional list of aspect ratios. Defaults to the studio\'s DEFAULT_ASPECT_RATIOS.' },
        quality:      { type: 'string', enum: ['low', 'medium', 'high'], description: 'gpt-image-1 quality. Default low.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/aiLayoutsGenerate',
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

  // ── Phase 7: Team — T3 invite / remove ───────────────────────────

  {
    id:       'team.invite.create',
    title:    'Invite a teammate',
    describe: 'Create a pending AdvertiserMembership invitation. Idempotent on (advertiserId, email, status:\'pending\') — a fresh call with the same email returns the existing invitation verbatim instead of creating a duplicate. Refuses when the email already has an ACTIVE membership. Returns the inviteToken the operator shares with the invitee. Requires operator confirmation AND the explicit phrase "INVITE MEMBER" typed in the confirmation UI.',
    tier:     3,
    scope:    'advertiser',
    explicitConfirmation: 'INVITE MEMBER',
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', maxLength: 200, description: 'Invitee email address.' },
        role:  { type: 'string', enum: ['admin', 'editor', 'viewer'], description: 'Role granted on accept. Defaults to editor. Owner cannot be invited (only the workspace creator).' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/teamInviteCreate',
      method:  'run'
    }
  },

  {
    id:       'team.member.delete',
    title:    'Remove a team member',
    describe: 'Soft-revoke an active membership (status:\'revoked\' + revokedAt/By). Refuses to remove the only owner. The user loses access to this advertiser immediately; re-inviting is a full round-trip. Requires operator confirmation AND the explicit phrase "REMOVE MEMBER" typed in the confirmation UI.',
    tier:     3,
    scope:    'advertiser',
    explicitConfirmation: 'REMOVE MEMBER',
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', description: 'User ObjectId of the member to remove.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/teamMemberDelete',
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
    id:       'catalog.inferCategoriesForBrand',
    title:    'Bulk-infer categories across a brand',
    describe: 'Bulk analog of catalog.inferCategories. Fans out JSON-LD BreadcrumbList → LLM-fallback category inference across every product with a productUrl in the brand. Respects the 14-day TTL unless force=true. Free on JSON-LD hits; ~$0.02/product on the LLM fallback. Reserve is upper bound (100% LLM fallback × MAX_STEPS_PER_RUN=100 = $2). Streams onProgress ticks.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogInferCategoriesForBrand',
      workflow: true
    },
    estimateUsd: 2.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        force:   { type: 'boolean', description: 'When true, bypass the 14-day inference TTL and re-scrape every product with a productUrl.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'catalog.refreshDetails',
    title:    'Refresh product details (specs / cross-seller / reviews) for a brand',
    describe: 'Full-catalog enrichment for any brand (not restricted to Sales Demos). Runs catalogProductEnrichmentService.enrichBrandDetails: SerpAPI cross-seller price table + Gemini web-wide review synthesis + Immersive specs per product. Paid path (~$0.05-0.10/product). Protected by an atomic claim on Brand.apifyDemo.enrichInFlight so a concurrent run fails at preview rather than double-billing — same lock sales.brand.enrich uses.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogRefreshDetails',
      workflow: true
    },
    estimateUsd: 10.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have at least one CatalogProduct row.' }
      },
      additionalProperties: false
    }
  },

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
    id:       'onboarding.createBrandFromUrl',
    title:    'Onboard a brand from a URL (create → enrich → sync → reviews)',
    describe: 'The money workflow. Chains Phase 3/4 primitives into a single confirm-and-go flow: (1) create Brand with source=\'curated\' and websiteUrl set; (2) run brand enrichment (Brandfetch → scrape → LLM) inline; (3) pull the public Shopify catalog via shopifyPublicIngestService (downstream detect + enrichment enqueue is fire-and-forget inside the service); (4) refresh on-site reviews for up to 25 products via the 3-tier scraper. Idempotent on brand existence — a matching brand under this advertiser is reused rather than duplicated. Heavy workflow (typically 2-5 min, SSE stream stays open). Each step\'s outcome surfaces in the final result; a step failing does NOT abort later steps.',
    tier:     4,
    scope:    'advertiser',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/onboardingCreateBrandFromUrl',
      workflow: true
    },
    // Reserves against advertiser cap; step 3\'s downstream detect
    // enqueue lands on OTHER spendGuard rows (per-image detect), not
    // this workflow\'s.
    estimateUsd: 2.00,
    args: {
      type: 'object',
      required: ['name', 'websiteUrl'],
      properties: {
        name:       { type: 'string', minLength: 1, maxLength: 200, description: 'Brand display name.' },
        websiteUrl: { type: 'string', description: 'Brand website — must start with http:// or https://.' }
      },
      additionalProperties: false
    }
  },

  // ── Ingestion coverage: P2/P4 standalone sync workflows ──────────

  {
    id:       'catalog.syncFromInstagram',
    title:    'Sync Meta Catalog for a brand',
    describe: 'Two-phase workflow — pull the brand\'s Meta Catalog products via the IG Commerce OAuth path (catalogSyncService.syncCatalog). Same service /api/integrations/instagram/sync-catalog + onboarding.dispatchSyncs invoke; standalone so the operator can trigger just the catalog leg. Requires an active IG IntegrationCredential with a catalogId. No LLM cost.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogSyncFromInstagram',
      workflow: true
    },
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have at least one active IG credential with a catalogId set.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'posts.syncFromInstagram',
    title:    'Sync Instagram posts for a brand',
    describe: 'Two-phase workflow — pull IG posts (feed + reels) via postSyncService.syncPosts. Same service /api/integrations/instagram/sync-posts + onboarding.dispatchSyncs invoke; standalone so the operator can trigger just the posts leg. Upserts Media rows and enqueues DetectRuns for new posts. Requires an active IG IntegrationCredential with an igUserId. No LLM cost.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/postsSyncFromInstagram',
      workflow: true
    },
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have at least one active IG credential with an igUserId set.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'catalog.syncFromGenericSitemap',
    title:    'Pull public catalog via XML sitemap + JSON-LD',
    describe: 'Two-phase workflow — pull the brand\'s catalog via genericCatalogIngestService (XML sitemap + schema.org JSON-LD). Fallback for non-Shopify stores where Shopify products.json returns nothing. Requires Brand.websiteUrl or Brand.shopifyUrl. Refuses when GENERIC_CATALOG_ENABLED=false. No LLM cost.',
    tier:     4,
    scope:    'brand',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogSyncFromGenericSitemap',
      workflow: true
    },
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId. Must have websiteUrl or shopifyUrl set.' }
      },
      additionalProperties: false
    }
  },

  // ── Phase 10: Sales demos — T4 workflows ─────────────────────────

  {
    id:       'sales.brand.sync',
    title:    'Sync demo brand via Apify (Sales Demos scope)',
    describe: 'Two-phase workflow that runs apifyIngestService.syncBrandApify for a demo brand under the Sales Demos advertiser. Same underlying service as catalog.pullFromApify, scoped strictly to callers who are IN Sales Demos. Cancel mid-flight via sales.brand.abort. Heavy (typically 1-3 min).',
    tier:     4,
    scope:    'global',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandSync',
      workflow: true
    },
    estimateUsd: 1.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Demo Brand ObjectId.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'sales.brand.enrich',
    title:    'Full-catalog enrichment for demo brand',
    describe: 'Two-phase workflow — full-catalog enrichment via catalogProductEnrichmentService.enrichBrandDetails: SerpAPI cross-seller price table + Gemini web-wide review synthesis + Immersive specs per product. PAID path. Protected by apifyDemo.enrichInFlight — a concurrent call fails at preview() rather than double-billing. Heavy (typically 5-10 min).',
    tier:     4,
    scope:    'global',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandEnrich',
      workflow: true
    },
    // Cost scales with product count; $10 reserves a bounded upper for
    // brands with ~100 products at ~$0.05-0.10 each.
    estimateUsd: 10.00,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId: { type: 'string', description: 'Demo Brand ObjectId.' }
      },
      additionalProperties: false
    }
  },

  {
    id:       'sales.brand.syncReviews',
    title:    'Sync demo brand product reviews',
    describe: 'Two-phase workflow — re-scrape product reviews + ratings via the 3-tier engine (schema.org rich snippets → vendor-widget API → optional headless). HTTP tiers are free; headless is opt-in per run because it costs a browser per product. Mirrors POST /api/sales-demos/brands/:id/sync-reviews.',
    tier:     4,
    scope:    'global',
    execute: {
      kind:    'service',
      service: './capabilityExecutors/salesBrandSyncReviews',
      workflow: true
    },
    // Free by default (HTTP-only). Headless can add up but stays under
    // the T4 gate for the operator to accept.
    estimateUsd: 0,
    args: {
      type: 'object',
      required: ['brandId'],
      properties: {
        brandId:     { type: 'string', description: 'Demo Brand ObjectId.' },
        force:       { type: 'boolean', description: 'When true, ignore the 30-day TTL and re-scrape everything.' },
        useHeadless: { type: 'boolean', description: 'When true, allow the tier-3 headless browser fallback per product. Expensive.' },
        pages:       { type: 'integer', minimum: 1, maximum: 50, description: 'Optional per-product page cap for the vendor-widget tier.' }
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

// Resolve the executor path recorded on a capability into a form that
// can be require()'d from ANY file in the tree.
//
// PROBLEM this exists to solve: entries store paths like
//   './capabilityExecutors/catalogRefreshReviewsForBrand'
// which node's require() resolves relative to the CALLING FILE. That
// worked when only services/agentTools.js dispatched (same directory)
// but crashed in prod when routes/agent.js dispatched T4 workflows
// directly — the './capabilityExecutors/...' path resolved to
// 'routes/capabilityExecutors/...' and blew up with MODULE_NOT_FOUND.
//
// FIX: every dispatch site funnels through this resolver, which
// anchors relative paths to THIS file's directory (services/) so the
// resolved absolute path works from anywhere. Absolute paths and npm
// module names pass through unchanged.
//
// The verifier uses this same resolver in [2] so its executor-loads
// check matches production behavior byte-for-byte.
const pathMod = require('path');
function resolveExecutorPath(cap) {
  const s = cap?.execute?.service;
  if (!s || typeof s !== 'string') return null;
  if (s.startsWith('.')) return pathMod.join(__dirname, s);
  return s;
}

module.exports = {
  CAPABILITIES,
  capabilitiesToTools,
  capabilityById,
  capabilityByToolName,
  applicableCapabilities,
  describeManifest,
  validateManifest,
  resolveExecutorPath,
  // exported for the verifier's precondition tests
  __test: { evalClause, describeClause, getPath }
};
