# Repo-scope supplement (the four org repos the consolidation design missed)

Read-only. Cloned to `/tmp/rs-scope-supplement/` (not under `RS/`). Measured 2026-09-06. Does not redo the four-repo design; only amends its scope.

`gh repo list Emami-RS-Project` is eight repos. The running design knows four (`liquidretail_backend`, `liquidretail_adgen`, `liquidretail`, `claude-org-brain`). This covers the other four.

## Disposition table

| repo | disposition | one-line reason |
|---|---|---|
| `Emami-RS-Project/yolo-microservice-prod` | **ARCHIVE** | Frozen 2026-05-11 snapshot of the personal YOLO repo; nothing deploys from it; missing every route the live backend now calls. |
| `madecastro/yolo_microservice` *(not org-owned)* | **KEEP SEPARATE** | This is the live detection service. Python/Docker/gunicorn on Render, own cadence. Do not fold into the Node monorepo. |
| `Emami-RS-Project/Ad-Specs` | **ARCHIVE** | Empty stub: one commit, a 2-line README, no specs. Nothing reads it. |
| `Emami-RS-Project/rs-ai-frontend` | **ARCHIVE** | SHA-identical ancestor of `liquidretail` at `380d0af` (2026-08-10); 75 commits behind `origin/master`; 0 unique commits; no deploy. |
| `Emami-RS-Project/rs-ai-backend` | **out of scope** | Owner directive. Not re-raised. |

## What would change the main design

1. **A fifth production runtime exists and is not in the org.** Live YOLO is `github.com/madecastro/yolo_microservice` → Render `https://yolo-microservice.onrender.com`. The four-repo design does not track it. Keep it separate (different language, image, deploy cadence) but **name it** as a production dependency. Transfer into the org is ownership hygiene, not a merge.
2. **Do not treat `yolo-microservice-prod` as that dependency.** It is a stale private copy. Merging or deploying from it would ship a service without `/detect-batch`, Grounding DINO, or structured error codes — all of which production already uses.
3. **Ad-Specs and rs-ai-frontend add no merge target.** Archive. They do not change MERGE-adgen / KEEP-SPA / KEEP-brain.
4. **Credential leak (not a merge issue, but it sits on the live YOLO repo):** both YOLO copies commit `.env` with a MongoDB Atlas URI for user `decastromark85` against `cluster0.5tqqey.mongodb.net/liquidRetail`. The personal copy is **public**. Rotate that URI; do not paste it here.

---

## 1. YOLO — ownership settled

### Live service fingerprint (the decisive evidence)

Probed `https://yolo-microservice.onrender.com` (GET/empty POST only; no images, nothing billable). Headers: `x-render-origin-server: gunicorn`.

| request | live response | personal `yolo_service.py` (HEAD `40682e5`, 2026-08-31) | org `yolo-microservice-prod` (HEAD `0d04969`, 2026-05-11) |
|---|---|---|---|
| `POST /detect-batch` (empty) | **400** `{"error":"At least one image is required"}` | route exists; that exact string at lines 768–773 | **no `/detect-batch` route at all** |
| `POST /detect` (empty) | **400** `{"code":"missing-image","error":"Image file is required"}` | line 683 returns `code: 'missing-image'` | line 340 returns the same error **with no `code` field** |
| `GET /` | **404 JSON** `{"code":"client-error",...}` | `@app.errorhandler(Exception)` `_json_uncaught` lines 663–676 | no such handler; Flask would emit HTML |
| `GET /healthz` | **200** | present (line 554) | also present (line 333) — not discriminating |

`/detect-batch` landed in personal commit `0b82519` (2026-08-31). `code: missing-image` landed in `9e8d5d32` (same day). Neither exists in the org copy.

**The live Render service is running `madecastro/yolo_microservice`, not `Emami-RS-Project/yolo-microservice-prod`.**

`docs/PROD_DEPLOY.md` is a DRAFT runbook (header: "Nothing has been provisioned or cut over yet") but its planned wiring matches this: line 101 says staging YOLO "autodeploys from `main` on `github.com/madecastro/yolo_microservice`". Backend default URL is that hostname (`services/yoloService.js:8`, `config/defaults.env:1288`). `scripts/verifyCatalogYoloDetection.js:389` looks for a sibling `yolo_microservice/yolo_service.py` — the personal name, not the org name. Zero hits in the four in-scope repos for the string `yolo-microservice-prod`.

### The two copies

| | org `yolo-microservice-prod` | personal `madecastro/yolo_microservice` |
|---|---|---|
| visibility | private | **public** |
| created | 2026-08-10 | 2025-07-26 |
| last push | 2026-08-10 | **2026-08-31** |
| HEAD | `0d04969` (2026-05-11, gunicorn env-driven config) | `40682e5` (2026-08-31, PyTorch thread cap) |
| relation | identical history through `0d04969`; GitHub `isFork: false` (history was pushed, not forked) | 10 commits / 10 files ahead (`Dockerfile`, `eval/*`, `gunicorn.conf.py`, `render.yaml`, `yolo_service.py`) |
| `yolo_service.py` | 458 lines; `/detect` + `/detect-video` only | 958 lines; + `/detect-batch`, Grounding DINO, HEIC/`pi-heif`, JSON error codes |
| `render.yaml` | `plan: free`, `autoDeploy: true`, service name `yolo-detection` | `plan: standard`, same name, `autoDeploy: true` |
| GitHub Actions / deployments / org webhooks | none | Actions 0; webhooks 404 (need `admin:repo_hook`); collaborators 403 (no push for `nicknsheth-beep`) |
| language | Python 21 KB + Dockerfile | Python 75 KB + Dockerfile + eval JS |

