#!/usr/bin/env node
// Offline pins for the post-detect deferral + full-brand rematch design
// (2026-09-02). Two knobs and one path-selection: the env parsers must
// stay strict (a runaway '0' or 'off' can't silently opt in / out), and
// the full-vs-unmatched path selection MUST agree with the deferral
// flag so ops can't put the system into a mixed state where both the
// per-post detect fires AND the full rematch re-matches everything (a
// duplicate-pay pattern).
//
// Runs zero DB / zero network — the enqueue variants are exercised
// against tiny in-memory model stubs.

'use strict';

const assert = require('assert');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const svc = require('../services/postRematchAfterCatalogService');
const {
  isDeferPostDetectEnabled,
  postRematchPollMaxMs,
  enqueueRematchForAllPosts,
  enqueueRematchForUnmatchedPosts,
  __test: { UGC_SOURCES, POST_REMATCH_POLL_MAX_MS_DEFAULT, POLL_INTERVAL_MS, REMATCH_BATCH_LIMIT }
} = svc;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// ── SECTION A — isDeferPostDetectEnabled ─────────────────────────────

(async () => {
  console.log('\n== A. isDeferPostDetectEnabled — env parser ==');
  const prior = process.env.POST_DETECT_DEFER_TO_CATALOG;
  try {
    await check('A1 default (unset) → true', () => {
      delete process.env.POST_DETECT_DEFER_TO_CATALOG;
      assert.strictEqual(isDeferPostDetectEnabled(), true);
    });
    await check('A2 "true" → true', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = 'true';
      assert.strictEqual(isDeferPostDetectEnabled(), true);
    });
    await check('A3 "false" → false', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = 'false';
      assert.strictEqual(isDeferPostDetectEnabled(), false);
    });
    await check('A4 "0" → false', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = '0';
      assert.strictEqual(isDeferPostDetectEnabled(), false);
    });
    await check('A5 "off" → false', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = 'off';
      assert.strictEqual(isDeferPostDetectEnabled(), false);
    });
    await check('A6 mixed case "False" → false', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = 'False';
      assert.strictEqual(isDeferPostDetectEnabled(), false);
    });
    await check('A7 garbage → true (defaults on)', () => {
      process.env.POST_DETECT_DEFER_TO_CATALOG = 'maybe';
      assert.strictEqual(isDeferPostDetectEnabled(), true);
    });
  } finally {
    if (prior === undefined) delete process.env.POST_DETECT_DEFER_TO_CATALOG;
    else process.env.POST_DETECT_DEFER_TO_CATALOG = prior;
  }

  // ── SECTION B — postRematchPollMaxMs ────────────────────────────────

  console.log('\n== B. postRematchPollMaxMs — env parser + clamps ==');
  const priorPoll = process.env.POST_REMATCH_POLL_MAX_MS;
  try {
    await check('B1 default (unset) → 60 min', () => {
      delete process.env.POST_REMATCH_POLL_MAX_MS;
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B2 default constant matches expected 60 min', () => {
      assert.strictEqual(POST_REMATCH_POLL_MAX_MS_DEFAULT, 60 * 60 * 1000);
    });
    await check('B3 valid override respected', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = String(15 * 60 * 1000);
      assert.strictEqual(postRematchPollMaxMs(), 15 * 60 * 1000);
    });
    await check('B4 empty string → default', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = '';
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B5 negative → default (clamped)', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = '-1000';
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B6 below floor (30_000) → default', () => {
      // 30s poll ceiling is meaningless; catalog never drains that fast.
      process.env.POST_REMATCH_POLL_MAX_MS = '30000';
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B7 at floor (60_000) → respected', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = '60000';
      assert.strictEqual(postRematchPollMaxMs(), 60_000);
    });
    await check('B8 above ceiling (5h) → default', () => {
      // A runaway 24h ceiling hides real problems; cap at 4h.
      process.env.POST_REMATCH_POLL_MAX_MS = String(5 * 60 * 60 * 1000);
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B9 at ceiling (4h) → respected', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = String(4 * 60 * 60 * 1000);
      assert.strictEqual(postRematchPollMaxMs(), 4 * 60 * 60 * 1000);
    });
    await check('B10 garbage → default', () => {
      process.env.POST_REMATCH_POLL_MAX_MS = 'maybe';
      assert.strictEqual(postRematchPollMaxMs(), 60 * 60 * 1000);
    });
    await check('B11 float → parseInt truncation respected', () => {
      // parseInt gives us base-10 truncation. A caller who ships '90000.5'
      // should not silently round to a subtly-different ceiling.
      process.env.POST_REMATCH_POLL_MAX_MS = '90000.5';
      assert.strictEqual(postRematchPollMaxMs(), 90000);
    });
  } finally {
    if (priorPoll === undefined) delete process.env.POST_REMATCH_POLL_MAX_MS;
    else process.env.POST_REMATCH_POLL_MAX_MS = priorPoll;
  }

  // ── SECTION C — path selection (full=true vs full=false) ────────────
  //
  // enqueueRematchForAllPosts must include UGC media that already have
  // a strong match (the whole point of the deferred design's full-rematch);
  // enqueueRematchForUnmatchedPosts must exclude them (the whole point of
  // the legacy path's cost floor).
  //
  // Stubs are wired at the model prototype level via the shared module
  // cache so both functions see the SAME shape they see in production
  // (Model.find(...).select(...).lean() and Model.distinct(...)).

  console.log('\n== C. enqueue path selection ==');

  // Stub factories — one per test to avoid state bleed.
  const makeStubs = ({ ugcMedia, strongMatchIds = [] }) => {
    const createdRuns = [];

    // Media.find({ brandId, source: { $in: ... } }).select().lean()
    const MediaStub = {
      find(filter) {
        // Return only rows whose source ∈ filter's $in list
        const sourceIn = filter?.source?.$in || [];
        const rows = ugcMedia.filter(m => sourceIn.includes(m.source));
        return { select() { return { lean: async () => rows }; } };
      }
    };
    // ProductMatchArtifact.distinct('mediaId', { brandId, outcome: { $in: [...] } })
    const PmaStub = {
      async distinct() { return strongMatchIds; }
    };
    // DetectRun.create(...)
    const DetectRunStub = {
      async create(doc) {
        createdRuns.push(doc);
        return doc;
      }
    };

    // Replace the require cache entries so the functions we're testing
    // pick these up. Restored in a try/finally by the caller.
    const path = require('path');
    const mediaPath = require.resolve(path.join(__dirname, '..', 'models', 'Media'));
    const pmaPath = require.resolve(path.join(__dirname, '..', 'models', 'ProductMatchArtifact'));
    const drPath = require.resolve(path.join(__dirname, '..', 'models', 'DetectRun'));
    const originals = {
      media: require.cache[mediaPath],
      pma: require.cache[pmaPath],
      dr: require.cache[drPath]
    };
    require.cache[mediaPath] = { id: mediaPath, filename: mediaPath, loaded: true, exports: MediaStub };
    require.cache[pmaPath] = { id: pmaPath, filename: pmaPath, loaded: true, exports: PmaStub };
    require.cache[drPath] = { id: drPath, filename: drPath, loaded: true, exports: DetectRunStub };

    // Wipe the service from the cache so it re-requires its models
    // through our stubs on next require.
    const svcPath = require.resolve(path.join(__dirname, '..', 'services', 'postRematchAfterCatalogService'));
    delete require.cache[svcPath];

    return {
      createdRuns,
      restore() {
        if (originals.media) require.cache[mediaPath] = originals.media; else delete require.cache[mediaPath];
        if (originals.pma) require.cache[pmaPath] = originals.pma; else delete require.cache[pmaPath];
        if (originals.dr) require.cache[drPath] = originals.dr; else delete require.cache[drPath];
        delete require.cache[svcPath];
      }
    };
  };

  await check('C1 UGC_SOURCES includes both instagram and apify-ig', () => {
    assert.ok(UGC_SOURCES.includes('instagram'));
    assert.ok(UGC_SOURCES.includes('apify-ig'));
  });

  await check('C2 full=true enqueues EVERY UGC media (even already-matched)', async () => {
    const advertiserId = { toString: () => 'adv-1' };
    const brandId = { toString: () => 'brand-1' };
    const ugcMedia = [
      { _id: 'm1', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm2', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm3', advertiserId, brandId, source: 'instagram' }
    ];
    const strongMatchIds = ['m1']; // already matched — full=true still enqueues it
    const stubs = makeStubs({ ugcMedia, strongMatchIds });
    try {
      const svc2 = require('../services/postRematchAfterCatalogService');
      const r = await svc2.enqueueRematchForAllPosts({ brandId: 'brand-1' });
      assert.strictEqual(r.candidates, 3, 'all 3 UGC counted');
      assert.strictEqual(r.enqueued, 3, 'full=true enqueues every UGC, ignoring strong-match set');
      assert.strictEqual(stubs.createdRuns.length, 3);
      // Every created run must have the manual-rematch trigger + priority 1
      // (bumped above the deferred apify-sync so catalog-owner priority
      //  ordering still holds even when both paths coexist).
      for (const doc of stubs.createdRuns) {
        assert.strictEqual(doc.trigger, 'manual-rematch');
        assert.strictEqual(doc.priority, 1);
      }
    } finally { stubs.restore(); }
  });

  await check('C3 full=false SKIPS UGC media with a strong match', async () => {
    const advertiserId = { toString: () => 'adv-1' };
    const brandId = { toString: () => 'brand-1' };
    const ugcMedia = [
      { _id: 'm1', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm2', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm3', advertiserId, brandId, source: 'instagram' }
    ];
    const strongMatchIds = ['m1', 'm3']; // 2 matched → only m2 needs re-detect
    const stubs = makeStubs({ ugcMedia, strongMatchIds });
    try {
      const svc2 = require('../services/postRematchAfterCatalogService');
      const r = await svc2.enqueueRematchForUnmatchedPosts({ brandId: 'brand-1' });
      assert.strictEqual(r.candidates, 3, 'all UGC counted');
      assert.strictEqual(r.enqueued, 1, 'full=false only touches unmatched');
      assert.strictEqual(stubs.createdRuns.length, 1);
      assert.strictEqual(stubs.createdRuns[0].mediaId, 'm2');
    } finally { stubs.restore(); }
  });

  await check('C4 non-UGC sources (catalog-product, manual) are NEVER enqueued', async () => {
    const advertiserId = { toString: () => 'adv-1' };
    const brandId = { toString: () => 'brand-1' };
    const ugcMedia = [
      { _id: 'm1', advertiserId, brandId, source: 'catalog-product' },
      { _id: 'm2', advertiserId, brandId, source: 'manual' },
      { _id: 'm3', advertiserId, brandId, source: 'apify-ig' }
    ];
    const stubs = makeStubs({ ugcMedia, strongMatchIds: [] });
    try {
      const svc2 = require('../services/postRematchAfterCatalogService');
      const rAll = await svc2.enqueueRematchForAllPosts({ brandId: 'brand-1' });
      // Stub.find honours the $in filter, so only m3 (apify-ig) reaches
      // targets. Pins that the service passes the correct UGC_SOURCES
      // filter — a regression that widened the filter to include
      // catalog-product would run vision-match on our own catalog images,
      // which is nonsense and expensive.
      assert.strictEqual(rAll.candidates, 1);
      assert.strictEqual(rAll.enqueued, 1);
      assert.strictEqual(stubs.createdRuns[0].mediaId, 'm3');
    } finally { stubs.restore(); }
  });

  await check('C5 REMATCH_BATCH_LIMIT caps a huge brand', async () => {
    const advertiserId = { toString: () => 'adv-1' };
    const brandId = { toString: () => 'brand-1' };
    const ugcMedia = [];
    for (let i = 0; i < REMATCH_BATCH_LIMIT + 50; i++) {
      ugcMedia.push({ _id: `m${i}`, advertiserId, brandId, source: 'apify-ig' });
    }
    const stubs = makeStubs({ ugcMedia, strongMatchIds: [] });
    try {
      const svc2 = require('../services/postRematchAfterCatalogService');
      const rAll = await svc2.enqueueRematchForAllPosts({ brandId: 'brand-1' });
      assert.strictEqual(rAll.candidates, REMATCH_BATCH_LIMIT + 50, 'candidates counts the full set');
      assert.strictEqual(rAll.enqueued, REMATCH_BATCH_LIMIT, 'enqueue capped at REMATCH_BATCH_LIMIT');
      assert.strictEqual(stubs.createdRuns.length, REMATCH_BATCH_LIMIT);
    } finally { stubs.restore(); }
  });

  await check('C6 E11000 (in-flight guard) is swallowed, other errors are logged', async () => {
    // The partial-unique mediaId_in_flight_unique index rejects a
    // duplicate enqueue on an already-queued media. That MUST be a
    // silent no-op so a routine race with the ingest path doesn't
    // count as an enqueue failure. Any OTHER Mongo error should not
    // silently pass — otherwise a broken DetectRun schema would land
    // zero real enqueues while reporting 'enqueued=N'.
    const advertiserId = { toString: () => 'adv-1' };
    const brandId = { toString: () => 'brand-1' };
    const ugcMedia = [
      { _id: 'm1', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm2', advertiserId, brandId, source: 'apify-ig' },
      { _id: 'm3', advertiserId, brandId, source: 'apify-ig' }
    ];
    let createCount = 0;
    const stubs = makeStubs({ ugcMedia, strongMatchIds: [] });
    // Swap DetectRun.create with a fail-a-specific-shape variant that
    // throws E11000 on m2 (should be swallowed) and a bare error on m3
    // (should be logged; test that the enqueue count reflects that).
    const drPath = require.resolve(require('path').join(__dirname, '..', 'models', 'DetectRun'));
    require.cache[drPath].exports.create = async (doc) => {
      createCount++;
      if (doc.mediaId === 'm2') {
        const e = new Error('duplicate');
        e.code = 11000;
        throw e;
      }
      if (doc.mediaId === 'm3') {
        throw new Error('some other error');
      }
      return doc;
    };
    // Reset the require cache for the service so it picks up our swap.
    const svcPath = require.resolve(require('path').join(__dirname, '..', 'services', 'postRematchAfterCatalogService'));
    delete require.cache[svcPath];
    try {
      const svc2 = require('../services/postRematchAfterCatalogService');
      const r = await svc2.enqueueRematchForAllPosts({ brandId: 'brand-1' });
      assert.strictEqual(r.candidates, 3);
      assert.strictEqual(r.enqueued, 1, 'only m1 succeeded; m2 E11000 no-op, m3 caught + logged');
      assert.strictEqual(createCount, 3);
    } finally { stubs.restore(); }
  });

  // ── SECTION D — apifyIngestService reads the flag from a shared source ─
  //
  // Structural pin: apifyIngestService's skip decision MUST route through
  // isDeferPostDetectEnabled — inlining a `process.env.POST_DETECT_...`
  // read there would let a future refactor of the parser drift the two
  // callers into a mixed state.

  console.log('\n== D. apifyIngestService structural pin ==');

  const fs = require('fs');
  const apifyPath = path.join(__dirname, '..', 'services', 'apifyIngestService.js');
  const apifySource = fs.readFileSync(apifyPath, 'utf8');

  await check('D1 apifyIngestService requires isDeferPostDetectEnabled from postRematchAfterCatalogService', () => {
    assert.match(
      apifySource,
      /require\(['"]\.\/postRematchAfterCatalogService['"]\)/,
      'expected apifyIngestService to require postRematchAfterCatalogService'
    );
    assert.match(
      apifySource,
      /isDeferPostDetectEnabled\s*\(\s*\)/,
      'expected apifyIngestService to call isDeferPostDetectEnabled()'
    );
  });

  await check('D2 apifyIngestService does NOT read POST_DETECT_DEFER_TO_CATALOG directly', () => {
    // A direct env read would drift on a future clamp change. Structural
    // pin: only the shared parser touches the env var.
    const directRead = /process\.env\.POST_DETECT_DEFER_TO_CATALOG/;
    assert.ok(
      !directRead.test(apifySource),
      'apifyIngestService must not inline process.env.POST_DETECT_DEFER_TO_CATALOG — route through isDeferPostDetectEnabled()'
    );
  });

  // ── SECTION E — catalogPostSyncOrchestrator wires the trigger ────────

  console.log('\n== E. catalogPostSyncOrchestrator phase 3 wiring ==');

  const orchPath = path.join(__dirname, '..', 'services', 'catalogPostSyncOrchestrator.js');
  const orchSource = fs.readFileSync(orchPath, 'utf8');

  await check('E1 orchestrator requires rematchAfterCatalogDetect from postRematchAfterCatalogService', () => {
    assert.match(orchSource, /rematchAfterCatalogDetect/);
    assert.match(orchSource, /postRematchAfterCatalogService/);
  });

  await check('E2 orchestrator couples full=<isDeferPostDetectEnabled()>', () => {
    // The two knobs are coupled by design — deferred + full-rematch go
    // together, legacy + unmatched-only go together. A hardcoded `full:
    // true` would double-pay when someone flipped the deferral off.
    assert.match(
      orchSource,
      /full\s*=\s*isDeferPostDetectEnabled\s*\(\s*\)/,
      'expected orchestrator to derive full from isDeferPostDetectEnabled()'
    );
  });

  await check('E3 orchestrator fires phase 3 via setImmediate (fire-and-forget)', () => {
    // Awaiting inside runPostSyncChain would hold the OperationRun open
    // through the drain poll (up to 60 min), breaking the reconcile
    // tick's stale-updatedAt heuristic. The rematch has its own poll +
    // logging.
    assert.match(orchSource, /setImmediate\s*\(/);
  });

  await check('E4 orchestrator only fires phase 3 when phase 2 (yolo-detect) succeeded', () => {
    // Firing rematch after a phase-2 failure would enqueue against a
    // catalog whose detects couldn't even start — a definite bad
    // outcome, worse than not firing. This gate is a money guard.
    assert.match(orchSource, /phases\.yoloDetect\s*===\s*['"]ok['"]/);
  });

  // ── Summary ─────────────────────────────────────────────────────────

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${total} checks — ${passed} passed, ${total - passed} failed`);
  if (passed !== total) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
