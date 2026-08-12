// verifyNoDoubleTitledBand — two title groups must never be visible in the
// same band at the same time.
//
// THE DELIVERED DEFECT (found 2026-08-12, reported by a parallel session that
// pulled the real files off Cloudinary). A shipped Marine Layer "Cloud 9 Terry"
// 9:16 ad rendered TWO different copy strings interleaved glyph-over-glyph:
// the hook headline ("Cloud 9 Terry … Relaxed Comfortable") and the proof quote
// ("Wear it everyday") occupying the same line, completely illegible. 1 of 4
// sampled clips showed it.
//
// WHY IT HAPPENS. Canonical.jsx groups slots by `${phase}|${anchor}` and gives
// EACH group its own container positioned by ANCHOR ALONE (stackContainerStyle).
// Items inside one group stack; two groups that share an anchor do not — their
// containers land on the same box and simply overlay. So the moment a group's
// exit ramp is still running while the next group's enter ramp has started,
// both sets of words paint on top of each other.
//
// canonical.json vertical was doing exactly that:
//     hook  exits 2.4 + 0.6s ramp -> visible until 3.0
//     proof enters 2.7
//   => 0.3s of two live groups in the same upperThird box.
//
// It reads as "intermittent" only because whether you SEE it depends on where
// the sampled frame lands in that handoff, and on how specTimeScale stretches
// the grid onto the real clip length — a longer clip widens the window in
// absolute seconds.
//
// A per-preset patch would not hold: the same shape can reappear in any preset
// anyone authors. This asserts the invariant across EVERY preset and format, so
// the next author is told at test time instead of in a delivered ad.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = path.join(HERE, '..', 'remotion', 'presets');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyNoDoubleTitledBand\n');

// A group's VISIBLE window includes its ramps: a slot is on screen from the
// instant its enter begins until its exit ramp has finished. Comparing bare
// enter/exit points is what let this ship — the 0.6s exit ramp was invisible to
// any such check.
function groupWindows(slots) {
  const byGroup = new Map();
  for (const s of slots || []) {
    const anchor = s?.position?.anchor;
    const t = s?.timing || {};
    if (!anchor || typeof t.enterAtSec !== 'number') continue;
    const key = `${s.phase}|${anchor}`;
    const start = t.enterAtSec;
    // exitAtSec null/absent === "holds to the end of the clip".
    const end = typeof t.exitAtSec === 'number'
      ? t.exitAtSec + (typeof t.exitDurationSec === 'number' ? t.exitDurationSec : 0)
      : Infinity;
    const g = byGroup.get(key) || { key, phase: s.phase, anchor, start: Infinity, end: -Infinity, keys: [] };
    g.start = Math.min(g.start, start);
    g.end = Math.max(g.end, end);
    g.keys.push(s.key);
    byGroup.set(key, g);
  }
  return [...byGroup.values()];
}

function collisionsIn(slots) {
  const groups = groupWindows(slots);
  const out = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i]; const b = groups[j];
      if (a.anchor !== b.anchor) continue;      // different bands never overlay
      if (a.phase === b.phase) continue;        // same group — these STACK, by design
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0) {
        out.push(`${a.key}[${a.keys.join('/')}] ${a.start}-${a.end} ⨯ ${b.key}[${b.keys.join('/')}] ${b.start}-${b.end} (overlap ${overlap.toFixed(2)}s @ ${a.anchor})`);
      }
    }
  }
  return out;
}

const presetFiles = fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.json'));

ok('presets are discoverable', () => {
  assert.ok(presetFiles.length >= 4, `expected preset files, found ${presetFiles.length}`);
});

for (const file of presetFiles) {
  const doc = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, file), 'utf8'));
  const byFormat = doc.byFormat || doc;
  for (const [fmt, block] of Object.entries(byFormat)) {
    const slots = block && typeof block === 'object' ? block.slots : null;
    if (!Array.isArray(slots) || !slots.length) continue;
    ok(`${file} [${fmt}] has no two groups live in one band`, () => {
      const hits = collisionsIn(slots);
      assert.deepStrictEqual(
        hits, [],
        `${file} [${fmt}] would double-title:\n    ${hits.join('\n    ')}`
      );
    });
  }
}

// Guard the detector itself: a check that cannot fail is not a check.
ok('the detector catches a known-bad shape', () => {
  const bad = [
    { key: 'headline', phase: 'hook', position: { anchor: 'upperThird' },
      timing: { enterAtSec: 0.15, exitAtSec: 2.4, exitDurationSec: 0.6 } },
    { key: 'quote', phase: 'proof', position: { anchor: 'upperThird' },
      timing: { enterAtSec: 2.7, exitAtSec: 4.8, exitDurationSec: 0.6 } }
  ];
  assert.strictEqual(collisionsIn(bad).length, 1, 'the exact delivered defect was not detected');
});

ok('same-phase slots sharing an anchor are NOT flagged (they stack)', () => {
  const stacked = [
    { key: 'quote', phase: 'proof', position: { anchor: 'upperThird' },
      timing: { enterAtSec: 2.7, exitAtSec: 4.8, exitDurationSec: 0.6 } },
    { key: 'reviewer', phase: 'proof', position: { anchor: 'upperThird' },
      timing: { enterAtSec: 3.1, exitAtSec: 4.8, exitDurationSec: 0.6 } }
  ];
  assert.deepStrictEqual(collisionsIn(stacked), []);
});

ok('a hold-to-end group still collides with a later group in its band', () => {
  // exitAtSec null means "holds to the end", which must not read as "ends at 0".
  const held = [
    { key: 'cta', phase: 'close', position: { anchor: 'lowerThird' },
      timing: { enterAtSec: 5.4, exitAtSec: null } },
    { key: 'promo', phase: 'outro', position: { anchor: 'lowerThird' },
      timing: { enterAtSec: 7.0, exitAtSec: null } }
  ];
  assert.strictEqual(collisionsIn(held).length, 1);
});

console.log(`\n✅ verifyNoDoubleTitledBand: ${checks}/${checks} checks passed`);
