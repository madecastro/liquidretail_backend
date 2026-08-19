# On-site review capture — vendor reference

Everything we know about reading customer reviews off a client's storefront.
This is the reference behind `services/reviewAdapters/`,
`services/productReviewsScrapeService.js` and `services/reviewHeadlessCapture.js`;
each adapter file repeats only the part that governs its own code.

Written down because it is expensive knowledge: most of it came from reading a
live storefront's JS, not from vendor documentation, and it is not rediscoverable
from the code alone once a vendor changes a key name.

**Everything marked VERIFIED was proven against a live storefront on the date
given, with a real HTTP response.** Anything not verified says so. Do not
promote a guess to a verified line — the whole value of this file is that the
verified rows can be trusted without re-probing.

---

## 1. Why three tiers

A store's review app publishes only a fraction of its reviews as schema.org
data for Google's rich snippets. Measured on real PDPs:

| Store | App | Reviews in JSON-LD | Reviews actually held |
|---|---|---|---|
| livingspaces.com | Bazaarvoice | ~6 | 156 |
| beardbrand.com | Judge.me | ~2 | 81 |
| blendjet.com | Loox | 0 | 13+ |
| gap.com | PowerReviews | 0 in a script tag (see §5) | 2,741 |

So capture runs in three tiers, and results are **merged**, not replaced —
a later tier adds reviews and never discards a rating an earlier tier proved.

| Tier | Mechanism | Cost | Coverage |
|---|---|---|---|
| 1 | schema.org / JSON-LD already in the served HTML | 1 GET | aggregate rating almost always; a handful of review bodies |
| 2 | the vendor's own public widget JSON API, paginated | 1 GET + N | the full review set |
| 3 | headless browser: intercept the widget's XHR, else read the rendered DOM | a browser | the only route for Loox and for widgets with no reachable key |

Tier 3 is **off by default** (`PRODUCT_REVIEWS_HEADLESS`) — a real browser per
product is orders of magnitude more expensive than a GET.

---

## 2. Adapter table

All nine verified live on **2026-07-27**. `pageSize` is what we ask for, chosen
against the server's real behaviour, not the documented limit.

| Platform | Endpoint | Credential in page HTML | Paging model | pageSize | Over-cap behaviour |
|---|---|---|---|---|---|
| **bazaarvoice** | `api.bazaarvoice.com/data/reviews.json` | display passkey, **3 hops** (§4) | `Offset` = 0-indexed **record** offset | 100 | HTTP **200** with `Errors[]` |
| **judge.me** | `judge.me/reviews/reviews_for_widget` | shop domain + Shopify product id | `page`, **1-indexed** (no page 0) | 30 | silently clamped |
| **yotpo** | `api-cdn.yotpo.com/v1/widget/<app_key>/products/<pid>/reviews.json` | widget app key (**not** the loyalty key) | `page`, 1-indexed (page 0 → 1) | 100 | silently clamped at 150 |
| **okendo** | `api.okendo.io/v1/stores/<subscriberId>/…` | subscriber GUID; product id needs the **`shopify-` prefix** | opaque cursor — replay the server's `nextUrl` **verbatim** | 100 | real ceiling is 100, not the documented 25 |
| **stamped** | `stamped.io/api/widget/reviews` | store hash + public key | `page`, 1-indexed | 100 | silently clamped |
| **reviews.io** | `api.reviews.io/product/reviews` | store id | `page`, **0-INDEXED** — the odd one out | 50 | — |
| **powerreviews** | `display.powerreviews.com/m/<merchant>/l/<locale>/product/<page_id>/reviews` | 3 possible key shapes (§5) | `from` = 0-indexed **record** offset | 25 | **HTTP 200** with `status_code:400` in the body |
| **junip** | `apid.juniphq.com/v2/products/remote/<id>/reviews` | public store key, header `Junip-Store-Key` | opaque cursor `meta.after`; **no total, no page count** | 50 | **hard HTTP 400** at 51 |
| **fera** | `cdn.fera.ai/api/v3/public/products/<id>/reviews` | public key | `page`, 1-indexed | 100 | silently clamped |

### Three traps this table encodes

1. **Paging is not a paging model, it is four paging models.** Record offsets
   (Bazaarvoice, PowerReviews), 1-indexed pages (Judge.me, Yotpo, Stamped,
   Fera), 0-indexed pages (REVIEWS.io), opaque cursors (Okendo, Junip). The
   driver in `reviewAdapters/index.js` is always 0-based and each adapter
   converts; getting this wrong re-reads page 1 forever, which is why the
   driver also stops on `'no new reviews'`.
2. **Failure arrives inside HTTP 200.** Bazaarvoice answers an over-cap `Limit`
   with 200 and `{"Errors":[{"Code":"ERROR_PARAM_INVALID_LIMIT"}],"Results":[]}`;
   PowerReviews puts `status_code:400` in the body. A status-code check alone
   reads both as "empty last page" and stops silently one page in. Adapters
   return `{error}` for these; the driver treats it as a stop, not a success.
3. **Silent clamps hide the ceiling.** Asking Yotpo for 500 gets 150 with no
   complaint, so the page count you compute from your requested size is wrong.
   Junip and PowerReviews instead throw a hard 400. Both are recorded above
   because you cannot tell which kind a vendor is without over-asking once.

