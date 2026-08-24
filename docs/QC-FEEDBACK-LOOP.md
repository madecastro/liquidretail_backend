# QC feedback loop

Post-render vision QC already inspects delivered static and video ads
(`services/adVisionQcService.js`). This loop **attributes, aggregates, and
proposes** — it never regenerates, never submits an image or video, and
never joins a render / recover / requeue path.

The live vision-QC switch is the **SystemConfig booleans only**. The env
vars `AD_VISION_QC_ENABLED` / `STATIC_VISION_QC_ENABLED` /
`VIDEO_VISION_QC_ENABLED` are retired and must not be reintroduced.

## The loop

1. **Collect** — `adVisionQcService` stamps `Ad.visionQc` (schemaVersion /
   skipped / disabled / passed / reason / attempts[] / mode). Unchanged by
   the static/video gate split.
2. **Attribute** — `directImageRenderService` stamps `intentResolution`
   with `promptSha256`, `seedStyle`, and `promptFlags` (fidelity /
   lifestyle / brand-led / applied segment overrides / operator
   override+note) so a later report can tell *which prompt* produced a
   verdict.
3. **Aggregate** — worker scheduler (`qcInsightsService.startScheduler`)
   or `POST /api/qc-insights/run` reads a window of STATIC ads
   (`kind:'image'`), segments them, and writes a `QcInsightsReport`.
4. **Propose** — optional LLM stage (`qcInsightsProposalService`), dark
   unless `QC_INSIGHTS_PROPOSALS_ENABLED=true`. At most 2 LLM calls per
   report. Additive directives only (`appendText` ≤ 400 chars).
5. **Review** — `GET /api/qc-insights/report` (HTML). Amber banner if
   **either** gate is off.
6. **Land** — paste a proposal into `config/segmentPromptOverrides.js`
   (append-only table). `staticAdIntents.buildPrompt` appends matching
   entries under `ADDITIONAL DIRECTIVES`. Empty table = byte-identical
   prompts.
7. **Measure** — the next report's `overridePerformance` recommends
   keep / revert / inconclusive per adopted id.

Video QC has its own gate and its own verdicts, but **video prompt text
is frozen** (CLAUDE.md §00). Overrides never touch it.

## Two-gate config surface

| Field | Meaning |
|---|---|
| `SystemConfig.staticVisionQcEnabled` | STATIC pipeline (direct image + recovery) |
| `SystemConfig.videoVisionQcEnabled` | VIDEO pipeline (brand-script titling) |
| `SystemConfig.adVisionQcEnabled` | backward-compat **bridge**, not a separate lever |

Tri-state on each: `true` force on, `false` force off, `null` unset
(bridge to the legacy field, then false). No env fallback. A throwing
SystemConfig read resolves **false** (fail toward OFF).

Read / flip — **`/api/admin/qc-config` ONLY**:

```
GET   /api/admin/qc-config
PATCH /api/admin/qc-config   { "staticEnabled": true|false|null, "videoEnabled": true|false|null }
```

Gated on `requireUserOnly` + `requireSuperAdmin` (routes/admin.js) — a
platform-wide billable switch must never be reachable by ordinary tenant
auth. `/api/qc-insights/*` deliberately has **no** `/config` route: an
earlier draft duplicated it there. See `scripts/verifyQcInsights.js` E2 for
the regression pin (routes/qcInsights.js must never define `/config` again)
and `scripts/verifyAdminSettingsAuthz.js` for the guard's own coverage.

