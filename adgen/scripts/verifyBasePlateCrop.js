#!/usr/bin/env node
'use strict';
/**
 * PORTED from liquidretail_backend/scripts/verifyBasePlateCrop.js into
 * liquidretail_adgen. Path adjustment (services/ -> src/services/, remotion/
 * -> src/remotion/) plus a Module._load stub so a bare adgen worktree can
 * require the live files without node_modules (axios/sharp/ffmpeg-static).
 * Every backend assertion is preserved. Group Q adds the face-quorum
 * boundary-miss retry (detectClipBoxes, I/O half, stubbed vision).
 *
 * verifyBasePlateCrop — offline suite for src/services/basePlateCropService.js's
 * pure half, plus the bounded retry in detectClipBoxes.
 *
 * Every check here pins a fix for a specific trap found by adversarial review of the design
 * (workflow wf_025bdd56-97b, 33 traps, 9 P0). The section letters name the trap being pinned.
 * The I/O half (vision calls, liveness probe, persistence) is exercised in production behind the
 * degradation contract; what CAN be asserted offline is the decision logic and the frozen tables.
 * Group Q drives the REAL detectClipBoxes against stubbed frame builders / detectFrameBoxes.
 *
 * No DB, no network. Safe in CI.
 */

process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'api';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://offline-harness/unused';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

function seed(rel, exports) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
  return abs;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') {
    return { get: async () => ({ data: Buffer.alloc(0), headers: {} }), post: async () => ({}) };
  }
  if (request === 'sharp') {
    const chain = {
      metadata: async () => ({ width: 1080, height: 1920 }),
      greyscale() { return this; },
      resize() { return this; },
    };
    const sharp = () => chain;
    return sharp;
  }
  if (request === 'ffmpeg-static') return '/bin/false';
  return origLoad.apply(this, arguments);
};

seed('src/models/Ad.js', { updateOne: async () => ({}) });
seed('src/services/atlasLlmService.js', {
  chatCompletion: async () => { throw new Error('atlasLlmService.chatCompletion must not run in this harness'); },
});
seed('src/services/adStage.js', { noteRenderIssue() {}, adStage() {} });

const {
  decideBasePlateCrop, preGateBasePlateCrop, TARGET_BY_FORMAT, DETECT_SYSTEM_PROMPT,
} = require('../src/services/basePlateCropService');
const basePlateCrop = require('../src/services/basePlateCropService');
const { classifyFormat } = require('../src/services/brandScriptExecutor');
const { PLATFORM_FORMATS, aspectRatioForPlatformFormat } = require('../src/services/platformFormats');
const { COMPOSITION_BY_FORMAT } = require('../src/services/remotionRenderService');
const {
  parseAspect, FACE_QUORUM_RETRY_FRAMES, FACE_MIN_FRAMES,
} = require('../src/services/faceSafeCrop');
const { planTimestamps, planAdditionalTimestamps } = require('../src/services/videoFrameService');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const SRC = 'https://res.cloudinary.com/reach-social-prod/video/upload/v1/liquidretail/atlas_renders/clip.mp4';
const SUBJ = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
const HEAD = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
const base = (o) => ({
  format: 'feed', platformFormat: 'meta_feed_4_5', sourceUrl: SRC,
  sourceW: 1080, sourceH: 1920, subject: SUBJ, head: HEAD, ...o,
});

// Root.jsx composition dims, extracted structurally (same technique as verifyTitlingFormats).
const rootSrc = fs.readFileSync(path.join(ROOT, 'src/remotion/Root.jsx'), 'utf8');
const compositions = {};
for (const block of rootSrc.split('<Composition').slice(1)) {
  const id = /id="([A-Za-z0-9_]+)"/.exec(block)?.[1];
  const w = /width=\{(\d+)\}/.exec(block)?.[1];
  const h = /height=\{(\d+)\}/.exec(block)?.[1];
  if (id) compositions[id] = { width: Number(w), height: Number(h) };
}

console.log('\nverifyBasePlateCrop\n');

