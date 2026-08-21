#!/usr/bin/env node
'use strict';
/**
 * verifyVideoQcFrameSampling — offline guard for the video vision-QC
 * DENSE FRAME PRE-FILTER (services/videoQcFrameSelectionService.js) and its
 * wiring into services/brandScriptExecutor.js's runVideoVisionQcForAd.
 *
 * WHY THIS EXISTS: the pre-existing sampling (videoFrameService quartiles,
 * 25/50/75% of duration) sends exactly 3 frames to the paid vision model
 * and is structurally blind to a defect that appears and disappears inside
 * one quartile window. PROVEN 2026-08-20: a hallucinated storefront-UI
 * overlay was visible at t=0.1s/0.5s and completely gone by t=2.5s on a
 * ~10s clip — quartile sampling (2.5/5.0/7.5s) would see NOTHING. Section F
 * below reproduces that exact defect shape with REAL synthetically-
 * generated JPEGs (sharp-encoded in-memory, no external asset, no network)
 * and proves the new selector catches it while the old baseline alone does
 * not — a real behavioral pin, not a shape assertion.
 *
 * No DB, no network, no API key. Every "fetch" in this file is a mocked
 * `deps.fetchDenseFrames` — real image DECODE (sharp) still runs for real
 * in section C/F/G, only the network hop is stubbed, matching the existing
 * convention in this suite (services/adVisionQcService.js is exercised the
 * same way — real code, mocked transport).
 *
 * All checks run SEQUENTIALLY (not fired-and-gathered) because several
 * mutate process.env.VIDEO_QC_DENSE_SAMPLING for the duration of one check
 * (see withEnv) — running them concurrently would let one check's
 * temporary env flip leak into another's assertion window.
 *
 *   node scripts/verifyVideoQcFrameSampling.js
 *
 * REVERT-PROOF: F5 flips the VIDEO_QC_DENSE_SAMPLING kill switch off
 * mid-script and re-asserts the SAME real-incident scenario collapses back
 * to the old blind baseline — i.e. this file fails on its own if the
 * feature is disabled, which is also exactly what happens if
 * services/videoQcFrameSelectionService.js or its wiring into
 * brandScriptExecutor.js is reverted. Confirmed by hand, same session:
 * reverting the brandScriptExecutor.js wiring (restoring the bare
 * `videoFrameService.buildFrameUrls(deliveredUrl, durationSec)` call) fails
 * G1/G2; deleting videoQcFrameSelectionService.js entirely fails every
 * check below with MODULE_NOT_FOUND; setting VIDEO_QC_DENSE_SAMPLING=false
 * in the real environment reproduces exactly F5's assertion for real ads.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.VIDEO_QC_DENSE_SAMPLING;

const sel = require('../services/videoQcFrameSelectionService');
const videoFrameService = require('../services/videoFrameService');

let pass = 0;
const failures = [];
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { return await fn(); }
  finally {
    if (had) process.env[name] = prev; else delete process.env[name];
  }
}

function bufFor(marker) { return Buffer.from(String(marker)); }

const CLOUDINARY_URL = 'https://res.cloudinary.com/x/video/upload/v1/a.mp4';

console.log('\nverifyVideoQcFrameSampling — dense frame pre-filter for video vision QC\n');

(async () => {
  // ── A. planDenseTimestamps: shape + early-weighting proof (pure) ────
  check('A1 planDenseTimestamps(10) returns a dense, unique, ascending set', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    assert.ok(ts.length >= 10, `expected a dense set (>=10), got ${ts.length}`);
    const sorted = [...ts].sort((a, b) => a - b);
    assert.deepStrictEqual(ts, sorted, 'must be ascending');
    assert.strictEqual(new Set(ts).size, ts.length, 'must be unique');
  });

  check('A2 at least half of the dense set sits inside the first 2 seconds (early-weighted)', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    const early = ts.filter((t) => t <= 2);
    assert.ok(
      early.length * 2 >= ts.length,
      `expected >=50% of samples <=2s, got ${early.length}/${ts.length}`
    );
  });

  check('A3 the dense set still covers the tail of the clip (not early-only)', () => {
    const ts = videoFrameService.planDenseTimestamps(10);
    const max = Math.max(...ts);
    assert.ok(max >= 9, `expected a sample within ~1s of the end, max was ${max}`);
  });

  check('A4 the exact incident timestamps (0.1s, 0.5s) are inside the dense set for a 10s clip', () => {
    // Anchors the real 2026-08-20 defect (visible at t=0.1s/0.5s, gone by
    // t=2.5s) directly against the planner, independent of the scoring
    // math exercised in section F below.
    const ts = videoFrameService.planDenseTimestamps(10);
    assert.ok(ts.includes(0.1), '0.1s must be probed');
    assert.ok(ts.includes(0.5), '0.5s must be probed');
  });

  check('A5 degenerate durations do not throw and return a sane (possibly empty) list', () => {
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(0), []);
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(-5), []);
    assert.deepStrictEqual(videoFrameService.planDenseTimestamps(NaN), []);
    const tiny = videoFrameService.planDenseTimestamps(0.3);
    assert.ok(Array.isArray(tiny) && tiny.every((t) => t > 0 && t < 0.3));
  });

  check('A6 baselineTimestamps matches the PRE-EXISTING quartile plan exactly — never drops below it', () => {
    assert.deepStrictEqual(sel.baselineTimestamps(10), [2.5, 5, 7.5]);
    assert.deepStrictEqual(sel.BASELINE_FRACTIONS, [0.25, 0.5, 0.75]);
  });

  // ── B. Additive URL/fetch helpers do not disturb the existing contract ─
  check('B1 buildFrameUrlsAtTimestamps: sorted, labelled, null-filtered for non-Cloudinary', () => {
    const frames = videoFrameService.buildFrameUrlsAtTimestamps(CLOUDINARY_URL, [5, 0.1, 2.5]);
    assert.deepStrictEqual(frames.map((f) => f.timestampSec), [0.1, 2.5, 5]);
    assert.ok(frames.every((f) => typeof f.url === 'string' && f.url.includes('so_')));

    const none = videoFrameService.buildFrameUrlsAtTimestamps('https://example.com/not-cloudinary.mp4', [1, 2]);
    assert.strictEqual(none.length, 0);
  });

  check('B2 buildFrameUrls (pre-existing) is UNCHANGED for a 10s clip — quartiles only, byte-for-byte', () => {
    // Redundant guard, scoped to this file, against regressing
    // scripts/verifyAdVisionQc.js O13 while this file's neighbors change.
    const frames = videoFrameService.buildFrameUrls(CLOUDINARY_URL, 10);
    assert.deepStrictEqual(frames.map((f) => f.timestampSec), [2.5, 5, 7.5]);
  });

  await checkAsync('B3 fetchFrameBuffersAtTimestamps resolves instantly with zero frames for a non-Cloudinary source (no network attempted)', async () => {
    const out = await videoFrameService.fetchFrameBuffersAtTimestamps('https://example.com/x.mp4', [1, 2, 3]);
    assert.deepStrictEqual(out, []);
  });

  await checkAsync('B4 fetchFrameBuffersAtTimestamps resolves instantly for an empty timestamp list', async () => {
    const out = await videoFrameService.fetchFrameBuffersAtTimestamps(CLOUDINARY_URL, []);
    assert.deepStrictEqual(out, []);
  });

  // ── C. computeFrameSignature — real sharp decode, single-frame checks ─
  async function makeSolidJpeg(rgb, { width = 16, height = 16 } = {}) {
    const sharp = require('sharp');
    const channels = 3;
    const buf = Buffer.alloc(width * height * channels);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
    }
    return sharp(buf, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer();
  }

  await checkAsync('C1 computeFrameSignature returns a normalized-[0,1] grid of the right size', async () => {
    const jpeg = await makeSolidJpeg([128, 128, 128]);
    const sig = await sel.computeFrameSignature(jpeg);
    assert.strictEqual(sig.length, sel.SIGNATURE_SIZE * sel.SIGNATURE_SIZE);
    assert.ok(sig.every((v) => v >= 0 && v <= 1));
  });

  await checkAsync('C2 two visually identical frames produce near-identical signatures; black vs white produce a large one', async () => {
    const grayA = await makeSolidJpeg([128, 128, 128]);
    const grayB = await makeSolidJpeg([128, 128, 128]);
    const black = await makeSolidJpeg([0, 0, 0]);
    const white = await makeSolidJpeg([255, 255, 255]);
    const [sigA, sigB, sigBlack, sigWhite] = await Promise.all(
      [grayA, grayB, black, white].map((b) => sel.computeFrameSignature(b))
    );
    const diffAB = Math.abs(sigA[0] - sigB[0]);
    assert.ok(diffAB < 0.05, `identical solid frames should read ~equal, diff=${diffAB}`);
    const diffBW = Math.abs(sigBlack[0] - sigWhite[0]);
    assert.ok(diffBW > 0.8, `black vs white should read as very different, diff=${diffBW}`);
  });

  // ── D. scoreOutliers — pure array math, no I/O ─────────────────────
  check('D1 a uniform signature set flags nothing', () => {
    const sigs = Array.from({ length: 12 }, () => [0.5, 0.5, 0.5, 0.5]);
    const scored = sel.scoreOutliers(sigs);
    assert.ok(scored.every((s) => !s.outlier));
  });

  check('D2 two outliers among twelve are flagged; the rest are not', () => {
    const sigs = Array.from({ length: 12 }, (_, i) =>
      (i === 0 || i === 3) ? [1, 1, 1, 1] : [0, 0, 0, 0]
    );
    const scored = sel.scoreOutliers(sigs);
    const flaggedIdx = scored.map((s, i) => (s.outlier ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(flaggedIdx.sort((a, b) => a - b), [0, 3]);
  });

  check('D3 fewer than MIN_DENSE_FRAMES_TO_SCORE signatures never flags and never throws', () => {
    const scored = sel.scoreOutliers([[1, 1], [0, 0]]);
    assert.ok(scored.every((s) => !s.outlier && s.score === 0));
  });

  check('D4 a perfectly uniform set (zero variance) cannot false-flag from float noise (minScore floor)', () => {
    const sigs = Array.from({ length: 8 }, () => [0.33, 0.33]);
    const scored = sel.scoreOutliers(sigs);
    assert.ok(scored.every((s) => !s.outlier));
  });

  // ── E. selectQcFrameTimestamps orchestration (mocked transport only) ─
  const denseSet = videoFrameService.planDenseTimestamps(10);

  await checkAsync('E1 no outliers -> exactly the baseline, flaggedCount 0', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async () => denseSet.map((t) => ({ timestampSec: t, buffer: bufFor('clean') })),
        computeFrameSignature: async () => [0.5, 0.5, 0.5, 0.5]
      }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.flaggedCount, 0);
    assert.strictEqual(result.degraded, false);
  });

  await checkAsync('E2 two flagged outliers merge into the baseline, sorted', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async () => denseSet.map((t) => ({ timestampSec: t, buffer: bufFor(t) })),
        computeFrameSignature: async (buf) => {
          const t = Number(buf.toString());
          return (t === 0.1 || t === 0.5) ? [1, 1, 1, 1] : [0, 0, 0, 0];
        }
      }
    );
    assert.deepStrictEqual(result.timestamps, [0.1, 0.5, 2.5, 5, 7.5]);
    assert.strictEqual(result.flaggedCount, 2);
    assert.ok(result.timestamps.length <= sel.MAX_TOTAL_FRAMES);
  });

  await checkAsync('E3 kill switch OFF: baseline only, AND the network probe is never invoked (real cost avoidance)', async () => {
    await withEnv('VIDEO_QC_DENSE_SAMPLING', 'false', async () => {
      let fetchCalled = false;
      const result = await sel.selectQcFrameTimestamps(
        { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
        { fetchDenseFrames: async () => { fetchCalled = true; return []; } }
      );
      assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
      assert.strictEqual(fetchCalled, false, 'flag-off must skip the dense probe entirely, not just discard it');
    });
  });

  await checkAsync('E4 a transport failure degrades to baseline and never throws', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      { fetchDenseFrames: async () => { throw new Error('network down'); } }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.degraded, true);
  });

  await checkAsync('E5 too few dense frames downloaded degrades to baseline', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      { fetchDenseFrames: async () => [{ timestampSec: 0.1, buffer: bufFor('x') }] }
    );
    assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
    assert.strictEqual(result.degraded, true);
  });

  await checkAsync('E6 more outliers than the cap: only the top MAX_EXTRA_FRAMES by score survive', async () => {
    // 8 majority "clean" frames at [0,0]; 4 minority frames, each a clear
    // outlier but with DISTINCT scores, at timestamps far from every
    // baseline quartile so none gets redundancy-filtered.
    const scoreByTimestamp = { 1.6: 1.0, 3.1: 0.9, 5.8: 0.8, 8.5: 0.7 };
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async () => denseSet.map((t) => ({ timestampSec: t, buffer: bufFor(t) })),
        computeFrameSignature: async (buf) => {
          const t = Number(buf.toString());
          const v = scoreByTimestamp[t] || 0;
          return [v, v, v, v];
        }
      }
    );
    assert.strictEqual(result.flaggedCount, sel.MAX_EXTRA_FRAMES);
    assert.ok(result.timestamps.length <= sel.MAX_TOTAL_FRAMES);
    // The two HIGHEST-scoring outliers (1.6, 3.1) must be the ones kept,
    // not an arbitrary pair among the four that cleared the threshold.
    assert.ok(result.timestamps.includes(1.6) && result.timestamps.includes(3.1));
    assert.ok(!result.timestamps.includes(5.8) && !result.timestamps.includes(8.5));
  });

  await checkAsync('E7 an outlier within 0.4s of a baseline quartile is treated as redundant and dropped', async () => {
    const extra = { timestampSec: 2.6, buffer: bufFor(2.6) };
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      {
        fetchDenseFrames: async () => denseSet.map((t) => ({ timestampSec: t, buffer: bufFor(t) })).concat([extra]),
        computeFrameSignature: async (buf) => (buf.toString() === '2.6' ? [1, 1] : [0, 0])
      }
    );
    assert.ok(!result.timestamps.includes(2.6), 'a near-duplicate of the 2.5s baseline must not double up');
    assert.strictEqual(result.flaggedCount, 0, 'the only candidate outlier was redundant with baseline — nothing extra should ship');
  });

  // ── F. THE REAL BEHAVIORAL PROOF: real JPEGs, the actual 2026-08-20 defect ─
  async function makeIncidentFrame({ defect = false, width = 64, height = 64 } = {}) {
    const sharp = require('sharp');
    const channels = 3;
    const buf = Buffer.alloc(width * height * channels);
    // Background: mid-gray. "Product": a blue block in the center third —
    // a stand-in for the product-on-plain-background shot every one of
    // these ads actually is.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const inProduct = x > width / 3 && x < (2 * width) / 3 && y > height / 3 && y < (2 * height) / 3;
        if (inProduct) { buf[idx] = 40; buf[idx + 1] = 80; buf[idx + 2] = 200; }
        else { buf[idx] = 120; buf[idx + 1] = 120; buf[idx + 2] = 120; }
      }
    }
    if (defect) {
      // The real incident: a hallucinated storefront nav bar across the
      // top + a small dark "bag icon" block in the corner — chrome that
      // has no business being IN the generated plate at all.
      for (let y = 0; y < Math.floor(height * 0.22); y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          buf[idx] = 245; buf[idx + 1] = 245; buf[idx + 2] = 245;
        }
      }
      for (let y = 2; y < 10; y++) {
        for (let x = width - 12; x < width - 2; x++) {
          const idx = (y * width + x) * channels;
          buf[idx] = 20; buf[idx + 1] = 20; buf[idx + 2] = 20;
        }
      }
    }
    return sharp(buf, { raw: { width, height, channels } }).jpeg({ quality: 85 }).toBuffer();
  }

  const DEFECT_TIMESTAMPS = new Set([0.1, 0.5]);
  const incidentDense = videoFrameService.planDenseTimestamps(10);
  const incidentFrames = await Promise.all(incidentDense.map(async (t) => ({
    timestampSec: t,
    buffer: await makeIncidentFrame({ defect: DEFECT_TIMESTAMPS.has(t) })
  })));

  await checkAsync('F1 sanity: the synthetic defect frames really do decode differently from clean ones', async () => {
    const sigs = await Promise.all(incidentFrames.map((f) => sel.computeFrameSignature(f.buffer)));
    const scored = sel.scoreOutliers(sigs);
    const flaggedTs = incidentFrames.filter((_, i) => scored[i].outlier).map((f) => f.timestampSec);
    assert.deepStrictEqual(flaggedTs.sort((a, b) => a - b), [0.1, 0.5]);
  });

  await checkAsync('F2/F3 selectQcFrameTimestamps (real sharp decode, mocked network only) CATCHES the real incident at its real timestamps', async () => {
    const result = await sel.selectQcFrameTimestamps(
      { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
      { fetchDenseFrames: async () => incidentFrames } // real buffers; only the network hop is stubbed
    );
    assert.ok(result.timestamps.includes(0.1), 'must catch the t=0.1s frame of the real incident');
    assert.ok(result.timestamps.includes(0.5), 'must catch the t=0.5s frame of the real incident');
  });

  await checkAsync('F4 the PRE-EXISTING quartile-only baseline would have caught NEITHER defect frame (the documented blindness)', () => {
    const baseline = sel.baselineTimestamps(10);
    assert.deepStrictEqual(baseline, [2.5, 5, 7.5]);
    assert.ok(!baseline.includes(0.1) && !baseline.includes(0.5));
  });

  await checkAsync('F5 REVERT-PROOF: flipping VIDEO_QC_DENSE_SAMPLING off on the SAME incident reproduces the old blindness', async () => {
    await withEnv('VIDEO_QC_DENSE_SAMPLING', 'false', async () => {
      let fetchCalled = false;
      const result = await sel.selectQcFrameTimestamps(
        { deliveredUrl: CLOUDINARY_URL, durationSec: 10 },
        { fetchDenseFrames: async () => { fetchCalled = true; return incidentFrames; } }
      );
      assert.deepStrictEqual(result.timestamps, [2.5, 5, 7.5]);
      assert.ok(!result.timestamps.includes(0.1) && !result.timestamps.includes(0.5),
        'with the flag off, the exact same real incident frames must go uncaught — proves F2/F3 is not vacuous');
      assert.strictEqual(fetchCalled, false);
    });
  });

  // ── G. Integration wiring into brandScriptExecutor.js ────────────────
  check('G1 runVideoVisionQcForAd requires and calls videoQcFrameSelectionService, and no longer calls the bare unselected quartile buildFrameUrls', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'brandScriptExecutor.js'), 'utf8');
    const m = src.match(/async function runVideoVisionQcForAd\([\s\S]*?\n\}\n/);
    assert.ok(m, 'runVideoVisionQcForAd not found');
    const body = m[0];
    assert.ok(/require\(['"]\.\/videoQcFrameSelectionService['"]\)/.test(body),
      'must require videoQcFrameSelectionService');
    assert.ok(/\.selectQcFrameTimestamps\(/.test(body),
      'must call selectQcFrameTimestamps');
    assert.ok(!/buildFrameUrls\(deliveredUrl,\s*durationSec\)/.test(body),
      'the old bare quartile-only call must be gone, not left dead beside the new one');
    assert.ok(/buildFrameUrlsAtTimestamps\(/.test(body),
      'must build the final frame URLs from the selector output');
  });

  await checkAsync('G2 runVideoVisionQcForAd threads the selector output into the vision call for real (mocked deps, real control flow)', async () => {
    const brandScriptExecutor = require('../services/brandScriptExecutor');
    const frameSelectionService = require('../services/videoQcFrameSelectionService');
    const adVisionQc = require('../services/adVisionQcService');

    const originalSelect = frameSelectionService.selectQcFrameTimestamps;
    const originalIsEnabled = adVisionQc.isEnabled;
    const originalRunVideoQc = adVisionQc.runVideoPostRenderQc;

    const MARKER_TIMESTAMPS = [0.3, 0.9, 6.6]; // distinctive — not the real baseline
    let capturedFrames = null;

    frameSelectionService.selectQcFrameTimestamps = async () => ({
      timestamps: MARKER_TIMESTAMPS, denseCount: 12, flaggedCount: 2, degraded: false
    });
    adVisionQc.isEnabled = () => true;
    adVisionQc.runVideoPostRenderQc = async (args) => {
      capturedFrames = args.frames;
      return {
        ok: true, skipped: false, passed: true,
        visionQc: { passed: true, skipped: false, attempts: [], finalAttempt: 1 }
      };
    };

    try {
      const ad = {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        veoReferenceImages: ['https://cdn.example/seed.jpg'],
        videoDurationSec: 10,
        brandId: null,
        productId: null,
        campaignId: null,
        campaignRunIds: []
      };
      await brandScriptExecutor.runVideoVisionQcForAd({
        ad, deliveredUrl: CLOUDINARY_URL, brandName: 'Test Brand'
      });
    } finally {
      frameSelectionService.selectQcFrameTimestamps = originalSelect;
      adVisionQc.isEnabled = originalIsEnabled;
      adVisionQc.runVideoPostRenderQc = originalRunVideoQc;
    }

    assert.ok(Array.isArray(capturedFrames), 'runVideoPostRenderQc must have been called with a frames array');
    assert.deepStrictEqual(
      capturedFrames.map((f) => f.timestampSec),
      videoFrameService.buildFrameUrlsAtTimestamps(CLOUDINARY_URL, MARKER_TIMESTAMPS).map((f) => f.timestampSec),
      'the vision call must receive frames built from the selector output, not the old fixed quartiles'
    );
  });

  // ── report ───────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`❌ verifyVideoQcFrameSampling: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyVideoQcFrameSampling: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error('verifyVideoQcFrameSampling crashed:', err);
  process.exit(1);
});
