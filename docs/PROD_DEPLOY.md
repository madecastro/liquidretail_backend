> **DRAFT** — this doc is the flip-day runbook. Nothing has been provisioned or cut over yet. Every "OWNER DECIDE" callout below is a load-bearing choice that changes the steps that follow. Fill those in, then execute in order.

# Production ↔ staging split runbook

**Goal:** split the currently-trunk-autodeploys-to-live setup into a promote-via-branch prod + staging pair with separate MongoDB, Cloudinary, OAuth apps, and Slack channels — before the first customer-facing release.

## Current state (2026-08-10)

| Piece | Where | Notes |
|---|---|---|
| Backend | `liquidretail-backend.onrender.com` (Render web service) | Worker runs in-process via `RUN_WORKER=true`. Autodeploys from `main`. HTTP + expansion + mint. **Does not render ads** when dashboard `ADGEN_RENDERER_ENABLED=true`. |
| Adgen | Render (`adgen-api`, `adgen-orchestrator`, `adgen-renderer`) | Separate repo `liquidretail_adgen`, trunk `master`. Live renderer. Orchestrator is still a no-op. |
| Frontend | `staging.reach-social.io` (Netlify) | Autodeploys from `master`. Proxies `/api/*` + `/auth/*` to the backend URL above. Does not talk to adgen HTTP (health only). |
| YOLO microservice | Render Docker | Consumed by backend; single instance shared. |
| MongoDB | Single Atlas cluster | Shared across everything. |
| Cloudinary | Single account | Uploads land in `liquidretail/` folder prefix. |
| OAuth apps | Meta / Google Ads / Instagram / Shopify | Callback URLs point at the Render backend + Netlify frontend. |
| Slack alerts | `SLACK_ALERT_CHANNEL` / `_FATAL` / `_STATUS` | One env, one set of channels. |
| Rule | Direct-to-trunk push, no PRs | Per `feedback_liquidretail_direct_to_trunk_prerelease.md` — **expires flip-day**. |

**The trap:** trunk push = live traffic. There is no separation between "iterating" and "customer-visible." Static-ad iteration on top of the live app is why you asked for the split.

---

## Load-bearing decisions — fill these in FIRST

### 1. Domain plan — **OWNER DECIDE**

- [ ] **A. Prod at new domain, keep current URL for staging.**
  - Prod: `app.reach-social.io` (fresh Netlify site + backend, new OAuth callbacks)
  - Staging: `staging.reach-social.io` (KEEPS the current URL and infrastructure)
  - **Pro:** current OAuth callbacks stay valid on staging; no reconnect required for the brands currently mid-onboarding.
  - **Con:** flip-day migration = spin up EVERYTHING new for prod.
- [ ] **B. Current URL becomes prod, staging gets a new domain.** ← **RECOMMENDED** if the current DB is the "real" state you want to keep as prod.
  - Prod: `staging.reach-social.io` (rename to `app.reach-social.io` in DNS, keep everything else)
  - Staging: `dev.reach-social.io` or `staging2.reach-social.io` (fresh)
  - **Pro:** minimal data migration. Existing OAuth apps stay pointed at the (now-prod) backend.
  - **Con:** current staging.reach-social.io keeps prod traffic; testers who bookmark the URL land in prod until DNS + subdomain rebrand.
- [ ] **C. Both get new domains, current infra becomes prod, current DNS retired.**
  - Prod: `app.reach-social.io`; staging: `staging.reach-social.io` (rebrand from the CURRENT one).
  - Requires DNS cutover + OAuth app renames.

**Default assumption below:** Option B. Change these instructions if you pick A or C.

### 2. Data migration — **OWNER DECIDE**

- [ ] **A. Bless current DB as prod.** (Recommended if Option B for domain.) Provision a fresh empty Atlas DB for staging. Every brand + campaign + ad row is preserved on prod. Staging starts empty.
- [ ] **B. Provision fresh prod DB, keep current as staging.** Requires every existing operator + brand to re-onboard on prod. Only sensible if you also picked Option A for domain.
- [ ] **C. Snapshot + restore.** `mongodump` the current DB, `mongorestore` into a fresh prod cluster. Diverge after. Preserves state on prod AND gives staging real fixtures.

**Default assumption:** Option A (bless current DB as prod, staging empty).

### 3. OAuth callbacks — **OWNER DECIDE**

- [ ] **A. Keep prod pointing at current backend URL, register NEW apps for staging.** ← Recommended when combined with domain Option B.
- [ ] **B. Rename existing apps to new prod domain, register additional new apps for staging.** Renames may invalidate existing tokens depending on the provider.
- [ ] **C. Both fresh apps.** Existing brands must reconnect on prod. Only sensible when combined with domain Option A.

**Default assumption:** Option A.

**Providers to touch:**
- Meta (Instagram + Meta Ads share one app in `services/instagramOAuthService.js` + `services/metaAdsOAuthService.js`).
- Google Ads (`services/googleAdsOAuthService.js`).
- (Shopify Admin push is not built yet — no OAuth app exists for it today.)

