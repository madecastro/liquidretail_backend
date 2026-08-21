# Confirmation-replay hole — INDEPENDENTLY VERIFIED, and refined in both directions

The addendum recorded this as *"reported to me with `path:line` evidence; I have NOT
independently re-verified it."* Now verified, by me, against `origin/main` (via
`codegraph_explore` on the indexed backend plus a targeted read of
`routes/agent.js:296-415`). **The core claim holds.** Two controls the earlier write-ups
did not mention DO fire — and neither one saves the worst case, which makes the severity
for `ad.delete` *higher*, not lower.

## 1. Confirmed — the mechanism is forgeable

- `confirmationsSet = new Set(req.body.confirmations)` (`routes/agent.js:509`) — caller-supplied ids.
- `explicitConfirmations = req.body.explicitConfirmations` (`:510-511`) — caller-supplied phrase map.
- `replayConfirmations` (`:300`) runs **before the LLM loop**, matching only on `call.id`
  (`:315` `if (!confirmationsSet.has(call.id)) continue;`).
- The `role:'tool'` stub must **exist** (`:327` `if (toolIdx < 0) continue;`) but **its content is
  never read** — `toolIdx` is used solely as an index to overwrite (`working[toolIdx] = {...}`).
  So the in-file comment that a hand-crafted history is "skipped" is **false** once the caller
  also forges the stub. Verified.
- `working` derives from `req.body.messages`; there is no nonce and no server-side proposal record.

So a caller who posts an assistant message with `tool_calls`, a matching `role:'tool'` stub, the
id in `confirmations[]`, and the published phrase in `explicitConfirmations` reaches dispatch.

## 2. NOT ungated — two controls run on the replay path (previously unrecorded)

- **`phraseCheck` runs on replay**, not just in-loop (`:334-338`), for tier 3 or any capability
  declaring a phrase.
- **`spendGuard.check()` runs on replay** for tier ≥ 2 (`:365-370`), genuinely awaited and
  enforced with `continue` on block.

So "no controls at all" would be wrong. But:

## 3. ⚠️ Why neither control saves `ad.delete` — the part that matters

**The phrase is a published constant.** `capabilityRegistry.js:2498` declares
`explicitConfirmation: 'DELETE AD'` in the manifest the client is served. Supplying it is
trivial. `phraseCheck` is a **model-facing ceremony** — it stops the LLM smuggling an action —
and was reasoned about as a **caller-facing** control. That framing is the whole bug class.

**spendGuard is DISABLED in production, and would not cover this anyway:**
- `config/defaults.env:1610` ships **`AGENT_DAILY_CAP_USD=0`**, and `0` means **DISABLED** —
  `dailyCap()` returns `null` and the guard short-circuits `allowed:true` without reading
  CostLog (semantics pinned by `verifyAgentRegistry.js:520-528, 529-550`).
- Render WEB carries **only `AGENT_ENABLED=true`** — no `AGENT_DAILY_CAP_USD` override
  (checked via the API). So the cap is off in prod.
- Even with the cap ON it would not help: `ad.delete` declares **`estimateUsd: 0`**
  (`capabilityRegistry.js:2499`), and a zero estimate is `allowed:true` *trivially* (pinned at
  `verifyAgentRegistry.js:514-519`). **spendGuard bounds money, not destruction.**

**And the endpoint is live:** `AGENT_ENABLED=true` in both `config/defaults.env:1572` and on
Render WEB.

**The capability's own description states the stakes** (`capabilityRegistry.js:2495`):
> "HARD-DELETE an Ad doc + best-effort destroy of the Cloudinary render asset. IRREVERSIBLE —
> the Cloudinary asset is gone, and the render cannot be reconstituted without re-billing
> generation (~$0.15-$1.10 depending on kind)."

## 4. Net severity

**Unchanged as urgent, and sharper than before.** The earlier framing implied the phrase gate
might be doing work; it is not, against a caller. For `ad.delete` specifically there is
**no effective control on the replay path at all** — the phrase is public, and the spend guard
is both disabled and structurally inapplicable to a zero-estimate destroy.

Also worth noting, surfaced by codegraph's blast-radius view: **`replayConfirmations`,
`splitByGate` and `spendGuard` all report "no covering tests found."** The most
security-sensitive dispatch path in the agent has no harness.

## 5. What this does NOT change

- Still needs an **owner decision on approach** before code. The three directional options are
  in `session.d/2026-08-21_agent-confirmations-are-not-authorization.md` on branch
  `fix/agent-capability-team-authz` (tip `42f3c3db`), flagged there as not a recommendation.
- Still must **not** be "fixed" in the executors — that closes the privilege-escalation
  consequence only, not tier bypass for non-team capabilities.
- `AGENT_DAILY_CAP_USD=0` is a **separate, cheap, independent hardening** worth raising on its
  own merits: the agent endpoint is live with its documented money defence switched off.
  `config/defaults.env:1588` even names that cap as one of the two defences it is relying on.

## 6. Method note
This was the first use of the codegraph index on this repo (backend 48MB, frontend 12MB, both
already indexed). Two `codegraph_explore` calls surfaced the gate functions, the call graph, the
"no covering tests" signal and the `phraseCheck`/`spendGuard` ordering; one targeted read of a
120-line slice finished it. That replaced what would have been a grep-and-read loop across
`routes/agent.js`, `capabilityRegistry.js` and two harnesses.
