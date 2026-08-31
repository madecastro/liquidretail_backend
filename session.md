# session.md — liquidretail_adgen

Handoff for the next session. Architecture lives in `CLAUDE.md`. This file is
**state only** — replace CURRENT STATE when it goes stale; do not append.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder.)_

---

## CURRENT STATE

*(Replaced 2026-08-31. Trunk `master`. Previous entry (PR #96 crop-fix, 2026-08-28) is
superseded; its content is in `session.d/`.)*

**Fixed 2026-08-31: TEXT-ON-TEXT on delivered vertical video ads (the "overlapping
titles" defect).** Reported against ad `6a93ade2e4f1d02784398630` (`meta_reels_9_16`,
conversion) and reproduced on `6a93ade1e4f1d02784398626` (`meta_stories_9_16`): the
headline and the productName/rating/deliveryLine stack rendered on top of each other
from ~1.5s, both illegible.

**Mechanism.** `Canonical.jsx` groups slots by `(phase, position.anchor)` and resolves
ONE anchor per group via `resolveGroupAnchor`'s keep-out walk; `stackContainerStyle`
then positions `position:absolute` from that anchor alone. Each group walks
`KEEP_OUT_CANDIDATES` **independently**, with no knowledge of where other groups
landed, and the chains overlap heavily — so two SIMULTANEOUSLY-VISIBLE groups can
resolve onto the same band and paint through each other. `canonical-conversion`
vertical authored its close stack in the `hook` phase from 1.5s with **no exit**, so it
shared the frame with `hook|upperThird` and then `proof|upperThird`; the plate scan
flags the middle+bottom bands (the model *wears* the product, so those bands ARE the
product), keep-out walked the close stack up to `upperThird`, and it landed on the live
headline. Two natural controls on the SAME footage/run isolate it: `…398612` (plain
`canonical`, strictly sequential) and `…39863a` (feed, single group) were both clean.

**Fix is TEMPLATE-LEVEL, not engine-level — owner decision 2026-08-31.** An engine
collision-avoidance pass was drafted and deliberately reverted; its fallback ("if no
band is free, keep the authored one") means sitting on a face, which the owner ruled
unacceptable. Three template changes instead:
1. **Sequential re-timing** of `canonical-conversion` + `canonical-conversion-pmax10`
   vertical (cuts kept ON the Omni camera beats 2.67/5.12 and 3.125/6.375), and of
   `soludos-summer-postcard` vertical. Each carries a `_layoutInvariant` field
   explaining why it must stay sequential.
2. **Removed the pinned in-creative `brandPill` wordmark** (`visible:false`, 18 slots
   across all 6 brand presets), matching `canonical.json`'s own 2026-08-04 owner
   decision. This alone cleared 12 combinations. A persistent group at `top` is
   uniquely dangerous: `top` is the ONLY keep-out chain that can walk DOWN onto another
   band — no other anchor's chain contains `top` — so it can be pushed into live copy
   while nothing can be pushed onto it.
3. **`offsetY: 0.105` on every vertical `upperThird` slot** in `canonical` +
   `canonical-conversion` + `canonical-conversion-pmax10`, so hook/proof copy clears the
   model's head on a full-body 9:16 shot. Owner rule: copy over the BODY is fine, copy
   over the FACE is not. NOTE `Canonical.jsx` uses `first.position.offsetY` — only the
   FIRST slot in a group positions the container — so the value is set on every slot in
   the group for robustness.

**Result: 0 of 15 vertical preset+format combinations overlap (was 9).** All Meta
9:16 / 4:5 / 1:1 layouts are clean except the two `proto-*` prototypes. Verified
visually against the REAL delivered plate at 4+ timestamps, on both a canonical and a
brand preset. Pinned by `scripts/verifyTitleGroupsNeverOverlap.js` (54 combos checked,
18-entry explicit baseline for the not-yet-fixed landscape/proto set).

**Three new tools (none are `verify*`; none touch the suite):**
- `scripts/renderTitlePreview.js` — renders any preset/format/face-scenario to a still
  in ~5s with NO database, network, or vision call. Supports `--plate-video` for real
  footage. **Its output uses HARNESS DEFAULT FONTS (Playfair/Inter/Lora), not brand
  fonts** — it prints a banner saying so, because its serif output was once mistaken
  for a production font regression. Judge geometry from it, never typeface.
- `scripts/inspectAd.js` — read-only Ad inspector by `_id`. Structurally incapable of
  writing (find/findOne only, caller supplies ObjectIds not filters, allow-listed field
  projection, URI redacted from all output incl. error messages).
- `scripts/verifyTitleGroupsNeverOverlap.js` — the regression pin above.

`renderPreview()` in `remotionRenderService.js` gained an optional
`plateHintsOverride` (default null = byte-identical); it is the hook the preview
harness uses to inject synthetic face flags.

**Suite: 84/87.** The 2 non-expected reds (`verifyModelParity`, `verifyVendorDrift`)
were confirmed PRE-EXISTING by stashing and re-running on a clean tree. All 10 changed
files reconciled in `vendor-manifest.json` as owed ports to backend — backend renders
these same presets through its own `brandScriptExecutor`/retitle path and does NOT yet
have any of this.

**FONT AUDIT (2026-08-31) — the "fonts look wrong" report was a FALSE ALARM, and the
real finding is different.** Production fonts are correct: website font capture
(`brandFontIngestService`) works and 8 of 9 brands have real downloaded font files
(Soludos 8, Gymshark 9, PB5star 7, Marine Layer 6, Peloton 5, Pelagic 1 = `ArchivoV`,
which is exactly what the delivered ad logged). The wrong-looking type came from the
new preview harness's empty tokens — now banner-warned. What IS broken, measured
directly:
- **Meta-ads font scanning returns nothing for every brand.** `metaAdsFontService` is
  wired, enabled (`META_ADS_FONTS_ENABLED=true`), and has RUN for all 9 brands
  (`metaFontsIngestedAt` set) — but every one has
  `metaAdsFontUsage: {heading:null, body:null, evidence:[]}`. 0/9 with zero evidence is
  not a real "no fonts found". It sources ad images in 3 tiers (persisted Campaigns →
  connected Meta ad account → public Ad Library via Apify); tier 3 is OFF because
  `APIFY_ADLIB_ACTOR` is blank in `config/defaults.env:1790`. **Check whether it is set
  on the BACKEND Render service** — brand enrichment runs there, not in adgen.
- **`Reach Social` website scan failed permanently**: `could not fetch
  https://reach-social.io`, and `fontIngestedAt` is stamped on failure so it never
  retries. 0 usable font files.
- Latent, NOT currently biting: the 6 brand presets hardcode generic Google fonts in
  `tokenOverrides.fonts` (Poppins/Montserrat/Saira/Barlow/Fraunces), and that override
  is the FIRST ladder entry in `fontResolverService.buildFontLadders` — above `ownFace`,
  and not exact-gated — so it would beat a brand's real captured font. Verified
  harmless today ONLY because **no brand has `titleStylePreset` set**. Setting one
  would immediately override that brand's real font.

---

## KNOWN-OPEN

- **Title-group simultaneity still open on 14 LANDSCAPE + 2 proto combos
  (2026-08-31).** The 2026-08-31 vertical fix cleared every vertical and every
  Meta feed/square layout, but 18 preset+format combinations still have two
  groups on screen at once and are listed explicitly in
  `scripts/verifyTitleGroupsNeverOverlap.js`'s ACCEPTED baseline. 14 are
  `landscape` (16:9 PMax/YouTube — NOT a Meta surface), all the same shape
  (`main|upperThird X main|lowerThird`); landscape additionally has the
  `panelColumnStyle` split-stage geometry, so whether they can actually collide
  there needs its own look and was NOT audited. 2 are `proto-bottom-editorial` /
  `proto-kinetic-center` on feed+square (prototypes). Removing a line from that
  baseline as each is fixed is the goal; ADDING one to silence a red run is the
  exact regression the harness exists to catch.
- **Meta-ads font capture produces zero evidence for all 9 brands (2026-08-31).**
  See CURRENT STATE for the measurement. Next concrete step: check whether
  `APIFY_ADLIB_ACTOR` / `APIFY_TOKEN` are set on the **backend** Render service
  (brand enrichment runs there, not adgen); the committed default is blank.
  Separately, `Reach Social`'s website font scan failed permanently and will
  never retry — its `fontIngestedAt` stamp needs clearing to re-attempt.
- **An engine-level anchor-collision guard was drafted and reverted (2026-08-31).**
  Owner chose the template fix instead. If the landscape/proto set is ever tackled
  generically rather than per-preset, note the design constraint that killed the
  first attempt: its "no free band, so keep the authored anchor" fallback means
  sitting on a face, which the owner ruled unacceptable. Any revival needs a
  better answer for that case than the one that was written.

- **Director-side reservation gate widening (`aiCreativeDirectorService.js`
  PROOF PRESENCE comment, correction 1) — owner decision, not started, now
  RIPE.** Both residuals it names are closed (PR #42 and PR #41, both
  MERGED as of this writing) — the comment says widening the gate to
  COMPEL a proof-led concept for a quote-only product "is very likely the
  right call", but that call itself still has not been put to the owner.
  `scripts/verifyProofReservationGate.js`'s D3 tripwire will not flag it
  automatically (both landed fixes are data-conditional, not blanket
  grants) — whoever picks this up should re-read that file's own
  instructions before touching the gate. Untouched by this PR (out of
  scope — this PR is build infra only).
- **`verifyVendorDrift.js` backend-side check is currently RED on
  `origin/master`, re-verified 2026-08-28** (this has moved twice since the
  2026-08-24 12-file list — first reconciled by PR #94, now red again for a
  DIFFERENT reason; don't trust either PR's own narrative as current, always
  re-run and diff fresh). Confirmed via a pristine `origin/master` worktree +
  `ADGEN_BACKEND_PATH` that the current 3-file red set is pre-existing, not
  caused by PR #96: `models/Ad.js`, `services/brandScriptExecutor.js`,
  `services/handoffContract.js` — all three are owed drift from the
  #93/#359/#360 retitle-handoff work landing same-day (backend moved past the
  manifest's last recorded look on each). Does **not** fail CI
  (`ADGEN_BACKEND_PATH` unset there, backend-side checks skip — see the
  harness's own `--help`). Needs a human to look at each file and either port
  the backend change or re-attest: `node scripts/verifyVendorDrift.js
  --reconcile <path> --reason "…"`. Separately, `services/adRegenerateService.js`
  remains an OPEN but currently-non-red unported debt from #94/#90 (backend's
  `runVideoFull`/`runImage` still lack the execute-time
  `assertNotInFlightBeforeSubmit()` re-check) — still owed, just not part of
  today's red set. PR #96 additionally added 3 NEW owed-port-to-backend
  entries for an unrelated reason (the face-quorum-retry fix — see CURRENT
  STATE): `basePlateCropService.js`, `faceSafeCrop.js`, `videoFrameService.js`.
- **`renderer.js` split (static vs. video render service) — owner
  decision, not started.** 1747 lines, touched by 13/38 recent merges (a
  third). Natural seam is render-route: `renderStatic` (~169 lines) vs.
  `renderVideo` (~398 lines, itself covering three sub-paths: master/
  derive/titling) share almost nothing except claim/release/
  bumpRunCounter/heartbeat primitives and module-level state (`inFlight`,
  `runInflight`/`runHeartbeats`/`runDocIdCache`). A split would extract
  those two into their own files and leave `renderer.js` as the thin
  poll/claim/dispatch/heartbeat core — see this session's final report for
  the full writeup. `processAd`'s shared catch block already has one
  video-specific carve-out inline (`err.unsettledAtTimeout`), so "thin
  dispatcher" isn't 100% clean today; a split needs to decide where that
  moves.
- **GitHub merge queue — needs repo-admin action, not done.** `master` has
  no branch protection (confirmed via API, 404). Org plan is `team`, which
  supports merge queue on a private repo. To enable: Settings → Branches →
  add a protection rule for `master` with at least one required status
  check (e.g. the existing `ci` job), then check "Require merge queue".
  This is a standing, repo-wide config change — deliberately not done by
  this session; the auto-rebase workflow (above) is the no-admin-needed
  alternative shipped instead.
- **`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`** — still labelled expected-fail;
  `maybeFinalizeRun` is wired on this branch. Group A only replays the `$inc`.
- **`verifyArchiveDigestRelease.js` E3/E14** — self-diagnosed broken ported scans.
- **`verifyModelParity.js`** — currently red on `origin/master` for a
  content reason, not a tooling one (re-confirmed 2026-08-25 by stashing):
  `Ad.js` declares `titlingNeeded` (titler Phase 3, PR #52) and, as of the
  video-titling-recoverability PR, `titlingAttempts` too — both adgen-only
  mechanisms the sibling `liquidretail_backend/models/Ad.js` has no
  analogue for, violating the adgen-fields-⊆-backend-fields subset rule.
  Real follow-up, not done here (separate repo/PR): either port both
  fields to backend's Ad.js (as declared-but-unwritten, matching how
  adgen carries backend-only fields today) or teach the harness an
  explicit accepted-drift allowlist the way `verifyVendorDrift.js --reconcile`
  does. (Older note about "models no longer call mongoose.model in a
  shape the harness can extract" was NOT reproduced 2026-08-25 — that
  looked like a stale/environment-specific symptom, not this repo's
  current cause; don't assume it without re-checking.) Separately: a
  `node_modules` symlink in the worktree still breaks it (remove before
  commit) — that part of the old note stands.
- **Orchestrator is still Phase 0, unchanged.** The video-titling-
  recoverability PR's FIRST draft wired the titling resume sweep here
  (reasoning: it's the one adgen role Render keeps singleton) but
  adversarial review found orchestrator's Render plan is `starter`
  (~512 MB) while a real Remotion titling slot needs ~1.97 GiB — the
  sweep would have OOM-killed it on the first real retitle. Moved to
  `renderer.js` instead (see CURRENT STATE). Expansion
  (Director/Judge/mint/claim) is still unwritten here.
- **`bootRecoveryService` still unwired** from adgen boot (unchanged by
  this PR — only `titlingResumeService.resumeUntitledMasters()` was
  wired, from `renderer.js`). `bootRecoveryService` is a DIFFERENT
  mechanism (pulls a finished Omni master out of a spend receipt after a
  crash mid-generation) that adgen has never wired either; still nobody's
  job here. Confirm before assuming it's covered.
- **`liquidretail_backend`'s own titling-resume sweep is ungated and has
  no attempt-cap concept — cross-repo, not fixed here.** Backend's web
  process runs its OWN `titlingResumeService.resumeUntitledMasters()` on
  an interval with NO `ADGEN_RENDERER_ENABLED` check (confirmed absent
  from `liquidretail_backend/index.js`'s wiring) and its
  `brandScriptExecutor.js` has no `stampTitlingFailureAndThrow` /
  `titlingResumable` — a plain OOM-or-terminal-fail split, same as adgen
  before this PR. If backend wins the claim race on a resumable ad before
  adgen does, its first Remotion failure immediately marks the ad
  `status:'failed'`, undoing this PR's resumability for that ad. Pre-
  existed for OOM; this PR widens which failures are exposed to it. The
  atomic per-document claim still prevents a double-title either way.
  Needs a backend-side PR (separate repo) — flagged, not done here.

---

## Adding an entry

Replace CURRENT STATE / KNOWN-OPEN in place. Do not grow a dated log in
this file.
