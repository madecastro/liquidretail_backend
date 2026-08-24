## 2026-08-24 — Slack run-feed requester-name regression, fixed; automated runs now labeled

Branch `fix/slack-requester-name-and-automation-label`, built in a fresh worktree
(`.wt-slackfeed`) off `origin/main` at `ba99a59f` (PR #329). Not self-merged, not deployed.

### The report

Owner: *"In slack messages I am not seeing the username of the person that requested
generation as I was before. If it's part of a test run then please identify the Claude
session name."*

### Which cause it actually was — MEASURED, not assumed

Two candidates were laid out before starting: (a) the parent-message tick never happens on
the adgen-handoff path, so a raw id shows and never upgrades; (b) `run.requestedBy` is
genuinely null at the call site, so nothing shows at all. **It was (a).** Confirmed two ways:

1. **Code trace.** `routes/ads.js:runRenderLoop` calls `runFeed.startRun()` exactly once with
   `requestedBy: run?.requestedBy` (a raw ObjectId, no label), then hits
   `if (isAdgenRendererEnabled()) { ...; return; }` — true on 100% of production runs. The
   SECOND, enriched call (the one that resolves `User.displayName` and re-calls `startRun`
   with `requesterLabel`) sat AFTER that `return` — dead code in production. Traced to PR #328
   (`b7b8cae6`, merged same day), whose own commit message documents hoisting the bare call
   above the handoff return but explicitly reasons "on the handoff path this is the only call,
   so the short id is what shows" — i.e. the author saw this exact gap and left it, believing
   (per the commit prose) the short id was an acceptable interim state, not realizing it was
   fully permanent (see next point).
   Also checked whether `loadLiveSnapshot`'s separate, later-tick enrichment (the ORIGINAL
   fallback path from PR #226) could rescue this — it cannot: it only fires when a later
   `onStage`/`noteEvent` call marks the run's parent dirty again, and on the handoff path
   nothing in the backend process ever does (adgen is a separate service with no call into
   this in-process `runFeedService` state). So the parent posts once and is never refreshed.
2. **Production evidence, via two read-only Render one-off jobs on WEB (`MONGODB_URI` already
   in that env) + Render log/env inspection, not just code reading:**
   - `CampaignRun.requestedBy` populated: 29/30 recent runs (96.7%), 27/27 today (100%) — so
     it is NOT null-at-source; cause (b) is ruled out.
   - `CampaignRun.slackFeed.ts` populated: only for runs AFTER 2026-08-24T18:36:33Z (PR #328's
     live deploy) that actually rendered ads — confirming #328 already fixed "the feed never
     starts at all" half, and everything since is the narrower "starts once, to a raw id,
     never upgrades" bug this PR closes.
   - `🔀 ... ADGEN handoff` log lines present on every substantive run today; `ADGEN_RENDERER_ENABLED=true` confirmed live on WEB; zero `📡 runFeed:` warning lines (the feed is not
     erroring, it is just never re-posting).
   - `SLACK_BOT_TOKEN` / `SLACK_ALERT_CHANNEL_STATUS` both effectively SET on WEB.

### Fix 1 — restore the requester's name

Hoisted the brand-name + human-`displayName` resolution (the `Promise.all` in
`runRenderLoop`) to run BEFORE the adgen-handoff early return, alongside the `startRun` call
PR #328 had already hoisted — and consolidated to a SINGLE `runFeed.startRun()` call, already
fully resolved, instead of "post fast now, upgrade later" (a shape that was structurally
unreachable on the handoff path and is now unnecessary: the lookup is one cheap Mongo
round-trip, already off the request's critical path — `runRenderLoop` runs from a
`setImmediate` AFTER the HTTP response returned, and adgen claims `Ad` rows via its own
independent DB poll, never via anything this function does). Degradation chain unchanged:
real name → short id → nothing. `requesterLookupDone` latch semantics in `runFeedService.js`
untouched. Non-handoff path re-verified unaffected — `scripts/verifyRunFeed.js`,
`scripts/verifySlackRunVerbosity.js`, `scripts/verifyRunFeedStartsUnderHandoff.js` all still
pass unchanged (97/97, 88/88, all-checks respectively).

### Fix 2 — identify automated runs

`scripts/mintTestToken.js` (the `ui-smoke` skill's offline JWT minter) mints a token for a
REAL `User` — a genuine `AdvertiserMembership` is required to drive the app — so before this
change a test run was indistinguishable from the owner's own click: same `requestedBy`, same
resolved `User.displayName`.

Mechanism (entirely additive; a real Google-OAuth login is unaffected at every step):

- Every token `mintTestToken.js` mints now carries two EXTRA JWT claims, unconditionally:
  `automated: true` and `sessionLabel` (from a new `--session-label <name>` flag; `null` if
  omitted). `routes/auth.js`'s real login callback signs a smaller, different claims shape and
  never sets either.
- `middleware/requireAuth.js` reads `payload.automated === true` (strict) and, only then,
  `payload.sessionLabel` (type-checked, trimmed, capped at 80 chars); attaches
  `req.user.automated` / `req.user.sessionLabel`.
- New `CampaignRun.automation: { isAutomated: Boolean, sessionLabel: String }` field
  (models/CampaignRun.js — Mongoose is strict, so this had to be declared, same trap class as
  the pre-existing `renderError.predictionId` / `titlingResumeState` incidents this repo has
  hit before). Stamped at BOTH `CampaignRun.create` call sites (`/generate`, `/runs`) from
  `req.user.automated`/`req.user.sessionLabel` — never inferred from heuristics.
- `runRenderLoop` (and two "Campaign run crashed" alerts elsewhere in the same file, via a
  shared `automatedRunLabel(run)` helper, at zero extra DB-read cost) renders
  `<sessionLabel> (Claude session)` — or the honest `automated (Claude session)` when no
  label was supplied — INSTEAD OF the human lookup, never merely beside it. Verified the exact
  rendered strings directly against the real `buildParentText`:
  - human: `▸ run_test… · b1 · 4 ads · by Nick Sheth`
  - automated + label: `▸ run_test… · b1 · 4 ads · by rs-e5 (Claude session)`
  - automated, no label: `▸ run_test… · b1 · 4 ads · by automated (Claude session)`

### Adversarial review (Grok, xhigh effort) — one real finding, fixed

Reviewed for: JWT trust-boundary forgery, `sessionLabel` injection into a real Slack
channel, whether the `runRenderLoop` restructure changes crash-state or timing, and
backward compat against pre-existing Mongo docs with no `automation` field. Verdict: no
money/auth bypass. Two things found:

1. **Real, low severity, FIXED.** `esc()` in `runFeedService.js` (the parent head) does
   not strip `\n`/`\r`, and `buildRunStartLine` (the thread's "run start" line) has no
   escaping at all — a `--session-label` containing a raw newline could forge an extra,
   spoofed-looking line in the thread (`--session-label $'foo\n▸ run_fake… · by Nick'`).
   Requires `JWT_SECRET` to reach at all (same trust boundary the whole test-minting tool
   already relies on), but cheap to close outright. Fixed at the actual trust-boundary
   read (`middleware/requireAuth.js`): strip every ASCII control character (`charCodeAt
   <= 0x1F` or `=== 0x7F`, covering `\n`/`\r`/`\t`/etc.) and collapse remaining whitespace
   to one space before the 80-char cap; `mintTestToken.js` applies the same sanitizer
   defensively at sign-time. The broader pre-existing gap (`buildRunStartLine` never
   escaping a real human `User.displayName` either) is unchanged and tracked in
   `session.d/KNOWN-OPEN.md` — not attacker-facing the same way, not fixed here.
   **Implementation note:** the first attempt at this fix used a `\x00-\x1F\x7F` regex
   character class typed directly into an Edit tool call; the tool's parameter-encoding
   layer silently decoded those escape sequences into literal raw control bytes (NUL,
   0x1F, 0x7F) IN THE SOURCE FILE ITSELF rather than preserving them as the six/four-char
   escape-sequence text — `git diff` started reporting the file as **binary**. Rewrote the
   sanitizer using `charCodeAt(0)` numeric comparisons (`<= 0x1F`, `=== 0x7F` — plain hex
   *number* literals, not regex escapes) instead, which cannot suffer the same corruption;
   verified byte-for-byte with a `python3` control-byte scan before proceeding. **Lesson
   for next time:** never type a `\x`-style hex escape directly into an Edit `new_string`
   for a file that must stay plain UTF-8 text — build the character class from numeric
   `charCodeAt` comparisons instead, and verify with a raw byte scan after any edit that
   touches control characters.
2. **Docs-only, FIXED.** `models/CampaignRun.js`, `mintTestToken.js`'s help/log text, and
   `docs/ALERTING.md` all said the no-label fallback renders `"automated (session
   unknown)"` — the real code (`automatedRunLabel`, `routes/ads.js`) produces `"automated
   (Claude session)"`. All four call sites corrected to match the real string.

`scripts/verifyAutomatedRunRequesterLabel.js`'s C3 check needed a small fix after the
sanitizer refactor moved `sessionLabel`'s derivation into a named intermediate variable
(`sanitizedSessionLabel`) instead of inlining `args.sessionLabel` directly in the claims
object literal — the check now accepts either shape. Re-ran full suite after every change
in this section: still 199/201, same two pre-existing failures, lint clean.

The internal stranded-ad sweep (`requeueStrandedAds`) mints its own system-identity
`CampaignRun` with `requestedBy: null` and is deliberately NOT stamped `automation` — it
already renders with no `by:` atom at all, which is honest (nobody clicked anything) and was
never the reported problem.

### Needs a human / follow-up (not fixed here, see session.d/KNOWN-OPEN.md)

- `--session-label` is not yet wired from the `ui-smoke` skill/harness (a separate tool
  outside this repo) — an automated run today shows the honest `automated (Claude session)`
  rather than a friendly name like `rs-e5` until that wiring lands. `CLAUDE_CODE_SESSION_ID`
  is one candidate value.
- `GET /api/ads/render-activity`'s requester column doesn't reuse the new automation label —
  cosmetic, unrelated internal admin board, out of scope here.
- `buildRunStartLine`'s thread "run start" line doesn't HTML-escape its `by:` atom the way
  `buildParentText`'s parent head does — pre-existing (real displayNames already flowed
  through unescaped), not introduced or worsened by this PR; `sessionLabel` is capped at 80
  chars and gated by the same JWT_SECRET operator trust boundary as the whole minting tool.

### New harness

`scripts/verifyAutomatedRunRequesterLabel.js` (33 checks, offline, structural — no live
Mongo/JWT). Revert-proven on 3 mutations while drafting: (1) forcing the human lookup to
always run instead of being skipped for automated runs → fails E2; (2) moving the
brand/requester `Promise.all` back to AFTER the (already-hoisted) `startRun` call — i.e.
reproducing the exact #328-class defect — → fails D6, the check written specifically for
this; (3) dropping `automation.sessionLabel`'s schema default → fails A5. All three restored
byte-identical (`diff` confirmed) before the real run.

### Suite

`npm test` → **199/201** (was 198/200 baseline + 1 new script). The two pre-existing failures
are the documented `verifyPreparingReap.js` / `verifyRenderStages.js` — unchanged, unrelated
to this diff. `verifyMetaApiVersion.js` flakes under the aggregate runner's concurrency
(passes standalone and on a clean re-run of the full suite) — not a real failure, not caused
by this branch. `npm run lint` clean. `node --check` clean on every touched file.

### Constraints honored

Read-only against production throughout (two Render one-off Jobs for Mongo reads only, GET-only
Render API calls for logs/env). No Slack message sent from testing — verification was
`buildParentText`/`buildRunStartLine` called directly in a `node -e` snippet plus the offline
harness, never a live post. No deploy, no generation triggered, no secret ever printed (env
vars reported SET/MISSING only).