### Family / variant rollup — an accuracy problem, not a paging one

Bazaarvoice (`BV_FE_FAMILY`) and Junip (product groups) return **sibling
variants' reviews under one id**. A query for the 12-piece set comes back with
reviews of the 6-piece set. We put these quotes on an ad for **one** product, so
both adapters prefer exact-id matches, fall back to the group only when nothing
matches, and set `familyRollup: true` so downstream can tell.

---

## 3. Loox — why there is no adapter

`loox.io/robots.txt` disallows `/widget` **and** `/widgets`, i.e. their review
endpoints. That is a third-party position we cannot override: a client can
authorise access to *their* storefront, but not to Loox's infrastructure on
Loox's behalf. So Loox reviews come only from:

- tier 1, the merchant page's own rich snippets, or
- tier 3, rendering the merchant page (which we *are* authorised to fetch) and
  reading what it displays. We never call `loox.io` ourselves.

This makes Loox the strictest tier-3 case, and the reason tier 3 exists at all:
BlendJet's `looxPublicStoreId` is **absent from the served HTML** and only
appears after hydration. Verified: 13 reviews, avg 4.9, ~18s, via frame-walking
DOM read.

### Vendor robots policies, checked live 2026-07-27

Recorded for the record; the runtime re-checks rather than trusting this list.

| Host | robots.txt |
|---|---|
| `api-cdn.yotpo.com` | `Disallow: /` **but** explicit `Allow:` for `/v1/widget/*`, `/products/*/*/reviews`, `/v1/star_distribution/*` — the widget reads are opened deliberately |
| `judge.me` | explicit `Allow: /api/v1`; disallows are unsubscribe/email/admin |
| `stamped.io` | only `/go` disallowed |
| `api.reviews.io` | `Disallow:` (empty) — allow all |
| `api.bazaarvoice.com` | no robots.txt (404) — nothing stated |
| `display.powerreviews.com` | no robots.txt (404) — nothing stated |
| `api.okendo.io` | robots.txt 403s — nothing stated |
| **`loox.io`** | **`Disallow: /widget`, `/widgets`** — off-limits, see above |

Storefront robots gating is **off by default** system-wide
(`services/httpScrapeClient.respectsRobots()`): this platform scrapes with
client authorisation, and the client warrants the rights to the content used in
their ads. `RESPECT_ROBOTS=true` restores it globally,
`REVIEW_RESPECT_ROBOTS=true` for reviews only. Throttling and `Crawl-delay` are
**kept regardless** — being permissioned is not a licence to hammer a host.

---

## 4. Bazaarvoice: the display passkey is three hops deep

The passkey is never in the PDP. Getting it:

```
PDP HTML                → BV client name + deployment zone
apps.bazaarvoice.com/deployments/<client>/…/bv.js   → legacyScoutUrl
<legacyScoutUrl>/bvapi.js                          → apiconfig: { passkey }
```

Cached at module scope (`PASSKEY_CACHE`) — it is per-client, not per-product, so
a 9,000-product catalog does this once.

---

## 5. PowerReviews: two separate traps, both found on gap.com

**Trap 1 — three key shapes.** The credentials appear as `prMerchantId`/
`prApiKey`, or as a `POWERREVIEWS.display.render({...})` call, or — on Gap — as
`powerReviewsConfig: { groupId, merchantId, apiKey }`. `groupId` is **not**
`merchantId`: using it returns `401 "api key is invalid for this merchant"`.

**Trap 2 — reviews are filed under a different id than the page's own.** Gap's
PDP `pid` is 9 digits (`130046042`, style + colour). Reviews are filed under the
6-digit **style** (`130046`) — the pid minus a 3-character suffix. Not the
13-digit sku either.

That second trap is why `services/reviewSiteProfiles.json` exists: deriving the
id needs a probe of up to 5 candidate ids (`MAX_TRIM=4`), and over 9,143 Gap
products that is ~45,000 requests. Learning the answer once (`idSource:
"productID"`, `idTrim: 3`) reduces it to ~9,000 — one probe per product.

**Also on gap.com — the RSC blind spot.** Gap is Next.js App Router, so the
`<script type="application/ld+json">` tag is serialised **into the React flight
payload as a doubly-escaped string**. There is no script tag to scan, and a
script-tag scanner returns `null` on a page that in fact publishes
`4.48 / 2741`. `extractEmbeddedLdBlocks()` + `matchBrace()` recover it.
Related and separate: JSON-LD inside `<script>` is a *raw-text element*, so the
HTML parser never decodes entities — a site that escapes its JSON-LD leaks
`&quot;`/`&#x2B;` straight through `JSON.parse`, which is the original `33"`
bug (`utils/htmlEntities.js`).

---

## 6. Learned site profiles

`services/reviewSiteProfileService.js` — memory → Mongo (`ReviewSiteProfile`) →
checked-in `services/reviewSiteProfiles.json`. DB first, file fallback, mirroring
`systemConfigService`. Fields: `platform`, `idSource`, `idTrim`, `ldSource`,
`hints`, `reviewsSeen`, `learnedFrom`.

Seeded with gap, ulta, livingspaces, deathwishcoffee, drsquatch. **The seed file
holds verified entries only.** The runtime writes what it learns to Mongo; when a
learned profile proves stable, promote it into the JSON so it survives a database
reset and is reviewable in a PR.

