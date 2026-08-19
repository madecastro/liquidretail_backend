## 2026-08-11 — I CAUSED THE MISSING RATINGS, AND MISDIAGNOSED IT ONCE. PRs #134 MERGED

**Read this one before touching quote retrieval.** The chain: #120 → #121 → #133 → **#134**.

### The regression, and why the first diagnosis was wrong
After #121 widened the quote ask (6 → `LLM_QUOTE_CAP` 12, each with source + author +
funnel stage), **every** brand-reviews fetch came back with `2 quote(s)` and **no star
rating**. Vuori went 4.6★ / 15,545 → **null**, which makes `social_proof_led` ineligible
outright — the exact failure the whole workstream had just fixed.

I first called it grounded-search drift, because the 09:05 Vuori run looked pre-deploy.
**It was not.** The deploy live at 09:05 (`466a92ac5`) already contained #121, and the last
fetch that returned numbers was **07:45**, before it went live. Lesson worth keeping: *"the
upstream API returned nothing"* is a claim to check against a deploy timeline — one
`git merge-base --is-ancestor` would have settled it in seconds.

### The actual mechanism (two compounding causes)
1. **`finishReason: MAX_TOKENS`, unchecked.** Nothing in the repo read `finishReason`, so a
   narrative cut off mid-enumeration was indistinguishable from a complete one — the fetch
   "succeeded", quotes came back, cost was ledgered, and the missing rating read as *"the
   web didn't say"*. Pass 2 can only see what pass 1 wrote.
2. **The rating was asked for LAST**, and **pass 1 never set `thinkingBudget: 0`** (pass 2
   has since April). Hidden thinking bills against `maxOutputTokens`, so the budget went to
   thoughts nobody reads and then to quotes, and the numbers never got written.

Measured on Vuori at the **same** 3000-token budget: `MAX_TOKENS` / 941 chars / 4 quotes /
no rating → **`STOP` / 3026 chars / 12 quotes / 4.58★ / 15,626**. Verified through the
shipped `lookupBrandReviews`: `✓ brand-reviews: 11 quote(s) · 4.6★ · 15,000 reviews`.

**Budgets are now padded and must stay padded** (owner directive): pass 1 16000, pass 2
12000, grounded timeouts 120s, on EVERY grounded call in those modules — output tokens bill
as used, so headroom is free, and a ceiling sized to the measured need is a data-loss bug
waiting for a brand with more reviews.

### Owner directive: mediocre never passes any gate
*"at no time should mediocre or negative sentiment pass any gate from initial screening to
selection for use in an ad."* A Grok audit of every hop found the bar was enforced at the
two ENDS and nowhere in the middle:

- **Retrieval was prompt-only** → `screenAdUsableSentiment` now screens every quote,
  unconditionally, no kill switch. The bar is **`pickStrongestQuote`**, the render path's
  own selector, so intake cannot drift from selection. Why not `hasPositiveSignal` alone:
  it is a lexeme allowlist, so *"low-support option best suited for lighter activities"*
  **passes** it (contains "best") — `HARD_LIMITER` is what rejects that, and the **score
  floor** is what rejects short generic filler like *"Great fit, and lightweight."*
- **The typeset string was never the judged string** → `selectStaticQuoteText` could emit a
  ≤50-char snippet judged nowhere. *"feel like second skin"*, *"true to size"*, *"awesome
  fit"* all FAIL the render bar while their parent quote passes. Every manufactured form is
  now judged; nothing prints if none clears the bar. The **unabridged** text stays trusted —
  it was judged twice upstream, and a lexeme allowlist would refuse *"The fabric held up
  through a whole season of training."*

### Process lessons that cost real time today
- **A restore loop that silently does nothing turns a mutation sweep into 14 stacked
  mutations.** `for f in $FILES` does **not** word-split in zsh. Every mutation "passed"
  while attribution was meaningless, and the working tree ended up corrupted. **Commit
  before mutation-testing** and restore with `git checkout --`, never with `cp` backups.
- **A mutation that does not apply looks exactly like a passing test.** Assert an exact
  single match before counting the result.
- **Two mutations survived the first sweep**, both because the check lived in the wrong
  harness or did not exist: a hard-limiter snippet, and the OPPOSITE failure of
  over-applying the gate (refusing good unabridged quotes). Pin both directions.
- The cost-harness fixture has now been broken twice by tightened intake gates. Its comment
  lists both, so the next person checks which gate moved before touching the check.

### Still open — needs an owner call, deliberately NOT changed
1. **Video** binds a ≤50-char snippet by design. A complete sentence rarely fits 50 chars,
   so "complete quotes" and the 50-char overlay are in real tension.
2. **Director copy** grounds on `product.reviews[0]` with no sentiment/star gate and feeds
   headline/subhead — outside the quote slot entirely.
3. **Rating source is unranked and unrecorded.** Pass 2 emits ONE number, so Vuori's
   self-reported 4.58 can outrank Trustpilot's 2.5, and nothing stores which site it came
   from. Only the 4.39 floor stands between those two numbers and an ad.
4. `funnelStage` / `conceptAngle` selection is still built-but-unwired; `stage` IS now
   populated on stored quotes (`stage: 'retention'` observed on Vuori), so the input exists.

