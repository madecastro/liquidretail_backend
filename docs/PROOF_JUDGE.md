# Social proof: judged at ingest, never raw

**The rule.** Every surface that prints a customer's words on an ad, or feeds
them to an LLM as proof, consumes the *ingested, processed* artifact. Never the
raw source text, never a raw star number.

| Source | Raw form (do not consume) | Processed form (consume this) |
|---|---|---|
| Social comment | `Comment.text` | `Comment.proofJudgment.{usable,line}` |
| Product review | `productReviews.quotes[].text` | `extractSnippet()` output, behind the 4.5★ gate |
| Star rating | `quotes[].rating` | `toFiveScale(rating) >= QUOTE_MIN_RATING` |
| Provenance | — | `origin` / `verbatim` / `scope` on every quote |

---

## Why comments are judged by inference, not by keywords

The gate this replaced was a regex lexicon: a comment was "positive" if any
positive word appeared in it. That is not a sentiment test, and it fails in both
directions:

```
"Not great, would not buy again."            → ACCEPTED. The word "great" is in it.
"Hasn't faded at all after a year, love it"  → REJECTED once a complaint
                                               blocklist was added, because
                                               "faded" is in it.
```

The second failure is the expensive one. A reviewer naming the exact worry that
stops a purchase and resolving it — *"no cracks after a year"*, *"doesn't
smell"*, *"never slips"* — is **risk reversal**, the most persuasive thing a
customer can write, and the form `quoteSnippetService`'s own prompt is told to
prefer above all others. A blocklist rejects precisely the best proof we have.

An allowlist and a blocklist cannot both be right about a negation, because
sentiment is a property of the sentence, not of the words in it. So the
judgment is made by inference over the whole sentence.

**It costs approximately nothing.** One batched call per candidate set through
the `review-text` role (`google/gemini-2.5-flash-lite`), ≈ $0.00002. The same
call also returns the shortened, ad-ready line, so a comment is judged *and*
shortened exactly once.

## Where the judgment happens

Once, at ingest — `mediaInsightsService.fetchCommentsForMedia`, immediately
after the upsert page, while we are already inside a background job. The verdict
is persisted to `Comment.proofJudgment`:

```js
proofJudgment: { usable, reason, line, model, judgedAt }
```

It lives on the row rather than in each renderer for two reasons: a comment's
sentiment does not change between ads, and every surface that renders one must
reach the *same* verdict. Before this, four consumers each decided for
themselves — with three different answers, and one no answer at all.

**Absent ≠ rejected.** `proofJudgment.usable === undefined` means *not yet
judged*. Read paths judge those lazily via `ensureCommentsJudged` and persist
the result, so the collection fills in without a backfill script. Forward-only,
self-healing.

## Over-fetch, then judge — never limit-then-screen

Every consumer over-fetches and lets the judge narrow the list:

```js
.sort({ likeCount: -1 }).limit(25)      // over-fetch
const usable = await usableProofComments(rows, ctx);
usable.slice(0, 3)                       // then take what you need
```

Taking the top N by likes *first* and screening after can only shrink an
already-truncated list. On a popular post the most-liked comments are usually
noise ("🔥🔥", "need this") or complaints, so the screen returned nothing while
clean praise sat just below the cut.

## Failure policy: stop and alert, do not guess

`judgeProofLines` has **no lexical fallback**, by design.

`chatCompletion` already tries Atlas and then falls back to the direct provider
for the same model (`atlasLlmService`, `atlasModelMap`'s `direct` entry). If
*both* are unreachable there is no third path that can judge sentiment. The only
remaining options would be to print unjudged comments, or to silently degrade to
the keyword screen this exists to replace — and both put a complaint on a paid
ad.

So it raises an alert and throws:

| Condition | Level | Behaviour |
|---|---|---|
| No `ATLAS_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` | `fatal` | Configuration fault. Throws. |
| Atlas *and* direct provider both failed the call | `error` | Throws. |
| Verdict persist (`bulkWrite`) failed | warn only | Not a correctness failure — verdicts are already applied in memory, so this run is correct and the next re-judges. |
| A candidate came back with no verdict | — | That candidate is **dropped**. Silence is not approval. |

Callers must not catch the throw and render the comments anyway. The one
deliberate exception is the ingest hook itself: a judge failure there does not
fail the comment *fetch* (the comments are stored and correct, they simply have
no verdict yet) because the read path will judge them lazily. The judge has
already alerted by that point.

## Consumers

All of these read the same verdict:

| Consumer | What it feeds |
|---|---|
| `layoutInputService.loadBrandCommentsForQuotePool` | the comment quote tier |
| `layoutInputService.buildProofComments` | `social_context.top_comments[]` |
| `aiCanvasInputBuilder.loadTopComments` | the AI-canvas spec generator |
| `aiCreativeDirectorService.assembleSignals` | `social_proof_signal.top_comments` — the Director |
| `aiImageReferenceService` | image-model reference context |

The Director one mattered most and was the worst: it was handed the most-liked
comments verbatim, truncated to 180 characters, with no screen of any kind. A
complaint could seed the concept the entire ad is then built around, and
`social_proof_type: "creator"` could be selected on the strength of it.

## Reviews are gated differently, and deliberately

Reviews are **not** run through the comment judge, because they carry something
better: the reviewer's own star rating.

- `QUOTE_MIN_RATING` (4.5) is the single threshold, normalized through
  `toFiveScale` first so a 90/100 is read as 4.5 and not as 90.
- The review's *text* still passes through inference — `extractSnippet`, the one
  place a quote is shortened, whose prompt enforces positive / on-product /
  complete-thought / no-shipping-or-service.
- Category- and brand-tier quotes come from an LLM web search and carry no
  per-review rating. They are allowed through unrated
  (`QUOTE_REQUIRE_RATING=false`) and are accepted when no product-specific quote
  exists.

## Known gap

`scoreQuote`'s `NEGATIVE_SENTIMENT` pattern still hard-rejects (`-Infinity`) any
review quote containing a complaint word, which means a 5-star *risk-reversal*
review — "no cracks after a year" — cannot win the primary slot even though it
is the strongest proof available. That is pre-existing behaviour on the review
ranking path, not the comment path, and it is the same class of bug this
document exists to explain. It should move to inference the same way.
