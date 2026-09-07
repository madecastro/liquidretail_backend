#!/usr/bin/env node
'use strict';
/**
 * Behavioural harness for regenerate preflight's in-flight money guard.
 *
 * WHY THIS IS NOT A SOURCE-TEXT CHECK. A regex over adRegenerateService.js can
 * see that the words `status === 'rendering'` exist somewhere. It cannot tell a
 * working refusal from a comment describing one, and it cannot tell the NEW
 * in-flight 409 apart from the neighbouring regenerating/synced 409s. This
 * harness CALLS the real preflight() against a stubbed Ad.findOne and asserts
 * on the thrown Error's `.status` AND on that branch's own distinctive phrase,
 * so a reimplementation that merely throws for some other reason cannot pass.
 *
 * THE MONEY INVARIANT. Regenerate's lock is `Ad.regenerating`; the INITIAL
 * render's lock is claimAdsForRun's atomic `{status:'queued'}` → `'rendering'`
 * write (routes/ads.js). adRegenerateService never reads or writes Ad.status,
 * so the two filters are disjoint and both match the same document — a
 * Regenerate pressed during a first render submits a second billable
 * generation. `queued` is the deterministic sibling of that race: regenerate
 * leaves status alone, so the row is still claimed and rendered afterwards.
 * `titlingResumeState` pending|claimed sits on status:'draft'
 * (titlingResumeService), so a status-only guard misses a paid video master
 * that is still owed titling.
 *
 * Each branch carries a phrase no other branch uses, which is what makes the
 * assertions discriminating rather than "something threw":
 *   rendering → 'still rendering its first version'
 *   queued    → 'has not been rendered yet'
 *   titling   → 'still being titled'
 *
 * THE GUARD HAS TWO HALVES AND THIS HARNESS PROVES BOTH. Group D0-D6 checks the
 * exported filter is correct; D7-D9 drive the real regenerateAd and evaluate
 * the filter it genuinely hands to Ad.updateOne. That split is deliberate: an
 * earlier revision of this file had D0-D6 only, and a mutation that removed
 * notInFlight() from the lock entirely left it fully GREEN — the same
 * "asserts the helper, not the call site" hole that shipped the broken
 * receiptFree guard to production (CLAUDE.md §4).
 *
 * Revert-prove — 16 mutations, all confirmed to fail this harness:
 *   drop the rendering / queued / titling arm      → A1+A1b / A2 / A3+A4+A5
 *   drop ONLY the untagged (unstamped) titling leg → A5, D6
 *   never call the shared predicate from preflight → A1-A5, C6
 *   lock loses notInFlight() entirely              → D7
 *   lock loses any ONE of its three $and clauses   → D1-D4, D6, D7
 *   notInFlight spread-merges instead of $and      → D0
 *   over-block failed / any draft video / archived → B1+B4+B6 / B5 / B7
 *   re-key the guard on the spend receipt          → A1-A5, B4, C6
 *   move the arms above the derive-only refusal    → C3, C5
 *   wrong HTTP code on the refusal                 → A1-A5, C6
 *
 * Run: node scripts/verifyRegeneratePreflightInflight.js
 *      (no DB, no network, no API key)
 */
