#!/usr/bin/env node
/**
 * verifyPmaxTitleInk.mjs — PMax video title ink must stay readable for the
 * WHOLE time the text is on screen, and Meta must not change.
 * Offline: no DB, no network, no API key. ESM (remotion/ is "type":"module").
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Ink was chosen from the single plate sample nearest the group's enter time.
 * A title group stays up for seconds while the shot changes underneath it, so
 * the reading describes the instant the text arrives, not the interval it is
 * visible for.
 *
 * Measured on a delivered 10s PMax 16:9 video (run_1786443391708_874c5eea):
 *
 *   inkBand: main|upperThird lum=0.75 -> dark ink (on-light tokens) best=9.77:1
 *
 * 9.77:1 is an excellent contrast — and it was true at enter+0.5s, when the
 * band was a pale studio wall. The clip then cut to a close-up of a BLACK
 * t-shirt filling that same band, and the headline and review quote became
 * invisible while still on screen. Only the CTA pill and the stars survived.
 *
 * bandStateFor already takes `avoid` and `busy` across time for exactly this
 * reason ("the worst-case texture is what legibility depends on"); luminance
 * was the one signal that never got the same treatment.
 *
 * REVERT-PROOF RECIPE (each must fail this harness — run after mutating):
 *   a) In worstCaseInkForBand, score only the first sample instead of the
 *      worst across all samples                              -> A2/A3 fail
 *   b) Drop the `marginal` escalation (hardcode marginal:false) -> A4 fails
 *   c) Make usesWorstCaseInk return true for everything        -> B2 fails
 *   d) Make usesWorstCaseInk return false for everything       -> B1 fails
 *   e) Return a default object instead of null when a band has
 *      no samples (kills the fallback to the existing path)    -> C1 fails
 */

import { worstCaseInkForBand, usesWorstCaseInk } from '../remotion/lib/plateHints.js';

const INK_DARK_LUM = 0.0091; // #16181D linearised — must match Canonical.jsx
const INK_LIGHT_LUM = 1.0;   // #FFFFFF

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const ink = (samples) => worstCaseInkForBand({ samples }, 'top', INK_DARK_LUM, INK_LIGHT_LUM);
const band = (atSec, lum) => ({ atSec, bands: { top: { lum } } });

// ── A. The delivered clip ───────────────────────────────────────────────
// Four bright samples and ONE dark one. The old nearest-sample rule read a
// bright sample and chose dark ink; the text was still up during the dark
// sample. The majority must NOT win here — the worst case must.
{
  const DELIVERED = [
    band(0.5, 0.75), band(1.5, 0.74), band(3.5, 0.70),
    band(5.5, 0.12),                      // black t-shirt fills the band
    band(7.5, 0.72)
  ];
  const r = ink(DELIVERED);
  check('A1 returns a decision for the delivered clip', !!r);
  check('A2 does NOT pick dark ink when any sampled band is dark', r && r.onLight === false,
    `onLight=${r?.onLight} (dark ink would vanish on the 0.12 sample)`);
  check('A3 worst-case contrast is reported, not the best instant',
    r && r.best < 4.5, `best=${r?.best} — a single bright sample would report ~9.77`);
  check('A4 marginal escalates the shadow when no ink is AA across the clip',
    r && r.marginal === true, `marginal=${r?.marginal}`);
}

// ── A5. A single instant must not be able to outvote the interval ───────
// Same clip, dark sample moved to every position: the answer cannot depend on
// WHERE in the clip the dark moment falls.
{
  for (let i = 0; i < 5; i++) {
    const lums = [0.75, 0.74, 0.70, 0.72, 0.71];
    lums[i] = 0.10;
    const r = ink(lums.map((l, n) => band(n * 2, l)));
    check(`A5 dark moment at index ${i} still forces light ink`,
      r && r.onLight === false, `onLight=${r?.onLight}`);
  }
}

// ── A6. Uniform clips keep the obvious answer ───────────────────────────
{
  const allLight = ink([band(0.5, 0.9), band(5, 0.88), band(9, 0.92)]);
  check('A6 an all-light clip still takes DARK ink', allLight && allLight.onLight === true,
    `onLight=${allLight?.onLight}`);
  check('A6 an all-light clip is not marginal', allLight && allLight.marginal === false,
    `best=${allLight?.best}`);

  const allDark = ink([band(0.5, 0.05), band(5, 0.08), band(9, 0.03)]);
  check('A6 an all-dark clip takes LIGHT ink', allDark && allDark.onLight === false,
    `onLight=${allDark?.onLight}`);
  check('A6 an all-dark clip is not marginal', allDark && allDark.marginal === false,
    `best=${allDark?.best}`);
}

// ── B. Meta must not reach this code at all ─────────────────────────────
{
  for (const k of ['pmax_video_16_9', 'pmax_video_9_16', 'pmax_video_1_1', 'pmax_landscape_1_91_1']) {
    check(`B1 ${k} uses worst-case ink`, usesWorstCaseInk(k) === true);
  }
  for (const k of ['meta_feed_1_1', 'meta_feed_4_5', 'meta_reels_9_16', 'meta_stories_9_16']) {
    check(`B2 ${k} keeps the single-instant reading`, usesWorstCaseInk(k) === false,
      'a true here silently changes delivered Meta video');
  }
  for (const v of [null, undefined, '', 0, {}, []]) {
    check(`B3 non-format input (${JSON.stringify(v)}) is not PMax`, usesWorstCaseInk(v) === false);
  }
}

// ── C. Fallback to the existing path is preserved ───────────────────────
{
  check('C1 no samples → null (caller falls back to inkForBand)', ink([]) === null);
  check('C2 null hints → null', worstCaseInkForBand(null, 'top', INK_DARK_LUM, INK_LIGHT_LUM) === null);
  check('C3 band absent on every sample → null',
    worstCaseInkForBand({ samples: [{ atSec: 0, bands: { bottom: { lum: 0.5 } } }] },
      'top', INK_DARK_LUM, INK_LIGHT_LUM) === null);
  check('C4 non-finite lums are ignored, not treated as 0',
    ink([band(0, NaN), band(1, null), band(2, 0.9)])?.onLight === true);
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyPmaxTitleInk: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyPmaxTitleInk: ${passed} checks passed`);
