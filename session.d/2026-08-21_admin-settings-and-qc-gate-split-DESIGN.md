# Admin Settings + QC Gate Split — Design

Status: **DESIGN ONLY — no implementation in this change.** Written for Nick's
review via the orchestrator. Backend investigation in
`/Volumes/Sayulita/Projects/RS/.wt-admin-settings` (branch
`feat/admin-settings-qc-gates`); frontend investigation in
`/Volumes/Sayulita/Projects/RS/.wt-admin-settings-fe` (branch
`feat/admin-settings-ui`). Nothing committed.

Research split: Grok CLI (`grok-4.6`, `--effort medium`, read-only sandbox) ran
two parallel investigations — full env/gate inventory + money-flag sweep on
the backend worktree, and Team/Settings/SalesDemos/routing/apiFetch on the
frontend worktree. Every Grok claim below that mattered to a decision was
independently re-verified by direct file reads (cited inline); nothing here
is Grok's unverified word.

---

## 0. Live findings, already escalated separately — status and how they interact with this design

Two live authz bugs were found while reading the User/AdvertiserMembership
model this design builds on. Both were sent to the orchestrator directly,
per instructions, rather than buried here. Neither is fixed by this design
and **I am not implementing either** — noted here only so they aren't lost,
and because both change what this design can safely assume.

1. **`routes/members.js` / `routes/invitations.js` privilege escalation.**
   Confirmed independently by the orchestrator. `PATCH /api/members/:userId`
   and `POST /api/invitations` are gated only by tenant membership
   (`requireAuth`), with **no check on the caller's own role** — any active
   member, including `viewer`, can PATCH their own role to `owner` or revoke
   another member. **Ruling: queued, not fixed now** — the orchestrator owns
   this fix afterward, specifically to avoid two sessions editing the same
   authz surface. My design assumes it lands and specifies the shared guard
   contract (`requireMembershipRole`, §3.4) both that fix and anything of
   mine touching tenant roles should use — one definition, not two, per this
   repo's own stated failure pattern (a per-caller copy of a guard is how a
   money hole opened once before, per `CLAUDE.md` §4).

2. **A `User.advertiserId` self-heal hazard — reported, then narrowed by the
   orchestrator's correction; recorded here accurately.** I initially
   flagged `middleware/requireAuth.js:87-112`'s self-heal block (creates a
   fresh membership from the legacy `User.advertiserId` pointer when zero
   *active* memberships exist) as silently undoing a revoke. **That
   conclusion was wrong for the main case, corrected by the orchestrator:**
   `DELETE /api/members/:userId` sets `status:'revoked'` but keeps the row
   (`routes/members.js:124-127`), and the partial unique index on
   `(advertiserId, userId)` (`partialFilterExpression: {userId:
   {$type:'objectId'}}`, not status-filtered) still occupies that slot —
   so self-heal's `AdvertiserMembership.create` throws a duplicate-key
   error, the soft-fail `catch` swallows it, and the re-fetch still finds
   zero active rows, correctly falling through to `403 NO_ADVERTISER`.
   **Revocation holds in the case that matters.** The real, narrow residual
   (not a live escalation): it would only fire if `User.advertiserId`
   pointed at a *different* Advertiser than the one the revoke happened on
   — one the user has literally no `AdvertiserMembership` row for at all,
   real or revoked, so no index collision blocks the create. Since
   `advertiserId` is only ever set at onboarding-create or first
   invite-accept, this is hard to reach in practice, but it is a latent gap
   worth the same hardening either way: gate self-heal on "zero membership
   rows of **any** status," not just zero active ones, so a stray
   `advertiserId` pointer can never manufacture a membership the user has
   no row for at all. Not fixing it here — noted for whoever picks up §0.1.
   **The actual live finding in this area is §3.2's super-admin expansion
   making a revoke of a super-admin's own membership meaningless on
   every tenant, unconditionally, today** — that is the one to treat as
   real.

---

## 1. QC gate split

### 1.1 Current state (one gate, three live callers, one legacy path)

`services/adVisionQcService.js` has exactly one enable/disable gate, shared by
static and video:

- `resolveEnabled()` (async, `adVisionQcService.js:110-128`) — precedence
  `SystemConfig.adVisionQcEnabled` (tri-state Boolean, DB) when a real
  boolean → `process.env.AD_VISION_QC_ENABLED` (`=== 'true'` after
  lowercasing) → default `false`.
- `isEnabled()` (sync, `:172-188`, doc-comment confirms **zero production
  call sites** as of 2026-08-20) — dead code path, kept only as a
  fail-safe-if-ever-needed synchronous fallback. Do not build anything new
  against it.
- Live callers, all `await resolveEnabled()` directly: static
  `directImageRenderService.js:2591`, video `brandScriptExecutor.js:1680`
  (fresh QC) and `:1878`/`qcAndStampVideoAd` (the "no brand resolved" ship
  path), static-recovery `imageRecoveryService.js:348`. `adRegenerateService`
  does **not** call it directly — regenerate reaches the gate indirectly by
  calling `directImageRenderService.renderDirectImage`, which does.
- `SystemConfig.adVisionQcEnabled` (`models/SystemConfig.js:45`) is currently
  `true` in production (set 2026-08-20T22:33:11Z). No HTTP route reads or
  writes it today.

**Recovery is not a separate concern.** `services/imageRecoveryService.js`
header (`:1-35`) states plainly it is static-only ("bootRecoveryService runs
on the WORKER and handles video... this cannot simply stamp `renderUrl`");
its QC call at `:348` calls the exact same `resolveEnabled()` and only ever
runs `judgeRender` (the static judge), never `runVideoPostRenderQc`. It is
the static gate applied to a recovered-rather-than-fresh render, not a third
concern.

**Behavioural asymmetry that any split must preserve exactly** (already true
today, not something this change introduces): static QC failure regenerates
once then fails the ad (`MAX_QC_REGENERATIONS = 1`, hard constant,
`adVisionQcService.js:64` — never an env knob); video QC **never**
regenerates — it flags and can mark the ad `failed` while **keeping**
`renderUrl` (the master is already paid, ~$0.90, and a baked-in defect can't
be fixed by a second submit on the same seed). These are documented as
deliberate, opposite money decisions in the file header (`:1-33`) and must
not be merged into one behavior by the split.

### 1.2 Investigated candidates for "other gates" — verdict: none

I checked every plausible "other QC gate" myself (direct reads) and via Grok,
independently, and both converged on the same answer:

| Candidate | Verdict | Why |
|---|---|---|
| `font-vision` role, `metaAdsFontService.js` | **Not the same family — leave alone** | `META_ADS_FONTS_ENABLED` (`:50-51`, default true) gates a one-shot brand-ingest step that *names typefaces in a brand's existing Meta ad creatives* (`POST /:id/ingest-meta-fonts`). It never runs against a generated ad, doesn't score anything, and already has its own independent toggle. Same LLM vision model family by coincidence, different job entirely. |
| `moderationSeedFallback.isEnabled()`, `directImageRenderService.js:2012` | **Not QC — a spend-recovery retry policy** | `STATIC_MODERATION_SEED_FALLBACK` (`moderationSeedFallback.js:59`, default true, **not in `config/defaults.env`**) governs whether a moderation-blocked static render retries with a *different catalog seed image*. It never inspects a rendered pixel — it's about which billable submit to try next after an Atlas moderation rejection. Different failure class (input-safety rejection, pre-render) than vision-QC (post-render defect detection). |
| `services/htmlValidationService.js` | **No gate exists — dead path, don't add one** | No `process.env` read anywhere in the file. Its only caller path is gated by `AI_HTML_LAYOUT_ENABLED` on the parent HTML-generation service, which `CLAUDE.md` §1 documents as unreachable for live catalog ads (`ai_*` templates go direct-image, never HTML). Giving this an admin toggle would expose a control for a dead code path. |
| Recovery QC, `imageRecoveryService.js:348` | **Same gate as static** | See §1.1 above — confirmed by direct read, not inference. |
| `VIDEO_QC_DENSE_SAMPLING` | **Sub-knob of the video gate, not a gate itself** | Controls *which frames* get sampled for inspection (`videoQcFrameSelectionService.js:157-158`, default true); it cannot disable inspection, only widen/narrow what's sampled. Belongs in the settings catalog as a video-QC tuning value, not as a third on/off switch. |

**Conclusion: exactly two gates should exist, replacing the current one.**
No other genuinely separate post-render QC concern exists in the codebase
today. Both a direct read of each candidate and an independent Grok sweep of
every boolean-ish env-gated validation/moderation flag in `services/` +
`routes/` (30+ flags catalogued) agree on this.

### 1.3 Proposed gates

| Gate | Replaces | Governs |
|---|---|---|
| `staticVisionQcEnabled` | the static half of today's single flag | `directImageRenderService.js:2591`, `imageRecoveryService.js:348` |
| `videoVisionQcEnabled` | the video half | `brandScriptExecutor.js:1680` and the `qcAndStampVideoAd` ship path at `:1878` |

Both live in the new generic settings store (§2), not as bespoke
`SystemConfig` fields — this is also the pilot migration proving the store
works before anything else moves onto it. Same shared boolean parser (§2.4)
for both, closing the exact defect class the brief calls out: today's env
parser (`String(x||'').toLowerCase() === 'true'`) already differs in
behaviour from `moderationSeedFallback`'s (`!== 'false'`, opposite default
polarity) and `metaAdsFontService`'s (`?? 'true'`); a second inconsistent
reader is exactly how this repo has shipped drift before (`CLAUDE.md`'s
`no-undef` / doc-drift incidents are the same species of bug).

