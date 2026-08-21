# 2026-08-21 — Agent tier/confirmation gates are not an authorization control

**Status: OPEN. Not fixed. Needs an owner decision on approach before anyone writes code.**
This is deliberately NOT folded into `fix/agent-capability-team-authz` (which closes a
different, narrower hole). It plausibly touches the whole agent request contract rather
than a handful of executors, so it should not be patched opportunistically.

Found while fixing the team-capability privilege escalation; corroborated by an
independent adversarial pass. Every line number below was read directly off
`routes/agent.js` at `2a256808` (identical to `origin/main` for this file).

## The claim

`tier`, `confirmations[]` and `explicitConfirmation` defend against **the model**.
They do not defend against **the caller**. Any authenticated caller can invoke any
capability at any tier, with arguments of their choosing, and can replay the same
invocation across requests.

## The mechanism, with evidence

1. **The whole message history is caller-authored.**
   `const clientMessages = req.body.messages.filter((m) => m.role !== 'system');`
   then `const working = [{role:'system', …}, ...clientMessages];` — `routes/agent.js:512,523`.
   The assistant message carrying `tool_calls` is just an element of that array.

2. **Confirmations are caller-authored too, and are consumed before any LLM call.**
   `confirmationsSet` is built straight from `req.body.confirmations` (`:509`), and
   `explicitConfirmations` from `req.body.explicitConfirmations` (`:510-511`).
   `replayConfirmations` runs at `:531-538`, *before* the `for (let iter = 0; …)`
   model loop at `:539`. So a request that carries `confirmations` dispatches
   capabilities with no model in the loop at all.

3. **A confirmation is bound to `tool_call.id` and nothing else.**
   `if (!confirmationsSet.has(call.id)) continue;` — `:315`. Not the capability id,
   not the tool name, not the arguments. The capability is then looked up from the
   *same caller-supplied* object: `registry.capabilityByToolName(call.function?.name)`
   (`:333`), and args from `JSON.parse(call.function.arguments)` (`:329-331`).

4. **The `role:'tool'` stub is existence-checked but never read.**
   `:317-327` scans forward for `working[j].role === 'tool' && working[j].tool_call_id === call.id`
   and only records the index. Its `content` is never inspected. The comment at `:325-326`
   ("No pending stub → … history was hand-crafted. Nothing to replay; skip.") is therefore
   true only when the client *omits* the stub — supply one and the replay proceeds.

5. **There is no server-side record to bind against.**
   `routes/agent.js:50-51`, verbatim: "STATELESS per-request: the client holds the full
   message history and resends it every turn. Server holds no chat state." No nonce, no
   signature, no single-use token, nothing persisted at propose time.

6. **The phrase gate is a published constant compared to a caller-supplied string.**
   `phraseCheck` (`:234-251`) compares `explicitConfirmations[callId]` against
   `capability.explicitConfirmation` — a fixed string living in the manifest. Any caller
   can type it.

## Consequences

- **Confirm Y, execute X.** Because the binding is `id`-only and the server holds no
  record of what was proposed, a caller can present a tool_call for any capability under
  an id they also list in `confirmations`. There is no "original" to disagree with.
- **Tier is not a barrier.** All five phrase-gated capabilities are reachable by echoing
  the published phrase: `INVITE MEMBER` (`capabilityRegistry.js:2449`), `REMOVE MEMBER`
  (`:2473`), `DELETE AD` (`:2498`), `DELETE BRAND` (`:2521`), `PUBLISH TO META` (`:2549`).
- **Replay.** Nothing marks a confirmation as spent, so the same id can be re-sent on a
  later POST as long as the history still carries a matching stub.

Two of the reachable capabilities are irreversible or outward-facing, which is what makes
this worse than the privilege escalation it was found next to:
- `ad.delete` — hard-deletes the Ad and destroys the Cloudinary render; the manifest itself
  says reconstituting it means re-billing generation (~$0.15–$1.10).
- `ads.publishToMeta` — publishes externally.

Tier ≥ 2 still runs `spendGuard` on the replay path (`:366-398`), so a daily cap is not
bypassed — but a cap is a budget control, not an authorization control, and Tier 1
capabilities skip it entirely.

## Severity

Requires only a valid session for the tenant — unlike the privilege-escalation hole, it
does not require the attacker to already hold a privileged role. Scope is still bounded by
`req.advertiserId`: executors filter on it, so this is not cross-tenant.

`AGENT_ENABLED=true` is the committed default (`config/defaults.env:1572`), so the surface
is live. (`docs/AGENT.md` previously claimed the agent was gated OFF in every env; that was
stale and is corrected in the same commit as this note.)

## What this note is NOT

It is not a claim that the LLM can self-confirm — it cannot, and that gate works as
designed (`routes/agent.js:44-45`). The bug is that a control built to constrain the model
was documented and reasoned about as though it also constrained the caller. That
misconception is what produced the team-executor hole: four executors mirrored an HTTP
route's behaviour, omitted its authorization, and were assumed safe because they sat behind
a tier gate.

## Directional options (NOT a recommendation — for the owner's decision)

1. Persist proposals server-side at propose time (capability id + a hash of args + a nonce),
   and require the confirmation to match that record. Closes confirm-Y-execute-X and replay,
   but introduces the chat state `:50-51` deliberately avoids.
2. Sign the proposal (HMAC over `id|capabilityId|argsHash|exp`) and require the signature
   back. Keeps the server stateless; does not stop replay without an additional spent-marker.
3. Accept that the confirmation layer is UX-only, and require every permission-relevant or
   irreversible executor to carry its own authorization check — the approach already taken
   for `team.*` in `services/capabilityExecutors/_teamAuthzCommon.js`. Cheapest, but it is a
   per-executor discipline rather than a structural guarantee, and the four team executors
   are proof that the discipline does not hold on its own.

## Related

- `fix/agent-capability-team-authz` — closes the privilege-escalation consequence for the
  four `team.*` executors. Does not close tier bypass for anything else.
- `docs/AGENT.md` — "What the tier gates do NOT protect against".