// ── T. TARGET_BY_FORMAT is consistent with EVERYTHING (the target/composition-disagreement P0) ──
check('T1 TARGET_BY_FORMAT covers exactly the four titling formats', () => {
  assert.deepStrictEqual(Object.keys(TARGET_BY_FORMAT).sort(),
    ['feed', 'landscape', 'square', 'vertical']);
});
for (const [format, target] of Object.entries(TARGET_BY_FORMAT)) {
  check(`T2 ${format} target ${target} matches its Remotion composition's aspect`, () => {
    const comp = compositions[COMPOSITION_BY_FORMAT[format]];
    assert.ok(comp, `no composition for ${format}`);
    const a = parseAspect(target);
    assert.ok(Math.abs(comp.width / comp.height - a.wr / a.hr) < 0.01,
      `${target} != ${comp.width}x${comp.height} — a crop to ${target} would be RE-CROPPED by objectFit:'cover'`);
  });
}
// Live VIDEO-capable surfaces only — base-plate crop is a titling-path step.
// Static-only live keys (e.g. pmax_landscape_1_91_1 at 1.91:1) never reach
// brandScriptExecutor / basePlateCropService; their deliveryDims need not
// match a Remotion crop target. Do NOT unscope this to every live format.
// coming_soon formats are never base-plated (never generated).
for (const [pfId, pf] of Object.entries(PLATFORM_FORMATS)) {
  if (pf.status === 'coming_soon') continue;
  if (!Array.isArray(pf.kinds) || !pf.kinds.includes('video')) continue;
  check(`T3 ${pfId}: classifyFormat's target matches deliveryDims aspect (video-capable)`, () => {
    const format = classifyFormat({ platformFormat: pfId, aspectRatio: pf.aspectRatio });
    const target = TARGET_BY_FORMAT[format];
    const a = parseAspect(target);
    const d = pf.deliveryDims;
    assert.ok(Math.abs(d.width / d.height - a.wr / a.hr) < 0.01,
      `crop target ${target} vs delivery ${d.width}x${d.height}`);
  });
}

// ── G. the catch-all guard (the 'feed'-swallows-everything P1) ─────────────
check('G1 platformFormat/format disagreement is refused, not cropped', () => {
  // aspectRatio '1:1' forces classifyFormat -> 'square', but suppose a caller passes format 'feed'
  // with a 1:1 platform format: the crop target (4:5) disagrees with the platform aspect (1:1).
  const d = decideBasePlateCrop(base({ format: 'feed', platformFormat: 'meta_feed_1_1' }));
  assert.strictEqual(d.action, 'skip');
  assert.ok(d.reason.startsWith('aspect-mismatch'), d.reason);
});
check('G2 an unknown/legacy platformFormat cannot reach the crop', () => {
  const d = decideBasePlateCrop(base({ platformFormat: 'some_legacy_thing' }));
  assert.strictEqual(d.action, 'skip');
  assert.ok(d.reason.startsWith('aspect-mismatch'), d.reason);
});
// Video-capable live formats only — same scope as T3. Static-only keys do not
// enter the crop path, and a 1.91:1 static would correctly fail the 16:9 target
// guard if forced through it.
check('G3 every REAL video-capable (platformFormat, aspect) pair passes the guard for its own format', () => {
  for (const [pfId, pf] of Object.entries(PLATFORM_FORMATS)) {
    if (pf.status === 'coming_soon') continue;
    if (!Array.isArray(pf.kinds) || !pf.kinds.includes('video')) continue;
    const format = classifyFormat({ platformFormat: pfId, aspectRatio: pf.aspectRatio });
    const pre = preGateBasePlateCrop({ format, platformFormat: pfId, sourceUrl: SRC });
    assert.strictEqual(pre.action, 'proceed', `${pfId} -> ${format}: ${pre.reason}`);
  }
});
// Derive-only path core: pmax_video_1_1 (1:1) is cropped free from a settled
// 9:16 master — the guard must PROCEED for that (platformFormat, format) pair,
// and a 9:16 source plate must produce a real crop, not a skip/refusal.
check('G3b pmax_video_1_1 preGate proceeds (derive-only 1:1 from 9:16 master)', () => {
  const format = classifyFormat({ platformFormat: 'pmax_video_1_1', aspectRatio: '1:1' });
  assert.strictEqual(format, 'square');
  const pre = preGateBasePlateCrop({ format, platformFormat: 'pmax_video_1_1', sourceUrl: SRC });
  assert.strictEqual(pre.action, 'proceed', `preGate refused derive-only 1:1: ${pre.reason}`);
});
check('G3b pmax_video_1_1 crops a 9:16 master into 1:1 (not skip/refuse)', () => {
  const format = classifyFormat({ platformFormat: 'pmax_video_1_1', aspectRatio: '1:1' });
  const d = decideBasePlateCrop(base({
    format, platformFormat: 'pmax_video_1_1', sourceW: 1080, sourceH: 1920,
  }));
  assert.strictEqual(d.action, 'crop', `expected crop from 9:16 master, got ${d.action}: ${d.reason}`);
  assert.ok(d.rect && d.rect.cw === 1080 && d.rect.ch === 1080,
    `expected 1080x1080 crop window, got ${JSON.stringify(d.rect)}`);
});

