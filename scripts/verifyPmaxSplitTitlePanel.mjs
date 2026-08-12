#!/usr/bin/env node
/**
 * verifyPmaxSplitTitlePanel.mjs — PMax 16:9 split-stage reserved copy column.
 * Offline: no DB, no network. ESM because remotion/lib/safeZones.js is
 * "type":"module"; plateIntel is pulled via createRequire.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Split-stage places the product in one vertical half of a 1920×1080 frame
 * and the ad copy in the other (generatively extended) half. Before this
 * primitive there was NO horizontal placement axis:
 *   - titleSpecValidator ANCHORS are purely vertical
 *   - ALIGNS is text-align inside a box, not a reserved column
 *   - stackContainerStyle always spans full width between left/right insets
 *   - landscape maxWidthPct:0.46 is a static left hint with no subject coupling
 *
 * Without panelColumnStyle, copy still paints full-width (or a left-biased
 * full-width stack) and lands on the product. Without panel-aware plate
 * sampling, analyzeFrameBands averages luminance across the product half and
 * can pick the wrong ink for the copy column.
 *
 * Inertness is a hard contract: absent panelSide → full-width sampling range
 * equals today's [0.08, 0.92] and Canonical falls through to stackContainerStyle
 * only. A NaN style paints the whole frame — every numeric field is swept.
 *
 * NO SCRIM. Owner 2026-08-12: legibility is worst-case ink + upstream gates,
 * never a shade behind the type. Panel style must carry no background /
 * backdrop-filter.
 *
 * REVERT-PROOF: let the column run into the bottom chrome band (e.g. force
 * bottom inset < 0.36 on landscapeYt) → the bottom-band check goes red.
 */

import { createRequire } from 'module';
import {
  panelColumnStyle,
  SAFE_ZONES,
  PANEL_CENTER_GUTTER_FRAC,
  PANEL_COLUMN_WIDTH_CAP_FRAC,
} from '../remotion/lib/safeZones.js';

const require = createRequire(import.meta.url);
const {
  resolveBandXRange,
  BAND_X0,
  BAND_X1,
} = require('../services/plateIntelService');

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/** Sweep every numeric field of a style object; NaN/Infinity fail. */
function allFinite(style) {
  if (!style || typeof style !== 'object') return false;
  for (const v of Object.values(style)) {
    if (typeof v === 'number' && !Number.isFinite(v)) return false;
  }
  return true;
}

/** Pixel box from panel style (left/right/top/bottom CSS insets → edges). */
function boxEdges(style, W, H) {
  return {
    left: style.left,
    right: W - style.right,
    top: style.top,
    bottom: H - style.bottom,
  };
}

console.log('verifyPmaxSplitTitlePanel\n');

const W = 1920;
const H = 1080;
const dims = { width: W, height: H };
const zoneKey = 'landscapeYt';
const z = SAFE_ZONES.landscapeYt;

// Measured mid-row clear span on Google's horizontal template (1920×1080).
const CLEAR_X0 = 38;
const CLEAR_X1 = 1758;

// ── 1. West left / east right / never overlap ─────────────────────────────
{
  const west = panelColumnStyle({ zoneKey, panelSide: 'west', dims });
  const east = panelColumnStyle({ zoneKey, panelSide: 'east', dims });
  check('1a west panel returns a style', !!west);
  check('1b east panel returns a style', !!east);
  check('1c west+east numeric fields finite', allFinite(west) && allFinite(east));

  const w = boxEdges(west, W, H);
  const e = boxEdges(east, W, H);
  check('1d west sits in left half (right edge ≤ mid)', w.right <= W / 2 + 1e-6,
    `west.rightEdge=${w.right}`);
  check('1e east sits in right half (left edge ≥ mid)', e.left >= W / 2 - 1e-6,
    `east.leftEdge=${e.left}`);
  check('1f west and east never overlap', w.right <= e.left + 1e-6,
    `west.right=${w.right} east.left=${e.left}`);
  // Gutter: columns must not abut across the midline.
  check('1g center gutter present between columns',
    e.left - w.right >= PANEL_CENTER_GUTTER_FRAC * W - 1,
    `gap=${e.left - w.right} expected≥${PANEL_CENTER_GUTTER_FRAC * W}`);
}

// ── 2. Never into bottom 36% or above top 10% of landscapeYt ───────────────
{
  const west = panelColumnStyle({ zoneKey, panelSide: 'west', dims });
  const east = panelColumnStyle({ zoneKey, panelSide: 'east', dims });
  for (const [label, style] of [['west', west], ['east', east]]) {
    const b = boxEdges(style, W, H);
    check(`2 ${label} top ≥ landscapeYt.top (0.10)`,
      b.top >= z.top * H - 1e-6, `top=${b.top} min=${z.top * H}`);
    check(`2 ${label} bottom edge ≤ 1−landscapeYt.bottom (never into 36% band)`,
      b.bottom <= (1 - z.bottom) * H + 1e-6,
      `bottomEdge=${b.bottom} max=${(1 - z.bottom) * H}`);
    // CSS bottom inset itself must reserve the chrome band.
    check(`2 ${label} CSS bottom inset ≥ landscapeYt.bottom`,
      style.bottom >= z.bottom * H - 1e-6, `bottom=${style.bottom}`);
  }
  // Zone floor is the ship value 0.36 (measured 35.9%).
  check('2 zone bottom is ≥0.355 so the clamp is real', z.bottom >= 0.355,
    `bottom=${z.bottom}`);
}

