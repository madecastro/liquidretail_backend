# 2026-08-27 — reframe claim: SIGTERM eviction, an explicit poll budget, and a decoupled lease floor

**MONEY. Backend half of a two-repo change. This PR must merge BEFORE the adgen
sibling — see "Merge order" below.**

## The thing that was actually firing in production

`liquidretail_adgen` has an in-process registry of the reframe claims a process
holds (`_activeReframeClaims`) and a `releaseAllActiveReframeClaims()` sweep wired
to shutdown. **This repo had neither.** So every backend process death — twelve or
more web deploys on 2026-08-27 alone — left this process's reframe billing claims
standing in Mongo with **no live holder**. Two such orphans, both with dead
holders, were found in production.

Nothing recovered them but the ~20 min lease TTL. Until it expired, every peer that
wanted that `(media, aspect)` either waited out its claim-loser budget or shipped a
**CROPPED** reference where every other run got the generative one.

Fixed by porting the registry + sweep, and wiring it into
`services/processAlerts.js` — into **both** shutdown paths, because an
`uncaughtException` strands a claim exactly as thoroughly as a SIGTERM. The sweep
runs inside the existing bounded `flush()` window (2.5s), so a hung Mongo cannot
stall a deploy, and it never throws out of a shutdown handler.

## The latent defect underneath it

The reframe outpaint (`nano-banana-2/edit`) is a different model on a different
path from the video master (`gemini-omni-flash`). But `reframeReferenceForAspect`
called `pollPrediction(id)` **with no options**, so it inherited `MAX_POLL_MS` —
the *video* ceiling — purely as a default parameter value. Nobody chose that.

Measured reframe latency (n=60, exact join of `CostLog.providerRequestId` for
`stage:'reframe-outpaint'` against the completion log line, 2026-08-24 →
2026-08-27):

| p50 | p95 | p99 | max | mean / sd |
|---|---|---|---|---|
| 48.5s | 136.6s | 220.2s | **232s** | 55.8s / 40.7s |

Zero of 126 billed reframes in seven days hit the ceiling. The inherited ceiling
was **2.6x** the observed max here (3.9x in adgen).

Worse, the *lease floor* was derived from that same video ceiling:
`Math.max(configured, MAX_POLL_MS + 10 * 60 * 1000)`. Two defects in one
expression:

1. **Cross-repo drift.** The claim is a field on the **shared** `Media` document
   that adgen also steals from using its own copy of the formula. adgen raised its
   `ATLAS_TIMEOUT_MS` to 900000 and this repo kept 600000, so the two sides
   silently disagreed about when a holder is dead — **25 min there, 20 min here.**
   A steal is only safe when every repo's floor exceeds every repo's max hold, so
   the floor cannot be a function of a knob only one side turns.
2. **The "+10 min" was already spent.** It reads like safety margin. Term by term
   against the code, bounded non-poll work inside the hold totals **602.5s**, so
   the real margin was `600 − 602.5` = **minus 2.5 seconds**, in both repos,
   before any unbounded term.

## The envelope, re-derived term by term

Every term is a real timeout constant between a winning `tryClaimReframe` and
`persistReframe`. Additive within one trailing poll iteration — the interval sleep,
the GET, and the rate-limit backoff are sequential statements, not alternatives.

| term | s | where |
|---|---|---|
| source GET | 20.0 | `normalizeReframeSource`, `timeout: 20000` |
| mirror upload | 60.0 | Cloudinary SDK default (`uploader.js` `post_request.setTimeout`, 60000) |
| submit POST | 60.0 | `submitImageGeneration`, `timeout: 60000` |
| poll overshoot | 188.0 | 18s interval+jitter (`ATLAS_POLL_INTERVAL_MS=15000` + 3s) + 30s GET + 120s max backoff + 20s peek |
| `fetchOutpaintOutput` | 94.5 | 3 x 30000 + sleeps (1500 + 3000) |
| outpaint upload | 60.0 | Cloudinary SDK default |
| mirror delete | 60.0 | Cloudinary SDK default |
| pad-fallback upload | 60.0 | Cloudinary SDK default |
| **total** | **602.5** | |

**The poll-overshoot term drops to 50s under this PR** (one in-flight GET + the
peek), because `pollPrediction` now respects its own deadline.

⚠️ **The overshoot term is still live on trunk — do not retire it early.** adgen's
#83 introduced the `maxPollMs` *parameter*; it changed **which budget is
enforced**, not **whether the loop respects it**. The condition is still evaluated
only at the top of the `while`, and the body still sleeps a full interval and
*then* issues a 30s-timeout GET before re-testing — ~48s of overshoot before the
rate-limit backoff is even considered. In this repo `maxPollMs` did not exist at
all. The clamp in this PR is the only thing that addresses the overshoot, in
either repo, and group C proves it by running the loop rather than reading it. So the post-fix
envelope is **464.5s**, and the hold is `300 + 464.5` = **764.5s ≈ 12.7 min**
against a 20 min floor — **~7.3 min of real margin**, sized against the terms that
have no timeout at all rather than against arithmetic that merely looked
reassuring.