// ── F. face gating (the anchorY-'center'-is-not-today's-output P0) ─────────
check('F1 no head quorum -> skip, NOT a centre-of-gravity crop', () => {
  const d = decideBasePlateCrop(base({ head: null }));
  assert.deepStrictEqual({ action: d.action, reason: d.reason }, { action: 'skip', reason: 'no-face-quorum' });
});
check('F2 a head the plausibility guard rejects -> skip, not centerOnBox', () => {
  // head == subject is the canonical mis-parse; plausibleFace rejects it -> anchorY 'center'.
  const d = decideBasePlateCrop(base({ head: SUBJ }));
  assert.strictEqual(d.action, 'skip');
  assert.strictEqual(d.reason, 'face-rejected-by-plausibility');
});
check('F3 a verified head -> crop with a face anchor', () => {
  const d = decideBasePlateCrop(base({}));
  assert.strictEqual(d.action, 'crop');
  assert.notStrictEqual(d.rect.anchorY, 'center');
});

// ── N. no-op and dims gates ────────────────────────────────────────────────
check('N1 9:16 target on a 9:16 master is a full-frame skip (zero cost)', () => {
  const d = decideBasePlateCrop(base({ format: 'vertical', platformFormat: 'meta_reels_9_16' }));
  assert.deepStrictEqual({ action: d.action, reason: d.reason }, { action: 'skip', reason: 'full-frame' });
});
check('N2 16:9 target on a 16:9 master is a full-frame skip', () => {
  const d = decideBasePlateCrop(base({
    format: 'landscape', platformFormat: 'pmax_16_9', sourceW: 1920, sourceH: 1080,
  }));
  assert.deepStrictEqual({ action: d.action, reason: d.reason }, { action: 'skip', reason: 'full-frame' });
});
check('N3 dims above the delivery cap are refused (upload-space = the v1 bug)', () => {
  const d = decideBasePlateCrop(base({ sourceW: 2268, sourceH: 4032 }));
  assert.strictEqual(d.action, 'skip');
  assert.ok(d.reason.startsWith('dims-exceed-delivery-cap'), d.reason);
});
check('N4 non-integer / missing dims are refused', () => {
  for (const dims of [{ sourceW: 1080.5, sourceH: 1920 }, { sourceW: NaN, sourceH: 1920 }, { sourceW: 0, sourceH: 1920 }]) {
    const d = decideBasePlateCrop(base(dims));
    assert.strictEqual(d.action, 'skip', JSON.stringify(dims));
  }
});

// ── U. URL gates ───────────────────────────────────────────────────────────
check('U1 an already-cropped source is refused (double-crop)', () => {
  const pre = preGateBasePlateCrop({
    format: 'feed', platformFormat: 'meta_feed_4_5',
    sourceUrl: SRC.replace('/video/upload/', '/video/upload/c_fill,ar_4:5/'),
  });
  assert.deepStrictEqual({ action: pre.action, reason: pre.reason },
    { action: 'skip', reason: 'already-cropped-url' });
});
check('U2 a non-Cloudinary source is refused', () => {
  const pre = preGateBasePlateCrop({
    format: 'feed', platformFormat: 'meta_feed_4_5', sourceUrl: 'https://example.com/x.mp4',
  });
  assert.strictEqual(pre.reason, 'not-transformable-url');
});

