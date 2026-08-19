## 2026-08-12 — rating provenance (Gemini must commit; sourced wins when flagged, never at the cost of printability)

Owner: *"Let's ask gemini to always get provenance, and yes scraped is better
than something unsourced."* Hole: `pickBestRating` could print a `source: null`
number because both pass-2 schemas made `source` optional and both assemblies
fold the legacy single rating in as unsourced.

**First draft rejected by adversarial review — two real bugs, both fixed
before this landed:**

1. **Schema/prompt were always-on, not flagged.** Making `source` a required
   schema key unconditionally is itself an I/O change with an unmeasured live
   outcome: faced with a required field it cannot fill, the model may DROP the
   unattributed aggregate rather than emit `null` — this file already
   documents that exact behaviour for the `ratings` array itself (optional →
   Gemini omits it entirely). A dropped aggregate never reaches the ranking
   gate, so "flag off" would not have meant "today's behaviour". Fixed:
   `ratingsItemRequiredKeys()` / `ratingsProvenanceAskSentence()` are pure,
   exported, **shared** builders that both pass-2 call sites use — flag off
   returns exactly `['rating']` and an empty prompt addendum, byte-identical
   to pre-change.
2. **The "fail-safe" was not one.** The first draft narrowed to the sourced
   rows whenever ANY row had a source, on the theory that "this can never take
   a brand's rating away." Adversarial review produced the case: Trustpilot
   2.5/126 + WorthEPenny 3.2/22 (both sourced) alongside the legacy fold-in's
   4.58/15,626 (always unsourced). Flag off prints `4.6`. The naive gate
   picked 3.2 — **under the 4.39 display floor, so the ad printed no stars at
   all.** Fixed: the gate now compares the sourced pool's winner against the
   open pool's winner using the SHIPPED display oracle
   (`ratingDisplay.formatDisplayRating`, incl. the volume exception) and
   stands down — ranks over every row, sourced or not — whenever narrowing
   would trade a printable rating for an unprintable one. Provenance decides
   between candidates we would actually print; it does not get to silence the
   line. Logged distinctly (`STOOD DOWN`) from an ordinary set-aside.

**Also added:** a source string that names nothing is not provenance —
`isRealSource()` denylists placeholders (`unknown`, `n/a`, `null` the literal
word, `none`, `web`, `various`, …) so a garbage string cannot out-rank a
genuinely unsourced candidate under the flag.

Always-on (not flagged, and now proven so — see below): both `ratings.items`
require `rating`; `source` joins it only when `RATING_REQUIRE_PROVENANCE=true`,
and stays **nullable** either way (a forced non-null string would make the
model invent a site name — worse than an absent one, because it looks
auditable and isn't). Both structure prompts carry the provenance demand only
when the flag is on.

Opt-in ranking, same flag: a sourced-AND-printable candidate beats an
unsourced one. Two-tier owner ranking (biggest credible sample / more stars)
is unchanged and runs over whichever pool the gate lands on. `ratingCandidates`
keeps every row regardless of outcome — narrowed, stood-down, or fail-safe.

Harness: `scripts/verifyRatingProvenance.js`, rewritten to **29 checks** —
F-section now calls the shared builders under each flag state instead of
regexing a value that stopped being a source-text literal once it moved
behind the flag (the exact class of harness gap the review flagged: "harness
never calls Gemini" / "checks that cannot fail"). New C-section pins the real
fail-safe (the regression case above, both directions) and G-section pins the
garbage-source denylist. Existing N10 pin in `verifyQuoteRetrievalDirective.js`
updated to assert delegation to the shared builder rather than a hardcoded
literal (structural, flag-agnostic — the flag's own on/off behaviour is
verifyRatingProvenance's job now).

Verified beyond the harness: flag-off measured equivalent to `origin/main`'s
`pickBestRating` across **500 candidate sets** (ratings incl. 0/negative/>5,
counts incl. null/0, sources incl. null/whitespace/placeholder strings) — 0
differences, throw-for-throw. Revert-proven on the two regression fixes plus
the denylist and the flag-gating itself (4 mutations, each turns a distinct
check red) — see `verifyRatingProvenance.js` header for the full list.

⚠️ **NOT yet measured live:** that Gemini, when the flag is ON, accepts
`required: ['rating','source']` + `nullable: true` on `source` and answers
with a real site rather than more nulls or a dropped aggregate. This is now
genuinely opt-in risk (flag-off carries none of it), but the first live
enrichment with the flag on should still be checked for a rise in
`source: null` or fewer aggregates than pass 1's narrative listed.

