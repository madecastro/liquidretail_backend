# 2026-08-20 — Static ad typeface classification: read the brand's CSS, stop guessing from the name

Closes the follow-up flagged as §5 of `session.d/2026-08-20_five-video-titling-defects-marine-layer-2.md`
(PR #261), which investigated this and deliberately did not change it.

## The defect

`services/directImageRenderService.js`'s `typefaceDirectiveForBrand` tells gpt-image-2
whether a brand's headline face is serif or sans. It classified by regex-matching the
family NAME against `FONT_SERIF_HINTS`. Marine Layer 2's real ingested website font is
"Seriously Nostalgic" — a Didone-style display **serif** — whose name matches no keyword
in that list ("serio…" and "serif…" diverge at the 5th character). So the static prompt
asserted a "clean, modern sans-serif" for it, while the VIDEO titling path (which loads
the real font FILE and therefore never guesses) rendered the same brand as a serif. A
brand's static and video ads disagreed about its own typeface, from a keyword-list gap.

Cosmetic — typography consistency, not spend or correctness.

## What was measured before choosing a fix

The brief suggested inspecting the font file's OS/2 table (panose). **Measured, and it
does not work:**

| signal | result across the 28 real woff2 files in `services/brandScripts/assets/webfonts` |
|---|---|
| `OS/2.sFamilyClass` | **0 (unset) on all 28** |
| `OS/2.panose[1]` (serif style) | unset on **every known serif** — Playfair Display, EB Garamond, Lora all `[0,0,…]`; Newsreader `[2,0,…]`. Populated on only 2 of 12 families (founders-grotesk, source-sans-pro — both sans). Google's v2 subsets zero it out. |
| the font's `name` table | only restates names ("Self Modern", designer "Lucas Le Bihan") — no structural signal |

Decisively: the live "Seriously Nostalgic" file itself (fetched from marinelayer.com's
CDN, `SeriouslyNostalgic-Regular.od0DjdTl.min.woff`, actually wOF2, 18,484 B) has
**panose all-zeros and sFamilyClass 0**. File-metadata inspection returns nothing for
the exact font in the bug report. A pure-Node woff2/woff/sfnt OS/2 reader was written to
establish this and then discarded. **Do not revisit without re-measuring.**

**What does work — the brand's own stylesheet says it outright.** marinelayer.com ships:

```css
.heading-1{font-family:Seriously Nostalgic,serif;font-size:50px;...}
```

The CSS generic beside the family IS the site author's classification of their own
typeface. `brandFontIngestService` already parsed these declarations and threw the
generic away (`firstConcreteFamily` skips past it by design). That is first-party
evidence, free, and needs no keyword treadmill.

## The change

- **`services/fontClassification.js` (new, pure — no I/O, network or DB).** The one
  serif/sans classifier. `SERIF_HINTS` now lives here instead of being hand-copied into
  two services with paired "must stay aligned" comments and nothing enforcing it. This
  does not breach the static/video boundary: what static must never require is the font
  RESOLVER (it fetches font FILES over the network); agreeing on what "serif" means is a
  pure string question.
- **`brandFontIngestService`** captures the generic (`genericFamilyIn`), puts it on each
  evidence row, and votes it **per (role, family)** into
  `websiteFontUsage.{heading,body,button}Generic`.
- **`directImageRenderService`** prefers a stored generic over the name default.
- **`scripts/backfillBrandFontGenerics.js`** (new, dry-run by default) for brands
  ingested before this. **NOT YET RUN — see Open below.**

### Traps found while building it

1. **The generic must be voted per (role, family), not per role.** Voting per role on
   the uncapped Marine Layer sheet tallies serif 72 vs sans-serif 72 — an arbitrary,
   rule-order-dependent tie (their heading rules name a serif display face, while a
   grotesque on other heading selectors plus a stale `--font-heading: "Seriously
   Nostalgic", sans-serif` variable pull the other way). Scoped to the family that won
   the role it is 72 vs 8.
   *Caveat recorded honestly:* under the pre-existing `evidence.slice(0, 30)` cap that
   production actually votes on, the live tally is serif 56 / sans 4 / Outfit-sans 4, so
   Marine Layer reaches the right answer under **either** scheme. The scoping is still
   correct (a generic describes one specific family) and is proven by a separate fixture
   where a display face is sometimes set without a fallback — the shape that makes a
   role-wide vote mis-classify it.
2. **The multi-sheet aggregation round-trip dropped it.** `ingestBrandFontsInner`
   re-serialises cross-sheet evidence as `selector{font-family:"family"}` and re-parses
   it so one scorer sees every sheet; without re-emitting the generic, `headingGeneric`
   came out null on every multi-sheet storefront.
3. **`!important` swallowed the generic** — found by adversarial edge-case testing of my
   own new code, not by review. `font-family: Brand, serif !important` tokenised to
   `serif!important`, which is not in `GENERIC_FAMILIES`, so the classification was
   silently dropped on exactly the declarations most likely to be authoritative — and
   Shopify themes use `!important` constantly. `familyStackTokens` now strips the
   priority flag first. Side benefit: a stack that is ONLY a generic
   (`font-family: serif !important`) previously came back as a concrete family literally
   named `"serif!important"`; it is now correctly treated as no concrete family.

### What the adversarial review found (Grok, high effort, two independent passes)

The first pass was invalidated twice by my own mid-review edits; the final pass ran
against a frozen commit and returned 15 findings. **Six were real defects in my own new
code**, all confirmed by executing them before fixing:

1. **`var(--f), serif` dropped the generic entirely — the worst of them.** The old
   substitution matched only a var() at the START of the value and ASSIGNED the
   variable's contents over the whole value, discarding everything after the reference.
   That is **Shopify Dawn's shape**, and Marine Layer is a Shopify store — so the fix
   was inert on a large share of real storefronts, including arguably the one it was
   written for. Replaced with iterative innermost-first substitution (depth cap 8 as a
   cycle guard), which also sees through chained properties
   (`--font-heading: var(--font-serif)`) that previously stored a literal
   `var(--font-serif)` as a family name, and drops unresolvable references instead of
   keeping them as families.
2. **`!important` inside a custom property value** still killed the generic — the strip
   ran before substitution. Now after, plus per token.
3. **The generic was the FIRST in the stack, not the terminal fallback.**
   `font-family: sans-serif, "Seriously Nostalgic", serif` classified the Didone as
   sans, from a token that is not its fallback at all. Now: only tokens after the first
   concrete family are considered, and among those the LAST one carrying a serif/sans
   signal wins — so `Brand Serif, monospace, serif` resolves to `serif` rather than
   returning the signal-less `monospace`.
4. **Internal whitespace made the stored key unfindable.** `font-family: Seriously
   Nostalgic, serif` (two spaces) stored the generic under `"seriously   nostalgic"`
   while the consumer looked up the `@font-face` name `"seriously nostalgic"` — ingest
   captured the answer and the read path could never find it. Both sides now key on
   `normalizeFamilyKey` (trim + collapse internal runs + lowercase), which also removes
   an inconsistency where `pick()` was case-sensitive and `pickGeneric` was not.
5. **`storedGenericForFamily` returned on the first role that matched the family**, even
   when that role recorded no generic — so a face named on `heading` without a fallback
   and on `body` with one returned null. Now it scans for the first role that matches
   AND has a generic.
6. **The backfill could persist a WRONG generic and then freeze it.** Its hand-rolled
   fetch loop did not follow `@import`, but ingest does — and themes routinely keep
   typography in an imported partial. So it could vote on a strict subset, write
   `sans-serif`, and never correct it (the never-overwrite rule). It now reuses ingest's
   own `collectStylesheets` (extracted for this) plus the shared scorer, so it cannot
   score differently from the pipeline. Separately, its "never overwrite" check was a
   **stale snapshot, not a write predicate**: a re-ingest landing inside its long
   network loop would be clobbered by an unconditional `$set`. Each field is now written
   under a filter requiring it to still be unset, and a lost race is reported.

**One defect I introduced by fixing (1), caught by re-checking the live site rather than
by review:** resolving custom properties correctly made the system font stack resolve,
and its only non-generic entries are the emoji fallbacks every CSS reset appends — so
`body` came back as **`Apple Color Emoji`**. That is worse than the `var(--font-sans)`
junk it replaced, because it is *plausible* junk that would be stored as the brand's face
and could be named to an image model. Added `NON_BRAND_FAMILIES` (emoji/symbol faces,
`-apple-system`, `BlinkMacSystemFont`); a system stack now correctly declares no brand
face. Live result went `var(--font-sans)` → `Apple Color Emoji` → **`Outfit`**, which is
the right answer.

**Also fixed: two comments that stated the OPPOSITE precedence of the code** — a landmine
I created when I inverted the ordering and updated the module header and docs but not the
call site in `directImageRenderService` or the harness's own C1 group header. A future
editor "fixing" the code to match those comments would have reintroduced exactly the
regression the ordering exists to prevent.

**Findings verified and NOT acted on** (pre-existing, unchanged by this work, recorded in
Open below): the 30-row evidence cap, `--*-font-family` matching the `font-family` regex,
native CSS nesting dropping a parent declaration, and a quoted family containing a comma.
Grok's independent pass confirmed no leak from `loadMutated` into `require.cache`, and
that C7-A/B/D/E discriminate.

### Precedence — the CSS generic deliberately does NOT outrank a keyword match

1. positive `SERIF_HINTS` match on the name → `serif`
2. first-party CSS generic → its class
3. `sans-serif` (unchanged default)

The obvious "freshest evidence wins" ordering was **rejected**: `font-family: Playfair
Display, sans-serif` is a real shape, and letting the generic win there flips a brand the
keyword list already gets right. On a prompt path this fragile (PR #61's video-prompt
hardening was rolled back in full) that is a bad trade. Tier 1 reads as "a recognised
serif type NAME wins" — the heuristic's `sans-serif` return is the *absence* of a signal,
which is the gap tier 2 fills.

**The invariant this buys is pinned as a property test:** no keyword-matched family can
change answer for ANY generic; every family that moves was previously the bare sans
default. That is the entire blast radius.

Known gap left alone: a MIS-matching keyword still wins — "Libre Franklin" is a sans
caught by the `libre` keyword (present for Libre Baskerville). Pre-existing; editing the
keyword list is its own measured change.

## Verification

- `scripts/verifyTypefaceClassification.js` — **128 checks**, incl. **10 revert-proof
  mutations** of the real shipped source (each compiled IN MEMORY and re-run, and
  asserted to break a specific check): dropping the generic tier restores the original
  defect; removing the role/family guard makes the body grotesque inherit the heading's
  serif; un-fixing the round-trip loses `headingGeneric`; role-only voting
  mis-classifies the serif display face; dropping the `!important` strip loses the
  generic again; restoring whole-value var substitution loses the Dawn shape's generic;
  removing the position filter takes a LEADING generic as the fallback; taking the first
  signalling generic instead of the terminal one resolves a conflicting stack the wrong
  way; dropping the whitespace collapse makes the stored key unfindable; and dropping
  `NON_BRAND_FAMILIES` reports an emoji font as the brand's face.
  **Two of these mutations initially failed to discriminate** because the mutants were
  not faithful reproductions of the old logic (substituting in place rather than
  assigning over the whole value; removing the position filter while leaving
  terminal-last selection). Both were rewritten until they actually reproduced the
  defect — a mutation that does not restore the bug proves nothing. The no-op guard in
  `loadMutated` also fired correctly three times when these rewrites moved anchor text.
- **One revert-proof was tautological, and an adversarial review caught it.** C7-C
  mutated the re-serialisation line inside `ingestBrandFontsInner`, but the check then
  re-implemented the round-trip itself with a hardcoded string that omitted the generic
  — so the assertion passed because the TEST omitted it, not because the mutation did.
  The mutation was irrelevant to what was measured. Fixed properly rather than papered
  over: the round-trip is now `aggregateFontUsageAcrossSheets`, a pure exported function
  that `ingestBrandFontsInner` delegates to, so C6/C7-C CALL shipped code instead of a
  copy of it. **Meta-verified**: reverting the real re-emit makes C6 fail
  (`headingGeneric` → null) and restoring it returns 91/91. The backfill now reuses the
  same function too, so it cannot score sheets differently from the pipeline.
  (`loadMutated` also throws if a mutation is a no-op, which fired correctly during that
  meta-verification — a stale anchor can no longer silently test the unmutated module.)
- **The mutation harness writes nothing to disk at all.** #259 (merged 2026-08-19, and
  the commit this branch rebased onto) established that verify scripts must not mutate a
  real repo file in place, because an unhandled `SIGTERM` runs no `finally` and leaves
  the file mutated; its fix was to write the copy under `os.tmpdir()`. `loadMutated`
  compiles the mutant in memory via `Module#_compile` with `filename` pointed at the
  real `services/` path — so relative requires still resolve, nothing is written
  anywhere, and there is no signal window at all. Verified: no write calls in the file,
  and 12 mid-run `SIGTERM`s leave the worktree clean with no stray files.
