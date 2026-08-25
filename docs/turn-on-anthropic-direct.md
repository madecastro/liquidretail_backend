# Restore the Anthropic direct twins on `MAP.director`

Short doc. Read it when you're about to add `ANTHROPIC_API_KEY` to Render.

## Context

`services/atlasModelMap.js`'s `MAP.director` chain is:

```
1. anthropic/claude-sonnet-5 (Atlas)  →  direct: anthropic/claude-sonnet-5   ← disabled 2026-08-25
2. anthropic/claude-opus-5   (Atlas)  →  direct: anthropic/claude-opus-5     ← disabled 2026-08-25
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
replaced with `direct: null`. Transport treats null identically to the
missing-key path (skips the direct branch entirely) except without the log
line. Functionally a no-op. See the `TURN BACK ON` comment on `MAP.director`
in `atlasModelMap.js`.

## When to re-enable

The moment `ANTHROPIC_API_KEY` is added to Render — on **both** services:

- `liquidretail-backend` (WEB, `srv-d1vuktqli9vc73ft07ng`)
- `liquidretail-backend-worker` (WORKER, `srv-d8128c1o3t8c73e8kb30`)

## Exact restoration steps

1. Open `services/atlasModelMap.js`
2. Find `'director':` entry (~line 176)
3. Remove the ⚠️ TURN BACK ON comment block
4. Restore the two Anthropic links to their original two-line shape. The
   original values (kept verbatim in commented-out lines above each `direct:
   null` for zero-guesswork restoration):

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

5. Delete this file. Its purpose is done.

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
