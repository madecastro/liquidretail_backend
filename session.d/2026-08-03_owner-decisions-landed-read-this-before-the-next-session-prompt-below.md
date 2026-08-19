## 2026-08-03 — OWNER DECISIONS (landed). Read this before the next-session prompt below.

Five owner decisions from 2026-08-03. Items 1–4 shipped in `be5b83f` (on `main`); item 5
(Render secrets-only migration) is a live dashboard change + the doc pass that records it.
**Verify each item against the code — several reverse advice written earlier in this same file.**

1. **Static seed default = THE FIRST IMAGE THAT CAME FROM THE CATALOG.** Not the `imageRole`
   `'hero'` label. Owner: *"I actually just want to use the first image that comes from the
   catalog not the 'hero' image since that may also come from social media or UGC?"* The label
   itself is never stamped on UGC (only `catalogProductDetectService.js:60` writes it, from
   `CatalogProduct.imageUrl`) — but it can be **absent**, and the old predicate then fell through
   to the shotType ranking, whose pool merges catalog with `product_match` UGC, so the default
   could be a UGC post. Implemented as `preferFirstCatalogImage` + `promoteFirstCatalogImage`
   cascade: hero stamp → earliest-`createdAt` catalog entry → nothing. Mirrors the proven
   cascade at `campaignAdsGenerationService.js:2085`.

2. **VIDEO: the whole of PR #61's prompt work is ROLLED BACK.** All three parts — Scene 3
   return-to-primary, the crossfade/long-dissolve policy, AND `subjectContinuity`. Owner:
   *"This is creating additional hallucinations and the previous output was better."* Acceptance
   test is mechanical: the prompt built from `services/veoPromptBuilder.js` must be
   **byte-identical** to the prompt built from `134db56~1`. Only intentional differences are the
   `OMNI_DIRECTIVES`/`GROK_DIRECTIVES` module exports (harness plumbing) and comments.
   **The restored old prompt is self-contradictory on purpose** — `transitions` permits ~0.25s
   crossfades while `doNot` bans "dissolves". Owner-confirmed: that contradictory prompt is the
   version that produced better output. DO NOT "repair" it.

3. **VIDEO: primary-ref repeat is OFF by default.** Both the code default
   (`isRepeatPrimaryReferenceEnabled`) and `config/defaults.env`. Default stack = the first
   **three distinct** references, nothing appended. Capability kept reachable via
   `REPEAT_PRIMARY_REFERENCE=true` for a future A/B; `REPEAT_PRIMARY_TOTAL_CAP` (=4) applies
   **only** to that opt-in path. On the default (flag-off) branch the hard ceiling is
   `MAX_DISTINCT_REFERENCES=5` (`atlasVideoService.js:813`) — turning the repeat off had
   removed the only clamp. Full PR #61 camera-prompt rollback is also landed (all three
   pieces; B14 byte-identity pin) — see CLAUDE.md §00 and `docs/PIPELINES.md` §6.

4. **UGC ads must not be affected — "we haven't optimized that path yet" (owner).** Concretely:
   - brand-only runs (`isBrandOnly`) → promotion skipped, UGC can still win index 0. Unaffected.
   - operator-picked media (`restrictToMediaIds`) → promotion never applied. Unaffected.
   - product mode, no picks → seed is now always catalog, so the ad is `product_image` where it
     could previously have been `ugc`. **Deliberate** — this is the same UGC-as-default worry as
     item 1.
   - **static regenerate** (`REGEN_RESEED_CATALOG_FIRST`, default ON) gates on
     `variantKind === 'product_image'` and skips non-empty `referenceMediaIds`. Built in
     `be5b83f` — see below.

5. **Render env migration COMPLETE (2026-08-03).** Owner: *"The dashboard in render should
   only contain secrets, everything else should be editable outside of the dashboard."*
   WEB 64→23, WORKER 24→14. Every deleted key matched `config/defaults.env` identically
   (no-ops) **except `RENDER_CONCURRENCY`** (dashboard 4, file 8) — deleting the dashboard
   pin made **8 live**. `JIRA_PROJECT_KEY` retained (not a secret, not in the file). Canonical
   write-up: CLAUDE.md §4a; stays-in-Render list: `docs/PIPELINES.md` §9.
   ⚠️ **Precedence still matters forever:** `index.js:1-5` / `worker.js:18-20` load process
   env FIRST; dotenv never overrides. A dashboard var of the same name still shadows the
   file. Diagnostic: compare the dashboard list against
   `grep -oE '^[A-Z_][A-Z0-9_]*=' config/defaults.env`.

**BUILT — catalog-first reseed on static regenerate (`REGEN_RESEED_CATALOG_FIRST=true`).**
Was "NOT YET BUILT" earlier the same day; shipped in `be5b83f`. `adRegenerateService.js`
re-derives via imageRole hero → earliest-`createdAt` catalog entry → nothing (every query
pinned to `source:'catalog-product'` + ad product + ad brand). **NOT a trim** of
`mediaIds[0]` (historical stacks are lifestyle-first over catalog+UGC, so [0] is often UGC).
Gates: `variantKind==='product_image'` only; operator `referenceMediaIds` always wins;
catalog VIDEO never selected; missing `fileUrl` is an honest skip; **nothing persisted**
back onto the Ad so the kill switch stays effective. Pinned by
`scripts/verifyRegeneration.js` (R3/R3b/R3c).

**Reference count is COST-NEUTRAL** (measured, not assumed): flat price per submit, no
`images.length` multiplier (`atlasImageService.js:75-104`). What multiplies spend is the Meta
static SIZE fan-out (3 surfaces = 3 submits). So all of the above is quality, not spend.

**Grok CLI headless CAN read files** — `-p --always-approve --sandbox read-only` executes read
tools (verified on 0.2.117). §0.29996's claim that it never executes tool calls is WRONG; that
was `--permission-mode acceptEdits`. Writes from headless remain unproven — use subagents to edit.

---

