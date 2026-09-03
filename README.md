# liquidretail_backend

Reach Social's **main backend**: Node/Express + MongoDB. Trunk is **`main`**.
Deploys to Render (`liquidretail-backend.onrender.com`).

This repo owns HTTP (`/api/*`, `/auth/*`), auth, catalog ingest, the generate
wizard, Director/Judge expansion, Ad mint, and claim. **It does not render
ads when `ADGEN_RENDERER_ENABLED=true`** — that work moved to
[`liquidretail_adgen`](https://github.com/Emami-RS-Project/liquidretail_adgen).

Agent notes: [`CLAUDE.md`](./CLAUDE.md). Live handoff: [`session.md`](./session.md).
Pipelines: [`docs/PIPELINES.md`](./docs/PIPELINES.md).

## How the four repos fit together

| Repo | Trunk | What it is |
|---|---|---|
| [`liquidretail`](https://github.com/Emami-RS-Project/liquidretail) | **`master`** | React SPA. Netlify `staging.reach-social.io`. Proxies `/api` + `/auth` here. |
| **This repo** | **`main`** | Express API + expansion. Fallback in-process renderer if the adgen flag is off. |
| [`liquidretail_adgen`](https://github.com/Emami-RS-Project/liquidretail_adgen) | **`master`** | Live renderer (static Atlas plates + Omni video + Remotion). Same MongoDB. |
| [`rs-ai-backend`](https://github.com/Emami-RS-Project/rs-ai-backend) | `main` | Older/parallel fork. **Reference only.** |

## Local

See `CLAUDE.md`. `npm test` is `node scripts/runVerifySuite.js` (the offline
verify suite). Do not use a `.js`-only shell glob — it skips the `.mjs`
titling harnesses.

## Config

Non-secret defaults: `config/defaults.env`. Secrets live in the Render
dashboard only. `ADGEN_RENDERER_ENABLED` defaults to `true` in that file
— adgen owns rendering in production (`services/adgenBridge.js`,
`routes/ads.js` `runRenderLoop`). The in-process loop is the fallback
when the flag is not the string `'true'`.
