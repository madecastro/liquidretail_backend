## 2026-08-19 — Last direct-Gemini path swept: grounding PROVEN unavailable on Atlas, ungrounded half rewired

Branch `fix/gemini-atlas-rewire` (worktree, off `origin/main` `87cfdd00`). **Not yet merged —
open a PR and land it next session unless already done.** Full 157-script suite green, lint
clean, four manual revert-proof mutations confirmed caught (see
`scripts/verifyGeminiSearchAtlasRouting.js`).

**Task:** find and rewire the last direct-Google-key LLM path onto Atlas, or prove it can't
move. The measured CostLog slice (`provider=gemini, model=gemini-2.5-flash,
stage=brand_reviews`) turned out to be TWO calls sharing a stage name — a grounded search pass
and an ungrounded JSON-structuring pass — and they needed opposite answers.

**Grounding is now PROVEN unavailable on Atlas, not asserted.** Four live probes against
`POST https://api.atlascloud.ai/v1/chat/completions`, `model: 'google/gemini-2.5-flash'`: a
plain call correctly self-reports no real-time access; Gemini's native
`tools:[{google_search:{}}]` → **HTTP 400**; OpenAI's own `tools:[{type:'web_search'}]` → also
**400**; a top-level `web_search:true` (mirroring Seedance 2.0's video convention) → 200 but
silently ignored (`toolUsePromptTokenCount:0`). No customer-reachable endpoint beyond
`openai.chat.completions` exists for this model either (the `gemini.generate` protocol tag is
not documented or reachable — 3 guessed URLs all 404). Full evidence: the **ATLAS GROUNDING
PROBE** comment in `services/providers/geminiSearchProvider.js` above `MODEL`/`ENDPOINT`.

**What moved, what stayed, what was deleted:**
- **Stayed on direct (`GEMINI_API_KEY`), because genuinely grounded:** `lookupBrandReviews` /
  `lookupProductReviews` pass 1, and `match()`.
- **`match()` was billing Google with ZERO CostLog visibility — now ledgered** (routed through
  `trackedGenerate`, stage `gemini_product_match`). Measured live: one real call, `$0.038263`,
  previously invisible spend.
- **Moved to Atlas:** pass 2 (JSON structuring, never grounded) of both lookups, via
  `atlasLlmService.chatCompletion`, role `gemini-2.5-flash` → `google/gemini-2.5-flash`. Same
  model as pass 1 deliberately (pricing is identical either way, verified live against
  `GET /api/v1/models` — no cost argument for a different model). Consolidated the two
  near-duplicate pass-2 implementations (brand + product) into one shared
  `structureReviewNarrative`, translating Gemini's native `responseSchema` to an OpenAI strict
  `json_schema` (verified live that Atlas honors and enforces it for this model).
- **Deleted, not rewired:** `lookupBrandCategoryUrl` — confirmed dead, its only caller
  (`productMatchService.tryLookupBrandCategoryUrl`) itself had zero call sites anywhere.
- **Still open, real, unledgered — same shape as the `match()` fix, not done this pass:**
  `categoryReviewsService` and `productDetailsService.fetchReviewSummary` both still POST the
  raw direct endpoint with no `trackLlmCall`. Both are genuinely grounded, so the fix there is
  "wrap in a ledgered transport," not "move to Atlas."
- **Confirmed already correct, nothing to do:** every other `GEMINI_API_KEY` reader
  (`geminiIdentifyService`, `visualCatalogMatchService`, `plateIntelService`,
  `overlayZoneService`, `quoteSnippetService`, `layoutInputService`, `metaAdsFontService`) is
  already Atlas-primary with the direct key wired only as `atlasLlmService`'s own
  fallback-of-last-resort. `aiVideoReferenceService` (direct Veo) is gated dead
  (`VIDEO_PROVIDER=atlas`). `aiImageReferenceService` reconfirmed dead (already known).

**Measured, real, live — not projected:** one real `lookupBrandReviews('Allbirds')` call wrote
two CostLog rows: pass 1 `provider:'gemini'`, `$0.037357`; pass 2 flipped to
`provider:'atlas', model:'google/gemini-2.5-flash'`, `$0.009403`. **Honest sizing from a real
7-day CostLog query — do not oversell this:** pass 2 is only **4.5%** of direct-gemini spend in
that window ($0.0548 of $1.2072, 28 of 59 calls). This is an architecture/observability fix
(one fewer direct-key dependency; `match()`'s blind spot closed), not a meaningful dollar
saving — pass 1's grounding requirement is the large majority of the spend and cannot move.

**Verification:** new `scripts/verifyGeminiSearchAtlasRouting.js` (9 checks, source-based,
revert-proven on 4 manual mutations — pass 2 requesting grounding, `match()` reverted to raw
axios, pass 2 reverted to `trackedGenerate`, the direct `ENDPOINT` referenced inside the
Atlas-routed pass — all four correctly failed, then were restored and reconfirmed passing).
Updated `scripts/verifyGeminiSearchCost.js` (D-section stub now branches on request URL to
serve both transports; new B1b pins the Atlas rate), `scripts/verifyQuoteRetrievalDirective.js`
(C3/F2/N10, updated for the single shared schema/prompt), `scripts/verifyRatingProvenance.js`
(F5/F6a/F6b — `RATING_REQUIRE_PROVENANCE` now only gates the PROMPT ask, not the schema, because
OpenAI strict mode requires every property present regardless of the flag; documented as a
deliberate consequence, not a silent regression). Full suite 157/157, `npx eslint .` clean.

**Not verified / explicitly out of scope this pass:** did not migrate
`categoryReviewsService` / `productDetailsService.fetchReviewSummary` (flagged above, real
follow-up); did not re-measure `match()`'s or pass 2's cost against alternative cheaper Gemini
models (`gemini-2.5-flash-lite`) — deliberately kept like-for-like given this schema/prompt's
documented history of model-quality-sensitive JSON compliance bugs; did not touch
`brandEnrichmentService.js`'s own key gates (already correct per the pre-existing "Gate on the
PRIMARY key" note).