⚠️ **Do not double-count.** If you re-derive this envelope, the 18s and 120s are
**no longer reachable** on the poll path. That is the whole point of the clamp.

**Read the 602.5s honestly.** It is a fully adversarial stack: a source needing
re-encode, a rate limit landing exactly at the deadline, the outpaint upload
failing so the pad fallback also runs, and every axios timeout firing at its
limit. **A typical hold is ~1-2 min** (measured p50 poll is 48.5s). Nothing in
production shows the envelope being approached.

## What this PR does

1. **`REFRAME_POLL_MS`** — new constant, env key of its own, default **300000**
   (1.29x the observed max, comparable to the 1.18x the video ceiling was sized
   with), clamped to `[60s, min(MAX_POLL_MS, lease − bounded work − 60s margin)]`. Passed **explicitly** at the reframe
   call site.
   The lower clamp is a money guard, not tidiness: `billed` is set at the submit
   POST, so a poll that gives up on a generation Atlas completes converts a PAID
   outpaint into a crop (`crop-after-bill`). Erring long costs claim margin, which
   is cheap and bounded; erring short costs spend.
2. **The lease floor is now an independent constant**,
   `REFRAME_CLAIM_TTL_FLOOR_MS = 20 min`, derived from nothing. Re-deriving it
   from the *new* budget would reproduce the same bug smaller (300s + 10 min = 15
   min, **worse** than what this repo already had). The poll budget is a latency
   choice; the floor is a money guard; they are no longer allowed to move each
   other. **This repo's floor value does not change** — 1200000 before and after.
3. **`pollPrediction` respects `maxPollMs`.** Every sleep is clamped to the
   remaining budget (`sleepWithinBudget`). The loop condition is only tested at the
   top of the `while`, so an iteration entered one millisecond before the deadline
   used to run ~168s past it. Also fixed two diagnostics that computed "remaining"
   from the module-wide `MAX_POLL_MS` rather than the per-invocation budget — on
   the reframe path those now differ, and a stage line that over-reports remaining
   time is what someone debugging a stuck claim reads first.
4. **The SIGTERM/crash claim eviction**, above.
5. **The hold is measurable without a log join.** `persistReframe`'s full `$set`
   of the aspect key is load-bearing — dropping `.claim` is exactly what supersedes
   the lease — but the side effect was that `claim.at` and the completion timestamp
   could never coexist on a settled document, so a hold's duration was not
   recoverable from the data at all. It now records `claimedAt` + `heldMs` as
   **historical record at `entry.claimedAt` / `entry.heldMs`, never
   `entry.claim.at`**, so `tryClaimReframe`'s claimability test is untouched and
   supersede semantics are unchanged. Plus an acquire log line (the winner was
   silent; only the loser logged) and a closing hold line.
   **Deliberately NOT `CostLog.durationMs`** — that measures the provider call,
   which is already measurable, not the hold, which is the window the TTL covers.
   **Digest-safe:** `computeIdentityDigest` hashes `mediaId`, not reframe entry
   contents (verified), so these fields cannot change an ad's identity or re-bill
   a master.

### The upper clamp is lease-derived — found by the sweep, not by reading

B3 probes absurd `REFRAME_POLL_MS` values on both sides of the clamp rather than
sampling near the default, and it caught a real defect: clamping only to
`MAX_POLL_MS` leaves the invariant hostage to that constant's value. In **adgen**,
where `MAX_POLL_MS` is 900000, an operator could set `REFRAME_POLL_MS=900000` and
make the hold `900 + 464.5` = **1364.5s against a 1200s lease** — reopening,
through an env var alone, the exact double-charge this change closes. **This repo
was safe only by accident** (its `MAX_POLL_MS` being 600000). Both repos now
derive the ceiling from the lease.

**This is not the coupling that was just removed; the direction is opposite, and
the direction is the whole point.** The defect was a MONEY GUARD (the lease floor)
derived from a LATENCY KNOB (the video ceiling), so tuning latency silently moved
the money guard. Here a LATENCY KNOB is bounded by the MONEY GUARD: the lease
constrains how long we may poll, and can never be moved by how long we would like
to poll.

## Merge order — THIS PR FIRST, and it is enforced, not remembered

**backend (this PR) → adgen.** Derived, not preference. Let `hold_R` be a repo's
max hold and `floor_R` its steal threshold; a peer in repo A steals a live claim
held by repo B iff `floor_A < hold_B`.

| state | `floor_be` | `hold_be` | `floor_adgen` | `hold_adgen` | new window? |
|---|---|---|---|---|---|
| today | 1200 | 1202.5 | 1500 | 1502.5 | 302.5s (be steals adgen) |
| **backend only** | 1200 | **764.5** | 1500 | 1502.5 | **none added** |
| adgen only | 1200 | 1202.5 | **1200** | **764.5** | 2.5s (adgen steals an unfixed be holder) |
| both | 1200 | 764.5 | 1200 | 764.5 | **none** |

adgen-first passes through a state with a *new* (small) cross-repo window, because
adgen's floor drops 25→20 min while an unfixed backend holder can still run to
20.04 min. Backend-first adds no window at any point. So backend lands first.

