# Legacy QC-gate removal — DRAFTED, NOT APPLIED

The one piece of owner-approved work left unfinished when the session ended. Everything
needed to finish it is in this directory. **Do not skip §2 — the prod prerequisite is
already done, which changes what is safe.**

## 1. What the owner approved

Verbatim: *"let's clean this up we don't need duplicate gates"* — then, on being asked which
end state: **exactly two gates** (`staticVisionQcEnabled`, `videoVisionQcEnabled`), remove the
legacy `adVisionQcEnabled` entirely, **and remove the new env vars from
`config/defaults.env` too** so the gates live ONLY in SystemConfig ("fewer places for the two
to disagree").

**My one deviation, flagged to him and not objected to:** remove both vars from
`defaults.env` but **KEEP the env-reading code** (`staticEnvEnabled` / `videoEnvEnabled` and
the shared `parseBoolEnv`). Removing the file entries is what kills the disagreement risk;
removing the *reader* would also delete the fail-closed fallback ("unconfigured → off") and
the only zero-deploy override if Mongo is unreachable. Revisit only if he asks for total
removal.

## 2. ✅ The production prerequisite is DONE — this is why removal is now safe

`{key:'default'}` in prod holds `staticVisionQcEnabled: true`, `videoVisionQcEnabled: true`,
`adVisionQcEnabled: true` (written and read back, `updatedAt 2026-08-21T03:29:12Z`).

So **the legacy bridge is no longer load-bearing** and can be deleted with no outage window.
Before the write it WAS the only thing keeping QC on in production — deleting it first would
have silently shipped every ad uninspected.

⚠️ **How that write had to be done, because the trap is general:** a Render one-off job runs
the **deployed** code, whose schema does not declare the new fields, and **Mongoose strict
silently drops writes to undeclared paths while reporting success.** The write therefore went
through the raw driver
(`mongoose.connection.db.collection('systemconfigs').updateOne`), not the model. Any future
expand-then-contract migration here needs the same treatment.

## 3. Files in this directory

| file | what it is |
|---|---|
| `DRAFT-hunks.md` | Grok (`grok-4.6`, `xhigh`) draft: exact old/new hunks, an `adVisionQcEnabled` reference list with keep/remove verdicts, a per-harness plan, and its own reasoning that the result fails CLOSED. **UNVERIFIED — I never applied or reviewed it.** |
| `prodsim-probe.js` | **The important one.** My offline prod-state simulation. Run this before AND after the removal. |
| `adversarial-authz-partial.md` | A `xhigh` adversarial review of the members-authz guard, **still running when the session ended — possibly truncated/incomplete.** Independent of this removal; kept only so it isn't lost. Its questions were largely answered by a peer's independent read (see `2026-08-21_authz-review-and-concurrency-boot-timing.md`). |

## 4. How to finish it

1. Work on `feat/admin-settings-qc-gates` (tip `f8a87b4d`), rebased onto current `main`.
2. **Run `prodsim-probe.js` FIRST, to establish the baseline.** Copy it into the worktree root
   (it needs the repo's `node_modules` to resolve `dotenv`) and run
   `node ./prodsim-probe.js "$PWD"`. Expect both resolvers `true`.
3. Apply the hunks. **Cross-check every one by hand** — it is gating code that controls
   billable vision calls, and nothing delegated ships unchecked here.
4. **Re-run the probe. Both resolvers must still return `true`.** With the legacy field gone
   they should now resolve from the real `staticVisionQcEnabled`/`videoVisionQcEnabled` values
   rather than the bridge. If either goes `false`, **stop** — that is QC silently off.
5. Full suite (184 scripts, currently green) + `npx eslint .`. macOS has no `timeout` binary;
   never wrap the suite loop in it.
6. Deleting the legacy path WILL break harnesses that assert on it. `DRAFT-hunks.md` proposes
   per-file whether to delete a now-meaningless check or re-point it at the new gates.
   **Never weaken a check to make it pass** — if a check has to go, say why it is meaningless
   rather than inconvenient.

## 5. Constraints that must survive

- `PASS_FLOOR` (7) and `MAX_QC_REGENERATIONS` (1) unchanged.
- The pipeline asymmetry unchanged: **static may regenerate ONCE** then fail the ad;
  **video NEVER regenerates** (a master is ~$0.90 and the defect is baked into the clip) — it
  flags, and can mark failed while KEEPING `renderUrl`.
- Do **not** touch `parseVerdict` — `fix/qc-verdict-parser-tolerance` (`f005f3c7`) owns it and
  merges separately.
- Do **not** touch `routes/members.js`, `routes/invitations.js`, or
  `services/capabilityExecutors/` — other branches own those.
- **A harness subtlety that will waste an hour otherwise:** `runPostRenderQc` /
  `runVideoPostRenderQc` call their resolver as a **same-module lexical reference**, so
  monkey-patching `qc.resolveStaticEnabled` from a test does **NOT** intercept them. The
  interceptable hop is `require('./systemConfigService').getStaticVisionQcEnabled`, a live
  property lookup on a shared module object. Established empirically.
