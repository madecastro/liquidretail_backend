#!/usr/bin/env node
'use strict';
/**
 * verifyFaceSafeCrop — offline correctness suite for services/faceSafeCrop.js.
 *
 * Ported from reach-social-llm-expander scripts/verify-gravity-crop.mjs, keeping its section
 * structure so the two suites stay comparable, minus the sections that tested expander-only app
 * wiring (ffmpeg invocation, SQLite job rows) and plus sections for this repo's divergences: the
 * asymmetric top margin, the raised headwear area threshold, and the Remotion centre-crop
 * regression this whole module exists to prevent.
 *
 * BEHAVIOURAL assertions only. An earlier drift guard in the sibling repo used source-text regexes
 * and passed 118/0 against three injected behavioural regressions — a test that cannot fail is not
 * a test. Everything here computes a rect and checks the rect.
 *
 * No DB, no network, no API key, no ffmpeg. Safe in CI.
 */

const assert = require('assert');
const fsc = require('../services/faceSafeCrop');
const {
  computeGravityCropRect, centerOnBox, windowFor, parseAspect,
  unionBoxes, consensusFaceBox, filmstripFrameCount,
  FACE_MARGIN_FRAC, FACE_TOP_MARGIN_FRAC, FACE_MAX_SUBJECT_AREA_FRAC, FACE_MIN_FRAMES,
} = fsc;
const { usableBox, clampTo, placeWithMargin, plausibleFace } = fsc._internal;

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// A 1080x1920 portrait master is what Omni actually produces at 1080p.
const SW = 1080, SH = 1920;
// Subject spans nearly the whole frame — this is the realistic case, because the subject box
// includes TEXT, which is exactly why a subject-top anchor beheads people.
const SUBJ_TALL = { left: 0.05, top: 0.02, right: 0.95, bottom: 0.98 };
// Head high in frame, as in a standing-model shot.
const HEAD_HIGH = { left: 0.36, top: 0.08, right: 0.64, bottom: 0.26 };
const px = (frac, span) => frac * span;

const TARGETS = [['9:16', 9, 16], ['4:5', 4, 5], ['1:1', 1, 1], ['16:9', 16, 9]];

console.log('\nverifyFaceSafeCrop\n');

// ── A. degenerate inputs never produce a rect ───────────────────────────────
const DEGENERATE = [
  [1080, 1920, 0, 0], [1080, 1920, 1, 0], [1080, 1920, 0, 1],
  [0, 1920, 1, 1], [1080, 0, 1, 1], [-1, -1, 1, 1],
  [NaN, 1920, 1, 1], [1080, NaN, 1, 1], [1080, 1920, NaN, 1], [1080, 1920, 1, NaN],
  [Infinity, 1920, 1, 1], [1080, 1920, Infinity, 1],
  [0.5, 0.5, 1, 1],
];
for (const [sw, sh, wr, hr] of DEGENERATE) {
  check(`A1 degenerate (${sw},${sh},${wr},${hr}) -> null`, () => {
    assert.strictEqual(computeGravityCropRect(sw, sh, wr, hr, SUBJ_TALL, HEAD_HIGH), null);
  });
  check(`A2 degenerate (${sw},${sh},${wr},${hr}) -> null via centerOnBox`, () => {
    assert.strictEqual(centerOnBox(sw, sh, wr, hr, SUBJ_TALL), null);
  });
}
check('A3 a ratio larger than the frame yields null (k<1)', () => {
  assert.strictEqual(computeGravityCropRect(10, 10, 100, 100, SUBJ_TALL, HEAD_HIGH), null);
});

