## 2026-08-11 (later) — QUOTE QUALITY: retrieval rewritten, then TWO live defects fixed. PRs #120, #121, #133 MERGED

The chain, in order, all merged: **#120** per-surface quote length + two unscoped review-count
paths; **#121** the retrieval prompt rewritten to the owner's directive; **#133** the two defects
the first post-deploy run exposed.

### The owner directive that started it (2026-08-10)
> *"The goal is to find positive statements that help us achieve our goals at different stages of
> the funnel as well as retention and conquest. Negative statements are not wanted, nor are neutral
> statements."* … *"statements should be complimentary and complementary to the brand in every sense
> of the word."*

Measured on Vuori beforehand: of 6 stored brand quotes, **2 were openly negative**, 3 were about a
different product category, and the one that printed carried a promotional claim nobody chose to
make. The ad path effectively had **one** usable quote and printed it on every creative. That is
why "feel like second skin" appeared on everything. `LLM_QUOTE_CAP` (12, validated 1..40) replaced
the hardcoded `slice(0, 6)`; the cap, not the prompt, was the real ceiling.

### The counterweight that makes a positivity ask safe
Asking a model for only-flattering quotes creates direct pressure to embellish or invent a
reviewer, and these are stamped `origin:'llm-web'` and can be typeset verbatim into a PAID ad.
`keepVerbatimQuotes` — **code, not prompt text** — drops anything the grounded narrative does not
literally contain. It existed on the category path only; it is now one shared implementation across
brand, product and category.

### #133 — the two defects, both found by looking at delivered output
1. **A quote reached an ad mid-sentence.** Pelagic returned *"…these have been keeping me cool in
   my"*. It passed the verbatim check because it genuinely **is** a substring of the narrative.
   `completeSentencesOnly` trims back to the last sentence stop the reviewer wrote, or drops it —
   **selection, not repair**: `completeSentencePrefix` always returns a literal prefix of the input.
2. **A refresh destroyed stored brand numbers.** Pelagic held 3.2★ / 22 reviews and came back with
   both null. Grounded search returns the aggregates **independently** of the quotes, so this is
   drift, not a prompt regression — confirmed by comparing the pre-deploy 09:05 and post-deploy
   16:45 runs (both logged `✓ brand-reviews: N quote(s)` with no `· X★ · N reviews` suffix).

### The four things adversarial review caught before #133 shipped — worth internalising
- **An abbreviation is not a sentence end.** A naive trim turns *"Absolutely love Dr. Bronners
  products and the scent is"* into **"Absolutely love Dr."**
- **A trim can INVERT the sentiment.** *"I hated the old ones. These are great and soft"* trims to
  a complete, verbatim, fabricated **negative** endorsement. The kept span is now re-judged with
  `layoutInputService.hasPositiveSignal` — the render path's own gate, reused so they cannot drift.
- **The rating/count pair is ONE ATOM.** A per-field carry manufactures a cross-snapshot pair:
  prior `{4.3, 22}` + fresh `{null, 6000}` stores a 22-review rating beside a 6000 count, and
  `brandStarFloorForCount` lowers the floor 4.39 → 4.19 above 5000 reviews — printing stars the
  real snapshot never earned. `resolveAtomicRatingPair` exists to prevent exactly that.
- **There was a SECOND wholesale-replace write path** (`productMatchService`'s cache write) with the
  identical bug. Fixing only the enrichment site would have left it fully reachable.

### Retrieval completeness is NOT sufficient — the last cut happens at render
`selectStaticQuoteText` fell straight through to the ≤50-char curated snippet on overflow, which is
optimised to be punchy and is therefore often subjectless — that is how *"feel like second skin"*
got typeset. It now prefers the longest run of whole sentences that fits the cap. `STATIC_FULL_QUOTE=false`
stays byte-identical. **Video's 50-char overlay is unchanged by owner decision**; the open item there
is attribution font sizing (*"be mindful of the font sizing for the attribution especially in videos"*).

### Harness lessons repeated three times this session
- A harness that reimplements the logic it tests passes against the reimplementation. #120 and #133
  both had to **export the real function** first. §H/§I of `verifyQuoteRetrievalDirective` are
  behavioural against shipped exports for this reason.
- **A mutation that does not apply looks like a passing test.** Every mutation run now asserts an
  exact single match before it counts. One mutation this session (`let staysPositive = false` → `true`)
  was a no-op against a dead initializer and read as "not caught" until re-aimed at the real gate.
- Source pins must strip comments **and** assert ordering: a preference that runs after the fallback
  it is meant to pre-empt can never fire, and a pin that matches its own explanation cannot fail.
- 17 mutations revert-proven on #133; full suite **90/90**.

### Still open on quote quality
- `funnelStage` / `conceptAngle` selection is **built but unwired** — `STAGE_TERMS`, `STAGE_WEIGHT`,
  `ANGLE_WEIGHT`, `BIAS_CAP` exist and **zero callers pass them**. `STAGE_TERMS` also has no
  retention/conquest terms, which the owner's directive explicitly asks for.
- Platform-level attribution ("via Reddit") needs **its own sized slot**; appending it to the count
  line measured 3.35:1 contrast, below the bar.
- Carried brand numbers ride along un-refetched: the 30-day TTL in `productMatchService` keys off
  `fetchedAt`, and `numbersFetchedAt` now records the real age but nothing reads it. Bounding that
  needs an owner call on how stale an aggregate may get.

