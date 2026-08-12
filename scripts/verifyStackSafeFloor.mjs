// verifyStackSafeFloor — no title stack may extend into the platform's blocked band.
//
// THE DELIVERED DEFECT (measured 2026-08-12, PMax landscape, Marine Layer run
// run_1786526271150_7d498862). landscapeYt blocks the bottom 36% of the frame —
// everything below y=691 of 1080, where YouTube paints player chrome. The proof
// group's quote landed at y=647..684, safely above it. The rating and review
// lines beneath it landed at y=774..795: a hundred pixels INSIDE the blocked
// band, under the chrome.
//
// WHY IT SURVIVED REVIEW. stackContainerStyle's top-anchored cases set `top` and
// nothing else, so the box had no bottom edge and its flex column grew downward
// without limit. `topFor()` reads like the guard and is not — it clamps where a
// stack STARTS (never below 1 - bottom - 0.05), which constrains nothing about
// how far the stack EXTENDS. A three-line group starting at the last legal top
// clears the floor comfortably.
//
// The file documents the invariant "no spec offset can push content under
// platform UI". That held for `bottom` and `center`, which set a bottom inset,
// and not for `top`, `upperThird` or `lowerThird`, which did not — three of five
// anchors, including the one most likely to be used low in frame.
//
// These checks assert the BOX, not the copy: a bounded box is the only thing
// that holds regardless of how much text a future preset puts in it.
import assert from 'node:assert';
import { stackContainerStyle, SAFE_ZONES } from '../remotion/lib/safeZones.js';

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyStackSafeFloor\n');

const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
const CASES = [
  { name: 'landscape/landscapeYt', format: 'landscape', safeZoneKey: 'landscapeYt', width: 1920, height: 1080 },
  { name: 'vertical/verticalYt',   format: 'vertical',  safeZoneKey: 'verticalYt',  width: 1080, height: 1920 },
  { name: 'square/squareYt',       format: 'square',    safeZoneKey: 'squareYt',    width: 1080, height: 1080 },
];

for (const c of CASES) {
  const zone = SAFE_ZONES[c.safeZoneKey];
  const blockedTopPx = c.height * (1 - zone.bottom);

  for (const anchor of ANCHORS) {
    ok(`${c.name} ${anchor}: box cannot reach the blocked band`, () => {
      const s = stackContainerStyle({
        format: c.format, safeZoneKey: c.safeZoneKey, anchor,
        offsetX: 0, offsetY: 0, width: c.width, height: c.height,
      });
      // Every anchor must yield a BOUNDED box: a bottom inset at or beyond the
      // blocked band. Without it the flex column has no floor to respect.
      assert.ok(typeof s.bottom === 'number' && Number.isFinite(s.bottom),
        `${anchor} has no numeric bottom inset — the stack can grow through the chrome`);
      const boxBottomPx = c.height - s.bottom;
      assert.ok(boxBottomPx <= blockedTopPx + 0.5,
        `${anchor} box ends at ${boxBottomPx.toFixed(0)}px, past the blocked band at ${blockedTopPx.toFixed(0)}px`);
    });
  }

  ok(`${c.name}: a downward offset still cannot break the floor`, () => {
    // The invariant is about SPEC OFFSETS specifically — that is the wording in
    // safeZones.js, and an author pushing a group down is the obvious attack.
    for (const anchor of ANCHORS) {
      for (const offsetY of [0.1, 0.3, 0.9, 5]) {
        const s = stackContainerStyle({
          format: c.format, safeZoneKey: c.safeZoneKey, anchor,
          offsetX: 0, offsetY, width: c.width, height: c.height,
        });
        const boxBottomPx = c.height - s.bottom;
        assert.ok(boxBottomPx <= blockedTopPx + 0.5,
          `${anchor} offsetY=${offsetY} escaped the floor (${boxBottomPx.toFixed(0)}px vs ${blockedTopPx.toFixed(0)}px)`);
      }
    }
  });

  ok(`${c.name}: top-anchored boxes clip rather than paint under chrome`, () => {
    for (const anchor of ['top', 'upperThird', 'lowerThird']) {
      const s = stackContainerStyle({
        format: c.format, safeZoneKey: c.safeZoneKey, anchor,
        offsetX: 0, offsetY: 0, width: c.width, height: c.height,
      });
      assert.strictEqual(s.overflow, 'hidden',
        `${anchor} would let an over-tall group spill past its bounded box`);
    }
  });

  ok(`${c.name}: no NaN in any numeric field`, () => {
    for (const anchor of ANCHORS) {
      const s = stackContainerStyle({
        format: c.format, safeZoneKey: c.safeZoneKey, anchor,
        offsetX: 0, offsetY: 0, width: c.width, height: c.height,
      });
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'number') {
          assert.ok(Number.isFinite(v), `${anchor}.${k} is not finite — a NaN inset paints over the whole frame`);
        }
      }
    }
  });
}

// The measured case, pinned exactly so a regression names the real ad.
ok('the delivered landscape overflow (y=795) is now impossible', () => {
  const H = 1080;
  const s = stackContainerStyle({
    format: 'landscape', safeZoneKey: 'landscapeYt', anchor: 'lowerThird',
    offsetX: 0, offsetY: 0, width: 1920, height: H,
  });
  const boxBottomPx = H - s.bottom;
  assert.ok(boxBottomPx < 795,
    `the box still reaches y=${boxBottomPx.toFixed(0)}; the delivered ad put review text at y=795`);
  assert.ok(boxBottomPx <= 691.5, `box must end at or above the blocked band (691), got ${boxBottomPx.toFixed(0)}`);
});

console.log(`\n✅ verifyStackSafeFloor: ${checks}/${checks} checks passed`);
