#!/usr/bin/env node
'use strict';
/**
 * verifyBasePlateCrop — offline suite for services/basePlateCropService.js's pure half.
 *
 * Every check here pins a fix for a specific trap found by adversarial review of the design
 * (workflow wf_025bdd56-97b, 33 traps, 9 P0). The section letters name the trap being pinned.
 * The I/O half (vision calls, liveness probe, persistence) is exercised in production behind the
 * degradation contract; what CAN be asserted offline is the decision logic and the frozen tables.
 *
 * No DB, no network. Safe in CI.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  decideBasePlateCrop, preGateBasePlateCrop, TARGET_BY_FORMAT, DETECT_SYSTEM_PROMPT,
} = require('../services/basePlateCropService');
const { classifyFormat } = require('../services/brandScriptExecutor');
const { PLATFORM_FORMATS, aspectRatioForPlatformFormat } = require('../services/platformFormats');
const { COMPOSITION_BY_FORMAT } = require('../services/remotionRenderService');
const { parseAspect } = require('../services/faceSafeCrop');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const SRC = 'https://res.cloudinary.com/reach-social-prod/video/upload/v1/liquidretail/atlas_renders/clip.mp4';
const SUBJ = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
const HEAD = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
const base = (o) => ({
  format: 'feed', platformFormat: 'meta_feed_4_5', sourceUrl: SRC,
  sourceW: 1080, sourceH: 1920, subject: SUBJ, head: HEAD, ...o,
});

// Root.jsx composition dims, extracted structurally (same technique as verifyTitlingFormats).
const rootSrc = fs.readFileSync(path.join(ROOT, 'remotion/Root.jsx'), 'utf8');
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
for (const [pfId, pf] of Object.entries(PLATFORM_FORMATS)) {
  check(`T3 ${pfId}: classifyFormat's target matches deliveryDims aspect`, () => {
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
check('G3 every REAL (platformFormat, aspect) pair passes the guard for its own format', () => {
  for (const [pfId, pf] of Object.entries(PLATFORM_FORMATS)) {
    const format = classifyFormat({ platformFormat: pfId, aspectRatio: pf.aspectRatio });
    const pre = preGateBasePlateCrop({ format, platformFormat: pfId, sourceUrl: SRC });
    assert.strictEqual(pre.action, 'proceed', `${pfId} -> ${format}: ${pre.reason}`);
  }
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
  const src = fs.readFileSync(path.join(ROOT, 'services/faceSafeCrop.js'), 'utf8');
  assert.ok(/hat\/cap\/hood/.test(src), 'faceSafeCrop no longer documents the headwear contract');
  assert.ok(/hat, cap, hood/.test(DETECT_SYSTEM_PROMPT), 'the prompt does not fulfil it');
});

// ── W. wiring invariants (the untitled-ad P0 and the poster P0) ────────────
const executorSrc = fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8');
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

if (failures.length) {
  console.error(`❌ verifyBasePlateCrop: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyBasePlateCrop: ${pass}/${pass} checks passed`);
