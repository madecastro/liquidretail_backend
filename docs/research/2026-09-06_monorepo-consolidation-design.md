# Reach Social monorepo design

**Status:** decided. 2026-09-06. No repo was modified writing this.
**Do not execute from memory.** Re-fetch GitHub tips immediately before any graft. Trunks moved *during this write*: backend `#396` and adgen `#133` merged at 07:04Z.

This is the how. The owner already decided to consolidate. Seven independent reviewers then tried to break the first draft. What follows is the plan that survived, with every change called out in **§ Adversarial review**.

---

## Pins (re-measured 2026-09-06)

Use **GitHub**, not local `origin/*` and not the dirty checkouts.

| repo | GitHub trunk tip (REST, 2026-09-06 ~07:05Z) | local `origin/*` (stale) | dirty local HEAD |
|---|---|---|---|
| `liquidretail_backend` | **`ec64a9a5`** `#396` duration | `982a554f` `#395` (21 behind GitHub) | `b4eb6435` `#380` (22 behind GitHub, dirty) |
| `liquidretail_adgen` | **`98be56bd`** `#133` duration | `b141149` `#131` | `94ba1c1` (1 ahead / 33 behind, dirty; on-disk `videoRouter.js` is the **Vertex fall-through**) |
| `liquidretail` | `270b35e` `#88` Master badge | same | `d3bdceb` feature branch + 2 dirty UI files |
| `claude-org-brain` | `1ad257a` | same | `ac303d6` 1 ahead (gitignore) |

Shared commits backend↔adgen, backend↔SPA, adgen↔SPA: **0** (measured `comm -12` of `git log --format=%H`). Clean grafts.

**Working copies are hostile.** Adgen local `master` still has `videoRouter.js:62-67` `else → Vertex Veo`. GitHub origin has atlas / gemini / else **throws**. Dashboard `VIDEO_PROVIDER=gemini`. Grafting or byte-comparing the dirty tree ships Vertex onto Gemini production. Codegraph and on-disk reads of adgen are the dirty tree. **Cite `git show origin-SHA:path` or a worktree at that SHA.**

