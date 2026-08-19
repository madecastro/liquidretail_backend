## 2026-08-19 — The last two unledgered grounded Gemini calls are ledgered (PR #229 follow-up)

Branch `fix/gemini-grounded-cost-ledger`, worktree off `origin/main` (`8db473c6`, PRs
through #234). Closes the gap PR #229 flagged and deliberately left out of scope.

**What was wrong.** `categoryReviewsService` (grounded category-review search, reachable
from UGC/IG detect on a 30-day category-cache miss via
`productMatchService.maybeFetchCategoryReviewsCached`) and
`productDetailsService.fetchReviewSummary` (grounded product review narrative, reachable
from UGC product_match and the user-triggered "Enrich") both POSTed
`generativelanguage.googleapis.com` with a bare `axios.post`: no `trackLlmCall`, no
`maxRedirects: 0`, nothing in CostLog. Google bills Search grounding **per request**
($0.035 whenever the free daily allowance is exceeded — see the "Third pass" section at
the end of this file for why that surcharge's ledgered default changed to $0 the same
day), so 92-94% of each call's cost was invisible at the time this was measured — the
same defect `match()` had.

**What changed.**
- `trackedGenerate` is now **exported** from `geminiSearchProvider` and is the single
  transport behind all four grounded stages. Both consumers also dropped their own copies
  of the REST URL and of `GEMINI_SEARCH_MODEL || 'gemini-2.5-flash'` (exported as
  `GEMINI_REST_MODEL`), so a row's `model` and the same call's error-log `model` can no
  longer disagree.
- New stages: **`category_reviews`** (`grounded_search` + `json_structure`) and
  **`product_review_summary`** (`grounded_search`). Linkage: `brandId` + breadcrumb key
  for category (threaded down from `fetchAndCache`; CostLog has no category field),
  `productId` + query descriptor for the summary (threaded from `fetchProductDetails`; that
  path holds a brand NAME, not a `Brand._id`, so `brandId` stays null honestly).
- Category **pass 2 moved to Atlas** (`structureCategoryNarrative`) — never grounded, so
  the ATLAS GROUNDING PROBE restriction does not apply. Deliberately a SIBLING of
  `structureReviewNarrative`, not a call into it: that one asks for a `ratings[]` array and
  tells the model to null the scalar `rating` when it fills the array, while this path reads
  ONLY `parsed.rating` — reusing it would have nulled the star rating on every category.
  Its strict `json_schema` is a TIGHTENING (the direct call had no schema at all, only
  `responseMimeType`), safe because every downstream read already treats absent and null
  identically. **The two identical failure fallbacks collapsed into one** — transport
  failure and unparsable content returned byte-identical objects.
- Pass 1 prompts and the pass-2 prompt are **byte-identical** to before (the pass-2 prompt
  was lifted out of the pre-change file programmatically rather than retyped, and that
  identity was asserted).

**Measured live, real money, one real call each** (Pelagic Gear, "Men > Shirts >
Performance Shirts"): `category_reviews/grounded_search` `provider:'gemini'` **$0.037387**
(2191 in / 692 out + the $0.035 surcharge, 10 quotes / 3.2★ / 22 reviews survived intake);
`category_reviews/json_structure` `provider:'atlas'`, `model:'google/gemini-2.5-flash'`
**$0.004218**; `product_review_summary/grounded_search` **$0.037883** (1927ch summary, 8
sources, 3 search queries). **$0.079488 across three rows that previously wrote nothing.**
The new strict schema was exercised on that same run and held — `rating` came back a scalar.

⚠️ **ONE THING NOT PROVEN LIVE, and it needs 30 seconds next session.** The rows were not
persisted to prod CostLog: `MONGODB_URI` in `~/Documents/API Keys/liquidretail_backend.env`
is **stale — "bad auth : authentication failed"** (the credential was rotated; the URI
parses fine and points at `<sub>.5tqqey.mongodb.net/liquidRetail`). Reading the current one
off the Render API, and running a one-off job in prod, were both blocked by this sandbox's
classifier. So the probe ran in capture+validate mode: the API calls, token counts and
dollars above are all REAL, each row was additionally validated against the real `CostLog`
mongoose schema (`validateSync()` — load-bearing, because `persistCost` silently DROPS a
row that fails validation), and the persistence step itself is the identical
`trackLlmCall → persistCost → CostLog.create` path PR #229 already proved live for
`trackedGenerate`. **Next session: refresh that env file's `MONGODB_URI` and re-run
`scripts/verifyGroundedGeminiLedger.js` plus one live call to see the rows land.**

**Verification.** New `scripts/verifyGroundedGeminiLedger.js` — 22 checks, and
**revert-proven MECHANICALLY against 15 mutations** (a runner applied each to the real
source, re-ran the harness, confirmed the named checks failed, reverted). That matrix earned
its keep by finding **two holes in the harness itself**, both of which would have shipped:
a source regex for `tools: [{ google_search: {} }]` passed against a mutation that DELETED
the field, because it matched the comment documenting it (every source assertion now reads
comment-stripped text, and the grounded-tool claim is owned behaviourally off the request as
sent); and a top-level `fnBody` assert killed the run with rc=1 and ZERO named failures,
reading like a crash rather than a revert. Two existing harnesses bound on things this
moved and were **updated, not loosened**: `verifyQuoteRetrievalDirective` bounded the
category pass-1 prompt region on `let searchRes` (now `let searchData`), and
`verifyLlmErrorCodes` A1's LLM-poster inventory legitimately lost both files — they no
longer post at all — so a new **A1b** keeps their coded-failure coverage explicit and fails
if either regains a socket. Full 169-script suite green, `npm run lint` clean.

**Known, bounded, precedented consequence of routing pass 2 through Atlas.** The direct call
was exactly ONE POST; `chatCompletion` on a single-link role is up to `MAX_ATTEMPTS` (3) Atlas
attempts plus one direct-twin attempt. So a pathological all-timeouts pass 2 can now cost ~4x
$0.004 instead of 1x. Accepted for the same reason PR #229 accepted it for brand/product
reviews: LLM failures are largely unbilled (a 429 bills nothing), the ceiling is a small
constant documented at `chatCompletion`, and pass 2 is ~10% of the call pair'''s cost. Pass 1 —
the expensive, grounded half — is untouched and still exactly one POST.

**Also learned, worth keeping:** routing pass 2 through Atlas does **not** take the direct
Google key off that path. `atlasLlmService` keeps Gemini's OpenAI-compatible surface as the
direct twin for this role, and that attempt is itself ledgered (`provider:'google-openai'`).
The harness pins it (F3: a dead Atlas + dead twin writes THREE rows, not two).

**Flagged, NOT fixed (pre-existing, unrelated to this change):**
`categoryReviews.sources` is effectively always `['vertexaisearch.cloud.google.com']` —
grounding chunks come back as Vertex redirect URLs and the category path dedupes by DOMAIN,
so all of them collapse to one. Observed on the live run above. The product path dedupes by
URI so it still reports 8. Real observability defect; its own change.

### Second adversarial pass, same day, same branch

Same branch (`fix/gemini-grounded-cost-ledger`), still on the section above. Grok
re-authed mid-session; ran FOUR parallel Grok reviews (money/ledger at `xhigh`,
schema/harness/bindings at `high`) plus two Anthropic subagents (Opus money
review, Sonnet harness sweep), then hand-verified every claim against the real
code before acting — several claims disagreed with each other and had to be
adjudicated by reading the source, not by majority vote.

**Real findings, fixed:**
- **`reviewCount` was typed `integer` in BOTH strict schemas** (category +
  provider) while the only reader is `typeof === 'number'`. Under strict
  decode, a float ("4.5k reviews" → `4500.0`) would have rejected the WHOLE
  object — quotes and rating included — not just nulled the count, which is a
  worse failure mode than the schemaless path it replaced. Now `'number'` in
  both places.
- **The pass-2 fallback error handler mislabeled its provider as `'atlas'`**
  even though the throw it catches may have come from the ungrounded
  `google-openai` direct twin. Corrected to `'unknown'` — the fallback only
  fires on a non-coded throw, so it genuinely doesn't know which one failed.
- **`brandId` was available and dropped at ALL THREE production
  `fetchProductDetails` call sites** (`productMatchService.js` ×2,
  `catalogProductEnrichmentService.js` ×1) — `CatalogProduct.brandId` is a
  real, required field, just never threaded. Every `product_review_summary`
  CostLog row from those paths carried `brandId:null`. Threaded through all
  three, plus `fetchProductDetails`/`fetchReviewSummary`'s own signatures.
- **A regex over source text cannot see an unbound identifier — same lesson
  as CLAUDE.md's `receiptFree` post-mortem, new instance.** The harness's F7
  check asserted `fetchAndCache` threads `brandId` using a source regex
  (`/fetchCategoryReviews\(\{[^}]*brandId[^}]*\}\)/`) that **matches
  `brandId: null`** — a caller that silently drops the join reads as passing.
  F7 now drives the REAL `fetchAndCache` (exported for this reason, same
  precedent as `fetchReviewSummary`) with Category/Brand stubbed, and asserts
  on the actual CostLog row.
- **A genuinely live regex-literal lexer bug**, found by testing my own fix
  against the real guarded files, not flagged by any reviewer:
  `productDetailsService.js:56` has
  `_rawKey.trim().replace(/^['"]|['"]$/g, '')` — four quote characters inside
  a regex literal. A naive quote-tracking `stripComments`/`fnBody` reads the
  first `'` as opening a string, misreads the following characters, and ends
  up with an unterminated fake string that corrupts every check for the rest
  of the file — demonstrated: a real `// GEMINI_SEARCH_MODEL` comment ~300
  lines later silently stopped being recognised as a comment at all. Fixed by
  replacing both `stripComments` and `fnBody` with ONE shared, regex-literal-
  aware tokenizer (`classifySource`) so the two can never independently
  disagree about what's "inside a string" again.
- **Two dummy-satisfiable source regexes removed.** E5/E8 asserted
  `tools: [{ google_search: {} }]` appears in the function's SOURCE TEXT —
  satisfiable by a dead literal placed anywhere in the function while the
  real call drops the field. Removed; G1/F7/F8 now own "still asks for
  grounding" **behaviourally**, off the actual request sent through the real
  production entry points.
- **`fnBody`'s brace-matcher was truncatable by a template literal
  containing a bare `}` line** — a Sonnet-subagent-demonstrated exploit
  (dead JSON-example literal + env-gated, string-built `axios.post`,
  invisible to every check because the harness deletes the gating env var at
  module load). Rewritten to walk the parameter list THEN the body using the
  same shared tokenizer, so string/comment/regex content can never look like
  a brace.
- **F6 was vacuously true on zero matching rows** (a `for...of` over an
  empty filter never executes its body) — would have silently no-op'd if a
  provider string were ever renamed. Now asserts a minimum row count first.
- **E9 only checked `catalogProductId`, not the new `brandId` threading** —
  found by my OWN second mutation matrix (N1-N3), not a reviewer. Rewritten
  to be argument-COUNT based (needs 3 args, not name-matched) so it can't be
  fooled by what a caller names its variable.
- **A meta-bug in my own edit tooling**: a Python script combining multiple
  file edits with a SINGLE deferred `write()` at the end crashed partway
  through (on an assertion for the F8 edit) and silently discarded EVERY
  edit before it — including the F7 rewrite and the Category/Brand harness
  stubs — while printing success messages for the ones that DID complete
  before the crash. Caught by re-testing the exact exploit the aborted edit
  was supposed to fix and finding it still passed. Lesson applied: every
  edit script from that point on writes its file immediately after each
  self-contained change, never batches multiple edits behind one write.

**Real finding, correctly declined and flagged instead of fixed here:**
`atlasLlmService.post()` (the shared Atlas + direct-provider-twin transport)
has no `maxRedirects: 0` — confirmed by two independent reviewers, confirmed
pre-existing (the old direct pass-2 call this PR replaced didn't have it
either), and confirmed to affect **27 files** including Director, Judge, Copy
derivation, and Layout generation. Fixing a shared transport with that blast
radius needs its own PR and its own full-suite verification pass, not a
drive-by inside a two-file ledger fix — flagged as a spawned follow-up task
rather than touched here.

**Two doc-only corrections, also real:**
- `services/costTracker.js`'s `google/gemini-2.5-flash` rate comment blamed a
  2026-08-17 cost-audit gap on the grounding-surcharge estimate. Proven
  impossible: `groundedRequests` is only ever set with `provider:'gemini'`,
  while the Atlas daily reconciler only aggregates `provider:'atlas'` rows —
  no Atlas row can carry that surcharge. Corrected to point at the more
  likely cause (the flat vision-image estimate) without re-chasing it.
- The "~92%" grounding-share figure in three docs was an approximation of the
  two measured numbers (93.6%, 92.4%); tightened to the actual range.

**Verification.** `scripts/verifyGroundedGeminiLedger.js` grew from 22 to 25
checks. TWO separate mutation matrices now revert-prove it: the original
19-mutation run (`mutate.py`, all 19 still trip it — M1/M2's revert target
had to move from `HEAD` to the branch's merge-base with `origin/main` once
this session started amending its own commit, or "revert to HEAD" silently
became a no-op) and a new 10-mutation run (`mutate2.py`) targeting every fix
from this second pass specifically. Full 169-script suite green, `npm run
lint` clean.

### Third pass — rebasing onto current `main` surfaced a real regime change

By the time this PR was ready to open, `main` had also been restructured
(`session.md` split into `session.d/`, this very file's home) and had picked up a
genuinely substantive, unrelated change to the shared cost-ledger transport this
PR's harness depends on: `GROUNDED_SEARCH_COST_PER_REQUEST_USD`'s default flipped
from a hardcoded `$0.035` (Google's published per-request grounding surcharge)
to **`$0`**. A separate session's deliberate, extensively-documented decision — see
that constant's comment in `services/costTracker.js` — because measured grounded
volume (13-19/day) sits comfortably inside Google's 1,500/day free allowance, so the
surcharge is genuinely $0 today; a new `noteGroundedRequests()` counter (wired
automatically into every `trackLlmCall`) watches for volume approaching the
allowance and alerts a human instead of auto-repricing. The comment is explicit that
"finishing" this by making the alert threshold auto-reprice is the regression, not
an improvement — respected as written.

This mattered to this PR in one real way, caught only by re-running the full
verify suite AFTER the rebase (not just trusting a clean merge): the harness's
`GROUNDING_PER_CALL` was a **hardcoded `0.035` literal**, and `F4` asserted
grounding is "the MAJORITY of the row" — both true under the old default, both
silently wrong the moment `main`'s default changed under this branch. `F0`
(added in the second pass specifically to catch rate-table drift) caught it
immediately and by name, exactly as designed — three checks failed with a clear
"rate constants disagree" signal rather than a confusing wrong-dollar-amount one.
Fixed by making `GROUNDING_PER_CALL` read live from
`costTracker.GROUNDED_SEARCH_COST_PER_REQUEST_USD` (so it can never drift from
reality again) and rewriting `F4` to assert the surcharge is **additive and
correctly gated** on `groundedRequests`, not that it dominates the row — a claim
that holds at $0, at $0.035, or at any future value. Revert-proven with an 11th
mutation (`mutate2.py`'s `N11`: wrong surcharge rate in `computeCost`) confirming
the rewritten `F4` still catches a real defect, not just a vacuous pass.

**The live dollar figures measured earlier in this file ($0.037387 etc.) are an
honest historical record of real API calls under the code as it existed then —
not today's price.** What this PR actually guarantees, unaffected by the regime
change, is that `groundedRequests` is correctly declared on every grounded row,
which is what both the dollar figure (whatever it currently is) and the
free-allowance alert depend on.

Also worth recording: no code file in `services/` needed to change for this —
`trackedGenerate` already read `GROUNDED_SEARCH_COST_PER_REQUEST_USD` from the
shared `costTracker` module rather than holding a private copy, so the actual
fix (both newly-ledgered call sites correctly declaring `groundedRequests`)
adapted to the new default automatically. Only the TEST HARNESS had a private,
now-stale copy of the old rate. That is itself the argument for F0's existence:
a harness that reads live values instead of hardcoding them at write-time is
what makes a rebase like this a same-day fix instead of a silent, months-later
drift.

Also worth noting: `scripts/verifyGeminiSearchCost.js` (pre-existing, not part
of this PR) had already been updated by the same session that changed the
default — its own `GROUNDING_PER_CALL` is now a hardcoded `0`. This harness's
fix (read the value live) is marginally more robust: a hardcoded `0` would go
stale again the next time the default changes, this can't.

Final state: 25 checks, 30 mutations across three matrices (19 + 11,
`mutate2.py` grew by one), full **174-script** verify suite green (up from 169
— `main` grew by 5 scripts while this branch was open), `npm run lint` clean,
on the branch as actually rebased onto `origin/main` immediately before
opening PR #253.