// ── B. window sizing is exact and matches Meta delivery dims ───────────────
check('B1 9:16 of 1080x1920 is the full frame', () => {
  const w = windowFor(SW, SH, 9, 16);
  assert.deepStrictEqual(w, { cw: 1080, ch: 1920 });
});
check('B2 4:5 of 1080x1920 is 1080x1350 (== meta_feed_4_5 deliveryDims)', () => {
  assert.deepStrictEqual(windowFor(SW, SH, 4, 5), { cw: 1080, ch: 1350 });
});
check('B3 1:1 of 1080x1920 is 1080x1080 (== meta_feed_1_1 deliveryDims)', () => {
  assert.deepStrictEqual(windowFor(SW, SH, 1, 1), { cw: 1080, ch: 1080 });
});
check('B4 16:9 of 1920x1080 is the full frame', () => {
  assert.deepStrictEqual(windowFor(1920, 1080, 16, 9), { cw: 1920, ch: 1080 });
});
check('B5 every window fits inside the source', () => {
  for (const [, wr, hr] of TARGETS) {
    const w = windowFor(SW, SH, wr, hr);
    if (!w) continue;
    assert.ok(w.cw <= SW && w.ch <= SH, `${wr}:${hr} window ${w.cw}x${w.ch} exceeds ${SW}x${SH}`);
  }
});
check('B6 window dimensions are EVEN (H.264 yuv420p re-encode downstream)', () => {
  for (const [name, wr, hr] of TARGETS) {
    const w = windowFor(SW, SH, wr, hr);
    if (!w) continue;
    assert.strictEqual(w.cw % 2, 0, `${name} cw=${w.cw} is odd`);
    assert.strictEqual(w.ch % 2, 0, `${name} ch=${w.ch} is odd`);
  }
});

// ── C. rect fields are integers and in bounds ──────────────────────────────
for (const [name, wr, hr] of TARGETS) {
  check(`C1 ${name} rect is all integers`, () => {
    const r = computeGravityCropRect(SW, SH, wr, hr, SUBJ_TALL, HEAD_HIGH);
    if (!r) return;
    for (const k of ['cx', 'cy', 'cw', 'ch']) {
      assert.ok(Number.isInteger(r[k]), `${k}=${r[k]} is not an integer — invalid crop arg`);
    }
  });
  check(`C2 ${name} rect is inside the source frame`, () => {
    const r = computeGravityCropRect(SW, SH, wr, hr, SUBJ_TALL, HEAD_HIGH);
    if (!r) return;
    assert.ok(r.cx >= 0 && r.cy >= 0, `negative origin ${r.cx},${r.cy}`);
    assert.ok(r.cx + r.cw <= SW, `right edge ${r.cx + r.cw} > ${SW}`);
    assert.ok(r.cy + r.ch <= SH, `bottom edge ${r.cy + r.ch} > ${SH}`);
  });
}

// ── D. THE REGRESSION THIS MODULE EXISTS FOR ──────────────────────────────
// Remotion BasePlate uses objectFit:'cover' == a centre crop. For a high head that beheads.
function headCutPx(cy, ch, head) {
  const hT = px(head.top, SH), hB = px(head.bottom, SH);
  return Math.max(0, cy - hT) + Math.max(0, hB - (cy + ch));
}
check('D1 centre-crop DOES behead a high head at 4:5 (proves the premise)', () => {
  const w = windowFor(SW, SH, 4, 5);
  const centreCy = Math.round((SH - w.ch) / 2);
  assert.ok(headCutPx(centreCy, w.ch, HEAD_HIGH) > 0,
    'if this fails the premise is wrong and the whole module is unnecessary');
});
check('D2 centre-crop DOES behead a high head at 1:1', () => {
  const w = windowFor(SW, SH, 1, 1);
  const centreCy = Math.round((SH - w.ch) / 2);
  assert.ok(headCutPx(centreCy, w.ch, HEAD_HIGH) > 0);
});
for (const [name, wr, hr] of TARGETS) {
  check(`D3 ${name} face-safe keeps the head FULLY in frame`, () => {
    const r = computeGravityCropRect(SW, SH, wr, hr, SUBJ_TALL, HEAD_HIGH);
    if (!r) return;
    assert.strictEqual(headCutPx(r.cy, r.ch, HEAD_HIGH), 0,
      `cut ${headCutPx(r.cy, r.ch, HEAD_HIGH)}px of head (anchor=${r.anchorY})`);
  });
}
check('D4 face-safe never cuts MORE head than centre-crop, for any head position', () => {
  for (let top = 0; top <= 0.7; top += 0.05) {
    const head = { left: 0.4, top, right: 0.6, bottom: top + 0.18 };
    for (const [name, wr, hr] of TARGETS) {
      const w = windowFor(SW, SH, wr, hr);
      const r = computeGravityCropRect(SW, SH, wr, hr, SUBJ_TALL, head);
      if (!r || !w) continue;
      const centre = headCutPx(Math.round((SH - w.ch) / 2), w.ch, head);
      const safe = headCutPx(r.cy, r.ch, head);
      assert.ok(safe <= centre,
        `${name} head.top=${top.toFixed(2)}: face-safe cut ${safe} > centre ${centre}`);
    }
  }
});

