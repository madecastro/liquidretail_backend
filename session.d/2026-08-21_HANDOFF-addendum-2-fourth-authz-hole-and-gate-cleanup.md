# HANDOFF ADDENDUM 2 — 2026-08-21

Appends to `session.d/2026-08-21_HANDOFF-session-2-qc-validated-and-three-authz-holes.md`.
Read that first. This records what happened after it was written: three workstreams
completed, the owner made four more decisions, and **a fourth authz hole was found that is
worse than the privilege escalation.**

---

## 1. 🔴 THE FOURTH AUTHZ HOLE — agent-chat confirmations are not an authorization control

**This is the most serious finding of the session and it is NOT fixed.** Found by a peer
session while fixing the capability-executor bypass. Reported to me with `path:line`
evidence; I have NOT independently re-verified it, so **verify before acting — but treat it
as credible and urgent until you do.**

The claim, in `routes/agent.js`:
- `working` is built **verbatim from `req.body.messages`** (`:523`).
- `replayConfirmations` runs **before any LLM call** (`:531-538`).
- A confirmation is bound to **`tool_call.id` and nothing else** (`:315`) — not the
  capability, not the args.
- The `role:'tool'` stub is checked for **existence only**; its content is never read
  (`:316-327`). So the in-file comment claiming hand-crafted history is "skipped" is **false**
  once a client also forges the stub.
- `:50-51` states outright that the server holds **no chat state** — so there is no nonce and
  no server-side record to bind against.

**Consequence:** any *authenticated* caller can invoke **any capability at any tier with args
of their choosing**, including all five phrase-gated ones (`INVITE MEMBER`, `REMOVE MEMBER`,
`DELETE AD`, `DELETE BRAND`, `PUBLISH TO META`) by echoing the published phrase — and can
**replay the same `tool_call.id` across POSTs.**

**Why this outranks the privesc in §5.1 of the main handoff:**
- Privilege escalation requires an attacker already inside a tenant. **This requires only a
  valid session.**
- Two reachable capabilities are **irreversible or outward-facing**: `ad.delete` is a
  Cloudinary destroy that costs a **re-bill** to reconstitute, and `ads.publishToMeta`
  **publishes externally**.

**Do NOT let anyone "just fix" this in the executors.** The capability-executor guard (§2
below) removes the *privilege-escalation* consequence; it does **not** close tier bypass for
non-team capabilities. A real fix plausibly changes the whole agent request contract (server-
side confirmation state, or binding a confirmation to capability + args + a nonce), so it
needs an owner decision on approach first.

The peer corrected `docs/AGENT.md`, which previously framed `confirmations[]` as "the SOLE
source of authorisation" — that misconception is what produced this bug class.

📌 **USE THE NOTE, NOT THIS SUMMARY, FOR LINE NUMBERS.**
`session.d/2026-08-21_agent-confirmations-are-not-authorization.md` on branch
`fix/agent-capability-team-authz` @ `8980e5c2` is authoritative: the peer re-verified every
line number individually and **found two of its own earlier citations wrong** (`:517`→`:512`
for `clientMessages`, `:540`→`:539` for the model loop). The note also carries three
directional options (server-side proposal record / HMAC-signed proposal / accept it as UX-only
and push authz into executors), explicitly flagged as NOT a recommendation.

**One narrowing worth keeping, from the peer:** the replay path only fires when
`confirmations` is non-empty, so a caller must supply the id **and** a matching `role:'tool'`
stub. That is trivially satisfiable, so the conclusion stands — but it is not "no LLM
involvement is ever needed", and the note deliberately does not overstate it. The genuine bug
is that a **model-facing** control was reasoned about as a **caller-facing** one.

---

## 2. Peer session work — CORRECTED: NOT at risk of loss (I was wrong)

