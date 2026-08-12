#!/usr/bin/env node
/**
 * Offline harness for VIDEO_PRODUCT_ANCHOR — named product-region grounding
 * for lifestyle video motion, plus product-first base-plate crop.
 *
 * No DB, no network, no API key.
 *
 *   R*  box → named region (9 grid cells + 4 halves + 0.45–0.55 band).
 *   M*  label matching: stem, person-exclusion, FK, full-frame
 *   P*  prompt contains the block ONLY when flag on + lifestyle + region + under cap
 *   B*  flag-off byte-identity (lifestyle and packshot)
 *   C*  crop chooser truth table (C1–C5, C10). C6–C9 deleted (crop half deferred)
 *   X*  revert-prove each LAND_WITH_FIXES item (mutate tmp → named check fails)
 *
 * Run: node scripts/verifyVideoProductAnchor.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const VEO_PATH = path.join(REPO, 'services/veoPromptBuilder.js');
const ANCHOR_PATH = path.join(REPO, 'services/videoProductAnchor.js');
const CROP_PATH = path.join(REPO, 'services/basePlateCropService.js');
const ATLAS_PATH = path.join(REPO, 'services/atlasVideoService.js');

const VEO_KEY = require.resolve('../services/veoPromptBuilder');
const ANCHOR_KEY = require.resolve('../services/videoProductAnchor');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

const ORIG = {
  VIDEO_PRODUCT_ANCHOR: process.env.VIDEO_PRODUCT_ANCHOR,
  VIDEO_LIFESTYLE_PROMPT: process.env.VIDEO_LIFESTYLE_PROMPT
};

function setEnv(key, val) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

function restoreEnv() {
  for (const [k, v] of Object.entries(ORIG)) setEnv(k, v);
  delete require.cache[VEO_KEY];
  delete require.cache[ANCHOR_KEY];
}

function loadAnchor() {
  delete require.cache[ANCHOR_KEY];
  return require('../services/videoProductAnchor');
}

function loadVeo({ lifestyle, anchor } = {}) {
  delete require.cache[VEO_KEY];
  delete require.cache[ANCHOR_KEY];
  setEnv('VIDEO_LIFESTYLE_PROMPT', lifestyle);
  setEnv('VIDEO_PRODUCT_ANCHOR', anchor);
  return require('../services/veoPromptBuilder');
}

// ── fixtures ────────────────────────────────────────────────────────────
// Production-shaped desert UGC: full-body person + pants + shoes.
// refinedProducts are SOURCE PIXELS (1080×1920). subjects are 0..1 GPT boxes.
const DESERT = {
  width: 1080,
  height: 1920,
  subjects: [
    {
      id: 's1',
      role: 'primary',
      description: 'Person standing in the desert',
      x1: 0.25, y1: 0.05, x2: 0.75, y2: 0.98
    }
  ],
  refinedProducts: [
    { id: 'r1', label: 'Black wide-leg pants', confidence: 0.80, x1: 270, y1: 1050, x2: 810, y2: 1700 },
    { id: 'r2', label: 'Silver running shoes', confidence: 0.90, x1: 350, y1: 1650, x2: 730, y2: 1880 },
    { id: 'r3', label: 'Person', confidence: 0.95, x1: 270, y1: 80, x2: 810, y2: 1900 }
  ],
  matchedProducts: []
};

const PANTS_PRODUCT = { _id: 'prod-pants-1', title: 'Wide-leg Track Pants' };
const MUG_PRODUCT = { _id: 'prod-mug-1', title: 'Ceramic Camp Mug' };

function cellBox(cx, cy, size = 0.10) {
  const h = size / 2;
  return { x1: cx - h, y1: cy - h, x2: cx + h, y2: cy + h };
}

const GRID = [
  [1 / 6, 1 / 6, 'upper left third'],
  [0.5, 1 / 6, 'upper third'],
  [5 / 6, 1 / 6, 'upper right third'],
  [1 / 6, 0.5, 'left third'],
  [0.5, 0.5, 'center'],
  [5 / 6, 0.5, 'right third'],
  [1 / 6, 5 / 6, 'lower left third'],
  [0.5, 5 / 6, 'lower third'],
  [5 / 6, 5 / 6, 'lower right third']
];

const HALVES = [
  [{ x1: 0.05, y1: 0.50, x2: 0.95, y2: 0.98 }, 'lower half'],
  [{ x1: 0.05, y1: 0.02, x2: 0.95, y2: 0.50 }, 'upper half'],
  [{ x1: 0.02, y1: 0.10, x2: 0.50, y2: 0.90 }, 'left half'],
  [{ x1: 0.50, y1: 0.10, x2: 0.98, y2: 0.90 }, 'right half']
];

// 0.45–0.55 centroid band is NOT a half — fall through to thirds.
const HALF_BAND = [
  [{ x1: 0.05, y1: 0.25, x2: 0.95, y2: 0.75 }, 'center'],       // cy=0.50
  [{ x1: 0.05, y1: 0.20, x2: 0.95, y2: 0.90 }, 'lower half'],    // cy=0.55
  [{ x1: 0.05, y1: 0.00, x2: 0.95, y2: 0.90 }, 'upper half'],    // cy=0.45
  [{ x1: 0.25, y1: 0.05, x2: 0.75, y2: 0.95 }, 'center'],        // cx=0.50
  [{ x1: 0.20, y1: 0.05, x2: 0.90, y2: 0.95 }, 'right half'],    // cx=0.55
  [{ x1: 0.00, y1: 0.05, x2: 0.90, y2: 0.95 }, 'left half']      // cx=0.45
];

const RETRO_PANT = { _id: 'prod-retro-1', title: 'Retrograde Track Pant' };
const DAILY_LEGGING = { _id: 'prod-leg-1', title: 'Daily Track Legging' };

const LEGGING_MEDIA = {
  width: 1080,
  height: 1920,
  refinedProducts: [
    { id: 'r-leg', label: 'Charcoal high-rise leggings', x1: 270, y1: 1050, x2: 810, y2: 1700 }
  ]
};

// Person-like box is LARGER and shares "pant" — exclusion must drop it.
const PERSON_TRAP = {
  width: 1000,
  height: 1000,
  refinedProducts: [
    { id: 'r-person', label: 'person in track pants', x1: 0.15, y1: 0.10, x2: 0.85, y2: 0.90 },
    { id: 'r-pants', label: 'Black wide-leg pants', x1: 0.20, y1: 0.55, x2: 0.80, y2: 0.95 }
  ]
};

const FULL_FRAME_MEDIA = {
  width: 1000,
  height: 1000,
  refinedProducts: [
    { id: 'r1', label: 'Black wide-leg pants', x1: 0.02, y1: 0.02, x2: 0.98, y2: 0.98 }
  ]
};

const OPERATOR_FIRST = {
  ...DESERT,
  matchedProducts: [
    {
      refinedProductId: null,
      catalogProductId: 'prod-jogger-9',
      source: 'operator'
    },
    {
      refinedProductId: 'r1',
      catalogProductId: 'prod-jogger-9',
      outcome: 'product_match',
      confidence: 0.88,
      source: 'detect'
    }
  ]
};

const GROK_CAPS = { promptByteCap: 4096, paramShape: 'grok' };
const SIX_K_PAD = 'PAD '.repeat(1500); // 6000 chars — assembled prompt + block is over Grok's 4096

const LIFE_ARGS = {
  product: PANTS_PRODUCT,
  media: DESERT,
  variantKind: 'ugc',
  seedStyle: 'lifestyle',
  hasProductReference: false,
  durationSec: 8,
  caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
};

const PACK_ARGS = {
  product: PANTS_PRODUCT,
  media: DESERT,
  hasProductReference: true,
  durationSec: 8,
  caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
};

const SW = 1080;
const SH = 1920;
const PRODUCT_LOW = { left: 0.20, top: 0.55, right: 0.80, bottom: 0.95 };
const FACE_HIGH = { left: 0.35, top: 0.08, right: 0.65, bottom: 0.26 };
const PRODUCT_MID = { left: 0.30, top: 0.40, right: 0.70, bottom: 0.70 };
const FACE_NEAR = { left: 0.35, top: 0.28, right: 0.65, bottom: 0.42 };

function looksLikePixelCoords(s) {
  return /\b\d{2,}\s*(px)?\b/.test(String(s || ''))
    || /\b(x1|y1|x2|y2|left|top)\s*[:=]/.test(String(s || ''));
}

function rewriteLocalRequires(src, fromDir) {
  return src.replace(/require\('(\.\/[^']+)'\)/g, (_, rel) => {
    const abs = path.join(fromDir, rel);
    return `require(${JSON.stringify(abs)})`;
  });
}

function loadMutated(srcPath, transform) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const next = transform(src);
  if (next === src) throw new Error(`mutation did not change ${path.basename(srcPath)}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpa-mut-'));
  const tmp = path.join(tmpDir, path.basename(srcPath));
  fs.writeFileSync(tmp, rewriteLocalRequires(next, path.dirname(srcPath)));
  delete require.cache[tmp];
  const mod = require(tmp);
  return {
    mod,
    cleanup() {
      delete require.cache[tmp];
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\nverifyVideoProductAnchor\n');

// ── R. named-region mapping ────────────────────────────────────────────
console.log('R. box → named region (9 cells + halves)');
{
  const { namedRegionFromBbox } = loadAnchor();
  for (const [cx, cy, want] of GRID) {
    const got = namedRegionFromBbox(cellBox(cx, cy));
    check(`R1 grid (${cx.toFixed(3)},${cy.toFixed(3)}) → ${want}`,
      got === want, `got ${got}`);
  }
  for (const [box, want] of HALVES) {
    const got = namedRegionFromBbox(box);
    check(`R2 half ${want}`, got === want, `got ${got}`);
  }
  for (const [box, want] of HALF_BAND) {
    const got = namedRegionFromBbox(box);
    check(`R2b band (${want})`, got === want, `got ${got}`);
  }
  check('R3 never emits a raw pixel / coord token on the 9-cell set',
    GRID.every(([cx, cy]) => !looksLikePixelCoords(namedRegionFromBbox(cellBox(cx, cy)))));
  check('R4 never emits a raw pixel / coord token on the halves',
    HALVES.every(([box]) => !looksLikePixelCoords(namedRegionFromBbox(box))));
  check('R5 unusable box → null', namedRegionFromBbox(null) === null);
  check('R5 inverted box → null', namedRegionFromBbox({ x1: 0.8, y1: 0.8, x2: 0.2, y2: 0.2 }) === null);
}

// ── M. label matching ──────────────────────────────────────────────────
console.log('\nM. label matching (token overlap; ties → largest)');
{
  const { productRegionForAd, tokenOverlapScore } = loadAnchor();

  const pants = productRegionForAd({ product: PANTS_PRODUCT, media: DESERT });
  check('M1 pants ad returns a hit', !!pants);
  check('M1 pants ad picks the pants label (not person, not shoes)',
    !!pants && /pants/i.test(pants.label) && !/person|shoe/i.test(pants.label),
    pants ? `label=${pants.label}` : 'null');
  check('M1 pants region is a named lower-frame description',
    !!pants && (pants.region === 'lower half' || pants.region === 'lower third'),
    pants ? `region=${pants.region}` : 'null');
  check('M1 pants region is not pixel coords',
    !!pants && !looksLikePixelCoords(pants.region));

  const mug = productRegionForAd({ product: MUG_PRODUCT, media: DESERT });
  check('M2 no token overlap → null (mug vs pants/shoes/person)', mug === null);

  check('M3 empty media → null',
    productRegionForAd({ product: PANTS_PRODUCT, media: {} }) === null);
  check('M3 missing product title + no match evidence → null',
    productRegionForAd({ product: {}, media: DESERT }) === null);

  // Exact match evidence: catalogProductId → refinedProductId, even when
  // the title shares no tokens with the box label.
  const linked = {
    ...DESERT,
    matchedProducts: [{
      refinedProductId: 'r1',
      catalogProductId: 'prod-jogger-9',
      outcome: 'product_match',
      confidence: 0.88,
      source: 'detect'
    }]
  };
  const exact = productRegionForAd({
    product: { _id: 'prod-jogger-9', title: 'AeroKnit Jogger' },
    media: linked
  });
  check('M4 matchedProducts exact link wins over zero token overlap',
    !!exact && /pants/i.test(exact.label),
    exact ? `label=${exact.label}` : 'null');

  // Ties → largest box. Two "pants" labels, different sizes.
  const tied = {
    width: 1000, height: 1000,
    refinedProducts: [
      { id: 'r1', label: 'black pants', x1: 0.40, y1: 0.40, x2: 0.55, y2: 0.55 },
      { id: 'r2', label: 'grey pants', x1: 0.10, y1: 0.60, x2: 0.90, y2: 0.95 }
    ]
  };
  const tieHit = productRegionForAd({
    product: { title: 'Trail Pants' },
    media: tied
  });
  check('M5 token-overlap tie picks the larger box (grey pants)',
    !!tieHit && /grey/i.test(tieHit.label),
    tieHit ? `label=${tieHit.label}` : 'null');

  check('M6 overlap("Track Pants","Black wide-leg pants") ≥ 1',
    tokenOverlapScore('Track Pants', 'Black wide-leg pants') >= 1);
  check('M6 overlap("Track Pants","Person") === 0',
    tokenOverlapScore('Track Pants', 'Person') === 0);

  // Canonical stemming: "Pant"↔"pants", "Legging"↔"leggings"; hyphens split.
  check('M7 overlap("Retrograde Track Pant","Black wide-leg pants") ≥ 1 (pant stem)',
    tokenOverlapScore('Retrograde Track Pant', 'Black wide-leg pants') >= 1);
  check('M7 overlap("Daily Track Legging","Charcoal high-rise leggings") ≥ 1 (legging stem)',
    tokenOverlapScore('Daily Track Legging', 'Charcoal high-rise leggings') >= 1);
  check('M7 hyphen split: "wide-leg" → {wide, leg}',
    tokenOverlapScore('wide-leg', 'wide leg') === 2);
  check('M7 stopwords dropped (the/a/an/in/on/with/women\'s/mens)',
    tokenOverlapScore("women's the a an in on with pant", 'mens pants') === 1);
  const retro = productRegionForAd({ product: RETRO_PANT, media: DESERT });
  check('M7 Retrograde Track Pant anchors via token fallback (pant↔pants)',
    !!retro && /pants/i.test(retro.label) && !/person|shoe/i.test(retro.label),
    retro ? `label=${retro.label}` : 'null');
  const legging = productRegionForAd({ product: DAILY_LEGGING, media: LEGGING_MEDIA });
  check('M7 Daily Track Legging anchors via token fallback (legging↔leggings)',
    !!legging && /legging/i.test(legging.label),
    legging ? `label=${legging.label}` : 'null');

  const personTrap = productRegionForAd({ product: RETRO_PANT, media: PERSON_TRAP });
  check('M8 person-like box excluded from fallback (pants wins, not person)',
    !!personTrap && /pants/i.test(personTrap.label) && !/person/i.test(personTrap.label),
    personTrap ? `label=${personTrap.label}` : 'null');

  const opFirst = productRegionForAd({
    product: { _id: 'prod-jogger-9', title: 'AeroKnit Jogger' },
    media: OPERATOR_FIRST
  });
  check('M9 FK skips operator row with refinedProductId null (detect r1 wins)',
    !!opFirst && /pants/i.test(opFirst.label),
    opFirst ? `label=${opFirst.label}` : 'null');

  const full = productRegionForAd({ product: PANTS_PRODUCT, media: FULL_FRAME_MEDIA });
  check('M10 full-frame box (>0.80 area) → null', full === null);
}

// ── P. prompt injection gates ──────────────────────────────────────────
console.log('\nP. prompt block only when flag on + lifestyle + region');
{
  const on = loadVeo({ lifestyle: 'true', anchor: 'true' });
  const lifeHit = on.buildVeoPrompt(LIFE_ARGS);
  const lifeMiss = on.buildVeoPrompt({ ...LIFE_ARGS, product: MUG_PRODUCT });
  const packHit = on.buildVeoPrompt(PACK_ARGS);
  const expected = on.buildProductAnchorBlock(
    on.productRegionForAd({ product: PANTS_PRODUCT, media: DESERT })
  );

  check('P1 lifestyle+flag+region injects PRODUCT FRAME ANCHOR',
    typeof lifeHit === 'string' && lifeHit.includes('PRODUCT FRAME ANCHOR'));
  check('P1 injected block matches buildProductAnchorBlock',
    !!expected && lifeHit.includes(expected),
    expected ? `block=${expected.slice(0, 80)}…` : 'no block');
  check('P1 block ≤400 chars',
    !!expected && expected.length <= 400,
    `len=${expected && expected.length}`);
  check('P1 block names the pants label',
    !!expected && /pants/i.test(expected));
  check('P1 block names a region (lower half/third)',
    !!expected && /lower (half|third)/.test(expected));
  check('P1 block says remain fully in frame',
    !!expected && /remain fully in frame/i.test(expected));
  check('P1 block says push-in moves TOWARD it',
    !!expected && /TOWARD it, never away/.test(expected));
  check('P1 block says faces may leave, product may not',
    !!expected && /Faces may leave the frame; the product may not/.test(expected));
  check('P1 block has no raw pixel coords',
    !!expected && !looksLikePixelCoords(expected));

  check('P2 lifestyle+flag+NO region → no inject',
    !lifeMiss.includes('PRODUCT FRAME ANCHOR'));
  check('P3 flag on + packshot (no lifestyle path) → no inject',
    !packHit.includes('PRODUCT FRAME ANCHOR'));

  const off = loadVeo({ lifestyle: 'true', anchor: 'false' });
  const lifeOff = off.buildVeoPrompt(LIFE_ARGS);
  check('P4 flag off + lifestyle + region → no inject',
    !lifeOff.includes('PRODUCT FRAME ANCHOR'));

  const unset = loadVeo({ lifestyle: 'true', anchor: undefined });
  check('P5 flag unset (default) + lifestyle + region → no inject',
    !unset.buildVeoPrompt(LIFE_ARGS).includes('PRODUCT FRAME ANCHOR'));

  // Grok 4096: a 6000-byte assembled prompt + the anchor must SKIP the
  // block (silent no-anchor). noText is never displaced; prompt matches
  // the flag-off sibling. Reload so the flag is on at call time.
  const onCap = loadVeo({ lifestyle: 'true', anchor: 'true' });
  const offCap = loadVeo({ lifestyle: 'true', anchor: 'false' });
  const sixKArgs = {
    ...LIFE_ARGS,
    operatorPrompt: SIX_K_PAD,
    caps: GROK_CAPS
  };
  const sixKOn = onCap.buildVeoPrompt(sixKArgs);
  const sixKOff = offCap.buildVeoPrompt(sixKArgs);
  check('P6 Grok 4096: 6000-byte prompt + anchor → anchor absent',
    typeof sixKOn === 'string' && !sixKOn.includes('PRODUCT FRAME ANCHOR'));
  check('P6 Grok 4096: prompt intact vs flag-off (no squeeze)',
    sixKOn === sixKOff);
  check('P6 Grok 4096: noText still present (never displaced)',
    /Do NOT render any text/.test(sixKOn));

  // Under the Omni 20k cap the same lifestyle hit still injects.
  const onOmni = loadVeo({ lifestyle: 'true', anchor: 'true' });
  check('P6 Omni 20k still injects the anchor (skip is cap-relative)',
    onOmni.buildVeoPrompt(LIFE_ARGS).includes('PRODUCT FRAME ANCHOR'));
}

// ── B. flag-off byte-identity ──────────────────────────────────────────
console.log('\nB. flag-off byte-identity');
{
  const offA = loadVeo({ lifestyle: 'true', anchor: 'false' });
  const offB = loadVeo({ lifestyle: 'true', anchor: undefined });
  const lifeA = offA.buildVeoPrompt(LIFE_ARGS);
  const lifeB = offB.buildVeoPrompt(LIFE_ARGS);
  const lifeNoMedia = offA.buildVeoPrompt({ ...LIFE_ARGS, media: null });
  check('B1 flag=false === flag unset on lifestyle prompt', lifeA === lifeB);
  check('B2 flag off: media boxes do not change the lifestyle prompt',
    lifeA === lifeNoMedia);

  const packA = offA.buildVeoPrompt(PACK_ARGS);
  const packBare = offA.buildVeoPrompt({
    product: { title: 'Wide-leg Track Pants' },
    hasProductReference: true,
    durationSec: 8,
    caps: { promptByteCap: 20000, paramShape: 'gemini-omni' }
  });
  check('B3 flag off: packshot with media === packshot without media',
    packA === packBare);

  const on = loadVeo({ lifestyle: 'true', anchor: 'true' });
  const packOn = on.buildVeoPrompt(PACK_ARGS);
  check('B4 flag on does not change the packshot prompt (B14 surface)',
    packOn === packA);

  // OMNI / GROK directive objects are untouched (B14 pins the strings).
  const live = loadVeo({ lifestyle: 'false', anchor: 'true' });
  check('B5 OMNI_DIRECTIVES still exported and non-empty',
    live.OMNI_DIRECTIVES && typeof live.OMNI_DIRECTIVES.doNot === 'string'
    && live.OMNI_DIRECTIVES.doNot.length > 40);
  check('B5 GROK_DIRECTIVES still exported and non-empty',
    live.GROK_DIRECTIVES && typeof live.GROK_DIRECTIVES.doNot === 'string'
    && live.GROK_DIRECTIVES.doNot.length > 40);
}

// ── C. crop chooser truth table ────────────────────────────────────────
console.log('\nC. crop chooser product-first truth table');
{
  const { chooseProductFirstCrop } = loadAnchor();

  const conflict = chooseProductFirstCrop({
    sourceW: SW, sourceH: SH, wr: 4, hr: 5,
    productBox: PRODUCT_LOW, faceBox: FACE_HIGH
  });
  check('C1 conflict (full-body pants + face): returns a rect', !!conflict);
  check('C1 conflict: product wins (anchorY=product, not product-union)',
    conflict && conflict.anchorY === 'product',
    conflict ? `anchorY=${conflict.anchorY}` : 'null');
  // Window should sit over the lower product, not the high face.
  if (conflict) {
    const productCy = ((PRODUCT_LOW.top + PRODUCT_LOW.bottom) / 2) * SH;
    const faceCy = ((FACE_HIGH.top + FACE_HIGH.bottom) / 2) * SH;
    const winMid = conflict.cy + conflict.ch / 2;
    check('C1 conflict: window mid is closer to the product than the face',
      Math.abs(winMid - productCy) < Math.abs(winMid - faceCy),
      `winMid=${winMid.toFixed(0)} product=${productCy.toFixed(0)} face=${faceCy.toFixed(0)}`);
  }

  const bothFit = chooseProductFirstCrop({
    sourceW: SW, sourceH: SH, wr: 4, hr: 5,
    productBox: PRODUCT_MID, faceBox: FACE_NEAR
  });
  check('C2 both fit: union (anchorY=product-union)',
    bothFit && bothFit.anchorY === 'product-union',
    bothFit ? `anchorY=${bothFit.anchorY}` : 'null');

  const productOnly = chooseProductFirstCrop({
    sourceW: SW, sourceH: SH, wr: 4, hr: 5,
    productBox: PRODUCT_LOW, faceBox: null
  });
  check('C3 product only (no face): still crops to product',
    productOnly && productOnly.anchorY === 'product');

  check('C4 no product box → null (caller falls through to face-safe)',
    chooseProductFirstCrop({
      sourceW: SW, sourceH: SH, wr: 4, hr: 5,
      productBox: null, faceBox: FACE_HIGH
    }) === null);

  check('C5 unusable product box → null',
    chooseProductFirstCrop({
      sourceW: SW, sourceH: SH, wr: 4, hr: 5,
      productBox: { left: 0.8, top: 0.8, right: 0.2, bottom: 0.2 },
      faceBox: FACE_HIGH
    }) === null);

  // Crop-service wiring is DEFERRED (coordinate-space error: seed-image
  // boxes applied to generated-video dims). C6–C9 (decideBasePlateCrop
  // productFirst) are deleted, not skipped — the count stays honest.
  // generateForAd still hands media into buildVeoPrompt (the live call site).
  const atlasSrc = fs.readFileSync(ATLAS_PATH, 'utf8');
  check('C10 generateForAd still passes media into promptArgs',
    /const promptArgs = \{[\s\S]*?\bmedia\b/.test(atlasSrc));
  check('C10 generateForAd still loads Media.findById(ad.mediaId)',
    /Media\.findById\(\s*ad\.mediaId\s*\)/.test(atlasSrc));

  const cropSrc = fs.readFileSync(CROP_PATH, 'utf8');
  check('C11 crop service has no product-first wiring (deferred)',
    !cropSrc.includes('resolveProductCropAnchor')
    && !cropSrc.includes('chooseProductFirstCrop')
    && !cropSrc.includes('productFirst'));
}

// ── X. revert-prove (mutate tmp copy → fail → restore) ─────────────────
console.log('\nX. revert-prove (tmp mutations, no residue)');
const revertRows = [];

function prove(name, fn) {
  let failedAsExpected = false;
  let errMsg = '';
  try {
    failedAsExpected = !!fn();
  } catch (err) {
    errMsg = err.message;
    failedAsExpected = false;
  }
  check(`X ${name}`, failedAsExpected, errMsg || (failedAsExpected ? '' : 'mutation did not trip the pin'));
  revertRows.push([name, failedAsExpected ? 'FAILS as required' : 'DID NOT FAIL']);
}

{
  // X1 was tautological (mutate-to-null then assert null). Replaced with
  // a real named-check failure: stemming gone → canonical Pant↔pants dies.
  prove('M7 dies if singular/plural stemming is removed', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      "if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);",
      'if (false && t.length > 3 && t.endsWith(\'s\')) return t.slice(0, -1);'
    ));
    try {
      const score = mod.tokenOverlapScore('Retrograde Track Pant', 'Black wide-leg pants');
      const hit = mod.productRegionForAd({ product: RETRO_PANT, media: DESERT });
      return score === 0 && hit === null;
    } finally { cleanup(); }
  });

  // 2. Drop the lifestyle gate → packshot prompt grows the block
  prove('P3 dies if the lifestyle gate is dropped (packshot injects)', () => {
    setEnv('VIDEO_LIFESTYLE_PROMPT', 'true');
    setEnv('VIDEO_PRODUCT_ANCHOR', 'true');
    const { mod, cleanup } = loadMutated(VEO_PATH, (src) => src.replace(
      'if (lifestyle && isVideoProductAnchorEnabled()) {',
      'if (isVideoProductAnchorEnabled()) {'
    ));
    try {
      const pack = mod.buildVeoPrompt(PACK_ARGS);
      return typeof pack === 'string' && pack.includes('PRODUCT FRAME ANCHOR');
    } finally {
      cleanup();
      setEnv('VIDEO_PRODUCT_ANCHOR', ORIG.VIDEO_PRODUCT_ANCHOR);
      setEnv('VIDEO_LIFESTYLE_PROMPT', ORIG.VIDEO_LIFESTYLE_PROMPT);
    }
  });

  // 3. Drop the flag gate → flag-off lifestyle prompt injects
  prove('P4/B2 die if the flag gate is dropped (flag-off still injects)', () => {
    setEnv('VIDEO_LIFESTYLE_PROMPT', 'true');
    setEnv('VIDEO_PRODUCT_ANCHOR', 'false');
    const { mod, cleanup } = loadMutated(VEO_PATH, (src) => src.replace(
      'if (lifestyle && isVideoProductAnchorEnabled()) {',
      'if (lifestyle) {'
    ));
    try {
      const life = mod.buildVeoPrompt(LIFE_ARGS);
      return typeof life === 'string' && life.includes('PRODUCT FRAME ANCHOR');
    } finally {
      cleanup();
      setEnv('VIDEO_PRODUCT_ANCHOR', ORIG.VIDEO_PRODUCT_ANCHOR);
      setEnv('VIDEO_LIFESTYLE_PROMPT', ORIG.VIDEO_LIFESTYLE_PROMPT);
    }
  });

  // 4. Face wins on conflict → C1 product-wins pin trips
  prove('C1 dies if the chooser prefers the face on conflict', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'const rect = centerOnBox(sourceW, sourceH, wr, hr, product);\n  if (!rect) return null;\n  return { ...rect, anchorY: \'product\' };',
      'const prefer = face || product;\n  const rect = centerOnBox(sourceW, sourceH, wr, hr, prefer);\n  if (!rect) return null;\n  return { ...rect, anchorY: face ? \'face\' : \'product\' };'
    ));
    try {
      const conflict = mod.chooseProductFirstCrop({
        sourceW: SW, sourceH: SH, wr: 4, hr: 5,
        productBox: PRODUCT_LOW, faceBox: FACE_HIGH
      });
      return !conflict || conflict.anchorY !== 'product';
    } finally { cleanup(); }
  });

  // 5. Named region emits pixel coords → R3 / P1 no-pixels pin trips
  prove('R3/P1 die if namedRegionFromBbox emits pixel coords', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'if (!box) return null;\n  const w = box.right - box.left;',
      'if (!box) return null;\n  return `${Math.round(box.left * 1000)},${Math.round(box.top * 1000)}`;\n  const w = box.right - box.left;'
    ));
    try {
      const named = mod.namedRegionFromBbox(cellBox(0.5, 0.5));
      return looksLikePixelCoords(named);
    } finally { cleanup(); }
  });

  prove('M8 dies if person-like boxes stay in the fallback pool', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'function isPersonLike(obj) {\n  if (!obj || typeof obj !== \'object\') return false;',
      'function isPersonLike(obj) {\n  return false;\n  if (!obj || typeof obj !== \'object\') return false;'
    ));
    try {
      const hit = mod.productRegionForAd({ product: RETRO_PANT, media: PERSON_TRAP });
      return !hit || /person/i.test(hit.label);
    } finally { cleanup(); }
  });

  prove('M9 dies if FK .find()s the first catalogProductId row blind', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'const hits = matches.filter((m) => m\n    && m.refinedProductId != null\n    && m.catalogProductId != null\n    && String(m.catalogProductId) === pid);',
      'const first = matches.find((m) => m && m.catalogProductId != null && String(m.catalogProductId) === pid);\n  const hits = first ? [first] : [];'
    ));
    try {
      const hit = mod.productRegionForAd({
        product: { _id: 'prod-jogger-9', title: 'AeroKnit Jogger' },
        media: OPERATOR_FIRST
      });
      return hit === null;
    } finally { cleanup(); }
  });

  prove('M10 dies if the full-frame area guard is removed', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'if (boxArea(winner.box) > FULL_FRAME_AREA) return null;',
      'if (false && boxArea(winner.box) > FULL_FRAME_AREA) return null;'
    ));
    try {
      const hit = mod.productRegionForAd({ product: PANTS_PRODUCT, media: FULL_FRAME_MEDIA });
      return hit != null;
    } finally { cleanup(); }
  });

  prove('R2b dies if half thresholds collapse to 0.5 (midline becomes a half)', () => {
    const { mod, cleanup } = loadMutated(ANCHOR_PATH, (src) => src.replace(
      'if (coversHorizHalf && cy >= 0.55) return \'lower half\';',
      'if (coversHorizHalf && cy >= 0.5) return \'lower half\';'
    ));
    try {
      const mid = { x1: 0.05, y1: 0.25, x2: 0.95, y2: 0.75 }; // cy=0.50
      return mod.namedRegionFromBbox(mid) === 'lower half';
    } finally { cleanup(); }
  });

  prove('P6 dies if the inject site always pushes the anchor (Grok 4096 no longer skips)', () => {
    setEnv('VIDEO_LIFESTYLE_PROMPT', 'true');
    setEnv('VIDEO_PRODUCT_ANCHOR', 'true');
    const { mod, cleanup } = loadMutated(VEO_PATH, (src) => src.replace(
      'if (Buffer.byteLength(next, \'utf8\') <= cap) lines.push(block);',
      'lines.push(block);'
    ));
    try {
      const sixK = mod.buildVeoPrompt({
        ...LIFE_ARGS,
        operatorPrompt: SIX_K_PAD,
        caps: GROK_CAPS
      });
      return typeof sixK === 'string' && sixK.includes('PRODUCT FRAME ANCHOR');
    } finally {
      cleanup();
      setEnv('VIDEO_PRODUCT_ANCHOR', ORIG.VIDEO_PRODUCT_ANCHOR);
      setEnv('VIDEO_LIFESTYLE_PROMPT', ORIG.VIDEO_LIFESTYLE_PROMPT);
    }
  });
}

// Confirm live files were not left mutated.
check('X residue: videoProductAnchor.js still has productRegionForAd body',
  fs.readFileSync(ANCHOR_PATH, 'utf8').includes('const exact = exactMatchCandidate'));
check('X residue: veoPromptBuilder.js still has the dual gate',
  fs.readFileSync(VEO_PATH, 'utf8').includes('if (lifestyle && isVideoProductAnchorEnabled())'));

restoreEnv();

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== REVERT-PROVE table ===');
for (const [name, result] of revertRows) {
  console.log(`  ${result.padEnd(20)}  ${name}`);
}
check('REVERT-PROVE table has ≥6 mutations (one per LAND_WITH_FIXES item)', revertRows.length >= 6);

console.log(`\nverifyVideoProductAnchor: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log('ok');
