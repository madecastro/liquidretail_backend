# liquidretail_adgen

Ad-generation **renderer** microservice for Reach Social. Fork of
[`liquidretail_backend`](https://github.com/Emami-RS-Project/liquidretail_backend).
When `ADGEN_RENDERER_ENABLED=true`, this service owns rendering in production.
The backend still owns `/api/ads/generate`, expansion, mint, and claim.

Trunk: **`master`**. Deploy: Render, one Docker image, three roles
(`render.yaml`). Same MongoDB as the backend.

Agent notes: [`CLAUDE.md`](./CLAUDE.md). Live handoff: [`session.md`](./session.md).

## How the four repos fit together

| Repo | What it is |
|---|---|
| [`liquidretail`](https://github.com/Emami-RS-Project/liquidretail) | React SPA (trunk **`master`**). Netlify `staging.reach-social.io`. Calls the backend HTTP API. |
| [`liquidretail_backend`](https://github.com/Emami-RS-Project/liquidretail_backend) | Express + Mongo API (trunk **`main`**). Auth, catalog, wizard, Director/Judge, mint. Hands off render when the flag is on. |
| **This repo** | Claims `Ad.status='rendering'` rows and runs static Atlas plates + Omni video + Remotion titling. |
| [`rs-ai-backend`](https://github.com/Emami-RS-Project/rs-ai-backend) | Older/parallel backend fork. **Reference only.** |

## Roles (`ADGEN_ROLE`)

Selected in `src/entrypoint.js`. One process runs one role:

- **`api`** — `GET /health` only (`src/routes/api.js`).
- **`orchestrator`** — Phase 0 no-op poller. Does **not** expand or claim.
- **`renderer`** — live worker. Atomic claim → static / video-master / derive → Remotion → terminal stamp. See `CLAUDE.md`.

## Cutover flag

`ADGEN_RENDERER_ENABLED` (read at call time in both repos):

- `true` — backend `runRenderLoop` returns; this renderer claims and renders.
  Committed default in `config/defaults.env` (and `render.yaml` on renderer +
  titler) is `true` — adgen owns rendering in production.
- anything else — renderer sleeps; backend's in-process loop still runs.

There is no `ADGEN_SERVICE_ENABLED` in this tree.

## Local

```
cp .env.example .env          # MONGODB_URI → staging, never prod
npm install
ADGEN_ROLE=api npm start
ADGEN_ROLE=orchestrator npm start
ADGEN_RENDERER_ENABLED=true ADGEN_ROLE=renderer npm start
npm test                      # node scripts/runVerifySuite.js (on master)
```

`scripts/` and `npm test` exist on `origin/master`. A checkout parked before
`881dabd` will not have them.

## Vendoring

~130 backend services live under `src/services/` (134 `*.js` at repo root of
that folder as of 2026-08-24) plus 33 models under `src/models/`. A backend
fix is **not** live here until it is ported. Layout trap: backend has
`services/` + `config/` at repo root; this repo has `src/services/` +
**both** `src/config.js` (a file) and `config/` (a directory), so
`require('../config')` from a service resolves to the **file**. Details in
`CLAUDE.md`.
