# session.md — liquidretail_backend

Handoff for the next session. **Restructured 2026-08-19** — this file had grown to
6,962 lines / 475 KB (touched by 15 of the last 36 merges to `main`), because every
session appended its entry directly here. Two different in-file reorganisations
(2026-08-03, then a "moved history to `CHANGELOG.md`" pointer later) were each buried
by the next round of appends landing past them — a written convention alone did not
hold, because every append still touched this one file at the one shared insertion
point, so any two open PRs conflicted on this file within seconds of either merging.

**The fix is structural, not just a rule:** a session's own entry now goes in its own
file under `session.d/`, never inside this one. Two sessions adding two different
files can never conflict — there is no shared line for git to argue about. This file
stays small on purpose, because the global convention is to read it first, every
session; a 475 KB read was most of a session's context budget before it opened a
single source file.

**What still lives here, and how it changes:**
- **NEXT-SESSION PROMPT** — the owner's standing instruction. The owner edits this;
  a session clears it back to the placeholder after acting on it. Whoever changes
  this is making a real edit to real state, so a conflict here is a real conflict,
  not the append tax — expected to be rare and easy to resolve by hand.
- **CURRENT STATE** — a short, *replaced* (not appended) snapshot. Same reasoning:
  low-frequency, legitimate edits only.
- **KNOWN-OPEN** — moved to `session.d/KNOWN-OPEN.md`, a curated checklist edited in
  place (add/remove/check off items; do not append a second copy of the list here or
  anywhere else).
- **Everything chronological** — every dated entry that used to accumulate in this
  file now lives as its own file in `session.d/`, one per entry, named
  `YYYY-MM-DD_<slug>.md`. See "Adding an entry" below.

**Archive.** All 56 pre-existing dated entries from the old `session.md` (2026-08-03
through 2026-08-19) were split out verbatim into `session.d/` in this same change —
nothing was deleted or summarized away; every file is git-tracked with its own
history entry point, and the old content is also still fully recoverable from this
file's own git history (`git log -- session.md`) if a `session.d/` file is ever
suspected of drifting from the original. `CHANGELOG.md` holds the older, hand-curated
prose summary (pre-2026-08-03) and is unaffected by this change.

## Adding an entry (do this instead of editing this file)

1. Create `session.d/YYYY-MM-DD_<short-slug>.md` (today's date, a few kebab-case
   words describing the finding — copy the style of any existing file in that
   directory). Write your entry there, in full — this is the same level of detail
   that used to go inline here.
2. Do **not** add a link to it anywhere. There is no index to maintain — that was
   itself a second shared-append point. To find recent entries:
   `ls -t session.d/*.md | head -20`, or `grep -rl <keyword> session.d/`.
3. Only touch the body of *this* file if you are updating CURRENT STATE, clearing or
   setting NEXT-SESSION PROMPT, or the owner asked you to fold something significant
   back into `CHANGELOG.md`.
4. If an entry is settled history with no more forensic value as a standalone file
   (rare — most are kept), fold a compressed summary into `CHANGELOG.md` and delete
   the `session.d/` file in the same commit, `git log --follow` will still find it.

See `CLAUDE.md` §5 *Conventions* for the repo-wide statement of this rule.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder in the same commit that closes it out.)_

---

## CURRENT STATE

