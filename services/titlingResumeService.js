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
const { childTailsFrom } = require('./renderErrorFields');
const { isAdgenRendererEnabled } = require('./adgenBridge');
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
// Generous on purpose: unlike routes/ads.js renderOne, this path does NOT
// heartbeat updatedAt during the render, so a legitimately in-progress titling
// keeps its claim-time timestamp. The threshold must therefore exceed the
// longest plausible render (one measured at 76s) by a wide margin. Worst case
// if it is still running: a second pass titles the same ad — wasted CPU, no
// spend (Remotion is local), and the later write wins. Under-setting it would
// be the harmful direction, so it defaults high.
const CLAIM_STALE_MIN = Math.max(1, parseInt(process.env.TITLING_RESUME_STALE_MIN, 10) || 15);

// How long to keep releasing a claim for an ad whose brand will not resolve before
// giving up terminally. Bounds what would otherwise be a silent infinite retry.
const BRAND_GIVEUP_MIN = Math.max(1, parseInt(process.env.TITLING_RESUME_BRAND_GIVEUP_MIN, 10) || 60);

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
function buildResumeFilter(staleCutoff) {
  return {
    status: 'draft',
    $or: [
      // 1. Recovery marked it; titling has not started.
      { titlingResumeState: STATE_PENDING },
      // 2. A render was killed mid-flight — reclaim rather than leak the ad.
      //    Covers BOTH this sweeper's own claims and, since the render path now
      //    stamps the same state before titling, a normal-path process death.
      { titlingResumeState: STATE_CLAIMED, updatedAt: { $lt: staleCutoff } },
      // 3. MIGRATION arm — ads stranded by code that wrote veoVideoUrl +
      //    status:'draft' and NOTHING else. Self-limiting: handling one gives it
      //    a renderUrl, after which it can never re-match.
      { veoVideoUrl: { $ne: null }, renderUrl: null }
    ]
  };
}

/**
 * Claim and title recovered masters. NEVER throws — one bad ad must not kill
 * the pass or the interval. Returns { titled, failed, skipped }.
 */
async function resumeUntitledMasters({ limit = TITLING_RESUME_MAX } = {}) {
  const out = { titled: 0, failed: 0, skipped: 0 };
  if (!enabled()) return out;
  // Stand down when adgen owns rendering. Call-time read via the shared
  // helper (re-reads process.env every call) so a dashboard flip takes
  // effect without a redeploy. Fail-safe: ONLY the exact predicate adgen
  // uses to claim (`=== 'true'`, case-insensitive) makes us skip. Missing
  // or malformed ⇒ helper is false ⇒ we still sweep. The other direction
  // (stand down on any set/truthy value) would strand paid untitled
  // masters whenever adgen is not claiming. Gate the function body, not
  // the interval: an in-flight pass that has already passed this check
  // finishes; only a NEW pass is skipped.
  if (isAdgenRendererEnabled()) return out;

  let ads;
  const staleCutoff = new Date(Date.now() - CLAIM_STALE_MIN * 60 * 1000);
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
      const claim = await Ad.updateOne(claimFilter, { $set: claimSet });
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
        const tooOld = (Date.now() - new Date(adFresh.updatedAt || 0).getTime())
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
          // Status-guarded for the same reason as the titled arm above:
          // qcAndStampVideoAd (line above) can stamp status:'failed' on a real
          // vision-QC failure, and this write used to overwrite it with 'draft'.
          const noBrandPromoted = await Ad.updateOne(
            { _id: ad._id, titlingResumeState: STATE_CLAIMED, status: { $in: ['rendering', 'draft'] } },
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
          ).catch(() => null);
          if (!noBrandPromoted || !noBrandPromoted.matchedCount) {
            // Verdict kept — still settle the debt or this ad is re-swept forever.
            await Ad.updateOne(
              { _id: ad._id, titlingResumeState: STATE_CLAIMED },
              { $set: { titlingResumeState: null, renderStageAt: new Date(), updatedAt: new Date() } }
            ).catch(() => {});
          }
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
            }
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
      renderAttempted = true;
      await renderBrandScriptAndSave({ ad: adFresh, brand });

      // Success (including skipped / no-chrome — routes/ads.js treats that as
      // intentional success). Do NOT overwrite renderUrl/posterUrl —
      // renderBrandScriptAndSave already persists the titled asset itself.
      const now = new Date();
      // GUARDED — renderBrandScriptAndSave runs vision QC, and a real QC
      // failure stamps status:'failed' (buildVideoQcFailureFields) without
      // throwing, so this arm is reached with a terminal verdict already on
      // the row. A bare { _id } write overwrote it with 'draft'. Measured in
      // prod 2026-08-24: 47 QC-failed video ads in 'draft', ZERO in 'failed'.
      // Allowlist, not denylist: an unknown status is left alone, never
      // resurrected. The debt is settled on BOTH arms or the sweeper re-picks
      // this ad forever.
      const promoted = await Ad.updateOne(
        { _id: ad._id, status: { $in: ['rendering', 'draft'] } },
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
      if (!promoted.matchedCount) {
        await Ad.updateOne(
          { _id: ad._id },
          { $set: { titlingResumeState: null, renderStage: 'done', renderStageAt: now, updatedAt: now } }
        );
      }
      out.titled++;
    } catch (err) {
      // A PRE-RENDER throw is NOT the ad's fault — release, do not condemn.
      // These are DB reads (claim / findById / Media / Brand). A Mongo blip during
      // a deploy, which is exactly when this sweeper runs, must not permanently
      // write off a paid recoverable ad. Releasing to 'pending' costs one more
      // pass; condemning costs the ad.
      if (!renderAttempted) {
        await Ad.updateOne(
          { _id: ad._id, titlingResumeState: STATE_CLAIMED },
          { $set: { titlingResumeState: STATE_PENDING, updatedAt: new Date() } }
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
              renderError: { message: tmsg, stage: 'titling', at: new Date(), ...childTailsFrom(err) },
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
      if (err && err.stderrTail) {
        console.warn(`   ⚠️  titlingResume[${ad._id}]: child stderrTail:\n${err.stderrTail}`);
      }
    }
  }

  const touched = out.titled + out.failed + out.skipped;
  if (touched > 0) {
    console.log(
      `🎬 titlingResume: ${out.titled} titled · ${out.failed} failed · ${out.skipped} skipped`
    );
  }
  return out;
}

module.exports = {
  resumeUntitledMasters,
  buildResumeFilter,
  enabled,
  fallbackPosterUrl,
  STATE_PENDING,
  STATE_CLAIMED,
  TITLING_PENDING,
  TITLING_CLAIMED,
  TITLING_RESUME_MAX,
  CLAIM_STALE_MIN,
  BRAND_GIVEUP_MIN
};