Branch `fix/agent-capability-team-authz` @ **`8980e5c2`** (fix at `5f411615`, plus a `session.d/` write-up of the §1 finding at `8980e5c2`) — the sibling fix for the
capability-executor bypass (§5.1 item 2 of the main handoff). Contents: a new
`services/capabilityExecutors/_teamAuthzCommon.js` that **imports** `canActOnRole` /
`canGrantRole` from the members middleware (zero rank logic of its own, with a harness check
asserting it declares none and cross-checking all 16 caller/target pairs), the four executors
enforcing the same matrix, and `scripts/verifyAgentTeamCapabilityAuthz.js` (33 checks, 8
behavioural revert-proofs).

⚠️ **CORRECTION — my original claim here was WRONG and I verified the correction myself.**
I wrote that this work "exists ONLY at `/private/tmp/.../wt-agent-authz`, which macOS clears on
reboot" and called it time-sensitive. **That is not true, and the peer session was right to
push back on it.** Verified directly:

```
git -C liquidretail_backend rev-parse fix/agent-capability-team-authz  -> 8980e5c2
git -C liquidretail_backend cat-file -t 5f411615                       -> commit
ls .git/refs/heads/fix/agent-capability-team-authz                     -> real 41-byte file
cat <worktree>/.git  -> "gitdir: .../liquidretail_backend/.git/worktrees/wt-agent-authz"
```

**A linked worktree stores no objects and no refs of its own.** Its `.git` is a *file*
pointing back at the main repo, so both commits and the branch ref live on the persistent
`/Volumes/Sayulita` volume. A `/private/tmp` wipe destroys the **working-tree checkout only**,
fully reconstructible with `git worktree add <path> fix/agent-capability-team-authz`, and the
branch ref keeps the objects alive against gc.

**The generalisable lesson, because I conflated two different failure modes:** the four earlier
near-losses on this project were **uncommitted working-tree state** — that genuinely dies with a
wipe, and it is exactly what I found and preserved three times in other worktrees tonight. **A
commit on a branch is not the same thing.** Do not treat "it's in a /private/tmp worktree" as a
loss risk once the work is committed; check `git rev-parse <branch>` from the main repo first.

Pushing is still worth doing for **visibility** and so a fresh orchestrator can see it — but
that is a discoverability argument, not a preservation one. That session's user instructed it
not to push and it correctly refused my request; a peer cannot authorize what another user
forbade, so this remains the owner's call on accurate facts.

**One design constraint from it, worth preserving:** the executor gates sit **after** shape
validation but **before** any membership lookup. That is deliberate — validation touches no
data, it keeps `verifyAgentRegistry`'s arg-validation checks green, and it preserves the
no-existence-probe property (a harness check asserts `findOne` is never called for an
unauthorized caller). If you move the route gates, respect that ordering.

---

## 3. Owner decisions since the main handoff

