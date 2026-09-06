# LLM cost, inference-over-results, and Slack — specification

**Status:** specification, not code. No production files were edited.
**Date:** 2026-09-05.
**Repos:** `liquidretail_backend` (trunk `main`), `liquidretail_adgen` (trunk `master`).
**How this was produced:** a prior research pass completed the census, live Atlas catalog pull, first-party price fetch, and Slack inventory, then died (exit 144) before writing. This document is that deliverable. Two corrections verified in the live code after that pass are folded in (title-card unit cost; native Remotion typography).

**Discipline:** every cost has a derivation. Every code claim has a `file:line`. Model IDs are Atlas catalog slugs unless a sentence says they require a direct vendor account. Anything this pass did not re-verify is marked **UNVERIFIED**.

---

## How to read the money

LLM spend on a default Generate is a **minority line**. The material lines are Omni video plates and, if left on, gpt-image-2 title cards. That is the finding, not a failure of the census.

| Line | What it is | Per video (10s, 720p/1080p) | Source |
|---|---|---|---|
| Omni plate (ledger formula) | `(4k ? $1 : $0.20) + duration × $0.10` | **$1.20** | `atlasVideoService.js:461–463` (`basePerResolution['720p'/'1080p']=0.20`, `perSecond=0.10`); `META_VIDEO_DURATION_SEC=10` in both `config/defaults.env` |
| Omni plate (measured developer) | `$0.150 + $0.075/s` | **$0.90** | Prior-pass comment in `atlasVideoService.js` model-intel; **UNVERIFIED against live Atlas billing in this writing pass** |
| gpt-image-2 title cards (coded path) | 3 phase cards × non-dev `/edit` | **$0.215** | Measured `$0.07173` × 3 — see Correction 1 |
| Native Remotion titles (new path) | treatment-spec LLM + existing keep-out | **~$0.0003** | Correction 2 + §2A.3 |
| LLM stack, default Generate today | Director + Judge + layout + crumbs | **~$0.13** | §2A.5 |

Video duration is **10 seconds**. Do not restate 8. The `8s ≈ $1.00` comments in `atlasVideoService.js:446,462` and the `durationSec … : 8` fallback in `basePlateCropService.js:800` are leftover literals, not the default.

**Loop 2 plate cost — flag, do not swallow.** The architecture plan says a Loop 2 fire is ~$0.90 for *2 Omni plates*. A single 10s Omni developer plate is already ~$0.90. Either Loop 2 is one master, not two, or the plan's $0.90 is a stale single-plate figure. Until that is re-measured, price a Loop 2 fire as **2 × one 10s master: $1.80 measured-rate / $2.40 ledger**, and treat the plan's $0.90 as **unsafe to spend-gate on**.

---

## Correction 1 — gpt-image-2 title cards are ~$0.0717 each, not $0.04

The $0.04 figure is the **lifestyle-image** estimate, not the title-card path.

| Claim | Where | Live value |
|---|---|---|
| Title-card model | `liquidretail_adgen/src/services/directorTitleCardGenerate.js:86` | `process.env.AI_DIRECT_IMAGE_EDIT_MODEL \|\| 'openai/gpt-image-2/edit'` — the **non-developer** variant |
| Same default on the static plate path | `liquidretail_backend/services/directImageRenderService.js:105`; both repos `config/defaults.env:356` | `AI_DIRECT_IMAGE_EDIT_MODEL=openai/gpt-image-2/edit` |
| Measured charge, `/edit` | `directImageRenderService.js:80–96` | **$0.07173** (catalog `base_price` $0.01 under-reports ~7×) |
| Measured charge, `-developer/edit` | same block | **$0.03586** |
| Three phase cards / video | `directorTitleCardService.js:11,132–134` (one card per composed spec phase) | **3 × $0.07173 = $0.21519** |
| The $0.04 number | `catalogProductLifestyleImageService.js:27` | `PER_UNIT_ESTIMATE_USD = 0.04` at `quality=low`, **a different service** |

Kill switch: `ADGEN_DIRECTOR_TITLE_CARDS` defaults **false** (`liquidretail_adgen/config/defaults.env:1602`; gate at `directorTitleCardService.js:52`). Production Generate does not currently pay $0.215/video. The coded path, and the plan's Layer A burned-in cards if they kept gpt-image-2, would. Every rollup below uses **$0.07173/card** and **$0.215/video**, never $0.04.

Quality vs developer is **NOT VERIFIED**. The comment at `directImageRenderService.js:87–103` is explicit: schemas match, a 38-submit session showed developer at 15.8% hard failure, and that session was not a controlled comparison.

---

## Correction 2 — title typography moves off gpt-image-2 onto native Remotion

Live architecture decision, after the research pass. Real brand fonts are already ingested and loaded into the render browser:

- Ingest: `liquidretail_adgen/src/services/brandFontIngestService.js:872` `ingestBrandFonts`
- Resolve files: `liquidretail_backend/services/fontResolverService.js:1–26` `resolveBrandFonts` / `resolveFamily` (Brand.customFonts → Google Fonts → library substitution)
- Load in Remotion: `liquidretail_backend/remotion/components/FontLoader.jsx:66` `useBrandFonts`; consumed by `remotion/compositions/Canonical.jsx:291`

Face keep-out already runs in the titling path. Product keep-out already exists as a $0 DINO reproject. The new shape is:

1. An LLM authors a **typographic treatment spec** (structured JSON).
2. Remotion typesets that spec with the brand's real face.
3. A keep-out map, built from detectors that **already ship**, places the type.

The gpt-image-2 card path (`directorTitleCardGenerate.js`) is the thing this replaces, not a sibling. Economics in §2A.3.

---

## Price sources (named once)

| Source | What it covers | When |
|---|---|---|
| Live Atlas catalog `GET https://api.atlascloud.ai/api/v1/models` (UA `Mozilla/5.0`) | Token prices and routability for every recommended Atlas slug | 2026-09-05, 467 models. Prior research pass. **Not re-fetched in this writing pass.** |
| Atlas public UI | https://www.atlascloud.ai/pricing/models | Same day |
| Atlas skill table | `/Users/nicksheth/.agents/skills/atlas-cloud/SKILL.md` | **Stale on LLM IDs** — two listed slugs are gone. Do not use as a price source. |
| Local snapshot | `/Volumes/Sayulita/Projects/RS/claude-org-brain/scout/atlas-catalog-snapshot.json` | Same size (467), 37/37 swap vs live. Prefer live. |
| RS ledger | `liquidretail_backend/services/costTracker.js` `MODEL_RATES` (identical copy in adgen) | Code, 2026-08-19 corrections on Atlas Gemini cache rates and the vision-surcharge drop |
| Anthropic first-party | https://platform.claude.com/docs/en/about-claude/pricing | 2026-09-05. Sonnet 5 **$2/$10 is now the standard price**; the scheduled 2026-09-01 bump to $3/$15 will not occur. |
| OpenAI first-party | https://developers.openai.com/api/docs/pricing | 2026-09-05 |
| Gemini first-party | https://ai.google.dev/gemini-api/docs/pricing | 2026-09-05 |
| Measured gpt-image-2 | `directImageRenderService.js:80–96` | Charged prediction, not catalog `base_price` |

**Atlas routing fact that constrains every recommendation:** a slug that is not in this live catalog, or that Atlas 400s as `router not found`, cannot ride `POST https://api.atlascloud.ai/v1/chat/completions`. Recommending it means a new vendor account, a new key, a new fallback, and a new `costTracker` key. Direct OpenAI (`OPENAI_API_KEY`) and direct Gemini (`GEMINI_API_KEY`) already exist as fallbacks. Direct Anthropic does **not** (`ANTHROPIC_API_KEY` is not on Render; `DIRECT_KEYS` has no `anthropic` entry). Tracked in `docs/turn-on-anthropic-direct.md`, not done.

Hidden-but-catalogued (`display_console: false`) is how the models we actually use are listed: `anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`, `google/gemini-2.5-flash-lite`, `google/gemini-2.5-pro`. Hidden ≠ unroutable.

---

# 2A. LLM call-site census, model routing, and cost

Transport for all of this: `liquidretail_backend/services/atlasLlmService.js` — Atlas OpenAI-compatible `POST https://api.atlascloud.ai/v1/chat/completions`, with `ATLAS_LLM_MAX_ATTEMPTS` / chain budget / backoff. Role map: `atlasModelMap.js`. USD for LLM rows is **estimated** from `usage` × `MODEL_RATES`, not Atlas `prediction.price` (that reconcile is image/video). Stage is a free string on `CostLog`, not an enum — extend it, do not build a parallel ledger.

