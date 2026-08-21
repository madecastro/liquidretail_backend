I'll audit the remaining pages from the real SPA, backend, and harness—no edits, no subagents. First I'll read the session handoff, page inventory, and the source for each route.Inventory is a starting map, not evidence. Next I’ll read the harness suites, selector lint, routes, and the real page sources.Harness visits many of these routes with thin selectors. Next I’ll read journeys plus the page and onboarding source so coverage vs. real UI is based on code.I need how the pages suite actually asserts, then the real page sources—especially onboarding/brand, team, and settings.The onboarding/brand failure is confirmed in results.json. Next I’ll read eligibility, team/settings APIs, and the remaining page surfaces.# Remaining-pages coverage audit

**Scope.** `/home`, `/brand`, `/integrations`, `/catalog`, `/detect`, `/media-library`, `/render-activity`, `/team`, `/settings`, `/upload`, `/onboarding/*`. No files were edited. Claims below are **VERIFIED** against source (path:line) or the last harness run (`ui-smoke/artifacts/results.json`, 2026-08-21). **INFERENCE** is labelled.

**How the harness actually works (this area).** `suites/pages.js` is the only suite that visits these routes. `run.js` does `goto → expectText(selectors) → expectNoConsoleErrors → expectNoFailedRequests` (`run.js:257-307`). Empty `selectors: []` still counts as a **pass** of two health checks. `suites/journeys.js` does not walk any of these routes (its journeys are Product Ads / wizard / campaigns / ads). Free-tier denylist in `journeys.js:31-48` also forbids clicking `Delete Account`, `Create`, `New brand`, `Sync now`, `Refresh` (brief), so even a future journey cannot exercise most danger-zone / invite-submit / brand-save paths without an explicit `allow`.

**Coverage grades used here.**
- **COVERS** — an assertion that would fail if that *page-specific* UI were gone, and it is not also in the chrome.
- **VISITS** — the route is loaded; health checks and/or chrome-colliding strings fire. “Rendered without console error” is **not** coverage.
- **DOES NOT COVER** — interactive control, modal, empty/error/conditional branch with no assertion and no click.

---

## Special: `/onboarding/brand` → “STEP 1 OF 3 — WORKSPACE”

**Verdict: this is a defect for an already-onboarded operator, not correct guard behaviour.** The BrandPage *intent* is a real guard; the *predicate it uses is the wrong one*, and the live harness caught it.

**What BrandPage is supposed to do (VERIFIED).** Deep-links are documented as valid in two states: signed-in + has Advertiser → stay on the form; signed-in + no Advertiser → bounce (`BrandPage.tsx:49-66`):

```49:66:liquidretail/frontend/app/src/pages/Onboarding/BrandPage.tsx
  // Defensive bounces. Deep-links here are valid in two states:
  //   - signed in + already has Advertiser → continue to the form
  //   - signed in + NO advertiser → bounce back to workspace-create
  // ...
        if (!elig.hasAdvertiser) {
          navigate(elig.canSelfCreate ? '/onboarding/workspace' : '/onboarding', { replace: true });
        }
```

If eligibility said `hasAdvertiser: true`, the form would stay and render `Step 2 of 3 — Brand` (`BrandPage.tsx:142`). There is **no** bounce for “already has brands.”

**What eligibility actually computes (VERIFIED).** `GET /api/onboarding/eligibility` uses the Phase-1 field on the User doc, **not** `AdvertiserMembership`:

```149:160:liquidretail_backend/routes/onboarding.js
router.get('/eligibility', requireUserOnly, async (req, res) => {
  try {
    const hasAdvertiser = !!req.userDoc.advertiserId;
    const domainAllowed = isEmailDomainAllowed(req.userDoc.email);
    res.json({
      email:           req.userDoc.email,
      hasAdvertiser,
      canSelfCreate:   !hasAdvertiser && domainAllowed,
```

`requireAuth` (every in-app API) resolves the workspace from **memberships**, and only 403s `NO_ADVERTISER` when memberships.length === 0 (`requireAuth.js:53-90`). Self-heal is one-way: User.advertiserId → create a missing membership (`requireAuth.js:64-83`). There is **no** reverse heal (membership exists → write User.advertiserId).

**Live evidence the two predicates disagreed on the smoke user (VERIFIED).** Same run, same token:

| Route | Result |
|---|---|
| `/team`, `/brand`, `/home`, `/settings` | **pass** (memberships exist; PipelineShell loaded) |
| `/onboarding/brand` | **fail** — actual innerText: `STEP 1 OF 3 — WORKSPACE` / `Name your workspace` / `Workspace name*` (`results.json:487-550`) |

That Workspace copy is `WorkspacePage.tsx:154-164`. BrandPage only navigates there when `!elig.hasAdvertiser && elig.canSelfCreate`. So for this user, eligibility returned `hasAdvertiser: false` **while** `/api/members` and `/api/brand/:id` succeeded.

**INFERENCE.** The smoke-test user’s `User.advertiserId` is unset (invite-joined, seeded, or membership-only), while `AdvertiserMembership` rows exist. Invite accept *does* set `userDoc.advertiserId` if it was null (`invitations.js:192-198`); that path is not the only way a membership can exist.