---

## 7. Review text is stored verbatim

Adapters call `reviewText()` / `reviewHtmlText()`
(`services/reviewAdapters/helpers.js`), never a positional cut:

- A body over `REVIEW_TEXT_MAX` (1200, env `REVIEW_TEXT_MAX_CHARS`) is shortened
  by dropping **whole sentences** — the least useful ones, ranked by
  `utils/reviewText.scoreSentence`, re-emitted in the reviewer's original order.
  Never mid-sentence, never an added ellipsis, never rewritten.
- **Leftover budget is never padded.** If one sentence is all that clears the
  bar, that is the whole stored quote. Storage length is an upper bound, not a
  target.
- Titles and authors still use the word-boundary `text()` cut, where a clipped
  label is harmless. DOM-path authors are deliberately `null`: the heuristic
  returned product variant names ("Match Point", "Lavender") often enough to be
  worse than nothing.

400 was the original cap and was measured too tight — 10 of 50 Ulta reviews and
1 of 50 Living Spaces reviews were being cut mid-word.

### Provenance

Every stored quote carries where it came from, so a consumer can tell a
quotable customer review from generated copy without guessing:

| Field | Values |
|---|---|
| `origin` | `scraped` — the customer's own words; `llm-web` — an LLM's summary of web sources; `synthesized` — derived from our own review summary |
| `verbatim` | `true` only for `scraped` |
| `scope` | `product` \| `brand` \| `category` |

`productReviews.quotesOrigin` records the same at snapshot level, and the LLM
cache write in `productMatchService` is filtered so it can **never** overwrite a
scraped snapshot.

---

## 8. Caps

Blast-radius control: a 10k-product catalog × unbounded pagination is a
six-figure request count. Reviews exist to surface a handful of positive quotes
and an honest rating distribution, not to mirror a vendor's database.

| Env | Default | Meaning |
|---|---|---|
| `REVIEW_ADAPTER_MAX_PAGES` | 5 | pages per product |
| `REVIEW_ADAPTER_MAX_REVIEWS` | 100 | reviews per product |
| `REVIEW_ADAPTER_TIMEOUT_MS` | 12000 | per request |
| `REVIEW_ADAPTERS_ENABLED` | on | master switch — tier 2 is additive, so a bad vendor day should be one env var away from off |
| `PRODUCT_REVIEWS_HEADLESS` | off | tier 3 |
| `REVIEW_TEXT_MAX_CHARS` | 1200 | stored body bound |

---

## 9. Adding an adapter

The contract is in the header of `services/reviewAdapters/index.js`:
`discover` (may be async), `request(ctx, zeroBasedPage)`, `parse`, `normalize`,
optional async `aggregate`.

The order that actually works:

1. Open a real PDP for the vendor in a browser. Find the widget's XHR in the
   network panel — **that** is the endpoint, not whatever the vendor's developer
   docs describe. (Junip's documented API, `api.juniphq.com/v1`, is Premium-gated
   and needs an account key; the widget calls `apid.juniphq.com/v2` with the
   public store key sitting in the page markup, which is why it works for every
   merchant regardless of plan.)
2. Find the credential in the served HTML — `view-source`, not the inspector, so
   you learn whether it survives without JS. If it does not, this vendor is a
   tier-3 case.
3. Over-ask on page size once, to learn silent-clamp vs hard-400.
4. Check whether the *first* page's aggregate is present. If not, implement
   `aggregate()` rather than summing what you fetched — a mean over 100 of 8,278
   reviews is not the product's rating.
5. Ask for page 2 and confirm the rows differ. If they do not, the paging param
   is wrong.
6. Verify against a live store and record the store, product id and review count
   in the adapter header, the way the existing nine do.

`discover()` returning `null` is the normal answer for 8 of 9 adapters on any
page, so the driver tries them all: platform detection is a keyword sniff over
HTML and gets it wrong both ways — a store can carry markers for three apps it
once trialled.

### Shopify's own Product Reviews app

Not implemented, deliberately: removed 2023-09-05, backend shut down
2024-05-06, `productreviews.shopifyapps.com` no longer answers TLS. It was never
a paginated JSON API — Liquid-rendered metafield HTML plus Shopify's generic
`?page=`.

---

## 10. Server-side rating filters, and documented rate limits

We surface *positive* quotes, so under a rate limit the remaining request budget
is better spent on reviews we can actually use — 1-3 star reviews get fetched,
stored, and then never chosen. Checked per vendor, 2026-07-27, against primary
sources:

| Platform | `>=4 stars` server-side? | Syntax | Documented rate limit |
|---|---|---|---|
| **bazaarvoice** | **YES — one request** | `Filter=Rating:gte:4`, AND-ed with the mandatory `Filter=ProductId:<id>` | per-key QPM, no published default; `X-Bazaarvoice-QPM-Allotted`/`-Current` headers, 429 on breach |
| yotpo | exact star only | `star=4` then `star=5` — **two** requests | 30,000 req/min per IP |
| reviews.io | documented on *sibling* paths only | `minRating=4` on `/product/review` (deprecated) and `/reviews`, **not** on the `/product/reviews` we call | not documented |
| judge.me | no | — | not documented |
| okendo | no — `orderBy` sorts, it does not filter | — | not documented |
| stamped | no (the `?r=4` that exists belongs to the HTML full-page widget, a different surface) | — | not documented |
| powerreviews | no — `sort` only, per the official OpenAPI spec | — | **1,800 calls / 5 min per IP, then a 5-minute block** |
| junip | no — undocumented internal widget endpoint | — | not documented |
| fera | no — documented params are paging/`verified`/`sort_by` | — | not documented |

