#!/usr/bin/env node
'use strict';
//
// verifyRunsClaim — guards the atomic claim on POST /api/ads/runs AND
// POST /api/ads/generate (2026-08-18: /generate now routes through the same
// function; see group I).
//
// Atlas generation POSTs are billable ON SUBMIT. /runs must claim ads with
// `status: 'queued'` in the updateMany filter (exactly like /generate) and
// re-read what it actually won before creating a CampaignRun or starting the
// render loop. Without that filter, two concurrent /runs — or a /runs racing
// a /generate — both render the same ads = double charge.
//
// STRUCTURAL GUARANTEE: this harness drives claimAdsForRun — the SAME function
// the live POST /runs handler, the stranded-sweep requeue, AND (as of
// 2026-08-18) POST /generate all call. It does NOT test a parallel Map-backed
// model the routes never use. That false-confidence pattern is what let two
// double-charge regressions ship green (rebind renderIds to selectedIds;
// gut the re-read ownership filters). Both of those now fail behaviourally.
//
// /generate USED TO inline a second copy of this claim with no anomaly
// branch: when updateMany reported a write but the ownership re-read came
// back empty (concurrent interference — modifiedCount > 0, 0 rows re-read),
// /runs releases and fails honestly, but /generate folded that shape into the
// ordinary "claimed by a concurrent run" outcome and never released the ads
// — they sat status:'rendering' until the 15-minute reaper. CLAUDE.md §2:
// "do not inline a second claim path." Group I pins that /generate now calls
// the shared function and handles the anomaly branch distinctly.
//
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyRunsClaim.js
//
// Revert-prove:
//   (a) rebind renderIds to selectedIds in the /runs handler → H5/H7 fail
//   (b) gut re-read ownership filters in claimAdsForRun → A/E concurrent fail
//   (c) revert /generate to its old inline claim (no claimAdsForRun call,
//       no anomaly branch) → I3/I4/I5/I6/I7/I8 fail
//   (d) keep the claimAdsForRun call in /generate but drop only its
//       `claim.kind === 'anomaly'` branch → I5/I6/I8 fail (I3/I4/I7 still
//       pass — they pin the call itself, independent of the anomaly handling)
//   (e) [ADVERSARIAL REVIEW FINDING] revert /generate to the old inline claim
//       while LEAVING the "Use claimAdsForRun() only:" comment above it in
//       place → I3-I8 still correctly fail (group I strips comments before
//       matching, and I3/I8 require `await claimAdsForRun(`, not the bare
//       identifier a comment can also contain) — a naive uncommented regex
//       would have false-passed I3 on this exact mutation

const fs = require('fs');
const path = require('path');