**Follow-on defect if they hit Continue on that Workspace form (VERIFIED).** `POST /api/onboarding/advertiser` also gates only on `req.userDoc.advertiserId` (`onboarding.js:48-54`). A member without that field can create a **second Advertiser**. Last-owner / team design work sitting on top of this will see a phantom extra workspace.

**What *is* correct guard behaviour.** A user with **zero** memberships deep-linking `/onboarding/brand` *should* bounce to step 1. That is the comment at `BrandPage.tsx:49-52`. The smoke user is not that user.

**Asymmetry (VERIFIED, product-intent).**
- `/onboarding` + `/onboarding/workspace`: `hasAdvertiser` → `/brand` (`Onboarding/index.tsx:46`, `WorkspacePage.tsx:60`).
- `/onboarding/brand`: `hasAdvertiser` → **stay and offer another brand**.
- `/onboarding/connect`: no eligibility check at all beyond unauthenticated → `/landing` (`ConnectPage.tsx:100-107`). Fully onboarded users can re-enter step 3; live run **passed** `Step 3 of 3 — Connect` (`results.json:555-563`).

---

## `/team` — what it already does, what is asserted

**Purpose (VERIFIED).** Workspace-wide (not per-brand) member + invite-link management. Header copy: “Members can see every brand under the workspace; per-brand restrictions land later.” (`Team/index.tsx:4-8, 234-237`). No email send; copy-link only (`Team/index.tsx:1-3, 289-291`). Invite accept is a **separate** public route `/invite/:token` (`App.tsx:100`, `Invite/index.tsx`).

**Role model in the UI (VERIFIED).**
- `canManage = resolvedRole === 'owner' || resolvedRole === 'admin'` (`Team/index.tsx:89`).
- Role resolution: exact membership by `activeAdvertiserId` → single-membership shortcut → JWT `auth.user.role` (`Team/index.tsx:63-84`). `resolutionInFlight` suppresses the “unknown” banner during BrandContext hydration (`Team/index.tsx:76, 240`).
- Editor/viewer: orange banner, no invite form (`Team/index.tsx:240-247`).
- Invite Select options: admin / editor / viewer — **not owner** (`Team/index.tsx:273-276`). Matches backend `VALID_ROLES` (`invitations.js:21, 34-40`).
- Self row: role is a Badge, never a Select; never a revoke icon (`Team/index.tsx:372-397`).
- Pending invitations card only mounts if `invitations.length > 0` (`Team/index.tsx:297`).
- Empty members: `No active members yet.` (`Team/index.tsx:356`) — rare; current user is always a member if the list loaded.

**Interactive elements (VERIFIED).**

| Control | Gate | Backend |
|---|---|---|
| Email input + Role select + `Create invite link` | `canManage`; button disabled when email blank (`278-287`) | `POST /api/invitations` |
| Client toast `Enter a valid email` | no `@` (`145-150`) | never sent |
| `Copy link` on pending row | always if pending exist | clipboard only |
| Revoke invitation `✕` (`aria-label="Revoke invitation"`) | `canManage` + `window.confirm` (`216-217, 325-334`) | `DELETE /api/invitations/:id` |
| Member role `<Select>` | `canManage && !m.isYou` (`372-379`) | `PATCH /api/members/:userId` |
| Revoke member `✕` (`aria-label="Revoke member"`) | same + `window.confirm` (`200-201, 386-395`) | `DELETE /api/members/:userId` |

**Backend does *not* match the UI comment (VERIFIED — money/auth-critical for the settings design).** `Team/index.tsx:10-12` says “Backend enforces independently so a tampered UI still can't escalate.” `routes/members.js` and `routes/invitations.js` are mounted under `requireAuth` only (`index.js:158-162`). The only extra guards are last-owner 409s (`members.js:72-85, 109-121`) and “already a member” 409 (`invitations.js:44-54`). **Any authenticated member (editor/viewer) can POST invites, PATCH roles (including to owner), and DELETE members via API.** Last-owner copy is `cannot demote the only owner — promote someone else first` (`members.js:81`), not the shorter string in the inventory.

**States (VERIFIED).**
- Loading: `Loading…` spinner (`351-352`).
- Error: raw `error` string in red (`353-354`) — `apiJson` message only (`apiFetch.ts:114-126`).
- Read-only banner vs invite form: mutually exclusive on `canManage` once hydration finishes.

**Harness (VERIFIED).** `pages.js:281-287` selectors: `Team`, `Invite a teammate`, three role option strings. Last run: **pass** 7 (`results.json:388-397` = 5 selectors + 2 health). Journeys: none. Forbidden clicks would block Create/Delete anyway.