**Only Bazaarvoice opts in** (`supportsMinRating: true`). Yotpo's enumeration
costs two requests per page, which saves nothing at the moment requests became
scarce; REVIEWS.io's `minRating` is unverified *for the path we actually call*,
and a param the server does not recognise either silently returns unfiltered
data (pointless) or 400s (breaks the adapter). Six have no filter at all.

Sources: `developers.bazaarvoice.com` (Conversations API display fundamentals,
rate-limit page), `apidocs.yotpo.com` (retrieve-reviews-for-a-product),
`developer.reviews.io`, `docs.okendo.io` (storefront REST API),
`github.com/powerreviews/api-documentation` (`readservices.yaml`),
`help.powerreviews.com`, `developers.fera.ai`.

### How the driver uses it

`reviewAdapters/index.js`, `collectFromAdapter`:

1. Normal sweep is **unfiltered** — that is what gives an honest rating
   distribution.
2. On a 429, if the adapter declares `supportsMinRating`, escalate **once** to
   `REVIEW_MIN_RATING_ON_THROTTLE` (default 4) and **retry the same page**
   rather than stopping.
3. A caller may pass `minRating` to filter from page 0 (for a host already
   known to throttle).
4. `result.ratingFiltered` records the floor, so a consumer knows the captured
   set is not a representative sample.

**The aggregate is never read from a filtered response.** Bazaarvoice has a
separate `FilteredStats` concept and whether plain `Stats=Reviews` stays
whole-product under a `Rating` filter is documented ambiguously; Yotpo's
`bottomline` behaviour under `star=` is undocumented. Rather than depend on
reading that right, `total`/`average`/`distribution` are only ever taken from an
unfiltered page — storing "4.9 from 83" for a product that really holds
"3.8 from 156" is a worse error than storing no rating. Tier 1 (JSON-LD) usually
supplies the true aggregate anyway.

Adapters that cannot filter are **not** silently client-side filtered: the ask
is to filter *before* fetching, and pretending otherwise would hide that the
request cost was paid regardless.

---

## 11. Where inference is (and is not) used on review text

**The capture engine uses no LLM at all.** Tiers 1-3, all nine adapters,
platform detection, id derivation, sentence selection and shortening are regex,
JSON parsing and a deterministic heuristic. That is deliberate, and it is a cost
decision, not an accident:

> Shortening runs on **every stored review** — up to 100 reviews × ~10k products
> per catalog sweep is ~10⁶ calls. Even at flash-tier pricing that is a
> recurring five-figure spend to do something a ranking heuristic
> (`utils/reviewText.scoreSentence`, ~30 lines) does deterministically, for
> free, with no latency, and — importantly — **without the ability to reword a
> customer's sentence**, which is the one thing we must not do here.

Inference is used **once per ad**, not once per review, and only where judgement
genuinely beats a heuristic:

| Call site | Task | Volume | Model |
|---|---|---|---|
| `quoteSnippetService` | pull a ≤50-char extractive phrase out of the winning quote for a video overlay | per ad, only when the quote exceeds 50 chars | **`review-text` role** |
| `layoutInputService` derivation | writes ad copy with review quotes/rating as one input among many | per (media × template × ratio), cached on `LayoutInputArtifact` | `gemini-2.5-pro` |
| `categoryReviewsService` | grounded search → category-level review narrative | per (brand, category), cached 30 days | `gemini-2.5-flash` |
| `geminiSearchProvider.lookup{Brand,Product}Reviews` | grounded web search when the free scrape found **nothing** | gap-fill only, capped `CATALOG_ENRICHMENT_MAX_PER_RUN` (500), cached 30 days | `gemini-2.5-flash` |
| `productDetailsService.fetchReviewSummary` | narrative review summary | user-actuated "Enrich" only (~$0.05-0.12/product) | `gemini-2.5-flash` |

#### What a grounded review lookup actually costs — and where it lands

`lookup{Brand,Product}Reviews` are **two** billable POSTs each, not one: a grounded
`google_search` pass, then a plain JSON-structuring pass. Both now ledger to
**`CostLog`** under `stage: 'brand_reviews' | 'product_reviews'`, split by
`purposeTag: 'grounded_search' | 'json_structure'` — see
`scripts/verifyGeminiSearchCost.js`. Until 2026-08-03 they were the only
review-path LLM calls with **no cost tracking at all**, because they hit the raw
`generativelanguage` REST endpoint rather than `atlasLlmService`.

**Grounding dominates the bill, and it is not a token cost.** Google charges
Search grounding *per prompt* on 2.5 models — $35/1,000 after a free 1,500/day —
so one lookup is roughly:

| component | cost |
|---|---|
| grounded pass tokens (~1.5k out) | ~$0.004 |
| **grounding surcharge** (inside free allowance) | **$0.000** |
| structuring pass tokens | ~$0.001 |
| **total per lookup** | **~$0.005** |

