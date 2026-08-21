# Authz review record + the concurrency boot-timing finding — 2026-08-21

Two things the previous handoff files could not yet record: my own review of the privesc
fix (which I had flagged as outstanding), and a finding that changes what the admin
settings panel can honestly promise.

---

## 1. My line-by-line review of `fix/members-invitations-caller-role-guard` @ `b6ddf3e9`

I had recorded this branch as "complete but UNREVIEWED", and a peer session correctly
pointed out that its own work sits on top of mine, so a green suite on the peer's branch
includes my unreviewed code. Closing that gap. **Verdict: the guard logic is sound.**
Not yet merged — see §1.3.

### 1.0 Independent peer read — my target-2 reasoning CONFIRMED empirically
A peer session re-read this branch (I asked, precisely because I wrote the brief the
implementing agent worked from, so my own review was not independent). It **executed the real
exported helpers across all 16 caller/target pairs** rather than reasoning about them:
`canActOnRole(r,r)` is true for all four roles, and **all six possible self-promotions**
(viewer→editor/admin/owner, editor→admin/owner, admin→owner) are blocked by `canGrantRole` and
by nothing else. Zero promotions slip past. So §1.1's claim below stands, verified behaviourally.

### 1.1 What I verified myself, reading `middleware/requireMembershipRole.js`
- `roleRank()` uses `Object.prototype.hasOwnProperty.call(...)`, so `__proto__` /
  `constructor` cannot poison the lookup, and an unknown role ranks `-Infinity`.
- `canGrantRole(caller, requested) = rank(requested) <= rank(caller)` correctly yields all
  three required properties at once: **admin (2) can never grant owner (3)**;
  **self-promotion is blocked** (this is the check that does it — `canActOnRole` is
  trivially true for self since rank == rank); and **self-demotion stays allowed**.
- `canActOnRole(caller, target) = rank(caller) >= rank(target)` stops an admin touching an
  owner at all ("escalation-by-deletion"). Same-rank peers acting on each other is
  deliberate and documented.