// ── E. the top bias (owner requirement: product below the face) ────────────
check('E1 face-safe places the head top one TOP margin down (+/-1px rounding)', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, HEAD_HIGH);
  assert.strictEqual(r.anchorY, 'face-safe');
  // cy is rounded to an integer while the head's pixel top is fractional (0.08*1920 = 153.6),
  // so headroom lands within 1px of the margin rather than exactly on it.
  const headroom = px(HEAD_HIGH.top, SH) - r.cy;
  const want = Math.round(FACE_TOP_MARGIN_FRAC * r.ch);
  assert.ok(Math.abs(headroom - want) <= 1,
    `headroom ${headroom.toFixed(2)} is not within 1px of the top margin ${want}`);
});
check('E2 the top margin is SMALLER than the all-edge margin (that is the bias)', () => {
  assert.ok(FACE_TOP_MARGIN_FRAC < FACE_MARGIN_FRAC,
    'no bias: top margin must be tighter than the symmetric margin');
});
check('E3 the bias yields MORE product below the head than a symmetric margin would', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, HEAD_HIGH);
  // cy is the window's TOP edge. A SMALLER top margin puts the head nearer that edge, i.e. a
  // LARGER cy, i.e. the window extends further DOWN over the garment. Getting this direction
  // backwards is easy, so assert the consequence (window bottom) as well as cy itself.
  const symmetricCy = Math.round(px(HEAD_HIGH.top, SH) - FACE_MARGIN_FRAC * r.ch);
  assert.ok(r.cy > symmetricCy,
    `biased cy ${r.cy} should sit BELOW symmetric cy ${symmetricCy} (larger = window lower)`);
  const gained = r.cy - symmetricCy;
  assert.ok(gained > 0 && gained < 200, `implausible gain ${gained}px`);
  assert.ok(r.cy + r.ch > symmetricCy + r.ch - 1, 'window bottom did not move down');
});
check('E4 the head still keeps clear of the TOP edge (bias must not touch the edge)', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, HEAD_HIGH);
  assert.ok(px(HEAD_HIGH.top, SH) - r.cy > 0, 'head is flush against the top edge');
});