| What | Grade |
|---|---|
| Invite form is visible for an owner/admin | **COVERS** (`Invite a teammate` + role option literals) |
| Title `Team` | **VISITS** — also `SECONDARY_NAV` (`routes.ts:52`) and PageHeader |
| Submit invite, clipboard, pending list, revoke, role change, last-owner toast, `window.confirm` | **DOES NOT COVER** |
| Editor/viewer banner | **DOES NOT COVER** (this fixture is canManage; if it were not, `Invite a teammate` would fail — the suite is accidentally owner-only) |
| `/invite/:token` preview / mismatch / Accept | **DOES NOT COVER** (route not in `pages.js`) |
| API role enforcement | **DOES NOT COVER** (and currently does not exist) |

**Silent failure class (VERIFIED).** `setMembers(m.members || [])` / `setInvitations(i.invitations || [])` (`Team/index.tsx:112-113`). A 200 with a missing `members` field (unchecked `apiJson<T>` cast, `apiFetch.ts:126`) renders `No active members yet.` with **no error**.

---

## `/settings` — what it already does, what is asserted

**Purpose (VERIFIED).** Stub + self-serve delete. Page itself (`Settings/index.tsx:11-38`):
- PageHeader eyebrow `Workspace`, title `Settings`, description promising “members, billing, API access, and cross-brand integration management.”
- Card: `Coming soon` / `Workspace settings rebuild is on the backlog.` / “Per-brand settings live on the Brand page…”
- Then `DeleteAccountSection`.

**There is no workspace rename, billing, API keys, or member UI here.** WorkspacePage still tells the user they can “rename it later in Settings” (`WorkspacePage.tsx:158-159`) — that path does not exist. Member management already lives on `/team`.

**Delete Account (VERIFIED, `DeleteAccountSection.tsx`).**
- Closed: Danger Zone card + `Delete Account` button (`64-77`).
- Open: `GET /api/me/deletion-preview` (`105`). Loading `Calculating impact…` (`154`). Error box (`155-158`).
- `canSubmit = preview.canDelete && typed email matches auth.user.email (trim, case-insensitive) && !busy` (`115-116`).
- Sole-owner blocker: `You're the sole owner of {n} workspace(s) with other members.` (`161-178`); type-email **hidden** when `!canDelete` (`224`).
- Cascade list / revoke list / empty “You're not currently a member of any workspaces.” (`182-222`).
- Confirm button label `Delete account` (lowercase a) vs opener `Delete Account` (`246` vs `76`).
- Modal `onClose` no-op while `busy` (`147`). Success: toast then `setTimeout(() => auth.signOut(), 500)` (`134`).
- `DELETE /api/me { confirmEmail }` (`122-126`); backend re-checks email (`me.js:111-117`) and `SOLE_OWNER_BLOCKED` → 409 (`me.js:123-128`).

**Harness (VERIFIED).** `pages.js:306-313`: `Settings`, `Coming soon`, backlog sentence, `Danger Zone`, `Delete your account`, `Delete Account`. Last run **pass** 8. Modal never opened. Journeys denylist includes `Delete Account` (`journeys.js:40`).

| What | Grade |
|---|---|
| Stub copy + closed Danger Zone | **COVERS** (page-specific strings; `Settings` alone would be chrome) |
| Modal, preview, blocker, type-email, disabled submit, busy no-close | **DOES NOT COVER** |
| Actual DELETE | **DOES NOT COVER** (and must not be, on prod DB) |

**Silent class.** Preview fields (`canDelete`, `blockers`, arrays) come through `apiJson<Preview>` with no runtime check. Missing `canDelete` → `canSubmit` false forever with no error if `preview` is truthy (`115-116`). Missing arrays skip whole sections (`182, 199, 218`).

---

## Per-route inventory + coverage

### `/home`

**Interactive (VERIFIED, `Home/index.tsx` + `agent/AgentChat.tsx` + `ChatInput.tsx` + `ConfirmationCard.tsx`).** Page is chat-only. `TokenDebugCard.tsx` is dead (defined, never imported — grep of `src/` would be needed; inventory claim matches file comment and no import in `Home/index.tsx:1-30`).

- Heading: `Ask about ${brandName}` vs `Ask the operator agent` (`AgentChat.tsx:78`).
- `New chat` only if `chat.turns.length > 0` (`80-84`).
- Empty state vs `MessageList` (`88-91`). Empty copy + 4 suggestion buttons from `getDefaultSuggestions` (`38-45, 134-163`).
- `ConfirmationCard` when `pendingActions.length > 0` (`94-106`): Cancel / Confirm (or `Run plan`); tier-3 phrase input.
- Error banner `chat.error && !chat.streaming` (`109-113`).
- `ChatInput`: textarea, Enter-to-send, `aria-label="Send"` / `aria-label="Stop"` (`ChatInput.tsx:70-94`). Send disabled until trimmed text (`41, 91`). Footer disclaimer (`AgentChat.tsx:127`).
- POST `/api/agent/chat` via raw `fetch`, not `apiFetch` (inventory; not re-opened here).

**States.** Always interactive on mount (no load gate). Empty is the default. Streaming flips Send→Stop. No-brand vs branded copy.

**Harness.** `selectors: []` (`pages.js:45`). Last run **pass 2** = health only (`results.json:208-217`).

