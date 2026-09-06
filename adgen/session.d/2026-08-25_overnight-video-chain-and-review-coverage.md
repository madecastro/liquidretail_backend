# 2026-08-25 — video reliability chain landed; review-coverage numbers corrected

Written at the end of a long overnight session that started as an autonomous E2E
loop and turned into a merge-gate marathon. Two colleagues (Brian and Mark) are
picking this up, so this entry is written to be read cold.

---

## 1. Where the code is

- `liquidretail_adgen` trunk `master` @ **684ac8b**. Zero open PRs.
- `liquidretail_backend` trunk `main` @ **e5f4a3ff**. Four PRs still open:
  #333 (Slack requester name), #331 (cost attribution), #330 (postStatus.js) —
  all MERGEABLE — and #319, CONFLICTING.
- All four adgen Render services and both backend services deployed from those
  trunks. `render.yaml` describes the four-role split
  (api / orchestrator / renderer / titler).

## 2. Video generation works again — and here is the proof, not the claim

The outage was **PR #43**: two `renderTitles({...})` call sites in
`brandScriptExecutor.js` (~:2230 and ~:2261) passed raw Mongoose ObjectIds on the
Remotion child IPC payload. `remotionChildSupervisor.js:96-101`'s `assertNoBuffers`
rejects those — an ObjectId serialises through a Buffer — so **every** video render
threw `remotion child IPC forbids buffers (key=buffer); pass a path`. The fix wraps
each id in `String()`; those `String()` calls are load-bearing, not cosmetic.

Evidence it is fixed, from the production `ads` collection:
- the last `remotion child IPC forbids buffers` failure is **22:09 UTC 2026-08-24**
- the batch at **04:13 UTC 2026-08-25** came back `status: 'draft'` with
  `veoVideoUrl` populated — real delivered videos
- the only failure in that batch was a vision-QC rejection ("product fidelity
  drifts in construction and material"), which is a content judgement, not infra

Do not re-open this as an infrastructure bug without first checking whether the
error string is the IPC one or a QC verdict. They look similar in a Slack line.

## 3. Two production levers are still unpulled — both deliberate

1. **`REMOTION_QUEUE_CONCURRENCY` is 2 on the adgen-renderer dashboard.** PR #61
   raised the value in `config/defaults.env` to 3, but `src/config.js:12` loads
   dotenv WITHOUT `override: true`, so a Render dashboard variable of the same name
   wins. **PR #61 is therefore inert in production.** Raising it means editing the
   dashboard, not the file. The memory math: ~1.97 GiB per concurrent Remotion
   render (measured), so 3 ≈ 5.9 GiB of an 8 GiB box (74%, ~2 GiB headroom). 4 is
   the value that was OOM-killed on 2026-08-21 while holding a paid master — do not
   restore it. Autoscaling is DISABLED on that service, so the old "stay under the
   60% trigger" constraint does not apply.
2. **`ADGEN_TITLER_ENABLED` is false, and must stay false until the claim filter is
   fixed.** `renderer.js`'s `claimOne()` (~:634) claims on
   `{ status:'rendering', claimedByWorker:null, renderRoute:{$in:['html_gen','veo']} }`
   with **no `titlingNeeded` exclusion**. In titler mode the renderer stamps
   `titlingNeeded: true` and hands off — and then, with this filter, immediately
   re-claims the same row. Flipping the flag today livelocks the two roles.
   The fix is a `titlingNeeded: { $ne: true }` predicate plus a behavioural harness;
   it was in progress when this session ended (see KNOWN-OPEN).

## 4. `verifyModelParity` now pins to backend `origin/main`

It used to `require()` the sibling backend's model files straight off the **working
tree** — a shared checkout that is routinely dirty and behind (measured today: 18
commits behind `origin/main`, 9 modified tracked files). That produced a false
failure claiming the backend lacked `titlingNeeded`/`titlingAttempts` when
`origin/main` declares both. The subset rule was correct; the comparison target was
stale.

It now `git archive`s `origin/main`'s `models/` (plus the two files those models
require at load time — `services/platformFormats.js`, `utils/titleNormalize.js`)
into a temp dir and requires those copies for real. No source-text parsing.

**The NODE_PATH rule is unchanged and still absolute:** in an adgen worktree, never
set `NODE_PATH` and never run `npm ci`. The harness depends on adgen's own bare
`require('mongoose')` FAILING so its `Module._load` patch can fall back to the
sibling backend's `node_modules`. The extracted temp tree has no `node_modules` for
exactly this reason. Setting `NODE_PATH` turns ~33 harnesses red spuriously.
Diagnostic shape: a uniform 33/33 failure is NODE_PATH poisoning; a single named
model failure means a stale sibling checkout — now impossible, since the ref is
pinned. Override with `ADGEN_BACKEND_REF`.

## 5. Vendor drift

`services/concurrency.js` moved `synced -> fork`. adgen genuinely diverged: its SPEC
fallback is 4 -> 2 (a degraded-boot fallback must be the most conservative value the
process has survived, and 4 is the measured OOM-fatal one), plus a correction to
that field's `why` note. The old "~0.9 GiB per concurrent slot" figure divided a
7.57 GiB peak by 8 permits when only 4 were demonstrably rendering; the real number
is ~1.97 GiB/slot.

**Standing rule:** after ANY backend merge, run `node scripts/verifyVendorDrift.js`
here and reconcile with `--reconcile <path> --reason "…"`. Backend merges turned
adgen red five times in one day.

## 6. The merge-gate rules that actually caught things today

- **Green CI does not mean safe to merge.** A PR built on a stale branch is valid
  code that silently REVERTS newer commits, and CI passes. Always
  `git diff --numstat origin/<trunk>` before merging and confirm every hunk is
  intended. Five silent reverts were caught this way today.
- **Mongoose strict mode silently discards writes to undeclared paths.** Five real
  instances found today. Any new field written on a document must be declared in the
  model — in BOTH repos when both write that collection.
- **Work in a worktree branched off `origin/<trunk>`.** The shared checkouts here
  are permanently dirty with other sessions' live edits; never `git checkout` or
  `git stash` in the main checkout.
- **Prove a harness both directions.** Today's parity fix was mutation-tested
  (inject a bogus field → must fail) and ref-proved (`ADGEN_BACKEND_REF=<stale sha>`
  → reproduces the old failure). The first mutation attempt landed inside a comment
  block and proved nothing; green was meaningless until that was caught.

## 7. Suite status

`node scripts/runVerifySuite.js` → **47/48**. The single red is
`verifyRunFinalizesOnSettle_KNOWN_OPEN.js`, which is red by design and listed in
`scripts/expected-failures.json`.
