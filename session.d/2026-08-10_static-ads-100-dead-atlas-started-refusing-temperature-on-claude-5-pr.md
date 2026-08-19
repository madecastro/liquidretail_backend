## 2026-08-10 — STATIC ADS 100% DEAD: Atlas started refusing `temperature` on Claude 5. PR #108, live `cb5150ca`

Owner: *"I am not seeing any static ads being generated."* Every concept-driven expansion
was failing; video was fine.

```
conceptDriven[product=…]: failed (Atlas 400: {"code":400,"msg":"bad request"})
[campaignRun run_…] start — 4 ad(s) concurrency=veo:12(4) image:24(0)
```

**Read `image:24(0)` first when triaging this shape** — the parenthetical is the count of
ads with `renderRoute != 'veo'`. Zero means the static rows were never created and the
problem is upstream of rendering entirely.

**Root cause — NOT OURS.** Atlas began rejecting `temperature` (≠ 1), `top_p` and `top_k`
on the **Claude 5 family** with a bare, field-less `400 {"code":400,"msg":"bad request"}`
(the Anthropic extended-thinking constraint, now enforced at the gateway). Role `director`
is the **only** Anthropic entry in `atlasModelMap` and sent `temperature: 0.45`, so it broke
100% while every `openai/*` and `google/*` role kept working.

**The timeline is the proof, and it is the reusable move here.** Last good Director round
`2026-08-07 21:20 UTC`; first failure `2026-08-10 15:17 UTC`; **no deploy in between** —
`f3cd56c9` was live throughout and produced ~9 healthy rounds on 08-07. A 100%-failure onset
with no deploy is evidence *against* a code cause; check the Render deploy list before
reading any code. A tracing agent nominated the `max_tokens` 8000→30000 raise (`f7d818d3`)
as the culprit; a live probe refuted it in one call (`max_tokens: 30768` alone → 200).
**Probe the gateway before trusting a code-archaeology hypothesis.**

**Live probe (production key, 2026-08-10)** — full table in `docs/ATLAS.md` §9:
`temperature 0/0.45/0.7 → 400`, `top_p → 400`, `top_k → 400`; `temperature 1` or omitted →
200; `max_tokens 30768`, `response_format`, `stop`, `seed`, `frequency_penalty`,
`presence_penalty` → all 200. `claude-opus-5` identical; 4.x / OpenAI / Google unaffected.

**Fix.** `atlasModelMap.rejectsSamplingParams()` + `stripSamplingParams()`, applied by all
**three** transports that POST to `/v1/chat/completions` — `atlasLlmService.buildAtlasBody`,
`atlasLlmStreamService.buildStreamBody`, and `atlasTextService.buildTextBody`. That third one
posts its body **inline**, bypassing the other two; its `DEFAULT_MODEL` is 4.x today but
`ATLAS_TEXT_MODEL_ID` exists to repoint it, so it was one env var from the same outage.
Params are **stripped, not pinned to 1**.

**Consequence, owner-accepted:** `DIRECTOR_ROUND_TEMP = 0.45` is now **inert** on Claude 5 —
the Director samples at the default, so expect more run-to-run variety in concepts. Owner:
*"let's accept the default on 5 for now and see how it goes."* To get a tunable temperature
back, repoint `director` at `anthropic/claude-sonnet-4.6` (probed: still accepts temperature).

**Fence:** `scripts/verifyClaude5SamplingParams.js` — 20 offline checks, revert-proven twice
(predicate forced off → 6 fail; reverting *only* the stream transport → drift guard fails).
Check `B2` fails deliberately if a second Anthropic role is added to `MAP`, forcing a re-probe.
Verified end-to-end pre-deploy: real `buildAtlasBody` output for the actual Director params
POSTed live → **200**, valid JSON.

**Suite: 72 pass / 1 fail.** The failure is `verifyBrandFieldNames` (`shopifyUrl` not on
`brandSchema`, in `catalogSyncFromGenericSitemap.js:28` + `catalogSyncFromShopifyPublic.js:29`)
and is **pre-existing on `origin/main`** — confirmed by re-running with my changes stashed.
Unrelated to this work; still open.

### Still open from this incident
- **The failure is silent.** A run that creates zero static ads reports `succeeded` and posts a
  clean Slack feed, because the tally counts *rendered Ad rows* and these were never created.
  Nothing alerts. This is the second incident hidden by this exact gap — worth an alert on
  "expansion produced 0 payloads for N products".
- **The shared Atlas key in the global CLAUDE.md** (`apikey-6bcd29b1…`) returns
  `402 insufficient balance`. Production uses the Reach-Social project key
  (`~/Documents/API Keys/Reach-social-atlascloudapikey.txt`) and is unaffected, but any path
  falling back to the global key is dead.

