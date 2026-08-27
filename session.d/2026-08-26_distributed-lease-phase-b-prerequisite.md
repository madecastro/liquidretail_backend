# Distributed singleton lease — the Phase B gating prerequisite

Date: 2026-08-26. Branch `feat/distributed-lease` off `master` @ `16e64e2`.
Design doc: `../DESIGN-adgen-transition.md`, "Phase B" + the station contract.

## Why this had to land before any expansion wiring

Adgen's expansion services (Director, Judge, brief derivation, concept mapping,
mint, per-product caps) are implemented but unreachable — `expandWizardJob` has
zero callers and `orchestrator.js` was a no-op poller. Wiring them makes a
**second expander possible**, and adgen's static identity digests are
**run-scoped**: the `(campaignId, identityDigest)` unique index catches a
duplicate on the *video* side, but static has no equivalent. Two concurrent
expanders would therefore mint two separate, uncaught sets of billable static
ads. So the lease lands, is reviewed, and is proven first. Wiring is the next PR.

## No pre-existing lease existed

`render.yaml`'s `adgen-orchestrator` block has been advertising "distributed
lease handles failover" and `orchestrator.js:5` named
`services/singletonLease.js pattern from backend` — but **no such file existed
anywhere in this repo**. The deploy config was describing something never built.
The reference implementation is `liquidretail_backend/services/singletonLease.js`
(111 lines, collection `singleton_leases`, one caller: backend `worker.js:250`,
lease name `worker-housekeeping`).

## The one deliberate deviation from backend's shape

Backend derives BOTH the expiry comparison and the new `expiresAt` from the
**calling process's** `Date.now()`. That is atomic against a racer, but it
assumes every process's wall clock agrees. A process whose clock runs S seconds
fast sees a live lease as expiring S seconds early; once S >= `ttlMs` it steals a
healthy holder's lease immediately and permanently — two holders coexisting,
which is the exact failure the lease exists to prevent.

adgen's version puts the whole take-or-not decision inside a **Mongo
aggregation-pipeline update keyed on `$$NOW`**, with the filter reduced to
`_id`, so mongod's clock is the sole authority and inter-process skew cannot
matter. Documented at length in the file header — do not "simplify" it back.

## Verified by execution, not by argument

Against **real MongoDB 7** (docker), through Mongoose and the real model:

| case | result |
|---|---|
| 12 concurrent acquires, fresh doc | exactly 1 winner, 0 duplicate-key errors, fence 1 |
| 12 concurrent acquires, **expired** doc | exactly 1 winner, fence incremented exactly once |
| peer attempt while held | loses; incumbent's expiresAt/acquiredAt/fenceToken untouched |
| holder-scoped renew by a non-holder | `null` |
| release → peer acquire | immediate, no TTL wait |
| stale release after peer takeover | `modifiedCount: 0`, peer intact |

`scripts/verifySingletonLease.js`: **22/22 offline**, **35/35** with the
opt-in real-Mongo arm (`LEASE_VERIFY_MONGODB_URI`). The offline arm
hand-evaluates the *real* pipeline the module emits and **throws on any
operator it does not know**, so a future pipeline edit fails loud rather than
silently no-matching. The real-Mongo arm is what proves the offline stub is not
lying about mongod's semantics.

**13 of 13 mutations** made the harness go red (`$lt`→`$lte`, `$$NOW`→client
`Date`, dropping the holder scope from renew and from release, disabling
self-expiry, fence-on-non-takeover, removing the stand-down on a null renew,
removing `stopHeartbeat`, always-report-a-win, keying on the pinnable label,
removing the per-lease nonce, skipping the hand-back write, removing the TTL
floor).

## Two defects found DURING review, both fixed and pinned

1. **HIGH — the exclusivity key must never be a dashboard-pinnable string**
   (found by Grok xhigh; reproduced against real Mongo before fixing).
   `config.js` builds `WORKER_ID` as `ADGEN_WORKER_ID || <random>` and its own
   comment invites pinning. A Render service's env is shared by every instance,
   so a pinned value gives two instances the SAME holder string — and the
   pipeline's self-renew arm (`$eq ['$holder', me]`) then reads a peer's live,
   unexpired row as "already mine". Both win, both heartbeat, `fenceToken`
   never bumps because it is not scored as a takeover. **Nothing notices.**
   Measured before the fix: `A.acquire() -> true`, `B.acquire() -> true`, both
   `holds() -> true`, fence 1 → 1 on an unexpired row.
   Fixed with `deriveHolderId` + a per-process nonce **and** a per-lease-object
   counter (`WORKER_ID` stays as a human-readable prefix only). Pinned by
   R14 (derivation) and R14b (the factory — R14 alone would let the factory
   regress to a bare `config.WORKER_ID`).

2. **MEDIUM — `acquire()` was outside the `leaseGen` fence** (found
   independently by execution here and by the adversarial pass). SIGTERM
   landing while an acquire was in flight had `release()` run first — it saw
   `currentlyHolds === false` and wrote **nothing** — and then the acquire
   resolved, won, and set `currentlyHolds = true` on a process about to
   `process.exit(0)`. The doc was left held by a dead instance with no release
   write ever issued, so a replacement instance had to wait out the whole
   `ttlMs` before it could expand. Not a double-mint, but a self-inflicted
   failover delay in exactly the instance-replacement case this lease is meant
   to smooth. Fixed by applying the same generation discipline `renewOnce()`
   already had, plus a holder-scoped hand-back. Pinned by R13.

Also from review (LOW): the 3-beat ratio is **scale-free** — `ttlMs:30,
heartbeatMs:10` passes it, yet a 40ms event-loop pause expires the lease under
its own live holder. Added `MIN_TTL_MS_PRODUCTION = 15_000`, skipped only when
`opts.model` is injected (harness mode). The mutation run then showed nothing
covered the floor at all; R15 now does.

The `opts.nowMs` monotonic seam is honoured **only** alongside an injected
model, so a production caller cannot half-use the test seams and reintroduce a
wall-clock dependency.

## Scope held

No expansion wiring. `expandWizardJob` is not called. `orchestrator.js` gains
acquire → heartbeat → gate-the-existing-read-only-poll → release-on-shutdown and
nothing else; `entrypoint.js` now **awaits** `orchestrator.shutdown()` (it did
not, so `process.exit(0)` raced the release write). `fenceToken` is exposed and
deliberately unconsumed — it exists so the wiring PR can condition expansion
writes on "still the same lease generation".

## Notes for the next session

- Worktree lives at `/Volumes/Sayulita/Projects/RS/.wt-distributed-lease`, a
  **sibling**, per CLAUDE.md. The task brief asked for a nested `.worktrees/`
  path; CLAUDE.md forbids that and won.
- `verifyVendorDrift.js` is RED on this branch — **already KNOWN-OPEN on
  `master`, not caused by this PR.** Proven: a pristine `origin/master`
  worktree placed at a sibling path exits 1 identically. It passes from a
  `/private/tmp` checkout only because the sibling backend is unresolvable
  there and drift is skipped.
- **Cross-repo follow-up, not fixed here:** backend's own lease cannot
  self-expire on renewal failure. If its renewals *throw* (Mongo unreachable)
  rather than return null, `currentlyHolds` stays true while the row expires
  server-side and a peer takes over — two instances both running
  `startScheduler` + `runWatchdog`, duplicating paid Apify demo syncs and Slack
  alerts. Live-reachable: the `liquidretail_backend` worker is at
  `numInstances=1` but **autoscaling is enabled, min 1 max 2**. Clock skew
  specifically is a latent footnote there (needs >= 90s skew); the
  renewal-throws path is the real one.