### 4. Branch strategy — **OWNER DECIDE**

- [ ] **A. `production` branch on each repo, autodeploys prod. `main`/`master` keeps auto-deploying staging.** ← Recommended.
  - Prod = merge from `main`/`master` → `production` (via PR or `git merge --no-ff`).
  - Staging = direct trunk push (current behavior — same rule as pre-flip).
- [ ] **B. Tag-based prod deploys.** `v*` tag on `main`/`master` triggers a prod deploy. Staging = every trunk push.
  - **Con:** Render tag deploys aren't as ergonomic as branch tracking; harder to roll back.
- [ ] **C. Two long-lived branches (`main` = prod, `staging` = staging).**
  - **Con:** breaks the current "master/main = trunk" mental model.

**Default assumption:** Option A.

### 5. Flip-day order — **OWNER DECIDE**

- [ ] **A. Parallel provision.** Build the SECOND environment (staging under Option B) alongside prod. Verify staging. Then flip nothing on prod — prod just keeps running.
- [ ] **B. Cutover.** Stop prod-side writes, snapshot, restore into new prod, DNS cutover. Highest risk but cleanest end state.

**Default assumption:** Option A. Under Option A + domain B + data A, the "flip day" is really "staging-provision day" — prod stays untouched.

---

## Phased execution (assuming default answers: B / A / A / A / A)

### Phase 0 — pre-flight (you can do these today)

1. **Confirm the 5 decisions above.** Delete the "OWNER DECIDE" callouts and check the chosen boxes so this doc reflects reality.
2. **Read `server/CLAUDE.md` §4a.** The Render dashboard vs `defaults.env` precedence rules matter — a var set in both places with different values is a silent config lie.
3. **Inventory current Render + Netlify + OAuth app configs.** Screenshot or export every env var, callback URL, and secret currently in use. Restore point.
4. **Snapshot MongoDB.** Even under Option A, take a `mongodump` in case something goes sideways.

### Phase 1 — provision staging infrastructure (owner + ops)

5. **New MongoDB Atlas DB or cluster** for staging. Separate connection string. IP-allowlist the staging Render service only.
6. **New Render web service** (`liquidretail-backend-staging`). Autodeploys from `main` on `github.com/madecastro/liquidretail_backend`. Env vars: fresh set (see "Staging env-var checklist" below). RUN_WORKER=true (single-service topology, same as prod).
7. **New Netlify site.** Autodeploys from `master` on `github.com/madecastro/liquidretail`. Custom domain: `staging.reach-social.io` (rebrand from current, if picking Option B) OR fresh domain. Repoint netlify.toml `/api/*` + `/auth/*` redirects to the new staging backend URL — this repo needs the new `netlify.toml` (see below).
8. **New yolo_microservice on Render** (staging). Same Docker image, autodeploys from `main` on `github.com/madecastro/yolo_microservice`.
9. **New OAuth apps.** Meta app for staging (IG + Meta Ads scopes). Google Ads app for staging. Callback URLs point at the staging backend Render URL.
10. **New Slack channels.** `staging-alerts` / `staging-alerts-fatal` / `staging-runs`.
11. **New Cloudinary folder prefix.** Not a new account (unless you want billing separation). `cloudinaryService.js` gets a `CLOUDINARY_FOLDER_PREFIX` env — staging sets it to `staging/`, prod sets it to `prod/` (or leaves unset for current default). Change is described in Phase 3.

### Phase 2 — production branch strategy (both repos)