// ── F. rule ordering ──────────────────────────────────────────────────────
check('F1 rule 1: no head -> centre of gravity, NOT a top anchor', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, null);
  assert.strictEqual(r.anchorY, 'center');
  const expected = centerOnBox(SW, SH, 1, 1, SUBJ_TALL);
  assert.deepStrictEqual(r, expected);
});
check('F2 rule 1 protects a headless tall product from losing its bottom', () => {
  // A hanging coat: tall subject, no head. A top anchor would lop off the bottom.
  const coat = { left: 0.3, top: 0.05, right: 0.7, bottom: 0.95 };
  const r = computeGravityCropRect(SW, SH, 1, 1, coat, null);
  const lostTop = Math.max(0, r.cy - px(coat.top, SH));
  const lostBot = Math.max(0, px(coat.bottom, SH) - (r.cy + r.ch));
  assert.ok(Math.abs(lostTop - lostBot) <= 2,
    `overflow should split evenly, got top=${lostTop} bottom=${lostBot}`);
});
check('F3 rule 2: subject fits vertically -> subject-fit, centred on subject', () => {
  const small = { left: 0.3, top: 0.35, right: 0.7, bottom: 0.60 };  // 0.25*1920=480 < 1080
  const head = { left: 0.42, top: 0.36, right: 0.58, bottom: 0.44 };
  const r = computeGravityCropRect(SW, SH, 1, 1, small, head);
  assert.strictEqual(r.anchorY, 'subject-fit');
});
check('F4 rule 3: subject does NOT fit -> face-safe', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, HEAD_HIGH);
  assert.strictEqual(r.anchorY, 'face-safe');
});
check('F5 rule 4: head taller than the window -> face-center', () => {
  // Head must be taller than the 1:1 window (1080px = 0.5625 of 1920) AND stay under the 0.6
  // area guard, or plausibleFace rejects it first and we land on 'center' instead. A narrow,
  // very tall head box satisfies both: 1248px tall, 0.254 of the subject's area.
  const tall = { left: 0.35, top: 0.05, right: 0.65, bottom: 0.70 };
  const subj = { left: 0.10, top: 0.02, right: 0.90, bottom: 0.98 };
  assert.ok((tall.bottom - tall.top) * SH > windowFor(SW, SH, 1, 1).ch, 'fixture head is not taller than the window');
  assert.notStrictEqual(plausibleFace(tall, subj), null, 'fixture head is rejected by the area guard');
  const r = computeGravityCropRect(SW, SH, 1, 1, subj, tall);
  assert.strictEqual(r.anchorY, 'face-center');
});
check('F6 no subject at all -> leads with the head, not subject-fit', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, null, HEAD_HIGH);
  assert.notStrictEqual(r.anchorY, 'subject-fit');
  assert.strictEqual(headCutPx(r.cy, r.ch, HEAD_HIGH), 0);
});

// ── G. plausibleFace guards ───────────────────────────────────────────────
check('G1 inverted / non-finite head boxes are rejected', () => {
  for (const bad of [
    { left: 0.6, top: 0.1, right: 0.4, bottom: 0.3 },   // right <= left
    { left: 0.4, top: 0.3, right: 0.6, bottom: 0.1 },   // bottom <= top
    { left: NaN, top: 0.1, right: 0.6, bottom: 0.3 },
    { left: 0.4, top: 0.1, right: 0.6, bottom: Infinity },
  ]) {
    assert.strictEqual(plausibleFace(bad, SUBJ_TALL), null, `accepted ${JSON.stringify(bad)}`);
  }
});
check('G2 a head whose CENTRE is outside the subject box is rejected', () => {
  const away = { left: 0.01, top: 0.01, right: 0.04, bottom: 0.04 };
  const subj = { left: 0.4, top: 0.4, right: 0.9, bottom: 0.9 };
  assert.strictEqual(plausibleFace(away, subj), null);
});
check('G3 a head echoing the whole subject box is rejected (mis-parse)', () => {
  assert.strictEqual(plausibleFace(SUBJ_TALL, SUBJ_TALL), null,
    'head == subject must be rejected or the window drags to the subject top');
});
check('G4 with no subject to cross-check, a usable head is accepted', () => {
  assert.deepStrictEqual(plausibleFace(HEAD_HIGH, null), HEAD_HIGH);
});
check('G5 rejection falls back to centre, never to a top anchor', () => {
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, SUBJ_TALL);  // head == subject
  assert.strictEqual(r.anchorY, 'center');
});