| Grade | |
|---|---|
| VISITS | route + no console/network errors |
| DOES NOT COVER | suggestions, send, stop, new chat, confirmation cards, error banner, no-brand copy, streaming abort |

**Silent.** Agent response fields are untyped at runtime. A missing tool-call field can drop a confirmation card with no error.

---

### `/brand`

**Shell states (VERIFIED, `Brand/index.tsx:145-161`).** `Loading brand…` / `Failed to load brand: {error}` / `No active brand. Pick one from the sidebar…`. Healthy: breadcrumb `Advertisers › {name}`.

**Resume-onboarding banner** only if `localStorage.onboarding_resume_to` (`57-65, 168-196`): `You're mid-onboarding`, `Dismiss`, `Resume onboarding →`. Auto-dismiss poll every 5s on meta/google ads `status==='active'` (`72-91`). Post-OAuth query params toast + auto-open picker via ref (`113-138`).

**Cards / controls (VERIFIED by file, not every handler line).** This is the largest mutation surface in the area.

- **Header** (`Header.tsx:141-178`): `Generate Ads`, `Refresh AI` (POST refresh-enrichment), `Edit Brand` / `Cancel Edit`; website + tagline inputs in edit mode.
- **OnboardingStatusPanel**: poll + dismiss `aria-label="Dismiss"`.
- **IntegrationsCard** (`IntegrationsCard.tsx:278-377`): heading `Integrations`; disabled `Connect New Source`; tiles Instagram / Meta Ads / Google Ads / TikTok Shop (`Coming soon`); per-tile `Connect` / `Manage` / `Finish setup` / `Disconnect` (`window.confirm`) / Instagram `Re-scan` (`window.confirm`, billable); `Sync Now`; `Auto-sync is ON|OFF`. Modals: `IGPickerModal`, `AdsPickerModal`, `GoogleAdsPickerModal`.
- **AutomationEngineCard**: three immediate-persist Switches (auto-reply / auto-create / auto-sync) (`AutomationEngineCard.tsx:1-10, 175`).
- **BrandSafetyCard**: `Adjust Brand Safety` modal, category select, topics add/remove, Save.
- **VideoModelCard** / **StaticImagePipelineCard**: Select + Save.
- **BrandVoiceCard** / **DerivedVoiceCard** / **BrandReviewsCard**: tag add/remove, refresh/clear derived voice, refresh reviews.
- **VisualIdentityCard**: colors, theme generate/save/clear.
- **PreviewCard**: prev/next layout (`aria-label`).
- **AudiencePersonasCard**: add/remove personas.
- **MetaCascadesCard**: doc/literal sources, reorder, save.
- **TitleStudioCard**: embedded titling editor.
- **StyleOverridesCard**: file exists; import + render **commented out** (`Brand/index.tsx:35-38, 223-228`). Do not expect it.
- **DangerZone**: `Delete this brand` / `Delete Brand` → type-name modal → `DELETE /api/brand/:id` (`DangerZone.tsx:36-47, 60-75, 108-136`).
- **SaveBar**: only if `isEditing \|\| dirty \|\| saving` (`SaveBar.tsx:21`); `Unsaved changes` / `Saving…` / `All changes saved` / Cancel / `Save Changes` (disabled unless dirty).

Fetch: `GET /api/brand/:id` (`useBrandDetail.ts:29`). Each card fires its own PATCHes.

**Harness.** Single selector `"Integrations"` (`pages.js:60-61`). Last run **pass 3**.

| Grade | |
|---|---|
| VISITS | `"Integrations"` is also primary nav (`routes.ts:28`) **and** the card heading (`IntegrationsCard.tsx:282`). If the brand failed to load, the sidebar still contains `Integrations` → **vacuous**. |
| DOES NOT COVER | every card, edit/save, OAuth, pickers, danger zone, resume banner, null-brand / error / loading |

---

### `/integrations`

**VERIFIED (`Integrations/index.tsx`).** PageHeader eyebrow `Integrations`, title `Connected integrations`. Loading `Loading brand…`. Error = raw `useBrandDetail` string. Cards only if `brand` (`48-53`). **No** `No active brand` fallback (unlike `/brand:153-160`). `integrationsRef` unused (`24-28`) — OAuth auto-picker does **not** run here.

**Harness.** `Integrations`, `Connected integrations` (`pages.js:79-81`). Last run **pass 4**.

| Grade | |
|---|---|
| COVERS | title `Connected integrations` (page-specific) |
| VISITS | `Integrations` (nav + eyebrow + card heading) |
| DOES NOT COVER | tiles, Connect/Disconnect/Re-scan/Sync, Meta cascades, null-brand blank body, pickers |

---

### `/catalog`

