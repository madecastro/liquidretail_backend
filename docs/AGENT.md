# Home-page conversational agent

Backend for the operator-facing chat drawer. Natural-language interface
that routes to typed capabilities (`catalog.listProducts`, `ad.archive`,
`ads.publishToMeta`, …) so the operator can inspect, mutate, and orchestrate
without leaving the home page.

**Currently ON by default** — `AGENT_ENABLED=true` in `config/defaults.env`
(line 1572). Set it to `false` per-env to disable. When disabled, the
endpoint returns `503 Service Unavailable` with a clear reason so the
frontend can distinguish "feature off" from "backend missing".
(This section previously claimed the agent was gated OFF in every env. It
was not, and that error made a live authorization hole read as unreachable —
see "What the tier gates do NOT protect against" below.)

## The one rule that would have saved the most time

**The client's `confirmations[]` array is the sole thing standing between a
tool_call and dispatch for Tier 1+.** A rogue LLM that emits a tool call for
`ad.archive` without operator input hits the server-side gate and gets a
synthetic `{ ok:false, needsConfirmation:true }` result — it CANNOT
self-confirm. Same for phrase gates (Tier 3) and spend gates (Tier 2+). If
you're reading this because you want to bypass a gate: **don't**. The gates
are the safety net. Every capability that ships must live under them.

## What the tier gates do NOT protect against

Read this before you assume a capability is safe because it is Tier 3.

The tier system defends against **the model**, not against **the caller**.
`confirmations[]` and `explicitConfirmations` both arrive in the REQUEST
BODY (`routes/agent.js:508-511`), and `working` — the whole message history,
including the assistant `tool_calls` being replayed — is built verbatim from
`req.body.messages` (`:523`). `replayConfirmations` (`:300-443`) then runs
BEFORE any LLM call whenever `confirmations` is non-empty, dispatching those
client-authored tool_calls directly. Concretely:

- A confirmation is bound to a `tool_call.id` and NOTHING else — not the
  capability id, not the tool name, not the arguments. The server keeps no
  record of what was proposed (`:50-51`, "Server holds no chat state").
- The `role:'tool'` stub the replay looks for is only checked for
  EXISTENCE (`:319-327`); its `content` is never read. The code comment
  saying hand-crafted history is skipped holds only when the client omits
  the stub — supply one and the replay proceeds.
- An `explicitConfirmation` phrase is a fixed string published in the
  manifest and compared against a caller-supplied value. Any authenticated
  caller can type `"REMOVE MEMBER"`.

So: **tier + confirmation + phrase are UX friction and anti-LLM-self-confirm
controls. They are NOT authorization.** An authenticated caller can invoke
any capability at any tier with arguments of their choosing.

**Therefore every capability that mutates permission-relevant state must
enforce its own caller-role check inside the executor.** The `team.*`
membership capabilities do this via
`services/capabilityExecutors/_teamAuthzCommon.js`, which reuses the same
`canActOnRole` / `canGrantRole` helpers as the HTTP routes
(`middleware/requireMembershipRole.js`). `/api/agent` is mounted with
`requireAuth` ONLY (`index.js:207-208`) — there is no role middleware on the
agent path, and Express middleware cannot gate an executor anyway, because an
executor is a plain `run({req, args})` function rather than a route layer.

If you add a capability that changes who can do what, mirror that pattern.
An executor whose header comment says "Mirrors `<some HTTP route>`" must
mirror the route's AUTHORIZATION, not just its behaviour — four of them
mirrored only the behaviour, and that was a live privilege-escalation hole.

---

## Files

```
routes/agent.js                                 — POST /api/agent/chat (SSE)
services/capabilityRegistry.js                  — manifest + validator + helpers
services/agentTools.js                          — dispatcher (Tier 0-3 non-workflow)
services/atlasLlmStreamService.js               — streaming Atlas wrapper
services/spendGuard.js                          — Tier ≥ 2 spend cap check
services/capabilityExecutors/*.js               — one file per capability
services/catalogProductReviewRefreshService.js  — single-product review scrape (for the Tier 4 workflow)
scripts/verifyAgentRegistry.js                  — 176-check offline verifier
config/defaults.env                             — AGENT_* knobs
```