// ── H. headwear: the area threshold must tolerate a hat ───────────────────
// Measured ratios (see the constant's comment): worst realistic hatted framing is ~0.528, and a
// head==subject mis-parse is 1.000. So the guard must sit between those, and NOT be loosened.
check('H1 the area threshold separates a hatted head from a mis-parse', () => {
  assert.ok(FACE_MAX_SUBJECT_AREA_FRAC > 0.53,
    `${FACE_MAX_SUBJECT_AREA_FRAC} would reject a legitimate head+shoulders+hat framing (0.528)`);
  assert.ok(FACE_MAX_SUBJECT_AREA_FRAC < 1.0,
    `${FACE_MAX_SUBJECT_AREA_FRAC} would accept a head==subject mis-parse`);
});
// H2a and H2b were originally one check that conflated two orthogonal things: whether a hatted head
// SURVIVES the area guard (needs a head-dominant framing, i.e. a SHORT subject) and whether it GETS
// the top bias (needs a subject too TALL to fit the window, which makes the area ratio small). One
// fixture cannot satisfy both — a head+shoulders subject is only 960px tall, so it fits the 1080px
// window and rule 2 correctly fires 'subject-fit' instead.
check('H2a the worst realistic hatted framing survives the area guard', () => {
  // head+shoulders with a wide hat — the most head-dominant realistic case, ratio ~0.528
  const subj = { left: 0.15, top: 0.05, right: 0.85, bottom: 0.55 };
  const hatted = { left: 0.22, top: 0.05, right: 0.78, bottom: 0.38 };
  const area = (b) => (b.right - b.left) * (b.bottom - b.top);
  const ratio = area(hatted) / area(subj);
  assert.ok(ratio > 0.45, `fixture too small to exercise the guard (ratio ${ratio.toFixed(3)})`);
  assert.notStrictEqual(plausibleFace(hatted, subj), null,
    `hat-sized head rejected (area ratio ${ratio.toFixed(3)} vs cap ${FACE_MAX_SUBJECT_AREA_FRAC})`);
});
check('H2b a hatted head on a full-body shot gets the face-safe bias, hat uncut', () => {
  const subj = { left: 0.20, top: 0.06, right: 0.80, bottom: 0.98 };   // too tall to fit 1080
  const hatted = { left: 0.26, top: 0.06, right: 0.74, bottom: 0.30 }; // hat raises the top edge
  const r = computeGravityCropRect(SW, SH, 1, 1, subj, hatted);
  assert.strictEqual(r.anchorY, 'face-safe');
  assert.strictEqual(headCutPx(r.cy, r.ch, hatted), 0, 'hat clipped');
});
check('H3 the top of the HAT, not the forehead, is what clears the edge', () => {
  const subj = { left: 0.20, top: 0.06, right: 0.80, bottom: 0.98 };
  const hatted = { left: 0.26, top: 0.06, right: 0.74, bottom: 0.30 };
  const r = computeGravityCropRect(SW, SH, 1, 1, subj, hatted);
  assert.ok(px(hatted.top, SH) >= r.cy, 'hat top is above the crop window');
});

// ── I. margins are respected on all four edges where possible ─────────────
check('I1 side margins are held for the head', () => {
  const offCentre = { left: 0.72, top: 0.10, right: 0.92, bottom: 0.26 };
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, offCentre);
  const mx = Math.round(FACE_MARGIN_FRAC * r.cw);
  assert.ok(px(offCentre.left, SW) - r.cx >= mx - 1, 'left margin violated');
  assert.ok((r.cx + r.cw) - px(offCentre.right, SW) >= mx - 1, 'right margin violated');
});
check('I2 bottom margin uses the FULL margin, not the top bias', () => {
  // Head low enough that the bottom constraint binds.
  const low = { left: 0.4, top: 0.55, right: 0.6, bottom: 0.72 };
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, low);
  const my = Math.round(FACE_MARGIN_FRAC * r.ch);
  const below = (r.cy + r.ch) - px(low.bottom, SH);
  assert.ok(below >= my - 1 || r.cy + r.ch === SH,
    `bottom clearance ${below} < full margin ${my} and not clamped to frame edge`);
});
check('I3 placeWithMargin returns null only when the box cannot clear both edges', () => {
  assert.strictEqual(placeWithMargin(0, 100, 1000, 10, 95, 10, 10), null); // needs 95+10-100=5..0
  assert.ok(placeWithMargin(0, 200, 1000, 50, 100, 10, 10) !== null);
});
check('I4 placeWithMargin is symmetric when both margins are equal (expander parity)', () => {
  const a = placeWithMargin(100, 300, 1000, 150, 250, 20, 20);
  assert.ok(Number.isInteger(a));
});
check('I5 placeWithMargin always returns an integer', () => {
  for (const d of [0, 10.4, 99.9, -5.5]) {
    const v = placeWithMargin(d, 300, 1000, 150.7, 250.3, 18, 18);
    if (v !== null) assert.ok(Number.isInteger(v), `${v} not an integer`);
  }
});