### 1.4 Migration from the single flag

`SystemConfig.adVisionQcEnabled` is `true` in production today, protecting
both pipelines. The split must **not** silently change live behaviour:
migrate by seeding both new gates to `true` at cutover (equivalent to
today's state), then retire the old field once both new callers are wired.
Do not default video QC to anything other than what it already is just
because it "never blocks" — that's a policy call for Nick, not an inferred
side effect of refactoring.

### 1.5 A hole this split sits directly next to (flagging, not silently fixing)

`routes/ads.js:2570-2598` and `:3008-3045` (verified by direct read): when
video **titling** throws, the `catch (scriptErr)` branch sets
`titlingFailed` and the ad ships `status:'failed'` **keeping the paid
master** — but that catch branch never calls QC. QC only runs inside
`renderBrandScriptAndSave` (the success path) or the explicit
`qcAndStampVideoAd` call in the sibling "no brand resolved" `else` branch
(same file, both locations). So a paid video that fails specifically at
titling ships with **no** `Ad.visionQc` at all, silently, regardless of
which QC gate is on. This is pre-existing and not introduced by the split,
but it sits in the exact two functions whose QC call sites this work
touches, so I'm flagging it as an adjacent, cheap fix candidate (call the
same disabled/skipped-verdict builder the "no brand resolved" branch already
uses, inside the `catch`) — see Question 6.

---

## 2. Settings-store architecture

### 2.1 The hard question: precedence

Today, two different precedence rules coexist and disagree:

- **Everything in `config/defaults.env`**: process env (Render dashboard)
  loads first, the file loads second via `dotenv`, which **never** overrides
  an already-set var. So Render > file > (no DB layer exists for these).
- **The one DB-backed flag that exists today**
  (`SystemConfig.adVisionQcEnabled`): DB **wins over** env when set
  (`adVisionQcService.js:110-116` — DB checked first, env only on `null`/
  read-failure).

These are opposite rules. A new settings store needs exactly one, stated
plainly:

**Proposed precedence, uniform across every key the new store manages:**

```
DB override (when set / non-null)  >  Render dashboard env  >  config/defaults.env  >  code default
```

This is the QC flag's existing rule, generalized. Rationale: the entire
point of the store is a zero-deploy lever for an operator — if env could
still beat the DB, "change it in the settings screen" would silently no-op
on any key that happens to have a Render dashboard value, which is exactly
the kind of two-writers-disagree bug `CLAUDE.md` §4a documents
(`RENDER_CONCURRENCY` staying wrong for a day). One rule, stated once, and
the settings UI should show the resolved *effective* value plus which layer
it came from (`db` / `render-env` / `defaults.env` / `code-default`) so an
operator is never confused about why a change didn't seem to take effect —
this is a real support cost of getting the display wrong, not a
nice-to-have.

**Consequence worth naming:** this makes the DB the highest-priority layer
for every managed key, which means a key with a Render dashboard override
becomes *harder to change back to "whatever env says"* than to just set a
DB override on top of it. That's intentional (it's the whole point) but
means "clear the DB override" must be a first-class action (tri-state:
explicit true / explicit false / unset-fall-through — same shape as
`adVisionQcEnabled` today), not just a UI reset-to-default button that
secretly just writes the current default value into the DB (which would
freeze that value even after `defaults.env` changes).

### 2.2 Storage model

**Do not** grow `SystemConfig` into a monolith with one schema field per
setting — that requires a Mongoose schema change (a real code deploy) for
every new key, defeating the goal. **Do not** use an un-declared dynamic
object either — Mongoose strict mode silently drops writes to undeclared
paths (a named repo-wide gotcha), so an ad-hoc `{...}` blob is a live
data-loss trap the moment a key name doesn't match.

**Proposed: a new collection, one document per key.**

```js
// models/AdminSetting.js
{
  key:         { type: String, required: true, unique: true, index: true },
  value:       { type: mongoose.Schema.Types.Mixed, default: null }, // null = unset, falls through
  valueType:   { type: String, enum: ['boolean','number','string','enum'], required: true },
  updatedAt:   { type: Date, default: Date.now },
  updatedBy:   { type: String, default: null } // email
}
```

One doc per key (not a single Map-valued field on one singleton doc) so
concurrent edits to different keys never contend on one document, and so a
per-key audit trail (§2.6) can reference `AdminSetting._id` cleanly. A Map
field would also work schema-wise (Map keys aren't subject to the strict-mode
undeclared-path trap, unlike bare object literals) but loses that
per-document concurrency and audit-linkage property for no benefit.

**The catalog is a separate, code-declared registry — not derived from
Mongo.** This is the actual answer to "how do we know what's editable, its
type, its default, whether it's money-flagged, and its description" — model
it directly on the existing `services/concurrency.js` `SPEC` pattern, which
already does exactly this for the concurrency knobs:

```js
// services/adminSettingsCatalog.js (new, generalizes concurrency.js's SPEC shape)
{
  AD_VISION_QC_STATIC_ENABLED: {
    envFallback: null,          // this one has no legacy env name; others may
    type: 'boolean',
    default: false,
    money: false,
    category: 'qc',
    description: 'Post-render vision QC for static image ads. Off ships uninspected.'
  },
  UNIFIED_VIDEO_9_16_MASTER: {
    envFallback: 'UNIFIED_VIDEO_9_16_MASTER',
    type: 'boolean',
    default: true,
    money: true,
    moneyNote: 'Off: a mixed Meta+PMax run mints 3 paid Omni masters ($2.70) instead of 2 ($1.80).',
    category: 'video',
    description: '...'
  },
  // ...
}
```

The catalog — not `config/defaults.env` — is what the admin UI, the
validator, and the export/import code all read. This also directly answers
a gap the env sweep surfaced: **`UNIFIED_VIDEO_9_16_MASTER` — one of the
four money flags named in the brief — does not exist in `config/defaults.env`
at all today** (confirmed: `grep` for it returns nothing; it's a pure
`process.env` read with a code-only default,
`campaignAdsGenerationService.js:526-527`). Several other money-relevant
flags are in the same state (`META_VIDEO_DERIVATIVES`,
`STATIC_MODERATION_SEED_FALLBACK`, `REGENERATE_DAILY_CAP`,
`ADS_PER_PRODUCT_CAP`, `MAX_ADS_PER_GENERATION_RUN`, `VEO_ADS_PER_PRODUCT_CAP`
— all confirmed via direct grep, none in `config/defaults.env`). A store that
only mirrors `defaults.env` would miss exactly the flags Nick cares most
about controlling. See Question 2.

