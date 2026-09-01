# Restore the Anthropic direct twins on `MAP.director`

Short doc. Read it when you're about to add `ANTHROPIC_API_KEY` to Render.

**UPDATE (2026-08-31): the named-skip restoration described below already
happened, independently of the key landing.** `verifyDirectorFallbackChain.js`
E5 caught that the 2026-08-25 `direct: null` change (described in "Context"
below as reducing log noise) had an unintended side effect: it didn't just
silence the log line, it skipped the transport's `if (direct && !directKey)`
branch ENTIRELY, so the auth-missing skip stopped being *recorded* too — the
identical shape of hole the 2026-08-18 outage exposed, reintroduced by the
noise fix itself. `MAP.director`'s two Anthropic links are therefore back to
their original `direct: { provider: 'anthropic', model: '...' }` shape as of
this update — see the `RESTORED` comment on `MAP.director` in
`atlasModelMap.js`. This did **not** wait for `ANTHROPIC_API_KEY`: no key
means `DIRECT_KEYS['anthropic']` is still undefined (see "Also worth doing
at the same time" below, still open), so the transport still makes zero live
Anthropic HTTP calls — it just goes back to *recording* the skip instead of
silently no-op'ing it. The steps below, from "When to re-enable" onward, are
about the SEPARATE remaining follow-up: making the direct twin actually
dispatch once a key exists. Sections above that line are historical context
for how the hole got there.

## Context

`services/atlasModelMap.js`'s `MAP.director` chain is:

```
1. anthropic/claude-sonnet-5 (Atlas)  →  direct: anthropic/claude-sonnet-5   ← named skip restored 2026-08-31, key still absent
2. anthropic/claude-opus-5   (Atlas)  →  direct: anthropic/claude-opus-5     ← named skip restored 2026-08-31, key still absent
3. openai/gpt-5.6-terra      (Atlas)  →  direct: openai/gpt-4.1              ← still live
```

Atlas is currently capacity-starved on the two Anthropic slugs — measured
2026-08-18 and again on 2026-08-25: each Anthropic link 429s after ~5s.
The chain then advances to the next link.

The two Anthropic direct twins were silently unreachable — no
`ANTHROPIC_API_KEY` on either Render service (WEB 24 vars, WORKER 15;
neither carries `ANTHROPIC` anywhere). Every Director round logged two
`[LLM_AUTH_MISSING] role=director provider=anthropic` lines before
advancing. Pure noise: the transport's own `direct && !directKey` guard at
`services/atlasLlmService.js:393-407` skipped them in 0.0s anyway.

To reduce log noise until the key lands, both Anthropic direct twins were
replaced with `direct: null` on 2026-08-25. That went further than intended:
`direct: null` doesn't reach the `direct && !directKey` guard at all (its
`direct &&` half is false), so the skip was no longer *recorded* — not the
"transport treats null identically to the missing-key path" behaviour this
doc originally claimed. `verifyDirectorFallbackChain.js` E5 exists precisely
to catch that gap and went red until the 2026-08-31 restore above.

## When to re-enable (making the direct twin actually DISPATCH — still open)

The moment `ANTHROPIC_API_KEY` is added to Render — on **both** services:

- `liquidretail-backend` (WEB, `srv-d1vuktqli9vc73ft07ng`)
- `liquidretail-backend-worker` (WORKER, `srv-d8128c1o3t8c73e8kb30`)

## Exact restoration steps

**The `MAP.director` half of this (step 4) is DONE as of 2026-08-31** — the
two Anthropic links already carry this exact shape. What remains is adding
the `anthropic:` entry to `DIRECT_KEYS`/`DIRECT_URLS` in
`services/atlasLlmService.js` (see "Also worth doing at the same time"
below) once the key exists on Render.

```js
'director': {
  atlas: 'anthropic/claude-sonnet-5',
  direct: { provider: 'anthropic', model: 'claude-sonnet-5' },
  chain: [
    { atlas: 'anthropic/claude-sonnet-5', direct: { provider: 'anthropic', model: 'claude-sonnet-5' } },
    { atlas: 'anthropic/claude-opus-5',   direct: { provider: 'anthropic', model: 'claude-opus-5'   } },
    { atlas: 'openai/gpt-5.6-terra',      direct: { provider: 'openai',    model: 'gpt-4.1'         } },
  ],
},
```

5. Once `DIRECT_KEYS`/`DIRECT_URLS` also carry the `anthropic:` entry (the
   remaining step), this file's purpose is done and it can be deleted.

## Expected latency win after restore

For each Director round while Atlas remains starved on Anthropic routes:

| State | Sonnet link | Opus link | Terra link | Total |
|---|---|---|---|---|
| Currently (Aug 2026) | Atlas 429 in ~5s → skip direct (0s) | Atlas 429 in ~5s → skip direct (0s) | Atlas 200 in ~11-29s | ~21-39s |
| After key restored | Atlas 429 in ~5s → direct 200 in ~1-2s | (not reached) | (not reached) | **~6-7s** |

**~15-30 seconds saved per Director round.** At 12 rounds per typical 21-ad
run = **~3-6 minutes saved per run**.

## Also worth doing at the same time

Once Anthropic direct is live, `atlasLlmService.DIRECT_KEYS` needs an
`anthropic:` entry pointing at the env var reader. That is a separate line
in a separate file — search for the openai/google entries there and copy
the shape. Without it the transport still can't dispatch the direct call
even if the twins are un-nulled.

## When NOT to re-enable

If your bake-off measurements shift and terra proves quality-adequate for
Director's output, keeping the Anthropic direct twins disabled is a real
cost decision: no per-request Anthropic bill, single-vendor billing through
Atlas. Owner call.

## Adjacent history

- 2026-08-18: cross-provider chain added, silently created this hole.
  `atlasLlmService.js:395-398` even documents it: *"the silent hole that
  caused the 2026-08-18 outage: role 'director' declared direct.provider
  'anthropic' and no service carries ANTHROPIC_API_KEY, so the configured
  fallback could never fire and nothing said so."* The recorded skip line
  landed then too — this doc handles the OTHER half (silencing the
  never-fires-until-key-exists case).
- 2026-08-25: recorded LLM_AUTH_MISSING lines finally moved from
  informational to noise (measured 24 lines per 21-ad run's Director
  activity), triggering this doc + the `direct: null` change.
