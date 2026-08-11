#!/usr/bin/env node
/**
 * verifyTitleBeatScale.mjs — specTimeScale must be SYMMETRIC (stretch as
 * well as compress) so authored text beats keep landing on the Omni camera
 * beats at any clip length. Offline: no DB, no network, no API key.
 * ESM (remotion/ is "type":"module" — see remotion/package.json).
 *
 * THE DEFECT THIS PINS
 * ---------------------
 * specTimeScale used to be `clipSec < extent ? clipSec / extent : 1` — it
 * only ever compressed. Presets are authored on a nominal grid (canonical.json
 * is authored on an 8s grid; canonical.json's own description: "Text phases
 * cut ON the camera cuts (2.7/5.1)") with text cuts placed to coincide with
 * the Omni camera-beat cuts that services/veoPromptBuilder.js places at
 * dur/3 and 0.64*dur — beats that SCALE WITH THE ACTUAL CLIP LENGTH.
 *
 * With the old one-directional formula, a clip LONGER than the authored
 * extent (clipSec > extent) fell into the `: 1` branch and text timing froze
 * at the authored-grid seconds while the camera cuts moved outward with
 * dur/3 and 0.64*dur — the alignment silently broke. This matters NOW
 * because the Meta default plate length is moving 8s -> 10s in a sibling
 * lane: an 8s-authored preset rendered at 10s would have text cuts frozen at
 * 2.7/5.1 while the camera cut to 10/3=3.33 and 10*0.64=6.40.
 *
 * THE FIX: scale both ways — `clipSec / extent` unconditionally (with an
 * exact-match short-circuit and degenerate-input guards). See the docstring
 * on specTimeScale in remotion/lib/timing.js for the full "why".
 *
 * REVERT-PROOF RECIPE (must fail this harness — run after mutating):
 *   a) Restore the old one-directional formula
 *      (`clipSec < extent ? clipSec / extent : 1`)        -> C1/D1..D3 fail
 *   b) Drop the exact-match short-circuit so clip==extent produces a
 *      floating scale instead of exactly 1                -> A1..A3 fail
 *   c) Remove the extent>0 guard (division by zero on an empty/degenerate
 *      preset)                                             -> E1..E3 fail
 *   d) Remove the fps>0 guard                               -> E4 fails
 *   e) Re-author canonical.json or canonical-awareness-pmax10.json phases
 *      so their extent drifts off 8 / 10                    -> F1..F4 fail
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { specTimeScale } from '../remotion/lib/timing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; return true; }
  failures.push(detail ? `${label} — ${detail}` : label);
  return false;
}

const close = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

// Minimal spec builder: only `phases` matters to specTimeScale.
const specWithExtent = (extent) => ({ phases: [{ key: 'p', startSec: 0, endSec: extent }] });

// ── A. Exact match -> exactly 1 (byte-identical current configs) ───────────
{
  // Meta 8s clip on an 8s-authored preset.
  const s = specTimeScale(specWithExtent(8), 8 * 24, 24);
  check('A1 clip(8s)==extent(8s) -> exactly 1 (Meta 8s on 8s preset)', s === 1, `got ${s}`);
}
{
  // PMax 10s clip on a 10s-authored preset.
  const s = specTimeScale(specWithExtent(10), 10 * 24, 24);
  check('A2 clip(10s)==extent(10s) -> exactly 1 (PMax 10s on 10s preset)', s === 1, `got ${s}`);
}
{
  // Non-integer extent still hits the exact-match branch precisely.
  const s = specTimeScale(specWithExtent(6.5), 6.5 * 30, 30);
  check('A3 clip==extent -> exactly 1 for a non-integer extent too', s === 1, `got ${s}`);
}

// ── B. Compression (short plate) unchanged from before ──────────────────────
{
  // 6s clip, 8s extent -> 0.75 (existing behaviour, must not regress).
  const s = specTimeScale(specWithExtent(8), 6 * 24, 24);
  check('B1 clip(6s) < extent(8s) -> 0.75 (compression unchanged)',
    close(s, 0.75, 1e-9), `got ${s}`);
}

// ── C. Stretch (long plate) — THE FIX ───────────────────────────────────────
{
  // 10s clip, 8s extent -> 1.25 (this is the new behaviour; old code
  // returned exactly 1 here since clipSec(10) was NOT < extent(8)).
  const s = specTimeScale(specWithExtent(8), 10 * 24, 24);
  check('C1 clip(10s) > extent(8s) -> 1.25 (stretches — was frozen at 1 before the fix)',
    close(s, 1.25, 1e-9), `got ${s}`);
}

// ── D. THE POINT — scaled beats track veoPromptBuilder's camera beats ───────
// veoPromptBuilder.js: t1 = dur/3, t2 = dur*0.64. Build a SYNTHETIC 8s-
// authored spec whose cuts sit EXACTLY at 8/3 and 8*0.64 (the idealized
// authoring target the canonical presets approximate) and confirm the scaled
// cut lands within 0.01s of dur/3 / 0.64*dur for several longer clips.
{
  const AUTHORED_EXTENT = 8;
  const cut1 = AUTHORED_EXTENT / 3;        // 2.6667 — dur/3 at the authored length
  const cut2 = AUTHORED_EXTENT * 0.64;      // 5.12   — 0.64*dur at the authored length
  const spec = {
    phases: [
      { key: 'hook', startSec: 0, endSec: cut1 },
      { key: 'proof', startSec: cut1, endSec: cut2 },
      { key: 'close', startSec: cut2, endSec: AUTHORED_EXTENT },
    ],
  };
  for (const dur of [10, 12, 15]) {
    const fps = 24;
    const scale = specTimeScale(spec, dur * fps, fps);
    const scaledCut1 = cut1 * scale;
    const scaledCut2 = cut2 * scale;
    const camT1 = dur / 3;
    const camT2 = dur * 0.64;
    check(`D${dur}a scaled cut1 within 0.01s of camera t1 (dur=${dur}s)`,
      close(scaledCut1, camT1, 0.01),
      `scaledCut1=${scaledCut1.toFixed(4)} camT1=${camT1.toFixed(4)}`);
    check(`D${dur}b scaled cut2 within 0.01s of camera t2 (dur=${dur}s)`,
      close(scaledCut2, camT2, 0.01),
      `scaledCut2=${scaledCut2.toFixed(4)} camT2=${camT2.toFixed(4)}`);
  }
}

// ── E. Degenerate inputs -> no NaN / Infinity ───────────────────────────────
{
  const s1 = specTimeScale(specWithExtent(0), 240, 24); // extent 0
  check('E1 extent=0 -> finite fallback (no divide-by-zero)',
    Number.isFinite(s1), `got ${s1}`);
}
{
  const s2 = specTimeScale({ phases: [] }, 240, 24); // no phases at all
  check('E2 no phases -> finite fallback', Number.isFinite(s2), `got ${s2}`);
}
{
  const s3 = specTimeScale(undefined, 240, 24); // no spec at all
  check('E3 undefined spec -> finite fallback', Number.isFinite(s3), `got ${s3}`);
}
{
  const s4 = specTimeScale(specWithExtent(8), 240, 0); // fps=0
  check('E4 fps=0 -> finite fallback (no divide-by-zero)',
    Number.isFinite(s4), `got ${s4}`);
}
{
  const s5 = specTimeScale(specWithExtent(-5), 240, 24); // negative extent
  check('E5 negative extent -> finite fallback', Number.isFinite(s5), `got ${s5}`);
}

// ── F. REAL preset files — extents must stay 8 and 10 ───────────────────────
// Guards against silent re-authoring: if someone edits canonical.json or
// canonical-awareness-pmax10.json and the phase extent drifts off its grid,
// this must trip.
function maxEndSec(spec) {
  return Math.max(0, ...(spec?.phases || []).map((p) => p.endSec || 0));
}

{
  const doc = JSON.parse(readFileSync(path.join(ROOT, 'remotion/presets/canonical.json'), 'utf8'));
  check('F1 canonical.json loads and has byFormat', !!doc?.byFormat);
  for (const fmt of ['vertical', 'feed', 'square', 'landscape']) {
    const spec = doc.byFormat?.[fmt];
    check(`F2 canonical.json/${fmt} exists`, !!spec);
    if (!spec) continue;
    const extent = maxEndSec(spec);
    check(`F3 canonical.json/${fmt} extent is 8`, close(extent, 8, 0.01), `extent=${extent}`);
    // At its own authored length this is still an exact-match -> scale 1.
    const s = specTimeScale(spec, 8 * 24, 24);
    check(`F4 canonical.json/${fmt} timeScale=1 at its own 8s length`, s === 1, `got ${s}`);
  }
}
{
  const doc = JSON.parse(readFileSync(path.join(ROOT, 'remotion/presets/canonical-awareness-pmax10.json'), 'utf8'));
  check('F5 canonical-awareness-pmax10.json loads and has byFormat', !!doc?.byFormat);
  for (const fmt of ['vertical', 'feed', 'square', 'landscape']) {
    const spec = doc.byFormat?.[fmt];
    check(`F6 canonical-awareness-pmax10.json/${fmt} exists`, !!spec);
    if (!spec) continue;
    const extent = maxEndSec(spec);
    check(`F7 canonical-awareness-pmax10.json/${fmt} extent is 10`, close(extent, 10, 0.01), `extent=${extent}`);
    const s = specTimeScale(spec, 10 * 24, 24);
    check(`F8 canonical-awareness-pmax10.json/${fmt} timeScale=1 at its own 10s length`, s === 1, `got ${s}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────
console.log(`verifyTitleBeatScale: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
