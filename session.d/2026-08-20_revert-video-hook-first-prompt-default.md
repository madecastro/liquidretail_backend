# 2026-08-20 — Meta video prompt reverted to pre-standardization text, applied to PMax too

Branch `fix/revert-meta-video-prompt`, off a clean worktree at `origin/main`
(`110837df`, #268 "Downscale static ad-grid tiles"). PR: see repo PR list for
this branch.

## The ask

Owner, verbatim: *"we want to revert the change i made to the prompt being
used for Meta videos. I want to go back to the prompt I was using before we
standardized on the pmax prompt but stretch it to 10s. Also, I want to use
this same prompt for PMax for now also."*

This is a revert of the 2026-08-18 standardization (commit `f295b827`,
"standardize Meta onto the hook-first camera prompt") — see CLAUDE.md §00 for
the full layered history (PR #61 rollback → 2026-08-18 standardization → this
revert).

## Archaeology (delegated to Grok, `--effort medium` then `--effort high`,
`--sandbox read-only`, two focused calls rather than one giant prompt)

Found the exact standardization commit via `git log -S` on the prompt-profile
selector in one step (`f295b82741fc40d7b9cf1208cfb17027410e9e5`, merged to
`main`), then had Grok trace `services/veoPromptBuilder.js` end to end and
separately audit every harness that touches the switch, before changing
anything. Key findings, each independently re-verified by hand (not just
trusted from the agent):

- There was **never a separate `META_DIRECTIVES` constant**. Pre-standardization,
  Meta simply had no destination-specific profile and fell through to
  `OMNI_DIRECTIVES` (the same frozen text the PR #61 rollback pinned at
  `134db56~1`). "The old Meta prompt" = `OMNI_DIRECTIVES` + the frozen
  Ken Burns Scene 1/2/3 timeline in `buildVeoPrompt`'s final `else` branch.
  PMax had its own `PMAX_DIRECTIVES` profile. `f295b827` did not rewrite any
  directive text — it renamed `PMAX_DIRECTIVES`→`HOOK_FIRST_DIRECTIVES` /
  profile `'pmax'`→`'hook_first'` (byte-identical fields, confirmed by diff)
  and made `promptProfileFor` route **Meta** onto that same profile too, gated
  by kill switch `VIDEO_HOOK_FIRST_PROMPT` (legacy alias
  `PMAX_VIDEO_DIRECTIVES`), default `true`.
- **The kill switch already reverts both platforms when off** — this was
  already true and documented (CLAUDE.md, `docs/PIPELINES.md`) before this
  session: `isHookFirstVideoDestination(dest) && isHookFirstVideoPromptEnabled()`
  gates the `hook_first` branch for **both** `meta_*` and `pmax_video_*`
  destinations identically. So the entire owner ask reduces to: ship the OFF
  arm as the default, for both names, in `config/defaults.env`. No change to
  `services/veoPromptBuilder.js` itself.
- **"Stretch to 10s" needed zero prompt-text change.** `buildVeoPrompt`'s
  Timeline/Scene/Output sentences interpolate `durationSec` (`t1 = dur/3`,
  `t2 = dur*0.64`, `dur.toFixed(1)`) rather than hardcoding seconds — true of
  BOTH the frozen (`else`) branch and the `hook_first` branch. Separately,
  Meta and PMax were already both flooring `durationSec` to 10 before this
  change (`campaignAdsGenerationService.resolveVideoDurationForFormat`,
  `config/defaults.env: META_VIDEO_DURATION_SEC=10`; PMax hardcoded
  `GOOGLE_PMAX_VIDEO_DURATION_SEC=10`) — a wholly separate axis from which
  prompt profile is selected. So the frozen prompt already renders
  `Timeline (10.0s): Scene 1 (0.0–3.33s) … Scene 3 (6.40–10.0s)` once
  selected; confirmed live (see Verification below). This was flagged in the
  task as a likely no-op, and it was.
- **The UI-chrome hallucination guard (PR #262, `VIDEO_PROMPT_UI_CHROME_GUARD`,
  default ON) is untouched and unaffected.** It is spliced into the assembled
  `lines` array via `lines.push(UI_CHROME_GUARD_LINE)` **after** the
  profile-specific directive object is consumed, gated on its own separate
  env var — never inside `OMNI_DIRECTIVES`/`GROK_DIRECTIVES`/
  `HOOK_FIRST_DIRECTIVES`. It applies identically regardless of which profile
  is selected. Confirmed present in both the Meta and PMax printed prompts
  below.

## What changed

**`config/defaults.env`** — the only functional change:
```
VIDEO_HOOK_FIRST_PROMPT=false   # was true
PMAX_VIDEO_DIRECTIVES=false     # was true
```
The switch itself, its two arms, `OMNI_DIRECTIVES`/`GROK_DIRECTIVES`/
`HOOK_FIRST_DIRECTIVES`, and the UI-chrome guard are all byte-for-byte
unchanged — only the shipped default flipped. Fully reversible: set either
name back to `true` to restore the 2026-08-18 standardization for both
platforms with no code change.