12. **Create `production` branch on `liquidretail_backend.git`** from current `main`. Push.
13. **Create `production` branch on `liquidretail.git`** from current `master`. Push.
14. **Reconfigure Render web service** (the CURRENT one — under Option B it becomes prod) to autodeploy from `production` instead of `main`.
15. **Reconfigure Netlify site** (the current one, becoming prod) to autodeploy from `production` instead of `master`. Repoint DNS to `app.reach-social.io` (or keep the current subdomain if you're keeping `staging.reach-social.io` as prod).
16. **Reconfigure yolo_microservice** (the current one, becoming prod) to autodeploy from `production`.

### Phase 3 — code changes (this session can start these NOW as DRAFT commits)

17. **`netlify.toml` rewrite** — per-context redirects so prod points at prod backend, branch deploys (staging) point at staging backend. Draft below.
18. **`cloudinaryService.js` folder prefix env** — add `CLOUDINARY_FOLDER_PREFIX` env var support. Prod = `prod/`, staging = `staging/`, unset = current behavior (`liquidretail/`).
19. **Slack alert channels env-var-driven** — already are per `services/alertService.js`; just ensure staging Render service has different values.
20. **`config/defaults.env` audit** — `AGENT_ENABLED=true` currently; keep. `AGENT_DAILY_CAP_USD=0` currently; **re-enable to a positive value on prod** (e.g. 10). Add a comment noting the per-env difference.
21. **Retire `feedback_liquidretail_direct_to_trunk_prerelease.md` memory.** Add a new memory: staging = direct-trunk-push OK; production = merge from staging trunk via PR.
22. **Update `session.md`** with the split-in-progress state and the flip-day date.

### Phase 4 — flip day itself

23. **Merge current `main` → `production` on backend.** First prod deploy.
24. **Merge current `master` → `production` on frontend.** First prod Netlify deploy.
25. **DNS cutover if applicable** (Option B keeps DNS as-is; Options A/C need a swap).
26. **Verify prod end-to-end**: `/api/agent/chat` returns SSE, one existing brand can generate an ad, OAuth callback resolves.
27. **Retire the direct-to-trunk memory + write the replacement memory.**
28. **Send announcement** if anyone was mid-onboarding (Option B minimizes this; Option C needs a "reconnect required" banner).

### Phase 5 — post-flip cleanup

29. **Bump `AGENT_DAILY_CAP_USD=10`** (or ops-chosen) on prod. Keep 0 on staging.
30. **Configure `SLACK_ALERT_CHANNEL_STATUS_*_STAGING`** to point at staging channels.
31. **Verify `render.yaml` isn't lying about state.** (We're not adding one in v1, but if you do later, it should reflect reality.)
32. **Turn on Netlify PR previews** on both repos (free, worth it for design review).
33. **Turn OFF autodeploy on the production branch until CI / verify-scripts land.** The verify-scripts already catch a lot (see `scripts/verifyAgentRegistry.js` — 1412 checks); consider gating prod deploys on their success once GitHub Actions exists.

---

## Staging env-var checklist (for the new Render web service)

Every var in this list must have a DIFFERENT value on staging vs prod. If it's identical across envs, that's a bug — one env's action mutates the other's state.

**MUST DIFFER (secrets — dashboard-only, per §4a):**
- `MONGODB_URI` — separate cluster or database + user
- `ATLAS_API_KEY` — same key OK ONLY if separate spend-cap budget lines by advertiser (which we don't have). Prefer separate keys with separate spend caps.
- `META_APP_ID` + `META_APP_SECRET` — separate app for staging
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — separate app for staging
- `APIFY_TOKEN` — separate account preferred, or accept shared quota
- `BRANDFETCH_API_KEY` — separate key or shared with quota awareness
- `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` — same account OK if `CLOUDINARY_FOLDER_PREFIX` differs (see Phase 3 change)
- `SLACK_BOT_TOKEN` — separate bot preferred (or same bot with different channel env vars)
- `JWT_SECRET` — MUST differ so a staging-issued token can't authenticate against prod
- `INTEGRATION_ENCRYPTION_KEY` — same key OK ONLY if IntegrationCredential collection is also separated (Option A data migration = new prod DB); otherwise MUST differ

**MUST DIFFER (non-secret — in defaults.env if you want per-env, else dashboard):**
- `FRONTEND_URL` — new domain for prod, current for staging (or vice versa)
- `META_ADS_REDIRECT_URI` — points at each env's backend
- `GOOGLE_ADS_REDIRECT_URI` — same
- `SLACK_ALERT_CHANNEL` / `SLACK_ALERT_CHANNEL_FATAL` / `SLACK_ALERT_CHANNEL_STATUS`
- `AGENT_DAILY_CAP_USD` — 0 on staging (current default), positive on prod
- `RENDER_CONCURRENCY` — can differ if staging is a smaller instance
- `CLOUDINARY_FOLDER_PREFIX` — `prod/` vs `staging/` (Phase 3 change enables this)
- `JIRA_PROJECT_KEY` — non-secret; can be identical if desired (RER)

**CAN BE SHARED (utility / capability flags — same behavior wanted):**
- `AGENT_ENABLED`, `AGENT_MODEL`, `AGENT_MAX_TOKENS`, `AGENT_MAX_ITERATIONS`
- `ALTS_LIGHT_MODE`, `MAX_ALT_IMAGES`
- Every rendering / video / static / prompt-tuning flag documented in `config/defaults.env`

---

## Rollback plan

- **Prod deploy breaks:** Render + Netlify both support 1-click "redeploy previous commit." Practice this on staging first.
- **DB migration corrupted prod:** restore from Phase 0 snapshot into a new database, repoint `MONGODB_URI` in Render dashboard, redeploy web service.
- **OAuth callbacks broken:** the OAuth apps themselves are the state — reverting to previous callback URLs in each provider dashboard is the rollback.
- **DNS cutover breaks:** revert the DNS record. TTL is short.

## Success criteria

- **S1.** A staging deploy cannot mutate a prod DB row, cannot post to a prod OAuth-linked Meta account, cannot charge the prod AtlasCloud budget, and cannot alert into prod Slack channels — enforced by DIFFERENT credentials, not by convention.
- **S2.** A prod deploy is reproducible from a single git commit on the production branch (rollback = redeploy previous commit, no manual step).
- **S3.** The first customer onboard can happen against prod without touching staging.
