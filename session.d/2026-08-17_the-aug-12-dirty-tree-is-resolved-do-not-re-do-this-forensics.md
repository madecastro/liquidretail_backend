## 2026-08-17 — THE AUG-12 DIRTY TREE IS RESOLVED. Do not re-do this forensics.

The `liquidretail_backend` checkout sat on branch `feat/video-intent-variants`, **26 commits behind
`origin/main`**, with 6 modified + 5 untracked files from 2026-08-12 and a handoff claiming
"3 harnesses RED, 116 pass / 3 fail". All of it is now adjudicated. **One item landed, the rest was
superseded and discarded.** The per-file verdicts, so nobody re-derives them:

| Aug-12 item | Verdict | Why |
|---|---|---|
| `services/aiCreativeDirectorService.js` | **LANDED — PR #201** | Director pricing-ban + promotional opt-in. Genuinely absent from main. |
| `config/defaults.env` → `DIRECTOR_PROMOTIONAL_STYLE=` | **LANDED — PR #201** | ditto |
| `scripts/verifyPromotionalOptIn.js` (new, 31 checks) | **LANDED — PR #201** | ditto |
| `scripts/verifySocialProofRestoration.js` (A3/A3b) | **LANDED — PR #201** | **Had to** land with it; see below |
| `services/campaignAdsGenerationService.js` | **DISCARDED** | Earlier hand implementation of what `b85cad5b` (#197) shipped |
| `services/concurrency.js` | **DISCARDED** | main moved 2026-08-13; tree would delete `REMOTION_QUEUE_CONCURRENCY` |
| `scripts/verifyConcurrencyConfig.js` | **DISCARDED** | edit of the pre-#186 harness; would delete Remotion coverage |
| `config/defaults.env` → `RENDER_CONCURRENCY=48`, `MAX_CREATIVES_PER_RUN=100` | **DECIDED — dropped 2026-08-17, then cap SUPERSEDED 2026-08-18** | cap is now 1000 (owner: "immediately remove the cap"); see NEXT-SESSION PROMPT §1 |
| `scripts/mintTestToken.js` (untracked) | **STILL UNLANDED** | see NEXT-SESSION PROMPT |
| `scripts/backlogStats.js`, `scripts/diagnoseCatalogIngestPath.js` | **left untracked** | local diagnostics, nothing depends on them |

**MERGED + DEPLOYED 2026-08-17.** #201 (`dca796a9`) and #202 landed; main is `a67e00dc` and BOTH
Render services (web `srv-d1vuktqli9vc73ft07ng`, worker `srv-d8128c1o3t8c73e8kb30`) went **live on
`a67e00dc`** at 22:09–22:10 UTC. `/api/health` OK. Full suite on merged main: **132 pass / 1 fail**
by exit code, the one failure being `verifyAgentRegistry` (the tier-4 `estimateUsd` gap, owned by a
separate session — not from this work). **That failure is now FIXED — see the section directly
below; the suite is 133 pass / 0 fail.**

**The Director leak was real and is now quantified.** Render logs for the 5 days before the deploy
carry **12 `directorRound: payload rejected, re-asking once` lines**, ~11 of them
`concepts[N].copy contains pricing or discount language`. Every one of those is a second PAID
Director call spent discovering a rule the prompt never stated. That is the recurring cost #201
removes; if any such line appears on a round minted after `a67e00dc`, the fix is not working and
that is the signal to look for.

**The 3 RED harnesses were a stale-tree artifact, not open defects.** All three pass on `origin/main`
as-is — measured this session: `verifyMixedPlatformVideo` **33/33** (G1 and the money-relevant H3b
included), `verifyPmaxVideoExpansion` **73**, `verifyPmaxFunnelVariants` **166/0**. So the "116 pass /
3 fail" figure in `HANDOFF-2026-08-12-generation-audit.md` describes a 26-commit-stale base and
**should not be treated as an open-defect list**.

**H3b's money defect is FIXED on main.** The tree carried a *second* Meta derivative mint block
(`expandWizardJob` hand-writing rows) that bypassed the kill switch and inflated the dry-run
estimate. Main has exactly one mint site: `planDeterministicVideoAds`, iterated once by
`expandWizardJob`. The tree was additionally **worse** in two ways — its dry-run added 3 PMax stages
while the mint loop only ran 2 (over-counting delivered ads), and its Meta intent mint was not gated
on `META_VIDEO_DERIVATIVES`, so flag-off still minted staged crop variants.

**Why the A3 coupling matters** (this will bite whoever next edits the Director style menu):
`verifySocialProofRestoration` A3 used to assert *"every enum member gets a criterion"*. Promotional
opt-in deliberately breaks that invariant, so **A3 fails with `no criterion line for promotional` the
instant the Director fix lands**. It is now the stronger form — every ALLOWED style carries a
criterion AND no disallowed style is advertised. Note the scope split, which is easy to get wrong:
gutting `creativeStylesFor` to return the full enum leaves **A3 green** (both sides move together —
it pins menu/helper *agreement*), and is caught instead by `verifyPromotionalOptIn` groups A/B/C,
which fail 10 checks on exactly that mutation. **Neither harness covers the other; keep both.**

### Two traps that cost real time here

1. **`NODE_PATH` is mandatory in a backend worktree.** `node_modules` is tracked in this repo but the
   committed copy is **incomplete**; a fresh worktree throws `MODULE_NOT_FOUND` on harnesses that
   looked like real failures (`verifyPmaxVideoExpansion`, `verifyPmaxFunnelVariants`,
   `verifyLogoSilhouette`). Run with
   `NODE_PATH=/Volumes/Sayulita/Projects/RS/liquidretail_backend/node_modules`. **Do not symlink it.**
2. **The full suite is 126 pass / 7 fail on CLEAN `origin/main`.** Those 7
   (`verifyAdVisionQc`, `verifyAgentRegistry`, `verifyChargePointLedger`, `verifyDirectorRoundPersist`,
   `verifyLogoSilhouette`, `verifyShopifyLadderBlocks`, `verifyVideoRetryOnUnbilledFailure`) are
   pre-existing or environmental (DB/network/missing module), **not** caused by any current branch.
   Always control-run them on clean main before blaming your change.