The endpoint mounts at `index.js` behind `requireAuth`:

```js
const agentRoutes = require('./routes/agent');
app.use('/api/agent', requireAuth, agentRoutes);
```

Tenant scope: every executor receives the authenticated `req` and enforces
`req.advertiserId` in its own DB queries. The endpoint never lets the LLM
pick which advertiser to operate against.

---

## Endpoint contract

```
POST /api/agent/chat
Auth: session cookie / bearer (requireAuth)
Content-Type: application/json
```

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `messages` | `Message[]` | yes | Full chat history. Client is authoritative — server holds no chat state. Cap: `AGENT_MAX_MESSAGES=40` |
| `context` | `{ brandId?, adId?, campaignId?, productId? }` | no | UI selection; capabilities that need one of these IDs use it as a default when the LLM omits it. Whitelisted keys only |
| `confirmations` | `string[]` | no | Array of `tool_call_id`s the operator has confirmed. Populated by the client only after Confirm is clicked. Empty on the initial request |
| `explicitConfirmations` | `{ [tool_call_id]: string }` | no | Tier 3 phrase-gate. Object mapping tool_call_id to the phrase the operator typed (e.g. `"PUBLISH TO META"`) |

`Message` shape (OpenAI-compatible; the same shape the LLM sees):

```ts
type Message = {
  role: 'user' | 'assistant' | 'tool' | 'system';   // system stripped by server
  content: string | Array<...> | null;               // null allowed on tool-call-only assistant messages
  tool_calls?: [{ id, type: 'function', function: { name, arguments: string } }];
  tool_call_id?: string;                             // required on role='tool'
};
```

### Response

**SSE stream** (`Content-Type: text/event-stream`) — one connection stays
open for the whole tool-loop. See event vocabulary below.

Buffered mode does not exist. Every response goes through SSE.

---

## SSE event vocabulary — the client-facing contract

Wire format: `event: <name>\ndata: <json>\n\n`. Client binds via
`EventSource.addEventListener('<name>', ...)`.

**DO NOT change the event names or payload shapes silently.** The frontend
binds against these; a rename is a breaking change that manifests as a
silently-broken chat UI.

| Event | When emitted | Payload | Terminal? |
|---|---|---|---|
| `iteration` | Start of each LLM tool-loop iteration | `{ n }` (0-indexed) | no |
| `assistant-delta` | Every text token/chunk from the LLM | `{ text }` | no |
| `tool-use-start` | LLM has emitted id + name for a tool_call (before arguments are complete) | `{ toolCallId, toolName }` | no |
| `tool-use-complete` | LLM has finished a tool_call; args JSON-parsed | `{ toolCallId, toolName, args }` | no |
| `tool-result` | Tool has been dispatched (or gated) — result available | `{ toolCallId, result }` | no |
| `proposed-action` | Tier ≥ 1 tool_call intercepted, awaiting confirmation | `{ toolCallId, toolName, args, tier }` | no |
| `plan-proposed` | Tier 4 workflow preview computed, awaiting confirmation | `{ toolCallId, toolName, plan }` | no |
| `workflow-progress` | Per-step progress during Tier 4 execute | `{ toolCallId, toolName, step, totalSteps, item, outcome, ... }` | no |
| `spend-guard-block` | Tier ≥ 2 dispatch blocked by daily cap | `{ toolCallId, toolName, reason, dailyCap, spent, estimateUsd, projected }` | no |
| `tier3-phrase-block` | Tier 3 dispatch blocked by missing/wrong phrase | `{ toolCallId, toolName, reason, required }` | no |
| `done` | Server finished this turn — connection closes after | `{ stop_reason, iterations, model }` | **yes** |
| `error` | Server hit an unrecoverable error — connection closes after | `{ error }` | **yes** |

`stop_reason` values: `'end_turn'`, `'pending_confirmations'`,
`'max_iterations'`, `'length'`, `'aborted'`.

### Event ordering per iteration

Within one loop iteration the server emits:

```
1. iteration { n }
2. 0..N × assistant-delta { text }                    ← streams as tokens arrive
3. 0..M × tool-use-start { toolCallId, toolName }     ← as tool_call ids resolve
4. per tool_call in this iteration:
     tool-use-complete { toolCallId, toolName, args }
     [optional] spend-guard-block  OR  tier3-phrase-block   (before dispatch)
     [Tier ≥ 1 unconfirmed] proposed-action { toolCallId, toolName, args, tier }
     [Tier 4 unconfirmed]   plan-proposed { toolCallId, toolName, plan }
     [Tier 4 confirmed]     0..K × workflow-progress { ... }
     tool-result { toolCallId, result }
5. (next iteration OR done/error)
```

`tool-use-start` may arrive multiple times per call as delta chunks come in
with `id` and `name` — the frontend should treat repeats as idempotent.

---

## Confirmation flow — turn 1 → turn 2

Example: operator says "archive ad 6a68f022ac9815dfb38dd40c".

### Turn 1

Client sends:

```json
POST /api/agent/chat
{
  "messages": [
    { "role": "user", "content": "archive ad 6a68f022ac9815dfb38dd40c" }
  ],
  "context": { "brandId": "6a4e7dcf7b13860ec3a31872" }
}
```

Server streams:

```
event: iteration
data: { "n": 0 }

event: assistant-delta
data: { "text": "I'd like to archive ad 6a68f022... " }

event: assistant-delta
data: { "text": "(currently in status 'draft'). Reversible via ad.restore. Confirm?" }

event: tool-use-start
data: { "toolCallId": "call_1", "toolName": "ad__archive" }

event: tool-use-complete
data: { "toolCallId": "call_1", "toolName": "ad__archive", "args": { "adId": "6a68f022ac9815dfb38dd40c" } }

event: proposed-action
data: { "toolCallId": "call_1", "toolName": "ad__archive", "args": {...}, "tier": 1 }

event: tool-result
data: { "toolCallId": "call_1", "result": { "ok": false, "needsConfirmation": true, "toolCallId": "call_1", "toolName": "ad__archive", "tier": 1, "note": "..." } }

event: done
data: { "stop_reason": "pending_confirmations", "iterations": 1, "model": "gemini-2.5-flash" }
```

Client:
- Appends the assistant message (with `tool_calls`) to its local history.
- Appends the synthetic pending tool result (from the `tool-result` event) to its history.
- Renders the assistant text + a Confirm/Cancel card for the proposed action.

### Turn 2 (operator clicks Confirm)

Client sends:

```json
POST /api/agent/chat
{
  "messages": [
    { "role": "user", "content": "archive ad 6a68f022ac9815dfb38dd40c" },
    { "role": "assistant", "content": "I'd like to archive ...", "tool_calls": [
      { "id": "call_1", "type": "function", "function": { "name": "ad__archive", "arguments": "{\"adId\":\"6a68f022...\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":false,\"needsConfirmation\":true,...}" }
  ],
  "context": { "brandId": "6a4e7dcf..." },
  "confirmations": ["call_1"]
}
```

Server:
- `replayConfirmations()` walks the last assistant message's `tool_calls`,
  finds `call_1` in `confirmations`, dispatches `ad.archive` for real, and
  REPLACES the synthetic pending tool result in `messages` with the real
  result.
- Emits `tool-result { toolCallId: "call_1", result: { ok: true, ... } }` for
  the frontend.
- Enters the LLM loop with the updated history — LLM sees the real success
  result and produces a natural summary.

Server streams:

```
event: tool-result
data: { "toolCallId": "call_1", "result": { "ok": true, "kind": "adUpdate", "data": {...} } }

event: iteration
data: { "n": 0 }

event: assistant-delta
data: { "text": "Done — ad 6a68f022... is now archived." }

event: done
data: { "stop_reason": "end_turn", "iterations": 1, "model": "gemini-2.5-flash" }
```

Client:
- Updates the pending action card to a completed card (from `tool-result`
  with `ok:true`).
- Renders the assistant text.

### Tier 3 phrase gate — turn 2 needs `explicitConfirmations` too

For a Tier 3 action (e.g. `ads.publishToMeta`), the operator ALSO has to type
the required phrase. Turn 2 body carries both:

```json
{
  "messages": [...same history...],
  "context": {...},
  "confirmations": ["call_1"],
  "explicitConfirmations": { "call_1": "PUBLISH TO META" }
}
```

Wrong or missing phrase → server emits `tier3-phrase-block` + synthetic
`{ ok:false, tier3PhraseBlocked:true }` result. Operator re-confirms.

### Tier 4 workflow — plan → confirm → execute

Same shape as Tier 1, but the pending tool result carries a `kind:'plan'`
payload the frontend renders as a rich plan card (summary, step count,
estimated wall time, sample steps). On confirm, the server invokes the
workflow's `execute()` phase and streams `workflow-progress` events per
step until the final `tool-result { ok:true, kind:'workflowResult' }`.

---

## Risk tier model

Every capability declares a `tier: 0 | 1 | 2 | 3 | 4`. The tier determines
which gates apply.

| Tier | Semantics | Required declarations | Server gates |
|---|---|---|---|
| **0** | Read-only, autonomous | (none) | Dispatch immediately |
| **1** | Cheap write, reversible | (none) | Confirmation gate |
| **2** | Billable write | `estimateUsd` | Confirmation gate + spend gate |
| **3** | External / hard-to-reverse | `estimateUsd`, `explicitConfirmation` | Confirmation gate + phrase gate + spend gate |
| **4** | Multi-step workflow | `estimateUsd`, `execute.workflow=true` | Preview / execute + spend gate + (optional) phrase gate |

`validateManifest()` enforces these declarations at registry-load. A Tier 2
without `estimateUsd` or a Tier 3 without `explicitConfirmation` refuses to
load. Same fail-closed rule for workflow shape (Tier 4 must have
`execute.workflow=true` and no `method`).

### Gate ordering — per dispatch

```
tool_call arrives
      │
      ├─ Standard capability (Tier 0-3)
      │       │
      │       ▼
      │  splitByGate → toDispatch / toGate
      │       │
      │       ▼  (per call in toDispatch)
      │  phrase gate (Tier 3 OR opt-in)
      │       │
      │       ▼
      │  spend gate (Tier ≥ 2)
      │       │
      │       ▼
      │  agentTools.dispatch → executor.run()
      │
      └─ Workflow capability (Tier 4)
              │
              ▼
         splitByGate → toWorkflowPreview / toWorkflowExecute
              │
              ├─ Preview (unconfirmed): executor.preview() → emit plan-proposed
              │
              └─ Execute (confirmed):
                      │
                      ▼
                 phrase gate (if opt-in)
                      │
                      ▼
                 spend gate (Tier ≥ 2 estimateUsd)
                      │
                      ▼
                 executor.execute({ onProgress })  ← streams workflow-progress
```

Phrase gate runs BEFORE spend gate — a phrase-less confirmation can't reach
a billable estimate check. Irrelevant for `ads.publishToMeta` (0-cost) but
load-bearing for any future Tier 3 that IS billable.

---

## Registered capabilities (as of this doc)

| id | Tier | Scope | Executor | Notes |
|---|---|---|---|---|
| `catalog.listProducts` | 0 | brand | `catalogListProducts` | Filters: `missing:'lifestyle_image'`, `'onsite_reviews'`, `'video_media'` |
| `ad.inspect` | 0 | ad | `adInspect` | Compact snapshot (kind, template, status, model, prompt preview, regen state) |
| `spend.today` | 0 | advertiser | `spendToday` | Rolling 24h (or `sinceHoursAgo` up to 168) CostLog rollup |
| `ad.archive` | 1 | ad | `adArchive` | `Ad.status → 'archived'`. Idempotent |
| `ad.restore` | 1 | ad | `adRestore` | Archived → draft (or queued if no renderUrl) |
| `brand.updateTagline` | 1 | brand | `brandUpdateTagline` | `≤200` chars; returns `priorTagline` |
| `ad.regenerateWithPrompt` | 2 | ad | `adRegenerateWithPrompt` | ~$0.15 gpt-image-2/edit. Kicks async; poll `ad.inspect` |
| `ads.publishToMeta` | 3 | brand | `adsPublishToMeta` | Phrase: `"PUBLISH TO META"`. Batch ≤20 |
| `catalog.refreshReviewsForBrand` | 4 | brand | `catalogRefreshReviewsForBrand` | Workflow: fans out over products missing on-site reviews via the 3-tier scraper |