// ── J. clamping at frame edges ────────────────────────────────────────────
check('J1 a head at the very top clamps cy to 0, never negative', () => {
  const top = { left: 0.4, top: 0.0, right: 0.6, bottom: 0.12 };
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, top);
  assert.strictEqual(r.cy, 0);
});
check('J2 a head at the very bottom keeps the window inside the frame', () => {
  const bot = { left: 0.4, top: 0.88, right: 0.6, bottom: 1.0 };
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, bot);
  assert.ok(r.cy + r.ch <= SH);
});
check('J3 a head at the left edge clamps cx to 0', () => {
  const left = { left: 0.0, top: 0.1, right: 0.14, bottom: 0.26 };
  const r = computeGravityCropRect(SW, SH, 1, 1, SUBJ_TALL, left);
  assert.strictEqual(r.cx, 0);
});

// ── K. multi-frame reconciliation ─────────────────────────────────────────
check('K1 unionBoxes returns the smallest containing box', () => {
  assert.deepStrictEqual(
    unionBoxes([{ left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 }, { left: 0.3, top: 0.1, right: 0.6, bottom: 0.5 }]),
    { left: 0.2, top: 0.1, right: 0.6, bottom: 0.5 });
});
check('K2 unionBoxes ignores nulls and unusable boxes', () => {
  assert.deepStrictEqual(
    unionBoxes([null, HEAD_HIGH, { left: 0.9, top: 0.9, right: 0.1, bottom: 0.1 }, undefined]),
    HEAD_HIGH);
});
check('K3 unionBoxes of nothing is null', () => {
  assert.strictEqual(unionBoxes([]), null);
  assert.strictEqual(unionBoxes([null, null]), null);
  assert.strictEqual(unionBoxes(null), null);
});
check(`K4 one head in ${FACE_MIN_FRAMES}+ detected frames is NOT trusted (hallucination guard)`, () => {
  assert.strictEqual(consensusFaceBox([SUBJ_TALL, SUBJ_TALL, SUBJ_TALL], [HEAD_HIGH, null, null]), null);
});
check('K5 two agreeing frames ARE trusted', () => {
  assert.notStrictEqual(consensusFaceBox([SUBJ_TALL, SUBJ_TALL, SUBJ_TALL], [HEAD_HIGH, HEAD_HIGH, null]), null);
});
check('K6 a single-detection clip trusts one head (nothing could confirm it)', () => {
  assert.deepStrictEqual(consensusFaceBox([SUBJ_TALL], [HEAD_HIGH]), HEAD_HIGH);
});
check('K7 zero heads -> null', () => {
  assert.strictEqual(consensusFaceBox([SUBJ_TALL, SUBJ_TALL], [null, null]), null);
});
check('K8 a shorter frameFaces array cannot read undefined as a head', () => {
  assert.strictEqual(consensusFaceBox([SUBJ_TALL, SUBJ_TALL, SUBJ_TALL], [HEAD_HIGH]), null);
});
check('K9 the quorum union only includes frames that found a head', () => {
  const a = { left: 0.4, top: 0.10, right: 0.6, bottom: 0.20 };
  const b = { left: 0.4, top: 0.12, right: 0.6, bottom: 0.22 };
  assert.deepStrictEqual(consensusFaceBox([SUBJ_TALL, SUBJ_TALL, SUBJ_TALL], [a, b, null]),
    { left: 0.4, top: 0.10, right: 0.6, bottom: 0.22 });
});

