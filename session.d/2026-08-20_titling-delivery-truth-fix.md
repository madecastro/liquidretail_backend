# "Delivered" now means titled — and the crash loop that was stranding masters is named

Branch `fix/titling-delivery-truth`, PR #278, open, not self-merged. Started from an
owner report: ads were shipping
"delivered" carrying a raw, untitled Omni master — no headline, CTA, rating, quote, or
logo — and nothing in the system could tell them apart from a finished ad.

## Measured evidence (run `run_1787266578461_70865bdd`, Pelagic Gear "Marco Polo Lured",
## 39 ordered)

Queried live via a read-only Render one-off job (`render jobs create` on the web
service, `MONGODB_URI` already in its env — no local DB credentials handled). At
23:52:35Z: 39/39 ads accounted for — 15 statics clean, 3 correctly failed, 14 videos
genuinely `renderStage:'done'` with `renderUrl !== veoVideoUrl` (proof something
composited), and **8 videos still `titlingResumeState:'claimed'`**, ages 11-15
minutes, `renderStage` frozen mid-flight (`'titling 9:16'`, `'titling 4:5'`,
`'titling 1:1'`, `'face-safe crop skipped (not-transformable-url)'`). The owner's
original snapshot (13 stuck, 16/39 honestly delivered vs 29/39 reported) was taken
earlier in this same run's life; by the time I queried, the sweeper had already
worked several of the original 13 through to a genuine `'done'` — it is not
permanently stuck in the literal sense, but see below for why it kept re-stranding a
tail of ads faster than it could clear them.

## The caveat was right to raise, and the answer is: BOTH, and they're connected

The task brief warned the owner was mid-deploy (three deploys 23:02:50/23:04:10/
23:08:45, a "triple SIGTERM" at 23:05:09) and asked me to separate genuine defects
from process-churn artifacts before touching anything.