1. **QC gates: exactly TWO** (`staticVisionQcEnabled`, `videoVisionQcEnabled`). Remove the
   legacy `adVisionQcEnabled` entirely — **and remove the new env vars from
   `config/defaults.env` too**, so the gates live ONLY in SystemConfig ("fewer places for the
   two to disagree").
2. **Approved the production SystemConfig write** needed to make that safe. **DONE — see §4.**
3. **Concurrency limits move into the admin panel and out of env.** Handed to the
   admin-settings workstream. Verbatim: *"also let's put the concurrency limit in the panel
   along with the other concurrency limits and remove that from the env also."*
4. Earlier, still standing: *"I am not pinching pennies I want everything tested, all UI
   elements, everything."*

**My one deviation, flagged to him:** I am removing both new env vars from `defaults.env` as
asked but **keeping the env-READING code** (`staticEnvEnabled`/`videoEnvEnabled` and the shared
`parseBoolEnv`). Removing the file entries is what eliminates the disagreement risk; removing
the reader would also delete the fail-closed fallback ("unconfigured → off") and the only
zero-deploy override if Mongo is unreachable. He has not objected; revisit if he prefers total
removal.

---

## 4. ✅ Production SystemConfig write — DONE and verified

`{key:'default'}` now holds `staticVisionQcEnabled: true`, `videoVisionQcEnabled: true`,
`adVisionQcEnabled: true` (`updatedAt 2026-08-21T03:29:12Z`). Read back and confirmed.

**So the legacy bridge is no longer load-bearing** — the legacy path can be deleted with no
outage window.

⚠️ **How this was written matters, and the trap is general.** A Render one-off job runs the
**deployed** code, whose Mongoose schema does not declare the new fields — and **strict mode
silently drops writes to undeclared paths**, reporting success while persisting nothing. The
write therefore went through the **raw driver**
(`mongoose.connection.db.collection('systemconfigs').updateOne`), not the model. Any future
expand-then-contract migration on this repo needs the same treatment.

The script also refused to run unless legacy was already `true`, so it could only mirror an
existing ON state forward, never change behaviour.

---

## 5. Branch states — all pushed, all verified, all still UNREVIEWED for merge

**Use branch tips, not these SHAs** (they have gone stale three times — see the main handoff's
box in §4).

| branch | tip | state |
|---|---|---|
| `fix/members-invitations-caller-role-guard` | `b6ddf3e9` | **COMPLETE.** Shared `requireMembershipRole` guard, 53/53 harness, 11 revert-prove mutations, 185/185 suite, `/by-token/accept` verified with zero membership. **Must NOT merge alone** — needs `5f411615` (§2). |
| `feat/admin-settings-qc-gates` | `515d41a8` | **Gate split COMPLETE and independently verified by me** — see §6. Legacy-removal pass drafted but NOT yet applied. |
| `fix/qc-verdict-parser-tolerance` | `f005f3c7` | **COMPLETE.** `parseVerdict` tolerates 4 shape drifts without ever inventing a pass. 21 new checks (AA1-AA21), 91/91 in that file, 184/184 suite, 12-row mutation matrix. |

**On the parser branch, one thing is worth reading before merging:** an adversarial Grok pass
found a **real false-pass bug in the first draft** — the candidate-selection heuristic
("prefer the LAST balanced span with a `categories` key") let a genuine *failing* verdict be
discarded in favour of a later passing-looking object, e.g. the model restating an example
shape after its real answer. Redesigned so **any failing candidate beats all passing ones
regardless of order**. That is the whole reason the adversarial pass was worth running.

---

## 6. What I independently verified (so nobody re-does it)

- **The QC gate split does NOT turn QC off on deploy.** I wrote an offline prod-state
  simulation: stub the `SystemConfig` model in the require cache, load the **real committed**
  `config/defaults.env` (so all three env vars are genuinely `'false'`), then drive the real
  getters/resolvers against `{staticVisionQcEnabled:null, videoVisionQcEnabled:null,
  adVisionQcEnabled:true}`. Both getters returned `true` via the bridge; both resolvers
  returned `true`; and an explicit `staticVisionQcEnabled:false` correctly overrode legacy
  `true`. **Recreate this probe before merging the legacy removal** — it is the cheapest proof
  that a gate change cannot silently disable QC.
- Full **184-script suite green** and `npx eslint .` clean, re-run by me on the gate-split
  branch (not taken on the agent's word).
- The getter projects **both** fields in one `.select('staticVisionQcEnabled
  adVisionQcEnabled')` — correct, and non-obvious given this repo's silent-`.select()` trap.

**A subtlety that will bite a harness author:** `runPostRenderQc` / `runVideoPostRenderQc` call
their resolver as a **same-module lexical reference**, so monkey-patching
`qc.resolveStaticEnabled` from a test does **NOT** intercept them. The interceptable hop is
`require('./systemConfigService').getStaticVisionQcEnabled`, a live property lookup on a shared
module object. Established empirically, not by reading.

---

## 7. Next actions

1. **Put §1 in front of the owner.** It is the only open item that lets an ordinary
   authenticated user trigger an irreversible destroy or an external publish.
2. **Get `5f411615` preserved** (§2) before a reboot destroys it.
3. Apply the legacy-gate removal (drafted; prod write already done), re-run the §6 prod
   simulation, then merge the gate split.
4. Review and merge `f005f3c7` (parser) and the two authz branches **together**.
5. Answer the admin-settings design's 11 questions (§6 of the main handoff) — the concurrency
   work in §3.3 is blocked on the precedence question among them.
