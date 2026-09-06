# Ingest signal completeness and Director data flow

**Scope:** read-only audit of `liquidretail_backend` at `802f662e`, starting from PR #390 (`d994c243`, 2026-09-05). No code was changed except this file. No live DB or API calls.

**Owner question:** is ingest capturing the richest available signal (especially social engagement) efficiently, and does that signal reach both the static Director and the video Director?

---

## 1. Executive summary

Ingest already knows how to pull Instagram likes, comments, saves, shares, reach, and views, and it already stores them. Catalog reviews, ratings, quotes, specs, buyer benefits, and brand personas are also captured, and yesterday’s Director work (PR #390) successfully forwarded product description, specs, review quotes/ratings, brand tone, tagline, and personas into the ad-planning layer.

The single biggest gap is social *performance numbers*. They are snapshotted once (often only on first ingest), then mostly left to go stale — and the video-title Director is never shown them at all. “Printable social proof” in PR #390 is review quotes and star ratings, not like/comment/save/view counts. Scheduled Instagram sync skips posts we already have, so likes do not refresh hourly. Demo/Apify Instagram posts are stored with likes but then filtered out of the Director’s social pool because their source tag is `apify-ig`, not `instagram`. True customer UGC (tagged/mentioned posts) is still an unbuilt path.

Recommended next fix, in one move: (1) refresh likes/comments/saves on already-ingested posts during the existing scheduled sync, without re-running paid detect; (2) hand those numbers to the video-title Director the same way the static Director already sees them; (3) treat Apify Instagram posts as social media, not as a different species. That is free Graph/Apify data we already fetch, pointed at both ad brains.

---

## 2. Direct answer: does PR #390 “printable social proof” include raw engagement counts?

**No.**

`printableSocialProofForVideo` (`services/videoBenefitsDirector.js:91-113`) copies only:

- `rating` (`{ value, count }` — **catalog/review stars and review volume**, not Instagram likes)
- `primary_quote` (`text`, `author`)
- `top_comments` (`text`, `author` only — **comment like counts are stripped**)
- `strongest_signal` (`testimonial` | `rating` | `creator`)

It does **not** read `performance_signal`, `ugc_signal`, `platformStats.likes/comments/saves/shares/views/reach`, or `top_comments[].likes`.

The video-title prompt then emits that object as `SOCIAL PROOF:` (`:197-198`) and never mentions likes/saves/views.

The **static** Director *does* receive engagement totals, via the shared `assembleSignals` return value (`performance_signal` at `services/aiCreativeDirectorService.js:1103-1138`, stringified into the round prompt at `:3324`). That is a different object. PR #390 did not forward it to video.

---

## 3. Findings table

| path:line | what’s captured / missing | why it matters for ad quality / conversion | confidence |
|---|---|---|---|
| `services/postSyncService.js:40-45` | OAuth IG `/me/media` **does** request `like_count` and `comments_count` (no extra insights scope). | Basic social proof numbers exist at ingest for connected IG Business accounts. | Confirmed (request + persist) |
| `services/postSyncService.js:48-101`, `models/Media.js:44-53` | Insights request `impressions/reach/engagement/saved` (feed), `plays/likes/comments/shares/saved` (reels), `video_views` (video). Mapped onto `Media.platformStats` `{likes, comments, views, reach, saves, shares, engagement}`. Requires `instagram_manage_insights` (`instagramOAuthService.js:26-40`). Fail-soft to basic counters. | Saves/shares are the higher-intent signals this codebase already weights more heavily than likes (`campaignAdsGenerationService.js:1105-1117`). They only exist if insights succeed. | Confirmed |
| `services/scheduledSyncService.js:302-313` + `postSyncService.js:304-305` | Scheduled post sync calls `syncPosts` **without `force`**. Known posts are skipped (`existing && !force → continue`) **before** `ingestPost`. The “refresh stats on every sync” comment at `postSyncService.js:448-451` is true of `ingestPost` itself, and **false of the hourly job**. | Likes/saves on a post that is already in the library freeze at first-seen values. The Director then plans “stat-led” ads from stale or empty numbers. This is the largest social-signal hole. | Confirmed (both ends) |
| `services/instagramWebhookService.js:12-13, 99-105, 26-29, 120-121` | Webhook handles `media` publish only. **`comments` field is explicitly “not wired yet.”** Webhook Graph fetch **omits** `like_count` / `comments_count`. Already-ingested posts are skipped, so later likes never land. | New comments after publish never update the Comment collection in real time. Webhook-first ingest can mint a Media row with empty likes until a later full sync (which, without `force`, will also skip it). | Confirmed |
| `services/postSyncService.js:462-529` | Comment fetch is fire-and-forget **only after a DetectRun is created**. Cap-deferred ingest (`enqueueRun=false`, `:462-466`) and “already had a DetectRun” (`:477-479`) return **without** fetching comments. `Media` `post('save')` auto-refresh (`models/Media.js:364-378`) does **not** run on `findOneAndUpdate` (the actual ingest write). | Comment cards and Director `top_comments` stay empty unless detect was queued on first ingest, or an operator later hits refresh. | Confirmed |
| `services/mediaInsightsService.js:71-166` + `routes/media.js` / `media.refreshInsightsForBrand` | Operator/agent refresh **does** re-pull insights + comments. Not on a timer. | The refresh path is correct; it is just not the default. Engagement freshness is opt-in. | Confirmed |
| `services/postSyncService.js:15-16, 371-378` | Carousels: **first child only**. Caption/likes are of the album; extra carousel frames are discarded. | Multi-image posts that would make stronger product ads (detail + lifestyle) lose every frame after the first. | Confirmed |
| `services/postSyncService.js:430-433` | Own-account posts stamped `classification.socialPostType = 'brand_produced'`. Tagged/mentioned UGC is **backlog #69, not built**. No `/tags` (or mentions) pull. OAuth has `instagram_basic` + `instagram_manage_comments` + `instagram_manage_insights`; tagged-media needs the Graph **IG User tags** edge (`GET /{ig-user-id}/tags`), which is not called anywhere. | Owner asked for social input as the conversion key. We ingest the brand’s own grid, not customer posts that tag the brand — usually the higher-trust UGC. | Confirmed missing path; inferred that `/tags` is the right edge (not live-probed) |
| `services/apifyPullService.js:104-119` + `apifyIngestService.js:422-426, 370-387` | Apify IG scraper **does** return `likesCount` / `commentsCount` and they are written on **insert**. Re-sync of an existing `apify-ig` row **does not update** `platformStats` (`$setOnInsert` only). Apify does not return saves/shares/reach. | Demo / public-handle brands get likes once, then freeze. No save/share signal on this path. | Confirmed |
| `services/aiCreativeDirectorService.js:814` | Director social pool = `source === 'instagram' \|\| source === 'tiktok'` only. **`apify-ig` is excluded.** Same filter in `aiCanvasInputBuilder.js:238`. | Apify-ingested posts (common on demo brands) can have real like counts on the Media doc and still contribute **zero** to `ugc_signal` / `performance_signal`. Static Director plans as if there is no social. | Confirmed (model field + filter) |
| `services/aiCreativeDirectorService.js:1103-1138` vs `:814` + `videoBenefitsDirector.js:91-113, 197-198` | Static Director **does** get `performance_signal` `{likes, comments, saves, shares, avg_engagement_rate, strength, top_post}` inside the JSON brief (`buildPromptRound` stringifies the whole `inputSummary`). Video-title Director **does not**. | Conversion ads that should lead with “12k likes / 800 saves” can do that on static. Video titling never sees the number, so it cannot choose a benefits/proof slot *because* the post is a social winner. | Confirmed (both ends) |
| `services/aiCreativeDirectorService.js:1108-1135` | `avg_engagement_rate` is the mean of `platformStats.engagement` (IG **absolute interaction count**), documented in-code as “0–1”. Prompt rule is `high (>0.05)` (`:1661`). Reach is captured and **not** used to compute a real rate. Views/reach omitted from `performance_signal`. | Almost any post with a handful of interactions looks “high engagement rate.” The Director is instructed to go social-proof-led on noise. True virality (likes/reach) is never computed. | Confirmed (assembly + prompt); not live-measured |
| `services/aiCreativeDirectorService.js:847-863` | `ugc_signal.top_creator.followers` reads `metadata.creatorFollowerCount`. **Zero writers** of that field exist in the repo (grep: three reads, no writes). Prompt still says “if a creator with significant followers… pick a creator-led archetype” (`:1655`). | Starved-brief class (same family as historical `brand.description` / `product.shortBenefits`). The prompt asks for a field ingest never fills, so creator-led concepts never fire on follower strength. | Confirmed |
| `models/Comment.js:29-31` + `aiCreativeDirectorService.js:1010-1014` vs `videoBenefitsDirector.js:104-108` | Comment `likeCount` **is** persisted and **is** on the static Director’s `top_comments[].likes`. Video printable proof **drops** it. | Video cannot prefer the crowd-validated comment over a quieter one. | Confirmed |
| `services/productReviewsScrapeService.js:6-32, 734-767, 785-824` | Free on-page scrape (JSON-LD → vendor API → optional headless) persists `rating`, `reviewCount`, `quotes[]` (with **per-review stars**), `ratingDistribution`, `vendorDistribution`, `platform`, `tiers`. Also copies `rating` onto `CatalogProduct.rating`. TTL 30d. | This is the right cheap path. Star-gated quotes are what stop a 2★ complaint from becoming the ad’s testimonial. | Confirmed |
| `services/catalogProductEnrichmentService.js:82-137` | Auto enrichment: scrape first, paid Gemini gap-fill **only** when scrape found nothing. User “Enrich” then adds SerpAPI details + a **second** grounded Gemini narrative (`productDetailsService.fetchReviewSummary`). | Auto path is efficient (gap-fill only). User Enrich can double-pay for web-wide review research on a SKU that just failed scrape (`lookupProductReviews` + `fetchReviewSummary`). | Confirmed for the dual call; not measured in CostLog |
| `services/providers/geminiSearchProvider.js:880, 524-530` vs grep of `quote.stage` / `q.stage` | Gemini is **paid** to label each quote `stage: awareness\|consideration\|conversion\|retention\|conquest`. `stampLlmQuotes` keeps the field. **No consumer reads `quote.stage`.** Funnel-aware picking uses lexical `STAGE_TERMS` on quote *text* (`layoutInputService.js:1819-1826`). | We already pay for funnel-stage labels and throw them away. Conversion ads cannot prefer “worth every penny” quotes by the model’s own stage tag. | Confirmed (schema + zero readers) |
| `services/providers/geminiSearchProvider.js:1233-1234` + `productDetailsService.js:296-297` | Grounded prompts ask for **recurring complaints**. Pass-2 JSON schema has **no `complaints[]` / `themes[]`**. Only `quotes`, `ratings`, `summary`. | Consideration/conversion copy is often objection-handling. Complaints exist in the paid narrative and are collapsed into one sentiment sentence, then never structured for the Director. | Confirmed |
| `services/productBenefitsService.js:210-224` | `shortBenefits`: 3–5 phrases, ≤6 words, one undifferentiated list. **No funnel-stage split.** Derived from title + description + specs + brand tone/summary. | Awareness (“stays dry”) and conversion (“worth the price / true to size”) are mixed. Video-title Director then places that same list on awareness *or* conversion profiles without a stage-specific subset. | Confirmed |
| `services/brandEnrichmentService.js:34-62, 451-457` | Brand `summary`, `tagline`, `tone`, `hashtags`, `tags`, `demographics[]` (`painPoints`, `interests`, `toneHint`). Personas are **who the customer is**, not funnel stage. | Pain points are the closest thing we have to consideration/conversion framing at brand level. | Confirmed |
| `services/aiCreativeDirectorService.js:746-754, 1208-1243` (PR #390) | Static `brand_signal.personas` now forwarded (flag `DIRECTOR_BRAND_PERSONAS`). Video `buildDirectorMessages` uses only `brandSignal.name/tagline/tone` (`videoBenefitsDirector.js:180-188`) — **personas assembled, not prompted**. | Video titling cannot aim proof/benefits at a named objection (“worried about fit”) even though the data is in the shared brief. | Confirmed |
| `services/aiCreativeDirectorService.js:734-800` | Static `brand_signal` gets `summary` as `description`, tagline, tone, brand-reviews summary, logo flag, optional personas. **`hashtags` / `tags` / `derivedVoice` are not in `assembleSignals`.** `derivedVoice` is a *separate* round-prompt block for static only (`:2427-2432, 2955`). | Hashtags captured at enrichment never reach either Director. Brand voice derived from live Meta/Google ads reaches static only. | Confirmed |
| `services/aiCreativeDirectorService.js:756-800` | `product_signal`: name, category, description, price, currency, availability, review_summary, specs, optional `benefits` from `CatalogProduct.shortBenefits`. **Not forwarded:** `ratingDistribution`, `vendorDistribution`, `sellers`, `reviews[]` raw Immersive rows (quotes go through the proof pool instead). | Specs + benefits + price are enough for a lot of conversion copy. Star *histogram* (e.g. “92% 5-star”) is captured on scrape and never shown to either Director. | Confirmed |
| `CLAUDE.md` §00 video prompt | Live video **camera** prompt is canonical camera-only (`buildVeoPrompt`). Director concepts do not drive Omni. That is owner-directed, not a miss. | Video *pictures* will not start using likes/quotes unless that policy changes. Video *titles* are the Director surface that should get social signal — and currently don’t, for engagement. | Confirmed (policy + code) |
| `services/campaignAdsGenerationService.js:1544-1555, 3755-3770` | One `assembleSignals` per product (`makeAssembleSignalsOnce`) shared by static round and video-title mint. Fork is **consumption**, not assembly: static stringifies the whole object; video picks a subset. | Drift risk is in `buildDirectorMessages` / `printableSocialProofForVideo`, not a second assembler. Adding a field to `assembleSignals` does not automatically reach video. | Confirmed |
| `services/layoutInputService.js:3134-3174` + `metaCascadeConfig.js:190-192` | **Render/titling** (not Director) *can* print `likes` from `layoutInput.performance.engagement.likes` → Remotion `likes` slot. Catalog `product_image` ads skip this (`isProductImage ? {}`). | Catalog product video/static ads — the live pipeline — **blank the likes slot on purpose** because the seed is a catalog photo, not the IG post. Even if Media.platformStats is full, catalog-kit ads will not burn a like count unless the seed is UGC. | Confirmed |
| `models/Media.js:364-362` vs `postSyncService.js:403` | Duplicate Graph calls on a hypothetical `save()` insert (insights + comments). Live ingest uses `findOneAndUpdate`, so the hook is mostly inert. `ingestPost` already calls insights; comments called once on detect-queued inserts. | Not a current double-bill of money (Graph is free). Token budget is fine. The hook is a footgun if someone later switches to `save()`. | Confirmed |
| Insights metric names `impressions` / `engagement` on Graph **v26.0** (`metaApiVersion.js:42`, `postSyncService.js:50-52`) | One invalid metric fails the **whole** insights request; errors are swallowed (`fetchPostInsights` → `null`). Meta has historically renamed IG media insights (`impressions` → `views` on some surfaces). | If the bundle 400s, every feed photo silently has only `like_count`/`comments_count` — no saves/reach/shares — and nobody is paged. | **Inferred** (no live Graph probe this audit). Worth a one-shot authenticated probe. |

---

## 4. What ingest captures today (map)

### A. Instagram / social

| Source | Likes | Comments count | Comment *text* | Saves | Shares | Views / plays | Reach |
|---|---|---|---|---|---|---|---|
| OAuth Graph, first ingest | Yes (`like_count`) | Yes (`comments_count`) | Yes, if DetectRun queued | Yes, if insights scope + success | Reels only (insights) | Yes if insights | Yes if insights |
| Scheduled re-sync of known posts | **No (skipped)** | **No** | **No** | **No** | **No** | **No** | **No** |
| Webhook new publish | Often **missing** (fields omitted) | Often **missing** | Only if detect queued | Only if insights | Reels only | Only if insights | Only if insights |
| Webhook new comment | n/a | **Not handled** | **Not handled** | n/a | n/a | n/a | n/a |
| Operator refresh | Yes | Yes | Yes (top-level, 10 pages) | Yes | Reels | Yes | Yes |
| Apify public scrape | Yes on insert only | Yes on insert only | Separate paid Apify comments run | No | No | No | No |
| TikTok | Enum exists; **no ingest writer** | — | — | — | — | — | — |
| Tagged / mentioned UGC | **Not ingested** | — | — | — | — | — | — |
| Stories | **Not ingested** (`/me/media` only) | — | — | — | — | — | — |

OAuth scopes already requested (`instagramOAuthService.js:26-40`): `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`, `catalog_management`, `instagram_manage_comments`, `instagram_manage_insights`.

**Not requested / not called:** IG User **tagged media** (`/{ig-user-id}/tags`). Comment *replies* are schema-ready (`Comment.parentExternalId`) but V1 fetches top-level only (`mediaInsightsService.js:11-12`).

### B. Catalog reviews / product facts

| Path | Fields persisted | Paid? | Funnel-aware? |
|---|---|---|---|
| On-page scrape | rating, reviewCount, quotes+stars, distributions, platform | Free | No (positive-first rank only) |
| Gemini gap-fill | quotes (with unused `stage` label), rating, reviewCount, 1-sentence summary | Grounded Gemini, 30d TTL, sibling GTIN/MPN reuse | Labels paid for, **not read** |
| User Enrich / Immersive | description, specs, sellers, ratingDistribution, review rows, reviewSummary (praise **and** complaints in prose) | SerpAPI + grounded Gemini | Narrative only |
| `shortBenefits` (PR #391) | 3–5 buyer phrases | gemini-2.5-flash, idempotent, freshness on title/description | **No** — one list |

### C. Brand

| Field | Writer | Static Director | Video-title Director |
|---|---|---|---|
| `summary` → `brand_signal.description` | enrichment GPT | Yes | No (not in `buildDirectorMessages`) |
| `tagline`, `tone` | enrichment | Yes | Yes (PR #390) |
| `demographics` → `personas` | enrichment | Yes (PR #390) | Assembled, **not prompted** |
| `brandReviews` | grounded Gemini | Yes (summary + proof menu) | Rating/quote only via printable proof |
| `hashtags`, `tags` | enrichment | **No** | **No** |
| `derivedVoice` (from live ads) | `brandVoiceDerivationService` | Separate prompt block | **No** |
| Funnel / buying-intent model | — | PMax round asks the model to *emit* `routing.funnel_stage`; signal in is not staged | Profile is awareness/consideration/conversion from `Ad.funnelStage`, not from ingest |

The signal model is **not** awareness-only: PMax static concepts and video titles are staged. The *ingest* model is mostly unstaged (one quote pool, one benefits list, one persona list). Staging happens at pick/prompt time via text heuristics, not stored structure.

---

## 5. Director consumption (does captured data arrive?)

Shared assembler: **`assembleSignals` in `aiCreativeDirectorService.js` is the one function.** Video imports it. PR #390 added `makeAssembleSignalsOnce` so a mixed kit does not re-query Mongo per surface.

```
assembleSignals
  ├─ static directConceptsRound → JSON.stringify(entire inputSummary)
  └─ runVideoTitleDirector
        ├─ product_signal.benefits  (required; empty → no LLM)
        ├─ product_signal.name/description/specs
        ├─ brand_signal.name/tagline/tone
        └─ printableSocialProofForVideo(social_proof_signal)
              (rating, quote, comment text, strongest_signal)
```

**Captured in ingest/enrichment but NOT in either Director prompt**

- `Media.platformStats.views`, `.reach` (captured; dropped at `performance_signal`)
- Gemini `quote.stage` (paid; never read)
- `Brand.hashtags` / `tags`
- `CatalogProduct.ratingDistribution` / `vendorDistribution`
- `creatorFollowerCount` (prompted, never written)
- Recurring complaints as a structured list
- Funnel-split benefits
- Tagged UGC (never captured)

**In static Director, not in video-title Director**

- `performance_signal` (likes/comments/saves/shares/top_post)
- `ugc_signal` (shot mix, rights, media count, top_creator)
- `top_comments[].likes`
- `brand_signal.personas`, `description`, `brand_reviews_summary`
- `product_signal.review_summary`, `price`, `benefits` as grounding beyond the include/exclude list (benefits *list* is sent; price/review_summary are not)
- `social_proof_signal.proof_options`, `quotes_by_stage`
- `derivedVoice`, campaign brief

**Policy, not a bug:** Omni camera prompt stays camera-only. Social numbers should not be stuffed into the video *generation* prompt. They should inform **titling / concept** — which is the video-title Director, and that is the miss.

**Starved-brief class check (post–PR #390)**

| Prompt asks for | Assembler actually fills | Status |
|---|---|---|
| `brand_signal.description` | `brand.summary` | Fixed earlier; still good |
| `product_signal.benefits` | `CatalogProduct.shortBenefits` | Fixed PR #389/#390; still good |
| `ugc_signal.rights_approved` | `media.rights.approved` | Fixed PR #390 (was empty `platformStats.rights_approved`) |
| `ugc_signal.top_creator` followers | **never written** | **Open — new instance of the same class** |
| `performance_signal.avg_engagement_rate` as 0–1 | absolute IG `engagement` count | **Open — wrong unit, not empty** |

No regression of the old `brand.description` / missing `shortBenefits` bugs was found.

---

## 6. Efficiency

**Already good (do not relitigate)**

- Product-reviews 30d TTL + GTIN/MPN sibling copy
- Auto enrichment: free scrape first, Gemini only on empty
- `shortBenefits` idempotent; title/description change re-derives, price/image does not
- `assembleSignals` once per product per generate
- Layout Gemini no longer re-invents `short_benefits` when catalog already has them (PR #390)
- Insights/comments are Graph (free), not LLM
- Detect is not re-queued on ordinary re-sync

**New issues**

1. **Stale social stats by design of the skip path** — cheapest fix is also the highest-value: on known posts, update `platformStats` (and optionally comments) *without* `forceDetect`.
2. **User Enrich double grounded-review** — `lookupProductReviews` then `fetchReviewSummary` on the details path. Two paid “what do reviewers say” calls. Auto path does not do this.
3. **Paid `quote.stage` unused** — waste of tokens already spent; using it is free going forward.
4. **Webhook Graph fetch omits fields we already parse** — free bytes discarded.
5. **Apify re-sync does not `$set` likes** — free JSON discarded after first insert.
6. Duplicate `Media.post('save')` insights/comments is mostly dead (not currently double-calling). Leave it unless ingest switches to `save()`.

---

## 7. Recommendations (ranked)

Scoring: **signal unlock** (does it give Directors new conversion-useful facts) × **cost/risk** (engineering + money + prompt drift).

### R1 — Refresh engagement on known IG posts (no re-detect)

- **Unlock:** High. Makes likes/saves/comments *true* for the static Director that already reads them, and for R2.
- **Cost/risk:** Low. Free Graph. Must not set `forceDetect` (that is the billable re-scan).
- **Change:** `scheduledSyncService.runDueSyncs` and/or `postSyncService.syncPosts`: for `existing && !force`, call `refreshInsightsForMedia` (and optionally `fetchCommentsForMedia`) instead of `continue`. Keep the skip of DetectRun. Cap comment pagination as today. Same for Apify: `$set` likes/comments on re-sync, not only `$setOnInsert`.
- **Files:** `services/scheduledSyncService.js`, `services/postSyncService.js`, `services/apifyIngestService.js`, `services/mediaInsightsService.js`.

### R2 — Forward `performance_signal` (and comment likes) into the video-title Director

- **Unlock:** High relative to PR #390’s remaining hole. Video titles can then justify a proof/benefits slot with “this SKU’s posts do 4k saves,” not only a review quote.
- **Cost/risk:** Low–medium. Prompt delta on `video_title_director` only. Keep numbers as grounding, not extra slots (same rule PR #390 used for quotes). Do not put them in `buildVeoPrompt`.
- **Change:** `printableSocialProofForVideo` or `buildDirectorMessages` to include `likes/comments/saves/shares` + `top_post` + `top_comments[].likes`. Optionally personas/painPoints (already in `brand_signal`).
- **Files:** `services/videoBenefitsDirector.js`; pin in `scripts/verifyVideoBenefitsDirector.js`.

### R3 — Treat `apify-ig` as Instagram in Director/canvas filters

- **Unlock:** High for demo and public-handle brands; zero for OAuth-only brands.
- **Cost/risk:** Trivial. One filter.
- **Change:** `ugcMedias` (and canvas `social_context`) include `source === 'apify-ig'`.
- **Files:** `services/aiCreativeDirectorService.js:814`, `services/aiCanvasInputBuilder.js:238`. Bump `DIRECTOR_SIGNALS_VERSION` if the static shadow cache should re-derive.

### R4 — Include `like_count` / `comments_count` on the webhook Graph fetch; wire comment events later

- **Unlock:** Medium (correct first snapshot). Comment webhooks are the real-time half (larger).
- **Cost/risk:** Trivial for fields; comment field handling is more work (dedupe vs `fetchCommentsForMedia`).
- **Files:** `services/instagramWebhookService.js:26-29, 99-105`.

### R5 — Use Gemini `quote.stage` we already store; optionally persist complaints/themes on the same pass-2 schema

- **Unlock:** Medium for funnel fit. Stage labels are already paid. Complaints/themes need a **schema + prompt add** on pass 2 (same call, not a new paid call) — e.g. `complaints: string[]`, `praised_attributes: string[]`.
- **Cost/risk:** Medium. Must not let complaints print as testimonials (printability gate). Stage should *nudge* `pickPrimaryProductQuote`, not override star/sentiment gates.
- **Files:** `services/providers/geminiSearchProvider.js` (`REVIEWS_STRUCTURE_SCHEMA`, `structureReviewNarrative`); `services/layoutInputService.js` `scoreQuote` / `pickPrimaryProductQuote`; `assembleSignals` `quotes_by_stage`.

### R6 — Fix `avg_engagement_rate` to a real rate; add views/reach to `performance_signal`

- **Unlock:** Medium. Stops the Director treating “8 likes” as high engagement; enables honest “this Reel reached 80k.”
- **Cost/risk:** Low code, **prompt-behaviour change** for static (signals version bump).
- **Change:** `rate = engagement / reach` or `(likes+comments+saves)/reach` when reach > 0; otherwise omit. Pass `views` and `reach` as counts. Recalibrate the `>0.05` rule.
- **Files:** `services/aiCreativeDirectorService.js:1103-1138, 1660-1661`.

### R7 — Stop asking the static Director about creator followers until ingest writes them

- **Unlock:** Low until a writer exists; prevents another starved-brief.
- **Cost/risk:** Low. Follower count on IG Business is typically `followers_count` on the **user** node, not the media node — one extra Graph call per account, cache on Brand or credential, not per post.
- **Files:** `services/postSyncService.js` / `instagramOAuthService.js` (write); until then, drop or guard the prompt line at `aiCreativeDirectorService.js:1655`.

### R8 — Funnel-split benefits (only after R2)

- **Unlock:** Medium for conversion vs awareness titles.
- **Cost/risk:** Higher. Either a second derived field (`shortBenefitsByStage`) or a prompt change in `productBenefitsService.buildPrompt` returning `{awareness, consideration, conversion}` **on the same flash call** (no second bill). Video-title Director already has `profile`.
- **Files:** `services/productBenefitsService.js`, `models/CatalogProduct.js`, `videoBenefitsDirector.js`, `assembleSignals`.

### R9 — Tagged / mentioned UGC ingest (backlog #69)

- **Unlock:** Highest *ceiling* (real customer posts), highest *build* cost (rights, brand-safety, matching, detect spend).
- **Cost/risk:** High. Each new tagged post can enqueue a **billable** DetectRun. Needs `dailyDetectRunCap` from day one, `classification.socialPostType = 'ugc'`, and rights review before ads.
- **Files:** new path next to `postSyncService.js`; Graph `GET /{ig-user-id}/tags`; `instagramOAuthService.js` if an extra permission is required at reconnect time (confirm with a live Graph probe — do not assume).

### R10 — Deduplicate user-Enrich grounded review calls

- **Unlock:** None for ad quality; saves money.
- **Cost/risk:** Low.
- **Change:** If `lookupProductReviews` just ran or `productReviews.summary` is fresh, skip `fetchReviewSummary` (or write complaints/themes into `productReviews` and drop the sibling narrative).
- **Files:** `services/catalogProductEnrichmentService.js`, `services/productDetailsService.js`.

**Do not do (this pass)**

- Put likes/quotes into the Omni camera prompt (owner-frozen; PR #61 rollback class).
- Add `deriveFromMaster` / run id to video identity digest to “fix” anything here (money invariant).
- Re-derive benefits inside `assembleSignals` (already forbidden; ingest owns it).

---

## 8. Suggested implementation order

1. R1 (refresh stats) + R3 (Apify source filter) — data becomes real.
2. R2 (video Director sees numbers) + R4 (webhook fields) — both brains see it.
3. R6 (honest rates) + R5 (use paid stage labels) — conversion staging gets sharper.
4. R10 when touching enrichment.
5. R8 / R9 only with an explicit product decision (new field vs new ingest class).

---

## 9. Ambiguities not resolved without a human or a live probe

- **Whether Graph v26.0 still accepts the feed insights bundle** that leads with `impressions`. Errors are swallowed; this audit did not call Meta. A single authenticated `GET /{media-id}/insights?metric=impressions,reach,engagement,saved` on a real feed photo would settle it.
- **How many production tokens actually include `instagram_manage_insights`.** Code requests it; brands connected before that scope was added must reconnect. No DB read this audit.
- **Whether `/tags` needs a scope beyond what we already ask.** Documented as inferred.
- **How often operators run `media.refreshInsightsForBrand`.** If that is already habitual, R1 is less urgent than R2/R3; if not, R1 is the whole game.
- **Owner intent on tagged UGC (R9) vs “likes on our own posts” (R1–R3).** The verbatim ask names likes *and* “social input”; own-grid likes are the cheap half, customer tags are the expensive half. Needs a product call, not a guess.