**The guard is mechanical:** adgen's PR adds a `scripts/shared-invariants.json`
entry forbidding the `MAX_POLL_MS + 10 * 60 * 1000` coupling, and
`scripts/verifySharedInvariants.js` reads **this repo from `origin/main`** (not a
working tree). If adgen's PR is merged while this one is not, adgen's own suite
goes red on the un-ported backend instance. A rebase cannot silently reopen it —
the check re-reads `origin/main` live rather than trusting a recorded hash.

## Verification

- **Baseline on pristine `origin/main` (`8bd9eebd`), measured in a throwaway
  detached worktree, not inferred:** **207/211**; reds
  `verifyDirectorFallbackChain.js`, `verifyPreparingReap.js`,
  `verifyRenderStages.js`, `verifyTitleBeatScale.mjs`. None reframe-related; the
  `.mjs` one is the documented worktree ESM artifact.
- **After:** **208/212** — same four reds, plus the new harness passing. No
  regressions.
  (Trunk moved twice mid-work: `b5a42717` → `8bd9eebd`, #352 landing a harness of
  its own. The earlier baseline of 206/210 was against `b5a42717`. Both the
  baseline and the revert proofs were re-run after the rebase rather than carried
  over — against the newer trunk the stale pair would have read as zero net gain.)
- `scripts/verifyReframeHoldBounded.js` — **28 checks**, offline (axios stubbed via
  `require.cache`; no DB, network, or Atlas key).
- **Revert-proven against 7 mutations**, each caught, with the baseline green
  before and after:
  M1 bare `pollPrediction(id)` → A1,A2 · M2 restore the `MAX_POLL_MS` coupling →
  A3,B6 · M3 un-clamp the rate-limit backoff → C1 · M4 un-clamp the interval sleep
  → C1 · M5 drop the SIGTERM eviction → D8 · M6 stop threading `claimedAt` → E4 ·
  M7 write the hold record under `claim` → E3.
- `npm run lint` clean on all touched files (`no-undef` — the check three shipped
  regressions here needed).

**Two of my own checks were unsound and were caught by revert-proof, not by
reading:** (a) `check()` was synchronous while two checks were `async`, so their
assertions passed vacuously against a truthy pending Promise; (b) B6 mutated
`process.env.ATLAS_TIMEOUT_MS` in-process, but `MAX_POLL_MS` is resolved **once at
module load**, so it PASSED with the defect deliberately reinstated. B6 now forks
two child processes. Both are the "test oracle shares the bug" shape; the mutation
matrix is what found them.

## Deferred, with reasons

- **`sharp` calls in the hold have no wall-clock deadline.** Not bounded here: no
  `AbortSignal` or `Promise.race` exists anywhere in either copy, and adding a
  deadline to image processing is its own change with its own failure semantics
  (what do you ship when a re-encode is cancelled mid-flight?). The 7.3 min margin
  is sized to absorb it. Note `fitBufferForCloudinary`'s 5-attempt sharp ladder is
  **latent, not exercised**: `CLOUDINARY_MAX_UPLOAD_BYTES` defaults to 40 MiB and
  real 4k reframe outputs measure 6.5-8.5 MB, so it returns the buffer early and
  does no sharp work at all.
- **Mongo ops in the hold are unbounded.** **This repo sets no timeout options at
  all** — the `mongoose.connect` calls in `index.js` and `worker.js` pass only
  `maxPoolSize` (plus the no-op deprecated
  `useNewUrlParser`/`useUnifiedTopology`), so `serverSelectionTimeoutMS` is the
  driver default 30s and `socketTimeoutMS` is unset. (The
  `serverSelectionTimeoutMS: 5000` cited in the brief lives in **adgen's**
  `src/db.js` `CONNECT_OPTIONS`; there is no `db.js` in this repo at all, and the
  only hits here are one-off `scripts/`.) No reframe query passes `maxTimeMS`. Adding either is a global change affecting every query in the repo
  — out of scope for a claim-lease PR, and it would need its own measurement.
  **Whether the live `MONGODB_URI` carries `socketTimeoutMS` as a query parameter
  is NOT determinable from this repo** (it is a Render secret, absent from
  `config/defaults.env`), so the code-level claim stands and the URI-level one is
  unverified rather than refuted.
- **The Cloudinary 60s terms are socket-INACTIVITY timeouts**, not total-duration
  deadlines (`post_request.setTimeout`), so a slow trickling transfer can exceed
  60s while a hung socket cannot. Counted at 60s each anyway; the margin absorbs
  the difference.

## Not acted on, but noted

`REFRAME_CLAIM_WAIT_ATTEMPTS`'s `n=26` is justified in-code by a "measured
worst-case cold reframe stage (5m19s, 3 serialized outpaints)". **That figure has
no measurement behind it** — it appears only as prose, in two places, one of which
cites "this file's own notes". The loser wait never spends, and `n=26` (351s) still
clears the clamp against the 20 min floor, so nothing is changed here. But the
comment should not be cited as evidence by the next person.