`CostLog` fields (both repos, `models/CostLog.js` + `services/costTracker.js`): `stage`, `provider`, `model`, `purposeTag`, identity ids (`brandId`, `campaignId`, `campaignRunId` string, `adId`, `mediaId`, `productId`), `providerRequestId`, `costSource` ∈ `{actual,estimated,unknown,none}`, cache flags, token counts, `visionImages`, `groundedRequests`, `costUsd`, `durationMs`, `status` ∈ `{ok,error,timeout,rejected,rejected-billing,failed,charged-no-output,submitted}`.

Vision surcharge is **$0** since 2026-08-19 (`costTracker.js:122–148`): image tokens already sit inside `prompt_tokens`. Grounding surcharge is **$0** (under Google's 1,500 RPD free). Unknown model → `costSource:'unknown'`, token USD not computed.

**Observed bake-off / probe numbers this census leans on** (from code comments, not a live CostLog query — **UNVERIFIED against Mongo in this writing pass**):

- Director sonnet-5: **~$0.105/run**; opus-5: **~$0.223/run** (`atlasModelMap.js:82`)
- Director actual output: **756–904 tokens** against a 30,000 `max_tokens` ceiling (`aiCreativeDirectorService.js:1897–1908`)
- review-text flash-lite: **$0.000012/call**, 851ms, zero reasoning tokens (`atlasModelMap.js:43`)
- luna on the same review-text probe: **$0.000195**
- Vision QC: **~$0.01–0.03** (`adVisionQcService.js:126–127`)
- Face-safe crop: **~$0.02 typical, ~$0.03 worst** (`basePlateCropService.js:47–50`)

Director input implied by those two figures: `$0.105 − (850 × $10 / 1e6) ≈ $0.0965` of input at $2/1M ≈ **~48k input tokens** including two catalog images. Prompt is well under the 200k Claude threshold (`costTracker.js:100–102`).

---

## 2A.1 What exists today — generate-path census

Default Generate assumptions (from `defaults.env` + `campaignAdsGenerationService.js`): `AI_CONCEPT_DRIVEN=true`; wizard kinds default **image** (`:1455`); 1 product; Director universe TOP_N=1; 3 concepts; vision QC **off**; comments already judged; detect already done; layout cache **cold**. Live path is `runConceptDrivenExpansion` → `directConceptsRound` + `judgeConceptsRound` (`campaignAdsGenerationService.js:398–401`). It returns before legacy cartesian (`:1637–1648`).

`copyDerivationService`, V1 `directConcepts` (`stage:'creative_director'`), `aiJudgeService.judgeCandidates`, `aiCanvasSpecService`, `aiCanvasHtmlGeneratorService` fire only on **legacy cartesian** (flag off **and** image-only single format). They are not on this path.

### Generate-path LLM calls

| # | Call site | Purpose | Model actually used | max_tokens / format | Per default Generate | Stage | Live? | Cost/call | Cost/Generate |
|---|---|---|---|---|---|---|---|---|---|
| G1 | `aiCreativeDirectorService.js:2434` `directConceptsRound` (role hardcoded `'director'` at `:1885`) | 3 concepts: copy + style + `media_picks` | Role `director` → Atlas `anthropic/claude-sonnet-5` → opus-5 → `openai/gpt-5.6-terra`. Direct Anthropic twin is a named skip (no key). Override `ATLAS_MODEL_DIRECTOR` collapses the chain. | 30000, `json_object`, temp 0.45. **No `json_schema`** — Atlas 400s it on Claude (`atlasModelMap.js:85–89`). | **1 per product.** +1 if `validateDirectorPayload` fails (one re-ask, same budget). No cache. | `creative_director_round` | LIVE backend | **~$0.105** (bake-off). Derivation: ~48k in × $2/1M + ~850 out × $10/1M. Atlas rates = Anthropic list. | **$0.105** typical; **$0.210** on re-ask |
| G2 | `aiJudgeService.js:440` `judgeConceptsRound` | Rank 3 concepts, no culling | `JUDGE_MODEL` \|\| `'gpt-4.1-mini'` (`:27`) → Atlas `openai/gpt-5.6-luna` (`atlasModelMap.js`) | 1500, `json_schema`, temp 0 | **1 per product** if ≥2 concepts (always 3). Fail → unscored, still mint. | `judge_concept_round` | LIVE backend | Est. 4k in × $1/1M + 800 out × $6/1M = **~$0.0088** (Atlas luna). **UNVERIFIED vs CostLog.** | **~$0.009** |
| G3 | `quoteSnippetService.js:702` `judgeProofLines` via `usableProofCommentsOrNone` from Director `assembleSignals` (`:946`) | Sentiment-screen UGC comments for the Director pool | `QUOTE_SNIPPET_MODEL_ID` \|\| `'review-text'` → `google/gemini-2.5-flash-lite` | `60N+200`, `json_schema` | **0** if already judged; **1 batch** first time comments are used | `proof_line_judge` | LIVE backend, first-touch | Same class as review-text probe **~$0.00001–0.00005** | **$0** steady-state |
| G4 | `campaignBriefDerivationService.js:240` | Per-campaign intent for the Director prompt | hardcoded `'gpt-4o-mini'` → luna | 1200, `json_schema` | **0 on Generate** unless brief missing; TTL 7d; POST `/derive-brief` + campaign sync | `campaign_brief` | ingest/sync, not Generate | ~$0.002 if it fires (Atlas luna, small) | **$0** |
| G5 | `brandVoiceDerivationService.js:208` | `Brand.derivedVoice` from Meta/Google ads | `'gpt-4o-mini'` → luna | 1200, `json_schema` | **0 on Generate**; nightly/manual | `brand_voice` | not Generate | ~$0.002 | **$0** |
| G6 | `campaignAdsGenerationService.js:1382` `ensureDetectForProducts` | Overlay/identify if a catalog image was never detected | see ingest table | — | **0** if already detected; burst on first Generate of a SKU | several | first-touch only | — | **$0** steady-state |

### Render-path LLM calls (per ad, after mint)

Runs in **adgen** if `ADGEN_RENDERER_ENABLED=true` (production sets this even though committed defaults say `false`), else backend `renderService` / `brandScriptExecutor`. Same files exist in both.

| # | Call site | Purpose | Model actually used | max_tokens / format | Per default Generate | Stage | Live? | Cost/call | Cost/Generate |
|---|---|---|---|---|---|---|---|---|---|
| R1 | `layoutInputService.js:911` `runDerivation`; model at `:90` | headline, subhead, CTA, `short_benefits[]`, badges, theme | `GEMINI_SEARCH_MODEL` \|\| `'gemini-2.5-pro'` → Atlas `google/gemini-2.5-pro`. **There is no `LAYOUT_DERIVATION_MODEL` env.** Fallback `fallbackDerivation` if LLM fails. | 3000, `json_schema` nonstrict, temp 0.3 | **1 per cache miss** of `(mediaId, template, aspect, product)` (`:207–209`). Same media × 3 Meta sizes = up to 3. Cache hit = 0. | `layout_derivation` | LIVE at render | Est. 4k in × $1.25/1M + 800 out × $10/1M = **~$0.013**. (`costTracker.js` bare `gemini-2.5-pro` still ledgers output at **$5**, which understates Atlas/Google $10 — flag, left untouched 2026-08-03.) | **~$0.013** on `preset=single`; **up to ~$0.039** on `meta_static` |
| R2 | `quoteSnippetService.js:516` `extractSnippet` from `layoutInputService.js:2869` | ≤50-char extractive overlay snippet | `'review-text'` → flash-lite | 60, `json_schema` | **1 per layout cache miss** if a quote exists | `quote_snippet` | LIVE at render | **$0.000012** measured | **~$0** |
| R3 | same `judgeProofLines` as G3 | Comments used as proof in layout | `'review-text'` | as G3 | 0 if judged | `proof_line_judge` | first-touch | ~$0.00005 | **$0** |
| R4 | `adVisionQcService.js:125` `judgeRender` | Post-render 2-image QC | role `'ad-vision-qc'` / `ATLAS_MODEL_AD_VISION_QC` / `AD_VISION_QC_MODEL` → `google/gemini-2.5-pro` | 5000, `json_object` | **0 unless `SystemConfig.staticVisionQcEnabled`**. Prod finding 2026-08-19: all ads shipped `visionQc:null`, gate off. | `ad_vision_qc` | wired, default OFF | **~$0.01–0.03** | **$0** |
| R5 | `adVisionQcService.js:196` `judgeVideoRender` | Multi-frame QC | same role | 6000, `json_object` | 0 unless `videoVisionQcEnabled` | `ad_video_vision_qc` | default OFF | **~$0.01–0.03** | **$0** |
| R6 | `veoStoryboardService.js:162` | Camera/audio/vibe knobs | `VEO_STORYBOARD_MODEL_ID` \|\| `'gpt-4.1'` → terra | 200, `json_schema` | **1 per video ad** if `VEO_USE_GPT_STORYBOARD=true` (both repos `defaults.env` **true**, backend `:409`) | `veo_storyboard` | LIVE on video | Est. 800 in × $2.50/1M + 150 out × $15/1M = **~$0.004** | **$0** on default image Generate; **~$0.004** per video ad |
| R7 | `plateIntelService.js:378` `semanticScan` | Which bands cover faces/product | `TITLE_SCAN_MODEL` \|\| `'gemini-2.5-flash'` | 1024, `json_object` | **0 in backend default**; **1 per plate in adgen** (`TITLE_PLATE_SCAN=gemini`, adgen `defaults.env:1835`) | `title_plate_scan` | adgen LIVE / backend dormant | Est. ~$0.001–0.003 (flash $0.30/$2.50, one frame) | **~$0.002** on adgen video |
| R8 | `basePlateCropService.js:400` `detectFrameBoxes` | Subject + head boxes | `'gpt-4.1'` → terra | 400, temp 0 | **1–4 vision calls** per crop-needed video (typical 10s ≈ 3–4 stills); +2 retry ~9% of crop-eligible; **$0** cached re-title / gated-out / same-aspect | `base_plate_crop` | LIVE on video crop | **~$0.02 typical, ~$0.03 worst** (code comment, `:47–50`) | **$0** on default image Generate; **$0–0.03** on video |
| R9 | adgen-only `videoBenefitsDirector.js:218` | Whether to add a benefits slot | `'director'` chain | 800, `json_object` | **0 today.** `assembleSignals().product_signal` has no `benefits`; CatalogProduct has no `shortBenefits`. Always short-circuits (`:207–208`). `VIDEO_BENEFITS_PLACEMENT=true` does not change that. | `video_title_director` | wired, 0 calls | — | **$0** |

**Benefit synthesis today — a plan problem, not a cost line.** The only LLM that writes `short_benefits[]` is **layout derivation (R1)** (`layoutInputService.js:1276`, persisted `:3005`). Director does **not** emit benefits. `copyDerivationService.js:208` still *reads* `product.shortBenefits` but that field is **not on CatalogProduct** (always `[]`). Cascade `metaCascadeConfig.js:155` reads `layoutInput.input.product.short_benefits`. See N1 in the plan-implied table.

### Default Generate rollup — today

| Wizard | LLM calls typical | LLM $ | Non-LLM $ (for contrast) |
|---|---|---|---|
| `preset=single` (default image, 3 static ads) | G1 + G2 + R1 + maybe R2 = **3–4 calls** (4–5 with Director re-ask) | **~$0.128** (`0.105 + 0.009 + 0.013 + 0.000012`) | 3 × gpt-image-2/edit **$0.215** (static plates, measured) |
| `preset=meta_static` (3 sizes → 9 static ads) | G1 + G2 + R1× up to 3 + R2× up to 3 = **5–8** | **~$0.154** | 9 × $0.07173 = **$0.646** |
| Video-only (`deterministicVideo`, no Director) | R1 (if layout built) + R6 + R7 + R8 | **~$0.04** (storyboard + plate scan + crop; layout if cold) | Omni **$0.90 measured / $1.20 ledger** + title cards **$0.215 if the flag is on** |
| Mixed `meta_all` | static block plus video block; Director still **1/product** | static ~$0.15 + video ~$0.04 | both non-LLM columns |

**LLM is not the material line on any of these.** On default static, gpt-image-2 plates cost ~1.7× the entire LLM stack. On video, Omni is ~7–9× the LLM stack, and gpt-image-2 title cards (if enabled) cost **more than the LLM stack**.

### Ingest / catalog / detect (not default Generate; first-touch possible)

All via `chatCompletion` unless noted. Backend-owned.

Inventory identify, NER, subject-text, YOLO identify, Gemini identify, crop refine, overlay zones, visual SKU match, detect judge, extended-crops judge, product reasoner, product category, brand enrichment, grounded product match, brand/product reviews (2 LLM calls per fetch, cached), product review summary, category reviews, layout studio vision, Meta ads fonts, QC insights proposals. Models are mostly `'gpt-4.1'` → terra, `'review-text'` / `GEMINI_VISION_MODEL` / `GEMINI_SEARCH_MODEL`, `'font-vision'`, `'qc-insights'`. **Not priced into the Generate rollup.** Overlay zones used to be the largest ingest line (Gemini-pro, measured 2026-09-02 Pelagic resync **$143 / 64% of $223**); `dinoOverlayZoneService.js` replaced that with **$0 math**.

### Operator / agent / HTML (not Generate)

| Call | File:line | Model | Stage | Notes |
|---|---|---|---|---|
| Agent chat stream | `routes/agent.js:155` | `AGENT_MODEL=gemini-2.5-flash` (`defaults.env`) | `recordFlatCost`; up to 8 iters | Streaming usage often `$0` — real gap |
| Title-spec modify | `routes/brand.js:2046+` `atlasText.generate` | `ATLAS_TEXT_MODEL_ID` \|\| `anthropic/claude-sonnet-4.6` | **not tracked** | `atlasTextService` is a third transport with **no CostLog** |
| HTML layout gen | `aiCanvasHtmlGeneratorService.js:250` | `gpt-4.1` | `layout_generator_html` | Legacy. Live static is `directImageRenderService` |
| JSON canvas spec | `aiCanvasSpecService.js:1401` | `gpt-4.1` | `layout_generator` / `legacy_ai_canvas_spec` | Same legacy path |
| Copy derivation | `copyDerivationService.js:120` | `COPY_DERIVATION_MODEL` \|\| `gpt-4.1-mini` | `copy_derivation` | Legacy cartesian only (`runCopyDerivationEager`) |
| V1 canvas judge | `aiJudgeService.js:69` | `gpt-4.1-mini` | `judge` | HTML/JSON multi-candidate intro only |

Script-only `scripts/verify*.js` stubs that call `chatCompletion` are out of the generate path. Treat as script-only.

---

## 2A.2 Plan-implied calls — model, cost, frequency

Routing rule used throughout: **cheapest Atlas-routable model that clears the call's quality bar.** Mechanical / high-volume → `google/gemini-2.5-flash-lite` (measured winner for extractive JSON; zero reasoning tokens; `json_schema` works). Copy that has to match Director voice → `anthropic/claude-sonnet-5` (bake-off winner). Spend-adjacent judgment → sonnet-5, never opus-5, never a binary-gate on a $30/1M flagship.

Do not use `qwen/qwen3.5-flash` for JSON extract (HTTP 400 on strict `json_schema`). Do not use Doubao / reasoning-flash for short JSON (hidden reasoning tokens billed as output; 2026-07-27 bake-off: looked 20× cheaper, cost 2× more). Do not use `claude-haiku-4.5` for verbatim or schema-tight work (5/6 non-verbatim on the quote probe). `gpt-5-nano` is **not on Atlas** (removed; was `router not found`). `gemini-2.0-flash-lite` is **shut down at Google and not on Atlas** — drop it from `MODEL_RATES`.

| ID | Call site (would live) | Purpose | Recommended model | Why that model / quality bar | In / out tokens | Cost/call | Frequency | Cost/Generate |
|---|---|---|---|---|---|---|---|---|
| N1 | Extend G1 `directConceptsRound` contract. **Not a fourth serial Director call.** New field `angles[]` of length 4, each `{angle, headline, subheadline, benefits[3], cta, eyebrow}`. | Angle copy ×4 + benefit synthesis, one round | `anthropic/claude-sonnet-5` (existing `director` role) | Bar: on-brand, angle-faithful, no product-name-as-headline, benefits that are actually in the catalog signals. Same bar the 2026-07-31 bake-off already paid to establish. Four serial sonnet rounds would be **$0.42** for no quality gain the Judge isn't scoring. Output grows ~4/3 vs today's 3-concept JSON. | ~50k in (same universe) / ~1,200 out (4 packs × ~300). Derivation: today's 850 out × 4/3. | **~$0.14** = 50k × $2/1M + 1,200 × $10/1M | **1 per product per plate** | **$0.14** |
| N2 | New `loop1CopyRewrite` next to G1, Phase 4. Input = one losing angle's copy + the winner's copy + the angle preset. Output = one new pack, same schema. | Loop 1 copy iteration | `anthropic/claude-sonnet-5` | Bar: must sound like the Director, not like a cheaper model paraphrasing it. Flash-lite is the wrong bar (extractive, not generative). A dedicated `gemini-2.5-flash` rewrite is how you get off-brand CTAs. Smaller than G1: no universe images. | ~8k in / ~400 out | **~$0.020** = 8k × $2/1M + 400 × $10/1M | **per underperforming angle**, not per Generate | **$0** on Generate. ~$0.02 per Loop 1 fire |
| N3 | New `creativeInferenceService`, Phase 4 shadow / Phase 5 before auto. See §2B. | Reasoning over performance results | `anthropic/claude-sonnet-5` | Bar: a structured verdict a human will act on, and that can **veto** a $1.80–$2.40 fire. Flash-lite will agree with the numbers and miss the "three of four angles are objection-led and this product has no objection" case — that's the whole point of the layer. Opus-5 is 2× ($0.223-class) for a weekly batch job. | ~12k in / ~800 out (payload in §2B) | **~$0.032** = 12k × $2/1M + 800 × $10/1M | **weekly per (brand, product)** that has new rollup rows; also on-demand before a Loop 2 button | **$0** on Generate |
| N4 | New `catalogFeedCopyAdapt`, Phase A/B/C. Input = already-minted angle copy + destination limits (Meta title 200, Google short headline 30, Pinterest 100 — **UNVERIFIED against current network docs in this writing pass**; treat limits as a table the call reads, not as this sentence). | Constrained rewrite onto a catalog network | `google/gemini-2.5-flash-lite` | Bar: valid JSON, character limits held, no new claims. Mechanical. Flash-lite cleared that bar on the quote probe at $0.000012. | ~2k in / ~300 out | **~$0.00032** = 2k × $0.10/1M + 300 × $0.40/1M | **per SKU per network** at catalog publish, not per Generate | **$0** on Generate |
| N5 | New `typoTreatmentSpecService` on the adgen titling path, next to `titleSpecService`. Replaces `directorTitleCardGenerate.js`. | Typographic treatment spec for native Remotion | `google/gemini-2.5-flash-lite` | Bar: valid enum-constrained JSON; font **role** (not a family name — Remotion already resolved the file); no invented faces. This is assignment, not taste. Sonnet is wasted here. See §2A.3 for schema. | ~1.5k in / ~250 out | **~$0.00025** = 1.5k × $0.10/1M + 250 × $0.40/1M | **1 per angle** (treatment is brand+angle; Remotion scales it per format via existing safe zones) | **$0.001** for 4 angles |
| N6 | Keep-out map for native type placement | **No new model call.** See §2A.3 | — | Existing detectors already cover faces, product, occupied bands, and platform chrome. Adding a vision LLM would re-detect what DINO + face-keep-out already paid for — the exact waste `dinoOverlayZoneService.js:6–14` was written to kill. | — | **$0 new.** Face detect, if not already on `Ad.basePlate`, is the existing R8 ~$0.02 and already fires on the titling path. | once per video ad, already | **$0 new** |
| N7 | Customer weekly digest prose | **No new model call.** Bind numbers in a template from rollup rows; copy `headline_for_operator` out of the N3 verdict. | — | A customer-facing message stating a wrong number is worse than no message. An LLM rewriting already-structured sentences is how those numbers drift. See §2C. | — | **$0** | weekly | **$0** |
| N8 | Layer B Meta `asset_feed_spec` extra headlines/descriptions | **No new model call** if N1 emits ≥5 headlines across 4 angles (Meta mixer wants multiple). If a network requires more strings than N1 produced, reuse N2's rewrite on the winning pack, flash-lite, same as N4. | flash-lite only if a filler rewrite is required | Mechanical length/variant fill. | as N4 | ~$0.0003 | rare | **$0** typical |

**G2 (Judge) after the plan:** keep it on Generate, still ranking the 4 angle packs for operator display. Do not let it cull — minting all 4 is the point of Layer A. Cost stays ~$0.009. If the Judge is later pointed at Loop 1 rewrites, same call, same cost.

**R1 (layout derivation) after the plan:** stays on the **static** path. Video Layer A does not need it for benefits (N1 now owns those). Do not delete R1; static overlays still read `LayoutInputArtifact`.

New `CostLog.stage` strings, added to the existing free-string taxonomy, not a new collection: `typo_treatment_spec`, `loop1_copy_rewrite`, `creative_inference`, `catalog_feed_copy`. Reuse `creative_director_round` for N1.

---

## 2A.3 Native typography path — models, keep-out, before/after

### (a) Treatment-spec authoring — N5

One cheap structured-output text call per angle. Remotion renders it deterministically with fonts already on the machine.

**Model:** `google/gemini-2.5-flash-lite` via the existing `review-text` transport (`atlasLlmService` `json_schema`, role can be a new `typo-treatment` row in `atlasModelMap.js` pointing at the same slug, overridable `ATLAS_MODEL_TYPO_TREATMENT`). Atlas live: **$0.10 / $0.40 / $0.01 per 1M**, ctx 1,048,576. First-party Gemini matches. Direct Gemini twin already wired.

**Why not sonnet-5:** the call does not invent copy and does not see a plate. It maps `{angle, copy, brand tokens, format class}` onto a closed enum. Sonnet is ~20× ($2/$10 vs $0.10/$0.40) for no bar this call has.

**Why not haiku-4.5:** failed verbatim-constraint on the quote probe. This schema is the same class of constraint.

**Why not luna:** 10× Atlas token price vs flash-lite; the review-text bake-off already measured luna at $0.000195 vs $0.000012 on equivalent short JSON.

**Schema the model must emit** (closed enums, salvage in code the same way Director JSON is salvaged — flash-lite accepts `json_schema`, unlike Claude):

```json
{
  "schemaVersion": 1,
  "fontRole": "heading" | "body" | "quote",
  "weight": 400 | 500 | 600 | 700 | 800 | 900,
  "sizeRatio": 0.04,
  "layoutMode": "single_line" | "stacked" | "split_left" | "bottom_bar",
  "colorToken": "on_dark" | "on_light" | "brand_primary" | "brand_accent",
  "casing": "as_authored" | "upper" | "title",
  "tracking": "tight" | "normal" | "wide",
  "align": "left" | "center",
  "stagger": { "hookMs": 0, "proofMs": 2500, "closeMs": 7000 }
}
```

`fontRole` is a role in `fontResolverService.js:40–44` (`heading` / `body` / `quote`), **not** a family string. The file is already chosen. `sizeRatio` is a fraction of canvas height; clamp in code to `[0.035, 0.12]`. `colorToken` resolves through existing brand tokens, not a hex the model paints. Invalid enum → deterministic fallback (current DOM title spec), never a gpt-image-2 card.

**Token derivation:** system prompt = schema + brand token names + angle enum ≈ 800 tokens; user = copy pack + format class ≈ 700; output ≈ 250. **$0.00025/call.** Four angles: **$0.001/video-set.**

### (b) Vision keep-out — do not add a model call

The architecture note said "a VISION step supplies a keep-out map." That step already exists. It is a merge, not a new LLM.

| Signal | What it protects | Where | Cost |
|---|---|---|---|
| Platform safe zones | IG action rail, story chrome, YT lower-third | `remotion/lib/safeZones.js` (both repos) | $0 |
| Face keep-out | Heads in the title band | `brandScriptExecutor.js:2211` `ensureFaceDetectionForKeepOut` (adgen twin `:2466`); multi-frame consensus in `faceSafeCrop.js` (pure geometry, no I/O) | **$0** when `Ad.basePlate` already has `faceSamples` from the crop path; otherwise **one** `detectClipBoxes` (the existing R8 terra call, ~$0.02), cached on the Ad. `TITLE_FACE_KEEPOUT=false` → null → bands stay `avoid:false` (`brandScriptExecutor.js:2205–2208`) |
| Product / subject / on-plate text | Don't type on the garment, the logo, the hang tag | `dinoOverlayZoneService.js:1–45` — reprojects YOLO/Grounding-DINO `Media.refinedProducts` into crop space, emits `restrictions[]` with classes `product`, `face`, `secondary_subject`, `text`, `object` **without a Gemini call** | **$0**. Built to kill the ingest Gemini overlay pass ($143 / 64% of one Pelagic resync) |
| Occupied title bands | Which of the title strips are already busy | `plateIntelService.js:378` `semanticScan` (R7) | already on the adgen path if `TITLE_PLATE_SCAN=gemini`; **reuse**, do not add a second scan |

**Decision:** the keep-out map is `safeZones ∪ face envelope ∪ DINO restrictions ∪ plateIntel occupied bands`, computed in the existing CJS titling path (`brandScriptExecutor` already calls `analyzePlate` / `applyFaceKeepOut` before Remotion — comment at `:2221–2226`). Remotion reads the map. **No new vision LLM.**

What this merge does **not** cover, and we accept: on-product woven labels DINO missed, and background scene text (signage). `dinoOverlayZoneService.js:31–40` already documents that loss. Native type sitting on a street sign is a worse problem than gpt-image-2 drawing a word on a street sign, but not one a second Gemini-pro call is worth ~$0.02–0.05 to maybe catch. If it becomes a real defect, the add-back path in that file is local Tesseract, not a new Atlas vision role.

**Do not** point `overlayZoneService.js`'s Gemini path at title placement. That is the $143 ingest line.

### Before / after economics, per video

Assuming the gpt-image-2 card path as currently coded (3 phases, non-dev `/edit`, medium quality). Flag is off in prod; this is the path Layer A would have paid.

| | gpt-image-2 cards (today's coded path) | Native Remotion (new path) |
|---|---|---|
| Typesetting | 3 × `openai/gpt-image-2/edit` @ **$0.07173** | Remotion + ingested TTF, already on the render | 
| Treatment | baked into the image prompt (`buildCardPrompt`, `directorTitleCardService.js:197`) | N5 flash-lite **$0.00025** × 1 angle (or ×4 if all angles render) |
| Keep-out | **blind to the frame** (the canary that motivated the clean-sheet: cards collide with the brand logo) | merge of existing detectors, **$0 new** |
| **Total per video** | **$0.215** | **~$0.00025–0.001** (+ R8 ~$0.02 only if faces were not already detected, which today's titling path already pays) |
| **Delta** | — | **−$0.214/video** |

At 40 video Generates/month that's **~$8.60/month saved** on title cards, against **~$0.04** of new treatment-spec LLM. The LLM added by this decision is noise. The $0.215 line is the one that mattered, and it goes away.

---

## 2A.4 After-plan Generate rollup

Assumptions: 1 product, 1 plate, 4 angles minted, Layer A video titles via native Remotion, vision QC still off, detect already done, comments judged, layout cache cold on any sibling static.

| Step | Calls | $ |
|---|---|---|
| N1 Director (4-angle contract) | 1 | **$0.14** |
| G2 Judge (rank, no cull) | 1 | **$0.009** |
| N5 treatment spec | 4 | **$0.001** |
| N6 keep-out | 0 new | **$0** |
| R6 storyboard (if video flag on) | 1 | **$0.004** |
| R7 plate scan (adgen) | 1 | **$0.002** |
| R8 face crop / keep-out detect | 0–1 | **$0–0.03** |
| R1 layout (static sibling only) | 0 on video-only | **$0** |
| **LLM total** | **~8–9** | **~$0.16 typical; ~$0.19** with crop + Director re-ask |

Non-LLM on the same Generate: Omni **$0.90–$1.20** per master. Title cards **$0** (native). Loop 1/2 do not fire on Generate.

**Before → after LLM, default Generate:** ~$0.13 (static today) vs ~$0.16 (video+angles after). A few cents. The real before/after is **+$0.90–$1.20 Omni** (the plate, which already existed on the video path) and **−$0.215 title cards** (if Layer A would have used gpt-image-2).

---

## 2A.5 Per-brand per month, stated volume

**Assumption, stated:** one mid-size brand, **40 product Generates/month**, **4 Loop 1 fires/month** (10% of Generates earn a copy rewrite), **2 Loop 2 fires/month**, **4 weekly inference runs** (one per week over the products that moved), catalog-feed adapt **80 SKU×network writes/month** once Phase A ships, **4 customer digests/month** (templated, $0 LLM).

| Line | Math | Monthly $ |
|---|---|---|
| Generate LLM | 40 × $0.16 | **$6.40** |
| Loop 1 copy | 4 × $0.020 | **$0.08** |
| Inference (N3) | 4 × $0.032 | **$0.13** |
| Catalog-feed adapt | 80 × $0.00032 | **$0.03** |
| Treatment spec (already in Generate) | — | (included) |
| **LLM total** | | **~$6.64** |
| Omni plates (Generate) | 40 × $1.00 (mid of $0.90–$1.20) | **$40** |
| Loop 2 plates | 2 × **$1.80 measured-rate** (2 masters; see flag at top) | **$3.60** |
| Title cards, old path, if left on | 40 × $0.215 | **$8.60 — do not spend this** |
| Title cards, new path | 40 × $0.001 | **$0.04** |

**LLM is ~14% of generation spend at this volume, and most of that 14% is the Director round we already run.** Loop 1, inference, treatment specs, and catalog adapt are cents. An inference layer that cannot fire Loop 2 cannot accidentally become a money bug on the LLM line; the money bug is still Omni.

If volume is 10× (400 Generates/month), LLM is ~$66 and Omni is ~$400. Same fraction. The routing decisions above still hold; the thing that would justify leaving Atlas for direct OpenAI luna ($0.20/$1.20 vs Atlas $1/$6) is **G2 + any luna-mapped leftover**, not N5. I am **not** recommending that move in this spec. One gateway, one key, one ledger. Revisit only if Judge volume 10×es and CostLog shows luna as a real line.

---

# 2B. Inference over performance results

Mechanical thresholds in the plan stay. They are cheap, auditable, and do not hallucinate:

- hold rate below the brand's 25th percentile
- log-slope ≤ ln(0.92)/week
- spread < 15% relative
- conditions 4 ∧ 5 (budget caps, genuinely-different-plate gate)
- condition 6 week-bucketed hold-rate / CPM residuals (fatigue)

The inference layer sits **on top**. It does not replace a threshold with a paragraph.

## 2B.1 Where inference adds value, and where it does not

**Does not add value — do not call the model:**

- Computing any of the thresholds. That is SQL / a rollup job.
- Deciding that a cap binds. That is arithmetic.
- `identityDigest` uniqueness on `(campaignId, identityDigest)`. That is a unique index.
- Minting ads, writing `Ad.copy`, pushing to Meta. Those have existing write guards.
- Agreeing with a threshold. "Hold rate is below p25, therefore Loop 1" is a sentence a template can write.

**Does add value — this is the call:**

1. **Copy diagnosis.** The thresholds see that angle A is winning and angle B is not. They cannot read the headlines and say *what* is working ("the winner names a fabric and a temperature; the losers name a lifestyle"). That is the Loop 1 input. No numeric gate produces it.
2. **Angle-preset misfit.** "These four angles all underperform, but three of them are `objection_resolved` and the product has no real objection to resolve." The intent taxonomy is real (`product_first_lifestyle`, `objection_resolved`, `social_proof_led`, dormant `brand_led`) and render-time `resolveIntent()` already exists; the inference layer is the first thing that can notice the *set* is skewed.
3. **Plate vs copy.** Thresholds can fire Loop 2 (new plate, ~$1.80) or Loop 1 (new copy, ~$0.02). The cross-sectional "the picture is the ceiling" test (conditions 1∧2∧3) is the mechanical Loop 2 trigger and should stay mechanical. Inference's job is the residual cases: mechanical says Loop 1, but the winning and losing copy are near-duplicates so a rewrite will not move the number; or mechanical says Loop 2, but one unused angle preset has never been tried on this plate. That residual is where a $0.032 call can save a $1.80 fire **or** stop a useless $0.02 rewrite from looking like progress.
4. **Fatigue narrative.** Condition 6 is a residual against the brand's own concurrent weeks. The number is the trigger. The sentence an operator (or a brand) needs is "this plate has been in market 6 weeks, CPM drifted +18% vs the brand's other live plates, hold rate did not." That sentence is written from the rollup, not instead of it.

## 2B.2 What it reads

One payload, built in code, never "go look at the DB":

```json
{
  "brandId": "...",
  "productId": "...",
  "windowDays": 14,
  "plate": {
    "mediaId": "...",
    "identityDigest": "...",
    "recipe": { "seedUgcIds": [], "shotType": "..." },
    "ageDays": 18
  },
  "angles": [
    {
      "angle": "social_proof_led",
      "adId": "...",
      "copy": { "headline": "...", "benefits": ["..."], "cta": "..." },
      "publishedCopy": { "headline": "..." },
      "metrics": {
        "impressions": 12000,
        "holdRate": 0.31,
        "cpm": 8.4,
        "spendUsd": 42.10,
        "clicks": 110,
        "purchases": 3
      },
      "thresholds": {
        "holdRatePctl": 18,
        "logSlopePerWeek": -0.11,
        "spreadRel": 0.09
      }
    }
  ],
  "brandBaselines": {
    "holdRateP25": 0.28,
    "holdRateP50": 0.36,
    "cpmP50": 7.1
  },
  "mechanical": {
    "loop1WouldFire": ["adId", "..."],
    "loop2WouldFire": false,
    "loop2Reasons": [],
    "capBinds": false
  },
  "priorVerdicts": [
    { "at": "2026-08-29", "recommendation": "loop1", "followed": true }
  ]
}
```

Size: 4 angles × (~200 tokens copy + ~80 tokens metrics) + plate + baselines + prior verdicts ≈ **8–12k tokens**. That is the 12k input in N3. Do not attach images. Do not attach CostLog. Do not attach other brands.

`publishedCopy` is the Phase 0 field the plan already needs so machine output never overwrites the human-edit channel (`metaCascadeConfig.js:44–48` cascade). Inference reads **published** copy when present, generated copy otherwise. Diagnosing the machine's unused draft while Meta is serving the human edit is how you get a confident wrong verdict.

## 2B.3 What it emits — structured output

Machine-actionable, auditable, not prose. Salvage/validate in code. Reject and no-op on schema miss (same posture as `validateDirectorPayload`).

```json
{
  "schemaVersion": 1,
  "verdictId": "uuid",
  "at": "ISO-8601",
  "brandId": "...",
  "productId": "...",
  "plateMediaId": "...",
  "recommendation": "hold" | "loop1" | "loop2" | "retire_angle" | "retire_plate",
  "targetAdIds": ["..."],
  "targetAngle": "objection_resolved" | null,
  "confidence": 0.0,
  "reasons": [
    {
      "code": "copy_pattern" | "angle_misfit" | "plate_ceiling" | "fatigue" | "insufficient_n" | "cap_binds",
      "detail": "≤140 chars, no numbers the model invented — numbers are cited from input keys"
    }
  ],
  "copyDiagnosis": {
    "winnerAdId": "...",
    "loserAdIds": ["..."],
    "whatWorked": "≤200 chars",
    "whatToTry": "≤200 chars"
  },
  "vetoMechanicalLoop2": false,
  "vetoReason": null,
  "headlineForOperator": "≤120 chars",
  "headlineForBrand": "≤120 chars, no internals",
  "numbersCited": ["angles[0].metrics.holdRate", "brandBaselines.holdRateP25"]
}
```

`numbersCited` is the anti-hallucination hook: the writer that posts to Slack / in-app **re-reads those keys from the payload** and interpolates. If the model writes a number that is not in `numbersCited`, the writer strips it. If a cited key is missing, the verdict is invalid and does not ship.

`headlineForBrand` is allowed to be empty. Empty → no customer message from this verdict (the common case).

## 2B.4 Authority — the money question

**Decision: recommend-only for spend. Veto-capable against a mechanical Loop 2. Cannot authorize a fire. Cannot mint, cannot push, cannot write `Ad.copy`.**

| Action | Authority |
|---|---|
| Fire a Loop 2 (~$1.80–$2.40) | **No.** Mechanical thresholds fire it, and only after the plan's own manual → shadow → auto sequence. The LLM may *recommend* Loop 2 in shadow; a human (manual) or the mechanical gate (auto) spends. |
| Fire a Loop 1 (~$0.02) | **No auto-fire from the LLM.** Loop 1 is "free" relative to a plate but it still writes copy. Same sequence: operator button, then shadow, then auto from **mechanical** underperformance, not from the verdict. The verdict's `copyDiagnosis.whatToTry` is the prompt input to N2 when Loop 1 does fire. |
| Veto a mechanical Loop 2 | **Yes, in auto.** A structured `vetoMechanicalLoop2: true` with `vetoReason.code ∈ {angle_misfit, insufficient_n, cap_binds}` plus `confidence ≥ 0.7` **blocks the fire** and opens an operator Slack (see §2C). Operator override is a button that writes `inferenceVetoOverriddenBy` on the claim. |
| Retire an angle or plate | **Recommend only.** Retirement is a publish/status write and needs the same class of guard as any other Ad-status change. |

**Why veto but not authorize.** Authorizing spend from a model is a new spender. This codebase's money-safety discipline is atomic Mongo claims with `claimedByWorker: null` filters, `identityDigest` uniqueness, `adId: null` on test harnesses, Ad-write guards. An LLM that can insert a Loop 2 claim is a spender that bypasses every one of those unless we rebuild them around a verdict document — which is a larger design than this layer. A veto is a **narrow additional predicate** on a fire that already passed the mechanical gate: `mechanicalWouldFire && !validVeto`. It fails closed (invalid verdict → no veto → mechanical proceeds). That is the same shape as `TITLE_FACE_KEEPOUT=false → null → bands stay avoid:false`.

**Why not "recommend only, no veto."** Then the layer cannot do the one money-saving job it has (stop a $1.80 fire when the unused angle on this plate has never been tried). Without veto it is a Slack comment. With veto it is a guard. Guards fail closed; comments do not need to.

**Implementation guard, consistent with existing spenders:**

- Verdict persists as its own document (`CreativeInferenceVerdict`) with `brandId`, `productId`, `payloadHash`, `schemaVersion`, `costLogId`.
- The Loop 2 claim path (when auto ships) reads the latest **valid** verdict for that `identityDigest` inside the same Mongo transaction as the claim. Predicate: `claimedByWorker: null` AND `mechanical.loop2WouldFire` AND NOT (`vetoMechanicalLoop2` AND `confidence ≥ 0.7` AND schema-valid AND `payloadHash` matches the rollup just computed).
- Shadow mode writes the verdict and **does not** evaluate the veto predicate. Same as the fatigue detector.
- `adId: null` in any harness that builds a fake verdict. A verdict with a real `adId` in a test is how you spend.
- The LLM does not hold the Atlas key for Omni. The fire path does.

## 2B.5 How it is evaluated

Ship **shadow-first**, same sequence as the fatigue detector: instrument → shadow (verdict written, not consulted) → auto (veto predicate on).

A good verdict, scored weekly against operator action and against the next window's metrics:

| Check | Pass |
|---|---|
| Schema | `validateInferenceVerdict` returns ok; `numbersCited` all resolve |
| Agreement with operator (shadow) | When an operator fires Loop 1 / Loop 2 / hold from the button, the shadow verdict's `recommendation` matches ≥70% over a rolling 30 days, **once N ≥ 20** (same min-N posture as `QC_INSIGHTS_*` min N=20) |
| Veto precision (auto, after shadow) | Of vetoes that an operator did **not** override, the next 14-day window does not beat the brand p50 by enough that the fire would have been right. Track override-rate; if overrides >30% over 20 vetoes, disable auto-veto (`INFERENCE_VETO_ENABLED=false`) without taking the verdicts down |
| Drift | `whatWorked` / `whatToTry` embeddings (cheap, local) vs the previous 4 weeks for the same brand — a sudden collapse to generic ("try a stronger CTA") is a drift page, posted internally, not a silent degrade |
| Cost | `CostLog.stage='creative_inference'` stays in the cents/month envelope of §2A.5. A spike is the watchdog's problem, not a new one |

Precedent: `judgeService.js` already returns a **structured rubric with numeric scores and a winner constrained to the non-rejected set** (`:11–52`). `aiCreativeDirectorService` already salvages JSON and re-asks once. Do not invent a new judge personality. Reuse `chatCompletion` + `json_object` (Claude cannot `json_schema`) + salvage + one re-ask + `CostLog`.

`qcInsightsService.js` is the other precedent (nightly, min N, proposals dark by default). Inference is closer to that cadence than to per-ad vision QC. Do not run it per Generate.

## 2B.6 Cost (2A table form)

Already N3: `anthropic/claude-sonnet-5`, ~$0.032/call, weekly per (brand, product) with new rows, **$0 on Generate**, ~$0.13/month at the stated volume. Shadow doubles nothing (one call, unused). Auto adds no call.

Do not run opus-5 on this. Do not attach frames. Do not chain a second "write the Slack post" call.

---

# 2C. Slack — internal tool vs customer channel

Two audiences. They do not share a bot, a channel, a message builder, or a data class.

## 2C.1 What already exists (internal only)

All Slack traffic is **one workspace bot**. Token `SLACK_BOT_TOKEN` is the only secret (Render / `.env`, not committed). Channel IDs are committed and non-secret. **There is no per-tenant Slack destination anywhere.** Exhaustive: `Brand.js`, `User.js`, `Advertiser.js`, `SystemConfig.js` have no Slack field. `CampaignRun.slackFeed` / `OperationRun.slackFeed` store **our** `ts`/`channel`, not a tenant destination. Frontend "Slack" is layout-engine whitespace or operator-parity copy.

This is a security-relevant finding. Every brand's name, spend, and failure already lands in the same three operator channels.

| Var | Default | File:line | Purpose |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | not committed | backend `defaults.env:1414–1416`; adgen `:1606–1608` | Bot User OAuth (`xoxb-`) |
| `SLACK_ALERT_CHANNEL` | `C0BMMDA3MFE` | backend `:1427`; adgen `:1619` | `#rs-alerts` — warn/error/info |
| `SLACK_ALERT_CHANNEL_FATAL` | `C0BM2BG6M71` | backend `:1428–1429`; adgen `:1620–1621` | `#rs-alerts-critical` — `level:'fatal'` only |
| `SLACK_ALERT_CHANNEL_STATUS` | `C0BMMD5AN84` | backend `:1435`; adgen `:1627` | `#rs-status` — per-run live feed + `postStatus.js` |
| `SLACK_INGEST_STATUS_CHANNEL` | **blank** | backend `:1456–1480` | Ingest live status. Adgen has none. Feature **off** in prod config because channel is blank. |
| `SLACK_QC_INSIGHTS_CHANNEL` | **blank** | backend `:1673–1674` | Nightly QC-insights ping. Blank → **main alert channel**. Adgen has none. |

Inert without `SLACK_BOT_TOKEN` is a real, deliberate design property (`alertService.js:387–397`, `runFeedService.js:155–164`, `ingestStatusFeedService.js:132–141`). Preserve it. Missing token/channel → no fetch, one console warn per process, never throws. Exception: `scripts/postStatus.js:354–368` prints and **exits non-zero**.

There is **no Slack verbosity env**. `slackRunVerbosity.js` is a pure string builder. Volume control is `ALERT_MIN_LEVEL=warn`, poll-tick filter, throttles, ring drops, `ALERT_DEDUPE_WINDOW_MIN=15`, `ALERT_RATE_LIMIT_MAX=20` (info/warn), error/fatal `max(60, 3× low)`.

Threading: alerts are **unthreaded `chat.postMessage`**. Run feed is **one parent per CampaignRun** (`chat.postMessage` then throttled `chat.update`) plus a thread of events. Ingest is one in-place message per OperationRun, no thread. QC insights is a one-line warn via alertService.

## 2C.2 Internal — what to post, where, what to never post

Extend the existing services. Do not add a fourth bot. Do not invent a verbosity env; add **kinds** to the run-feed ring and **keys** to alertService, which already dedupe.

### Post these (high-value, a human might intervene)

| Event | Channel | Mechanism | Why |
|---|---|---|---|
| Loop 2 **about to fire** (manual confirm, or auto-fire 5 min out) | `#rs-alerts` as **warn**, key `loop2:pending:{identityDigest}` | `alertService.notify` | Spend. Dedupe 15 min so a retry does not page twice. Fields: brand, product, estimated USD (ledger + measured), mechanical reasons, verdict recommendation if any. **No other brand.** |
| Inference **veto** of a mechanical Loop 2 | `#rs-alerts-critical` as **warn** (not fatal — nothing is on fire), key `loop2:veto:{identityDigest}` | `alertService.notify` | This is the human-override moment. Include `vetoReason`, `confidence`, a button-shaped instruction ("override: …"). Thread a copy into the run feed if a run is live. |
| Shadow verdict **disagrees** with a mechanical would-fire | `#rs-status` **thread of that campaign's parent**, not alerts | `runFeedService` event kind `inference-shadow-disagree` | Disagreement is the shadow-mode signal. It is not an incident. Putting it on `#rs-alerts` trains people to ignore `#rs-alerts`. |
| Brand-level cap binding | `#rs-alerts` warn, key `cap:{brandId}:{day}` | `alertService.notify` | Already the shape of `watchdog:spend` (global hourly CostLog vs `ALERT_HOURLY_SPEND_USD=25`). Per-brand is the missing half. |
| Spend anomaly (hourly, existing) | keep `watchdog:spend` | already wired | Do not duplicate. |
| Director fallback-served | keep `director:fallback-served:{p}/{m}` warn | already wired | Capacity, not creative. |
| Claim anomaly | keep `claim-anomaly:{runId}` **fatal** | already wired | Money-path invariant. |

### Deliberately do not post

- Loop 1 copy mints. They cost $0.02 and there will be many. Status-thread one line on finish if you must; never an alert.
- Shadow verdicts that **agree** with mechanical. Silence is the success signal.
- Per-angle metric ticks, QC passes, layout cache misses, treatment-spec emissions, plate-scan scores.
- `vision-qc:accepted` (already dead in prod, `adVisionQcService.js:2395–2398`). Do not revive it.
- Ingest kinds not in `INGEST_STATUS_SLACK_KINDS` (`demo-sync,catalog-sync,social-ingest,enrichment`). Leave ingest off until a channel is actually set.
- Boot, clean shutdown, recovered-with-success (already muted by `ALERT_MIN_LEVEL=warn`). Keep them muted.
- Internal cost figures **on any channel a customer could be added to** — which, today, is all of them if someone Slack-Connects this workspace. Treat `#rs-alerts` / `#rs-status` / `#rs-alerts-critical` as **operator-only by policy**, and do not put customer people in them. Cost **does** belong on operator alerts for Loop 2 pending (that is the point).

Parent run-feed head already includes brand name, product, ad count, requester (`runFeedService.js:252–266`) and spend on finish (`slackRunVerbosity.js:163–187`). Keep that. Do not add model IDs or plate economics to the parent head — they belong in the Loop 2 pending alert, which is keyed and rare.

`proof-judge:unavailable` currently puts the body on `body` while `notify()` only reads `detail` (`quoteSnippetService.js:685`). Fix that when touched; do not design around a drop.

## 2C.3 Customer-facing — Slack is the wrong primary channel

**Decision: in-app + email is the primary customer channel. Slack is an opt-in sidecar a brand configures themselves, never our operator bot, never our operator channels.**

A brand wants, at most:

1. A **weekly creative digest** — which angles held, which copy won, whether a plate was retired. Cadence: weekly, not per-fire. Per-fire is our problem, not theirs.
2. A **note when a new angle wins** — one sentence, the published headline, not the internals.
3. A **note when their plate is retired for fatigue** — they will see the replacement in-app anyway; the message is courtesy.

They do **not** want: CostLog, Omni unit prices, gpt-image-2, Director fallbacks, 429s, other brands, worker names, `identityDigest`, veto confidence, model IDs.

**Why Slack is the wrong primary:**

- There is **no per-brand destination** in the schema. Building one as "invite the brand into `#rs-status`" is a multi-tenancy incident waiting for a `queued-archive-sweep` fields list (that alert already lists `brandIds`).
- Slack Connect / a shared channel still lands in *our* workspace, next to `#rs-alerts`. One mis-share, one `/invite`, one "also add the client to this thread."
- The brand installing *our* app in *their* workspace is a new OAuth product (scopes, distribution, token storage per tenant). That is a real product surface, not a flag.
- Incoming webhooks they paste into a Brand setting are the only Slack shape that keeps their workspace theirs and ours ours. Even that is opt-in.

**What to build instead, in this order:**

1. **In-app** weekly digest on the brand's existing dashboard, rendered from rollup rows + the structured verdict. Numbers from the DB. `headlineForBrand` from the verdict, or nothing. This is the primary.
2. **Email** to `Advertiser.ownerEmail` (`models/Advertiser.js:27–46` already has it). Same template as in-app. Cadence weekly. No LLM rewrite.
3. **Optional Slack sidecar**, later, behind an explicit Brand field `customerComms.slackIncomingWebhook` (HTTPS, Slack's `hooks.slack.com` host allowlist). We POST a Block Kit payload built by a **separate** `customerCommsService` that cannot import `alertService`, cannot read `CostLog`, and cannot accept a channel ID — only the webhook URL the brand pasted. Token for this path is the webhook itself, not `SLACK_BOT_TOKEN`. Inert if the field is blank — same property as today's bot.

Do not Slack-Connect. Do not reuse `SLACK_BOT_TOKEN`. Do not default `SLACK_QC_INSIGHTS_CHANNEL`-style "blank means the main alert channel" for anything customer-facing. Blank means off.

### Multi-tenancy leakage — a security boundary, not a care instruction

Enforced in code, not in the prompt to the model:

1. **Separate module.** `customerCommsService` takes a `Brand`-scoped DTO `{brandId, productName, angles:[{headline, holdRate, winner}], retiredPlate: bool, weekStart}`. It does not accept `costUsd`, `model`, `identityDigest`, `otherBrand*`, `stack`, `worker`. Type the DTO. A compile/test miss on an extra key is a red test, not a review note.
2. **Query predicate.** Every read that feeds the DTO is `{brandId: dto.brandId, …}`. Harness: seed two brands, request brand A's digest, assert brand B's product name, spend, and headlines are absent from the payload **and** from the rendered message. Pin it with `scripts/verifyCustomerCommsIsolation.js`.
3. **Webhook allowlist.** Host must be `hooks.slack.com`. No SSRF into our own Slack (`chat.postMessage` with a channel override is how a bug turns a customer send into an operator-channel leak — do not give this module `chat.postMessage` at all).
4. **Never interpolate operator channels, tokens, or CostLog into a customer template.** The writer has no handle to them.
5. **`headlineForBrand` sanitizer.** Strip `$`, `Omni`, `gpt-`, `claude-`, `CostLog`, other brand names (compare against a loaded list of `Brand.name` ≠ this brand), and any number not in the DTO. If the sanitizer mutates, drop the sentence and send the templated numbers only.
6. **No customer send from a verdict that failed `numbersCited` resolution.** Fail closed to silence.

Inference fits here as **the source of `headlineForBrand`**, not as a second writer. The weekly digest is **not** LLM-written from rollup rows. It is a template. See N7.

---

# 2D. Phase placement

Instrumentation before the thing that consumes it. Manual, then shadow, then auto. Consistent with the plan's own discipline.

| Mechanism | Phase | Why |
|---|---|---|
| Phase 0 fixes (`productName \|\| headline` swap; `Ad.publishedCopy`) | **Phase 0** | Inference (§2B.2) reads published copy. Shipping inference before `publishedCopy` diagnoses the wrong string. The backwards headline priority is already a live Meta-push bug. |
| N1 Director 4-angle contract + benefit fields | **Phase 1–2** with the angle system | Angles without copy are presets. Copy without benefits re-opens R9's dead `VIDEO_BENEFITS_PLACEMENT` flag. One round, not four. |
| N5 treatment spec + Remotion native type + N6 keep-out merge | **Phase 2–3** with Layer A | Layer A is "burned-in Remotion video title cards." That sentence is now **native type**, not gpt-image-2. Do not ship Layer A on the $0.215/video path and migrate later — the migration *is* Layer A. Keep `ADGEN_DIRECTOR_TITLE_CARDS=false` as the gpt-image-2 kill switch until native is the renderer, then delete the generator, do not default it on. |
| Layer B Meta `asset_feed_spec` | **Phase 2–3**, after N1 exists | Mixer needs multiple strings. N1 is that source. N8 filler only if a network asks for more than N1 emitted. |
| Loop 1 (N2) + operator button | **Phase 4**, manual-first | Free relative to a plate, still a copy write. Button before shadow before auto. |
| Inference (N3) **instrumentation** (payload builder, verdict schema, CostLog stage, shadow writer) | **Phase 4**, alongside Loop 1 | Needs rollup rows and `publishedCopy`. Does not need Loop 2 to exist. Shadow from day one of Phase 4. |
| Inference **veto predicate** | **Phase 5**, after shadow N≥20, **before** Loop 2 auto-fire | A veto that ships on the same day as auto Loop 2 is untested. Shadow through Phase 4, enable `INFERENCE_VETO_ENABLED` as a separate flag when Loop 2 is still manual/shadow, then auto. |
| Loop 2 fire | **Phase 5**, manual → shadow → auto | Unchanged. Auto does not ship without the veto flag having a setting (on or deliberately off), so nobody "forgets" the guard. |
| Catalog-feed copy (N4) | **Phase A/B/C** of catalog-feed distribution | Zero outbound catalog-creative write code exists today. Do not build N4 before the write path. When Meta `items_batch` ships, N4 ships with it. |
| Operator Slack: Loop 2 pending, cap-binding, veto | **Phase 4–5** with the matching mechanism | A Loop 2 pending alert with nothing that can fire is noise. Ship the alert with the manual button, not before. |
| Operator Slack: shadow disagreement | **Phase 4** with inference shadow | That *is* the shadow signal. |
| Customer in-app + email digest | **Phase 4**, once rollup rows exist, even if inference is still shadow | Template can ship with mechanical numbers only; `headlineForBrand` fills in when verdicts exist. Do not wait for auto. |
| Customer Slack webhook | **After** in-app digest has been live, as an opt-in | Not in the architecture plan's critical path. Do not invent Brand Slack fields in Phase 1. |

**Do not** put native typography in a later "nice-to-have" phase than Layer A. Layer A *is* that work. Shipping Layer A as gpt-image-2 cards at $0.215/video and then migrating is paying the line this spec exists to kill.

---

# Problems with the plan, not routed around

1. **Loop 2 "$0.90 for 2 Omni plates" collides with one 10s developer plate ≈ $0.90.** Re-measure before any auto-fire threshold is expressed in dollars. Until then use 2 × 10s master (**$1.80 / $2.40**).
2. **Benefit synthesis is not a call that exists.** Director does not emit benefits; CatalogProduct has no `shortBenefits`; R9 short-circuits. Fold benefits into N1 or the plan's title cards have nothing to typeset but a headline. Do not add `VIDEO_BENEFITS_PLACEMENT`-shaped flags that cannot call an LLM.
3. **Director does not emit `objection_resolved` or `product_first_lifestyle`.** Those are render-time `resolveIntent()` outputs (`staticAdIntents.js:647–826`). `creative_style` is a different enum (`brand_led`, `ugc_led`, `social_proof_led`, `editorial`, `promotional`). The angle system cannot "ride" Director styles without a mapping table. Build that table in Phase 1, in code, not in a prompt.
4. **`LAYOUT_DERIVATION_MODEL` does not exist.** Layout shares `GEMINI_SEARCH_MODEL` (default **pro**, $1.25/$10) with search. Two defaults, one env, two files (`layoutInputService.js:90` vs `geminiSearchProvider.js:619`). If layout volume grows with 4 angles × 3 sizes, that silent pro default becomes a real line. Split the env before Phase 2 static fanout, even if the value stays pro for now.
5. **`atlasTextService` has no CostLog.** Title-spec modify and anything else on that transport is invisible. Do not put N5 on it. N5 goes through `chatCompletion` → `trackLlmCall`.
6. **Vision QC is implemented and default-off.** Do not "turn on QC" as a side effect of Layer A. It is ~$0.01–0.03 × every ad and a separate product decision.
7. **`ADGEN_RENDERER_ENABLED` committed default is `false`; production is `true`.** Any phase that ships titling to the wrong repo ships it to a dead renderer. Native Remotion work lands in **adgen**, with backend kept in lockstep because the files are duplicated.

---

# Unverified in this writing pass

- Live Mongo `CostLog` rows were not queried. Per-call USD for G1 is the bake-off comment; G2/R1/R6/N1–N5 are token-price estimates.
- Atlas catalog was not re-fetched; prices are the 2026-09-05 prior-pass pull.
- Omni developer `$0.150 + $0.075/s` was not re-measured against a settled prediction in this pass.
- gpt-image-2 non-dev vs developer **quality** is not verified (`directImageRenderService.js:87–90`).
- Network character limits in N4 are flagged as unverified.
- Treatment-spec token sizes are estimates against a schema that is not in the repo yet.
- That face+DINO+plateIntel+safeZones is *sufficient* keep-out for native type is an architectural judgment from those services' contracts, not a live render A/B on Pelagic/Gymshark plates.
- `directorTitleCardGenerate.js` model default is at **line 86** in current adgen, not 127 (the line moved; the claim is the same).

---

# Sources

| What | URL / file |
|---|---|
| Atlas live catalog | `GET https://api.atlascloud.ai/api/v1/models` (UA Mozilla/5.0), 2026-09-05, 467 models |
| Atlas public prices | https://www.atlascloud.ai/pricing/models |
| Local snapshot (prefer live) | `/Volumes/Sayulita/Projects/RS/claude-org-brain/scout/atlas-catalog-snapshot.json` |
| Atlas skill (stale LLM table) | `/Users/nicksheth/.agents/skills/atlas-cloud/SKILL.md` |
| OpenAI | https://developers.openai.com/api/docs/pricing |
| Anthropic | https://platform.claude.com/docs/en/about-claude/pricing |
| Gemini | https://ai.google.dev/gemini-api/docs/pricing |
| RS rates | `liquidretail_backend/services/costTracker.js` `MODEL_RATES` |
| RS routing | `liquidretail_backend/services/atlasModelMap.js` |
| Video formula | `liquidretail_backend/services/atlasVideoService.js:445–463, 561–572` |
| gpt-image-2 measured | `liquidretail_backend/services/directImageRenderService.js:80–96` |
| Title-card model | `liquidretail_adgen/src/services/directorTitleCardGenerate.js:86` |
| $0.04 lifestyle (not title cards) | `catalogProductLifestyleImageService.js:27` `PER_UNIT_ESTIMATE_USD = 0.04` |
| Face keep-out in titling | `liquidretail_backend/services/brandScriptExecutor.js:2211` |
| Face consensus (pure) | `liquidretail_backend/services/faceSafeCrop.js` |
| DINO overlay (no LLM) | `liquidretail_backend/services/dinoOverlayZoneService.js:1–45` |
| Font ingest / resolve / load | `brandFontIngestService.js:872`, `fontResolverService.js:1–26`, `FontLoader.jsx:66` |
| Slack inventory | backend/adgen `config/defaults.env` + `alertService.js` / `runFeedService.js` / `ingestStatusFeedService.js` / `qcInsightsService.js` / `slackRunVerbosity.js` |
| Duration default | both repos `META_VIDEO_DURATION_SEC=10` |