### 2.3 Read path (resolver)

One function per key (or one generic resolver keyed by catalog entry),
mirroring `adVisionQcService.resolveEnabled()`'s existing shape exactly —
because that shape is already correct and already fixed the one production
bug this class of code has actually had:

```js
async function resolveSetting(key) {
  const entry = CATALOG[key]; // throws on unknown key — closes off typos silently no-oping
  const dbVal = await getAdminSettingCached(key);      // §2.4 cache
  if (dbVal !== null && dbVal !== undefined) return coerce(dbVal, entry.type);
  if (entry.envFallback && process.env[entry.envFallback] !== undefined) {
    return parseEnv(process.env[entry.envFallback], entry.type); // ONE shared parser, see §2.5
  }
  return entry.default;
}
```

Every new call site uses this **async** resolver. **No new synchronous
"peek" path, ever** — that is precisely the shape of the 2026-08-20
production bug (`peekAdVisionQcEnabled` returning `undefined` on a
merely-stale-not-actually-cold cache, 31 of 39 ads shipping "QC disabled"
while the DB said `true`). The fix that closed that bug
(`services/systemConfigService.js:peekAdVisionQcEnabled`'s doc comment,
`:100-135`) is exactly the caching contract to copy: a loaded value is
trusted until explicitly invalidated, never silently degraded to "unknown"
just because a TTL elapsed while a background refresh is in flight.

### 2.4 Propagation / caching across WEB and WORKER

WEB and WORKER are separate Render services / separate processes (confirmed:
both `index.js:1-5` and `worker.js:18-20` independently run
`require('dotenv').config()` then load `defaults.env`; there is no shared
in-memory state between them). Any cache is therefore inherently per-process.

