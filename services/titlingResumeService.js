'use strict';
//
// TITLING RESUME — finish recovered masters that already hold a paid asset.
//
// WHY (2026-08-04): bootRecoveryService can pull a finished Omni master out of a
// spend receipt and stamp it draft with renderUrl. That makes the ad VIEWABLE,
// but CLAUDE.md §00 step 4 is explicit that "untitled is not success". Remotion
// is warmed only on the web process (index.js); worker.js has zero remotion
// references. So recovery (worker) marks; this sweeper (web) titles.
//
// CRITICAL MONEY CONSTRAINT: the normal render path declares `veoVideoUrl`
// FRESH each run and never reads `ad.veoVideoUrl` (routes/ads.js:1342, :1367).
// Requeuing a recovered ad would therefore fall through to a fresh Omni
// submit and pay a second time for a master we already hold. This module
// titles only — no requeue, no video-provider submit path.

const Ad    = require('../models/Ad');
const Brand = require('../models/Brand');
const Media = require('../models/Media');
// brandScriptExecutor is required lazily below: bootRecoveryService imports only
// TITLING_PENDING from this module, and the worker process must not pay the
// remotion/ffmpeg load at boot for a constant.

// Exact sentinel written by bootRecoveryService when a paid master is recovered.
// WHY exact-match: renderStage is written by services/adStage.js on every normal
// render, so a substring or regex match would sweep up normally-titled ads
// ('done'), deliberate no-chrome ships ('no titling (...) — shipping master')
// and titling failures ('master rendered; titling failed'). Only recovery
// writes this exact string.
// STATE LIVES ON Ad.titlingResumeState, a field declared in models/Ad.js — NOT in
// renderStage.
//
// The first version of this module used a renderStage sentinel, reasoning that
// reusing an existing field dodges the Mongoose-strict trap (a write to an
// UNDECLARED path is silently dropped). Adversarial review killed it: renderStage
// is OWNED by services/adStage.js, which `$set`s it unconditionally
// (adStage.js:82-85) and runs throughout titling (brandScriptExecutor.js:1200,
// :1306, :1332). The sentinel was therefore clobbered seconds into the render, so
// an ad whose render crashed could never be re-swept — precisely the leak this
// module exists to close. The trap is about undeclared paths; declaring the field
// removes it.
const STATE_PENDING = 'pending';
const STATE_CLAIMED = 'claimed';

// Mirror routes/ads.js:1432-1436 exactly — Cloudinary video poster transform, or
// null when the url is not a Cloudinary `/video/upload/` url. Defined HERE and
// imported by bootRecoveryService (which already imports from this module, so no
// new require cycle) so the two writers cannot drift.
function fallbackPosterUrl(videoUrl) {
  return videoUrl?.includes('/video/upload/')
    ? videoUrl
        .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
        .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
    : null;
}

// Human-readable breadcrumb only. Written for the operator/UI alongside the real
// state above, and deliberately NOT depended on for any query — adStage will
// overwrite it during titling.
const TITLING_PENDING = 'master recovered; titling pending';

// Breadcrumb for the claim, same caveat as above — informational, never queried.
//
// WHY A STALE CLAIM IS RE-SWEPT AT ALL (omitting this leaked ads): if the web
// process dies mid-Remotion-render the ad is left `status:'draft'` +
// titlingResumeState:'claimed'. NOTHING else would ever look at it again — every
// other sweeper keys on `status:'rendering'` (worker.js reapOrphans :196,
// bootRecoveryService :79, backlogWatchdog :69), and a draft matches none of
// them. The ad would sit untitled forever with no retry and no alert, which is
// exactly the "untitled is not success" failure (CLAUDE.md §00 step 4) this
// module exists to close.
const TITLING_CLAIMED = 'titling recovered master';

const TITLING_RESUME_MAX = Math.max(1, parseInt(process.env.TITLING_RESUME_MAX, 10) || 5);