**VERIFIED.** 3-pane. Sidebar (`Sidebar.tsx:69-123`): search, native source Select (`All sources` / `Meta Catalog` / `Manual` / `Detect-identified` / `Drafts only`), category Select, `Show all variants`. Empty: `No catalog products match.` (`131-132`). `Load more`. Center: `No product selected` / `Loading…` / `Loading product…` / `Could not load product` (`CatalogBrowser/index.tsx:78-110`). Auto-select first row into `?productId=` (`38-42`). Right tabs: Summary / Reviews / Specs / Sellers / Matches (`RightSidebar.tsx:38-43`); empty Summary: `Select a product to see its summary.` (`59`). BottomBar: `Add to Campaign` + `Generate Ads →` only with a product (`BottomBar.tsx:16-65`). Header: `View on site`; kebab `aria-label="More"` has **no onClick** (`Header.tsx:59`) — dead control. Default query `draft=0` unless source=`draft` (`hooks.ts:46-51`). `inStock`/`hasReviews` exist on the hook type (`hooks.ts:14-15`) but **no UI** binds them.

**Silent (VERIFIED).** `useCatalogList` sets `error` (`hooks.ts:68-70`); `CatalogBrowser/index.tsx` never passes `list.error` anywhere. A failed list fetch looks like empty catalog.

**Harness.** `No product selected`, `Meta Catalog`, `Manual`, `Detect-identified`, `Drafts only` (`pages.js:201-207`). Last run **pass 7**. j1 on `/product-ads` in the same run had real products (`results.json:33-43`), so auto-select *should* replace `No product selected`. That selector therefore either raced the loading frame or the catalog was empty for a tick — it does **not** prove the inspector loaded.

| Grade | |
|---|---|
| VISITS | source-option strings (native `<option>` text is in `document.body.innerText` even when unselected) + loading-frame `No product selected` |
| DOES NOT COVER | search, filters, row select, tabs, gallery alts, Add to Campaign, Generate Ads, `Load more`, error-as-empty, draft source semantics, variants |

---

### `/detect`

**VERIFIED (`DetectReview/index.tsx`).** Header + `Drafts only` Switch (default on, `76`) + `Open Product Catalog →`. Fetch: `source=detect-identified&showVariants=1&limit=100` + `draft=1` when toggled (`85-97`). Empty drafts: `No drafts to review` / `You're all caught up.` Empty all: `No detect-identified products yet` (`198-210`). Row: badges, 7 inputs, `Save edits`, `Save & add to catalog` (only if `row.draft`, disabled if title blank, `299-309`). Link `aria-label="Open source media"` (`266`). PATCH `/api/catalog/:id`; graduate sets `draft:false` (`131`). `res.product` used without a null check (`141-146`) — missing field → throw, not blank.

**Harness.** `Detect Review`, `Drafts only`, `Open Product Catalog →`, `Detect-identified`, `Draft` (`pages.js:224-229`). Last run **pass 7** → this brand had at least one draft row (those two badges only render on cards, `254-255`). Empty-state copy is **not** asserted.

| Grade | |
|---|---|
| COVERS | header, toggle label, catalog CTA; **incidental** presence of a draft row |
| DOES NOT COVER | Switch off, save, graduate, empty both modes, error card, title-disabled graduate, source-media link |

---

### `/media-library`

**VERIFIED.** 3-pane. Sidebar empty `No media yet for this brand.` (`Sidebar.tsx:50-51`). Center empty `No media selected` (`index.tsx:126-129`). Auto-select first `?mediaId=` (`34-38`). FilterChips: Products/People/Text/Safe zones/Density/Crops/Palette (`FilterChips.tsx` + `types.ts LAYER_LABELS`); default all of products/people/text/safe-zones/density on (`index.tsx:51-53`). Canvas, AspectRatioStrip. Right tabs: Summary / Insights / Objects / Crops / Text / Layout / Palette (`RightSidebar.tsx:33-39`). BottomBar: `Delete` (`window.confirm`, `index.tsx:74`), disabled `Request Rights`, `AddToCampaignMenu`, `Generate Ads →` (`BottomBar.tsx:43-57`). List fetch **no `brandId` query**; brand from `X-Brand-Id` header + `brand:change` (`hooks.ts:24-52`). `list.error` is **not rendered** (same silent-empty as catalog). Add-to-campaign list fetch failure → `setCampaigns([])` with no toast (`AddToCampaignMenu.tsx:54`).

**Harness.** `selectors: []` (`pages.js:245`). Last run **pass 2**.

| Grade | |
|---|---|
| VISITS | health only |
| DOES NOT COVER | everything: empty, select, layers, tabs, crops, delete confirm, add-to-campaign, generate, error-as-empty |

---

### `/render-activity`

**VERIFIED (`RenderActivity/index.tsx`).** Adaptive poll 4s/20s (`44-45, 118-123`). 30s load timeout (`52, 150-157`). Filters always in DOM: status Select, `runId` Input, `Apply`, `Clear` (if applied), limit 50/100/200, `Stalled` toggle (`312-384`). `Refresh` / `Copy all` in PageHeader (`244-265`). States: brand hydrating spinner (`405-408`); `No brand selected` (`411-429`); load spinner; error `Couldn't load render activity` + `Retry` (`438-461`); empty `No render activity` / `No matching assets` / `No stalled assets` (`464-490`); rows with expand + per-row Copy (`RenderActivityRow.tsx:29-41, 56-62`). Stalled callout + `Clear stalled filter` (`269-305`). `stalledOnly` is **page-scoped** (`176-177`). Copy-all reads only key-matched envelope (`200-204`).