The Aug 10 org copy was current *that day* (personal also sat at `0d04969` from May 11 until Aug 30). Then personal received the production incident flight of 2026-08-30/31 (open-vocab, batch, HEIC, JSON errors, thread cap) and the org copy was never updated.

### Disposition

- **Org copy: ARCHIVE.** Dead mirror. Merging it would import a service the live backend has already outgrown.
- **Personal copy: KEEP SEPARATE.** Legitimate microservice: Python 3.11 Docker image, YOLOv8x + Grounding DINO, gunicorn, own Render service, own incident cadence. Folding it into `liquidretail_backend` mixes runtimes and deploy units. The main design's "merge everything" spirit does not require that.

**Risk, one sentence:** production autodeploys from a **public personal** repo that org admins cannot push to (`gh` 403 on collaborators; `main` is unprotected), so a single GitHub account is the bus factor and anyone on the internet can read the committed `.env`.

Follow-up (not a merge): transfer `madecastro/yolo_microservice` into `Emami-RS-Project`, point Render at the org repo, archive `yolo-microservice-prod`. Until then the consolidation design should cite the personal repo as the YOLO source.

---

## 2. Ad-Specs — stale placeholder, not a drifted table

| field | value |
|---|---|
| description | "Ad specs for all advertising surfaces supported by Reach-Local" |
| created / last commit | 2026-07-22 `7543894` nicknsheth-beep "Initial commit" |
| GitHub `pushedAt` | 2026-07-28 (no extra commit; settings noise) |
| tree | `README.md` only (74 bytes, 2 lines) |
| languages | none |
| wiki / Actions / deployments / hooks | wiki 404; rest empty |
| clone size | 2.04 KiB pack (GitHub `diskUsage: 1375` is empty-repo padding) |

Grep of the four in-scope repos for `Ad-Specs`, `ad-specs`, `Reach-Local`: **no matches**. SPA comments cite `services/platformFormats.js`, not this repo.

`liquidretail_backend/services/platformFormats.js` is the live table (file header: "Single source of truth for platform-format capabilities"). 15 format keys as of this read:

- live: `meta_feed_1_1`, `meta_feed_4_5`, `meta_reels_9_16`, `meta_stories_9_16`, `pmax_landscape_1_91_1`, `pmax_square_1_1`, `pmax_portrait_4_5`, `pmax_video_16_9`, `pmax_video_1_1`, `pmax_video_9_16`
- coming_soon / frozen: `pmax_16_9`, `google_demandgen_1_1`, `google_demandgen_4_5`, `google_demandgen_1_91_1`, `google_shorts_9_16`

**Finding:** there are two *named* sources of truth, but they did not drift against each other. Ad-Specs never received a single surface, dimension, or safe-area. It is an empty README whose description claims the job `platformFormats.js` actually does. Archive; do not merge an empty tree.

---

## 3. rs-ai-frontend — confirmed dead

| field | value |
|---|---|
| created | 2026-08-10 (same day as `yolo-microservice-prod`) |
| last commit | `380d0af` 2026-08-10 madecastro `netlify.toml: per-context redirects for prod-staging split` |
| language | TypeScript (1.5 MB) + HTML/JS/CSS |
| GitHub size | 6340 KB vs live `liquidretail` 7026 KB |
| default branch | `master` |
| Actions / deployments / hooks | none |
| `package.json` name | `liquidretail-app` (same as live SPA) |

Every SHA on `rs-ai-frontend` is in `liquidretail`. HEAD `380d0af` is an ancestor of `liquidretail` `origin/master` `270b35e` (2026-09-02). **75 commits ahead on liquidretail, 0 unique on rs-ai-frontend.**

No references in `liquidretail`, `liquidretail_adgen`, or `claude-org-brain`. One stale mention in `liquidretail_backend/docs/backlog.csv:184` (2026-08-10 UGC-wizard story): "frontend repo Emami-RS-Project/liquidretail (staging) → Emami-RS-Project/rs-ai-frontend (prod)" — the split that `PROD_DEPLOY.md` drafted and never flipped. Live SPA remains `liquidretail` → Netlify `staging.reach-social.io` (`PROD_DEPLOY.md:13`).

**ARCHIVE.** Pair of the excluded `rs-ai-backend`. Not a second frontend.

---

## 4. rs-ai-backend

Owner-excluded. Last org push 2026-08-10. Local clone under `RS/rs-ai-backend/` is the stale fork the four-repo design already set aside. No further action from this supplement.
