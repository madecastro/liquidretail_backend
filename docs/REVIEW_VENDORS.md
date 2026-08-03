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
| **grounding surcharge** | **$0.035** |
| structuring pass tokens | ~$0.001 |
| **total per lookup** | **~$0.040** |

Token math alone would have reported ~$0.005 — about **10x** understated. The
surcharge is `costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD`; set
`GEMINI_GROUNDING_COST_USD=0` while inside the free daily allowance. Two
approximations are deliberate and documented at that constant: the surcharge is
*declared* (the tool was enabled) rather than *confirmed* from
`groundingMetadata`, and per-prompt billing is a **2.5-era rule** — Gemini 3 bills
per executed search query, so a model bump changes the unit.

**Still unledgered on this path (known gap, not fixed here):**
`geminiSearchProvider.match` / `.lookupBrandCategoryUrl`,
`categoryReviewsService`, and `productDetailsService.fetchReviewSummary` all POST
the same raw endpoint with no `trackLlmCall` and no `maxRedirects: 0`.

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