**`rs-ai-backend` is out of scope** (owner 2026-09-06: *“I don't think we need anything in -ai- so we can leave it out.”*). The four in-scope repos do not `require` it. Mentions are docs-only: `liquidretail_backend/README.md:21`, `docs/README.md:9`, `liquidretail_adgen/CLAUDE.md:79`, `README.md:20`. Archive-in-place. No census, no design, no subagent spend beyond that sentence.

---

## Key decisions

1. **Merge adgen INTO backend.** Survivor is `liquidretail_backend` (GitHub identity, trunk `main`). Adgen grafts at `adgen/` with history intact. Backend files do not move.
2. **Leave the SPA separate.** Different runtime (Vite/React Node 22 vs Express CJS Node 20), different deploy (Netlify vs Render), HTTP-only coupling. The pain this merge kills is vendor drift on a shared Mongo. The SPA does not write that Mongo.
3. **Leave `claude-org-brain` separate.** Claude plugin + launchd scout. Plist hardcodes `cd /Volumes/Sayulita/Projects/RS/claude-org-brain`. Not product.
4. **No turbo, no nx, no pnpm/npm workspaces.** Two `package.json`, two lockfiles, two `npm ci`. Workspaces would hoist mongoose 7 and 8.
5. **`git subtree add --prefix=adgen` without `--squash`. The graft PR is a GitHub *merge commit*. Squash or rebase of that PR discards the history subtree just imported.** This team’s default is squash. That default is the kill shot for every baseline SHA pin.
6. **The merge commit is a prefix-only tree move, plus the minimum wiring the graft itself changes:** `siblingBackend.js`, adgen mongoose-major boot assert, `autoDeploy: false` in yaml, `verifyRequireGraph` freeze-N. Everything else (dotenv `__dirname`, `rawResult`, mongoose 7→8, detection require, retiring vendor tooling) is its own revertible PR.
7. **Never Blueprint-sync until yaml already contains live `scaling:`, `autoDeploy: false`, and `ADGEN_TITLER_ENABLED: {sync: false}` without a live-overwriting `value`.** A missing `scaling:` stanza disables Render autoscale (measured titler 6→1). Yaml `autoDeploy: true` re-arms a dashboard No. Yaml `ADGEN_TITLER_ENABLED: "false"` darkens the titler while the renderer keeps handing off.
8. **`ADGEN_RENDERER_ENABLED=false` is not merge rollback.** It re-enables backend leftover `runRenderLoop`, which **never writes `claimedByWorker`**, so adgen can still CAS-claim the same row. Two billable POSTs. Merge rollback is Render cached-image + keep the adgen GitHub repo writable. Never flip the ownership flag as a response to a merge incident.
9. **Do not unify `config/defaults.env` or mongoose in this window.**
10. **Detection unlock is a follow-up after the monorepo is stable**, with an explicit mongoose-identity design. The graft only makes the file path exist.

---

## 1. Per-repo disposition

### `liquidretail_backend` — SURVIVOR

Live API. Express + Mongoose **7.8.7** (`^7.6.0`). Render **dashboard-only** — no `render.yaml`, no Dockerfile. WEB `srv-d1vuktqli9vc73ft07ng`, WORKER `srv-d8128c1o3t8c73e8kb30`. When `ADGEN_RENDERER_ENABLED=true`, `runRenderLoop` returns after flipping the CampaignRun to `running` (`routes/ads.js:1855-1864`). The leftover pool below that return is the fallback, and it is live code.

Keeping this repo as survivor: GitHub identity, 220+ harnesses keep paths, baseline SHAs keep blob paths, Render `rootDir: ""` stays valid, `CORE_DIRS` (`scripts/runVerifySuite.js:108`) still sees `services` as the first path segment.

### `liquidretail_adgen` — MERGE (graft at `adgen/`)

Live renderer. Four Render services, one Docker image, `ADGEN_ROLE` ∈ {api, orchestrator, renderer, titler}. Mongoose **8.24.3**. Vendors 185 files (`vendor-manifest.json` on origin: 137 synced / 33 fork / 13 unported / 2 unused). Same production Mongo.

This is why we consolidate. A backend fix is not live here until ported.

Origin line counts (not the dirty tree):

| file | backend | adgen | note |
|---|---:|---:|---|
| `plateIntelService.js` | 679 | **672** | brief said 738 — that was dirty/local |
| `overlayZoneService.js` | 413 | 372 | only backend exports `computeBrightnessGridFromUrl` (`:380,:413`) |
| `adVisionQcService.js` | 2607 | 2693 | only adgen has `titlingOnlyGate` (`:1464`) |
| `yoloService.js`, `dinoOverlayZoneService.js`, `mediaYoloRefine.js`, `catalogYoloDetectionService.js`, `yoloIdentifyService.js` | present | **MISSING on origin** | dirty adgen still *tracks* `yoloService.js` from `0213f88` because local master is 33 behind a later strip. Origin has **zero** yolo/dino files. |

Do not archive adgen. It is production.

### `liquidretail` (SPA) — LEAVE SEPARATE

**Call: stay in `emami-rs-project/liquidretail`, trunk `master`.** Folding it in *this* window is actively worse.

- Talks to the backend **HTTP API only**. `netlify.toml` 200-proxies `/api/*` and `/auth/*` to `https://liquidretail-backend.onrender.com`. App uses relative `/api/...`.
- **Zero** source imports of backend or adgen.
- Vite 5 + React, Node **22**. Backend/adgen: Node **20**.
- Netlify `base = "frontend/app"`. Independent of Render.
- `origin/main` is vestigial (`0e20437` Initial commit). `origin/HEAD` still points at it. Ignore.
- Leftover `server/` is a **different product** (Flood QRF). Netlify never builds it.
- Remotion island `frontend/app/src/titling/island/` is a third copy of backend `remotion/` (README: “Do not edit these files here”). That is a *later* hoist, not a reason to mix Netlify into the adgen graft.
- ui-smoke requires a sibling `liquidretail_backend` checkout. That sibling relationship survives if SPA stays a sibling.

**Revisit** when preview ≠ renderer is the next vendor-drift incident. Then graft as `web/` (not `frontend/` — the SPA already contains `frontend/app`). Separate window.

### `claude-org-brain` — LEAVE SEPARATE

14 tracked files: Claude Code plugin (`.claude-plugin/plugin.json` + four skills) + `scout/`. Not a marketplace (`marketplace.json` absent; not in `~/.claude/plugins/installed_plugins.json`). Product repos do not reference it. Scout default `--repo` still points at backend `scripts/rpd/` which **no longer exists**. LaunchAgent plist hardcodes the current path. `scout.sh` auto-pushes this remote.

**Do not MERGE.** ARCHIVE only after `launchctl unload` of `com.reachsocial.scout`. Until then leave the GitHub repo as the plugin home.

---

## 2. Repo shape and tooling

```
liquidretail_backend/                 ← GitHub repo, trunk `main`
├── index.js  worker.js  package.json  package-lock.json
├── services/  models/  routes/  schemas/  remotion/  scripts/  config/
├── .github/workflows/ci.yml
└── adgen/                            ← grafted tree, otherwise intact
    ├── src/config.js                 ← FILE; require('../config') from src/services hits THIS
    ├── src/  config/  scripts/  Dockerfile  render.yaml  package.json
    └── config/defaults.env
```

**Not** `apps/backend` + `apps/adgen`. Moving backend:

1. Silently greens `npm run test:affected`. `CORE_DIRS` is first-path-segment (`runVerifySuite.js:108`). `adgen/src/services/foo.js` → `'adgen'` ∉ set → empty selection **exits 0** (`:676-678`). The `apps/` form is the same bug. After this graft, **`--affected` must treat an unknown first segment (including `adgen`) as “run everything”**, and CI must never use `--affected`.
2. Forces a Render `rootDir` change on two dashboard-only services whose `dockerContext`/`dockerfilePath` the Render CLI cannot set.
3. Baseline pins of `9531ae9f:services/veoPromptBuilder.js` keep working only because those commits’ trees are unmoved.

**Package manager: npm.** Both have `package-lock.json` v3. No `turbo.json` / `nx.json` / `pnpm-workspace.yaml`.

**Workspaces: no.** A root `npm ci` would mix two mongoose majors. Adgen Docker `COPY package*.json ./` then `npm install --omit=dev` (`Dockerfile:54-55`) must keep seeing **adgen’s** lockfile.

**The graft creates a parent `node_modules` that did not exist.** From `adgen/src/services/renderer.js`, Node’s walk-up after prefix is:

1. `adgen/src/services/node_modules`
2. `adgen/src/node_modules`
3. `adgen/node_modules` ← mongoose **8.24.3** if `npm ci` ran *here*
4. **`<monorepo>/node_modules` ← mongoose 7.8.7** — **new ancestor**

`verifyRequireGraph` only records specifiers starting with `.` (`scripts/lib/requireGraph.js:269`). Bare `require('mongoose')` / `require('sharp')` / `require('@remotion/renderer')` are invisible to the gate. This is already documented as silent (`scripts/verifyLogoColorPreservation.js:65-70`).

**Graft-PR wiring (not optional):**

- Always `npm ci` inside `adgen/` (CI job `working-directory: adgen`). Never run adgen off the root lockfile.
- Boot assert in `adgen/src/db.js`: `require('mongoose/package.json').version` must start with `8`. Fail closed.
- Never set `NODE_PATH` to the parent. `runVerifySuite.js` `childEnv()` currently does that for the sibling; rewrite it.
- `remotionChildSupervisor.js:66-68` copies `NODE_PATH` into Remotion children. After rewrite it must stay unset or point at `adgen/node_modules`.

**`.claude/` hooks:** both run `node "$CLAUDE_PROJECT_DIR/scripts/auditStrandedWork.js" ... || true` (`liquidretail_adgen/.claude/hooks/session-end-audit.sh:36`). After merge, `$CLAUDE_PROJECT_DIR` is the monorepo root; adgen’s copy is at `adgen/scripts/...`; `|| true` hides the miss. Rewrite backend’s hook to cover both; delete or repath adgen’s; **deliberately break one** and confirm the session-end message fires.

**eslint:** two configs, `working-directory`. Backend `sourceType: 'commonjs'` + ignore `remotion/**` (not `adgen/**`) will parse `adgen/src/remotion/lib/*.js` `export` as a syntax error and block the required check. **Add `adgen/**` to backend ignores, or only lint adgen from the adgen job.** Suspected by the outage reviewer; prove with `npm run lint` on a subtree worktree before merge.

**`skills-lock.json`:** keep at repo root (backend’s). Adgen doesn’t have one.

**adgen `npm run setup:worktree`** is `node scripts/setupMergeDrivers.js` — git merge-driver config for `vendor-manifest.json`, **not** npm install. Backend `setup:worktree` is `bin/setup-worktree.sh` (sharp / https-proxy-agent / jwt). Different tools, same script name. After merge, keep both under their packages.

---

## 3. History preservation

### Why subtree, and the GitHub button that undoes it

`git subtree add --prefix=adgen` without `--squash` **does not rewrite original SHAs.** Probe (throwaway repos, this pass): original SHA remained `HEAD^2`; `git show $BSHA:src/foo.js` succeeded; `git show $BSHA:adgen/src/foo.js` failed (prefix is only on the merge commit’s tree).

That is why `git show 16e64e2:src/services/veoPromptBuilder.js` still works after graft: commit `16e64e2`’s tree *is* the old adgen root. The harness uses the **unprefixed** path. `cwd: adgen/` does not matter; `git show sha:path` is commit-tree relative and walks up to the monorepo `.git`.

**Squash-merging that PR onto `main` drops the second parent.** This team’s default is squash (`liquidretail_adgen/CLAUDE.md:580-582`; commit subjects `feat(director) (#395)`). GitHub squash creates a single-parent commit whose *tree* has `adgen/` and whose *graph* does not contain `16e64e2`. `actions/checkout` + `fetch-depth: 0` on `main` never fetches dangling PR objects. Then:

- Adgen `verifyOperatorPromptPrecedence.js:130-140` **exits 1** (`git show 16e64e2:...` fail-closed).
- Backend B14 / V2 / V3 **SKIP and the suite stays green** (`verifyPostPilotBatch.js:369-372,800-816`). Decision 5’s “pins die if history is rewritten” is **false for the money pins** until those SKIPs become fail-closed.

`git show` locally is **not** an ancestry gate. `git fetch` + `read-tree --prefix` + `git commit` (single parent) still makes `git show 16e64e2:src/...` succeed **in that worktree**; `git push` does not send unreachable objects.

### Exact commands

Fresh worktree. Fetch **GitHub**, not the dirty clone. **No `--squash`.**

```bash
git -C /Volumes/Sayulita/Projects/RS/liquidretail_backend fetch origin
git -C /Volumes/Sayulita/Projects/RS/liquidretail_backend \
  worktree add -b merge/adgen-monorepo \
  /Volumes/Sayulita/Projects/RS/.wt-merge-adgen origin/main

cd /Volumes/Sayulita/Projects/RS/.wt-merge-adgen
# Confirm origin/main is GitHub tip (ec64a9a5 or newer), not 982a554f.

git remote add adgen-src https://github.com/Emami-RS-Project/liquidretail_adgen.git
git fetch adgen-src master
# Confirm adgen-src/master is GitHub tip (98be56bd or newer).
# Namespace: do NOT `+refs/heads/*:refs/heads/*` (clobbers backend branches).

git subtree add --prefix=adgen adgen-src master -m "merge: graft liquidretail_adgen history under adgen/"
# NEVER add --squash.
```

Equivalent plumbing if subtree is unavailable:

```bash
git merge -s ours --no-commit --allow-unrelated-histories adgen-src/master
git read-tree --prefix=adgen/ -u adgen-src/master
git commit -m "merge: graft liquidretail_adgen history under adgen/"
```

**Never** bare `git merge --allow-unrelated-histories` (root collisions on the eight shared names).

### Gates (merge worktree AND a fresh clone of origin/main **after** the PR lands as a merge commit)

```bash
git merge-base --is-ancestor 16e64e211daa1e7864ba2261adc39783f09f51bc HEAD
git merge-base --is-ancestor 9531ae9f73d5ad9773bddff9c87d19890873ea59 HEAD   # confirm full SHA at freeze
git show 16e64e2:src/services/veoPromptBuilder.js >/dev/null
git show 9531ae9f:services/veoPromptBuilder.js >/dev/null
test "$(git rev-parse HEAD^2)" = "$(git rev-parse adgen-src/master)"

# Byte-identity against the *fetched tip*, not the dirty checkout:
rm -rf /tmp/adgen-tip && mkdir /tmp/adgen-tip
git archive adgen-src/master | tar -C /tmp/adgen-tip -x
diff -rq --exclude=.git --exclude=node_modules /tmp/adgen-tip adgen/
# Must be empty.
```

The draft’s `diff -rq ../liquidretail_adgen adgen/` compares the **dirty 33-behind Vertex tree**. Do not.

`git log -- adgen/src/foo.js` will show the graft commit, not 147 adgen commits (old trees have no `adgen/` prefix). GitHub blame attributes every line to the merger. Grafted `(#131)` autolinks to **backend** `#131`. Object-level authors/dates are intact; the UI people use is not. That is the subtree vs `filter-repo --to-subdirectory-filter` tradeoff: filter-repo would make blame work and **rewrite every adgen SHA**, breaking `16e64e2:src/...`. We pick the harnesses.

### Trunk

**`main`.** Hardcoded `master` to fix on the merge branch (same PR, after subtree, still no production behavior change except CI):

- `adgen/.github/scripts/prCollisionWatch.js` — `const BASE = 'master'` (inert under `adgen/` until hoisted)
- `adgen/.github/scripts/rebaseOpenPrs.js` — same
- `adgen/scripts/verifyRegenerateInFlightGate.js:1038` — `git show origin/master:scripts/vendor-manifest.json` **fails closed** on the survivor. Rewrite or delete in the CI commit, **not** via `expectedFailures`.

### Remotes afterwards

| remote | after cutover |
|---|---|
| `emami-rs-project/liquidretail_backend` | survivor. Do not rename in this window. |
| `Emami-RS-Project/liquidretail_adgen` | keep **writable** until every Render service builds from the survivor and a cached-image rollback has been rehearsed. Then GitHub Archive + README pointer. Do not delete. Old adgen SHAs in the survivor have **no** `adgen/` prefix — they are not deployable from the survivor with `rootDir: adgen`. |
| `emami-rs-project/liquidretail` | unchanged |
| `Emami-RS-Project/claude-org-brain` | unchanged |

**Graft PR merge method: Create a merge commit. Disable squash and rebase for that PR.** Confirm branch protection is not “Require linear history” (API 401 this pass — click the UI). After it lands, ancestry gates on a **fresh clone of origin/main**, not the merge worktree.

`git revert -m 1` only works on a merge commit with no follow-ups. The yaml pin is a follow-up. Treat push of the graft to `main` as git point-of-no-return. Rollback is Render cached-image + the still-writable adgen repo.

**Do not `filter-repo` tracked `node_modules/`** (~4,930 files, `bin/setup-worktree.sh:6-7`) in this window. That rewrite kills `9531ae9f`.

---

## 4. Directory layout and the require graph

### The FILE vs DIRECTORY bug (real, already handled in-tree)

Adgen has both `src/config.js` (FILE) and `config/` (DIRECTORY at repo root). From `src/services/*`:

| require | resolves to |
|---|---|
| `require('../config')` | FILE `src/config.js` (renderer `:25`, titler `:37`, orchestrator `:27`, regenerateConsumer `:108`, retitleConsumer `:90`, …) |
| `require('../config/segmentPromptOverrides')` | **NOWHERE** |
| `require('../../config/segmentPromptOverrides')` | the DIRECTORY file (`staticAdIntents.js:1242`) |

`verifyStaticIntentChanges.js:377` pins the `../../` form. **Do not flatten. Do not rename `src/config.js` in the graft.** Prefix keeps the relative depths.

### Mechanical rewrite of application requires: none

`verifyRequireGraph.js` uses `__dirname` (`ROOT = path.join(__dirname, '..')`). `node adgen/scripts/verifyRequireGraph.js` from git root still scans `adgen/src`. Gate:

```bash
cd adgen && node scripts/verifyRequireGraph.js
# Last line: ✅ verifyRequireGraph: N/N
# N must equal freeze-N recorded on the GitHub tip *and* N > 0
```

**Add `assert.ok(total > 0)` and `assert.strictEqual(total, FREEZE_N)`.** Today `total` is edges checked; a missing `src/` yields `✅ 0/0` (`requireGraph.js:31-36`).

False greens the harness will not catch: stubs that exist but don’t export; bare specifiers (mongoose/sharp); cwd dotenv; `.jsx` / ESM island; `path.join(__dirname, …)` targets are referenced but not existence-checked.

**Backend has no `verifyRequireGraph.js`** (brief said both; origin/main does not). Do not move backend files.

### `siblingBackend.js` — rewrite on the merge branch

```39:47:liquidretail_adgen/scripts/lib/siblingBackend.js
function resolveBackendRoot(repoRoot) {
  const candidates = [];
  if (process.env.ADGEN_BACKEND_PATH) candidates.push(process.env.ADGEN_BACKEND_PATH);
  candidates.push(path.join(repoRoot, '..', 'liquidretail_backend'));
```

After graft `repoRoot` is `…/liquidretail_backend/adgen`. Candidate becomes `…/liquidretail_backend/liquidretail_backend`. Parent **is** the backend (`models/` exists). Add `path.join(repoRoot, '..')` as a candidate. Set `ADGEN_BACKEND_PATH` in CI to `${{ github.workspace }}`.

Today a miss INFO-skips and `verifyModelParity` prints `✅ 0/0 checks run (skipped)` exit 0. `verifyHandoffContract` skip sits **inside `check()`**, so skip increments `pass`. After graft, without this rewrite, the only schema-subset pin is vacuous **in the one clone that finally has both trees**.

`ADGEN_REQUIRE_SIBLING` / `BACKEND_REQUIRE_SIBLING` appear **only in the 2026-09-02 plan**. Zero JS readers. Putting the env on the workflow changes nothing until the harnesses **throw** on a missing sibling.

`vendorDrift.js` `isGitRepo` looks for `.git` **immediately inside** the dir (`:70-77`), does not walk parents. `adgen/` has no `.git` → silent working-tree hash. Point `backendRoot` at the monorepo root (which has `.git`) or retire in the same PR as a same-repo replacement that is revert-proved red.

---

## 5. Deploy topology

### Today

| surface | config | plan / scale in git |
|---|---|---|
| backend web / worker | dashboard only, `rootDir: ""` | UNKNOWN (snapshot) |
| `adgen-api` | `render.yaml` web, `plan: starter`, `autoDeploy: true` | starter; no `scaling:` |
| `adgen-orchestrator` | worker, `plan: starter`, `autoDeploy: true` | no `numInstances:` (comment: dashboard 1) |
| `adgen-renderer` | worker, `plan: pro_plus`, `autoDeploy: true` | **no `scaling:`**. Comments contradict: “DISABLED” vs “dashboard min=2 max=8”. Owner brief: min2/max4. **Snapshot wins.** |
| `adgen-titler` | worker, `plan: pro_plus`, `autoDeploy: true`, `ADGEN_TITLER_ENABLED: "false"` | **no `scaling:`**. Comment: live min=4/max=12. |
| SPA | Netlify `frontend/app` → `dist` | out of this merge |

**Zero `scaling:` keys in `render.yaml`.** Render changelog (2022-01-12, still the rule this team measured): once Blueprint-managed, a sync with no `scaling:` **disables autoscaling**; instances fall to 1. That is titler 6→1.

`plan` and `scaling` are independent. A sync that “only” adds `rootDir: adgen` and leaves `plan: pro_plus` still kills autoscale.

### Env vars that double-claim or double-bill

| var | committed | live (claimed) | hazard |
|---|---|---|---|
| `ADGEN_RENDERER_ENABLED` | `false` in **both** `defaults.env` (backend `:1410`, adgen `:1581`) | dashboard `true` | Not in yaml (good). A **new** service from git gets `false` → leftover `runRenderLoop` **and** adgen `claimOne` if the old adgen still has `true`. |
| `VIDEO_PROVIDER` | `atlas` in `adgen/config/defaults.env:394`; `activeProvider` `\|\| 'atlas'` | dashboard **`gemini` on adgen-renderer only** | **Not in yaml (keep it that way).** Origin adgen router: atlas / gemini / vertex throws / else throws. Origin **backend leftover** router is still `atlas` else **Vertex**. |
| `ADGEN_TITLER_ENABLED` | yaml **`value: "false"`** (`render.yaml:107-108`), not `sync: false` | dashboard likely `true` | Blueprint sync darkens titler; renderer (key not in its envVars) keeps handoff. Paid masters sit `{titlingNeeded:true, claimedByWorker:null}`. Backend titling sweeper is **deleted** (`index.js:385-393`). |
| `REMOTION_QUEUE_CONCURRENCY` | backend **4**, adgen **2** — the one value disagreement | dashboard may differ; 4 OOM-killed 8 GiB | Do not unify defaults.env. Cwd-relative dotenv from git root loads **backend’s 4** into adgen. |
| `ADGEN_ROLE` | per-service in yaml | must stay | Invalid → `process.exit(1)` (`src/config.js:16-20`). Workers have **no** `healthCheckPath`. |

`VIDEO_PROVIDER=gemini` is a **code path** on origin (`geminiVideoService.js` exists). It is **not** the selected value in git. Treat the selection like a secret.

### Merged deploy (the sequence the reviewers broke, then we fixed)

**Invariant: a Blueprint apply is a four-service event. Do not use it as the repoint.**

1. **Snapshot** via Render API (plan, instance count, min/max, **target CPU/mem**, every env, `rootDir`, `dockerContext`, `dockerfilePath`, `env: docker`, autoDeploy, Blueprint Auto-Sync). Written checklist. CLI cannot set `dockerContext`/`dockerfilePath`. **Abort the window if the snapshot file is missing.** Do not copy yaml comments or the owner brief into `scaling:`.
2. **Dashboard:** Auto-Deploy = No on all six services. **Blueprint Auto-Sync = No.** Raise `--max-shutdown-delay` above `ATLAS_TIMEOUT_MS` (900000) before any worker replace. Old plan required this; the first draft dropped it.
3. **On the merge branch, in git, before `main` ever sees the graft:**
   - `autoDeploy: false` on all four
   - `scaling:` copied from the snapshot, **including targets**
   - `ADGEN_TITLER_ENABLED`: `sync: false`; **drop `value: "false"`** (or keep it only after rewriting G4 — today G4 matches `["']false["']` within 40 chars of the key, so `sync: false` **false-greens**)
   - Do **not** add `VIDEO_PROVIDER` or `ADGEN_RENDERER_ENABLED`
   - Explicit **repo-root relative** `dockerContext: ./adgen` and `dockerfilePath: ./adgen/Dockerfile` unless the snapshot proves `rootDir` rewrites both. The comment “dockerContext defaults to rootDir” is untested; Render’s spec treats those fields as repo-root paths.
4. Merge to `main` (merge commit). **No Render deploy fires** (Auto-Deploy No, yaml `autoDeploy: false`, Auto-Sync No).
5. **Unlink the old Blueprint** from the adgen repo **before** attaching anything to the survivor. Two Blueprints matching `adgen-api` etc. is undefined (Render: last sync wins).
6. **Repoint one service at a time in the dashboard** (not via Blueprint attach):
   - Drain **that role** first. For renderer: do **not** flip backend `ADGEN_RENDERER_ENABLED`. Stop new claims on the old renderer (or wait `claimedByWorker` for that worker id to 0). Drain budget today is **25s** (`renderer.js` `SHUTDOWN_DRAIN_MS \|\| 25_000`); Atlas hold is **15 min**. After 25s, receipt-holding claims **stay claimed** on a dead `WORKER_ID` (`${ROLE}-${random}`, not pinned in yaml). `alertOrphanedClaimsOnBoot` is Slack-only.
   - Pin `env: docker`. A native Node start of `adgen/` has **no postinstall**; Chrome bake is Docker-only (`Dockerfile:89-90`). Native start of repo root runs **backend Express**; `ADGEN_ROLE` is ignored; process “up”; nobody claims.
   - Order: **api → orchestrator → renderer → titler last**, or overlap titler (new healthy before old SIGTERM). Draft’s titler-before-renderer is the livelock order: renderer keeps stamping `titlingNeeded:true` into a dead titler.
   - Success: **claim-and-release** with the new worker id, including `status: {$in:['rendering','draft']}` (`titler.js:154-163`). `/health` exists only on `adgen-api`.
7. Attach Blueprint to the survivor, path `adgen/render.yaml`, Auto-Sync still No, after all four are verified. Then Auto-Sync if you want yaml to be source of truth **of the pinned file**.
8. Re-arm Auto-Deploy only after that.

### P0.1 dotenv (still live on origin)

```12:13:liquidretail_adgen/src/config.js
require('dotenv').config();
require('dotenv').config({ path: 'config/defaults.env' });
```

`dotenv` does not throw. **Docker `WORKDIR /app` + `COPY config/` keeps this working in the image.** The graft trigger is `node adgen/src/entrypoint.js` from git root (CI / onboarding / a backend habit), which loads **backend** `defaults.env` (`REMOTION_QUEUE_CONCURRENCY=4`). Land `__dirname`-anchored dotenv on the **split** adgen repo and deploy it before the graft. Do not treat P0.1 as the thing that saves Docker cutover.

---

## 6. Money-safety invariants

Both live repos share one Mongo. The graft must introduce zero database-observable behavior change. **§6.8 of the first draft (“no double-bill moment exists”) was false.** The tree-move can be behavior-free. The documented *rollback* and *Blueprint* steps were the double-bill.

### 6.1 Atomic renderer claim

`liquidretail_adgen/src/services/renderer.js:705-714` (confirm on freeze SHA):

```js
if (!isAdgenRendererEnabled()) return null;
return Ad.findOneAndUpdate(
  {
    status:          'rendering',
    claimedByWorker: null,
    renderRoute:     { $in: ['html_gen', 'veo'] },
    ...(isTitlerEnabled() ? { titlingNeeded: { $ne: true } } : {}),
  },
  { $set: { claimedByWorker: WORKER_ID, claimedAt: new Date() } },
  { new: true, sort: { createdAt: 1 } }
);
```

Pins: `verifyRendererAtomicClaim.js`, `verifyAdgenClaimRespectsRendererFlag.js`.

Backend leftover **never writes `claimedByWorker`** (`models/Ad.js:48-51`). Flag false on backend + true on adgen → leftover `ads.js:1867+` submits **and** adgen `claimOne` matches `{status:'rendering', claimedByWorker:null}`. Origin-line leftover `videoRouter` is still `atlas` else **Vertex**. Dashboard gemini is renderer-only. That is two vendors on one Ad.

### 6.2 Four namespaces — not four fields

| namespace | fields | filter gist | file |
|---|---|---|---|
| renderer | `claimedByWorker` / `claimedAt` | `status:'rendering', claimedByWorker:null, renderRoute∈{html_gen,veo}, titlingNeeded≠true` | `renderer.js:705-714` |
| titler | **same** `claimedByWorker` | `status∈{rendering,draft}, veoVideoUrl≠null, titlingNeeded:true, claimedByWorker:null` | `titler.js:154-163` |
| regenerate | `regenerateClaimedByWorker` / `At` | `regenerating:true, regenerationRequest:{$type:'object'}, regenerateClaimedByWorker:null` | `regenerateConsumer.js:201-209` |
| retitle | `retitleClaimedByWorker` / `At` | `retitleRequest` present, `retitleClaimedByWorker:null` | `retitleConsumer.js:118-120` |

Renderer/titler share the field, partitioned by `titlingNeeded`. Regenerates/retitles are disjoint **because** a retitle target is commonly `status:'live'`, which titler cannot match. `$type:'object'` on regenerate is load-bearing vs `$ne:null`. Do not consolidate helpers in this window.

ARM 2 without baseline is **not** a hole: filter requires `'regenerationRequest.priorVeoPredictionSetAt': {$type:'date'}` (`:282-288`) and the executor fail-closes (`adRegenerateService.js:1089-1105`). Do not null `regenerateClaimedByWorker` by hand.

### 6.3 `identityDigest`

Unique `{ campaignId: 1, identityDigest: 1 }` on both copies (backend `models/Ad.js` ~`:843` on origin-line; confirm at freeze — draft `:872` drifted). Neither sets `strict: false`. Cross-tree `require` of backend models from adgen (or the reverse) silently drops undeclared paths. **Do not load one tree’s models from the other process in this window.**

### 6.4 Derive-never-submits

`scripts/verifyRendererVideoMoneyInvariants.js` is a source-text proof against `src/services/renderer.js`. **Dirty vs origin-line are different proofs:** dirty B1 demands exactly one `atlasVideo.generateForAd`; origin-line B1 demands exactly one `videoRouter.generateForAd` and zero provider-named calls. Graft GitHub origin (router). Run the harness from `adgen/scripts` against that file. A stub at a hoisted path is the vacuous pass.

### 6.5 Backend reaper skip — line numbers moved

Brief cited `worker.js:387-405`. **On origin those lines are catalog post-sync reconcile.** The skip is `worker.js:568-587`:

```js
receiptFree({
  status: 'rendering',
  updatedAt: { $lt: cutoff },
  claimedByWorker: null
})
```

The adgen skip is **`claimedByWorker: null`**, not `receiptFree`. `receiptFree` only excludes receipt-holding unclaimed rows. **`verifyReceiptAwareRequeue.js` has zero `claimedByWorker` hits. Dropping the claim conjunct stays green.** Pin it (W2) on the split backend **before** the graft.

**`persistOrphans` (`services/processAlerts.js:155-161`) does not have the claim conjunct.** It only runs if backend tracked the run (`inFlight.track` is **below** the adgen return, `ads.js:1883`). Flag true → tracks nothing → persist no-ops. Flag false → persist can requeue receipt-free rows **adgen already claimed**. Another reason never to flip the flag.

The graft does not move `worker.js`. Proof: `git diff origin/main -- worker.js` empty on the merge commit.

### 6.6 Boot recovery vs the kill switch

`bootRecoveryService.js:405` `adgenOwnsRendering = isAdgenRendererEnabled()` then `receiptKinds = adgenOwnsRendering ? 'image' : 'both'` (`:436`). Flag false re-includes video receipts. Claimed rows older than `RESUME_CLAIM_STALE_MIN` (default 15, equal to `ATLAS_TIMEOUT_MS`) are swept **including `claimedByWorker ≠ null`**. Video path is GET (`resumeForAd`), not submit — dual-render / clobber / stealing a live poll, which drives an operator regenerate (`allowResume:false`) into a **second paid POST**.

Backend recovery has **no** `veoProvider === 'gemini'` fork (adgen origin-line does). Flip-web-only + `RUN_WORKER=true` on web = Atlas GET of Gemini ids.

`titlingResumeService.js` is deleted. Adgen owns titling exclusively.

### 6.7 mongoose 7 vs 8 / `rawResult` — still a landmine

P0.2 is **not done**. Live sites include:

- `routes/upload.js` (origin ~`:160`)
- `services/catalogProductDraftService.js:256`
- `services/catalogSyncService.js` (~`:284`/`:300`)
- `services/apifyIngestService.js:664`
- `services/capabilityExecutors/catalogBulkCreateProducts.js:182`
- `services/capabilityExecutors/catalogCreateProduct.js:123`
- **also** `shopifyPublicIngestService.js:541` (reviewer; confirm at freeze — draft’s six-site list missed it)

Mongoose 8.24.3: `rawResult` gone; `includeResultMetadata` defaults **false** (the 2026-09-02 plan was wrong on the default). Convert on mongoose 7, deploy, bake, *then* a later bump. Graft keeps two lockfiles.

`strictQuery`: adgen `src/db.js:37` sets `true`; backend never calls `mongoose.set` (mongoose 7 default `false`). Already mismatched in production. Do not “fix” as part of the graft.

### 6.8 Double-bill moment — designed out

The only remaining ways:

| moment | designed out by |
|---|---|
| Graft commit auto-deploys | Auto-Deploy No + yaml `autoDeploy: false` + Blueprint Auto-Sync No **before** `main` |
| Blueprint sync re-arms `autoDeploy: true` | yaml key is `false` in the same commit as `rootDir` |
| Operator “rolls back” by flipping `ADGEN_RENDERER_ENABLED=false` | **Forbidden.** Rollback is cached-image. If new work must stop, pause the HTTP generate route or add a **new** env both leftover **and** adgen honor, without enabling leftover. Do not ship that env in this window unless the leftover is deleted. |
| New Render service from git defaults | Do not recreate services. Repoint. Snapshot includes `ADGEN_RENDERER_ENABLED=true` and `VIDEO_PROVIDER=gemini` as dashboard-only. |
| Dirty tree grafted | Fetch GitHub; byte-identity against `git archive adgen-src/master` |
| Parent mongoose 7 | `npm ci` in `adgen/` + boot assert major 8 |
| `persistOrphans` during leftover | leftover never runs (flag stays true) |

There is then no *merge-designed* moment at which two billable submitters own the same row. The leftover path remaining in backend is a **pre-existing** footgun. Deleting it is its own PR (owner already ordered the generation stack stripped). Do not couple that deletion to the graft.

---

## 7. Test suites and worktree rules

### Counts (do not hardcode)

Both runners: `VERIFY_RE = /^verify.*\.(js|mjs)$/` on `scripts/` only, not recursive.

| | verify*.js | verify*.mjs | last recorded full run |
|---|---:|---:|---|
| adgen | 97 | 9 | UNKNOWN wall-clock; glob **106** |
| backend | ~224 local / ~208 shebang | 11 | **220/220** on 2026-09-01; CLAUDE.md 184 and ci.yml 218 are stale |

`expectedFailures: {}` in both. A listed script that **passes** fails as STALE (`adgen/scripts/runVerifySuite.js:224-230,258-263` needs `reason` **and** `removeWhen`). Missing file returns `{}` (adgen `:243-245`) — comment lies that missing is a hard error.

CI redness of current GitHub tips: **UNKNOWN** (not run; nothing billable). Stage 1 records it in **fresh solo clones** (no sibling). Local checkouts resolve `../liquidretail_backend` and do not reproduce CI.

### What dies (Phase 5, after a same-repo replacement is revert-proved red)

| machinery | after merge |
|---|---|
| `vendor-manifest.json` / `verifyVendorDrift.js` / `UNPORTED_GRACE_DAYS_DEFAULT=14` | do **not** delete until a same-repo check fails on a planted drift. Adgen-hash half is the only merge-blocking vendor check CI actually runs without a sibling. |
| `verifyModelParity.js` | rewrite sibling path **now**; retire only when models are hoisted |
| `gitAudit.js` copies | one copy |
| `INPUT_SCHEMA_VERSION` cross-repo | one module, later |
| `ADGEN_BACKEND_PATH` sibling probes | rewire now (parent / `adgen/` prefix on `git show`); skip-inside-`check()` must **throw** |

**Keep:** every money harness in §6, `verifyRequireGraph.js` (with freeze-N), remotion/titler/regen/retitle pins, baseline-SHA harnesses.

### CI shape

One workflow at repo root. **Never** `on.*.paths` on a required workflow.

`dorny/paths-filter` at job `if:` plus aggregator job **named `ci`**. The 2026-09-02 YAML computed `shared` and **never read it**. Job `if:` was only `backend` / `adgen`. A PR that touches `models/Ad.js` skipped adgen’s parity/drift/handoff — the checks whose job is “backend changed a shared blob.” Aggregator treated `skipped` as success.

**Required:** any change to `models/**`, `schemas/**`, `services/handoffContract.js`, `adgen/src/models/**`, `adgen/src/services/handoffContract.js` runs **both** jobs. Pin that `if:`. Aggregator `if: always()` must also fail if `needs.changes.result == failure`.

`fetch-depth: 0` stays. Add `git cat-file -e 9531ae9f && git cat-file -e 16e64e2`. `cache-dependency-path` per lockfile. Adgen job `working-directory: adgen`, `ADGEN_BACKEND_PATH: ${{ github.workspace }}`, and a **real** sibling-required throw.

Hoist or retire `pr-collision-watch.yml` / `rebase-open-prs.yml`. `BASE = 'master'` → `main` if hoisted.

Root `npm test` is the **backend** glob only. Two invocations, forever. A “simplify CI” that drops the adgen job silently loses derive-never-submits / claim partition.

`VERIFY_RE` already includes `.mjs`. Do not restore the js-only shell loop (CLAUDE.md already records that it skipped titling geometry).

### Worktree rules — reconciled

The contradiction existed because of `mongooseLoader.js:11-31`: a bare adgen worktree’s `require('mongoose')` **must fail** so a `Module._load` patch can point at the sibling. `npm ci` or `NODE_PATH` → first require succeeds → 0/33 “never called mongoose.model.”

Backend `bin/setup-worktree.sh`: committed `node_modules` subset is incomplete. `.mjs` ignores `NODE_PATH`. Backend worktrees **require** `npm run setup:worktree`.

**After merge:**

- Rewrite or retire the loader hack **before** telling people to `npm ci` in `adgen/`. CI already `npm ci`s; today that’s harmless because parity 0/0-skips. Making parity real without rewriting the loader goes 0/33 red, then someone allowlists it.
- Backend worktrees still `setup:worktree`.
- Nested worktrees remain forbidden. Sibling-only: `/Volumes/Sayulita/Projects/RS/.wt-<name>`.

---

## 8. In-flight work

**38 sibling `.wt-*`.** Local trunks dirty. **Merge source is GitHub tips.**

### Already landed while this document was written

| item | SHA | action |
|---|---|---|
| backend `#396` duration | `ec64a9a5` | **abandon the worktree.** Do not re-apply (squash illusion). |
| adgen `#133` duration | `98be56bd` | same |

### Must land on the *split* repos before the graft (class A)

| item | where | how |
|---|---|---|
| **P0.1 dotenv `__dirname`** | adgen | ordinary PR, deploy, bake |
| **P0.2 `rawResult` → `includeResultMetadata`** | backend, mongoose 7 | include `shopifyPublicIngestService.js` if still live |
| **B14/V2/V3 SKIP → fail-closed** | backend | otherwise squash/shallow mutes the money pin |
| **`claimedByWorker: null` pin in `verifyReceiptAwareRequeue.js`** | backend | dropping the reaper conjunct is currently green |
| **`fix/director-title-cards`** | adgen `.wt-director-title-cards-fix`, **5 ahead, unpushed** | branch **tracks `origin/master`**. `git push` from that worktree fast-forwards **master**. Push with `git push -u origin HEAD:fix/director-title-cards`. Dirty=2 is not in the five commits — commit or format-patch separately. |
| **`fix/video-money-guards-resume-receipt`** | `.wt-ship1-money-guards`, 1 ahead, tracks `main` | same: `git push -u origin HEAD:fix/video-money-guards-resume-receipt` |
| **`fix/strip-catalog-title-from-generative-prompt`** | `.wt-ship2-vaportek`, 1 ahead, tracks `main` | same |
| **`feat/deterministic-video-template-selection`** | `.wt-ship3-template-selection`, **2 ahead, no PR**, omitted from the first draft | class A. Primaries also have this as **untracked** files on the stale trunks — do not commit those there. |

`git reset --hard @{u}` in any class-A worktree **deletes the unique commits**. They have no `refs/remotes/origin/<feature>`.

### Replay after merge (class B)

Only with:

```bash
git format-patch --stdout origin/master..fix/director-title-cards \
  | git am --directory=adgen
```

`git am` / `git cherry-pick` of an adgen SHA at repo root writes `scripts/` and `config/` onto **backend**. `cd adgen && git am` does not help (paths are repo-root relative).

### Abandon the commits, inspect the dirt (class C)

Backend `port/*` at `10ab21ab` are **0 ahead** — commits are on origin as the strip/port wave. Abandoning the **SHAs** is right (owner: strip dormant generation, don’t sync). They are **dirty** (3–13 lines). Dirty is not a SHA. Diff dirty vs ship1/ship2 before wiping. Do not `git clean`.

**Do not rescue `.wt-gemini-direct`** (`lr=32 3`). Its `videoRouter.js` is the Vertex `else`. Live gemini is on origin. Rescuing “because production is gemini” replays Vertex onto the live renderer. Same for `.wt-video-refs-landing` (`lr=33 3`), `.wt-pad-source-scale` (`lr=34 6`).

Adgen `port/schema-hygiene` was the vaportek *adgen* half. Confirm `#124` merged (not in `gh pr list` ≠ on origin). UNKNOWN uniqueness this pass.

### Stale-replay / mid-rebase (class D)

- Primary backend `main` and adgen `master`: dirty, 22/33 behind GitHub. **Do not commit, rebase, or push from them.**
- `.wt-b14-control` detached at `b4eb6435`.
- `.wt-port-observability` has `REBASE_HEAD`. `.wt-port-schema-hygiene` / `.wt-port-segment-consumer` / director-title-cards have leftover `AUTO_MERGE` (title-cards: rebase finished; `MERGE_HEAD` absent). Do not `merge --continue`.

### SPA (class E)

Independent freeze. **Uncommitted** `adLabels.ts` + `ProductAds/index.tsx` are not on origin. “Not a merge blocker” is how they die. Commit or export. Feature branch `d3bdceb` is pushed (gitignore only vs its remote). SPA worktrees `lr=3 1` — Master badge is already `#88`; cherry-check with `gitAudit.js` two-gate, not `git cherry -v` leading `-` (that check is why `gitAudit.js:250-325` exists).

### Other

- `.wt-static-creative-qc-notes` is **NO_GIT** with real PNGs. A “remove sibling `.wt-*`” glob deletes QC evidence with no reflog.
- `.wt-strip-adgen` is **gone** from disk. `PROVIDER-FORK.md` / −14k strip may still be `origin/chore/strip-dead-vendored`. Fetch that ref before calling class C done.
- `.wt-font-every-import` `lr=7 1`, dirty, tracks `main`, session.md called it a cross-process double-bill hole. Not renderer-merge-surface; freeze+graft from origin drops it. Land or format-patch.

### Freeze (real, not two sentences in session.md)

From merge-branch cut to cutover-complete:

- `gbrain_work remember` the freeze.
- `git worktree lock` on every `.wt-*` you are not landing.
- `bin/setup-worktree.sh` exit 1 if `FREEZE` file exists at RS root.
- GitHub: dummy required check or a sticky PR comment on remaining opens.
- Class A pushes use `HEAD:<feature>` explicitly.
- Re-fetch immediately before `subtree add`. If GitHub moved, abort and restart the merge worktree. Do not “just merge main in.”

Use `scripts/lib/gitAudit.js` (or `npm run check:orphaned-branches`) for “already upstream,” not `git cherry -v`.

Open PRs at ~07:05Z: backend **#319** (harness, stale, not a merge blocker). SPA none. Late-August HELD money PRs are not in `gh pr list` — merged or closed; do not revive from memory.

---

## 9. Sequencing

Each stage independently revertible. Production stays up. **No stage flips `ADGEN_RENDERER_ENABLED` or `VIDEO_PROVIDER`.**

| stage | what | proof | rollback |
|---|---|---|---|
| **0a** | P0.1 dotenv `__dirname` on adgen, deploy, bake | running process has `REMOTION_TIMEOUT_MS` from adgen file | previous adgen image |
| **0b** | P0.2 `rawResult` on backend mongoose 7, deploy, bake | catalog upsert 200/201 | previous backend |
| **0c** | B14/V2/V3 fail-closed; `claimedByWorker` pin on reaper harness | those harnesses exit 1 if you hide the SHA / drop the conjunct | revert those PRs |
| **0d** | Class A branches as **feature** remotes (`git push -u origin HEAD:fix/...`), review, merge | GitHub has the SHAs | revert those PRs |
| **0e** | Render API snapshot file exists (incl. scaling targets, dockerContext, env: docker) | file present | n/a — **hard stop if missing** |
| **0f** | Dashboard Auto-Deploy = No on all six; Blueprint Auto-Sync = No; raise max-shutdown-delay | dashboard confirms | re-enable if aborting |
| **1** | CI baseline in fresh solo clones | committed log of failing scripts | n/a |
| **2** | Merge branch: subtree from **GitHub** tips + siblingBackend rewrite + mongoose major-8 assert + yaml `autoDeploy: false` + `scaling:` from snapshot + titler `sync: false` + G4 rewrite + `verifyRequireGraph` freeze-N + `--affected` unknown-segment fallback + eslint ignore `adgen/**` | ancestry gates; `diff -rq` vs `git archive`; N/N; `npm run lint`; adgen boot assert | delete the branch; old repos untouched |
| **3** | Graft PR to `main` as **Create a merge commit** (squash disabled). Auto-Deploy still No. | fresh clone: `merge-base --is-ancestor 16e64e2 origin/main`; **no Render deploy** | Render not involved. Git: keep adgen GitHub writable. `revert -m 1` only if literally no follow-up — there will be follow-ups, so don’t count on it. |
| **4** | Unlink old adgen Blueprint. Dashboard-repoint **one** service at a time (api → orchestrator → **renderer** → titler), drain that role first, `env: docker`, claim-and-release including `draft`. | new `WORKER_ID` appears and clears | cached image (2–5 min). Rebuild is 8–20 min and blows the 15 min hold. |
| **5** | Attach Blueprint to survivor, path `adgen/render.yaml`, Auto-Sync still No | yaml matches snapshot; autoscale still at snapshotted min/max | unlink Blueprint; dashboard still has the live values |
| **6** | Re-arm Auto-Deploy / Auto-Sync only after all four verified | next adgen-only commit deploys only adgen | n/a |
| **7** | CLAUDE.md + session.md + hook repath | deliberate hook break surfaces | revert docs/hooks |
| **8** | Later, own windows: retire vendor tooling (after replacement is red); hoist schemas/utils/models; mongoose 7→8; detection require; leftover `runRenderLoop` deletion; optional SPA graft | their own proofs | their own reverts |

---

## 10. What it unlocks

Once they share a tree, the live renderer can reach backend-only detection:

- `services/yoloService.js` including `/detect-video`
- `services/dinoOverlayZoneService.js`
- `services/mediaYoloRefine.js`
- `services/catalogYoloDetectionService.js`
- `services/yoloIdentifyService.js`

Today those blobs are **missing from adgen origin**. Subject-aware title placement that dodges a detected body/logo on a generated plate is impossible without a port, and ports drift.

**Follow-up, not this PR.** From `adgen/src/services/whatever.js` the path is `require('../../../services/yoloService')` (the first draft’s `../../` lands in `adgen/services/`, which does not exist). `mediaYoloRefine.js` then `require('../models/Media')` loads **backend** mongoose-7 models onto adgen’s mongoose-8 connection. Strict mode silently drops fields. Design that require (pass the adgen connection, or hoist mongoose-free helpers) as a separate spec.

Also later: one `INPUT_SCHEMA_VERSION`, one remotion island (including the SPA copy), `retitleMode` fixed once, deletion of `verifyVendorDrift` / grace-days.

Not unlocked by *this* merge: SPA preview = renderer, org-brain scout, leftover `runRenderLoop` gone, rs-ai-backend.

---

## PR plan

1. **`fix(adgen): anchor dotenv to __dirname`** — split repo. Deploy. Bake.
2. **`fix(backend): replace rawResult with includeResultMetadata`** — split repo, mongoose 7, include the seventh site if live. Deploy. Bake.
3. **`test(backend): fail-closed baseline SHA pins + claimedByWorker reaper pin`** — split repo.
4. **Class A feature PRs** — title-cards, money-guards, vaportek, template-selection. Push as **named feature branches**, not to trunk.
5. **Ops: Render snapshot + Auto-Deploy No + Auto-Sync No + max-shutdown-delay** — not a code PR. Hard stop without the snapshot file.
6. **`merge: graft liquidretail_adgen under adgen/`** — subtree **merge commit**, GitHub squash disabled, plus the graft-required wiring (siblingBackend, mongoose major assert, yaml pin, requireGraph freeze-N, `--affected` unknown-segment, eslint ignore). Ancestry + archive-diff + N/N gates.
7. **`ci: aggregator that reads the shared filter; both jobs on models/schemas/handoff; REQUIRE_SIBLING implemented in JS`** — can be the same PR as 6 or immediately after on the merge branch **before** `main` if that keeps the graft PR reviewable. Required check remains job id `ci`.
8. **Ops: unlink old Blueprint; dashboard-repoint one service at a time; then attach new Blueprint.**
9. **`chore: repath .claude hooks; rewrite CLAUDE.md + session.md`**
10. **Later, own windows:** leftover render-loop deletion; vendor-tooling retirement (after replacement is red); mongoose 7→8; detection require; optional SPA graft.

---

## Adversarial review — what they found, what changed

Seven independent reviewers, one axis each. A plan that survives no attack was not attacked. Surviving findings that changed the document:

### Production outage

**Found:** Stage 5 “point the Blueprint” is a four-service deploy; yaml `autoDeploy: true` re-arms dashboard No; yaml titler `"false"` livelocks paid masters while renderer keeps handing off; 25s drain vs 15 min Atlas zombies claims on a random `WORKER_ID`; workers have no health path; `rootDir` ≠ proven `dockerContext`; titler-before-renderer is the livelock order.

**Changed:** Blueprint is not the repoint. Yaml `autoDeploy: false` in the graft. Titler `sync: false` + G4 rewrite. Drain + max-shutdown-delay. Order renderer before titler. Explicit `dockerContext: ./adgen`. P0.1 scoped to native/cwd, not Docker.

**Failed attacks (held):** dotenv on the Docker path; backend `/api/health` masking a dead worker as a *merge-induced* outage; `.claude` hooks blocking deploys; orchestrator/api down taking generation with them.

### Double-billing

**Found:** Draft §6.6 step 1 (flip backend flag) **is** the false/true double-submit. Leftover never writes `claimedByWorker`. `persistOrphans` lacks the claim conjunct. Origin **backend** leftover router still Vertex-falls-through. `verifyReceiptAwareRequeue` does not pin the skip. Dirty vs origin videoRouters are different money machines.

**Changed:** Kill-switch is forbidden as merge rollback. Reaper harness pin is class A. Graft GitHub origin (gemini/throw), never the dirty tree. Leftover deletion is a later PR, not coupled.

**Failed attacks (held):** ARM 2 without baseline; `receiptFree` being the adgen skip; titler+renderer both Omni-submitting via shared `claimedByWorker` (partition holds); `shouldResumeAttempt` auto-resubmitting a Gemini id as Atlas.

### Silent require

**Found:** The require the graft actually changes is **bare** specifiers walking into parent mongoose 7. `verifyRequireGraph` does not see them. Cwd dotenv loads backend `defaults.env`. Draft’s detection `../../` is the wrong depth; `../../../` existence-checks then loads backend models.

**Changed:** `npm ci` in `adgen/` + mongoose major-8 boot assert. Detection require stays a later design. siblingBackend rewrite on the merge branch.

**Failed attacks (held):** FILE vs DIRECTORY after prefix; `SRC_DIR` cwd-sensitivity; Docker `COPY src/` with wrong context (fail-closed, not silent).

### Lost git history

**Found:** Squash-merge of the graft PR drops adgen history from `main`. `git show` is not an ancestry/push gate. B14/V2/V3 SKIP on missing SHA. Byte-identity command diffs the dirty clone. Tracked `node_modules` is the filter-repo lure. `revert -m 1` is theater once yaml follows.

**Changed:** Merge commit only; ancestry gates on a fresh clone; fail-closed money pins before graft; archive-diff; no filter-repo in this window; rollback is cached-image + writable adgen repo.

**Failed attacks (held):** subtree rewriting SHAs without `--squash`; zero-shared-commits being a lie; authors stripped at the object level; tags lost (neither repo has tags locally).

### Autoscale

**Found:** Same as outage C1–C5, plus: pin min/max without CPU/mem targets → platform 60% → scale-to-max on a renderer whose CPU is already 63.5% at concurrency 2; G4 false-green on `sync: false`; COPY-breakage looks like 6→1 only if someone **recreates** the service.

**Changed:** Snapshot includes targets; G4 rewrite; recreate-from-Blueprint forbidden; “plan already matches so sync is a no-op” explicitly false.

### In-flight work destroyed

**Found:** Byte-identity vs dirty tree; class A branches track trunk; format-patch without `--directory=adgen`; `#396` already merged while the draft still “landed” it; `.wt-gemini-direct` rescue; freeze was two sentences; ship3 omitted; `git cherry -v` unsound; SPA dirty files; NO_GIT QC dump.

**Changed:** §8 rewritten around those commands. Duration PRs removed from “land.” ship3 added. Freeze is operational.

**Failed attacks (held):** duration/title-cards conflicting with the 33 origin commits (those branches are `lr=0` vs origin; the 33 is local-behind); freeze deleting 5-ahead worktrees (`cleanupMergedBranches.js` refuses unpushed); abandoning backend `port/*` SHAs losing live gemini (gemini is on origin; rescue is the bug).

### Test suite that passes while covering less

**Found:** `ADGEN_REQUIRE_SIBLING` does not exist in JS; sibling path wrong after prefix; skip-inside-`check()` counts as pass; path-filter `shared` unused; `--affected` already silent-greens `adgen/**`; retiring vendor/parity before a replacement; `vendorDrift` `.git`-inside-dir; requireGraph `0/0`; mongooseLoader+`npm ci` as a path to allowlist; root `npm test` never sees adgen.

**Changed:** §7 implements the flag, reads `shared`, fail-loud on unknown first segments, freeze-N, two `npm test`s, no retirement until replacement is red.

**Failed attacks (held):** STALE being broken (empty `{}` is stall, not mute); `.mjs` currently skipped in CI (`VERIFY_RE` includes them); fetch-depth drop being silent green by itself (baseline harnesses fail-closed except B14 — which we flip).

---

## UNVERIFIED (do not convert to assumptions)

- Live Render scaling, targets, `env: docker`, `dockerContext`, whether renderer autoscale is on. Snapshot is the authority. Yaml comments, owner brief, and `src/config.js:99` (`min:2 max:8`) disagree.
- Live `ADGEN_TITLER_ENABLED` / `VIDEO_PROVIDER` / `ADGEN_RENDERER_ENABLED` on each service. Cited from `session.md` and yaml comments, not the Render API this pass.
- Whether `rootDir` rewrites Docker context. Treat as false until the snapshot says otherwise.
- CI redness of GitHub tips `ec64a9a5` / `98be56bd`. Stage 1.
- `verifyRequireGraph` freeze-N on those tips. Record it; do not reuse 496.
- Exact origin line numbers for `rawResult` sites vs dirty tree (`upload.js` 151 vs 160). `git show` at freeze.
- Whether `shopifyPublicIngestService.js:541` `rawResult` is still on GitHub main.
- Full SHAs of `9531ae9f` and `3e4561e2` (7-char collision after odb union: unverified). Expand at freeze with `git rev-parse`.
- Branch protection “linear history” / squash-only (API 401). Click the UI before the graft PR.
- Whether adgen `#124`–`#127` merged; uniqueness of dirty `port/*` vs ship1/ship2.
- Whether `origin/chore/strip-dead-vendored` still holds `PROVIDER-FORK.md`.
- Render apply order of `value: "false"` + `sync: false` on first attach. Staging apply, then read titler env.
- `npm run lint` on a subtree worktree (adgen remotion ESM under backend CJS eslint).
- Wall-clock of full suites and of an adgen Docker rebuild (quoted 8–20 min from the 2026-09-02 plan, not re-measured).
- Atlas GET-of-Gemini-id response shape (suspected ARM 2 fall-through to `runVideoFull allowResume:false`). Out of merge scope; do not flip regenerate during cutover.

---

## What I could not do

- No Render dashboard/API. Scaling and live env are UNKNOWN.
- No full `npm test` (nothing billable; also the suites are the gate, not this document).
- No `git fetch` that updates the in-scope remotes (this pass is read-only on those repos). GitHub REST and `gh` were used for live tips.
- Explore-agent censuses of on-disk trees mixed dirty files with origin. Mechanical `git show origin-SHA` and GitHub REST are the authority where they disagree.
