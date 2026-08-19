## NEXT-SESSION PROMPT

<!-- Both 2026-08-17 items are now DECIDED. Nothing here is blocking; §1 is kept as the
     rationale record for a values change the owner may revisit. -->

**2026-08-17 — the Aug-12 tree is fully resolved. Both survivors were decided the same day.**
Full forensics in the 2026-08-17 section at the top of this file; do not re-derive it.

- **§1 concurrency 48/100 — DROPPED (owner decision, 2026-08-17).** Not landed, deliberately. Keep
  the section below as the record if it is ever revisited: it holds the exact values, the four
  blockers, and the money notes. Do **not** treat it as a pending task.
- **§2 `mintTestToken.js` — LANDED, PR #202** (owner approved 2026-08-17 after review).

### 1. `RENDER_CONCURRENCY` 24→48 and `MAX_CREATIVES_PER_RUN` 20→100 — DROPPED 2026-08-17, record only

**SUPERSEDED 2026-08-18 (owner directive: "immediately remove the cap on max creatives per run")** —
`MAX_CREATIVES_PER_RUN` is now **1000** (effectively uncapped), landed via branch
`fix/uncap-max-creatives-per-run`. The 2026-08-17 drop decision predated PR #197's video-count
tripling, which made an Everything run mint 21 videos/product — so `selectAdsForRun`'s video-first
tier 0 filled the whole 20-cap and delivered ZERO statics, the live owner-reported bug this
reverses. `RENDER_CONCURRENCY` stays 24 (now a wave size, no longer non-binding); F13 in
`verifyNoStrandedQueued` and `verifyConcurrencyConfig`'s relational check were deliberately
rewritten in the same commit.

The original rationale: *"expandWizardJob mints the full promised set but selectAdsForRun claimed only
20, and queued ads never auto-drain — a measured Everything (Meta+PMax) run minted 34 and stranded 14
statics in queued forever while the wizard promised 34."*

**That rationale is now half-obsolete.** `2284f8ec` (#189) closed the leftover hole a different way —
honest `mintedTotal` notice plus a 24h archive. The mint-vs-claim **gap is still real** on main (mint
200-class, claim 20), so raising the cap remains a legitimate *product* choice ("one Generate renders
the whole kit"), but it is no longer the only fix for stranded ads.

**It cannot be a silent env bump. Four things block it:**

- `scripts/verifyNoStrandedQueued.js:468` — **F13 `MAX_CREATIVES_PER_RUN was not raised (that hides the
  symptom)`**. Raising the cap fails this by design. It must be deliberately rewritten, with an
  argument for why a cap raise is no longer symptom-hiding now that claim ≥ typical mint.
- `scripts/verifyConcurrencyConfig.js:78-80` — asserts `RENDER_CONCURRENCY is 24` **and**
  `RENDER >= MAX_CREATIVES_PER_RUN`. 48/100 fails both. Note 48 < 100, so the relationship inverts;
  the tree's replacement label was *"a wave size under the run cap, not non-binding"*.
- **Do not port the tree's `verifyConcurrencyConfig.js`** — it is a pre-#186 edit that would delete
  main's `REMOTION_QUEUE_CONCURRENCY` coverage and re-pin `VEO_TITLING_CONCURRENCY` to 4 (main is 48,
  and `12 > 48` is false, so the tree's veo-split assertion would fail outright). Write a fresh delta
  on main's A-block and **keep every Remotion assertion**.
- **The Aug-12 tree contained the exact config lie the A-block exists to catch**: `defaults.env` said
  `RENDER_CONCURRENCY=48` while `concurrency.js` `SPEC.default` stayed **24**. If these values land,
  move the file **and** the code default together (CLAUDE.md §4a).

**MONEY:** per-ad price does not change — only in-flight depth, wall-clock and burst rate. But check
`ALERT_HOURLY_SPEND_USD` (25) against a real 100-ad CostLog hour, re-tune `ALERT_RUN_STALE_MIN` (45,
tuned against a 20-ad batch), and note `REMOTION_QUEUE_CONCURRENCY=4` runs Remotion **in the web
process** — a 100-ad wave's RSS behaviour has never been measured.

### 2. `scripts/mintTestToken.js` — LANDED 2026-08-17 (PR #202)

Landed in PR #202 after review. It had existed **only** in the local checkout — absent from `origin/main`. `ui-smoke` uses it as the
offline JWT signer *and* as the marker `repo-paths.js` validates the backend root against, so the QA
harness cannot run on a fresh clone. Committing it is consistent with the skill's own documented
design (it deliberately has no HTTP token endpoint; an offline signer needs the Render credentials,
which is already the trust boundary) — but it is a **token-signing script**, so it is the owner's call.
The file is preserved in the local checkout meanwhile; landing it is a one-file commit.