// ── P. the detection prompt (the headwear P1 + faceSafeCrop doc honesty) ───
check('P1 the prompt demands headwear in the head box', () => {
  for (const word of ['headwear', 'hat', 'hood', 'helmet']) {
    assert.ok(DETECT_SYSTEM_PROMPT.toLowerCase().includes(word), `prompt does not mention ${word}`);
  }
});
check('P2 the prompt asks for STRICT JSON with normalized fractions', () => {
  assert.ok(DETECT_SYSTEM_PROMPT.includes('STRICT JSON'));
  assert.ok(DETECT_SYSTEM_PROMPT.includes('0.0-1.0'));
});
check('P3 faceSafeCrop\'s headwear claim now matches a prompt that actually exists', () => {
  // faceSafeCrop.js documents that "the detection prompt asks for the whole head INCLUDING
  // hair, chin and any hat/cap/hood". Before this service existed, no such prompt did.
  const src = fs.readFileSync(path.join(ROOT, 'src/services/faceSafeCrop.js'), 'utf8');
  assert.ok(/hat\/cap\/hood/.test(src), 'faceSafeCrop no longer documents the headwear contract');
  assert.ok(/hat, cap, hood/.test(DETECT_SYSTEM_PROMPT), 'the prompt does not fulfil it');
});

// ── W. wiring invariants (the untitled-ad P0 and the poster P0) ────────────
const executorSrc = fs.readFileSync(path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
check('W1 renderWithRemotionAndSave consumes the resolver, not ad.veoVideoUrl directly', () => {
  const fn = executorSrc.split('async function renderWithRemotionAndSave')[1].split('\nasync function')[0];
  assert.ok(fn.includes('resolveBasePlateVideoUrl'), 'resolver not called');
  assert.ok(/videoUrl:\s*plateUrl/.test(fn), 'renderTitles does not consume the resolved plate');
});
check('W2 a cropped-plate titling failure retries with the RAW plate (titles never lost)', () => {
  const fn = executorSrc.split('async function renderWithRemotionAndSave')[1].split('\nasync function')[0];
  assert.ok(/catch[\s\S]*basePlate\.cropped[\s\S]*renderTitles[\s\S]*ad\.veoVideoUrl/.test(fn),
    'no retry-with-raw path — a cold 423 would ship an UNTITLED ad');
});
check('W3 uploadRenderAndStamp rebuilds posterUrl from the titled upload', () => {
  const fn = executorSrc.split('async function uploadRenderAndStamp')[1].split('\nasync function')[0];
  assert.ok(/posterUrl/.test(fn) && /so_2,f_jpg/.test(fn),
    'poster stays a raw 9:16 still — the image Meta shows would be uncropped and untitled');
});

// ── Q. face-quorum boundary-miss retry (detectClipBoxes, at most once) ────
check('Q0 FACE_MIN_FRAMES stays 2; FACE_QUORUM_RETRY_FRAMES is 2', () => {
  assert.strictEqual(FACE_MIN_FRAMES, 2);
  assert.strictEqual(FACE_QUORUM_RETRY_FRAMES, 2);
});
check('Q0b retry timestamps never reuse the original plan (8s reel)', () => {
  const duration = 8;
  const existing = planTimestamps(duration, { isReel: true });
  assert.ok(existing.length >= 2, `expected a multi-frame plan, got ${existing}`);
  const extra = planAdditionalTimestamps(duration, existing, FACE_QUORUM_RETRY_FRAMES);
  assert.strictEqual(extra.length, FACE_QUORUM_RETRY_FRAMES,
    `expected ${FACE_QUORUM_RETRY_FRAMES} extra timestamps, got ${JSON.stringify(extra)}`);
  const taken = new Set(existing);
  for (const t of extra) {
    assert.ok(!taken.has(t), `retry timestamp ${t} collided with original plan ${existing}`);
    assert.ok(t > 0 && t < duration, `retry timestamp ${t} out of (0, ${duration})`);
  }
});
check('Q0c retry is one-shot in source (no while/for around the boundary-miss block)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/basePlateCropService.js'), 'utf8');
  const fn = src.split('async function detectClipBoxes')[1].split('\nasync function')[0];
  assert.ok(/head === null && initialHits === 1/.test(fn),
    'boundary-miss condition (head===null && initialHits===1) missing from detectClipBoxes');
  assert.ok(!/while\s*\(/.test(fn), 'detectClipBoxes must not loop the retry');
  const retryIdx = fn.indexOf('head === null && initialHits === 1');
  const after = fn.slice(retryIdx);
  assert.ok(!/detectClipBoxes\(/.test(after),
    'detectClipBoxes must not recurse into itself for the retry');
});