*(Replace this whole section, don't append to it, when it goes stale.)*

- Trunk `main` is moving fast — always `git fetch` before trusting a SHA here.
  As of this update, `main` was at `3bd30a93` (docs on the #244 adversarial-
  review P0). **#239-#252 (incl. #244, #249, #250, #251, #252) merged**
  since the previous snapshot below (`737732b9`).
- Open PRs at the time of this update: RPD **#210/#212** (deliberately
  deferred — do not touch). Newest backend session:
  `fix/detect-media-brand-tenancy` — closed the #1 finding from the
  adversarial review of #245 (see the KNOWN-OPEN entry): `expandWizardJob`'s
  on-demand detect prep resolved the request's raw `mediaIds` with no
  `brandId` clause, and `ensureDetectForProducts` accepted a `brandId` option
  but never applied it. Confirmed live+exploitable, measured against prod (8
  campaigns/4 brand pairs of persisted foreign-media residue, 0 currently
  chaining to a billable detect — the code path was the live risk, not
  today's data), fixed, landed with a new revert-proven harness. Also
  corrected the severity of the other five findings from the same review —
  two were previously overstated (`/preview`'s and the legacy cartesian
  path's actual blast radius are both narrower than first reported; see
  `session.d/2026-08-19_detect-prep-mediaids-brand-leak-fix.md` and the
  updated KNOWN-OPEN entry for the corrected version).
- Offline verify: `for f in scripts/verify*.js scripts/verify*.mjs; do node "$f" || echo "FAIL $f"; done`
  — **174 scripts** as of this update (re-count before quoting, this number
  drifts; use `node`'s own child_process timeout rather than shell job
  control if you wrap this in a runner — a bash `&`/`wait` timeout wrapper
  nested under this harness's own backgrounding misbehaved and silently
  under-ran the sweep twice in a row 2026-08-19). `npm run lint` enables
  exactly one rule, `no-undef` — see `CLAUDE.md` §5 for why that one rule
  matters more than it looks like it should.
- **Correction to a prior note below**: `verifyLogoSilhouette.js`,
  `verifyLogoColorPreservation.js`, `verifyStaticTextInk.js` failing in a
  fresh `git worktree` checkout (all three `require(path.join(__dirname,
  '..','node_modules','sharp'))`, which `NODE_PATH` cannot rescue — it's a
  literal path join, not a bare `require`) is **not permanently
  environmental** — it means that worktree's vendored `node_modules/sharp`
  is missing its native `@img/sharp-<platform>` + `detect-libc` deps (a
  `git worktree add` artifact, not a code issue). Verified 2026-08-19:
  `npm install sharp --no-save --ignore-scripts` from inside the worktree
  repairs it cleanly (also incidentally pulled in `https-proxy-agent` and
  `ffmpeg-static`, separately missing in that same worktree) — all three
  scripts then pass for real. `--no-save` leaves the top-level
  `package.json`/`package-lock.json` untouched; only
  `node_modules/.package-lock.json` (npm's own in-tree bookkeeping file,
  already git-tracked in this repo) shows a diff afterward — do not commit
  that file, it is a local environment repair, not a source change. macOS
  still has no `timeout` binary — a loop that wraps each script in `timeout`
  will misreport all of them as failed regardless of the above.
- Most recent entries (see `session.d/`, newest by filename date):
  `2026-08-19_detect-prep-mediaids-brand-leak-fix.md` (this session —
  `fix/detect-media-brand-tenancy`, closes the #245-review finding #1 above),
  `2026-08-19_reels-rating-row-half-sliced-fixed-element-aware-overflow.md`
  (follow-up to #239: a title group can now shrink/drop whole
  elements to fit its box instead of `overflow:hidden` clipping through the
  middle of one; `remotion/lib/stackFit.js` is new),
  `2026-08-19_crossbrand-tenant-leak-generate-fix.md` (PR #245, merged),
  `2026-08-19_video-vision-qc.md` (video ads now get the same post-render
  vision QC statics have; landed as PR #240),
  `2026-08-19_undispatched-tail-fix-stranded-ads-close-the-loop.md` (PR #241, merged),
  `2026-08-19_reels-quote-opening-line-silently-dropped-fixed-pr-239.md` (PR #239, merged),
  `2026-08-19_pelagic-ad-price-snapshots-repaired.md` (PR #242, merged),
  `2026-08-19_vision-qc-surfacing-closed-last-gap-table-row.md` (PR #236, merged).

## KNOWN-OPEN

See `session.d/KNOWN-OPEN.md` — curated list, edited in place.

## ARCHIVE

- `session.d/` — every dated session entry, one file per entry, 2026-08-03 onward.
- `CHANGELOG.md` — hand-curated prose summary, pre-2026-08-03 and select highlights.
- Full pre-restructuring `session.md` (single 6,962-line file): `git log -- session.md`.