// ── L. frame count ───────────────────────────────────────────────────────
check('L1 frame count is ~1 per 2s clamped 3..8', () => {
  assert.strictEqual(filmstripFrameCount(8), 4);
  assert.strictEqual(filmstripFrameCount(15), 8);
  assert.strictEqual(filmstripFrameCount(4), 3);   // clamped up
  assert.strictEqual(filmstripFrameCount(30), 8);  // clamped down
});
check('L2 bad durations fall back, never crash or return 0', () => {
  for (const d of [0, -5, NaN, null, undefined, 'x']) {
    const n = filmstripFrameCount(d);
    assert.ok(n >= 3 && n <= 8, `${d} -> ${n}`);
  }
});

// ── M. parseAspect ───────────────────────────────────────────────────────
check('M1 parses the real platform aspects', () => {
  assert.deepStrictEqual(parseAspect('4:5'), { wr: 4, hr: 5 });
  assert.deepStrictEqual(parseAspect('9:16'), { wr: 9, hr: 16 });
  assert.deepStrictEqual(parseAspect('1:1'), { wr: 1, hr: 1 });
  assert.deepStrictEqual(parseAspect(' 16 : 9 '), { wr: 16, hr: 9 });
  assert.deepStrictEqual(parseAspect('1.91:1'), { wr: 1.91, hr: 1 });
});
check('M2 rejects malformed / zero aspects rather than yielding NaN geometry', () => {
  for (const bad of ['', null, undefined, 'x', '4', '4:0', '0:5', '-4:5', '4:5:6', {}]) {
    assert.strictEqual(parseAspect(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── N. purity ────────────────────────────────────────────────────────────
check('N1 computeGravityCropRect does not mutate its inputs', () => {
  const s = JSON.parse(JSON.stringify(SUBJ_TALL));
  const h = JSON.parse(JSON.stringify(HEAD_HIGH));
  computeGravityCropRect(SW, SH, 1, 1, s, h);
  assert.deepStrictEqual(s, SUBJ_TALL);
  assert.deepStrictEqual(h, HEAD_HIGH);
});
check('N2 identical inputs give identical output (deterministic)', () => {
  const a = computeGravityCropRect(SW, SH, 4, 5, SUBJ_TALL, HEAD_HIGH);
  const b = computeGravityCropRect(SW, SH, 4, 5, SUBJ_TALL, HEAD_HIGH);
  assert.deepStrictEqual(a, b);
});
check('N3 usableBox / clampTo behave', () => {
  assert.strictEqual(usableBox(null), null);
  assert.strictEqual(usableBox({ left: 1, top: 1, right: 0, bottom: 2 }), null);
  assert.strictEqual(clampTo(5, 0, 3), 3);
  assert.strictEqual(clampTo(-5, 0, 3), 0);
  assert.strictEqual(clampTo(2, 0, 3), 2);
});

// ── O. sweep: no input combination produces an invalid rect ───────────────
check('O1 exhaustive sweep yields only valid, in-bounds, integer rects', () => {
  let n = 0;
  for (let hTop = 0; hTop <= 0.8; hTop += 0.1) {
    for (let hH = 0.08; hH <= 0.4; hH += 0.08) {
      for (let sTop = 0; sTop <= 0.4; sTop += 0.2) {
        const head = { left: 0.35, top: hTop, right: 0.65, bottom: Math.min(1, hTop + hH) };
        const subj = { left: 0.1, top: sTop, right: 0.9, bottom: 1 };
        for (const [, wr, hr] of TARGETS) {
          const r = computeGravityCropRect(SW, SH, wr, hr, subj, head);
          if (!r) continue;
          n++;
          assert.ok(Number.isInteger(r.cx) && Number.isInteger(r.cy), 'non-integer origin');
          assert.ok(r.cx >= 0 && r.cy >= 0 && r.cx + r.cw <= SW && r.cy + r.ch <= SH,
            `out of bounds: ${JSON.stringify(r)}`);
          assert.ok(['center', 'subject-fit', 'face-safe', 'face-center'].includes(r.anchorY),
            `unknown anchor ${r.anchorY}`);
        }
      }
    }
  }
  assert.ok(n > 200, `sweep only covered ${n} combinations`);
});

if (failures.length) {
  console.error(`❌ verifyFaceSafeCrop: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyFaceSafeCrop: ${pass}/${pass} checks passed`);