const assert = require('assert');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — ${String(e.message).split('\n')[0].slice(0, 220)}`); }
}

const AD_ID    = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BRAND_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';

// Every module adRegenerateService require()s at load time. Stubbing them keeps
// this harness free of Mongo, Atlas and Cloudinary — and the three DESTRUCTURED
// imports (uploadBufferToCloudinary, resolveDeriveFromMaster,
// isUgcFirstSeedingEnabled) must be present on their stubs or the require
// itself throws.
//
// services/ugcVideoPipeline.js and services/adgenBridge.js (formerly stubbed
// here as UGC / ADGEN, with an isAdgenRendererEnabled() stub) were DELETED
// wholesale as part of removing the dormant in-process render fallback —
// adgen owns rendering unconditionally now, and adRegenerateService.js no
// longer requires either module (regenerateAd unconditionally defers to
// adgen; there is no local-execution branch left to flag-gate). Requiring
// their now-nonexistent paths would throw MODULE_NOT_FOUND, so both are
// removed here rather than stubbed. services/videoRouter.js was the same
// class (deleted 2026-09-07; the VEO stub used to resolve it) — requiring
// its now-nonexistent path would throw MODULE_NOT_FOUND, so it is removed
// rather than stubbed. Every remaining stub below (MEDIA, BRAND, RUN, BSE,
// CLOUD, DI, SUS) still resolves to a real, un-deleted file — some are no
// longer imported by the current adRegenerateService.js either, but
// stubbing an unused module is inert, not broken, so they are left as-is.
const SVC   = require.resolve('../services/adRegenerateService');
const AD    = require.resolve('../models/Ad');
const MEDIA = require.resolve('../models/Media');
const BRAND = require.resolve('../models/Brand');
const RUN   = require.resolve('../models/CampaignRun');
const BSE   = require.resolve('../services/brandScriptExecutor');
const CLOUD = require.resolve('../services/cloudinaryService');
const DI    = require.resolve('../services/directImageRenderService');
const CAGS  = require.resolve('../services/campaignAdsGenerationService');
const SUS   = require.resolve('../services/seededUniverseService');

let currentRow = null;

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function install() {
  for (const m of [SVC, AD, MEDIA, BRAND, RUN, BSE, CLOUD, DI, CAGS, SUS]) {
    delete require.cache[m];
  }
  // preflight's only DB read is Ad.findOne({_id, brandId}).lean().
  stub(AD, { findOne() { return { lean: async () => currentRow }; } });
  stub(MEDIA, {});
  stub(BRAND, {});
  stub(RUN, {});
  stub(BSE, {});
  stub(CLOUD, { uploadBufferToCloudinary: async () => {} });
  stub(DI, {});
  // The real derive-only gate is pinned by verifyPmaxVideoExpansion; here it
  // must return null so it never short-circuits the arms under test.
  stub(CAGS, { resolveDeriveFromMaster: () => null });
  stub(SUS, { isUgcFirstSeedingEnabled: () => false });
  return require(SVC);
}

function row(over = {}) {
  return {
    _id:                 AD_ID,
    brandId:             BRAND_ID,
    status:              'draft',
    regenerating:        false,
    metaSyncStatus:      null,
    titlingResumeState:  null,
    regenerationHistory: [],
    deriveFromMaster:    null,
    platformFormat:      'meta_feed_1_1',
    kind:                'image',
    ...over
  };
}

const regen = install();

async function call(over = {}) {
  currentRow = row(over);
  try {
    return { ad: await regen.preflight(AD_ID, BRAND_ID), err: null };
  } catch (err) {
    return { ad: null, err };
  }
}

const msg = (r) => String((r.err && r.err.message) || '');

// Phrases that belong to exactly ONE branch each. Asserting a branch's own
// phrase AND the absence of its siblings' is what proves the intended code
// path ran, rather than some other refusal happening to fire.
const RENDERING = /still rendering its first version/i;
const QUEUED    = /has not been rendered yet/i;
const TITLING   = /still being titled/i;
const REGENING  = /already in progress/i;
const SYNCED    = /exported to Meta/i;

(async () => {
  console.log('\nRegenerate preflight in-flight guard — behavioural');

  check('A0 preflight is exported and callable', () => {
    assert.strictEqual(typeof regen.preflight, 'function');
  });

  // ── A. The new in-flight refusals (the money) ────────────────────────
  const rendering = await call({ status: 'rendering' });
  check('A1 [MONEY] status:rendering is refused 409 by the in-flight branch', () => {
    assert.ok(rendering.err, 'expected a throw — deleting the guard lets this resolve');
    assert.strictEqual(rendering.err.status, 409, `status=${rendering.err.status}`);
    assert.ok(RENDERING.test(msg(rendering)), `wrong branch: ${msg(rendering)}`);
    assert.ok(/second billable generation/i.test(msg(rendering)),
      `must name the double-bill: ${msg(rendering)}`);
    assert.ok(!REGENING.test(msg(rendering)), 'must not reuse the regenerating 409');
    assert.ok(!QUEUED.test(msg(rendering)) && !TITLING.test(msg(rendering)),
      'must not reuse a sibling in-flight 409');
  });
  check('A1b the rendering message points at recovery instead of inviting a retry', () => {
    assert.ok(/recovery sweepers/i.test(msg(rendering)),
      `must name where a stranded render is recovered: ${msg(rendering)}`);
    assert.ok(!/try again/i.test(msg(rendering)),
      'must not invite a retry loop — a retry cannot speed up a live render');
  });

  const queued = await call({ status: 'queued' });
  check('A2 [MONEY] status:queued is refused 409 (deterministic second claim)', () => {
    assert.ok(queued.err, 'expected a throw — dropping this arm because "queued is idle" re-opens spend');
    assert.strictEqual(queued.err.status, 409, `status=${queued.err.status}`);
    assert.ok(QUEUED.test(msg(queued)), `wrong branch: ${msg(queued)}`);
    assert.ok(/billing twice/i.test(msg(queued)), `must explain the second charge: ${msg(queued)}`);
    assert.ok(!REGENING.test(msg(queued)), 'must not reuse the regenerating 409');
    assert.ok(!RENDERING.test(msg(queued)) && !TITLING.test(msg(queued)),
      'must not reuse a sibling in-flight 409');
  });

  // A3/A4 are the checks a status-ONLY guard fails: status is 'draft' here.
  const claimed = await call({ status: 'draft', titlingResumeState: 'claimed' });
  check('A3 [MONEY] titlingResumeState:claimed on a draft is refused 409', () => {
    assert.ok(claimed.err, 'expected a throw — a status-only guard resolves a draft');
    assert.strictEqual(claimed.err.status, 409, `status=${claimed.err.status}`);
    assert.ok(TITLING.test(msg(claimed)), `wrong branch: ${msg(claimed)}`);
    assert.ok(/paid/i.test(msg(claimed)), `must name the already-paid master: ${msg(claimed)}`);
    assert.ok(!RENDERING.test(msg(claimed)) && !QUEUED.test(msg(claimed)) && !REGENING.test(msg(claimed)),
      'must be the titling branch, not another 409');
  });

  const pending = await call({ status: 'draft', titlingResumeState: 'pending' });
  check('A4 [MONEY] titlingResumeState:pending on a draft is refused 409', () => {
    assert.ok(pending.err, 'expected a throw — a status-only guard resolves a draft');
    assert.strictEqual(pending.err.status, 409, `status=${pending.err.status}`);
    assert.ok(TITLING.test(msg(pending)), `wrong branch: ${msg(pending)}`);
    assert.ok(/paid/i.test(msg(pending)), `must name the already-paid master: ${msg(pending)}`);
    assert.ok(!RENDERING.test(msg(pending)) && !QUEUED.test(msg(pending)) && !REGENING.test(msg(pending)),
      'must be the titling branch, not another 409');
  });

  // ── B. Must STILL resolve — anti-over-block ──────────────────────────
  // Regenerating a failed or a delivered ad is the feature working as
  // intended; a guard that blocks these is as wrong as no guard at all.
  const failed = await call({ status: 'failed' });
  check('B1 status:failed still RESOLVES (returns the ad)', () => {
    assert.strictEqual(failed.err, null, `threw: ${msg(failed)}`);
    assert.ok(failed.ad, 'expected the ad back');
    assert.strictEqual(failed.ad.status, 'failed');
  });

  const draft = await call({ status: 'draft', titlingResumeState: null });
  check('B2 status:draft with no titling debt still RESOLVES', () => {
    assert.strictEqual(draft.err, null, `threw: ${msg(draft)}`);
    assert.ok(draft.ad, 'expected the ad back');
    assert.strictEqual(draft.ad.status, 'draft');
  });

  const live = await call({ status: 'live' });
  check('B3 status:live still RESOLVES', () => {
    assert.strictEqual(live.err, null, `threw: ${msg(live)}`);
    assert.ok(live.ad, 'expected the ad back');
    assert.strictEqual(live.ad.status, 'live');
  });

  // A failed video ad can still hold the receipt of the attempt that failed;
  // that is not in-flight work and must not be confused with one.
  const failedWithReceipt = await call({
    status: 'failed', veoPredictionId: 'pred_dead_123', renderAttempts: 1
  });
  check('B4 a failed ad still holding a provider receipt RESOLVES', () => {
    assert.strictEqual(failedWithReceipt.err, null, `threw: ${msg(failedWithReceipt)}`);
    assert.ok(failedWithReceipt.ad, 'expected the ad back');
  });

  // ── C. Pre-existing refusals were not displaced ──────────────────────
  const regenerating = await call({ regenerating: true, status: 'draft' });
  check('C1 regenerating:true still 409s with its OWN message', () => {
    assert.ok(regenerating.err, 'expected a throw');
    assert.strictEqual(regenerating.err.status, 409, `status=${regenerating.err.status}`);
    assert.ok(REGENING.test(msg(regenerating)), `wrong branch: ${msg(regenerating)}`);
    assert.ok(!RENDERING.test(msg(regenerating)) && !QUEUED.test(msg(regenerating)),
      'must still be the regenerating 409, not a new in-flight one');
  });

  const synced = await call({ metaSyncStatus: 'synced', status: 'draft' });
  check('C2 metaSyncStatus:synced still 409s with its OWN message', () => {
    assert.ok(synced.err, 'expected a throw');
    assert.strictEqual(synced.err.status, 409, `status=${synced.err.status}`);
    assert.ok(SYNCED.test(msg(synced)), `wrong branch: ${msg(synced)}`);
    assert.ok(!RENDERING.test(msg(synced)) && !QUEUED.test(msg(synced)) && !TITLING.test(msg(synced)),
      'must still be the synced 409, not a new in-flight one');
  });

  // The synced/derive refusals are more specific than the in-flight ones and
  // must keep winning even when the row is ALSO rendering — otherwise the new
  // arms would have silently re-ordered preflight's reporting.
  const syncedAndRendering = await call({ metaSyncStatus: 'synced', status: 'rendering' });
  check('C3 a synced ad that is also rendering still reports the synced 409', () => {
    assert.ok(syncedAndRendering.err, 'expected a throw');
    assert.strictEqual(syncedAndRendering.err.status, 409);
    assert.ok(SYNCED.test(msg(syncedAndRendering)),
      `precedence changed: ${msg(syncedAndRendering)}`);
  });

  const notFound = await call();
  currentRow = null;
  const missing = await (async () => {
    try { return { ad: await regen.preflight(AD_ID, BRAND_ID), err: null }; }
    catch (err) { return { ad: null, err }; }
  })();
  check('C4 a missing ad still 404s (the new arms cannot read a null row)', () => {
    assert.ok(notFound.ad, 'sanity: the default row should resolve');
    assert.ok(missing.err, 'expected a throw');
    assert.strictEqual(missing.err.status, 404, `status=${missing.err.status}`);
  });

  // A5 — the UNTAGGED titling shape. titlingResumeService.buildResumeFilter's
  // third arm sweeps a draft holding veoVideoUrl with renderUrl still null,
  // and those rows carry NO titlingResumeState stamp at all, so a guard
  // written only against pending|claimed lets a paid, untitled master be
  // re-bought while the resume is trying to finish it.
  const untagged = await call({
    status: 'draft', titlingResumeState: null,
    veoVideoUrl: 'https://cdn/master.mp4', renderUrl: null, kind: 'video'
  });
  check('A5 [MONEY] untagged resume shape (draft + veoVideoUrl, no renderUrl) is refused 409', () => {
    assert.ok(untagged.err, 'expected a throw — a pending|claimed-only guard resolves this');
    assert.strictEqual(untagged.err.status, 409, `status=${untagged.err.status}`);
    assert.ok(TITLING.test(msg(untagged)), `wrong branch: ${msg(untagged)}`);
  });
  // ...and its two near-misses must still resolve, so the arm is not a blanket
  // "draft video" refusal.
  const titledDraft = await call({
    status: 'draft', veoVideoUrl: 'https://cdn/master.mp4',
    renderUrl: 'https://cdn/titled.mp4', kind: 'video'
  });
  check('B5 a draft whose titling already produced a renderUrl RESOLVES', () => {
    assert.strictEqual(titledDraft.err, null, `threw: ${msg(titledDraft)}`);
  });
  const failedUntitled = await call({
    status: 'failed', veoVideoUrl: 'https://cdn/master.mp4', renderUrl: null, kind: 'video'
  });
  check('B6 a FAILED video holding an untitled master RESOLVES (resume is draft-only)', () => {
    assert.strictEqual(failedUntitled.err, null, `threw: ${msg(failedUntitled)}`);
  });
  const archived = await call({ status: 'archived' });
  check('B7 status:archived RESOLVES (unchanged — a denylist guard would block it)', () => {
    assert.strictEqual(archived.err, null, `threw: ${msg(archived)}`);
  });

  // C5 — precedence against the OTHER money gate. resolveDeriveFromMaster is
  // stubbed to null everywhere else in this harness, so without this check a
  // reorder that put the in-flight arms above the derive-only refusal would
  // send an operator to "wait for the render" instead of "regenerate the
  // master", and nothing here would notice.
  const CAGS = require.resolve('../services/campaignAdsGenerationService');
  const savedCags = require.cache[CAGS];
  const deriveOnly = await (async () => {
    for (const m of [SVC, AD, MEDIA, BRAND, RUN, BSE, CLOUD, DI, CAGS, SUS]) {
      delete require.cache[m];
    }
    stub(AD, { findOne() { return { lean: async () => currentRow }; } });
    stub(MEDIA, {}); stub(BRAND, {}); stub(RUN, {}); stub(BSE, {});
    stub(CLOUD, { uploadBufferToCloudinary: async () => {} }); stub(DI, {});
    stub(CAGS, { resolveDeriveFromMaster: () => 'meta_stories_9_16' });
    stub(SUS, { isUgcFirstSeedingEnabled: () => false });
    const r = require(SVC);
    currentRow = row({ status: 'rendering', platformFormat: 'pmax_video_1_1', kind: 'video' });
    try { return { ad: await r.preflight(AD_ID, BRAND_ID), err: null }; }
    catch (err) { return { ad: null, err }; }
  })();
  check('C5 a derive-only ad that is ALSO rendering still reports the derive-only 409', () => {
    assert.ok(deriveOnly.err, 'expected a throw');
    assert.strictEqual(deriveOnly.err.status, 409);
    assert.ok(/derived from the already-paid/i.test(msg(deriveOnly)),
      `precedence changed — operator sent to the wrong remedy: ${msg(deriveOnly)}`);
    assert.ok(!RENDERING.test(msg(deriveOnly)), 'in-flight arm must not outrank derive-only');
  });
  require.cache[CAGS] = savedCags;

  // C6 — cap displacement, stated rather than discovered later. An ad that is
  // both over DAILY_CAP and in flight now reports the in-flight 409, not 429.
  const overCapAndRendering = await call({
    status: 'rendering',
    regenerationHistory: Array.from({ length: 50 }, () => ({ at: new Date(), status: 'done' }))
  });
  check('C6 in-flight + over daily cap reports the in-flight 409 (not 429)', () => {
    assert.ok(overCapAndRendering.err);
    assert.strictEqual(overCapAndRendering.err.status, 409,
      `got ${overCapAndRendering.err.status} — the cap now shadows the money guard`);
    assert.ok(RENDERING.test(msg(overCapAndRendering)));
  });

  // ── D. THE WRITE SIDE ────────────────────────────────────────────────
  // preflight is a `.lean()` READ and every caller answers 202 then runs
  // regenerateAd from setImmediate. A read-side-only guard therefore leaves a
  // window in which the row enters an in-flight state between the check and
  // the spend. `regenerating` has always been enforced on the lock filter too;
  // these checks prove the new predicates are, by evaluating the REAL exported
  // filter — not by grepping for it.
  const { notInFlight, NOT_IN_FLIGHT_AND } = regen;

  // A deliberately small Mongo evaluator covering exactly the operators the
  // filter uses. Absent fields read as null, matching Mongo.
  function matchClause(doc, clause) {
    return Object.entries(clause).every(([k, v]) => {
      if (k === '$nor') return !v.some(c => matchClause(doc, c));
      if (k === '$and') return v.every(c => matchClause(doc, c));
      const actual = doc[k] === undefined ? null : doc[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.entries(v).every(([op, operand]) => {
          if (op === '$nin') return !operand.includes(actual);
          if (op === '$in')  return operand.includes(actual);
          if (op === '$ne')  return actual !== operand;
          throw new Error(`evaluator missing operator ${op}`);
        });
      }
      return actual === v;
    });
  }
  const lockMatches = (over) => matchClause(
    row(over), notInFlight({ _id: AD_ID, regenerating: { $ne: true } })
  );

  check('D0 the exported lock filter composes $and (never spread-drops a caller clause)', () => {
    const composed = notInFlight({ _id: AD_ID, $and: [{ marker: 1 }] });
    assert.ok(composed.$and.some(c => c.marker === 1), 'caller $and was dropped');
    assert.strictEqual(composed.$and.length, 1 + NOT_IN_FLIGHT_AND.length);
  });
  check('D1 [MONEY] the lock does NOT match a row that went rendering after preflight', () => {
    assert.strictEqual(lockMatches({ status: 'rendering' }), false);
  });
  check('D2 [MONEY] the lock does NOT match a row that went queued after preflight', () => {
    assert.strictEqual(lockMatches({ status: 'queued' }), false);
  });
  check('D3 [MONEY] the lock does NOT match a row claimed by titling after preflight', () => {
    assert.strictEqual(lockMatches({ status: 'draft', titlingResumeState: 'claimed' }), false);
    assert.strictEqual(lockMatches({ status: 'draft', titlingResumeState: 'pending' }), false);
  });
  check('D4 [MONEY] the lock does NOT match the untagged resume shape', () => {
    assert.strictEqual(lockMatches({
      status: 'draft', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: null
    }), false);
  });
  check('D5 the lock STILL matches every legitimately regenerable row', () => {
    for (const over of [
      { status: 'draft' },
      { status: 'live' },
      { status: 'failed' },
      { status: 'archived' },
      { status: 'failed', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: null },
      { status: 'draft', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: 'https://cdn/t.mp4' },
      { status: 'draft', titlingResumeState: null }
    ]) {
      assert.strictEqual(lockMatches(over), true,
        `lock over-blocks ${JSON.stringify(over)} — legitimate regenerates would silently no-op`);
    }
  });
  check('D6 read side and write side agree on every shape (no drift between the twins)', () => {
    for (const over of [
      { status: 'rendering' }, { status: 'queued' },
      { status: 'draft', titlingResumeState: 'pending' },
      { status: 'draft', titlingResumeState: 'claimed' },
      { status: 'draft', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: null },
      { status: 'draft' }, { status: 'live' }, { status: 'failed' }, { status: 'archived' },
      { status: 'draft', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: 'https://cdn/t.mp4' },
      { status: 'failed', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: null }
    ]) {
      const readRefuses  = regen.inFlightRefusal(row(over)) !== null;
      const writeRefuses = !lockMatches(over);
      assert.strictEqual(readRefuses, writeRefuses,
        `read/write disagree on ${JSON.stringify(over)}: read=${readRefuses} write=${writeRefuses}`);
    }
  });

  // D7/D8 — WIRING, not just correctness. D0-D6 prove the exported filter is
  // right; they would ALL stay green if regenerateAd stopped calling it, which
  // is the `receiptFree` lesson this repo already shipped to production once
  // (CLAUDE.md §4: a harness asserting a call site uses a helper must also
  // assert the call site actually uses it). So these drive the REAL
  // regenerateAd and evaluate the filter it genuinely passes to Ad.updateOne.
  const lockCalls = [];
  function installLockProbe(dbRow) {
    for (const m of [SVC, AD, MEDIA, BRAND, RUN, BSE, CLOUD, DI, CAGS, SUS]) {
      delete require.cache[m];
    }
    stub(AD, {
      findOne() { return { lean: async () => currentRow }; },
      // The lock is the FIRST updateOne regenerateAd issues. Evaluate its real
      // filter against the row as the DB now holds it.
      async updateOne(filter) {
        lockCalls.push(filter);
        const matched = lockCalls.length === 1 ? matchClause(dbRow, filter) : true;
        return { modifiedCount: matched ? 1 : 0 };
      }
    });
    stub(MEDIA, {}); stub(BRAND, {}); stub(RUN, {}); stub(BSE, {});
    stub(CLOUD, { uploadBufferToCloudinary: async () => {} }); stub(DI, {});
    stub(CAGS, { resolveDeriveFromMaster: () => null });
    stub(SUS, { isUgcFirstSeedingEnabled: () => false });
    return require(SVC);
  }

  // The TOCTOU case: preflight saw a clean draft, then claimAdsForRun flipped
  // the row to rendering before regenerateAd got the lock.
  lockCalls.length = 0;
  const raced = installLockProbe(row({ status: 'rendering' }));
  const adAtPreflight = row({ status: 'draft' });
  await raced.regenerateAd({ ad: adAtPreflight, prompt: 'x', mode: 'full', requestedBy: 't' })
    .catch(() => {});
  check('D7 [MONEY] regenerateAd ACTUALLY passes the in-flight filter to its lock', () => {
    assert.ok(lockCalls.length >= 1, 'regenerateAd issued no lock write at all');
    const f = lockCalls[0];
    assert.ok(Array.isArray(f.$and) && f.$and.length,
      'the lock filter carries no $and — notInFlight() is not wired into it');
    assert.strictEqual(matchClause(row({ status: 'rendering' }), f), false,
      'the REAL lock filter still matches a rendering row — the guard is read-side only');
    assert.strictEqual(matchClause(row({ status: 'queued' }), f), false,
      'the REAL lock filter still matches a queued row');
    assert.strictEqual(matchClause(row({ status: 'draft', titlingResumeState: 'claimed' }), f), false,
      'the REAL lock filter still matches a titling-claimed row');
    assert.strictEqual(
      matchClause(row({ status: 'draft', veoVideoUrl: 'https://cdn/m.mp4', renderUrl: null }), f), false,
      'the REAL lock filter still matches the untagged resume shape');
  });
  check('D8 [MONEY] losing that race stops the run BEFORE any further write', () => {
    assert.strictEqual(lockCalls.length, 1,
      `regenerateAd kept going after losing the lock (${lockCalls.length} writes) — it must return early`);
  });
  check('D9 the lock is still WINNABLE on a legitimately regenerable row', () => {
    assert.strictEqual(matchClause(row({ status: 'draft' }), lockCalls[0]), true,
      'the real lock filter refuses a plain draft — every regenerate would silently no-op');
    assert.strictEqual(matchClause(row({ status: 'failed' }), lockCalls[0]), true);
  });

  // ── E. MERGE-ORDER GUARD — completeness is a property of the BASE ─────
  //
  // Everything above tests THIS diff. This group goes red on a regression
  // introduced by SOMEONE ELSE'S merge, which nothing above can see.
  //
  // The guard is an EXCLUSION list (`$nin: ['rendering','queued']`,
  // `$nin: ['pending','claimed']`). That shape is silently incomplete the
  // moment another PR adds a new Ad.status or titlingResumeState value
  // meaning "in flight": the new value is not in the exclusion list, so the
  // guard permits it, the double-bill reopens, and every check above stays
  // GREEN because none of them knows the enum grew.
  //
  // So the enum is asserted against an EXPLICIT classification of every
  // known value. A rebase that adds a status fails E1 and forces whoever
  // added it to declare which side of the money guard it falls on. Read from
  // the REAL compiled schema, not from the source text or from this file's
  // stub — mongoose compiles it with no DB connection.
  const REAL_AD = (() => {
    delete require.cache[AD];
    return require('../models/Ad');
  })();

  // status → must the in-flight guard REFUSE it?
  const STATUS_VERDICT = {
    queued:    true,   // pre-submit; claimAdsForRun will claim and render it
    rendering: true,   // the initial render's own claim
    draft:     false,  // a SUCCESSFUL first render — the feature's main input
    live:      false,  // approved/promoted; still regenerable
    archived:  false,  // not in-flight work; selectAdsForRun is queued-only
    failed:    false   // the other main input; must never be blocked
  };
  const TITLING_VERDICT = { pending: true, claimed: true, null: false };

  check('E1 [MERGE-ORDER] Ad.status enum is exactly the set this guard classifies', () => {
    const real = REAL_AD.schema.path('status').enumValues.slice().sort();
    const known = Object.keys(STATUS_VERDICT).sort();
    assert.deepStrictEqual(real, known,
      `Ad.status changed under this guard.\n  schema: ${JSON.stringify(real)}\n  classified: ${JSON.stringify(known)}\n`
      + '  A NEW status is not in the guard\'s $nin exclusion list, so it is PERMITTED by default.\n'
      + '  Decide whether it is in-flight (add it to both halves + STATUS_VERDICT) or not (STATUS_VERDICT only).');
  });
  check('E2 [MERGE-ORDER] titlingResumeState enum is exactly the set this guard classifies', () => {
    const real = REAL_AD.schema.path('titlingResumeState').enumValues
      .map(v => String(v)).sort();
    const known = Object.keys(TITLING_VERDICT).sort();
    assert.deepStrictEqual(real, known,
      `titlingResumeState changed under this guard: ${JSON.stringify(real)} vs ${JSON.stringify(known)}\n`
      + '  A new titling state is PERMITTED by default — see E1.');
  });
  check('E3 [MERGE-ORDER] both halves still agree with the declared verdict for every status', () => {
    for (const [status, mustRefuse] of Object.entries(STATUS_VERDICT)) {
      const readRefuses  = regen.inFlightRefusal(row({ status })) !== null;
      const writeRefuses = !lockMatches({ status });
      assert.strictEqual(readRefuses, mustRefuse,
        `read side disagrees on status:'${status}' (refuses=${readRefuses}, declared=${mustRefuse})`);
      assert.strictEqual(writeRefuses, mustRefuse,
        `write side disagrees on status:'${status}' (refuses=${writeRefuses}, declared=${mustRefuse})`);
    }
  });
  check('E4 [MERGE-ORDER] the guard still covers the schema fields it reads', () => {
    for (const f of ['status', 'titlingResumeState', 'veoVideoUrl', 'renderUrl', 'regenerating']) {
      assert.ok(REAL_AD.schema.path(f), `Ad.${f} no longer exists — the guard reads a field that is gone`);
    }
  });

  // E5 — the CROSS-FILE coupling. The `queued` and `rendering` arms exist
  // because of a mechanism in another file: claimAdsForRun's atomic
  // `{status:'queued'}` -> `'rendering'` claim. If a rebase moves that claim
  // to a different source status, those two arms stop guarding the thing
  // their comment says they guard, and nothing else here would notice.
  check('E5 [MERGE-ORDER] claimAdsForRun still claims queued -> rendering', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
    const i = src.indexOf('async function claimAdsForRun(');
    assert.ok(i > 0, 'claimAdsForRun is gone from routes/ads.js — re-derive the guard\'s premise');
    const body = src.slice(i, src.indexOf('\n}\n', i));

    // Bound the slice to the CLAIM STATEMENT, not the whole function. The
    // function body also contains a `status: 'queued'` in its CLAIM ANOMALY
    // release path, so a body-wide regex passes even when the claim itself has
    // moved to a different source status — that false negative was caught by
    // mutating the filter and watching this check stay green.
    const claimStart = body.indexOf('const writeResult = await ads.updateMany(');
    assert.ok(claimStart > 0,
      'the atomic claim statement (const writeResult = await ads.updateMany) is gone — re-derive the premise');
    const claimEnd = body.indexOf('\n  );', claimStart);
    assert.ok(claimEnd > claimStart, 'could not bound the claim statement — its shape changed');
    const claim = body.slice(claimStart, claimEnd);

    assert.ok(/status:\s*'queued'/.test(claim),
      'the mint claim no longer FILTERS on status:\'queued\' — the queued arm of the in-flight guard '
      + 'no longer guards the mechanism its comment cites. Re-derive both arms against the new claim.');
    assert.ok(/selectedIds/.test(claim),
      'the mint claim no longer keys on selectedIds — its shape changed under the guard');
    assert.ok(/\$set:\s*\{[^{}]*status:\s*'rendering'/.test(claim),
      'the mint claim no longer SETS status:\'rendering\' — the rendering arm\'s premise moved');
  });

  console.log(`\n${fail ? '❌' : '✅'} verifyRegeneratePreflightInflight: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness error:', e); process.exit(1); });
