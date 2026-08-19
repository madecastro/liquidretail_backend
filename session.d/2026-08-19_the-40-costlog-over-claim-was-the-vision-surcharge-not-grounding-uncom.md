## 2026-08-19 — The 40% CostLog over-claim was the VISION surcharge, not grounding. UNCOMMITTED

Branch `fix/grounded-surcharge-overstatement`, worktree `.worktrees/cost-grounding-surcharge`,
off `8db473c6`. **PUSHED, PR OPEN: [#237](https://github.com/Emami-RS-Project/liquidretail_backend/pull/237)** —
not yet merged; rs-7c (traffic cop) is gating/sequencing. Coordinated with rs-7c (traffic cop) first — no open PR touches `costTracker.js`;
`fix/cost-run-attribution` touches only the meta/param plumbing, not `computeCost`.

**The starting hypothesis was wrong, and provably so.** `scripts/reconcileAtlasDailyCosts.js`
(#230) found 2026-08-17 claiming $4.7890 against Atlas's settled $3.4185 (+40.1%), with
`google/gemini-2.5-flash` holding $1.6520 of it against $0.3418 billed. The suspicion was the
`$0.035` grounding surcharge. It cannot have been: **all 132 of that day's rows for that model
carry `groundedRequests: 0`**, and they carry `cachedInputTokens: 0` too, so the cachedInput
`0.075 -> 0.03` correction landed in #230 could not move them either (recompute is identical at
both rates: $1.6520).

**Actual cause — `VISION_IMAGE_COST_PER_IMAGE_USD` double-charged.** 260 declared images x $0.005
= **$1.3000 = 99.2% of the $1.3705 gap**. The images it surcharged are the same images already
inside `usage.prompt_tokens`; the constant's own comment gave the figure in TOKENS ("85 / 765 per
tile"), which was the tell. Token-only math for those rows is $0.3520 vs Atlas's $0.3418 — a 3.0%
drift, in line with every other day. Cross-check that settles direction: if images were NOT in
prompt_tokens Atlas would have billed MORE than our token math; it billed LESS.

**Grounding was a separate, real, and larger-in-percentage bug — just invisible here.** Google's
1,500 grounded-prompts/day allowance applies to the PAID tier (re-read live 2026-08-19). Measured
volume: **19/day and 13/day — 1.27% and 0.87% of it**. Every grounded call in the window was free
and the ledger claimed **$1.1200 — 89.9% of all direct-Gemini spend recorded**. It could never
self-correct: grounded calls are pinned `provider:'gemini'` (Atlas cannot proxy Google Search
grounding at all, probed in #229) and the reconcile matches `provider:'atlas'` only, so **no
reconciliation this repo has ever had could see those rows.**

**Changes (3 files, hand-written — money-facing):**
- `services/costTracker.js` — `VISION_IMAGE_COST_PER_IMAGE_USD` -> `0` (env `VISION_IMAGE_COST_USD`);
  `GROUNDED_SEARCH_COST_PER_REQUEST_USD` -> `0` (env `GEMINI_GROUNDING_COST_USD`, unchanged
  mechanism). Added `GEMINI_GROUNDING_FREE_RPD` (1500) + `noteGroundedRequests()`, a per-UTC-day
  counter that alerts once when a process crosses 50% of the allowance. **Deliberately NOT
  per-caller**: the price is a property of Google's billing, not of the calling stage.
  **Deliberately does not auto-reprice** on crossing — the counter is per-process, so re-pricing
  off an under-count would understate, the exact failure being fixed.
- `scripts/verifyGeminiSearchCost.js` — 24 -> 27 checks. B2 inverted (was: surcharge == 0.035),
  B2b/B2c/B2d added, C2 rewritten (it previously asserted the surcharge DOMINATED the row — true of
  the arithmetic, false about our bill), C6 now leans on `costSource:'unknown'` rather than a
  non-zero surcharge. Also pinned `VISION_IMAGE_COST_USD` / `GEMINI_GROUNDING_FREE_RPD` in the
  env-delete block so an operator override cannot make the suite pass against an unshipped value.
- `docs/REVIEW_VENDORS.md` — per-lookup table $0.040 -> $0.005, with why.

**Proof.** Every new check revert-proven at the source one at a time: grounding 0->0.035 fails
B2/C2/C6/D1; vision 0->0.005 fails B2d; dropping the `GEMINI_GROUNDING_FREE_RPD` export fails B2b.
Suite **156/159 (serial)**; the 3 failures are ALL `require(path.join(__dirname,'..','node_modules','sharp'))`
(`verifyLogoColorPreservation`, `verifyLogoSilhouette`, `verifyStaticTextInk`) — a known
worktree-environmental gap (no `node_modules/sharp` here), confirmed identical on the unmodified
baseline. (A parallel `-P6` run additionally flaked `verifyArchiveDigestRelease` /
`verifyDirectorFallbackChain` transiently; both pass standalone with and without this diff — not a
real regression, just parallel-run noise on this machine.) Lint clean.

**Cross-checked independently by rs-7c (traffic cop) against production** — both root causes
confirmed to the cent from their own aggregation, and go-ahead given to commit + open the PR (their
remit; not a merge to main). Their review added one requirement, implemented: the code now
explicitly documents what happens if `groundingUsage.count` ever crosses the FULL allowance (not
just the 50% alert threshold) — deliberately still nothing, i.e. it stays at $0 and keeps alerting,
never auto-reprices, with the reasoning inlined at `GROUNDING_ALERT_FRACTION` so a future session
doesn't "fix" it into a silent surcharge. rs-7c also confirmed the grounding gap independently over
a WIDER window (08-12->08-19): 35 grounded requests = 95.6% of all direct-Gemini spend in that
window — worse than the 7-day figure above, same conclusion.

**Reconcile projection (repricing the same historical rows through the new constants):**
2026-08-17 **+40.1% -> +0.3%**; max per-day error **$1.3705 -> $0.5444**.

**HONEST CAVEAT — the 6-day aggregate error gets slightly worse: +1.6% ($0.8919) -> -2.3%
($1.3131).** That is two opposite-sign errors having cancelled. The vision over-charge was masking
a systematic **~2-3% UNDER-count on Atlas token rows present on every single day** (-0.2, -1.4,
-3.2, -0.8, -5.8%). Removing it leaves one consistent, diagnosable signal instead of two errors
that hid each other in the total. **FOLLOW-UP: nobody has explained that residual under-count.**
Leading candidate is Atlas's `prompt_thresholds` >200k tier, which `MODEL_RATES` does not model
(already noted at the `claude-sonnet-4.5` entry).

**NOT DONE:** not committed, not pushed, no PR — awaiting the owner's go-ahead. rs-7c offered to
gate and sequence it. A `backfillCostReconcile`-style repricing of HISTORICAL rows was not
attempted; this change is forward-looking only.