**REVISED 2026-08-19 — the surcharge now defaults to $0, and that is the accurate
figure, not a disabled feature.** The table previously read $0.035 / ~$0.040 per
lookup on the reasoning that token math alone understates a grounded call ~10x.
The arithmetic was right; the premise was not. Google's **1,500 grounded
prompts/day allowance applies to the paid tier too** (re-read live 2026-08-19:
"1,500 RPD (free, limit shared with Flash-Lite RPD), then $35 / 1,000 grounded
prompts"), and measured volume is **13-19 grounded requests/day — about 1% of
it**. Every grounded call we have made was free; the ledger was claiming $1.12
over a 7-day window, which was **89.9% of all direct-Gemini spend it recorded**.

This one could not self-correct, which is why it survived: grounded calls are
pinned to `provider:'gemini'` (Atlas cannot proxy Google Search grounding at all
— probed in #229), and `scripts/reconcileAtlasDailyCosts.js` matches
`provider:'atlas'` only. Atlas's bill cannot contain a call that never touched
its meter, so no reconciliation this repo has had could ever see these rows.

The surcharge is `costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD`. Set
`GEMINI_GROUNDING_COST_USD=0.035` **if daily volume ever exhausts the
allowance** — `costTracker` alerts when a process sees more than half of
`GEMINI_GROUNDING_FREE_RPD` (1,500) in a UTC day, so that crossing is announced
rather than discovered in a bill. Two approximations remain deliberate and are
documented at that constant: the surcharge is *declared* (the tool was enabled)
rather than *confirmed* from `groundingMetadata`, and per-prompt billing is a
**2.5-era rule** — Gemini 3 bills per executed search query, so a model bump
changes the unit.

**UPDATED 2026-08-19.** `geminiSearchProvider.match` is now ledgered (routed
through the same `trackedGenerate` helper as brand/product reviews pass 1,
stage `gemini_product_match`) — it was billing Google on every UGC/IG detect
with a key and writing nothing to CostLog. `.lookupBrandCategoryUrl` is
DELETED, not ledgered — confirmed dead (its only caller had zero call sites
of its own; category breadcrumbs go through `productCategory.
enrichProductCategory` instead). Also in this pass: `lookupBrandReviews` /
`lookupProductReviews` pass 2 (the JSON-structuring half, never grounded) now
routes through Atlas (`atlasLlmService.chatCompletion`, model
`google/gemini-2.5-flash`) instead of this raw endpoint — pass 1 (the grounded
half) stays here; see the ATLAS GROUNDING PROBE comment in
`geminiSearchProvider.js` for the live-tested proof that Atlas cannot ground.

**Still unledgered on this path (known gap, NOT fixed here — same shape as
the `match` fix above, and a reasonable next pickup):**
`categoryReviewsService` and `productDetailsService.fetchReviewSummary` both
still POST the raw endpoint directly with no `trackLlmCall` and no
`maxRedirects: 0`. Both are genuinely grounded (`tools: [{google_search:{}}]`),
so — like `match` — the fix is "wrap in a ledgered transport", not "move to
Atlas": grounding still is not available there. Confirmed LIVE and
unledgered by a 2026-08-19 trace (`categoryReviewsService` reachable from
UGC/IG detect on a category-reviews cache miss; `productDetailsService.
fetchReviewSummary` reachable from UGC product_match and user-triggered
Enrich, gated on `SERPAPI_API_KEY` being configured for the sibling shopping
lookup, not on this call itself).

### The `review-text` role — chosen by measurement

Added to `services/atlasModelMap.js` so review-text model choice lives in **one**
place and moves with one env var (`ATLAS_MODEL_REVIEW_TEXT`).

Benchmarked live 2026-07-27: 6 real multi-sentence reviews per model, through the
**actual** `quoteSnippetService` prompt and strict schema, at the real
`max_tokens` the wrapper sends (60 + 768 reserve).

| Model | hard fails | off-product | non-verbatim | $/call | latency | reasoning tok |
|---|---|---|---|---|---|---|
| **`google/gemini-2.5-flash-lite`** ← chosen | 0 | 0 | 0 | **$0.000012** | **851 ms** | 0 |
| `openai/gpt-5.6-luna` (previous) | 0 | 0 | 0 | $0.000195 | 1245 ms | 0 |
| `bytedance/doubao-seed-1.6-flash-250828` | 0 | 0 | 0 | $0.000406 | 15526 ms | up to **5735** |
| `anthropic/claude-haiku-4.5-20251001` | 1 | 0 | **5 of 6** | $0.000124 | 1223 ms | 0 |
| `openai/gpt-5-nano` | — | — | — | HTTP 400 **router not found** | — | — |
| `qwen/qwen3.5-flash` | — | — | — | HTTP 400 on strict `json_schema` | — | — |

**16x cheaper and faster than what it replaces, with identical correctness.**

Three findings worth keeping:

1. **Headline price is the wrong metric — "does it think" dominates.** The
   cheapest-looking slugs are *reasoning* models, and hidden reasoning tokens
   bill as output. `doubao-1.6-flash` is nominally 20x cheaper per output token
   than luna but spent up to 5,735 reasoning tokens on a one-sentence
   extraction, making it **2x more expensive in practice and 12x slower** — and
   over the 828-token budget, which returns an empty message and silently
   degrades to mechanical truncation. `gemini-2.5-flash-lite` spends **zero**
   and emits ~20.
2. **A catalog listing is not a router.** `openai/gpt-5-nano` is listed with a
   price and 400s with "router not found" — exactly the trap `docs/ATLAS.md`
   warns about. Probe before trusting.
3. **`claude-haiku-4.5` is disqualified on correctness, not cost:** it returned
   non-verbatim text for 5 of 6 reviews. For a customer quote that is a
   fabrication, not a style difference.

Kimi and GLM were checked and are not competitive at this tier
(`moonshotai/kimi-k2.5` $0.49/$2.50); `deepseek-ai/deepseek-v4-flash`
($0.14/$0.28) is the cheapest credible DeepSeek but was not needed once
flash-lite won on both axes. `deepseek-ai/deepseek-ocr` is nominally cheapest at
$0.04/$0.08 and was rejected: 8k context, placeholder profile text, and inverted
pricing fields — an OCR model mislabelled generically.

All benchmarked rates are loaded into `costTracker.MODEL_RATES`, so switching via
`ATLAS_MODEL_REVIEW_TEXT` shows up in the ledger instead of logging $0.

---

## 12. Selecting for conversion, not for enthusiasm

These quotes go on ads, so the ranking question is not "is this a good review"
but "does this move a browser to buy". Those differ more than expected.

**The bug that made this concrete.** Given a real 3-sentence review — *"Ordered
this on the 3rd and it arrived Tuesday. Still looks brand new after eight months
of daily use and two cats. Customer service never answered my email."* — **every
model tested, including the one in production, returned "Customer service never
answered my email." as the sharpest phrase for the ad overlay.** It is vivid and
it is verbatim, so the extractive check passed it straight through onto the
creative.

Two fixes, both in place:

1. **Deterministic preselection before the model.** `quoteSnippetService`
   `strongestSentence()` narrows the input to the single highest-scoring sentence
   first, so a service complaint is never a candidate. This removed the failure
   on every review in the sample, **and** halved cost and latency, **and** cut
   reasoning-token spend by an order of magnitude (a whole-review call was
   observed at 2,422 tokens against an 828 budget).
2. **Conversion weighting in the ranker** (`utils/reviewText.scoreSentence`),
   used by both the storage path and the overlay path:

| Signal | Δ | Why |
|---|---|---|
| Risk reversal — a worry named and resolved ("fits true to size", "worth every penny") | **+6** | Most non-purchases are one specific unresolved doubt. Resolving it removes the actual blocker. |
| Repeat purchase ("third one I've bought") | +5 | Revealed preference; survives scrutiny in a way praise does not. |
| Fit / sizing language | +3 | The most common unresolved objection in apparel and footwear. |
| Stated outcome ("back pain gone after two weeks") | +4 | Concrete benefit rather than an adjective. |
| Duration of use | +3 | De-risks the spend. |
| **Generic praise** ("Great product", "I love it!") | **−5** | Scores high on sentiment, carries zero information, and would otherwise win ties. On an ad it is a wasted impression. |
| Shipping / delivery / service | −6 | Describes the retailer, not the product. |

Resulting order on a real sample — note generic praise is now *negative*:

```
 15  "It fits true to size and I am normally between a medium and large."
 11  "Awesome shirt with awesome fit"
  7  "Still looks brand new after eight months of daily use."
  5  "My back pain is gone after two weeks."
 -2  "Delivery took nine days and the courier left it in the rain."
 -4  "I absolutely love it!"
 -8  "Great product"
```

**Short is not disqualifying.** A quote already within the 50-char overlay budget
is used as-is — no model call, no minimum length, no padding. "Awesome shirt with
awesome fit" is a better overlay than a trimmed generic rave, which is why FIT
carries a bonus that offsets the short-length penalty.

### The same objective downstream

`aiCreativeDirectorService` carries an explicit `OBJECTIVE_BLOCK` (shared verbatim
by both the V1 and round prompts) stating that this is direct-response work and
ranking what converts: remove an objection → specific checkable claim → proof at
scale → one clear CTA. It also forbids building a concept around
shipping/packaging/service.

`aiJudgeService` gained a matching **`conversion_strength`** axis. Without it the
Judge's five axes all measured *coherence* — fit to signal, brand, media, proof,
peers — so a concept could score 10 everywhere and still be an ad nobody buys
from, and the Director's conversion work would be ranked away in favour of the
most coherent concept. Adding an axis is a one-line change because the response
schema, per-axis average and 0-1 normalisation all derive from `CONCEPT_AXES`.

Neither change relaxes the honesty rule: an unsupported claim converts once and
costs the client afterwards.

---

## 13. A grounded quote must END, and a refresh must not erase the numbers

Two live defects on 2026-08-11, both on the `llm-web` path, both fixed in code
rather than in prompt text.

### 13.1 Sentence completeness

The first post-deploy Pelagic Gear enrichment returned:

> Love these new T's. These new T's Pelagic has are so freaking soft. Here in San
> Diego, we've had screaming high temps the last few weeks and these have been
> keeping me cool in my

It ends mid-clause on a preposition, and it passed `keepVerbatimQuotes` because it
genuinely **is** a substring of the grounded narrative. The retrieval directive's
"must read as complete on its own" is prose an LLM may ignore, so the guarantee
moved into code: `completeSentencesOnly` (`services/providers/geminiSearchProvider.js`)
trims back to the last sentence stop **the reviewer themself wrote**, or drops the
quote.

**Selection, not repair.** It is built on `completeSentencePrefix`
(`utils/htmlEntities.js`), whose result is always a literal prefix of the trimmed
input — `String(s).trim().startsWith(completeSentencePrefix(s, n))` always holds —
so the kept text is still verbatim. Nothing is added, reordered, or invented.

Two non-obvious traps, both found by adversarial review before ship and both pinned
by `scripts/verifyQuoteRetrievalDirective.js` §H:

- **An abbreviation is not a sentence end.** `splitSentences` disambiguates by
  requiring a capital after the stop, which is right for "5.5 in. wide" and wrong
  whenever the next word is a proper noun: "Absolutely love Dr. Bronners products
  and the scent is" would become **"Absolutely love Dr."**. `NOT_A_SENTENCE_END`
  rejects titles, initials and common abbreviations, deliberately case-sensitively
  (with `/i`, "The answer is no." reads as the abbreviation `No.`).
- **A trim can invert the sentiment.** "I hated the old ones. These are great and
  soft" trims to a complete, verbatim, fabricated **negative** endorsement. The kept
  span is therefore re-judged with `layoutInputService.hasPositiveSignal` — the
  render path's own gate, reused so the two cannot drift — and dropped if it no
  longer reads as positive. The full quote was never judged as this shorter string.

Applies to all three lookups: brand, product, and (since this change) category,
which previously carried its own substring-only copy.

**Retrieval completeness is not sufficient on its own**, because the last cut
happens at render. `selectStaticQuoteText` (`services/directImageRenderService.js`)
used to fall straight through to the ≤50-char curated snippet whenever a quote
exceeded `STATIC_QUOTE_MAX_CHARS`, and that snippet is optimised to be punchy — which
is how the subjectless "feel like second skin" got typeset as a testimonial. It now
prefers the longest run of **whole sentences** that fits the cap, and only falls back
to the snippet when that run would say less than the snippet does. The video overlay
still uses the 50-char `extractSnippet` by design (owner decision 2026-08-10).

Known conservative gap: a missing space after a period ("amazing.Really soft") is
seen as one unfinished sentence and the quote is dropped rather than guessed at.
Widening `splitSentences` would change stored-review truncation everywhere it is
used, which is not worth a typo case.

### 13.2 `brandReviews` merge rule

`Brand.brandReviews` is written from two places, and both replaced it wholesale:
`brandEnrichmentService.runEnrichment` and `productMatchService`'s
cache write. Grounded search returns `rating` / `reviewCount` **independently** of
`quotes`, so a refresh that found good quotes but no aggregates destroyed a stored
rating — measured on Pelagic Gear, which held 3.2★ / 22 reviews and came back with
neither.

> **Correction.** This section first attributed the missing aggregates to
> grounded-search drift, because a run that looked pre-deploy also lacked them. It was
> not drift: the deploy live at that moment already carried the retrieval rewrite, and
> the real cause was pass-1 truncation — see §14. The merge rule below is still
> required (a fetch genuinely can find no aggregates), but it was treating a symptom. A null rating makes `INTENTS.social_proof_led` ineligible outright (its
`core` **is** the rating), so one unlucky refresh can remove a brand's ability to
render social-proof ads.

`preserveBrandReviewNumbers` (exported from `brandEnrichmentService`, called from
both sites) carries the numbers forward. The rule:

| | behaviour |
|---|---|
| `quotes` | **always replaced wholesale** — a refresh should adopt the newly-filtered pool |
| `rating` + `reviewCount` | carried **together, as one atom**, and only when the fetch supplies neither |
| `summary` | carried on its own — prose about the reviews, never typeset as a quote |
| a fresh number | always wins, **including when it is lower** — this preserves data, it does not flatter it |
| `NaN` | not data (`typeof NaN === 'number'`), treated as absent |

**The pair is one atom** because a per-field carry manufactures a cross-snapshot
pair: prior `{4.3, 22}` + fresh `{null, 6000}` would store a rating measured on 22
reviews next to a count of 6000, and `brandStarFloorForCount` lowers the star floor
from 4.39 to 4.19 once the count clears 5000 — so a stale rating can print stars the
real snapshot never earned. `resolveAtomicRatingPair` exists to prevent exactly that,
and a merge must not defeat it.

`numbersFetchedAt` records when the stored aggregates were actually measured, which
`fetchedAt` cannot (it stamps the quote fetch). **Open follow-up:** the 30-day TTL in
`productMatchService` keys off `fetchedAt`, so carried numbers can ride along
un-refetched. Bounding that needs an owner call on how stale an aggregate may get.


---

## 14. Pass 1 gets cut off, and nobody notices

**The most expensive twenty minutes of this workstream**, and the lesson is not about
prompts. Every grounded lookup is two calls: pass 1 asks Google-grounded Gemini for a
free-form narrative, pass 2 reshapes that narrative into JSON. **Pass 2 can only see
what pass 1 wrote.**

Both pass-1 calls were ending with `finishReason: MAX_TOKENS`, and **nothing in the
codebase read `finishReason`**. A narrative cut off mid-enumeration was therefore
indistinguishable from a complete one: the fetch "succeeded", quotes came back, cost was
ledgered, and the only visible symptom was a missing star rating — which reads as *"the
web just didn't say"*.

Two compounding causes:

1. **The rating was asked for LAST.** Widening the ask from "4-6 quotes" to
   `LLM_QUOTE_CAP` (12), each with a source, an author and a funnel stage, made
   truncation certain rather than unlikely. Anything a prompt asks for last is the first
   thing lost. The numbers are two lines and they gate an ad format, so they now go
   **first** — in all three prompts.
2. **Hidden thinking tokens.** `gemini-2.5-flash` bills reasoning against
   `maxOutputTokens`. The pass-2 calls had set `thinkingBudget: 0` for exactly this
   reason since April; the pass-1 calls never did. Pass 1 summarises search results — it
   does not reason — so every thought token was budget stolen from the narrative.

Measured on Vuori, **same 3000-token budget**:

| prompt | finishReason | narrative | quotes | rating |
|---|---|---|---|---|
| quotes-last, thinking on | `MAX_TOKENS` | 941 chars | 4 | **none** |
| numbers-first, thinking off | `STOP` | 3026 chars | 12 | **4.58 / 15,626** |

Same cost, ~3× the usable narrative. Verified end to end through the shipped
`lookupBrandReviews`: `✓ brand-reviews: 11 quote(s) · 4.6★ · 15,000 reviews`.

### Budgets are padded on purpose

Output tokens bill as **used**, not as reserved, so a high ceiling costs nothing until it
is needed — while a ceiling sized to the measured need is a silent data-loss bug the
moment a brand has more reviews to talk about. Pass 1 is 16000, pass 2 is 12000, grounded
timeouts are 120s, and **every** grounded call in these modules is on those constants —
including the breadcrumb resolver, whose 600-token ceiling looked generous until you
count thinking tokens. Do not tune these back down.

`warnIfTruncated` now runs on every pass-1 response. Silent truncation is what let this
survive three live runs.

---

## 15. Mediocre and negative stop at intake

Owner directive 2026-08-11: *"at no time should mediocre or negative sentiment pass any
gate from initial screening to selection for use in an ad."*

An audit of every hop from retrieval to typeset found the bar was enforced at the two
**ends** and nowhere in the middle:

| stage | before | now |
|---|---|---|
| retrieval | prompt text only | `screenAdUsableSentiment`, unconditional, no kill switch |
| storage | ungated | same screen — nothing mediocre is stored at all |
| primary selection | `pickStrongestQuote` | unchanged |
| **typeset string** | **ungated** | every manufactured form judged |

### The bar is the render path's own selector

`screenAdUsableSentiment` calls `pickStrongestQuote` — not a private notion of
"positive". That matters twice over: intake cannot drift from selection, and the selector
catches what a word list cannot.

- **`hasPositiveSignal` alone is too weak.** It is a lexeme allowlist, so
  *"low-support option best suited for lighter activities"* **passes** it — the phrase
  contains "best". `scoreQuote`'s `HARD_LIMITER` is what rejects it.
- **The score floor is what actually catches mediocrity.** *"Super comfortable and
  durable fabrics."* and *"Great fit, and lightweight."* both contain positive lexemes
  and both fail the floor, because short generic filler does not sell anything.

It **fails closed**: no judge, no quotes. An unjudged quote is worth less than no quote —
a short pool costs one ad format, a mediocre line costs the client.

### The typeset string is not the string that was judged

The subtler half. `pickStrongestQuote` judges the **full** quote text at artifact build,
and then the overflow path typesets a ≤50-char curated snippet that was judged **nowhere**.
Measured: *"feel like second skin"*, *"true to size"* and *"awesome fit"* all **fail** the
render bar while their parent quotes pass it. That is precisely how a subjectless fragment
became the testimonial.

`selectStaticQuoteText` now judges every candidate form before returning it, in preference
order (whole quote → whole sentences → curated snippet → bounded truncation), and prints
**nothing** if none clears the bar, leaving intent fallback to do its job.

**The unabridged text stays trusted.** It was already judged twice upstream, and applying
a lexeme allowlist to it would refuse *"The fabric held up through a whole season of
training."* — specific, credible durability proof with no flattery word in it. The gap
worth closing was strings we **invent**, not strings a reviewer wrote.

### Known gaps, needing an owner decision

- **Video** binds a ≤50-char snippet by design. A complete sentence rarely fits 50
  characters, so "complete quotes" and the 50-char overlay are in genuine tension.
- **Director copy** grounds on `product.reviews[0]` with no sentiment or star gate, and
  that feeds headline/subhead — outside the quote slot entirely.
- **Rating source is unranked and unrecorded.** Pass 2 emits one number, so Vuori's
  self-reported **4.58** on its own site can outrank **Trustpilot's 2.5**, and nothing
  stores which site it came from. Only the 4.39 star floor stands between those two
  numbers and an ad.
- `HARD_LIMITER` is a curated phrase list, not a classifier. It covers the cases seen so
  far; a new limiter phrasing needs adding by hand.