**Harnesses** (no assertion logic changed — every existing check either
already set the switch explicitly per-arm or stubbed the function; confirmed
by reading each one, not just running them):
- `scripts/verifyPmaxPromptOverlay.js` — added **V2c**, a new check reading
  the real `config/defaults.env` text and asserting both names are `false`
  (mirrors `verifyPostPilotBatch.js` C14's pattern for
  `REPEAT_PRIMARY_REFERENCE`). Hardened `loadVeoArm` to set BOTH switch names
  on an explicit arm (previously only the legacy name), and end-of-file
  cleanup to delete both. Updated stale comments that called the ON arm "the
  defaults.env shape" (it no longer is).
- `scripts/verifyLifestylePreserve.js` — `loadVeo` now also sets
  `VIDEO_HOOK_FIRST_PROMPT` when an explicit `pmaxVideo` arm is requested
  (previously only the legacy name), same hardening rationale.
- `scripts/verifyPmaxSplitPromptDirectives.js` — explicitly forces the ON arm
  now (it implicitly relied on the code-level ambient default before; that
  default is unchanged, but the file no longer depends on it being unchanged).
- `scripts/verifySharedPortraitMaster.js` — comment/footer text only (the
  header block and the closing `console.log`), correcting "$1.80" from an
  unconditional-sounding claim to naming which arm produces which cost. No
  assertion changed; F1/F6/C1 already pinned both arms correctly.
- `scripts/verifyPostPilotBatch.js` — **no change**; B14–B17 already isolate
  the switch per arm via `withSwitch(...)`, confirmed by direct read.

**Docs** — `CLAUDE.md` §00 and `docs/PIPELINES.md` §6 updated in place (not
appended) to state the new shipped default alongside the still-true history of
both prior layers (PR #61 rollback, 2026-08-18 standardization), and to flag
the one real side effect below. Do not delete the 2026-08-18 section — the
switch and its ON arm are still fully live code, just no longer default.

## The one real consequence — not a bug, must not be "fixed" here

A mixed Meta+PMax run's shared-9:16-master saving
(`resolvePortraitMasterFormat`, `campaignAdsGenerationService.js`) fails
closed on its 4th conjunct (`isHookFirstVideoPromptEnabled() === true`) once
the switch defaults to OFF. **Mixed runs now bill 3 masters / $2.70 by
default again, not 2 / $1.80.** This is the existing, already-tested
fail-closed design (`verifySharedPortraitMaster.js` F1/F6) doing exactly what
it was built to do — the conjunct's logic was not touched, only which arm is
the boot default. `routes/ads.js` / `campaignAdsGenerationService.js` are
explicitly out of this session's lane (other work was live there) and were
not touched. Flip either switch name back to `true` to restore the $1.80
shared-plate path.

## Verification (no generation — printed prompts only, ~$0.90/master avoided)

Loaded the real `config/defaults.env` via `dotenv` in a throwaway `node -e`
script (not committed) and called `promptProfileFor` + `buildVeoPrompt`
directly:

- `VIDEO_HOOK_FIRST_PROMPT` / `PMAX_VIDEO_DIRECTIVES` both read `"false"`.
- `promptProfileFor(..., {platformFormat:'meta_stories_9_16'})` → `'gemini-omni'`.
- `promptProfileFor(..., {platformFormat:'pmax_video_9_16'})` → `'gemini-omni'`.
- Built prompts for `meta_stories_9_16` and `pmax_video_9_16` at
  `durationSec:10` are **byte-identical to each other** (3,889 bytes) and
  open with the frozen `Role:`/`Objective:` text, contain
  `Timeline (10.0s): Scene 1 (0.0–3.33s): slow horizontal pan left→right,
  ~10–15% movement. … Scene 3 (6.40–10.0s): … Maintain center framing.`,
  the UI-chrome guard sentence, and close with `Output: 10.0s duration. …`.
  No `HOOK-FIRST`, no `centre-safe`, no `Frame (9:16 vertical):` line — i.e.
  genuinely the pre-standardization text, not a relabeled hook-first prompt.

## Gate

- `npm run lint` — clean (0 findings; the repo's one active rule is `no-undef`).
- Full offline suite, `for f in scripts/verify*.js scripts/verify*.mjs; do
  node "$f" || echo FAIL "$f"; done` — **180/180 scripts pass**, including
  every harness listed above, both before and after the harness edits.
  (Fresh worktree needed `npm install --no-save https-proxy-agent@5.0.1
  jsonwebtoken` first, per the standing repo trap — restored
  `node_modules/.package-lock.json` afterward so it stayed unstaged.)
- Not run: `npm test` (`scripts/runVerifySuite.js`, the newer parallel
  runner per this file's CURRENT STATE section) — the plain per-script loop
  above already covers every `verify*` script; if `npm test` runs anything
  additional, re-check before merge.

## Not done / explicitly out of scope

- Did not touch `routes/ads.js`, `campaignAdsGenerationService.js`, or the
  frontend — other sessions were live there; this session's lane was the
  prompt builders and their harnesses only.
- Did not attempt to decouple the shared-portrait-master saving from the
  hook-first switch (e.g. giving it its own independent flag) — that would be
  a design change to money-adjacent logic outside this session's brief. The
  $2.70-by-default consequence is flagged, not engineered around.
- Did not run a live Omni generation to visually confirm the video output —
  explicitly forbidden by the task brief (~$0.90/master; a paid E2E was
  already running elsewhere). Verification is print-only, against the same
  `buildVeoPrompt` function production calls.