const adsRouter = require('../routes/ads');
const { claimAdsForRun } = adsRouter;

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) || actual === expected;
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${cond}`);
}

function deepEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a, e);
}

// ── In-memory Ad access matching Mongo claim filter semantics ─────────
// Implements the subset of updateMany / find that claimAdsForRun uses:
//   - filter: { _id: { $in }, status?, campaignRunIds? }
//   - update: { $addToSet: { campaignRunIds }, $set: { status, updatedAt } }
//             or { $set: { status, updatedAt } } for release
// Bare campaignRunIds: value matches Mongo "array contains value".
function makeStore(ids, status = 'queued') {
  const store = new Map();
  for (const id of ids) {
    store.set(String(id), { status, campaignRunIds: [] });
  }
  return store;
}

function matchesFilter(ad, filter) {
  if (filter.status != null && ad.status !== filter.status) return false;
  if (filter.campaignRunIds != null) {
    if (!Array.isArray(ad.campaignRunIds) || !ad.campaignRunIds.includes(filter.campaignRunIds)) {
      return false;
    }
  }
  return true;
}

function makeAdsAccess(store) {
  return {
    async updateMany(filter, update) {
      const ids = (filter._id && filter._id.$in) ? filter._id.$in : [];
      let modifiedCount = 0;
      for (const raw of ids) {
        const id = String(raw);
        const ad = store.get(id);
        if (!ad) continue;
        if (!matchesFilter(ad, filter)) continue;
        if (update.$set) {
          if (update.$set.status != null) ad.status = update.$set.status;
          if (update.$set.updatedAt != null) ad.updatedAt = update.$set.updatedAt;
        }
        if (update.$addToSet && update.$addToSet.campaignRunIds != null) {
          const rid = update.$addToSet.campaignRunIds;
          if (!Array.isArray(ad.campaignRunIds)) ad.campaignRunIds = [];
          if (!ad.campaignRunIds.includes(rid)) ad.campaignRunIds.push(rid);
        }
        modifiedCount++;
      }
      return { modifiedCount };
    },
    async find(filter) {
      const ids = (filter._id && filter._id.$in) ? filter._id.$in : [];
      const out = [];
      for (const raw of ids) {
        const id = String(raw);
        const ad = store.get(id);
        if (!ad) continue;
        if (!matchesFilter(ad, filter)) continue;
        out.push({ _id: id });
      }
      return out;
    }
  };
}

async function main() {
  // ── A. Two concurrent claims → exactly ONE winner per ad ───────────
  // Both handlers selected the same ids; each runs claimAdsForRun (the live
  // function). The second claim's status filter matches nothing, re-read
  // confirms zero, kind:'empty' / 422.
  {
    const ids = ['a1', 'a2', 'a3'];
    const store = makeStore(ids);
    const ads = makeAdsAccess(store);

    const claimA = await claimAdsForRun(ads, { selectedIds: ids, runId: 'run_A' });
    const claimB = await claimAdsForRun(ads, { selectedIds: ids, runId: 'run_B' });

    check('A1 first claim kind ok', claimA.kind, 'ok');
    check('A2 first claim → 202', claimA.httpStatus, 202);
    deepEq('A3 first claim wins all selected', claimA.renderIds, ids);
    check('A4 first claim total is selected length', claimA.total, ids.length);
    check('A5 first claim startRenderLoop', claimA.startRenderLoop, true);

    check('A6 second claim kind empty', claimB.kind, 'empty');
    check('A7 second claim → 422', claimB.httpStatus, 422);
    deepEq('A8 second claim wins nothing', claimB.renderIds, []);
    check('A9 second claim does not start render loop', claimB.startRenderLoop, false);
    check('A10 second claim does not create CampaignRun', claimB.createCampaignRun, false);
    checkTrue('A11 second claim carries ordinary empty-claim message',
      typeof claimB.error === 'string' && /claimed by another run/i.test(claimB.error));

    check('A12 every ad owned by exactly one run',
      ids.every((id) => {
        const ad = store.get(id);
        return ad.status === 'rendering' &&
          ad.campaignRunIds.length === 1 &&
          ad.campaignRunIds[0] === 'run_A';
      }),
      true
    );
    check('A13 no ad carries both run ids (double ownership = double bill)',
      ids.every((id) => !store.get(id).campaignRunIds.includes('run_B')),
      true
    );
  }

  // ── B. Empty claim is 422, not 202, and not the anomaly path ───────
  {
    const store = makeStore(['x']);
    // Pre-claim for someone else so this run wins nothing.
    await claimAdsForRun(makeAdsAccess(store), { selectedIds: ['x'], runId: 'other' });
    const claim = await claimAdsForRun(makeAdsAccess(store), {
      selectedIds: ['x'],
      runId: 'loser'
    });
    check('B1 empty claim → 422', claim.httpStatus, 422);
    check('B2 empty claim kind', claim.kind, 'empty');
    check('B3 empty claim does not create CampaignRun', claim.createCampaignRun, false);
    check('B4 empty claim does not start render loop', claim.startRenderLoop, false);
    check('B5 empty claim total is 0', claim.total, 0);
    deepEq('B6 empty claim renderIds is []', claim.renderIds, []);
    checkTrue('B7 empty claim is NOT the anomaly message',
      typeof claim.error === 'string' &&
        /claimed by another run/i.test(claim.error) &&
        !/could not be confirmed/i.test(claim.error));
    check('B8 modifiedCount is 0 on normal empty claim', claim.modifiedCount, 0);
  }

  // ── C. total / renderIds reflect CLAIMED count, not SELECTED ────────
  // Shared store: run_A already owns a2; run_B selected a1+a2+a3.
  {
    const store = makeStore(['a1', 'a2', 'a3']);
    await claimAdsForRun(makeAdsAccess(store), { selectedIds: ['a2'], runId: 'run_A' });
    const claimB = await claimAdsForRun(makeAdsAccess(store), {
      selectedIds: ['a1', 'a2', 'a3'],
      runId: 'run_B'
    });
    check('C1 partial claim → 202', claimB.httpStatus, 202);
    check('C2 kind ok', claimB.kind, 'ok');
    check('C3 total is claimed length, not selected length', claimB.total, 2);
    checkTrue('C4 total is NOT selected length (the bug)', claimB.total !== 3);
    deepEq('C5 renderIds are the claimed set only', claimB.renderIds, ['a1', 'a3']);
    checkTrue('C6 renderIds never includes the lost ad a2', !claimB.renderIds.includes('a2'));
    check('C7 createCampaignRun on partial win', claimB.createCampaignRun, true);
    check('C8 startRenderLoop on partial win', claimB.startRenderLoop, true);
    check('C9 a2 still owned solely by run_A', store.get('a2').campaignRunIds.join(','), 'run_A');
    check('C10 a1 owned by run_B', store.get('a1').campaignRunIds.join(','), 'run_B');
    check('C11 a3 owned by run_B', store.get('a3').campaignRunIds.join(','), 'run_B');
  }

  // ── D. Full claim happy path ───────────────────────────────────────
  {
    const selected = ['x', 'y'];
    const store = makeStore(selected);
    const claim = await claimAdsForRun(makeAdsAccess(store), {
      selectedIds: selected,
      runId: 'run_Z'
    });
    check('D1 full claim → 202', claim.httpStatus, 202);
    check('D2 total equals selected when all won', claim.total, selected.length);
    deepEq('D3 renderIds equals selected when all won', claim.renderIds, selected);
    deepEq('D4 claimedIds equals renderIds', claim.claimedIds, claim.renderIds);
    check('D5 startRenderLoop true', claim.startRenderLoop, true);
    check('D6 modifiedCount equals claimed', claim.modifiedCount, 2);
  }

  // ── E. Gutted re-read ownership filters = double-charge (regression b)
  // Behavioural: if the re-read dropped status/campaignRunIds filters, the
  // loser of a concurrent claim would "claim" the winner's ads and return
  // them as renderIds. This group fails hard if that regression lands.
  {
    const ids = ['e1', 'e2'];
    const store = makeStore(ids);
    const ads = makeAdsAccess(store);
    const win = await claimAdsForRun(ads, { selectedIds: ids, runId: 'run_win' });
    const lose = await claimAdsForRun(ads, { selectedIds: ids, runId: 'run_lose' });

    check('E1 winner got the ads', win.kind, 'ok');
    deepEq('E2 winner renderIds are the full set', win.renderIds, ids);
    check('E3 loser must be empty (ownership re-read is load-bearing)', lose.kind, 'empty');
    deepEq('E4 loser renderIds must be [] — non-empty means double bill', lose.renderIds, []);
    check('E5 loser httpStatus 422', lose.httpStatus, 422);
    // Store integrity: only winner owns each ad
    checkTrue('E6 no ad owned by loser',
      ids.every((id) => !store.get(id).campaignRunIds.includes('run_lose')));
  }

  // ── F. modifiedCount vs empty re-read → anomaly, not ordinary 422 ──
  // Drive a fake that reports modifiedCount > 0 but returns no ownership rows.
  {
    let released = false;
    const anomalousAds = {
      async updateMany(filter, update) {
        // First call is the claim write; second is anomaly release.
        if (update.$addToSet) {
          return { modifiedCount: 2 };
        }
        // Release path: must re-filter status rendering + our runId
        checkTrue('F1 anomaly release filters status rendering',
          filter.status === 'rendering');
        checkTrue('F2 anomaly release filters campaignRunIds to this run',
          filter.campaignRunIds === 'run_anom');
        released = true;
        return { modifiedCount: 0 };
      },
      async find() {
        return []; // ownership re-read empty despite modifiedCount > 0
      }
    };
    const claim = await claimAdsForRun(anomalousAds, {
      selectedIds: ['p', 'q'],
      runId: 'run_anom'
    });
    check('F3 anomaly kind', claim.kind, 'anomaly');
    check('F4 anomaly httpStatus is NOT 422', claim.httpStatus, 500);
    checkTrue('F5 anomaly error says claim could not be confirmed',
      typeof claim.error === 'string' && /could not be confirmed/i.test(claim.error));
    checkTrue('F6 anomaly error is NOT the ordinary "another run" message',
      typeof claim.error === 'string' && !/claimed by another run/i.test(claim.error));
    check('F7 anomaly does not start render loop', claim.startRenderLoop, false);
    check('F8 anomaly does not create CampaignRun', claim.createCampaignRun, false);
    deepEq('F9 anomaly renderIds empty', claim.renderIds, []);
    check('F10 anomaly attempted release', released, true);
    check('F11 anomaly surfaces modifiedCount', claim.modifiedCount, 2);
  }

  // ── G. Normal empty claim does NOT look like anomaly ──────────────
  {
    const silentAds = {
      async updateMany() { return { modifiedCount: 0 }; },
      async find() { return []; }
    };
    const claim = await claimAdsForRun(silentAds, {
      selectedIds: ['z'],
      runId: 'run_quiet'
    });
    check('G1 modifiedCount 0 + empty re-read → empty not anomaly', claim.kind, 'empty');
    check('G2 → 422', claim.httpStatus, 422);
    checkTrue('G3 ordinary another-run message',
      /claimed by another run/i.test(claim.error || ''));
  }

  // ── H. Wiring: POST /runs calls the live function (not a fork) ─────
  // These cannot be expressed purely behaviourally without spinning Express
  // + Mongo. They pin that the production handler has not been decoupled
  // from claimAdsForRun, and that renderIds cannot be rebound to selectedIds
  // without this harness failing (regression a).
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
    const start = src.indexOf("router.post('/runs'");
    checkTrue('H1 POST /runs handler exists', start >= 0);
    const end = src.indexOf('async function runRenderLoop', start);
    checkTrue('H2 runRenderLoop follows /runs', end > start);
    const block = src.slice(start, end);

    // Live path must invoke claimAdsForRun (not a reimplemented claim).
    checkTrue(
      'H3 /runs calls claimAdsForRun (same function this harness drives)',
      /claimAdsForRun\s*\(/.test(block)
    );

    // CampaignRun.total must use claim.total (claimed), not selected length.
    checkTrue(
      'H4 /runs CampaignRun.total uses claim.total (claimed count)',
      /total:\s*claim\.total/.test(block)
    );

    // renderIds MUST come from claim.renderIds. Rebinding to selectedIds
    // (regression a) is the double-charge that used to ship green.
    checkTrue(
      'H5 /runs binds renderIds from claim.renderIds (not selectedIds)',
      /const\s+renderIds\s*=\s*claim\.renderIds/.test(block)
    );
    checkTrue(
      'H6 /runs runRenderLoop receives renderIds (claimed set)',
      /runRenderLoop\(\s*run,\s*job,\s*renderIds/.test(block)
    );
    // Explicit anti-regression: the bad rebind must not appear.
    check(
      'H7 /runs does not rebind renderIds = selectedIds (double-charge bug a)',
      /const\s+renderIds\s*=\s*selectedIds/.test(block),
      false
    );

    // Post-claim throw must requeue claimed ads (item 2) — mirrors /generate.
    // Behavioural exercise of the catch needs Express; pin the release write.
    checkTrue(
      'H8 /runs catch requeues claimed ads (status rendering → queued)',
      /claimedIds/.test(block) &&
        /status:\s*'rendering'/.test(block) &&
        /status:\s*'queued'/.test(block) &&
        /catch\s*\(\s*err\s*\)/.test(block)
    );

    // 422 / anomaly before 202: claim resolution precedes the 202 response.
    // (An earlier 422 for empty selection is unrelated — look only after claim.)
    checkTrue(
      'H9 /runs resolves claim (422/anomaly) before status(202)',
      (() => {
        const claimAt = block.search(/claimAdsForRun\s*\(/);
        if (claimAt < 0) return false;
        const after = block.slice(claimAt);
        const r422 = after.search(/status\(\s*422\s*\)/);
        const anomaly = after.search(/kind\s*===\s*['"]anomaly['"]/);
        const r202 = after.search(/status\(\s*202\s*\)/);
        return r422 >= 0 && anomaly >= 0 && r202 > r422 && r202 > anomaly;
      })()
    );
  }

  // ── I. Wiring: POST /generate calls the live function too (not a second
  // inline claim path) ────────────────────────────────────────────────
  // 2026-08-18 fix. /generate used to inline its OWN claim (updateMany +
  // re-read) with no anomaly branch: when updateMany reported a write but the
  // ownership re-read came back empty (concurrent interference), those ads
  // sat status:'rendering' forever — the exact shape /runs's anomaly branch
  // (group F above) exists to catch and release. CLAUDE.md §2: "Use
  // claimAdsForRun() only ... do not inline a second claim path" — this was
  // that second path. It now calls the SAME claimAdsForRun this whole file
  // drives, so groups A-G already cover its claim behaviour; these checks
  // pin the WIRING (that the route was not decoupled from the shared fn).
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');
    const start = src.indexOf("router.post('/generate'");
    checkTrue('I1 POST /generate handler exists', start >= 0);
    const end = src.indexOf('async function claimAdsForRun', start);
    checkTrue('I2 claimAdsForRun is defined after /generate (block below is /generate only)', end > start);
    const block = src.slice(start, end);
    // COMMENTS STRIPPED before every match below. This whole section pins the
    // WIRING via source text, and this file's own explanatory comments name
    // the very things they check for (e.g. "Use claimAdsForRun() only:" would
    // satisfy a naive /claimAdsForRun\s*\(/ test even if the real call were
    // deleted — caught in adversarial review of this harness itself, same
    // lesson as verifyPmaxVideoExpansion.js / verifyNoStrandedQueued.js).
    const blockCode = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    // Live path must invoke claimAdsForRun (not a reimplemented claim).
    // Matches `await claimAdsForRun(` specifically, not just the bare
    // identifier — belt and suspenders on top of the comment strip.
    checkTrue(
      'I3 /generate calls claimAdsForRun (same function this harness drives)',
      /await\s+claimAdsForRun\s*\(/.test(blockCode)
    );

    // Explicit anti-regression: the OLD inline claim shape must not reappear
    // inside /generate's own block, in EITHER of its two possible forms —
    // the original `$addToSet` write, or a `$push` to campaignRunIds, which
    // would sneak a second claim path past the narrower check (a $push here
    // is never legitimate: the shared claimAdsForRun always $addToSet's, so
    // any $push to this field inside /generate's own code is a reimplemented
    // write). claimAdsForRun's definition sits AFTER `end`, so any match
    // inside `blockCode` is a genuine second copy, not the shared function.
    check(
      'I4 [MONEY] /generate does not inline a second claim '
      + "(no local status:'queued' + $addToSet/$push write on campaignRunIds)",
      /\$addToSet:\s*\{\s*campaignRunIds:\s*runId\s*\}/.test(blockCode)
        || /\$push:\s*\{\s*campaignRunIds:/.test(blockCode),
      false
    );

    // claim.kind === 'anomaly' must be handled, and handled distinctly from
    // the ordinary "claimed by a concurrent run" outcome — that distinction
    // is the entire point of this fix.
    checkTrue(
      'I5 /generate branches on claim.kind === \'anomaly\'',
      /kind\s*===\s*['"]anomaly['"]/.test(blockCode)
    );
    checkTrue(
      'I6 the anomaly branch marks the run failed (not done — done is the ordinary empty-claim outcome)',
      (() => {
        const anomalyAt = blockCode.search(/kind\s*===\s*['"]anomaly['"]/);
        if (anomalyAt < 0) return false;
        // Scope to the branch's own body: from the `kind === 'anomaly'` test
        // to its closing `return;` (the first one after it) — that is
        // exactly the code this branch executes, no more and no less.
        const returnAt = blockCode.indexOf('return;', anomalyAt);
        if (returnAt < 0) return false;
        const branchBody = blockCode.slice(anomalyAt, returnAt);
        return /status:\s*'failed'/.test(branchBody) && !/status:\s*'done'/.test(branchBody);
      })()
    );

    // adIds MUST come from claim.claimedIds. Aliasing back to the pre-claim
    // selection (the same double-charge class as regression 'a' in the /runs
    // section) would defeat the whole point of routing through the shared fn.
    checkTrue(
      'I7 /generate binds adIds from claim.claimedIds (not the pre-claim selection)',
      /const\s+claimedIds\s*=\s*claim\.claimedIds/.test(blockCode) &&
        /adIds\s*=\s*claimedIds/.test(blockCode)
    );

    // Anomaly resolution must precede the ordinary empty-claim branch in
    // source order — otherwise an anomaly could fall through and be reported
    // as "claimed by another run" (the exact lie this fix removes).
    checkTrue(
      'I8 /generate resolves the anomaly branch before the ordinary empty-claim message',
      (() => {
        const claimAt = blockCode.search(/await\s+claimAdsForRun\s*\(/);
        const anomalyAt = blockCode.search(/kind\s*===\s*['"]anomaly['"]/);
        const ordinaryAt = blockCode.search(/All selected ads were claimed by a concurrent run/);
        return claimAt >= 0 && anomalyAt > claimAt && ordinaryAt > anomalyAt;
      })()
    );
  }

  // ── Report ──────────────────────────────────────────────────────────
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`\n❌ verifyRunsClaim: ${failures.length} of ${total} checks FAILED\n`);
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    console.error('A failure here means POST /runs may double-charge Atlas. Do not ship.\n');
    process.exit(1);
  }
  console.log(`✅ verifyRunsClaim: ${total}/${total} checks passed`);
  console.log('   claimAdsForRun (live fn): status:queued claim, ownership re-read,');
  console.log('   modifiedCount cross-check, 422 on empty, renderIds = claimed only.');
}

main().catch((err) => {
  console.error('verifyRunsClaim crashed:', err);
  process.exit(1);
});
