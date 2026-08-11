#!/usr/bin/env node
'use strict';
/**
 * verifyShotHeuristic — fences the zero-cost packshot/lifestyle sharp
 * heuristic (services/imageShotHeuristicService) and its detect wiring.
 *
 * WHY THIS EXISTS
 * Catalog seed ranking and future image-cap decisions need a free signal for
 * "is this a studio packshot or a lifestyle scene?" without another LLM call.
 * The heuristic writes to Media.technicalInsights (NOT classification.shotType)
 * and resolveSeedStyle documents LLM-over-heuristic precedence so calibration
 * against the LLM label stays possible.
 *
 * Fences:
 *   A*  contract shape + confidence ∈ [0,1]
 *   B*  obvious packshots (white + solid non-white) → packshot
 *   C*  busy noise → lifestyle
 *   D*  mid-case is not forced to a decisive packshot
 *   E*  null / empty / garbage buffer → null, never throws
 *   F*  resolveSeedStyle precedence (LLM wins, heuristic fallback, unknown)
 *   G*  technicalInsights fields declared in models/Media.js (silent-drop trap)
 *   H*  classification.shotType is never written by the new service / detect
 *       hook (scan source text)
 *   I*  flag reader default-true strict-string convention
 *
 * Offline: no DB, no network, no API keys. Synthesizes its own test images
 * with sharp — no fixture files.
 *
 *   node scripts/verifyShotHeuristic.js
 *
 * Revert-prove:
 *   (a) Comment out shotStyle / shotStyleConfidence / shotStyleMetrics in
 *       models/Media.js technicalInsights → G* fails.
 *   (b) Break resolveSeedStyle so heuristic always wins → F* fails.
 *   Report pass counts for both states.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sharp = require('sharp');

const {
  classifyShotStyle,
  resolveSeedStyle,
  isEnabled,
  SHOT_STYLE_THRESHOLDS
} = require('../services/imageShotHeuristicService');

const ROOT = path.join(__dirname, '..');
const MEDIA_SRC = fs.readFileSync(path.join(ROOT, 'models', 'Media.js'), 'utf8');
const HEURISTIC_SRC = fs.readFileSync(
  path.join(ROOT, 'services', 'imageShotHeuristicService.js'), 'utf8'
);
const DETECT_SRC = fs.readFileSync(path.join(ROOT, 'pipelines', 'detect.js'), 'utf8');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${label}: ${detail}` : label);
}
function checkFn(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

// ── Synthetic images (no fixtures) ──────────────────────────────────────────

async function solidWithCentredSquare(bg, sq, size = 256) {
  const base = await sharp({
    create: { width: size, height: size, channels: 3, background: bg }
  }).png().toBuffer();
  const sqSize = Math.round(size * 0.3);
  const square = await sharp({
    create: { width: sqSize, height: sqSize, channels: 3, background: sq }
  }).png().toBuffer();
  return sharp(base)
    .composite([{ input: square, gravity: 'centre' }])
    .png()
    .toBuffer();
}

async function noiseImage(size = 256) {
  const buf = Buffer.alloc(size * size * 3);
  // Deterministic pseudo-noise so the harness is stable across runs.
  let s = 0xC0FFEE;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = (s >>> 16) & 0xff;
  }
  return sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function midCaseImage(size = 256) {
  // Soft textured backdrop (mild wood-ish stripes) + a centred product block.
  // Intended as an ambiguous / non-decisive middle — not a pure seamless
  // packshot and not pure high-entropy noise. Untuned thresholds may still
  // tip it; the assertion only requires it is not a high-confidence packshot.
  const buf = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const stripe = Math.sin(x / 14) * 18 + Math.sin(y / 9) * 8;
      const n = ((x * 13 + y * 29) % 24) - 12;
      const v = Math.max(0, Math.min(255, 170 + stripe + n));
      buf[i] = v; buf[i + 1] = Math.max(0, v - 8); buf[i + 2] = Math.max(0, v - 20);
    }
  }
  const x0 = Math.floor(size * 0.35), x1 = Math.floor(size * 0.65);
  const y0 = Math.floor(size * 0.30), y1 = Math.floor(size * 0.70);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 3;
      buf[i] = 50; buf[i + 1] = 55; buf[i + 2] = 160;
    }
  }
  return sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

function isValidResult(r) {
  if (!r || typeof r !== 'object') return false;
  if (!['packshot', 'lifestyle', 'ambiguous'].includes(r.style)) return false;
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) return false;
  if (!r.metrics || typeof r.metrics !== 'object') return false;
  return true;
}

async function main() {
  console.log('\nverifyShotHeuristic\n');

  // ── I. thresholds exported + flag default ────────────────────────────────
  checkFn('I1 SHOT_STYLE_THRESHOLDS is a non-empty object', () => {
    assert.ok(SHOT_STYLE_THRESHOLDS && typeof SHOT_STYLE_THRESHOLDS === 'object');
    assert.ok(typeof SHOT_STYLE_THRESHOLDS.SCORE_PACKSHOT === 'number');
    assert.ok(typeof SHOT_STYLE_THRESHOLDS.BORDER_STDEV_LIFESTYLE === 'number');
  });
  checkFn('I2 isEnabled() default true when env unset', () => {
    const prev = process.env.CATALOG_SHOT_HEURISTIC_ENABLED;
    delete process.env.CATALOG_SHOT_HEURISTIC_ENABLED;
    try {
      assert.strictEqual(isEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.CATALOG_SHOT_HEURISTIC_ENABLED;
      else process.env.CATALOG_SHOT_HEURISTIC_ENABLED = prev;
    }
  });
  checkFn('I3 isEnabled() false only on explicit string "false"', () => {
    const prev = process.env.CATALOG_SHOT_HEURISTIC_ENABLED;
    try {
      process.env.CATALOG_SHOT_HEURISTIC_ENABLED = 'false';
      assert.strictEqual(isEnabled(), false);
      process.env.CATALOG_SHOT_HEURISTIC_ENABLED = 'FALSE';
      assert.strictEqual(isEnabled(), false);
      process.env.CATALOG_SHOT_HEURISTIC_ENABLED = 'true';
      assert.strictEqual(isEnabled(), true);
      process.env.CATALOG_SHOT_HEURISTIC_ENABLED = '0';
      // strict-string: only 'false' disables — '0' stays on
      assert.strictEqual(isEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.CATALOG_SHOT_HEURISTIC_ENABLED;
      else process.env.CATALOG_SHOT_HEURISTIC_ENABLED = prev;
    }
  });

  // ── A/B/C/D classify synthetic images ────────────────────────────────────
  const whitePack = await solidWithCentredSquare(
    { r: 255, g: 255, b: 255 }, { r: 30, g: 30, b: 30 }
  );
  const blackPack = await solidWithCentredSquare(
    { r: 0, g: 0, b: 0 }, { r: 200, g: 200, b: 200 }
  );
  const redPack = await solidWithCentredSquare(
    { r: 180, g: 40, b: 40 }, { r: 20, g: 20, b: 20 }
  );
  const busy = await noiseImage();
  const mid = await midCaseImage();

  const rWhite = await classifyShotStyle(whitePack);
  const rBlack = await classifyShotStyle(blackPack);
  const rRed   = await classifyShotStyle(redPack);
  const rBusy  = await classifyShotStyle(busy);
  const rMid   = await classifyShotStyle(mid);

  check('A1 white packshot returns contract shape', isValidResult(rWhite),
    rWhite ? JSON.stringify({ style: rWhite.style, conf: rWhite.confidence }) : 'null');
  check('A2 black packshot returns contract shape', isValidResult(rBlack));
  check('A3 red packshot returns contract shape', isValidResult(rRed));
  check('A4 noise returns contract shape', isValidResult(rBusy));
  check('A5 mid-case returns contract shape', isValidResult(rMid));
  check('A6 confidence within 0..1 (white)', rWhite && rWhite.confidence >= 0 && rWhite.confidence <= 1);
  check('A7 metrics includes packshotScore + borderStdev',
    rWhite && typeof rWhite.metrics.packshotScore === 'number'
      && typeof rWhite.metrics.borderStdev === 'number');

  check('B1 solid-white + centred square → packshot',
    rWhite && rWhite.style === 'packshot',
    rWhite ? `got ${rWhite.style} score=${rWhite.metrics.packshotScore}` : 'null');
  check('B2 solid-black + centred shape → packshot (brightness not required)',
    rBlack && rBlack.style === 'packshot',
    rBlack ? `got ${rBlack.style} score=${rBlack.metrics.packshotScore}` : 'null');
  check('B3 solid non-white (red) uniform bg → packshot (polarity trap)',
    rRed && rRed.style === 'packshot',
    rRed ? `got ${rRed.style} score=${rRed.metrics.packshotScore}` : 'null');
  check('B4 black packshot did not require brightBoost',
    rBlack && rBlack.metrics.brightBoostApplied === false);

  check('C1 high-variance noise → lifestyle',
    rBusy && rBusy.style === 'lifestyle',
    rBusy ? `got ${rBusy.style} score=${rBusy.metrics.packshotScore}` : 'null');

  check('D1 mid-case is not a high-confidence packshot',
    rMid && !(rMid.style === 'packshot' && rMid.confidence >= 0.85),
    rMid ? `got ${rMid.style} conf=${rMid.confidence}` : 'null');

  // ── E. failure modes ─────────────────────────────────────────────────────
  let threw = false;
  let rNull = 'sentinel';
  try { rNull = await classifyShotStyle(null); }
  catch (e) { threw = true; }
  check('E1 null buffer → null, no throw', !threw && rNull === null);

  threw = false;
  let rEmpty = 'sentinel';
  try { rEmpty = await classifyShotStyle(Buffer.alloc(0)); }
  catch (e) { threw = true; }
  check('E2 empty buffer → null, no throw', !threw && rEmpty === null);

  threw = false;
  let rGarbage = 'sentinel';
  try { rGarbage = await classifyShotStyle(Buffer.from('not-an-image-at-all')); }
  catch (e) { threw = true; }
  check('E3 truncated/garbage buffer → null, no throw', !threw && rGarbage === null);

  // ── F. resolveSeedStyle precedence ───────────────────────────────────────
  checkFn('F1 LLM lifestyle wins over heuristic packshot', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'lifestyle' },
      technicalInsights: { shotStyle: 'packshot', shotStyleConfidence: 0.99 }
    }), 'lifestyle');
  });
  checkFn('F2 LLM on_model → lifestyle', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'on_model' },
      technicalInsights: { shotStyle: 'packshot' }
    }), 'lifestyle');
  });
  checkFn('F3 LLM product_only → packshot (over heuristic lifestyle)', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'product_only' },
      technicalInsights: { shotStyle: 'lifestyle' }
    }), 'packshot');
  });
  checkFn('F4 LLM flat_lay / detail / packaging → packshot', () => {
    for (const t of ['flat_lay', 'detail', 'packaging']) {
      assert.strictEqual(resolveSeedStyle({
        classification: { shotType: t },
        technicalInsights: { shotStyle: 'lifestyle' }
      }), 'packshot', t);
    }
  });
  checkFn('F5 shotType absent → heuristic used', () => {
    assert.strictEqual(resolveSeedStyle({
      technicalInsights: { shotStyle: 'lifestyle' }
    }), 'lifestyle');
    assert.strictEqual(resolveSeedStyle({
      technicalInsights: { shotStyle: 'packshot' }
    }), 'packshot');
    assert.strictEqual(resolveSeedStyle({
      technicalInsights: { shotStyle: 'ambiguous' }
    }), 'ambiguous');
  });
  checkFn('F6 shotType "unknown" → heuristic used', () => {
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'unknown' },
      technicalInsights: { shotStyle: 'packshot' }
    }), 'packshot');
  });
  checkFn('F7 neither present → unknown', () => {
    assert.strictEqual(resolveSeedStyle({}), 'unknown');
    assert.strictEqual(resolveSeedStyle(null), 'unknown');
    assert.strictEqual(resolveSeedStyle({
      classification: { shotType: 'unknown' },
      technicalInsights: {}
    }), 'unknown');
  });

  // ── G. schema declaration (silent-drop trap) ─────────────────────────────
  // Parse technicalInsights block only — avoids false positives from comments
  // elsewhere, and ensures the fields sit under technicalInsights not
  // classification.
  const tiMatch = MEDIA_SRC.match(/technicalInsights:\s*\{([\s\S]*?)\n\s*\},/);
  check('G1 technicalInsights block exists in Media.js', !!tiMatch);
  const tiBody = tiMatch ? tiMatch[1] : '';
  check('G2 shotStyle declared in technicalInsights',
    /\bshotStyle\s*:/.test(tiBody));
  check('G3 shotStyleConfidence declared in technicalInsights',
    /\bshotStyleConfidence\s*:/.test(tiBody));
  check('G4 shotStyleMetrics declared in technicalInsights',
    /\bshotStyleMetrics\s*:/.test(tiBody));
  check('G5 shotStyle enum includes packshot|lifestyle|ambiguous',
    /packshot/.test(tiBody) && /lifestyle/.test(tiBody) && /ambiguous/.test(tiBody));

  // ── H. classification.shotType never written by new code ─────────────────
  // Heuristic service must not reference a write of classification.shotType.
  // Detect hook may READ classification for other reasons; the shot-style
  // block must not assign to shotType. Scan for assignment patterns.
  check('H1 heuristic service does not write classification.shotType',
    !/classification\.shotType\s*=/.test(HEURISTIC_SRC)
    && !/\$set[^;]*shotType/.test(HEURISTIC_SRC)
    && !/shotType:\s*shotStyle/.test(HEURISTIC_SRC));
  // detect.js: the technicalInsights object must not include a shotType key
  // that would clobber classification, and the $set for derivations should
  // only touch technicalInsights/adSuitability — not classification.shotType.
  const derivBlock = DETECT_SRC.match(
    /async function applyMediaLibraryDerivations[\s\S]*?^async function |async function applyMediaLibraryDerivations[\s\S]*?^function pickPrimary/m
  );
  // Fallback: take a window around the function.
  const derivIdx = DETECT_SRC.indexOf('async function applyMediaLibraryDerivations');
  const derivWindow = derivIdx >= 0
    ? DETECT_SRC.slice(derivIdx, derivIdx + 3500)
    : '';
  check('H2 applyMediaLibraryDerivations does not $set classification.shotType',
    !!derivWindow
    && !/classification\.shotType\s*:/.test(derivWindow)
    && !/'classification\.shotType'/.test(derivWindow)
    && !/"classification\.shotType"/.test(derivWindow));
  check('H3 detect wires classifyShotStyle + isShotHeuristicEnabled',
    /classifyShotStyle/.test(DETECT_SRC)
    && /isShotHeuristicEnabled/.test(DETECT_SRC)
    && /shotStyleConfidence/.test(DETECT_SRC));
  check('H4 detect persists shotStyle under technicalInsights object',
    /shotStyle:\s*shotStyle\?\.style/.test(DETECT_SRC)
    || /shotStyle:\s*shotStyle/.test(DETECT_SRC));

  // ── summary ──────────────────────────────────────────────────────────────
  if (failures.length) {
    console.error(`❌ verifyShotHeuristic: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyShotHeuristic: ${pass}/${pass} checks passed`);
}

main().catch((err) => {
  console.error('verifyShotHeuristic crashed:', err);
  process.exit(1);
});
