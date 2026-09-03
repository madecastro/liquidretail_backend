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

**2026-09-03: benefits-to-directors LANDED — backend #383 + adgen #109 merged,
both deployed and confirmed live.** Full detail:
`session.d/2026-09-03_benefits-to-directors-landed-and-deployed.md`. One
finding worth surfacing here directly: a stray "REVERT-PROVE INJECTION" test
comment (citing a fictitious module, zero functional effect) was found
appended to `services/bootRecoveryService.js` in this worktree and was
stripped before landing — not committed. An untracked, unreviewed
`scripts/verifyDocCitations.js` was also found (currently fails when run) and
was deliberately left uncommitted, out of scope for this landing.

*(Prior 2026-09-03 night, superseded by the landing above.)*

**2026-09-03: VIDEO refs implementation, UNCOMMITTED, no push.** Same two
flags as adgen (`VIDEO_PACKSHOT_PROTECTED_RANKING`,
`VIDEO_RAW_CATALOG_REFERENCES`), both false. `VIDEO_SEED_TEXT_TYPE_FILTER`
and the overlay/lock prompt machinery were **stripped** (not flag-gated) —
`OMNI_DIRECTIVES.noText` is the sole text directive. Strip report:
`/Volumes/Sayulita/Projects/RS/scratchpad/SEEDTEXT-STRIPPED.md`. Ranking/raw-refs:
`/Volumes/Sayulita/Projects/RS/scratchpad/IMPLEMENT-VIDEO-REFS-GROK.md`.
`npm test` 234/234 after the strip. Claude reviews the diff next. Ingest
`faceVisible` (earlier tonight, also uncommitted) is what the ranking reads;
no backfill.

**2026-09-03: A/B/C score — C alone is enough.** Pristine catalog
originals + generic CORE (no per-SKU marks) fixed all four headline
SERIOUS defects, including the 8af4/8b0b stacked sleeve that B’s marks
block could not kill. 69b4 C retry after unbilled `api_error` landed
`$1.035` and copied catalog `PELAGIC` + `BUILT FOR FISHING` (B had
omitted the second line). Staging is production-viable from existing
`shotType`+`text[]` ($0 extra). Running Gemini ~$11.38. Narrative:
`session.d/2026-09-03_abc-score-native-generic.md`. Pixels:
scratchpad `gemini-direct/REPORT-ABC.md`.

**2026-09-03: fidelity prompt + 4 Gemini r2v + Imagine $1.43.** Camera
is never a defect. Headline SERIOUS marks fixed on 8ea0/69b4/8af4/8b0b
except 8af4 sleeve print (on ref1). Imagine settled **$1.43** — not
$0.08/job, not $0.50/sec. Running Gemini ~$6.20. Narrative:
`session.d/2026-09-03_fidelity-prompt-gemini4-imagine.md`.

**2026-09-03: Grok Imagine v1.5 r2v one POST failed unbilled — prompt
over 4096.** Pred `96f0fcd79fbf4b2189e81834c4c0afd6`, executionTime 0,
no price. 10s/9:16/3-ref mapped; Leaderman's 4162-byte prompt did not.
$0.08 vs $0.50/sec still unresolved. Did not retry. Narrative:
`session.d/2026-09-03_grok-imagine-leaderman-prompt-4096.md`.

**2026-09-03: Gemini `image_to_video` (Leaderman, ref0 only) — invented
side-angle FIXED, waistband WORSE (`PELARIC`).** One POST, never retried.
i2v does not take a 3-ref stack (1 first-frame or 2 first+last). ~$1.03
Google; running Gemini total ~$2.06. Narrative:
`session.d/2026-09-03_gemini-omni-i2v-leaderman.md`.

**2026-09-03: direct Gemini Omni 1.1 Flash 10s 9:16 3-ref WORKS.** One
POST, never retried, Leaderman `6a986320eea5b7d839449c89` identical
control_r1 prompt+refs. Model `gemini-omni-1.1-flash`, `duration:"10s"`
now POSTed-confirmed on Developer REST. ~$1.04 on Google's account (not
Atlas). Output is not a drop-in of the Atlas Ken Burns master (invented
side angle). Narrative:
`session.d/2026-09-03_gemini-omni-1.1-flash-direct-leaderman.md`.

**2026-09-03: tonight's control-arm `veoVideoUrl` match is unbilled Atlas
422, not a persist bug. Do not POST another 10s 9:16 Omni regenerate.**
`7e75`/`8ea0`/`69b4`/`cbc` still show yesterday's Cloudinary masters
because Atlas failed `omni_flash-10s-portrait does not exist` (`price:
null`, `outputs: []`). Persist works when Atlas succeeds — `9c89`
billed $0.90 and wrote a new unique public_id whose bytes match Atlas
`outputs[0]`. Owner's `cbc` praise was the pre-run video. Halted leftover
`regenerating` rows `cbc` and `478f`. Full forensic:
`session.d/2026-09-03_veo-url-mismatch-is-unbilled-422.md`.