Proposed contract, generalizing the QC flag's already-fixed design:
- Each key (or the whole catalog in one read, since it's small) is cached
  **per-process** with a short TTL (5s, matching the existing precedent).
- A value that has been loaded at least once is served from cache
  immediately and trusted, even past its TTL, while a background refresh
  is kicked off — **never** collapse a stale-but-loaded value to "unknown."
- The **writing** process (WEB, since that's where the admin API lives)
  write-throughs its own cache immediately on save — an admin who just
  flipped a toggle sees it take effect on their own next request with zero
  wait, same as `setAdVisionQcEnabled`'s existing write-through does today.
- Every **other** process (WORKER, and any other WEB instance under
  autoscale) sees the change within one TTL window (≤5s) via its own
  background refresh — never instantly, and that bound should be stated to
  Nick in the UI copy ("takes effect within ~5s on all services") rather
  than implied as instant.
- This is a deliberate, bounded staleness window, not a bug — the bug this
  design must not reintroduce is the *cache answering "unknown, fall back to
  a different default" when it actually has a slightly-stale real answer*.

### 2.5 Typed schema, validation, and the shared parser

Every boolean-typed key uses **one** shared parser end to end (closing the
`toLowerCase()==='true'` vs `!=='false'` vs `?? 'true'` inconsistency
documented across the existing flags in §1.2/Grok's sweep). Every catalog
entry declares `type` (`boolean` | `number` | `string` | `enum`) and, for
`number`, optional `min`/`max` (reusing the exact shape
`services/concurrency.js`'s `SPEC` already uses for
`RENDER_CONCURRENCY`/`VEO_CONCURRENCY`/etc. — that file is the right
precedent to generalize, not reinvent). Writes are rejected server-side on
type/range mismatch; the API never trusts client-side validation alone.

### 2.6 Money-flagged keys — confirmation + audit

Catalog entries carry `money: true` + a `moneyNote` (human-readable cost
consequence, as drafted in §2.2's example). The write endpoint:
- Requires the request body to echo back the money note or an explicit
  `confirmMoneyImpact: true` flag for any `money:true` key — same shape as
  the existing double-click "confirmable" pattern in
  `services/campaignAdsGenerationService.js`'s generation gate
  (`confirmable:true` / `confirmDuplicate:true`), which is already a proven
  in-repo UX for "you're about to do something costly, click again to mean
  it."
- Every write (money-flagged or not) is appended to an audit collection —
  `SettingChangeLog { key, oldValue, newValue, changedBy, changedAt,
  moneyFlagged }` — never overwritten, so "who turned this off and when" is
  always answerable. This is the audit trail Nick asked for and is cheap:
  one insert per write, no read-path cost.
- The settings UI shows a diff/preview (old → new) before the write commits,
  not just a bare save button, for every key — cheapest possible guard
  against a fat-fingered toggle.

### 2.7 Secrets — structurally excluded, not hidden

The catalog (§2.2) is a **closed, code-declared allowlist**. A key not in
the catalog literally cannot be read, written, exported, or imported through
this system — there is no "list all env vars and let the operator pick,"
which would eventually surface a secret by construction. Secrets are never
candidates for catalog entries in the first place, so there's no filter to
bypass. Concretely: the import endpoint validates every incoming key against
`CATALOG` and **rejects** (not silently drops) any key not present — an
attempted import of `MONGODB_URI` or `JWT_SECRET` fails the whole key with a
named error, and (per Question 9) either fails the whole import or just that
key depending on Nick's answer, but never silently accepts a secret-shaped
name.

As a second belt-and-braces layer (defense in depth, not the primary
control): reject any key at catalog-registration time that matches a
secret-shaped pattern (`_KEY$|_SECRET$|_TOKEN$|_URI$|PASSWORD`) unless
explicitly annotated `money:false, secretLike:false` by a human reviewer in
the source — this catches an accidental future catalog entry before it ships,
the same way `htmlValidationService`-style dead-path traps get caught by a
harness rather than a reviewer's memory.

### 2.8 Import / export

- **Export**: JSON array of `{key, value, valueType, updatedAt, updatedBy}`
  for every catalog key that currently has a DB override (keys still at
  their env/file/code default are omitted, or included with a
  `source:'default'` marker — Nick's call, not a design fork, defaulting to
  "include everything with its resolved value + source" since that's more
  useful for a support/debugging export).
- **Import**: see Question 9 for all-or-nothing vs per-key. Either way:
  every key is validated against the catalog and its declared type/range
  *before* any write happens, a diff preview is shown, and money-flagged
  keys require the same confirmation as a normal UI edit — import is not a
  bypass of §2.6.

---

## 3. Authorization model

Substantially revised from the first draft after (a) the orchestrator's
live production measurement that a super-admin (Nick) was locked out of the
app entirely, which is now a stated requirement, and (b) an xhigh-effort
Grok adversarial review of the first draft's admin-authz proposal, which
found several real holes in it. Both are folded in below rather than kept
as a separate appendix, because they change what the design actually says,
not just how it's justified.

### 3.1 Every read of `isSuperAdmin`, traced — what it actually controls today

Full grep, backend and frontend, both re-confirmed directly (not taken on
Grok's word):

**Backend (7 sites, all of them):**

| Site | What it does |
|---|---|
| `models/User.js:39` | Schema declaration, `Boolean`, `default: false`. |
| `index.js:109` | **The only write.** Login upsert `$set`s `isSuperAdmin: isSuperAdminEmail(email)` unconditionally, every Google login. |
| `index.js:123` | Copies the just-written value into the passport `done()` user shape (feeds the JWT mint next). |
| `middleware/requireAuth.js:118` | Read — gates whether `expandSuperAdminMemberships` runs (see §3.2). |
| `middleware/requireAuth.js:152` | Read — sets `req.user.isSuperAdmin` from the **fresh Mongo read**, for every downstream route handler. |
| `routes/auth.js:37` | Read — stamps the JWT claim. Documented explicitly as a UX hint; no server code reads it back for enforcement. |
| `routes/me.js:38` | Read — exposes it in the `/api/me` response body. **This, not the JWT, is what the frontend should treat as authoritative** (see §3.6). |

**Frontend (5 sites, all of them):**

| Site | What it does |
|---|---|
| `auth/types.ts:18`, `auth/jwt.ts:11` | Type declarations only. |
| `auth/AuthContext.tsx:88` | Populates `auth.user.isSuperAdmin` by **decoding the JWT** at hydration — never re-fetched from `/api/me` afterward. |
| `shell/Sidebar.tsx:69` | Reads `auth.user.isSuperAdmin` (from that JWT-decoded context) to filter `SECONDARY_NAV`'s `adminOnly` entries. |
| `routes.ts:45` | Comment describing the above; no logic. |

**So today, `isSuperAdmin`'s entire functional effect, precisely stated, is
narrower than the name suggests:**
1. Server-side: it decides whether `requireAuth` synthesizes an ephemeral
   `role:'owner'` membership for every *active* `Advertiser` the user isn't
   already a real member of (§3.2). That is the **only** place any route
   checks it for access control. No admin-only API exists yet.
2. Frontend: it decides which `SECONDARY_NAV` items render (nav hiding,
   explicitly documented in `routes.ts:45-49` as not itself a security
   boundary — the backend 403 is).
3. Sales Demos is gated by a **separate** allowlist
   (`SALES_DEMOS_ADMINS` / `isAllowedBootstrapper`,
   `services/salesDemosService.js:138-144`), not `isSuperAdmin` directly —
   except that a super-admin can reach it anyway via the synthetic
   membership + `X-Advertiser-Id`, without being on that list (Grok's
   review, finding 13 — a real inconsistency, addressed in §3.4).

### 3.2 `expandSuperAdminMemberships` — the bypass already exists; here is exactly what it does and what that costs

**Correction to my own earlier draft.** The orchestrator's first message
described a lockout requiring a new bypass; a follow-up correction
withdrew that — `requireAuth` already runs this expansion, and it already
prevents `NO_ADVERTISER` for any super-admin as long as at least one
`Advertiser` document exists with `status:'active'` (the schema default,
`models/Advertiser.js:36`). There is no lockout to fix and no bypass to
design. What follows is what the orchestrator asked for instead: the
existing behaviour documented precisely, and assessed as the security
surface it actually is — because it is a large one, directly relevant to a
screen that will expose money-facing flags and manage who else gets this
same power.

**Exactly what `expandSuperAdminMemberships` does
(`middleware/requireAuth.js:28-54`, called at `:118-120` for every request
where `user.isSuperAdmin === true`):**

```js
async function expandSuperAdminMemberships(userId, userEmail, realMemberships) {
  const advertisers = await Advertiser.find({ status: 'active' }).select('_id')
    .sort({ createdAt: 1 }).lean();
  const covered = new Set(realMemberships.map(m => String(m.advertiserId)));
  const synthetic = advertisers
    .filter(a => !covered.has(String(a._id)))
    .map(a => ({ _id: `super:${a._id}`, advertiserId: a._id, userId, email: userEmail,
                 role: 'owner', status: 'active', acceptedAt: new Date(0), __synthetic: true }));
  return [...realMemberships, ...synthetic];
}
```

- Runs on **every single authenticated request** from a super-admin — one
  fresh `Advertiser.find` per request, not cached, not throttled. At
  today's scale (2 Advertisers) this is negligible; noted because it is a
  per-request query that grows linearly with the Advertiser count and has
  no cache the way `SystemConfig`'s QC flag does.
- Grants **`role: 'owner'`** — the single highest tenant role, full control
  including inviting/removing other members, on **every** `Advertiser`
  whose `status` is `'active'` and where the user lacks a real membership
  row. `covered` is built only from `realMemberships` passed in, which by
  the time this runs is already filtered to `status:'active'` real rows
  (`requireAuth.js:82-85`) — so a real membership that is `revoked` or
  `pending` does **not** count as "covered," and that Advertiser gets a
  synthetic owner grant exactly as if the user had never had any
  relationship to it at all.
- **Not persisted, and the comment says so on purpose** ("synthesize
  ephemeral... Not persisted"). `acceptedAt` is hardcoded to the Unix
  epoch, `_id` is a non-ObjectId string (`super:<advertiserId>`), and
  `__synthetic: true` marks it in memory only. **This means there is
  structurally no record anywhere — no `AdvertiserMembership` row, no
  `invitedBy`/`invitedAt`, nothing in an audit log — of a super-admin
  having acted as owner of a given tenant.** An action taken by a
  super-admin via this path is indistinguishable, in the data, from one
  taken by that tenant's real owner. For a workspace's own audit trail
  ("who changed this campaign"), a synthetic-path action attributes
  correctly to the acting `userId` on whatever document it touches (Ads,
  Campaigns, etc. all stamp the real `req.user.userId`), but there is no
  record of *why* that user had access to that tenant at all.

**The blast radius this grants, concretely (Grok's review, finding 5,
independently arrived at and now folded in here as the assessment the
orchestrator asked for):** promoting someone to `isSuperAdmin` does not
grant "can see the admin settings screen" — it grants full owner-level
write access to every current and future Advertiser in the system, with no
per-tenant record of it, the moment they next make a request with the
right `X-Advertiser-Id`. Any UI that presents the coming Users tab's
promote toggle as a narrow "let this person open Settings" control would
be describing it wrong. The promote UI (§4.3) must say this in plain
language before a promote takes effect.

**What this means for the Users tab specifically — the interaction the
orchestrator flagged as the one that matters most:** because the expansion
is unconditional for `isSuperAdmin === true` and runs before the
`NO_ADVERTISER` check, **revoking a super-admin's `AdvertiserMembership` on
any tenant is a no-op** — the very next request re-grants them synthetic
`owner` on that same tenant, since it's no longer "covered" by a real,
active row. All three current production users are `isSuperAdmin: true`,
so today `/team`'s existing Revoke button is a no-op against every one of
them, on every workspace, right now — not a hypothetical the Users tab
introduces, a pre-existing gap it inherits and must not paper over.
**Design requirement: the Users tab (and, ideally, `/team`'s existing
member row — flagged as an adjacent fix, not mine to make, see Question
11) must not present a Revoke control that silently no-ops.** Concretely:
when the target of a revoke/role-change action has `isSuperAdmin === true`,
either (a) disable the control with an explanation ("platform super-admins
have owner access to every workspace regardless of membership rows —
revoke their super-admin status first"), or (b) let the action proceed but
surface a clear warning that it will have no effect until super-admin
status is cleared. Recommend (a) — it's the version that can't be missed.

**Audit-log question this raises, worth Nick's explicit call rather than a
silent default:** should an admin-relevant action taken via a *synthetic*
membership (i.e., `req.membership.__synthetic === true` at request time)
get its own audit-log line — "super-admin X wrote to advertiser Y via
synthetic ownership, no real membership existed" — separate from the
per-key `SettingChangeLog` (§2.6)? Scoped sensibly (state-changing requests
only, not every read, given this resolves on every request) this is cheap
and directly answers "who touched what, and how did they have access,"
which today is unanswerable for this path by construction. See Question
10.

### 3.3 The admin API surface — do not mount it on `requireAuth`

The first draft of this design proposed `requireAuth` + a new
`requireSuperAdmin` for `/api/admin/*`, on the reasoning that a super-admin's
synthetic membership makes any `X-Advertiser-Id` the frontend happens to
send resolve harmlessly. **The adversarial review found this is the wrong
boundary, and I agree — corrected:**

- `apiFetch.ts` always attaches `X-Advertiser-Id` when
  `localStorage.advertiser_id` is set, with no per-call opt-out. Mounting
  admin routes on `requireAuth` means every admin handler receives a
  **tenant** `req.advertiserId` — whichever workspace the SPA last had
  selected — as an ambient value sitting right there to be read by
  accident. `middleware/tenantHelpers.tenantFilter` throws if it's missing,
  but nothing stops a handler from just writing
  `AdminSetting.find({advertiserId: req.advertiserId})` or similar without
  going through that helper at all — a single habitual line silently scopes
  a platform-wide read or write to one tenant.
- **Corrected design: mount `/api/admin` on `requireUserOnly` +
  a new `requireSuperAdmin`**, e.g. `app.use('/api/admin',
  requireUserOnly, requireSuperAdmin, adminRoutes)` in `index.js`, the same
  place-level mounting style already used for `/api/members` etc.
  (`index.js:170`) — never a per-route middleware inside individual
  handlers, which this repo has already gotten wrong once (Sales Demos'
  `/bootstrap` sits *above* its own `router.use(requireSalesDemosScope)`,
  `routes/salesDemos.js:34-129` — a precedent for exactly the mistake to
  avoid here).
  - `requireUserOnly` verifies the JWT and loads the User doc, but requires
    no advertiser context at all (`middleware/requireUserOnly.js`) — the
    right auth layer for a platform-wide surface.
  - `requireSuperAdmin` (new, small): re-reads `isSuperAdmin` off the User
    doc `requireUserOnly` already loaded (`req.userDoc.isSuperAdmin`,
    avoiding a second Mongo round-trip) and 403s otherwise. It must never
    read `req.user.role` or anything tenant-shaped, and — per Grok's
    finding 7 — must never accept the claim from a JWT payload; a harness
    should assert its source contains neither `payload.isSuperAdmin` nor
    `decoded.isSuperAdmin`.
  - **`req.advertiserId` must never be read inside `/api/admin/*` handlers**
    — add a lint-level or harness-level check that fails if any file under
    the admin routes directory calls `tenantFilter` or reads
    `req.advertiserId`, so this doesn't regress the moment someone
    copy-pastes a tenant-scoped pattern into an admin route.
  - Every write to `User.isSuperAdmin` re-checks freshness immediately
    before writing (`findOneAndUpdate({_id, isSuperAdmin: <expected>},
    ...)`), closing the TOCTOU window between `requireSuperAdmin`'s read at
    request start and a concurrent demote landing mid-request (Grok finding
    7) — cheap, and the same shape `routes/members.js`'s own last-owner
    guard already uses for a similar race.
  - PATCH body validation is strict: `typeof isSuperAdmin === 'boolean'`
    only, `{ $set: { isSuperAdmin: parsed } }` — never
    `findByIdAndUpdate(id, req.body)` (the anti-pattern already present
    at `index.js:263-266` for an unrelated route; do not let it get copied
    onto `User`).

### 3.4 A single audited writer for `isSuperAdmin` — and the env-allowlist tradeoff

The design's original "union, promote-only" login rule
(`isSuperAdmin: isSuperAdminEmail(email) || existingUser.isSuperAdmin`) is
**directionally right but under-specified in a way that reopens exactly the
bug it exists to fix, and creates a new one** (Grok findings 1-3, both
High):

- **Implementation must be one atomic pipeline update, not read-then-OR in
  JS.** A `find → compute-in-JS → $set` shape races a concurrent
  admin-PATCH: whichever write lands second wins, silently undoing the
  other. Use a pipeline-form `findOneAndUpdate` so Mongo computes the OR
  server-side in the same atomic operation:
  ```js
  User.findOneAndUpdate(
    { googleId: profile.id },
    [{ $set: {
        email, displayName, photoUrl, lastLoginAt,
        isSuperAdmin: { $or: [isSuperAdminEmail(email), { $eq: ['$isSuperAdmin', true] }] }
      } }],
    { upsert: true, new: true }
  )
  ```
  (verify `$setOnInsert`-equivalent behavior for the insert arm before
  shipping — pipeline updates compose differently; needs its own check.)
- **"Promote-only" makes the env allowlist sticky for anyone it ever
  matched, which is a real revocation regression, not a hypothetical:**
  `SUPER_ADMIN_EMAILS` lives in the **committed** `config/defaults.env`
  (not a Render secret, per this repo's own §4a rule), so a merged PR or a
  temporary dashboard override that adds an email, one login, then a
  revert, leaves that `User.isSuperAdmin: true` forever — the Users tab
  cannot fully demote them, because their next login ORs it right back to
  true. **This is a genuine design fork Nick should decide, not something I
  should silently pick** — see Question 3.
- **One audited writer, used by both the login upsert and the admin
  route — not two call sites that can drift.** Today the only write is the
  login upsert; if the Users tab's PATCH becomes a second, independent
  write path, that's exactly the "two definitions of one guard" failure
  mode this repo has already hit once (per the orchestrator's framing).
  Concretely: `setUserSuperAdmin({userId, next, actor, reason})` — one
  function, both callers, always appends to the audit log (§2.6) before
  returning, login's `actor` recorded as `'system:login-allowlist'`.
  `systemConfigService.setAdVisionQcEnabled` has exactly this problem
  *already*, unaudited, today — call it out as a pre-existing gap the new
  audited-writer pattern should also close once the QC flags move onto the
  new store (§1.4), not a new one this design introduces.
- **Last-admin guard.** No such guard exists or was proposed; without one,
  two admins demoting each other concurrently (or a sole UI-only admin
  self-demoting after `SUPER_ADMIN_EMAILS` was emptied under the mistaken
  belief the DB "took over") is a full lockout. Demote should refuse when
  `countDocuments({isSuperAdmin: true, _id: {$ne: target}}) === 0`.
- **Google email is read without checking `email_verified`,** and
  `User.email` is indexed but **not unique** (`models/User.js:17`) — identity
  is `googleId`. Combined with a sticky promote-only rule, an allowlisted
  person changing their Google account email leaves the *old* User row
  permanently admin under a stale address while a fresh signup could later
  claim the vacated one. Low severity today (Google's OpenID endpoint
  generally only returns verified emails), but cheap to close: refuse login
  if `profile.emails[0].verified !== true` is available on the profile
  shape.

### 3.5 The queued `members.js`/`invitations.js` fix — shared guard contract

Per §0.1, the orchestrator owns implementing this; my job is to specify the
contract so it and anything of mine share one definition, not two.

```js
// middleware/requireMembershipRole.js
// Must run AFTER requireAuth (needs req.user.role, populated from the
// resolved active AdvertiserMembership — middleware/requireAuth.js:151).
function requireMembershipRole(allowedRoles) {
  return function (req, res, next) {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `requires one of: ${allowedRoles.join(', ')}`,
        code:  'INSUFFICIENT_ROLE'
      });
    }
    next();
  };
}
module.exports = requireMembershipRole;
```

Usage at the two known call sites: `router.patch('/:userId',
requireMembershipRole(['owner','admin']), ...)` in `routes/members.js`, and
similarly on `POST /api/invitations`. **Deliberately does not special-case
`isSuperAdmin`** — a super-admin already resolves to a synthetic
`role:'owner'` on any tenant they lack a real membership for
(`expandSuperAdminMemberships`), so `requireMembershipRole` passes for them
for free with zero extra code, exactly as intended. Where a super-admin
*does* hold a real, lower-privileged membership on their own home tenant,
respecting that real role there (rather than a blanket `isSuperAdmin`
bypass) is correct, not a bug — it matches the existing
`expandSuperAdminMemberships` comment ("real memberships kept as-is"). This
is also, per Grok's review, a **pattern this repo does not have anywhere
yet** ("No `requireRole` anywhere... that's the members.js bug") — so it is
new code either way, and worth landing once, shared.

### 3.6 Frontend guard — corrected to source from `/api/me`, not the JWT

The first draft proposed a new `RequireSuperAdmin` component gating render
(an improvement over the Sales Demos precedent of "page renders, backend
403s"), which stands. **Corrected per Grok finding 12:** it must read
`isSuperAdmin` from `/api/me`'s response (`routes/me.js:38`, DB-fresh on
every fetch), not from `AuthContext`'s JWT-decoded value
(`AuthContext.tsx:88`), which is only ever set once at login and does not
notice a same-session promotion or demotion for up to 24h. Concretely: the
guard should trigger (or the existing `useBrand`/`/api/me` hook, if one
already refetches periodically) a fresh `/api/me` read rather than trusting
`auth.user.isSuperAdmin` alone — small but load-bearing, since this is
exactly the surface a demotion needs to take effect on quickly.

### 3.7 Residual risks accepted for v1 — stated, not hidden

- **No true session revocation.** JWTs are stateless, 24h, unrevocable
  before expiry (§4.4 covers this for "reset password"). Grok's review adds
  a concrete aggravating factor: at least one route already round-trips a
  full bearer JWT through a **query string**
  (`GET /api/ads/:id/preview-page`, via `?_token=` copied into the
  `Authorization` header at `index.js:192-198`), and a separate 1h JWT is
  minted inline in `routes/ads.js:822-832` — both are the same bearer any
  `/api/admin` route will accept. A leaked preview URL (logs, proxies,
  `Referer`) is a live admin session until it expires, and demoting
  `isSuperAdmin` stops it from reaching `/api/admin` (fresh DB read) but
  cannot revoke it for ordinary tenant routes before expiry. Accepting this
  matches Question 4's proposed default; flagged here so it's a stated
  tradeoff, not a surprise.
- **Multiple admin levels, revisited given the corrected role-model facts
  (§4.1):** the tenant-level 4-role model (owner/admin/editor/viewer) +
  full invite lifecycle **already exists** — it is not something this
  design needs to build, only expose via the (separately-fixed)
  enforcement gap. The platform level stays a boolean (`isSuperAdmin`) for
  v1, same rationale as the first draft, now routed through one named
  predicate (`isPlatformAdmin(user)`) that should also replace the
  currently-inconsistent `isAllowedBootstrapper` OR (which checks
  `SALES_DEMOS_ADMINS` and *not* `isSuperAdmin` — Grok finding 13, a real,
  if minor, present-day inconsistency: a UI-promoted admin can reach Sales
  Demos via synthetic membership but cannot call its `/bootstrap` unless
  also env-listed).

---

## 4. Users tab

### 4.1 What already exists — direct answer to "is there another user-management screen"

**Yes, `/team` exists and is fully built** (`pages/Team/index.tsx`, 410
lines) — but it is **per-Advertiser team management**, a different concern
from what Nick is asking for:

- Manages `AdvertiserMembership` rows (role: owner/admin/editor/viewer)
  scoped to the *active workspace* — "Members can see every brand under the
  workspace" (page copy, `:237`). Backed by `/api/members` +
  `/api/invitations`, both already fully built (list, invite-by-link,
  role-change, revoke).
- Its own header comment claims "Backend enforces independently so a
  tampered UI still can't escalate" (`Team/index.tsx:12`) — **this claim is
  false today**, per the live finding in §0. Worth knowing because it means
  the comment gave false confidence to whoever wrote/reviewed it; not
  something to fix in this workstream.
- **No concept of `isSuperAdmin` anywhere in this file or anywhere under
  `pages/`** outside the nav-gating code already covered in §3.1. Workspace
  `admin` (the AdvertiserMembership role) and platform `isSuperAdmin` are
  unrelated axes today; the UI never conflates them.
- It cannot be extended to cover platform-wide admin users: it's hard-scoped
  to `useBrand()`'s active advertiser, sends `X-Advertiser-Id`, and its
  copy explicitly frames everything as "this workspace." A cross-tenant
  concern doesn't fit there without ripping out its scoping, which would
  break its actual job.

**The orchestrator's correction is worth stating plainly here, not just in
§3: the tenant-level "multiple admin levels" Nick anticipated as coming
already exist, in full.** `AdvertiserMembership` already has the four-role
enum (`owner|admin|editor|viewer`) and a complete invite lifecycle
(`pending → active → revoked`, invite tokens, `invitedBy`/`invitedAt`,
`acceptedAt`, `revokedBy`/`revokedAt`), and `/team` + `/api/members` +
`/api/invitations` already expose and operate all of it. **My job here is
to expose and enforce what already exists, not invent a new role model** —
the one real gap in that existing system is enforcement (the queued fix in
§0.1/§3.5), not the model itself or its UI. Prod scale today is 3 users, 2
Advertisers, 4 memberships — small enough that neither `/team` nor the new
Users tab needs any pagination design.

**`/settings` is a stub** (`pages/Settings/index.tsx`) — "Coming soon,"
header copy already claims future scope of "members, billing, API access"
(the "members" half of that claim is already stale — `/team` shipped that).
Currently hosts only `<DeleteAccountSection />`. No tabs, no API calls
besides the delete-account flow.

**Recommendation: build a new, separate surface. Do not extend `/team` and
do not bolt onto `/settings`.** `/team` is correctly and completely scoped
to per-tenant collaboration; conflating "who can access this workspace" with
"who can access the platform's admin controls" would be a real modeling
error, not just an inconvenience — it's the same category of mistake as
mixing `AdvertiserMembership.role` with `User.isSuperAdmin` at the code
level, which the codebase has so far correctly kept apart. `/settings` is a
near-empty stub with no established pattern to inherit and — being
per-Advertiser-scoped in its own header copy — is the wrong tenant boundary
for a cross-tenant concern like admin-user management anyway. New route(s),
per §5.

### 4.2 What the Users tab actually manages

**Not** `AdvertiserMembership` roles (that's `/team`'s job, already built).
The Users tab manages **`User.isSuperAdmin`** — i.e., it is the UI for
exactly what `SUPER_ADMIN_EMAILS` does today, moved from an env-only
allowlist into something an admin can operate without a deploy:

- **List all Users** — `User.find()` across every Advertiser (this is
  necessarily cross-tenant; no existing endpoint does this today, `/api/members`
  is Advertiser-scoped). Show email, name, last login, current
  `isSuperAdmin` state, which Advertiser(s) they belong to (for context).
  Trivial at today's scale (3 users) — no pagination needed, per above.
- **Promote / demote** (`PATCH` toggling `isSuperAdmin`) — the "add admin
  users" ask. **Demote is not a bare toggle** — per §3.2, demoting a user
  who currently holds real or synthetic ownership on other tenants does
  not touch those; and per §3.2/§3.4, demoting someone still matched by
  `SUPER_ADMIN_EMAILS` will not stick past their next login. Both must be
  surfaced in the UI at the moment of the action, not discovered after.
  The promote confirmation must also state the real blast radius (§3.2):
  owner-level access to every current and future workspace, not "can open
  Settings."
- **Invite** — see §4.5; today's "invite" (AdvertiserMembership token flow)
  is about joining a workspace, not becoming a platform admin — a
  different action, doesn't need a token/link flow of its own.
- **"Reset password"** — see §4.4; needs reinterpretation given OAuth-only
  auth.
- **Revoke, on the *existing* `/team` page, needs a correctness fix this
  design surfaces but does not itself ship** — see §3.2's "Design
  requirement" paragraph: revoking a super-admin's membership there is
  silently a no-op today, for all three current users. Flagged as Question
  11, since it's a fix to a page outside this workstream's stated scope
  but directly caused by the same mechanism this design documents.

### 4.3 The `SUPER_ADMIN_EMAILS` login-time write — see §3.4

Superseded by the fuller, corrected treatment in §3.4 (single audited
writer, the atomic-pipeline fix for the promote-only race, and the
env-allowlist-stickiness tradeoff Grok's review surfaced) — not repeated
here to avoid two versions drifting. The short version: the naive "OR the
two booleans in JS" fix a first draft of this doc proposed is unsafe
(re-opens a lost-update race) and incomplete (makes the env allowlist
permanently sticky for anyone it ever matched, which the Users tab cannot
fully undo). §3.4 has the corrected version and Question 3 has the
resulting design fork for Nick.

### 4.4 "Reset passwords" — there are no passwords, by design

Auth is Google OAuth only; the brief is explicit that adding a scripted
login or token-minting route is a security decision to respect, not a gap to
close. Confirmed independently: no password field anywhere on `User`, no
session/token store, no `tokenVersion`/blacklist concept in
`requireAuth.js`/`requireUserOnly.js` — JWTs are bare stateless bearer
tokens with a 24h expiry (`routes/auth.js:31-36`) and **cannot be revoked
before they expire**. So today, the honest answer to "kick this person out
right now" is **"you can't, fully, for up to 24h."**

What "reset password" should actually mean here, in order of how directly
each maps to the ask:
1. **Revoke platform-admin status** (`isSuperAdmin → false`) — takes effect
   immediately server-side per §3.1 (no caching layer on this path), but a
   JWT already issued still carries the *old* claim for up to 24h — harmless
   for authz (server always re-checks the DB), but the UX hint on their own
   frontend nav would lag until their token expires or they re-auth.
2. **Revoke Advertiser access** — already exists, `/team`'s revoke button
   (`DELETE /api/members/:userId`), unrelated to platform admin but often
   what "kick this person out" really means for a given workspace.
3. **Force sign-out everywhere, immediately** — genuinely does not exist
   today and would need new work: a `User.tokenVersion` counter,
   incremented on demand, checked by `requireAuth`/`requireUserOnly`
   alongside the existing JWT verification (reject if the token's stamped
   version — added to the JWT payload at mint time — doesn't match the
   current DB value). This is a real, if small, addition, not a rename of
   something existing. **Made more concrete by §3.7**: a bearer JWT already
   travels in a query string on at least one live route
   (`?_token=` → `Authorization`, `index.js:192-198`), so a leaked preview
   URL is a live, unrevocable session for up to 24h/1h depending on which
   token — the same class of exposure "reset password" is usually asked
   for to close. See Question 4.

### 4.5 "Invite users" for platform admin

Distinct from `/team`'s invite (which mints an `AdvertiserMembership` for a
workspace). A platform-admin invite doesn't need a token/accept flow at
all if the invitee already has (or will create) any User row via normal
Google sign-in — "inviting" someone to be a platform admin is really just
promoting a User by email, which may not exist yet as a row. Recommend
supporting promote-by-email even for a User row that doesn't exist yet
(store the intent, apply `isSuperAdmin: true` on their first login-time
upsert) so "invite" doesn't require its own token/link flow duplicating
`/team`'s — this is simpler than it might sound because the login upsert
already exists as the one place `isSuperAdmin` gets written. **Guardrail
from §3.4/Grok's review, load-bearing:** this pending-promote-by-email
write must go through the *same* single audited writer as every other
`isSuperAdmin` change (§3.4) — and given `User.email` is not unique
(`models/User.js:17`, identity is `googleId`), a promote-by-email that
resolves to the wrong or a not-yet-existing row needs the same
duplicate-account edge case (§3.4's `email_verified` point) considered
before shipping, not after. Do not build this ahead of §3.4's writer.

---

## 5. Frontend shape

- **New nav entry**: `SECONDARY_NAV` gains one `adminOnly: true` entry (same
  filter mechanism `/sales-demos` already uses — no new nav infra).
- **Route shape**: Nick's own wording — "an admin settings screen...
  containing all env variables... include a Users tab" — reads as one
  screen with tabs, not two separate top-level nav items. There is no
  existing `/admin` prefix precedent (confirmed: every current route is a
  flat kebab path off the root — `/settings`, `/team`, `/sales-demos`), but
  a single new nested layout is a small, clean addition, not a fight
  against convention. Recommend a small `AdminShell` wrapping two child
  routes under one parent, `/admin/settings` and `/admin/users`, rendered as
  Chakra `Tabs` (following `pages/CampaignDetail/index.tsx:474-506`'s
  existing enclosed-tabs pattern — the one page-level Tabs precedent in the
  app) so each tab is deep-linkable and gets its own URL. See Question 7 for
  the alternative (two flat top-level nav items instead of tabs).
- **Unscoped API calls**: `apiFetch`'s `authHeaders()` (`apiFetch.ts:24-33`)
  always attaches `X-Advertiser-Id` when `localStorage.advertiser_id` is
  set, with no per-call opt-out (`.set()` overwrites anything the caller
  passes). Per §3.2, this is fine — a super-admin has a synthetic membership
  for every Advertiser, so `requireAuth` never 403s them regardless of which
  advertiser happens to be active client-side. No frontend change needed
  for this reason alone.

---

## 6. Verified vs. Assumed

**Verified by direct file read (not just Grok's word) — the load-bearing facts:**
- The QC gate's precedence, cache-bug history, and money-invariant asymmetry
  (`adVisionQcService.js`, `systemConfigService.js` in full).
- All named QC call sites, including that `adRegenerateService.js` reaches
  the gate only indirectly (via `renderDirectImage`), not by calling
  `resolveEnabled()` itself.
- The video-titling-without-QC hole, both locations, by reading the actual
  `catch` branches in `routes/ads.js`.
- `User`/`AdvertiserMembership`/`requireAuth`/`requireUserOnly`/`Advertiser`
  schemas and logic in full, including the live privilege-escalation bug
  (§0.1) and that `requireAuth` reads `isSuperAdmin` fresh from Mongo every
  request (no cache on that path).
- `expandSuperAdminMemberships` (`middleware/requireAuth.js:28-54`) read and
  quoted in full for §3.2 — its unconditional-per-request re-grant, the
  non-persistence, and the resulting no-op-revoke interaction were my own
  read of this function, independently confirmed by the orchestrator's
  separate correction to my first draft (which had wrongly assumed no
  bypass existed at all — see the note below).
- The `index.js` login-upsert's unconditional `$set` of `isSuperAdmin` from
  `SUPER_ADMIN_EMAILS` (§3.4's conflict analysis is derived from reading
  this code, not assumed).
- `routes/members.js`, `routes/invitations.js`, `routes/me.js`,
  `routes/salesDemos.js`, `services/superAdminService.js` in full — and,
  specifically, the partial unique index on `AdvertiserMembership`
  (`advertiserId`+`userId`, `userId: {$type:'objectId'}`) that makes a
  revoked-but-kept row block self-heal's re-create, per the orchestrator's
  correction to my own initial (wrong) reading of that interaction — noted
  in §0.2 as a correction, not a re-derivation I could have caught alone
  from a first pass.
- Frontend: `Team/index.tsx`, `Settings/index.tsx`,
  `DeleteAccountSection.tsx`, `routes.ts`, `Sidebar.tsx`, `App.tsx`,
  `AuthContext.tsx`, `auth/types.ts` — read directly, not only via Grok.
- `services/concurrency.js`'s `SPEC` pattern, used as the direct model for
  the proposed settings catalog.
- `docs/PIPELINES.md` §9 and `config/defaults.env`'s full key list (208
  keys, via direct grep) cross-checked against Grok's independent scan.
- `font-vision`, `moderationSeedFallback`, `htmlValidationService` — each
  read directly to confirm Grok's "not a QC gate" verdict rather than
  trusting it blind.

**Verified via Grok's read-only sweep, not independently re-read line-by-line
by me** (medium confidence, but Grok's specific file:line citations were
spot-checked and matched on every candidate I did re-verify, so I have no
reason to doubt the rest):
- The exhaustive list of ~30 other boolean env-gated flags in §1.2/Task E
  (I re-verified the four named candidates myself; I did not personally
  re-read all thirty).
- The full money-facing-flags-beyond-the-five table (§ "Additional
  money-facing flags").
- `App.tsx`'s exact line numbers for each route and the `RequireAuth`
  component boundaries (I read the file myself and confirm these match).

**Corrected mid-session — recorded so the false version doesn't resurface:**
- My first draft treated "a super-admin gets `403 NO_ADVERTISER`" as an
  established requirement and designed a `requireAuth` bypass against it.
  The orchestrator corrected this: `expandSuperAdminMemberships` already
  runs before that check and already prevents it (§3.2). The actual gap
  behind the original report was in `scripts/mintTestToken.js` (an offline
  test-token minter with its own, simpler membership lookup that does not
  implement the super-admin expansion) — a harness gap, not an auth gap. I
  have not read that script myself to confirm; taking the orchestrator's
  live-verified correction as authoritative rather than re-deriving it,
  since they have production access this worktree does not.
- Separately, my first report of the self-heal/`User.advertiserId`
  interaction concluded a revoke "silently undoes itself" in the main
  case. The orchestrator corrected this too, citing the exact lines
  (`routes/members.js:124-127`) and index shape that make the main case
  safe (§0.2). Both corrections are folded into the current text, not left
  as a dangling first-draft claim anywhere else in this doc.

**Explicitly unresolved / needs a live check, not resolvable from docs
alone:**
- **WEB Render service secret count disagrees between two sources I was
  given**: the brief states 24; `docs/PIPELINES.md:1699` (the file's own
  canonical inventory) states 23. Neither is something I can resolve without
  live Render dashboard access. Does not block this design (the discrepancy
  is one key either way, not a structural issue), but should be checked
  before anyone treats either number as gospel in an implementation PR.
- **`META_WEBHOOK_VERIFY_TOKEN`** (`routes/integrations.js:353`, per Grok) —
  a real secret used in production that is in neither `config/defaults.env`
  nor the `docs/PIPELINES.md` §9 Render-secrets table. I have not personally
  confirmed this beyond Grok's citation. If real, it's a pre-existing docs
  gap, not something this design needs to fix, but the settings-catalog
  build should double check it never gets treated as a candidate key.
- **`CLAUDE_API_KEY`** on the "Liquid Retail" env group — per Grok, not
  referenced anywhere in the codebase (dead credential). Not independently
  re-verified by me; not load-bearing for this design either way.

---

## 7. Questions for Nick

Recommended option listed first for each.

1. **Settings-store precedence.** Recommend: DB override (when set) wins
   over Render dashboard env, which wins over `config/defaults.env`, which
   wins over the code default — i.e., generalize the QC flag's existing
   rule to every managed key, even though it's the *opposite* of how
   `defaults.env`-vs-env already works today for everything else. Confirm
   this is the rule you want, since it changes "how do I get back to
   whatever's on Render" into "explicitly clear the DB override," not just
   "delete a setting."

2. **Catalog scope for v1.** Recommend a **curated allowlist** (the money
   flags you named plus the QC gates plus a short list of other feature
   toggles — on the order of 20-40 keys), not a mirror of every key in
   `config/defaults.env` (208 keys today, most of them low-value tuning
   knobs like `YOLO_MAX_INPUT_WIDTH`). Note this also means adding several
   keys to the catalog that don't exist in `defaults.env` at all today
   (`UNIFIED_VIDEO_9_16_MASTER` among them — confirmed absent) — those need
   a declared default captured from the current code fallback, not copied
   from a file that doesn't have them. Confirm curated-allowlist-first, and
   say if there's a specific set of keys beyond the ones already named in
   the brief that you want in v1.

3. **The promote-UI blast radius, and the env-allowlist stickiness
   tradeoff.** Two related forks, both surfaced by the adversarial review
   (§3.2, §3.4), not by me first: (a) promoting someone via the Users tab
   grants owner-level access to **every** current and future workspace,
   not "can open Settings" (§3.2) — the confirmation copy must say this
   plainly; recommend requiring an explicit acknowledgement of that
   sentence, not just a checkbox. (b) Making DB-side promotion durable
   (so the Users tab's promotions don't get silently reverted by the next
   login) requires the env allowlist to become **promote-only** — which
   means anyone who is ever added to `SUPER_ADMIN_EMAILS`, even briefly,
   stays a super-admin until someone finds them on the Users tab **and**
   removes them from the env list; UI-only demotion cannot fully undo an
   env-listed promotion (§3.4). Recommend accepting (a) as unavoidable
   given what the flag already means, and accepting (b) as the tradeoff
   for the env list still working as a break-glass bootstrap — but this is
   a real security-vs-convenience fork, not one to pick silently. This
   note is unrelated to who currently qualifies: all three production
   users are already `isSuperAdmin: true` today (your own measurement), so
   there's no separate "who becomes admin at cutover" question left open.

4. **Session revocation ("reset password").** Since there are no passwords
   and JWTs can't be revoked before their 24h expiry today, revoking a
   user's access (admin or otherwise) takes effect on the server
   immediately but that user's *already-issued token* keeps working for up
   to 24h. Recommend: accept that bound for v1 (it matches how the rest of
   the app already behaves) rather than building a `tokenVersion`
   revocation mechanism now. If "kick someone out right now, no 24h tail" is
   actually a hard requirement, say so — it's a real but small addition
   (one new field + one check in two middleware files), just not something
   to build silently as a side effect of this UI.

5. **QC-gate migration default.** Recommend seeding both new gates
   (`staticVisionQcEnabled`, `videoVisionQcEnabled`) to `true` at cutover,
   preserving today's production behavior exactly (both are currently
   protected by the one `true` flag). Confirm, or say if you want a
   different starting state for either.

6. **The video-titling-QC-skip hole (§1.5).** A paid video master that fails
   specifically at the titling step ships with no QC verdict at all,
   regardless of any gate — pre-existing, not caused by this work, but
   directly adjacent to the two functions this split touches. Recommend
   fixing it in the same change (it's a small, low-risk addition: call the
   same disabled/skipped-verdict builder the sibling branch already uses).
   Say if you'd rather this be a separate, explicitly-scoped follow-up
   instead.

7. **Admin page shape.** Recommend one nav entry ("Admin") leading to a
   single page with two tabs — Settings and Users — as separate deep-linkable
   routes (`/admin/settings`, `/admin/users`) under one small layout
   component, matching your "include a Users tab" wording literally.
   Alternative: two independent top-level secondary-nav entries instead of
   tabs (simpler routing, less discoverable as "one admin area"). Confirm
   tabs, or say you'd rather have two flat nav items.

8. **Future admin levels — narrower than originally framed.** The
   four-level tenant model (owner/admin/editor/viewer) plus full invite
   lifecycle you anticipated already exists and is already fully built
   (`AdvertiserMembership`, `/team`) — confirmed by your own read of the
   schema, not something this design needed to add. What's still boolean
   is the orthogonal *platform* axis (`isSuperAdmin`). Recommend keeping
   that boolean for v1 — it already exists, already works — routed through
   one named predicate (`isPlatformAdmin(user)`) so a future platform role
   enum only touches that function plus the Users tab's UI. Confirm this
   narrower framing matches what you meant by "multiple admin levels are
   coming," or say if you had a third axis in mind beyond these two.

9. **Import behavior.** Recommend **per-key** apply-what-validates rather
   than all-or-nothing: an import with one bad/unknown key applies every
   other valid key and reports the one rejection by name, rather than
   discarding an otherwise-good import over a single typo. Confirm, or say
   you'd rather an import be atomic (all keys valid or nothing is written).

10. **Audit logging for actions taken via a synthetic membership.** Per
    §3.2, a super-admin acting as owner of a tenant they have no real
    membership in leaves **no record anywhere** of how they had access —
    today's data can't distinguish that from the tenant's real owner
    acting. Recommend adding one audit-log line per **state-changing**
    request made this way (not every read, since the expansion resolves on
    every request and a per-read log would flood) — cheap, and directly
    answers "who touched this and how did they get in" for a screen that
    will otherwise make granting that power easy. Confirm you want this in
    v1, or say it's acceptable to leave for later.

11. **`/team`'s existing Revoke button silently no-ops for any
    `isSuperAdmin` user, for all three current users, today** — not
    something this workstream introduced, but directly caused by the
    mechanism §3.2 documents, and it sits on a page outside this design's
    stated scope (`/team`, which the brief said not to extend). Recommend
    fixing it in the same pass as the Users tab ships, since the fix is
    small (disable/relabel that one control when the target is a
    super-admin) and shipping a Users tab that can create more
    super-admins while leaving a known-broken Revoke control unlabeled
    elsewhere in the product is the kind of gap that gets found in
    production rather than review. Say if you'd rather this stay a
    separate, explicitly-scoped follow-up instead.