**Harness.** `Render Activity`, `Refresh`, `Copy all`, `Apply` (`pages.js:261-266`). Last run **pass 6**. Does not wait for the envelope (the #13 class: a spinner with zero requests would still have those four strings).

| Grade | |
|---|---|
| COVERS | chrome of the board (title + those four controls exist even with no data) |
| DOES NOT COVER | poll actually firing, timeout path, stalled filter, status/runId, row expand/copy, three empty variants, no-brand, Retry |

---

### `/upload`

**VERIFIED.** `PlaceholderPage` (`Upload.tsx:4-12`, `PlaceholderPage.tsx:17-50`): `Step 2 / 4`, `Upload Assets`, `Coming soon`, `Upload page rebuild — Phase 5`, `Open the legacy page →` href `/upload.html` (leaves the SPA). No fetch.

**Harness.** Those five strings (`pages.js:429-435`). Last run **pass 7**. **COVERS** the placeholder (assertions can fail if copy changes). **DOES NOT COVER** real upload (there is none; wizard empty-state `Upload media` is a different route).

---

### `/onboarding`

**VERIFIED (`Onboarding/index.tsx`).** Outside PipelineShell (`App.tsx:91`). Loading `Checking your account…`. `hasAdvertiser` → `/brand` (`46`). `canSelfCreate` → Create workspace. Else Request access mailto. Eligibility catch **silently** becomes `canSelfCreate: false, reason: 'domain_not_allowed'` (`47-50`) — a blip looks like “contact admin”, no Retry.

**Harness.** `"Sign out"` only (`pages.js:446-448`). Last run **pass 3**. `Sign out` also lives in the app shell (`Sidebar.tsx:91`). Redirect-to-`/brand` still passes.

| Grade | VISITS (vacuous). DOES NOT COVER both eligibility branches, silent-fail-as-blocked, race redirect. |

### `/onboarding/workspace`

**VERIFIED.** Loading `Checking session…` / `Checking eligibility…`. Unauth: own `Sign in to continue` card (`WorkspacePage.tsx:99-110`) — distinct from `RequireAuth` (`App.tsx:133-150`). Domain block: `Self-serve isn't open for your account yet`. Error: `Something went wrong` + `Retry`. Form: `Step 1 of 3 — Workspace`, `Workspace name`, Continue disabled until trimmed name + `canSelfCreate` (`68-69, 184`). `hasAdvertiser` → `/brand` (`60`). POST → `/onboarding/brand` (`83`).

**Harness.** `"Sign out"` only. Last run **pass 3**. For *this* user (eligibility `hasAdvertiser: false`) the form **is** showing; the suite still does not assert `Step 1 of 3`. For a user with User.advertiserId set it would redirect to `/brand` and still pass.

### `/onboarding/connect`

**VERIFIED.** Loading `Loading integrations…`. Error + Retry (`225-232`). Three sections Catalog / Social / Ad Accounts; Skip; skip warning strips; ProviderRows; GMC `Coming soon` disabled (`286-291`). IG satisfies catalog **and** social (`185-186`). `Finish setup` disabled until `allDecided`; tooltip `Connect or skip every section to continue.` (`331-346`). POST `dispatch-syncs` then `/home` (`190-210`). `additionalBrandMode` changes header + yellow banner (`183, 239-269`). OAuth bounce auto-opens pickers (`113-151`). Status fetch treats failure as empty creds, not page error (`85-88`) — a 500 can look like “not connected.”

**Harness.** `Step 3 of 3 — Connect`, `Plug in your data sources`, `Catalog`, `Social` (`pages.js:499-504`). Last run **pass 6**. **COVERS** default (non-additionalBrand) headings. **DOES NOT COVER** Skip, Connect, Finish enablement, additionalBrandMode, pickers, GMC disabled, IG dual-satisfy, dispatch.

---

## Vacuous / cannot-fail assertions

These are the ones that **cannot fail on a healthy chrome even when the page body is wrong**:

1. **`/home` and `/media-library` empty selector lists** (`pages.js:45, 245`) — only `expectNoConsoleErrors` + `expectNoFailedRequests`. A blank chat or empty media pane with no JS exception **passes**. Health checks themselves are not vacuous (they can fail); they are not functional coverage.
2. **`/brand` `"Integrations"`** — primary nav (`routes.ts:28`) + card heading. Survives `Failed to load brand` / `No active brand`.
3. **`/onboarding` and `/onboarding/workspace` `"Sign out"`** — present on the onboarding cards *and* on every in-shell page (`Sidebar.tsx:91`). Cannot detect the BrandPage bounce, the Workspace form, or the `/brand` redirect.
4. **`/catalog` `"No product selected"`** — the pre-auto-select center (`CatalogBrowser/index.tsx:104`). On a brand that has products (same run’s Product Ads journey passed), this matches a **loading frame**, not the inspector. Combined with native `<option>` strings (`Meta Catalog` etc.) that are in `innerText` whether or not a product is selected.
5. **`/team` `"Team"`** — `SECONDARY_NAV` (`routes.ts:52`). Mitigated by the other four selectors (those *can* fail for an editor).
6. **Not vacuous:** `/settings` backlog sentence + `Delete Account`; `/upload` placeholder strings; `/onboarding/brand` four selectors (they **did** fail); `/onboarding/connect` step-3 heading; `/detect` row badges (they fail on empty — brittle, not vacuous); console/network health.

`expectNoConsoleErrors` / `expectNoFailedRequests` (`assert.js:267-315`) **can** fail. Do not treat them as the coverage for forms.

---

## Gap ranking (owner-visible × silent)

| Rank | Gap | Reaches owner? | Silent? | Why |
|---|---|---|---|---|
| 1 | Eligibility uses `User.advertiserId`, requireAuth uses memberships — `/onboarding/brand` bounces a real member to Workspace; Continue can mint a second Advertiser | **Yes — live fail in the last run** | **Yes** until they notice the wrong step (no error toast) | `onboarding.js:151` vs `requireAuth.js:53-90`; POST advertiser `onboarding.js:48-54` |
| 2 | Members/invitations APIs have **no role gate** | **Yes**, the moment an editor uses DevTools or a stale client | **Yes** at the UI (controls hidden); API succeeds | `members.js` / `invitations.js` vs comment `Team/index.tsx:10-12` |
| 3 | `/team` and `/settings` are the substrate for the admin-settings design, and **no journey clicks them** | **Yes** — invite/revoke/role/delete are the feature | Role-change failure is toasted; missing `members` array is **silent empty** | `Team/index.tsx:112-113`; settings modal never opened |
| 4 | Catalog + Media list **errors render as empty** | **Yes** (“catalog is empty”) | **Yes** | `hooks.ts` error unused in both `index.tsx` files |
| 5 | `/brand` is the real settings/integrations/danger surface; harness asserts one chrome-colliding word | **Yes** — SaveBar, Sync Now, Re-scan (billable), Delete Brand | Many fields via `apiJson` + conditional cards (logo/colors/voice fill in async) | `Brand/index.tsx` + `IntegrationsCard.tsx` |
| 6 | `/home` agent is the post-login default (`App.tsx:119`) with **zero** functional asserts | **Yes** — this is the landing | Confirmation cards / tool args untyped | `Home/index.tsx`, `AgentChat.tsx` |
| 7 | `/onboarding` eligibility network failure → “self-serve closed” | **Yes** for a new signup | **Yes** (no Retry) | `Onboarding/index.tsx:47-50` |
| 8 | `/media-library` Delete + `/brand` Delete Brand + `/settings` Delete Account untested (correctly denylisted for spend/prod-db, but then **no** safe dry-run of the modal) | Delete Account modal is the only way to *see* sole-owner blocker before a real delete | Preview fields untyped | `DeleteAccountSection.tsx:105-116` |
| 9 | ConnectPage status 500 → “Not connected” | **Yes** during onboarding | **Yes** | `ConnectPage.tsx:85-88` |
| 10 | Detect / catalog / media interactions (save, graduate, layers, add-to-campaign) | Operator daily path | Catalog `apiJson` blanks | no journeys |

---

## Assertion sketches (selector-lint-able literals)

Lint accepts a string that exists in `frontend/app/src` at `origin/master` (`selector-lint.js:140-142`). Prefer page-unique copy, not nav labels. Journeys must still `allow` denylisted clicks; do **not** click real Delete/Create on staging.

**1. `/onboarding/brand` guard (highest).** After `goto('/onboarding/brand')`, wait, then:

- If `/api/me` has `memberships.length > 0`: `expectUrl(/\/onboarding\/brand/)` **and** `expectText('Step 2 of 3 — Brand')` **and** `expectText('Tell us about your brand')`. Today this **fails** — that is the product bug, not a test bug.
- If memberships are empty and `canSelfCreate`: `expectUrl(/\/onboarding\/workspace/)` **and** `expectText('Step 1 of 3 — Workspace')`. That is the legitimate guard.
- Replace `/onboarding` + `/onboarding/workspace` `"Sign out"` with those step eyebrows so a `/brand` redirect cannot pass.

**2. `/team` (admin-settings substrate).** Keep `Invite a teammate`. Add (all in `Team/index.tsx`):

- `Create invite link` (286)
- `Active members` (349) — heading always mounts
- `teammate@example.com` is a **placeholder**; `hasText` uses innerText, **placeholders do not match**. Need `dynamic` only if you read the value; better: click Create with empty field is disabled — assert `Create invite link` exists and (via evaluate) `disabled` when input empty.
- After typing a non-email and clicking: toast `Enter a valid email` (148).
- `expectText('You')` on the self badge (366).
- Do **not** click `Create invite link` with a real email (writes a membership). Do **not** click revoke (`window.confirm` + DELETE).
- Separate fixture (editor JWT): `Only owners and admins can invite, change roles, or revoke access.` (244) **and** `expectNoText('Invite a teammate')`.
- Last-owner: no safe staging click; if you stub PATCH 409, toast description is `cannot demote the only owner — promote someone else first` (`members.js:81`).
- **No stable hook** on the invite submit (no `data-testid`; only visible text). Revoke icon **has** `aria-label="Revoke member"` / `"Revoke invitation"` (`Team/index.tsx:328, 389`) — journeys click by **visible first line**, so those aria-labels are **not** used unless you add an evaluate.

**3. `/settings` Danger Zone modal (do not confirm).** `mustClick('Delete Account')` then:

- `Delete your account?` (150)
- `Calculating impact…` while preview loads (154)
- then either sole-owner sentence **or** `Type your email` (229)
- Footer `Delete account` should be `aria-disabled`/`disabled` until the email matches
- `Cancel` to close without DELETE
- Journeys must pass `allow: 'Delete Account'` **and** never click the modal confirm

**4. `/home`.** `One chat, everything you need for` (`AgentChat.tsx:139` — brand interpolates after; lint: this prefix exists). Plus `The agent can inspect, edit, and orchestrate` (127). Send control: no visible “Send”; `aria-label="Send"` (`ChatInput.tsx:86`) — **selector-lint will not help a CSS/aria selector; `hasText('Send')` will not match.** Flag: **no stable visible-text hook** on Send/Stop. Suggestion buttons are runtime (`What's worth my attention on ${subject} today?`) — mark `{ dynamic: true }` or assert the static `Show me the most recent 5 ads` (`AgentChat.tsx:42`).

**5. Catalog loaded inspector, not the loading frame.** Wait until `No product selected` is **gone** (or skip if `No catalog products match.`), then `expectText('Summary')` + `expectText('Reviews')` + `expectText('Matches')` (`RightSidebar.tsx:38-43`) + `Add to Campaign` (`AddToCampaignMenu.tsx:46`). Empty: `No catalog products match.` (`Sidebar.tsx:131`). **Do not** use `No product selected` as a success signal.

**6. Media library.** `Uploaded Media` (`Sidebar.tsx:40`) and either `No media yet for this brand.` or `No media selected` / `Generate Ads →`. Layer chips: labels in `LAYER_LABELS` (`types.ts:295`). Delete is denylisted.

**7. `/brand` non-vacuous load.** `Advertisers` breadcrumb (`Brand/index.tsx:252`) + `Delete this brand` (`DangerZone.tsx:39`) + `Edit Brand` (`Header.tsx:176`). Those are absent on the error/empty cards. Do not use `Integrations` alone.

**8. Render-activity actually loaded.** After goto, wait until `Couldn't load render activity` **or** `No render activity` **or** `Status · stage · meta` (`index.tsx:443, 478, 510`). Assert a matching `GET /api/ads/render-activity` fired (the #13 regression). `Refresh` / `Copy all` / `Apply` alone do not prove the poll ran.

---

## Elements with no stable hook (`data-testid` absent; journeys match visible first line)

Almost none of these pages use `data-testid`. Icon-only / aria-only controls the current clicker **will miss**:

| Control | Hook today |
|---|---|
| Chat Send / Stop | `aria-label` only (`ChatInput.tsx:74, 86`) |
| Team / invitation revoke | `aria-label`, visible `✕` (`Team/index.tsx:328-333, 389-394`) |
| Detect source-media link | `aria-label="Open source media"` + 🔗 (`DetectReview/index.tsx:266`) |
| Catalog/Media kebab `More` | aria-label; catalog kebab has **no handler** (`CatalogBrowser/Header.tsx:59`) |
| Meta cascade reorder/remove | `aria-label="move up|down|remove"` |
| Visual identity color picker / clear | aria-labels |
| OnboardingStatusPanel dismiss | `aria-label="Dismiss"` |
| Native `<select>` role/source/status | option text is in innerText; no test id |

---

## What `/team` + `/settings` already give the admin-settings design

**Already shipped on `/team`:** invite-by-link (not email), roles admin/editor/viewer (not invite-as-owner), copy link, revoke invite, change role, revoke member, last-owner 409, self-row frozen, editor/viewer read-only **UI**, workspace-scoped membership (every brand). Accept UX is `/invite/:token` (unauth preview, email match, mismatch banner, Accept → `/home`).

**Already shipped on `/settings`:** nothing for members/billing/API. Copy still claims those will live here (`Settings/index.tsx:17`). Danger Zone is **user** deletion (cascade vs revoke), not workspace settings.

**Not shipped, needed before building on top:**
- Backend `owner|admin` gate on `POST/PATCH/DELETE` members + invitations (UI-only today).
- Eligibility/`hasAdvertiser` aligned with memberships (or onboarding will keep dumping members onto Workspace create).
- Tests that distinguish owner vs editor vs viewer, and that open the delete-account modal without confirming.
- Decision: members stay on `/team` vs move to `/settings` — the stub description and Team header currently contradict each other.

---

**INFERENCE (not required for the ranking):** the last `pages` run’s `/onboarding/brand` failure is the same class as the four projection-allowlist bugs — a field the SPA treats as “has a workspace” is missing on the object the onboarding API actually reads, so the UI takes a perfectly smooth wrong branch with no exception.