Total: 9 capabilities across 4 tiers.

---

## Adding a new capability — the recipe

### 1. Write the executor

`services/capabilityExecutors/<yourCapability>.js`. Standard shape:

```js
async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  // Validate args shape.
  // Cross-tenant guard: any object the LLM referenced must resolve
  // under req.advertiserId (Brand.findOne({ _id, advertiserId }) etc.).
  // Perform the action.
  return {
    ok: true,
    kind: '<resource-tag>',   // frontend ResourceCard dispatches on this
    data: { ... }
  };
}
module.exports = { run };
```

Never throw — return `{ ok:false, error }` for user-facing failure. The
dispatcher's try/catch will convert throws to internal-error results, but
the executor is the right place to shape the failure.

**Tenant scoping is your job.** The dispatcher forwards `req` — the executor
enforces. A `Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })`
that returns nothing → `{ ok:false, error: 'brand ... not found' }` (same
message as a genuinely missing row; do NOT distinguish, or you leak
existence across tenants).

### 2. Register the capability

Add an entry to `CAPABILITIES` in `services/capabilityRegistry.js`. For a
Tier 1 example:

```js
{
  id:       'your.capability',                   // globally unique, dotted namespace
  title:    'Human-readable title',
  describe: 'What this does, why, and when the LLM should reach for it. Include tier-specific behavior in the describe so the model has full context.',
  tier:     1,                                    // 0 | 1 | 2 | 3 | 4
  scope:    'ad',                                 // ad | brand | advertiser | product | campaign | global
  args: {
    type: 'object',
    required: ['adId'],
    properties: {
      adId: { type: 'string', description: 'Ad ObjectId.' }
    },
    additionalProperties: false                   // strict — LLM must not smuggle keys
  },
  execute: {
    kind:    'service',
    service: './capabilityExecutors/yourCapability',
    method:  'run'
  }
}
```

Tier ≥ 2 also needs `estimateUsd: <number>` (or a function `(args) => number`).
Tier 3 also needs `explicitConfirmation: "SOME PHRASE"` (4-100 chars).
Tier 4 uses `execute.workflow: true` + no `method` (see below).

### 3. Extend the verifier