const INITIAL_FRAMES = [
  { timestampSec: 2.0, url: 'https://res.cloudinary.com/x/video/upload/so_2.0,w_640,c_limit,f_jpg/v1/clip.jpg' },
  { timestampSec: 4.0, url: 'https://res.cloudinary.com/x/video/upload/so_4.0,w_640,c_limit,f_jpg/v1/clip.jpg' },
  { timestampSec: 6.0, url: 'https://res.cloudinary.com/x/video/upload/so_6.0,w_640,c_limit,f_jpg/v1/clip.jpg' },
];
const RETRY_FRAMES = Array.from({ length: FACE_QUORUM_RETRY_FRAMES }, (_, i) => ({
  timestampSec: 1.0 + i * 6.0, // 1.0 and 7.0 — around the original quartile plan
  url: `https://res.cloudinary.com/x/video/upload/so_retry_${i},w_640,c_limit,f_jpg/v1/clip.jpg`,
}));
const FACE_A = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
const FACE_B = { left: 0.38, top: 0.10, right: 0.62, bottom: 0.28 };

async function withDetectStubs({ frames, extraFrames, detectFn }, fn) {
  const orig = {
    buildFrameUrls: basePlateCrop._internal.buildFrameUrls,
    buildAdditionalFrameUrls: basePlateCrop._internal.buildAdditionalFrameUrls,
    detectFrameBoxes: basePlateCrop._internal.detectFrameBoxes,
  };
  const calls = { detect: 0, additional: 0, initial: 0, additionalArgs: null };
  basePlateCrop._internal.buildFrameUrls = () => {
    calls.initial += 1;
    return frames;
  };
  basePlateCrop._internal.buildAdditionalFrameUrls = (...args) => {
    calls.additional += 1;
    calls.additionalArgs = args;
    return extraFrames;
  };
  basePlateCrop._internal.detectFrameBoxes = async (url) => {
    calls.detect += 1;
    return detectFn(url, calls.detect);
  };
  try {
    const det = await basePlateCrop._internal.detectClipBoxes(SRC, 8);
    await fn(det, calls);
  } finally {
    Object.assign(basePlateCrop._internal, orig);
  }
}

async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