// ── 3. Mid-row clear span x∈[38,1758] @1920 ────────────────────────────────
{
  for (const side of ['west', 'east']) {
    const style = panelColumnStyle({ zoneKey, panelSide: side, dims });
    const b = boxEdges(style, W, H);
    check(`3 ${side} left ≥ ${CLEAR_X0}px`, b.left >= CLEAR_X0 - 1e-6,
      `left=${b.left}`);
    check(`3 ${side} right ≤ ${CLEAR_X1}px`, b.right <= CLEAR_X1 + 1e-6,
      `right=${b.right}`);
  }
}

// ── 4. Bad input → null, no throw, never NaN ───────────────────────────────
{
  const bads = [
    { label: 'unknown zoneKey', args: { zoneKey: 'notAZone', panelSide: 'west', dims } },
    { label: 'missing dims', args: { zoneKey, panelSide: 'west' } },
    { label: 'null dims', args: { zoneKey, panelSide: 'west', dims: null } },
    { label: 'dims missing width', args: { zoneKey, panelSide: 'west', dims: { height: H } } },
    { label: "panelSide 'up'", args: { zoneKey, panelSide: 'up', dims } },
    { label: 'panelSide null', args: { zoneKey, panelSide: null, dims } },
    { label: 'empty args', args: {} },
  ];
  for (const { label, args } of bads) {
    let threw = false;
    let out;
    try { out = panelColumnStyle(args); } catch (e) { threw = true; out = e; }
    check(`4 ${label} does not throw`, !threw, threw ? String(out) : '');
    check(`4 ${label} returns null`, out === null, `got ${JSON.stringify(out)}`);
  }
  // Happy path still finite (already checked) — also sweep width cap constant.
  check('4 PANEL_COLUMN_WIDTH_CAP_FRAC is 0.46 (landscape maxWidthPct precedent)',
    PANEL_COLUMN_WIDTH_CAP_FRAC === 0.46);
  check('4 PANEL_CENTER_GUTTER_FRAC is finite and positive',
    Number.isFinite(PANEL_CENTER_GUTTER_FRAC) && PANEL_CENTER_GUTTER_FRAC > 0);
}

// ── 5. Absent panelSide → full-width sample range (inertness) ──────────────
{
  const today = { x0: 0.08, x1: 0.92 };
  const absent = resolveBandXRange({});
  const undef = resolveBandXRange({ panelSide: undefined });
  const nulled = resolveBandXRange({ panelSide: null });
  const empty = resolveBandXRange({ panelSide: '' });
  for (const [label, r] of [
    ['{}', absent],
    ['undefined', undef],
    ['null', nulled],
    ["''", empty],
  ]) {
    check(`5 absent (${label}) x0 === ${today.x0}`, r.x0 === today.x0, `x0=${r.x0}`);
    check(`5 absent (${label}) x1 === ${today.x1}`, r.x1 === today.x1, `x1=${r.x1}`);
  }
  check('5 exported BAND_X0/BAND_X1 match the historical 0.08/0.92 loop',
    BAND_X0 === 0.08 && BAND_X1 === 0.92, `BAND_X0=${BAND_X0} BAND_X1=${BAND_X1}`);
}

// ── 6. panelSide set → sample x-range entirely within that half ────────────
{
  const west = resolveBandXRange({ panelSide: 'west' });
  const east = resolveBandXRange({ panelSide: 'east' });
  check('6 west x1 ≤ 0.5', west.x1 <= 0.5 + 1e-9, `x1=${west.x1}`);
  check('6 west x0 ≥ 0', west.x0 >= 0, `x0=${west.x0}`);
  check('6 east x0 ≥ 0.5', east.x0 >= 0.5 - 1e-9, `x0=${east.x0}`);
  check('6 east x1 ≤ 1', east.x1 <= 1 + 1e-9, `x1=${east.x1}`);
  check('6 west range ordered and non-empty', west.x1 > west.x0);
  check('6 east range ordered and non-empty', east.x1 > east.x0);
  // Bad panelSide falls back to full range (not a throw, not a wrong half).
  const bad = resolveBandXRange({ panelSide: 'up' });
  check("6 bad panelSide 'up' falls back to full-width",
    bad.x0 === BAND_X0 && bad.x1 === BAND_X1);
}

// ── 7. No scrim on the panel style ─────────────────────────────────────────
{
  const SCRIM_KEYS = [
    'background', 'backgroundColor', 'backgroundImage',
    'backdropFilter', 'backdrop-filter', 'WebkitBackdropFilter',
  ];
  for (const side of ['west', 'east']) {
    const style = panelColumnStyle({ zoneKey, panelSide: side, dims });
    for (const k of SCRIM_KEYS) {
      check(`7 ${side} has no ${k}`, style[k] == null || style[k] === 'none' || style[k] === 'transparent',
        `got ${style[k]}`);
    }
  }
}

// ── Width geometry sanity (documented 0.405 west under landscapeYt) ────────
{
  const west = panelColumnStyle({ zoneKey, panelSide: 'west', dims });
  const w = boxEdges(west, W, H);
  const widthFrac = (w.right - w.left) / W;
  // Cap is 0.46; under landscapeYt left inset the effective west width is
  // half − gutter/2 − left = 0.5 − 0.02 − 0.075 = 0.405.
  check('W west width frac ≤ PANEL_COLUMN_WIDTH_CAP_FRAC',
    widthFrac <= PANEL_COLUMN_WIDTH_CAP_FRAC + 1e-9, `widthFrac=${widthFrac}`);
  check('W west width frac ≈ 0.405 under landscapeYt',
    Math.abs(widthFrac - 0.405) < 0.02, `widthFrac=${widthFrac}`);
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPmaxSplitTitlePanel: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyPmaxSplitTitlePanel: ${passed}/${total} checks passed`);