**The ENTIRE `/api/qc-insights/*` router is also super-admin-gated**, not
just `/config` — `router.use(requireUserOnly)` then
`router.use(requireSuperAdmin)` inside `routes/qcInsights.js` itself
(bare mount in `index.js`, same shape as `/api/admin`). Reason:
`qcInsightsService.collectWindowData()` has NO brandId/advertiserId
filter — the aggregation deliberately scans every brand's Ads to find
category-level patterns, so a report can name a specific product category
that effectively identifies a brand (e.g. `categoryTop='fishing shirt'` is
Pelagic on this catalog). Under plain tenant `requireAuth`, any
authenticated member of any workspace — including a viewer — could have
read every other workspace's QC data via `GET /latest`/`/history`/`/report`,
and (once `QC_INSIGHTS_PROPOSALS_ENABLED` is turned on) triggered a real
paid LLM call via `POST /run` with no tenant restriction and no rate limit
beyond the single in-process `isRunning()` flag, which bounds concurrency
per web instance, not per deployment, and bounds concurrency, not rate — a
caller can still run it repeatedly in series. Found in review, closed
before it shipped. Pinned by `scripts/verifyQcInsights.js` E4-E7
(identity-checked router stack + revert-prove, same technique as
`verifyAdminSettingsAuthz.js`'s admin-route coverage).

**Known, accepted limitation:** `POST /run`'s in-flight guard
(`qcInsightsService.isRunning()`) is a plain in-process boolean with no
cross-instance coordination — the same documented characteristic as
`pacedModelSubmit` elsewhere in this codebase. Two manual `POST /run`
calls landing on two different autoscaled web instances in the same
instant could each proceed and both complete, producing duplicate
`QcInsightsReport` docs and duplicate Slack notifications. Accepted as
low-severity now that the route is super-admin-only (analytics-only
blast radius, no unique-index violation, no double-billing at current
`QC_INSIGHTS_PROPOSALS_ENABLED=false`) — reconsider a real distributed
lock only if that flag is turned on AND the collision is observed in
practice, not preemptively.

Strings such as `"false"` are **400** — never coerced.

Env (aggregation only, in `config/defaults.env`):

| Var | Default | Notes |
|---|---|---|
| `QC_INSIGHTS_ENABLED` | `true` | blank → default |
| `QC_INSIGHTS_INTERVAL_HOURS` | `24` | worker tick |
| `QC_INSIGHTS_WINDOW_DAYS` | `14` | lookback |
| `QC_INSIGHTS_MIN_SEGMENT_N` | `20` | concentration floor |
| `QC_INSIGHTS_PROPOSALS_ENABLED` | `false` | exact `'true'` to enable |
| `STATIC_SEGMENT_PROMPT_OVERRIDES` | `true` | exact `'false'` disables |
| `SLACK_QC_INSIGHTS_CHANNEL` | blank | blank → default alert channel |

## Money

This loop does **not** submit image or video. The only optional spend is
the proposal LLM call (~text tokens, gemini-2.5-pro, at most 2 calls per
report) and only when `QC_INSIGHTS_PROPOSALS_ENABLED=true`.

Vision QC itself (the thing this loop *reads*) still costs ~$0.01–0.03
per vision call and, on static FAIL, one extra gpt-image-2/edit
(~$0.07). That is the existing QC gate, not this aggregator.

## Runbook

**Check gate state.** `GET /api/admin/qc-config` (super-admin only) →
`static.effective` / `video.effective`.

**Flip a gate.** `PATCH /api/admin/qc-config` with a real boolean or
`null`. Both web and worker pick it up within the ~5s SystemConfig TTL.

**View the report.** `GET /api/qc-insights/report` (newest) or
`?id=<ObjectId>`. Browser navigation can pass `?_token=<jwt>` the same
way ad preview pages do.

**Adopt a proposal.** Copy the `<pre>` block into
`config/segmentPromptOverrides.js`, set `enabled: true`, deploy. Empty
table / flag off is a no-op.

**Revert.** Set `enabled: false` on that entry (or delete it). Next
window's `overridePerformance` should move off `revert`.

## Known limits

- Aggregation is **STATIC ads only** (`Ad.kind === 'image'`). Video QC
  off with static QC on undercounts nothing in this report; the banner
  still makes the split visible.
- `categoryPrefix` matching needs `CatalogProduct.category` or
  `inferredBreadcrumb` populated. Missing → segment `unknown`.
- Historical ads pre-date the attribution stamp and read as
  `seedStyle: 'unstamped'` / no `promptSha256`.
- Segment groups with `n < 3` are dropped as noise. Concentrations
  require `n >= QC_INSIGHTS_MIN_SEGMENT_N`, lift ≥ 1.5, and rate delta
  ≥ 0.10.
- `QcInsightsReport` rows are analytics-only. Safe to delete.
