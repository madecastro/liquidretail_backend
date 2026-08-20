## 2026-08-19 — "I'm not getting all the ads I ordered" was already closed by #241/#244 — do not re-diagnose

**Context for why this entry exists:** the owner asked "why am I not getting all the ads I
ordered, is a fix in progress?" A brief was written proposing a `RUN_CLAIM_VIDEO_SHARE` claim-time
reservation in `selectAdsForRun` to stop tier-0 video from starving the static tiers. **That
premise was stale and the proposed fix would have been a knob solving a problem that no longer
existed.** Caught before implementation by a peer session's review; independently re-verified here.
Writing this down so nobody re-diagnoses the same symptom from the same stale evidence again.

### The trap: a 24h-delayed Slack alert made a fixed bug look current

The triggering evidence was a Slack alert — *"Queued leftovers archived — 9 ad(s)"* — for run
`run_1787089389048_2fe91d23`. That alert fires from `QUEUED_ARCHIVE_AFTER_H=24`, i.e. **24 hours
after the run**, so at the moment it posts it is always describing yesterday's state, never today's.
The run in question was from 2026-08-18 21:43 — the night before the fixes below shipped. Diagnosing
from that alert produces a permanent false positive: it will keep pointing at pre-fix runs long
after the fix is live, because the delay is structural, not a symptom of anything still broken.

**Rule of thumb for next time:** never diagnose current pipeline health from a "leftovers archived"
alert without also checking the run's own `createdAt` against `QUEUED_ARCHIVE_AFTER_H`. If the run
is close to 24h old, you are looking at history, not the present.

### What was actually wrong, and what fixed it

`selectAdsForRun`'s tier 0 (`services/campaignAdsGenerationService.js`) claims deterministic video
ads first, unconditionally, before touching the static tiers. Video tier size for a "Meta + PMax"
product is 21 ads. Two independent things caused those runs to lose exactly the video tail:

1. **The undispatched tail.** A claimed batch that exceeded `VEO_CONCURRENCY` (12) in one wave and
   then had its `CampaignRun` die (instance restart, SIGTERM, reaper) before draining left the
   remainder `status:'queued'`, `renderStage` empty — indistinguishable from a fresh, never-claimed
   mint leftover, so `strandedRunSweeper.js`'s `renderStage` requirement made that population
   invisible to the one recovery mechanism that could rescue it, forever. Fixed by **PR #241**
   (`7a5822c6`): all four REQUEUE_MARK sites now stamp an honest `renderStage` breadcrumb via
   `buildRequeueSetStage` (`services/adArchiveDigest.js`) at release time, so the ambiguity never
   reaches the sweeper's query.
2. **Static moderation collapse.** A single flagged catalog photo zeroed a product's entire static
   output, because `DIRECTOR_UNIVERSE_TOP_N=1` means all ~18 static payloads for a product share
   one seed image. Fixed by **PR #244** (`149862fd`): a seed-swap fallback tries the product's next
   catalog image before giving up.

Note also: `MAX_CREATIVES_PER_RUN` is **1000** (raised by #208 well before tonight), not 20. An
earlier internal brief assumed 20 and concluded tier 0's early-return (`if (detIds.length >= limit)
return detIds;`, still present at `services/campaignAdsGenerationService.js:2129`) fires on a
21-video run. It doesn't — it needs 1000 deterministic video ads to trigger, which no real run
approaches. That specific claim-starvation mechanism was never the live bug tonight; don't revisit
it without first re-confirming `MAX_CREATIVES_PER_RUN`'s current value.

### The evidence — measured against prod, both before and after #241/#244

Ordered vs. delivered (`draft` status + non-empty `renderUrl` = delivered; there is no `done`
status, and measuring on `status:'done'` reads as 100% failure — a separate trap), across the 20
most recent runs at the time of this entry:

```
BEFORE #241/#244 (2026-08-18 21:30 – 2026-08-19 10:54):
  R 08-18T21:43  ord=21 del=12 miss=9   (vid 12/21, img 0/0,  arch=9)  <- the run the Slack alert named
  R 08-19T02:15  ord=39 del=30 miss=9   (vid 12/21, img 18/18)
  R 08-19T05:58  ord=39 del=18 miss=21  (vid 0/21,  img 18/18)
  R 08-19T07:21  ord=39 del=31 miss=8   (vid 13/21, img 18/18)
  R 08-19T08:13  ord=39 del=30 miss=9   (vid 12/21, img 18/18)
  R 08-19T10:54  ord=39 del=12 miss=27  (vid 12/21, img 0/18)          <- moderation collapse, 0 statics

AFTER #241/#244 (2026-08-19 20:27 onward):
  R 08-19T20:27  ord=18 del=18 miss=0
  R 08-19T20:40  ord=39 del=39 miss=0   (vid 21/21, img 18/18)
  R 08-19T20:59  ord=39 del=39 miss=0   (vid 21/21, img 18/18)
  R 08-19T21:10  ord=9  del=9  miss=0
  R 08-19T21:29  ord=39 del=39 miss=0   (vid 21/21, img 18/18)
  R 08-19T21:39  ord=9  del=9  miss=0
  R 08-19T21:39  ord=11 del=11 miss=0
```

Every run after the ~20:27 cutover delivers 100%, including three separate 39-creative runs at the
exact 21-video shape that previously lost 9. The `vid 12/21` signature — the fingerprint of the
undispatched-tail bug — stops dead at that cutover and does not recur.

### What NOT to do

- **Do not add `RUN_CLAIM_VIDEO_SHARE` or any claim-time reservation knob to `selectAdsForRun`.** A
  config surface added to fix a non-bug is permanent cost for nothing, and the tier-0-first design
  is intentional (video is the guaranteed baseline when video is the only requested kind).
- **Do not re-open this from a "leftovers archived" Slack alert alone.** Check the run's age against
  `QUEUED_ARCHIVE_AFTER_H` first.

### What is still genuinely open (separate from this defect, do not conflate)

`strandedRunSweeper.js`'s recovery pass defaults to `recoverImageAd`, and
`services/imageRecoveryService.js:57-59` reads only `imageGeneration.predictionId` — it is
structurally blind to video receipts, reporting "no receipt" for every video ad regardless of
truth. Harmless tonight (the population involved had zero receipts, verified independently), but
latent: a future video ad that *does* hold a receipt would be misjudged. Already tracked in
`session.d/KNOWN-OPEN.md`; a `fix/sweeper-video-recovery` branch exists in progress. Not part of
this entry's closed defect.