// How long a claim must sit untouched before another pass may take it over.
// Generous on purpose. UPDATED 2026-08-21: this path NOW heartbeats updatedAt
// while renderBrandScriptAndSave is in flight (see the render call below) — the
// original design assumed it did not, reasoning the single-ad render time
// (measured 76s) sat safely under this default. That assumption broke once the
// exhausted-claim bound was added: routes/ads.js's titling block shares this
// SAME per-process Remotion pool (remotionRenderService, REMOTION_QUEUE_
// CONCURRENCY) and has measured a 20-ad drain at 926s — an ad merely WAITING
// its turn on that shared pool could go stale by this clock alone, and without
// a heartbeat a concurrent instance's exhausted-claims pass could then condemn
// a render that was never abandoned, only queued. The heartbeat is what keeps
// this threshold meaning "the process is gone", not "titling is running long".
// Under-setting it would still be the harmful direction, so it defaults high.
const CLAIM_STALE_MIN = Math.max(1, parseInt(process.env.TITLING_RESUME_STALE_MIN, 10) || 15);

// How long to keep releasing a claim for an ad whose brand will not resolve before
// giving up terminally. Bounds what would otherwise be a silent infinite retry.
const BRAND_GIVEUP_MIN = Math.max(1, parseInt(process.env.TITLING_RESUME_BRAND_GIVEUP_MIN, 10) || 60);

// How many times ONE ad may be claimed for a titling retry before the sweep
// stops re-driving it and records an honest terminal verdict instead.
//
// ⚠️ WHY A COUNT AND NOT JUST A CLOCK — this is the hole this bound closes.
// CLAIM_STALE_MIN makes an abandoned claim reclaimable, which is real recovery
// and it works. But the reclaim WRITES updatedAt, and nothing counted the
// reclaims, so the loop had no exit: an ad whose titling can never finish
// inside one process lifetime — a deploy/autoscale replacement storm, or a
// render heavy enough to OOM this process (that killed it on 2026-08-04, see
// index.js's re-entrancy comment) — cycles claim → die → reclaim → die
// indefinitely. Three things were wrong with that, none of them cosmetic:
//   1. No terminal verdict, ever. The ad stays 'claimed', which reads as "in
//      flight", so it is never surfaced as a creative that needs attention.
//   2. A full Remotion render (measured 76s, headless Chrome + a 1080p ffmpeg
//      encode) is burned on EVERY cycle, on the web process, forever. If the
//      render is what kills the process, this is a self-sustaining crash loop
//      that takes every other in-flight render on the instance down with it.
//   3. It is invisible to the one alarm built for it. backlogWatchdog's
//      titling-stuck arm keys on `updatedAt` older than ALERT_TITLING_STUCK_MIN
//      (45m), and a reclaim happens at most CLAIM_STALE_MIN (15m) + the sweep
//      interval (5m) after the previous touch — so an actively cycling ad is
//      NEVER 45m idle and that alert can never fire on it. The idle arm can
//      only ever see an ad the sweeper has STOPPED reaching. That is why
//      backlogWatchdog now also alerts on this counter directly.
//
// 3 is deliberately generous: a storm that replaces the instance twice in a row
// is normal here, and the cost of one more attempt is local CPU, never spend.
// Giving up is also not the end of the road — the master is paid for and kept
// on renderUrl, and scripts/retitleDriver.js re-drives titling by hand for
// free (it cannot reach Omni; see its money invariant). So the bound trades an
// unbounded loop for an operator-visible failure that is cheap to undo, which
// is the right direction for a resource loop that cannot converge on its own.
const RESUME_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.TITLING_RESUME_MAX_ATTEMPTS, 10) || 3);