- `fallbackFor` semantics unchanged (`verifyFontFallback.js` pins `'Self Modern'` →
  `sans-serif` on purpose); `typefaceDirectiveForBrand` still sync, arity 1.
- **Cross-pipeline side effect checked and cleared:** `brandSignalText` flattens the
  whole `websiteFontUsage` object into the blob `BRAND_SIGNAL_RULES` match against, so
  new keys *could* have changed the video path's library pick. A 5,040-case sweep
  (category × tone × family × role × generic-set) shows **zero** changes; pinned as C5c.
- Ingest verified against the **real live stylesheet**, not a synthetic fixture:
  `heading: Seriously Nostalgic → serif`, `body/button: Outfit → sans-serif`.
- The backfill's whole derivation path (homepage → 14 inline blocks + 4 external sheets
  → merged evidence → re-score) run live against marinelayer.com: would write
  `headingGeneric: serif`. Only the Mongo write is untested.
- `npm run lint` clean. Full suite **175/175** (174 + this file).

## Open

- **`scripts/backfillBrandFontGenerics.js` has NOT been run.** Nothing changes for
  Marine Layer 2 or any already-ingested brand until it does — `Brand.fontIngestedAt`
  exists to stop the pipeline re-crawling storefronts, so there is no natural refresh.
  It is dry-run by default, writes only the three new fields, never overwrites an
  existing generic, and skips any role whose live family no longer matches what was
  recorded. Its Mongo write path is the one part not exercised. Suggest
  `--brand "Marine Layer 2"` first, then a wider dry run.
- Pre-existing, not touched: `firstConcreteFamily` can return a literal `var(--x)` as a
  "family" when the variable resolves to another var (one-level resolution only) — seen
  live as `body: var(--font-sans)` on marinelayer.com. The backfill's family-match guard
  skips those rather than writing a wrong generic.
- Pre-existing, not touched: `evidence.slice(0, 30)` caps what the family vote itself
  sees on a large stylesheet.
- Pre-existing, not touched (all confirmed in review, none introduced here): a family
  name containing `}` is truncated by the rule regex (`.h1{font-family:"Br}and",serif}`
  → `Br`); a quoted family containing a comma is split; `--heading-font-family: X` is
  matched by the `font-family` regex; and native CSS nesting drops a parent
  `font-family`. All are pathological or rare shapes, and the backfill's family-match
  guard refuses to write a generic when the derived family disagrees with the recorded
  one.
- The one-level `var()` limitation previously noted here **is now fixed** (see review
  finding 1) — chained custom properties resolve, and unresolvable references are
  dropped rather than stored as families.