*(Prior 2026-09-01: verify-suite dotfile-race hardening, PR #374. Narrative:

**2026-09-03: overlay-zones skip catalog + committed config matches
prod (worktree `feat/benefits-to-directors`, not committed).** Catalog
ingest no longer computes overlay zones (`OVERLAY_ZONES_SKIP_CATALOG=true`;
UGC untouched). `ADGEN_RENDERER_ENABLED=true` in committed defaults
(adgen owns rendering). Write-up:
`session.d/2026-09-03_overlay-skip-catalog-and-config-truth.md`.

*(Prior: benefits-to-directors Parts A–D + catalog shortBenefits.
`session.d/2026-09-03_catalog-product-shortbenefits.md`.)*

*(Prior state replaced 2026-09-01. Narrative:
`session.d/2026-09-01_verify-suite-dotfile-race-remaining-walks.md`.)*

*(Prior state replaced 2026-08-28. Narrative: session.d/2026-08-28_retitle-adgen-handoff.md.)*

**2026-08-28: manual retitle → adgen handoff (PR pending,
`fix/retitle-adgen-handoff-be` + companion adgen
`fix/retitle-adgen-handoff-ag`).** Owner asked whether backend's manual
retitle routes would genuinely be "more scalable" routed through adgen's
titler. Verdict: yes for `/retitle-videos` only (`title-still` is a
synchronous interactive preview loop, `title-spec/modify` isn't a Remotion
render at all — neither belongs in the move). Built the stamp-then-poll
deferral (mirrors the regenerate handoff pattern, `handoffContract.js`
v1.0.0→v1.1.0). **Found and fixed a live production bug along the way,
independent of this work:** `brandScriptExecutor.uploadRenderAndStamp`
forces `status:'draft'` unconditionally in BOTH repos, so every manual
retitle of an already-delivered (`'live'`) ad has been silently
un-publishing it, today, regardless of `ADGEN_RENDERER_ENABLED`. Fixed via
an opt-in `preserveAdStatus`/`retitleMode` flag, both repos, revert-proven.
Two adversarial Grok xhigh review passes (one per repo) found a real gap
— the stamp filter also needed `regenerating:{$ne:true}` — and corrected
an overclaim: retitle makes no NEW Atlas video-gen submit, but it does
still make the pre-existing vision-QC/face-detection Atlas LLM calls
every titling render makes. `scripts/verifyRetitleAdgenHandoff.js` grew
13→16 checks. Full narrative:
`session.d/2026-08-28_retitle-adgen-handoff.md`. **Do not merge without
the companion adgen PR** — paired cross-repo contract change.

*(Prior state replaced 2026-08-25 ~12:45 UTC. Narrative:
`session.d/2026-08-25_review-coverage-corrected-and-ingest-mechanics.md` then
`session.d/2026-08-25_readiness-gate-headless-tier-and-preview-underquote.md`.)*

**All seven demo brands can now generate ads.** A readiness gate had been demanding a
catalog DetectRun that only the blocked request could create, permanently locking out every
brand onboarded after detect went lazy (#340). Peloton additionally needed catalog
materialization, run separately. This was the second time that one gate locked out the same
brands for a different reason, so it now has a harness.

**Review coverage is a per-storefront ingest property, not a constant.** The free on-site
pass took Peloton Apparel from 25 first-party reviewed products to 1,189 in half an hour at
zero cost. Gymshark and Marine Layer have real review platforms (`bazaarvoice`, `yotpo`)
that the HTTP tiers cannot read — and #339 made the headless tier reachable for the first
time, so running it against them is the cheapest coverage win available and is untried.

**A money bug is open:** `/api/ads/preview` under-quotes 2.6x when QC regenerates, and the
ui-smoke budget guard reserves from that quote.

**Known-red on this trunk:** `verifyPreparingReap.js` and `verifyRenderStages.js` fail on a
clean checkout. Stash and re-run before assuming a failure is yours.

**Open PR #319** — real concern, unmergeable as-is, needs a design call rather than a
rebase. Triage is commented on the PR.

---

## KNOWN-OPEN

See `session.d/KNOWN-OPEN.md` — curated list, edited in place.

## ARCHIVE

- `session.d/` — every dated session entry, one file per entry, 2026-08-03 onward.
- `CHANGELOG.md` — hand-curated prose summary, pre-2026-08-03 and select highlights.
- Full pre-restructuring `session.md` (single 6,962-line file): `git log -- session.md`.