**It is not just deploy churn — it is a live, still-firing crash loop, and I found
the likely trigger.** Pulling `render logs -r srv-d1vuktqli9vc73ft07ng` across
23:00-23:52Z shows `🚀 Server running` / `🛑 SIGTERM received` pairs recurring roughly
every 1-9 minutes **all the way through 23:51:58** — 43 minutes after the last actual
code deploy. That is Render's autoscaler (confirmed via `render services`:
`autoscaling.enabled:true`, `memory.percentage:60`, `max:3` on this `pro_plus`
service), not a deploy, replacing the instance. `config/defaults.env`'s own comment on
`REMOTION_QUEUE_CONCURRENCY` says the failure mode explicitly: *"RSS exhaustion →
Render autoscale → process replacement → a PAID Omni master stranded mid-titling"* —
and that knob was raised **4→8 today**, same day, as part of PR #274
(`40821675`), explicitly **unvalidated** ("16 was floated first but rejected... this
process has actually survived [only] 4... must be validated against the web-service
memory graph on a full run before going further"). This 39-ad run, heavy with
video, is plausibly the first full run to really exercise that raise. I am not
reverting #274 here — it was an explicit owner-approved change and the owner is
watching this run — but it is the leading hypothesis for *why* titling kept getting
interrupted tonight, and it deserves a memory-graph check before the next big video
batch. Flagging this clearly rather than quietly fixing/reverting it myself.

**Two separate, real gaps, not phantoms:**

1. **`titlingResumeService` has a working stale-claim reclaim (15 min) but zero
   operator-facing signal**, and depends entirely on *something* eventually re-
   sweeping. Under a recurring crash loop, an unlucky ad can cycle claim → abandoned
   → reclaimed → abandoned again faster than it can finish. Not "no recovery" — the
   design (PR #184, `6eda3816`) is sound and demonstrably making progress (measured
   ads reaching real `'done'` state during this investigation) — but "no failure
   signal" was exactly true: nothing has ever alerted on an ad stuck with an open
   titling debt. session.md itself flagged this as a known, deliberately-deferred gap
   before there was live proof it bites.
2. **"Delivered" was defined as `renderUrl` non-null + `status:'draft'`, everywhere**,
   which is true from the instant a paid master lands — before titling even starts.
   Confirmed via Grok CLI trace (`~/.grok/bin/grok -m grok-4.6 --effort high
   --sandbox read-only`) across the whole repo; full site inventory below.

## The fix

**New `services/adTitlingTruth.js`** — the one function (`isVideoTitlingSettled` /
`isAdHonestlyDelivered`) that tells a genuinely-composited video apart from a raw
master parked on `renderUrl`. Settled iff: `titlingResumeState` is not
pending/claimed, AND either `renderUrl !== veoVideoUrl` (proof of a real composite)
OR `renderStage` starts with the exact `"no titling ("` prefix every intentional
bare-master-ship call site in this repo already uses (grepped, not guessed — three
call sites, all consistent). Always `true` for a static image (no titling step).

Wired into every place Grok's trace found actually asserting delivery:

- **`services/campaignRunGuards.js` `classifyRunAdOutcome`** (the run rollup) — a
  `draft`/`live`/`archived` video ad now only counts `succeeded` if titling actually
  settled; otherwise it's a new `titlingIncomplete` bucket, and `isSettled` is false
  while any exist — the SAME deferral posture as a receipt-holding `'rendering'` ad
  (real, already-billed work still outstanding; don't finalize the run dishonestly).
  This is the exact heuristic PR #272 (`9fb14705`, landed *today*) had just
  re-institutionalized while fixing the OTHER half of the same class of bug
  (stale-`'running'` reconciliation) — so the run-rollup fix for today's incident had
  to land in the same function that shipped today, not a different one.
- **`worker.js`'s reconciliation call site** — the `Ad.find(...).select('status')`
  feeding `classifyRunAdOutcome` was missing `kind`/`renderUrl`/`veoVideoUrl`/
  `titlingResumeState`/`renderStage` entirely. An unselected `kind` reads
  `undefined !== 'video'`, so the whole check above would have silently no-op'd —
  every ad treated as a static, `titlingIncomplete` always 0. Fixed; pinned by
  harness check `W1`.
- **`routes/ads.js` `projectAd`** — now emits `titlingResumeState` (raw) and `titled`
  (the computed honest answer). Corrected the field's own stale comment, which
  claimed `renderStage && renderStage !== 'done'` was "the exact still-processing
  signal" — it wasn't; that string also reads `'done'` for an intentional no-brand
  ship, and goes stale forever if the writing process dies mid-render (exactly what
  was observed).
- **`routes/catalog.js` and `routes/campaigns.js` `GET .../:id/ads-detail`** — found
  a live, standing bug while wiring this through: both endpoints' `$project`
  already fetched `renderStage`/`renderStageAt` (with a comment saying it was there
  *specifically* so Product Ads could show real pipeline state), but the mapped JSON
  row **never actually included them**. Frontend commit `6541164` (`fix(ads): ad
  pill shows real render stage, finished ads say Ready for Review (#67)`) explicitly
  claims *"Backend already emits renderStage/renderStageAt on every relevant surface
  (projectAd, GET /api/catalog/:id/ads-detail) — no backend change needed."* That
  claim was false for this endpoint. Net effect before this fix: `renderStage` was
  `undefined` on every ad on the Product Ads page (the primary nav surface, per that
  same commit), so the frontend's own `!stage` "nothing reported yet ⇒ done" fallback
  fired for literally every draft ad, titled or not — the exact "we'd have made the
  lie more confident" risk the task brief warned about, except it wasn't hypothetical,
  it was already live on this endpoint. Fixed both endpoints: `renderStage`,
  `renderStageAt`, `titlingResumeState`, and `titled` all now reach the JSON.
- **`services/metaAdsPushService.js` `pushOne`** — an untitled master is no longer
  pushable to Meta. Session.md had flagged "Ads can be pushed to Meta before titling
  completes" as a known, not-fixed gap; Grok's trace independently surfaced the exact
  same line. Closed it: `isVideoTitlingSettled` throws before any upload call.
- **`services/backlogWatchdog.js`** — new check (arm "1b"), `ALERT_TITLING_STUCK_MIN`
  (default 45m = 3x titlingResumeService's own `CLAIM_STALE_MIN`), pages when an ad
  has sat with `titlingResumeState` pending/claimed past that window. This is the
  literal "no signal at all" answer from the task brief — the design gap session.md
  named as deliberately deferred, now with the live evidence that it should not stay
  deferred.

## NOT fixed here — flagged, scoped out on purpose

Grok's trace surfaced a few more `renderUrl`-as-delivered sites that are real but
outside this incident's blast radius; recorded so they don't get re-discovered from
scratch:
- `services/slackRunVerbosity.js` `classifyClaimedAd` still calls a `draft`/`live`
  video ad "delivered" in the run-close Slack summary, independent of titling.
- `services/adRegenerateService.js` can complete a regen as `'done'` on a raw,
  untitled master (titling failure there is non-fatal by design).
- `routes/ads.js` `GET /render-activity` selects `veoVideoUrl` but never emits it, and
  its `stalled` flag only checks `status:'rendering'` — a `draft`+untitled-claimed ad
  is never flagged stalled on that board.
- `POST /:id/approve` has no titling check — an operator can approve an untitled
  master today. Deliberately not touched: blocking an explicit operator action needs
  an owner call, not a unilateral change bundled into this fix.
- `adRecencyService`'s `renderedAt` is stamped at the pre-titling master write, so
  "most recently rendered" ranking is off by however long titling takes. Cosmetic.

## Verification

New `scripts/verifyTitlingDeliveryTruth.js` — 39 checks, offline (no DB/network),
covering the discriminator itself, the run-rollup bucket + `isSettled` gating, the
worker.js field-selection trap (the single most dangerous way to silently defeat the
whole fix), the `projectAd`/ads-detail field exposure (source-text, comment-stripped),
the Meta-push gate ordering, and the watchdog query shape. **Revert-proved by
actually reverting each fix in turn and confirming the harness fails** (always-true
discriminator, narrowed `.select()`, deleted `titled:` line, neutralized push gate,
wrong watchdog field) — not just claimed. `npm test`: **182/182** (full suite, this
new script included). `npm run lint`: clean.

## Not investigated / left for the owner

- Whether `REMOTION_QUEUE_CONCURRENCY=8` (raised today, PR #274) is actually safe —
  the crash-loop evidence above is circumstantial, not a memory-graph measurement.
  Recommend checking the web service's memory graph across a full video-heavy run
  before the next one, and dialing back to 4 if it's still thrashing.
- `?rendered=true` (routes/ads.js) still treats `status ∈ {draft,live,archived}` as
  "has something to show" — left alone on purpose; it never claimed "finished", only
  "not in the pre-render queue", so it's a different, weaker claim than the ones
  fixed here.