(async () => {
  // (a) faceHits=1 after initial sampling becomes >=2 after retry → real crop
  await checkAsync('Q1 faceHits=1 then retry hit → head set, crop not skip', async () => {
    await withDetectStubs({
      frames: INITIAL_FRAMES,
      extraFrames: RETRY_FRAMES,
      detectFn: (url, n) => {
        // First 3: one face (frame 2) + two subject-only. Retry: one face.
        if (url.includes('so_4.0')) return { subject: SUBJ, face: FACE_A };
        if (url.includes('so_retry_0')) return { subject: SUBJ, face: FACE_B };
        return { subject: SUBJ, face: null };
      },
    }, async (det, calls) => {
      assert.strictEqual(calls.initial, 1, 'initial plan should be requested once');
      assert.strictEqual(calls.additional, 1, 'retry must fire exactly once');
      assert.strictEqual(calls.detect, INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES,
        `expected ${INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES} vision calls, got ${calls.detect}`);
      assert.ok(det.head, 'combined set should reach quorum');
      assert.ok(det.faceHits >= 2, `faceHits=${det.faceHits} after retry`);
      assert.strictEqual(det.frames, INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES,
        'returned frames must be combined (original+retry), persisted on Ad.basePlate');
      const existingTs = INITIAL_FRAMES.map((f) => f.timestampSec);
      assert.deepStrictEqual(calls.additionalArgs[2], existingTs,
        'retry must be asked for NEW timestamps, not a re-sample of the original plan');
      assert.strictEqual(calls.additionalArgs[3]?.count, FACE_QUORUM_RETRY_FRAMES,
        'call site must pass count so buildAdditionalFrameUrls does not silently no-op (count=0 -> [])');
      const d = decideBasePlateCrop(base({ subject: det.subject, head: det.head }));
      assert.strictEqual(d.action, 'crop', `expected crop, got ${d.action}: ${d.reason}`);
      assert.notStrictEqual(d.rect.anchorY, 'center');
    });
  });

  // (e) exactly one sampled frame total (short clip), that frame has a face —
  // consensusFaceBox's single-detection exception already trusts it (faceHits=1,
  // detectedFrames=1), so head is non-null and the retry must NOT fire.
  await checkAsync('Q5 single-frame plan with a hit already trusts the head, no retry', async () => {
    const oneFrame = [INITIAL_FRAMES[0]];
    await withDetectStubs({
      frames: oneFrame,
      extraFrames: RETRY_FRAMES,
      detectFn: () => ({ subject: SUBJ, face: FACE_A }),
    }, async (det, calls) => {
      assert.strictEqual(calls.additional, 0,
        `retry fired ${calls.additional} times on an already-trusted single-frame hit`);
      assert.strictEqual(calls.detect, oneFrame.length);
      assert.ok(det.head, 'single-detection exception should already trust this head');
      assert.strictEqual(det.faceHits, 1);
      assert.strictEqual(det.frames, oneFrame.length);
    });
  });

  // (b) retry batch also fails to add a second hit → still no-face-quorum, no second retry
  await checkAsync('Q2 retry adds no second hit → no-face-quorum, retry bounded to one batch', async () => {
    await withDetectStubs({
      frames: INITIAL_FRAMES,
      extraFrames: RETRY_FRAMES,
      detectFn: (url) => {
        if (url.includes('so_4.0')) return { subject: SUBJ, face: FACE_A };
        return { subject: SUBJ, face: null };
      },
    }, async (det, calls) => {
      assert.strictEqual(calls.additional, 1, 'retry must fire once');
      assert.strictEqual(calls.detect, INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES,
        `retry must not loop: expected ${INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES} calls, got ${calls.detect}`);
      assert.strictEqual(det.head, null, 'still no quorum');
      assert.strictEqual(det.faceHits, 1);
      assert.strictEqual(det.frames, INITIAL_FRAMES.length + FACE_QUORUM_RETRY_FRAMES);
      const d = decideBasePlateCrop(base({ subject: det.subject, head: det.head }));
      assert.deepStrictEqual({ action: d.action, reason: d.reason },
        { action: 'skip', reason: 'no-face-quorum' });
    });
  });

  // (c) faceHits=0 → retry NEVER triggered
  await checkAsync('Q3 faceHits=0 never triggers retry (cost containment)', async () => {
    await withDetectStubs({
      frames: INITIAL_FRAMES,
      extraFrames: RETRY_FRAMES,
      detectFn: () => ({ subject: SUBJ, face: null }),
    }, async (det, calls) => {
      assert.strictEqual(calls.additional, 0, `retry fired ${calls.additional} times on a 0-hit clip`);
      assert.strictEqual(calls.detect, INITIAL_FRAMES.length,
        `0-hit ads must not pay extra vision calls, got ${calls.detect}`);
      assert.strictEqual(det.head, null);
      assert.strictEqual(det.faceHits, 0);
      assert.strictEqual(det.frames, INITIAL_FRAMES.length);
    });
  });

  // (d) faceHits>=2 on first pass → retry never triggered
  await checkAsync('Q4 faceHits>=2 on first pass never triggers retry', async () => {
    await withDetectStubs({
      frames: INITIAL_FRAMES,
      extraFrames: RETRY_FRAMES,
      detectFn: (url) => {
        if (url.includes('so_2.0') || url.includes('so_4.0')) {
          return { subject: SUBJ, face: FACE_A };
        }
        return { subject: SUBJ, face: null };
      },
    }, async (det, calls) => {
      assert.strictEqual(calls.additional, 0, `retry fired ${calls.additional} times after already-quorum`);
      assert.strictEqual(calls.detect, INITIAL_FRAMES.length);
      assert.ok(det.head, 'first-pass quorum should already trust the head');
      assert.ok(det.faceHits >= 2);
      assert.strictEqual(det.frames, INITIAL_FRAMES.length);
    });
  });

  if (failures.length) {
    console.error(`❌ verifyBasePlateCrop: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyBasePlateCrop: ${pass}/${pass} checks passed`);
})().catch((err) => {
  console.error(`❌ verifyBasePlateCrop: fatal ${err.message}`);
  process.exit(1);
});