- Both functions document the same real caveat — an unrecognised *target*/*requested* role
  ranks `-Infinity`, so they return true against garbage. Safe here because target roles
  come off a schema-enum'd document and both call sites run
  `VALID_ROLES.includes(role)` → 400 first. **Any new caller must keep that ordering.**
- The middleware fails closed on a missing role, and the self-target carve-out is opt-in
  per call site (deliberately NOT on PATCH, where self-targeting must stay rank-checked).
- The super-admin bypass is deliberately **not** implemented and is documented as a seam.
  Correct: `requireAuth`'s `expandSuperAdminMemberships` already synthesises `role:'owner'`
  on every advertiser, so a super-admin satisfies a role check for free. Adding a bypass
  here would be redundant surface.

### 1.2 ⚠️ CONDITIONAL FINDING — a load-bearing invariant nobody had written down
The self-resign carve-out lets a member of **any** role `DELETE` their own membership. That
is correct behaviour and the handler's last-owner `409` still applies. But it makes
"reach zero active memberships" an easy, deliberate action, and that is the trigger for
`requireAuth`'s self-heal (`:87-111`), which mints a membership with **`role:'owner'`**.

⚠️ **CORRECTED — my "not exploitable today" conclusion below was WRONG.** I claimed the
blocker was "nothing hard-deletes an AdvertiserMembership row." **There is one**, found by an
independent peer read and verified by me:

`services/accountDeletionService.js:127`
```js
const memRes = await AdvertiserMembership.deleteMany({ advertiserId: a.advertiserId });
```
Its own comment says it removes "the user's, plus any pending/revoked rows" — i.e. it frees
exactly the partial-unique-index slot I was relying on. And the cascade's own guards count
**`status:'active'` only** (`:50-53`, `:62-64`), so a revoked member does not block it.

**Two more corrections to my facts:**
- I cited only `routes/onboarding.js:111` as writing `User.advertiserId`. There is a **second
  site**: `routes/invitations.js:216-221`, on invite accept, guarded by
  `if (!req.userDoc.advertiserId)`. So a stale pointer can be created by accepting an invite,
  not just by onboarding.
- The index reading itself was right: `models/AdvertiserMembership.js:66-69`,
  `{advertiserId:1, userId:1}` unique, `partialFilterExpression: { userId: {$type:'objectId'} }`
  — type, not status. That reasoning holds; it just does not survive a hard delete.

**The live-route chain, no migration script needed:**
1. V accepts an invite to advertiser X with a null pointer → `V.advertiserId = X`, row `(X,V)` active.
2. V is revoked, or resigns via the self-target carve-out → row `status:'revoked'`, pointer still X.
3. V holds no other active membership.
4. The sole owner of X deletes their account. The cascade only checks for other **active**
   members, so V does not block it → `deleteMany({advertiserId: X})` **hard-deletes V's revoked row.**
5. V authenticates → 0 active memberships, truthy pointer → self-heal inserts
   `{X, V, role:'owner', status:'active'}`. **No 11000, because the row is gone.** V is now owner.

**Severity — narrower than it first looks, and I agree with the peer's framing here.** By step 4
the Advertiser doc and its brands are already deleted, so V inherits owner of a **ghost tenant**,
not access to anyone's data. V also cannot drive it end-to-end: steps 1-2 are V's, but step 4
belongs to an unrelated party. So this is a **latent integrity bug** — unearned `owner`, a
resurrected deleted tenant, a user dropped into a broken workspace instead of onboarding, and V
able to invite others into a tenant whose Advertiser row does not exist. **Not a blocker for the
members-authz PR**, which neither introduces nor worsens it beyond making step 2 a one-request
action.

⚠️ **The sharper variant is operator-run, and the ordering is load-bearing and undocumented.**
`scripts/backfillAdvertiser.js:71` does
`User.updateMany({advertiserId:null},{$set:{advertiserId:defaultAdv._id}})` and creates **zero**
memberships — the file contains **no `AdvertiserMembership` reference at all** (verified). Run
alone, every affected user self-heals to **owner of the default advertiser, which still exists**
— so this variant is not a ghost tenant. `scripts/backfillMemberships.js` is the pairing script
that mints rows from the pointers; the pair is only self-consistent **if both run, in order**.

**Cheapest real fix (peer's suggestion, and I agree):** make self-heal require that the
`Advertiser` doc still exists AND refuse to mint `owner` for a pointer with no corroborating
membership history — one extra query, closes the whole class. Alternatively clear
`User.advertiserId` wherever the row it points at stops being active (revoke, resign, and the
cascade's `deleteMany`).

---

**Original (now-falsified) reasoning, kept so the failure mode is legible:** I traced whether
that is exploitable and concluded **it is not, today** — for these reasons:

- `User.advertiserId` is written at onboarding (`routes/onboarding.js:111`) and on
  invite-accept-if-null, and is **never cleared** on revoke or resign. So a stale pointer
  is possible in principle.
- The escalation would need that pointer aimed at an advertiser where the user has **no
  membership row at all**. But **no code path hard-deletes a membership row** — `DELETE
  /api/members/:userId` sets `status:'revoked'` and keeps it, and that row keeps its slot
  in the partial unique index on `(advertiserId, userId)` (which filters on
  `userId: {$type:'objectId'}`, NOT on status), so self-heal's `create` throws 11000, the
  soft-fail catch swallows it, and the request correctly 403s.
- Onboarding and invite-accept both create a row alongside the pointer.

**So the safety of this rested entirely on "nothing hard-deletes an AdvertiserMembership" — and that premise is FALSE (see the correction above).**
That invariant is undocumented and the planned **Users tab is precisely where someone would
add a "remove user permanently" button.** If a hard delete is ever introduced, the
self-resign → self-heal → owner path becomes live. Either keep revoke-not-delete as an
enforced invariant (ideally pinned by a harness), or clear `User.advertiserId` in the same
operation.

### 1.3 Not merged, and why
- The branch is based on an older `main`, so `git diff origin/main..b6ddf3e9` shows later
  doc commits as deletions. That is a rebase artifact, not content loss (merge computes
  against the merge base) — but **rebase onto current `main` before merging** so nobody has
  to reason about it.
- **It must not merge alone.** The agent-capability executors reach the same mutations via
  `POST /api/agent/chat`; see the addendum's §1 and §2.
- An adversarial Grok review at `xhigh` was still running when this was written. Collect it
  before merging; it may add findings beyond §1.1-1.2.

---

## 2. Concurrency in the admin panel: every knob is boot-time-only

The owner asked for the concurrency limits to move into the panel and out of env. The
design work found something that changes what the panel can honestly promise, verified by
reading real require order rather than inferred:

**All 19 knobs in `services/concurrency.js` resolve synchronously from `process.env` at
first require, into a frozen snapshot (`:262`, `Object.freeze(resolveAll())`) — and in BOTH
processes that happens before Mongo is even connected** (`index.js`: concurrency at line 8,
`mongoose.connect` at line 296; `worker.js`: line 41 vs line 175).

So a DB-backed override **cannot reach that resolution point without reordering boot.** A
panel that accepts a concurrency change and appears to apply it would be the
"looks right, silently does nothing" class this repo has been bitten by repeatedly.

**Two distinct fixes, deliberately not conflated:**
- Removing the env vars **does** fix the two-sources-disagree failure — the
  `RENDER_CONCURRENCY` precedent in `CLAUDE.md` §4a, where the dashboard pinned 4 while the
  file said 8 and production silently ran at 4 for a day.
- It does **not** make changes take effect without a restart. That is a separate, unsolved
  problem. The design therefore mandates non-dismissable "takes effect on next restart" UI
  copy for boot-only knobs.

**One partial exception**, confirmed at its only production call site:
`ATLAS_SUBMIT_SPACING_MS` / `GROK_MAX_RPS` go through `submitSpacingMsForModel()`, which
defaults to an uncached `resolveAll()`, and `atlasVideoService.js:2964` calls it with no
cached values — so those two genuinely re-derive per video submit. Recommendation was to
still defer them, so the category ships with one uniform story rather than two knobs
behaving differently on day one.

**Also worth carrying:** `GROK_MAX_RPS` is the only genuinely provider-imposed knob (Grok's
real 1 RPS) — proposed read-only rather than editable-and-silently-clamped. And
`VEO_CONCURRENCY` is **per-process** while WEB autoscales 1-3 instances
(`docs/PIPELINES.md:1603`), with pacing state in plain in-memory `Map()`s and zero
cross-instance coordination — so aggregate submit rate can run ~3x over the provider
ceiling. That corroborates an existing independent finding (`ARCHITECTURE_REVIEW.md`
PIPELINE-7). The panel must not imply these are fleet-wide caps.

---

## 3. Branch SHAs — the peer's are NEW; the ones in earlier files are stale

The peer rebased onto my completed branch and re-verified the composition:

| branch | tip | note |
|---|---|---|
| `fix/agent-capability-team-authz` | **`42f3c3db`** | was `8980e5c2`; fix now `2e4ec3ec` (was `5f411615`) |
| `fix/members-invitations-caller-role-guard` | `b6ddf3e9` | reviewed, §1 |
| `feat/admin-settings-qc-gates` | `f8a87b4d` | gate split + concurrency design |
| `fix/qc-verdict-parser-tolerance` | `f005f3c7` | complete |

**Always resolve the tip with `git fetch && git rev-parse <branch>`** — these have gone
stale four times now.

**The composition is proven**, which nobody had tested before: on the combined tree,
`verifyMembersAuthz` 53/53, `verifyAgentTeamCapabilityAuthz` 33/33 (8 revert-proofs),
full suite 185/186, eslint clean. The single failure is `verifyTitleBeatScale.mjs`, a
worktree-only missing-`remotion` ESM false-fail (`NODE_PATH` fixes CommonJS only, ESM
ignores it) — judge it from the main checkout. The peer's A3 check cross-checks all 16
caller/target pairs against my helpers and is green against the *completed* branch, so a
rank-semantics drift would fire rather than silently diverge. My review in §1 did not
change rank semantics, so that check stays valid.