function enabled() {
  return String(process.env.TITLING_RESUME_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * The sweep predicate, as a PURE function of the stale cutoff.
 *
 * Extracted so a harness can evaluate the real filter against real document
 * shapes instead of regexing this file. A source-text assertion cannot tell a
 * working query from one that merely still contains the right words, and this
 * particular query is the only thing standing between a paid master and a
 * permanent untitled orphan — so it is worth being able to actually run it.
 *
 * @param {Date} staleCutoff  claims older than this may be taken over
 */
function buildResumeFilter(staleCutoff, maxAttempts = RESUME_MAX_ATTEMPTS) {
  return {
    status: 'draft',
    $or: [
      // 1. Recovery marked it; titling has not started.
      { titlingResumeState: STATE_PENDING },
      // 2. A render was killed mid-flight — reclaim rather than leak the ad.
      //    Covers BOTH this sweeper's own claims and, since the render path now
      //    stamps the same state before titling, a normal-path process death.
      //
      //    BOUNDED BY ATTEMPT COUNT, not just by staleness. Staleness alone made
      //    this arm an infinite loop for an ad that can never finish inside one
      //    process lifetime — see RESUME_MAX_ATTEMPTS. Past the bound the ad
      //    drops out of this arm and is picked up by buildExhaustedClaimFilter
      //    below, which records a terminal verdict instead of re-rendering.
      //
      //    The `$exists: false` branch is load-bearing and is the same idiom
      //    strandedRunSweeper.buildStrandedAdFilter uses for renderAttempts:
      //    Mongo's `$lt` does NOT match a missing field, and Mongoose's
      //    `default: 0` applies only to newly created documents — so every ad
      //    already stranded 'claimed' in production carries no counter at all.
      //    Without this branch the bound would exclude exactly the population
      //    the sweep exists to rescue.
      {
        titlingResumeState: STATE_CLAIMED,
        updatedAt: { $lt: staleCutoff },
        $or: [
          { titlingResumeAttempts: { $lt: maxAttempts } },
          { titlingResumeAttempts: { $exists: false } }
        ]
      },
      // 3. MIGRATION arm — ads stranded by code that wrote veoVideoUrl +
      //    status:'draft' and NOTHING else. Self-limiting: handling one gives it
      //    a renderUrl, after which it can never re-match.
      { veoVideoUrl: { $ne: null }, renderUrl: null }
    ]
  };
}

/**
 * The COMPLEMENT of the stale-claim arm's attempt bound, as a pure function.
 *
 * These are ads the sweep has re-driven RESUME_MAX_ATTEMPTS times and which are
 * stale again — so the retry budget is spent and the last attempt is not merely
 * slow. Extracted for the same reason buildResumeFilter is: a harness can then
 * evaluate the REAL query against real document shapes rather than regexing
 * this file, and the two filters can be proved DISJOINT (an ad must be either
 * re-driven or condemned, never both, and never neither).
 *
 * THE STALENESS BOUND IS NOT REDUNDANT HERE. Without it this filter would match
 * an ad whose Nth attempt is running RIGHT NOW — the claim bumps updatedAt and
 * then renders for up to ~76s — and condemn a titling job that was about to
 * succeed. It must mean "the budget is spent AND nobody is holding it".
 *
 * @param {Date}   staleCutoff  same cutoff the sweep used this pass
 * @param {number} maxAttempts  claims allowed before the ad is given up on
 */
function buildExhaustedClaimFilter(staleCutoff, maxAttempts = RESUME_MAX_ATTEMPTS) {
  return {
    status: 'draft',
    titlingResumeState: STATE_CLAIMED,
    updatedAt: { $lt: staleCutoff },
    titlingResumeAttempts: { $gte: maxAttempts }
  };
}

/**
 * Record an honest terminal verdict for claims that have exhausted their retry
 * budget. NEVER throws. Returns the number of ads marked.
 *
 * WHY THIS IS A SEPARATE, EARLIER PASS and not a branch inside the render loop:
 * an exhausted ad must stop consuming one of the TITLING_RESUME_MAX (5) slots
 * per pass. The sweep sorts by `updatedAt` ascending, so a permanently-failing
 * ad is by construction the OLDEST row and would be re-picked first every single
 * pass, starving every other recoverable master behind it.
 *
 * THE OUTCOME MIRRORS THE EXISTING TITLING-FAILURE BRANCH (below, and
 * routes/ads.js's `if (titlingFailed)`) rather than inventing a fourth shape:
 * status 'failed' + titlingResumeState null + renderError.stage 'titling', with
 * renderUrl LEFT ALONE so the paid master is never discarded. Two independent
 * reasons that is the honest marking and not just the convenient one:
 *   - services/adTitlingTruth.isAdHonestlyDelivered rejects any non-terminal
 *     status, so the ad stops being counted as a delivered creative by the run
 *     rollup, the Slack summary, the ads list/detail JSON and the Meta push gate.
 *   - isVideoTitlingSettled ALSO returns false for it independently, because
 *     renderUrl still equals veoVideoUrl and this renderStage deliberately does
 *     NOT begin with "no titling (" — the exact prefix that module treats as a
 *     DECLARED intentional bare-master ship. Wording it that way would relabel
 *     an abandoned render as a deliberate one, which is the single most
 *     dangerous edit that can be made to this string.
 */
async function markExhaustedClaims(staleCutoff, { limit = TITLING_RESUME_MAX } = {}) {
  let stuck;
  try {
    stuck = await Ad.find(buildExhaustedClaimFilter(staleCutoff))
      .sort({ updatedAt: 1 })
      .limit(limit)
      .select('_id titlingResumeAttempts renderStage')
      .lean();
  } catch (err) {
    console.warn(`⚠️  titlingResume: could not query exhausted claims — ${err.message}`);
    return 0;
  }
  if (!stuck.length) return 0;

  let marked = 0;
  for (const ad of stuck) {
    const n = ad.titlingResumeAttempts || 0;
    const tmsg = `master rendered; titling abandoned after ${n} resume attempt(s) — ` +
      `the render never completed inside one process lifetime`;
    try {
      // Re-assert BOTH the state AND the staleness bound in the write, not just
      // the find — adversarial review caught that the state alone re-asserts
      // nothing: a reclaim keeps titlingResumeState:'claimed' and only bumps
      // updatedAt, so "still claimed" is true for both "still abandoned" and
      // "another instance just took it and is rendering right now". Only the
      // SAME staleCutoff the find used tells those apart — this is the write-side
      // half of the heartbeat fix above; the two together are what make "the
      // budget is spent AND nobody is holding it" actually hold at write time,
      // not just at find time (a TOCTOU gap the write's own comment used to
      // claim was closed without actually doing so).
      const res = await Ad.updateOne(
        { _id: ad._id, titlingResumeState: STATE_CLAIMED, updatedAt: { $lt: staleCutoff } },
        {
          $set: {
            status: 'failed',
            titlingResumeState: null,
            renderError: { message: tmsg, stage: 'titling', at: new Date() },
            renderStage: 'master rendered; titling abandoned',
            renderStageAt: new Date(),
            updatedAt: new Date()
          }
        }
      );
      if (res.modifiedCount > 0) {
        marked++;
        console.warn(
          `   ⚠️  titlingResume[${ad._id}]: giving up after ${n} attempt(s) — ` +
          `paid master kept on renderUrl, re-drive with scripts/retitleDriver.js`
        );
      }
    } catch (err) {
      console.warn(`   ⚠️  titlingResume[${ad._id}]: could not mark abandoned — ${err.message}`);
    }
  }
  return marked;
}

/**
 * Claim and title recovered masters. NEVER throws — one bad ad must not kill
 * the pass or the interval. Returns { titled, failed, skipped, abandoned }.
 */
async function resumeUntitledMasters({ limit = TITLING_RESUME_MAX } = {}) {
  const out = { titled: 0, failed: 0, skipped: 0, abandoned: 0 };
  if (!enabled()) return out;

  let ads;
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MIN * 60 * 1000);

  // FIRST, retire claims whose retry budget is spent — before selecting work,
  // so an ad that can never finish stops starving the queue it sits at the head
  // of (this find sorts by updatedAt ascending). Never throws; a failure here
  // must not stop real titling from happening below.
  out.abandoned = await markExhaustedClaims(staleCutoff, { limit });

  try {
    // Three arms, all exact-match — never a substring or regex on any field.
    //   1. pending           — recovery marked it, titling has not started.
    //   2. claimed + stale   — a render was killed mid-flight; reclaim it rather
    //                          than leak the ad forever (see TITLING_CLAIMED).
    //   3. MIGRATION arm     — ads stranded by the code currently in production,
    //      which wrote veoVideoUrl + status:'draft' and NOTHING else. They carry
    //      no titlingResumeState and no renderUrl, so arms 1-2 would never see
    //      them and the very ad that prompted this work would stay broken after
    //      the deploy. `renderUrl: null` + a veoVideoUrl is the unambiguous
    //      signature of that bug, and it is SELF-LIMITING: once handled, the ad
    //      has a renderUrl and can never re-match. Not gated on `kind` because
    //      the old write did not set it.
    ads = await Ad.find(buildResumeFilter(staleCutoff))
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean();
  } catch (err) {
    console.warn(`⚠️  titlingResume: could not query pending masters — ${err.message}`);
    return out;
  }
  if (!ads.length) return out;

  for (const ad of ads) {
    // Set once the Remotion render is actually entered. Only a throw from there is
    // allowed to be terminal — see the comment at the renderBrandScriptAndSave call.
    let renderAttempted = false;
    try {
      // CLAIM FIRST, before any Remotion work. Several web instances run this
      // concurrently under autoscaling and there is no lease — the filter-
      // guarded write is the whole concurrency control. Claiming AFTER the
      // render would let two instances title one ad.
      // The filter must REPRODUCE the condition that selected this ad, which is
      // what makes the claim exclusive with no lease:
      //   - pending: the first writer flips titlingResumeState, so a second
      //     writer's `titlingResumeState: 'pending'` no longer matches.
      //   - stale claim: the state is ALREADY 'claimed', so the state alone
      //     cannot arbitrate. `updatedAt: { $lt: staleCutoff }` is the arbiter —
      //     the first writer bumps updatedAt to now and every later writer's
      //     staleness bound then misses. Dropping that bound here would let two
      //     instances both "win" a stale claim and double-render.
      //   - migration: `renderUrl: null` is the arbiter. The claim sets
      //     renderUrl, so the first writer makes every later filter miss.
      const claimFilter = ad.titlingResumeState === STATE_PENDING
        ? { _id: ad._id, titlingResumeState: STATE_PENDING }
        : ad.titlingResumeState === STATE_CLAIMED
          ? { _id: ad._id, titlingResumeState: STATE_CLAIMED, updatedAt: { $lt: staleCutoff } }
          : { _id: ad._id, renderUrl: null };

      // The migration arm must ALSO backfill what the old code failed to write,
      // or the ad stays invisible even after it is titled: projectAd
      // (routes/ads.js) serialises ad.renderUrl with no veoVideoUrl fallback.
      const claimSet = {
        titlingResumeState: STATE_CLAIMED,
        renderStage: TITLING_CLAIMED,
        renderStageAt: new Date(),
        updatedAt: new Date()
      };
      if (!ad.renderUrl && ad.veoVideoUrl) {
        claimSet.kind = 'video';
        claimSet.renderUrl = ad.veoVideoUrl;
        claimSet.posterUrl = ad.posterUrl || fallbackPosterUrl(ad.veoVideoUrl) || ad.veoVideoUrl;
      }
      // $inc RIDES THE SAME ATOMIC WRITE AS THE CAS, deliberately. The claim is
      // the only thing that arbitrates between concurrent instances (there is no
      // lease), so counting anywhere else — a second write, or after the render —
      // would either miss the attempt that then died (which is the ONLY attempt
      // worth counting) or double-count a claim that lost the race. Exactly one
      // winner increments, exactly once, at the moment it takes ownership.
      const claim = await Ad.updateOne(claimFilter, {
        $set: claimSet,
        $inc: { titlingResumeAttempts: 1 }
      });
      if (claim.modifiedCount === 0) {
        out.skipped++;
        continue;
      }

      const adFresh = await Ad.findById(ad._id).lean();
      if (!adFresh) {
        out.skipped++;
        continue;
      }

      // Resolve brand the same way routes/ads.js:1328-1331 does — via the ad's
      // source Media brandId. Projection is load-bearing for the proof beat
      // (brandReviews); keep the list in sync with routes/ads.js:1330.
      const sourceMedia = await Media.findById(adFresh.mediaId)
        .select('fileType fileUrl brandId').lean();
      const brand = sourceMedia?.brandId
        ? await Brand.findById(sourceMedia.brandId)
            .select('name styleScript styleScriptVertical styleScriptLandscape styleTheme tagline logoUrl websiteUrl primaryColor secondaryColor accentColor fontFamily fontSource curatedFields tailwindTheme websiteFontUsage customFonts derivedVoice videoSettings titleStyleSpec titleStylePreset brandReviews').lean()
        : null;

      if (!brand) {
        // A missing brand is not the ad's fault and may be transient (a slow
        // replica, a mid-migration read), so this releases rather than fails.
        //
        // BOUNDED, unlike the first version. Releasing straight back to 'pending'
        // means a permanently missing/deleted brand is retried every pass FOREVER
        // — cheap (no render runs) but a silent infinite loop with no operator
        // signal. So it releases only while the ad is younger than the give-up
        // window; past that it goes terminal with an honest reason. The paid
        // master is already on renderUrl either way, so nothing is lost.
        // MEASURE FROM `ad.updatedAt` (the doc as SELECTED, before this pass's own
        // claim write touched it) — NOT `adFresh.updatedAt`. adversarial review
        // caught that the claim a few lines up ($set updatedAt: new Date()) always
        // lands before this read, so adFresh.updatedAt is always "just now" and
        // `tooOld` was always false: the give-up path — and the vision-QC stamp
        // and "no titling (no brand)" ship it exists to reach — was unreachable
        // dead code. `ad.updatedAt` is the pre-claim snapshot from the resume
        // find() above and is exactly the debt's true age.
        const tooOld = (Date.now() - new Date(ad.updatedAt || 0).getTime())
          > BRAND_GIVEUP_MIN * 60 * 1000;
        if (tooOld) {
          // Past the window the brand is treated as genuinely absent, and then we
          // MIRROR THE NORMAL PATH rather than invent a harsher outcome:
          // routes/ads.js wraps titling in `if (brandDoc)` and its else-branch
          // promotes the ad to draft and counts it a SUCCESS — with no
          // brand there is no chrome to composite, so the raw master IS the
          // deliverable. Marking it 'failed' here would write off a perfectly good
          // paid ad for a condition the normal path ships happily, and would make
          // the same ad's outcome depend on which code path titled it.
          //
          // Mirror that path's vision QC too, not just its "ship anyway"
          // verdict — this branch never reaches renderBrandScriptAndSave, so
          // without this the ad would ship with NO Ad.visionQc at all (same
          // gap the routes/ads.js no-brand branches had). Lazy require —
          // same reason as the one a few lines below (worker.js must not pay
          // the remotion/ffmpeg load at boot for a constant).
          const { qcAndStampVideoAd } = require('./brandScriptExecutor');
          await qcAndStampVideoAd({ ad: adFresh, deliveredUrl: adFresh.veoVideoUrl });
          await Ad.updateOne(
            { _id: ad._id, titlingResumeState: STATE_CLAIMED },
            {
              $set: {
                status: 'draft',
                titlingResumeState: null,
                renderStage: 'no titling (no brand) — shipping master',
                renderStageAt: new Date(),
                renderedAt: new Date(),
                updatedAt: new Date()
              }
            }
          ).catch(() => {});
          out.titled++;
          console.warn(
            `   ⚠️  titlingResume[${ad._id}]: brand unresolvable for >${BRAND_GIVEUP_MIN}m — ` +
            `shipping the untitled master (matches routes/ads.js no-brand behaviour)`
          );
          continue;
        }
        await Ad.updateOne(
          { _id: ad._id, titlingResumeState: STATE_CLAIMED },
          {
            $set: {
              titlingResumeState: STATE_PENDING,
              renderStage: TITLING_PENDING,
              renderStageAt: new Date(),
              updatedAt: new Date()
            },
            // Same reasoning as the pre-render-throw release below: a missing
            // brand is a DB-read outcome, never a render attempt, so this claim
            // must not cost budget meant for genuine Remotion deaths.
            $inc: { titlingResumeAttempts: -1 }
          }
        ).catch(() => {});
        out.skipped++;
        continue;
      }

      // Lazy require — same call site pattern as routes/ads.js:1471.
      const { renderBrandScriptAndSave } = require('./brandScriptExecutor');
      //
      // ONLY A RENDER FAILURE IS TERMINAL. Everything above this line is DB reads
      // (the claim, findById, Media, Brand); if one of those throws it says nothing
      // about the ad, and the outer catch would otherwise flag a paid, perfectly
      // recoverable ad `failed` forever. That is not hypothetical: this sweeper runs
      // on an interval and at ~90s after boot, i.e. exactly when a deploy is
      // churning Mongo connections. So the render is marked, and only a throw from
      // INSIDE it is allowed to be terminal — a pre-render throw releases instead.
      //
      // ⚠️ HEARTBEAT, mirroring routes/ads.js's renderOne (:2655-2666) exactly —
      // added after adversarial review proved this render is NOT exempt from the
      // same risk that heartbeat exists for. renderBrandScriptAndSave calls into
      // services/remotionRenderService, the SAME per-process bounded pool
      // (REMOTION_QUEUE_CONCURRENCY, default 4) that routes/ads.js's titling
      // block queues behind — and routes/ads.js has ALREADY MEASURED a 20-ad
      // titling drain at 926s on that shared pool, longer than CLAIM_STALE_MIN
      // (15m default). Without a heartbeat, a resume-claimed ad merely WAITING
      // its turn on that pool goes stale by this module's own clock, and a
      // concurrent instance's exhausted-claims pass (or this ad's own next
      // stale-reclaim) can then act on it as if the process had died — see
      // buildExhaustedClaimFilter's staleness bound, which this heartbeat is
      // what makes mean "nobody is holding it" rather than "merely slow".
      const resumeHeartbeat = setInterval(() => {
        Ad.updateOne(
          { _id: ad._id, titlingResumeState: STATE_CLAIMED },
          { $set: { updatedAt: new Date() } }
        ).catch(() => {});   // a missed beat is survivable; the next one lands
      }, 60_000);
      if (typeof resumeHeartbeat.unref === 'function') resumeHeartbeat.unref();
      renderAttempted = true;
      try {
        await renderBrandScriptAndSave({ ad: adFresh, brand });
      } finally {
        clearInterval(resumeHeartbeat);
      }

      // Success (including skipped / no-chrome — routes/ads.js treats that as
      // intentional success). Do NOT overwrite renderUrl/posterUrl —
      // renderBrandScriptAndSave already persists the titled asset itself.
      const now = new Date();
      await Ad.updateOne(
        { _id: ad._id },
        {
          $set: {
            status: 'draft',
            titlingResumeState: null,   // nothing owed — clears the sweep
            renderStage: 'done',
            renderStageAt: now,
            renderedAt: now,
            updatedAt: now
          }
        }
      );
      out.titled++;
    } catch (err) {
      // A PRE-RENDER throw is NOT the ad's fault — release, do not condemn.
      // These are DB reads (claim / findById / Media / Brand). A Mongo blip during
      // a deploy, which is exactly when this sweeper runs, must not permanently
      // write off a paid recoverable ad. Releasing to 'pending' costs one more
      // pass; condemning costs the ad.
      if (!renderAttempted) {
        // GIVE BACK the attempt this claim just spent. T18's whole point is that
        // a pre-render throw (a DB blip, exactly the kind this sweeper runs
        // straight into after a deploy) is not the ad's fault — but the claim's
        // $inc already charged it against RESUME_MAX_ATTEMPTS regardless of why
        // the claim released. Left uncorrected, three unrelated Mongo blips would
        // exhaust the SAME budget meant for genuine Remotion deaths, and a later
        // ad that has never actually entered a render even once would be
        // condemned on its first real attempt. The $inc/$dec pair nets to zero
        // for a claim that never became a render — only a render that was
        // ATTEMPTED and then failed/died should ever cost budget.
        await Ad.updateOne(
          { _id: ad._id, titlingResumeState: STATE_CLAIMED },
          {
            $set: { titlingResumeState: STATE_PENDING, updatedAt: new Date() },
            $inc: { titlingResumeAttempts: -1 }
          }
        ).catch(() => {});
        out.skipped++;
        console.warn(
          `   ⚠️  titlingResume[${ad._id}]: pre-render error, claim released for retry — ${err.message || err}`
        );
        continue;
      }

      // TERMINAL BY DESIGN, and only for a real render failure: clear the state so
      // a permanently failing ad is retried once and then stops instead of looping
      // forever on a CPU-heavy Remotion render. The paid master stays on renderUrl
      // and is never deleted. Mirror routes/ads.js:1490-1504 exactly.
      try {
        const msg = (err && err.message) ? String(err.message) : String(err);
        const tmsg = `master rendered; titling failed: ${msg}`;
        await Ad.updateOne(
          { _id: ad._id },
          {
            $set: {
              status: 'failed',
              titlingResumeState: null,
              renderError: { message: tmsg, stage: 'titling', at: new Date() },
              renderStage: 'master rendered; titling failed',
              renderStageAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
      } catch (persistErr) {
        console.warn(
          `   ⚠️  titlingResume[${ad._id}]: titling failed and could not persist — ${persistErr.message}`
        );
      }
      out.failed++;
      console.warn(
        `   ⚠️  titlingResume[${ad._id}]: titling failed — master kept: ${err.message || err}`
      );
    }
  }

  const touched = out.titled + out.failed + out.skipped + out.abandoned;
  if (touched > 0) {
    console.log(
      `🎬 titlingResume: ${out.titled} titled · ${out.failed} failed · ` +
      `${out.skipped} skipped · ${out.abandoned} abandoned`
    );
  }
  return out;
}

module.exports = {
  resumeUntitledMasters,
  buildResumeFilter,
  buildExhaustedClaimFilter,
  markExhaustedClaims,
  enabled,
  fallbackPosterUrl,
  STATE_PENDING,
  STATE_CLAIMED,
  TITLING_PENDING,
  TITLING_CLAIMED,
  TITLING_RESUME_MAX,
  CLAIM_STALE_MIN,
  BRAND_GIVEUP_MIN,
  RESUME_MAX_ATTEMPTS
};
