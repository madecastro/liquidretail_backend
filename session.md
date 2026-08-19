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

- Trunk `main` is moving fast — 36+ merges in the last day; always `git fetch` before
  trusting a SHA here. As of this restructuring landing, `main` was at `3ac2ca85`
  — **#235 and #236 merged while this change was in flight** (confirming the
  problem this restructuring exists to fix: #236's own squash-merge included a
  `session.md` append, which is exactly what conflicted this branch on rebase —
  see `session.d/2026-08-19_vision-qc-surfacing-closed-last-gap-table-row.md`,
  archived here rather than lost).
- Open PRs at the time of this change: **#227** (backend), **#59** (frontend
  `liquidretail`, companion to #236), plus RPD **#210/#212** (deliberately
  deferred — do not touch).
- Offline verify: `for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done`
  (168 scripts as of this change — re-count before quoting, this number has drifted
  before). `npm run lint` enables exactly one rule, `no-undef` — see `CLAUDE.md` §5
  for why that one rule matters more than it looks like it should.
- Known environmental-only failures from a `git worktree` checkout (not a real
  regression, do not "fix"): `verifyLogoSilhouette.js`, `verifyLogoColorPreservation.js`,
  `verifyStaticTextInk.js` all `require('node_modules/sharp')`, which no worktree
  vendors. macOS has no `timeout` binary — a loop that wraps each script in `timeout`
  will misreport all of them as failed.
- Most recent entries (see `session.d/`, newest by filename date):
  `2026-08-19_vision-qc-surfacing-closed-last-gap-table-row.md` (PR #236, merged),
  `2026-08-19_ad-readiness-gate-counted-only-the-legacy-apify-shopify-ingest-source.md`,
  `2026-08-19_two-omni-masters-timed-out-run_1787119100250_eef4d871-the-real-defect.md`,
  `2026-08-19_run-status-stopped-lying-gap-table-vs-slack-and-the-partial-failure-bu.md`,
  `2026-08-19_last-direct-gemini-path-swept-grounding-proven-unavailable-on-atlas-un.md`.

## KNOWN-OPEN

See `session.d/KNOWN-OPEN.md` — curated list, edited in place.

## ARCHIVE

- `session.d/` — every dated session entry, one file per entry, 2026-08-03 onward.
- `CHANGELOG.md` — hand-curated prose summary, pre-2026-08-03 and select highlights.
- Full pre-restructuring `session.md` (single 6,962-line file): `git log -- session.md`.
