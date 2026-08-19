## 2026-08-17 — `verifyAgentRegistry` GREEN. Five capabilities were DEAD, not dangerous.

Branch `claude/gallant-almeida-a7fb96`. The red harness on main is fixed; suite is **133 / 0**.
`verifyAgentRegistry` now **1579 / 1579** (was 1564/1567 — see the count note below).

**The reported symptom understated the problem, and the stated risk was BACKWARDS.** The brief
described one capability (`catalog.bulkDeleteProducts`) missing `estimateUsd`, with the risk being
"the agent can invoke a destructive bulk delete with no cost declaration". Both halves were wrong:

- **It was FIVE capabilities, not one** — `catalog.bulkDeleteProducts`, `catalog.bulkDeleteCategories`
  (both tier 4) and `detect.rematchCatalogProduct`, `detect.rematchByProduct`, `match.rescoreOnly`
  (tier 2). Grok swept all 110 manifest entries and I re-verified by live `require`; those five are
  the complete set. No other capability has this gap, and rules 3/4/5 (tier-3 phrase, workflow+method
  contradiction, declared-shape-vs-actual-exports) were already clean.
- **Nothing was running uncosted.** `spendGuard.check` fails **CLOSED** on a missing estimator
  (`spendGuard.js:81-87` → `allowed:false`), and `routes/agent.js` consults it at all three dispatch
  sites for `tier >= 2`. So all five were **refused at dispatch — dead, not dangerous.** The real
  cost was five silently non-functional capabilities plus a red validator masking future regressions.

**A THIRD failing check the brief did not mention, and it is the load-bearing one:**
`every Tier 4 capability declares execute.workflow=true`. In this registry **tier 4 is a STRUCTURAL
contract, not a danger label** — `splitByGate` (`routes/agent.js:277`) buckets on
`cap.execute.workflow === true`, **not on tier**. Both bulk-deletes were tier 4 while exporting a
single `run()`, so the entries were internally incoherent and `estimateUsd` alone could never have
turned the harness green.

**Resolution (owner chose the two-phase conversion over re-tiering to 3):** both delete executors are
now real two-phase workflows — a shared read-only `resolvePlan()` feeding `preview()` + `execute()`,
exports `{preview, execute}` matching the other 16 workflow modules. The operator now sees the
resolved blast radius (row count, a 10-row sample, `reversible: !hardDelete`, and for categories how
many extra rows cascade pulled in plus which targets were `refused`) **before** anything mutates.
Delete semantics are unchanged; the 500-row cap is re-checked in `execute()`, not just `preview()`,
so a set that grows between plan and confirm still cannot slip through.

**The `describe` text was also lying** — it claimed the operator "must confirm with the phrase gate",
but the phrase gate is the **tier-3** ceremony (`routes/agent.js` gates phrases on `cap.tier === 3`;
tier 4 is opt-in). Corrected in the same commit, per the CLAUDE.md rule about docs describing the
wrong mechanism.

**Cost basis for the three tier-2 estimators — planning-grade, NOT billing truth.** Grounded in the
repo's own published figures (`matchRescoreOnly.js:94`: *"~$0.005 spend vs ~$0.05"*), **not** an Atlas
`base_price` (CLAUDE.md §2 — base_price is not the charge). Constants live at the top of
`capabilityRegistry.js`: `DETECT_FULL_RUN_USD = 0.05`, `DETECT_RESCORE_ONLY_USD = 0.01`
(~$0.005 rounded **up** — spendGuard rejects when `spent + estimate > cap`, so overestimating fails
safe while underestimating lets a fan-out breach the cap).
`detect.rematchByProduct` is the only **function** estimator: `min(maxMedia, 100) × 0.05`, default 25
→ $1.25, max → $5.00. **Verified against the executor's real bound** (`HARD_CAP=100`,
`DEFAULT_CAP=25`, refuses when `medias.length > maxMedia`) across 14 arg shapes including `'abc'`,
`-5`, `null`, `1.9`, `5000` — it **never underestimates**; two shapes overestimate, the safe direction.

**A gap I found and closed while revert-proving — worth knowing.** `validateManifest` only checks
`typeof estimateUsd === 'function'`; **it never CALLS it.** An estimator returning `-1`/`NaN`/throwing
passed 1569/1569 clean, while `spendGuard.estimateFor` rejects the value at runtime and fails closed
— i.e. a **permanently un-dispatchable capability that nothing reports**, the exact "declared but
silently dead" class as the five above, and invisible to a source-text regex. New harness function
`checkFunctionEstimators()` now **invokes** every function estimator and asserts a finite `>= 0`,
plus pins the fan-out clamp arithmetic. Revert-proven: estimator returns `-1` → **5 failures**;
clamp removed (linear scaling) → **1 failure**.

**Why the check count went 1567 → 1579, since it will look wrong otherwise.** +2 is automatic: the
harness's scope-guard suite iterates executor entry points, so each delete executor went from
contributing one check (`run()`) to two (`preview()` + `execute()`). +10 is the new
`checkFunctionEstimators()`. The three original failures pass, and the negative-control checks now
list **only** the synthetic `_test_.*` fixtures in their "got" strings — the validator still rejects
planted violations, so nothing was weakened to go green.

**Lint note:** `npm run lint` reports **24 pre-existing `no-undef` errors**, all browser globals in
vendored `.cache/puppeteer/**` and `.drafts/ad-vision-qc/`. Measured identical with this branch's
changes stashed — **not introduced here**, and none in any touched file. Worth a separate decision on
whether to add those paths to `.eslintignore`, because right now `npm run lint` can never exit 0 and
the CLAUDE.md pre-push rule says to run it.