`scripts/verifyAgentRegistry.js` needs a check that:
- The new executor file loads and syntax-checks.
- It rejects a missing advertiser scope (add to `checkTenantGuard` if
  the loop doesn't auto-cover it — currently it does).
- Any capability-specific arg validation you added.

Run `node scripts/verifyAgentRegistry.js` — must be 100% green before push.

### 4. Update the system prompt if the LLM needs guidance

Most capabilities don't require prompt changes — the manifest describe
field is enough for the LLM to know when to reach for the tool. Update the
prompt only when the CAPABILITY introduces new SEMANTICS (a new tier, a
new gate, a new response shape the model needs to interpret specially).

The prompt lives in `routes/agent.js::buildSystemPrompt()`.

---

## Two-phase workflow pattern (Tier 4)

A Tier 4 capability exports `preview()` and `execute()` instead of `run()`.
Registry entry declares:

```js
{
  id:       'catalog.doTheThing',
  tier:     4,
  scope:    'brand',
  estimateUsd: 0,   // required (Tier ≥ 2 rule)
  args:     { ... },
  execute: {
    kind:     'service',
    service:  './capabilityExecutors/catalogDoTheThing',
    workflow: true    // marks this as two-phase; NO `method` field
  }
}
```

Executor shape:

```js
async function preview({ req, args }) {
  // Tenant guard. Enumerate targets. Cost estimate. Wall-time estimate.
  // Never mutate. Return a plan the operator can approve.
  return {
    ok: true,
    kind: 'plan',
    data: {
      workflowId:     'catalog.doTheThing',
      summary:        'Human-readable one-liner',
      totalSteps:     N,
      estimateUsd:    0,
      estimateWallMs: 60_000,
      sampleSteps:    [...first-N-steps-for-the-card],
      reversible:     true|false,
      note:           'What the operator should know before confirming'
    }
  };
}

async function execute({ req, args, onProgress }) {
  // Re-derive the target set (don't trust a snapshot from preview;
  // catalog may have changed).
  // Fan out at bounded concurrency.
  // For each step, call onProgress({ step, totalSteps, item, outcome, ... }).
  // Aggregate the final result.
  return {
    ok: true,
    kind: 'workflowResult',
    data: {
      workflowId: 'catalog.doTheThing',
      totalSteps, succeeded, failed, skipped,
      failureReasons: {...},
      durationMs,
      note: 'Any human-readable observation'
    }
  };
}

module.exports = { preview, execute };
```

`onProgress` is optional (backend passes it; a caller invoking the executor
directly for testing might omit it) — the executor must not crash when it's
absent.

**Preview must be side-effect free.** Operators call preview implicitly on
every "give me a plan" prompt; it must be safe to run repeatedly.

**Execute must be non-throwing.** All errors surface via per-step `outcome`
in the returned result. A single flaky item doesn't fail the whole batch.

---

## Environment configuration

All in `config/defaults.env` (env-overridable per deploy).

| Var | Default | Purpose |
|---|---|---|
| `AGENT_ENABLED` | `false` | Master switch. Set `true` per env to activate |
| `AGENT_MODEL` | `gemini-2.5-flash` | Routes through `atlasLlmService`. Alt: `director` (Claude Sonnet-5 via `anthropic/claude-sonnet-5-ccmax`) for planning-heavy runs |
| `AGENT_MAX_ITERATIONS` | `8` | Tool-loop cap. Server bails with `stop_reason='max_iterations'` if the LLM keeps calling tools |
| `AGENT_MAX_MESSAGES` | `40` | Client-side history cap enforced server-side. Longer histories should compact client-side before resending |
| `AGENT_MAX_TOKENS` | `2048` | Per-LLM-call `max_tokens`. Agent answers are summaries; 2K is generous without blowing latency |
| `AGENT_MAX_TOOL_RESULT_BYTES` | `12000` | Truncation ceiling for a single tool_result payload. Overflow becomes `{ _truncated: true }` so the LLM asks for pagination |
| `AGENT_DAILY_CAP_USD` | `10` | Per-advertiser rolling 24h USD cap for Tier ≥ 2 dispatch |
| `AGENT_STREAM_DEBUG` | (unset) | When set, streaming service logs chunk count + duration + usage per call |

**Not agent-specific but required:** `ATLAS_API_KEY` (secret — Render env
only), `MONGODB_URI`. The Director already uses both.

---

## Debugging

### The verifier

`node scripts/verifyAgentRegistry.js` runs 176 offline checks. No network,
no DB. Every added capability must keep it green.

```bash
$ node scripts/verifyAgentRegistry.js
[1] Syntax check
[2] Registry structural checks
[3] Tool schema conversion
[4] Tool name round-trip
[5] Executor contract — tenant-scope enforcement
[6] Env / flag / mount readiness
[7] Streaming service + SSE endpoint
[8] Streaming SSE parser
[9] Tier 1 capabilities + confirmation gate
[10] Tier 2 capabilities + spend-guard
[11] Tier 3 capabilities + explicit-phrase gate
[12] Tier 4 workflows

176 checks — 176 passed, 0 failed
```

### Live smoke via curl

Once `AGENT_ENABLED=true`:

```bash
# From an authenticated shell (session cookie or bearer token in headers)
curl -N -X POST https://staging.reach-social.io/api/agent/chat \
  -H 'Content-Type: application/json' \
  -H 'Cookie: your.session=…' \
  -d '{
    "messages": [
      { "role": "user", "content": "how many Allbirds products lack on-site reviews?" }
    ],
    "context": { "brandId": "6a4e7dcf7b13860ec3a31872" }
  }'
```

You should see `iteration`, `tool-use-start`, `tool-use-complete`,
`tool-result`, then `assistant-delta` chunks with the LLM's answer, then
`done`.

### Common failure modes

**"agent disabled (AGENT_ENABLED=false)" 503** — set the env var per env.

**"ATLAS_API_KEY not configured"** — the streaming service can't reach
Atlas. Set the secret in Render env.

**Every capability returns `ok:false, error: 'no advertiser scope'`** —
`requireAuth` didn't run. Check the mount in `index.js` includes
`requireAuth` before the router. Common regression when refactoring
route mounts.

**LLM emits a tool_call but tool-result is `ok:false, needsConfirmation:true`
and the client never sends a confirmation** — the frontend didn't wire the
Confirm button to a re-POST with `confirmations: [id]`. Verify the client's
Confirm handler.

**`spendGuardBlocked:true` result even though the operator hasn't spent
today** — the spend guard sums across ALL brands under the advertiser and
includes non-agent activity (video renders, HTML gen, etc.). If a batch of
video generation already spent $9.50 today, the $0.15 regen puts the
projected at $9.65 — under the $10 cap, so this shouldn't trigger. If it
does, check `AGENT_DAILY_CAP_USD` and the last hour's CostLog rollup for
this advertiser.

**Tier 3 phrase gate rejects even with the right phrase** — verify the
client sends `explicitConfirmations` as an OBJECT (`{ [tool_call_id]:
phrase }`), not an array. The endpoint validation rejects an array shape
with `400`.

**Client disconnects mid-stream but tool loop keeps running** — the
`req.on('close')` handler should abort the AbortController. If it's not,
the `atlasLlmStreamService`'s AbortSignal wiring may have regressed. Check
that `abort.signal` is passed into `streamChatCompletion` and forwarded to
axios.

### Reading a live conversation

Every LLM call logs through `atlasLlmStreamService` → `recordFlatCost`.
Filter CostLog by `stage: 'agent-chat'` + `advertiserId` to see the
conversation's LLM cost trail. Provider-emitted usage stats vary — many
streaming responses omit token counts entirely, in which case the row is
tagged `stream:no-usage` in `purposeTag` (honest about the observability
gap; not a $0 lie).

---

## Not shipped yet

- **Frontend chat drawer** (separate repo, `Emami-RS-Project/liquidretail`).
  Backend is stable enough for the frontend to build against without further
  churn to the event vocabulary or the confirmation contract.
- **Prompt caching** for the Anthropic slug. The system prompt + manifest is
  ~3KB — a candidate for `cache_control` at 90% discount. Adds ~1hr of
  atlasLlmService work when we get to it.
- **`catalog.generateLifestyleImages`** (Tier 4, backlog row 167). Same
  pattern as `refreshReviewsForBrand`; blocked on the frontend rendering
  `plan-proposed` cards.
- **Additional Tier 0/1 capabilities**: `catalog.sync`, `campaign.list`,
  `campaign.summary`, `run.status`, `ad.updateCta`, `spend.byBrand`.
- **Stateful sessions**. Client-holds-history works for a solo operator; a
  Mongo-backed session store would enable cross-device chat continuity.
- **Slack alerts** on `stop_reason='error'` and repeated tool-call
  failures. `alertService` already routes to Slack; just needs wiring.
- **Integration tests** end-to-end (fake Atlas + fake user + real Mongo
  fixture). Verifier covers structural / contract properties; integration
  covers wire behavior.
- **Async workflows** — the current Tier 4 shape holds the SSE connection
  open for the whole execute duration (capped at ~5 min via
  `MAX_STEPS_PER_RUN=100`). Longer workflows need a workflow-status
  polling endpoint.

---

## Change log

| PR | Commit | Summary |
|---|---|---|
| #1 | `e5176f1` | Registry + dispatcher + endpoint scaffolding + 3 Tier 0 tools (buffered) |
| #2 | `32721f6` | SSE streaming + AbortController + wire format |
| #3 | `d6bb641` | Server-side confirmation gate + 3 Tier 1 tools |
| #4 | `f2bb330` | Tier 2 spend-guard + `ad.regenerateWithPrompt` |
| #5 | `aff2aea` | Tier 3 phrase-gate + `ads.publishToMeta` |
| #6 | `1b2f039` | Tier 4 workflows + `catalog.refreshReviewsForBrand` |
| #7 | (this doc) | `docs/AGENT.md` |
