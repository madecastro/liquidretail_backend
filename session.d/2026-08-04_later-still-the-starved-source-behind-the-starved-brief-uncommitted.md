## 2026-08-04 (later still) — the STARVED SOURCE behind the starved brief. UNCOMMITTED

Follow-on from the `ai_brand_led` work above, prompted by the owner asking *"there must be lots of
derived brand attributes we could use for these ads?"* Answer: there are, and **the tier that
derives most of them may never have run.**

**1. `wantGpt` gated on the FALLBACK key** (`brandEnrichmentService.js`). The tier's call goes
through `atlasLlmService.chatCompletion` — Atlas primary, direct providers kept only as a fallback
per operator directive — but the gate was `!!process.env.OPENAI_API_KEY`. After the move to Atlas, a
deployment holding only Atlas credentials **silently skipped the entire GPT enrichment tier.** That
tier's `ENRICHMENT_SCHEMA` (`:33`) owns **tagline, summary, tone, hashtags, tags, demographics, the
colours and fontSuggestion** — and `summary` has **no other automated writer**
(`setIf('summary', …, 'gpt')`). `brand_signal.description` in the Director brief reads exactly that
field, so the starved brief fixed earlier today had a starved *source* upstream of it.
Now `(atlasLlmConfigured() || !!process.env.OPENAI_API_KEY)`.
**NOT the same bug as `wantBrandReviews`/`GEMINI_API_KEY`** — `geminiSearchProvider` calls Google's
grounded-search endpoint directly and is deliberately not behind `atlasLlmService`, so that gate is
correct. Don't "fix" it.

**2. `.select()` of a non-existent path is silent** (`aiCanvasInputBuilder`). It selected
`'description tagline brandReviews tone'` off Brand; `description` is not a brandSchema field, so
the rich-context `description` key handed to the canvas Generator was permanently empty. Fixed to
`summary` in **both** the projection and the read. Output key stays `description` because
`aiCanvasSpecService.js:749` names it in the prompt.

### THE FALSE POSITIVE THAT WAS AVOIDED — read this before touching `brand.logo`

An audit initially reported `aiCanvasInputBuilder.js:133/329/330` (`brand.logo`) as the same bug.
**They are correct code.** `:37` is `const brand = layoutInput.brand || {}`, and
`layoutInputService.js:2227` builds `layoutInput.brand.logo` **from** `brand.logoUrl`. Likewise
`ALLOWED_SLOTS` (`aiCanvasSpecService.js:115`) and the prompt text at `:555`/`:749` are slot-binding
contract paths and context key names, not property reads. Renaming any of them is a regression.
The real bug was one line above, on a different variable (`brandDoc`, the Mongoose doc).
`Brand doc` vs `layoutInput.brand` is the distinction to check first, every time.

**Verify:** new `scripts/verifyBrandFieldNames.js` — **17 checks**. Group A parses the real
top-level `brandSchema` keys from `models/Brand.js` (58 today; independently re-counted) and asserts
every `Brand.find*().select(…)` path in `services/` + `routes/` is a real field — the general form
of the trap. Group B forbids `brandDoc.description` / `brandDoc.logo` with a **negative lookahead**
so `logoUrl` cannot false-pass. Group C pins the three fixed sites. **Group D asserts the
legitimate layoutInput usages still exist**, so an over-eager cleanup fails the harness.
Revert-proven on 5 mutations including both directions (restore the bad `.select()` → Group A names
it; break the layoutInput contract → Group D fails). Full suite **54 scripts, 0 failing**.

### Open question the owner should settle

Whether the GPT tier ever ran is an empirical question and **there is no local Mongo URI**, so it is
unanswered. Check `enrichmentSources` for a `'gpt'` entry across brands; if it is near-absent while
brands have `websiteUrl`s, none of the derived attributes were ever generated and the gate above is
the whole story. Then re-run enrichment on a brand and confirm `summary` / `tone` / `demographics`
populate before wiring any new consumer — do not build consumers for fields nothing writes.

---

