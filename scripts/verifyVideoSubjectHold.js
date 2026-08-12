#!/usr/bin/env node
/**
 * verifyVideoSubjectHold — the two owner directives of 2026-08-12:
 *
 *   B. "for UGC, we should wait until it has been attached to a product, UGC
 *       that doesn't have a product attached can't use this method."
 *   C. "when there is no product obviously called out, we should ensure the
 *       face is shown and the picture doesn't change very much."
 *
 * Offline. No DB, no network, no key. Calls the SHIPPED functions rather than
 * scanning source text, except where the assertion genuinely is about the
 * prompt string that reaches Omni.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_ANCHOR = path.join(ROOT, 'services/videoProductAnchor.js');
const SRC_BUILDER = path.join(ROOT, 'services/veoPromptBuilder.js');

const anchor = require(SRC_ANCHOR);
const {
  productRegionForAd, attachmentTierForProduct,
  subjectHoldRegionForMedia, buildSubjectHoldBlock,
  videoAnchorRequireMatchEnabled, videoSubjectHoldEnabled,
  ANCHOR_BLOCK_MAX_CHARS
} = anchor;

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(`${name} — ${err.message}`); console.log(`  ✗ ${name}`); }
}
const read = (p) => fs.readFileSync(p, 'utf8');

// Restore env after each arm so arms cannot leak into one another.
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const PID = '507f1f77bcf86cd799439011';
const OTHER_PID = '507f1f77bcf86cd799439099';

// A UGC frame: a person plus a detected garment whose label shares a token
// with the product title, so bestOverlapCandidate WOULD fire on it.
function mediaWith({ outcome, catalogProductId = PID, refinedProductId = 'r1' } = {}) {
  return {
    width: 1000,
    height: 1000,
    refinedProducts: [
      { id: 'r1', label: 'track pants', x1: 200, y1: 600, x2: 700, y2: 950 },
      { id: 'r2', label: 'person', x1: 150, y1: 40, x2: 800, y2: 980 }
    ],
    subjects: [
      { id: 's1', role: 'primary', description: 'a woman standing on a city street',
        x1: 0.15, y1: 0.04, x2: 0.80, y2: 0.98 }
    ],
    matchedProducts: outcome
      ? [{ refinedProductId, catalogProductId, outcome, confidence: 0.9, source: 'detect' }]
      : []
  };
}
const PRODUCT = { _id: PID, title: 'Retrograde Track Pant' };

console.log('\nA. attachmentTierForProduct — the tier the box actually came from');

check('A1 product_match link → product_match', () => {
  assert.equal(
    attachmentTierForProduct({ product: PRODUCT, media: mediaWith({ outcome: 'product_match' }) }),
    'product_match'
  );
});

check('A2 product_category link → product_category (NOT product_match)', () => {
  assert.equal(
    attachmentTierForProduct({ product: PRODUCT, media: mediaWith({ outcome: 'product_category' }) }),
    'product_category'
  );
});

check('A3 no matchedProducts at all (brand_match seed) → none', () => {
  assert.equal(
    attachmentTierForProduct({ product: PRODUCT, media: mediaWith({ outcome: null }) }),
    'none'
  );
});

check('A4 entry for a DIFFERENT product → none', () => {
  const m = mediaWith({ outcome: 'product_match', catalogProductId: OTHER_PID });
  assert.equal(attachmentTierForProduct({ product: PRODUCT, media: m }), 'none');
});

check('A5 no product id → none (cannot be attached to nothing)', () => {
  assert.equal(attachmentTierForProduct({ product: null, media: mediaWith({ outcome: 'product_match' }) }), 'none');
});

check('A6 product_match wins when both tiers are present for one product', () => {
  const m = mediaWith({ outcome: 'product_category' });
  m.matchedProducts.push({
    refinedProductId: 'r1', catalogProductId: PID, outcome: 'product_match',
    confidence: 0.95, source: 'operator'
  });
  assert.equal(attachmentTierForProduct({ product: PRODUCT, media: m }), 'product_match');
});

console.log('\nB. the gate — VIDEO_ANCHOR_REQUIRE_MATCH');

check('B1 flag OFF: a brand_match seed STILL anchors via token overlap (the hole)', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: undefined }, () => {
    assert.equal(videoAnchorRequireMatchEnabled(), false);
    const hit = productRegionForAd({ product: PRODUCT, media: mediaWith({ outcome: null }) });
    assert.ok(hit, 'expected the pre-fix overlap anchor to fire with the flag off');
    assert.ok(/pant/i.test(hit.label), `unexpected label ${hit.label}`);
  });
});

check('B2 flag ON: the same brand_match seed anchors NOTHING', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'true' }, () => {
    assert.equal(
      productRegionForAd({ product: PRODUCT, media: mediaWith({ outcome: null }) }),
      null,
      'an unattached seed must not anchor'
    );
  });
});

check('B3 flag ON: product_category also anchors nothing (could be another SKU)', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'true' }, () => {
    assert.equal(
      productRegionForAd({ product: PRODUCT, media: mediaWith({ outcome: 'product_category' }) }),
      null
    );
  });
});

check('B4 flag ON: a product_match seed STILL anchors — the fix does not break the good case', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'true' }, () => {
    const hit = productRegionForAd({ product: PRODUCT, media: mediaWith({ outcome: 'product_match' }) });
    assert.ok(hit, 'a confident match must still anchor');
    assert.ok(/lower|bottom/i.test(hit.region), `expected a lower-frame region, got "${hit.region}"`);
  });
});

// Isolates the SECOND strict guard (`strict ? exact : exact||overlap`). Both
// guards independently cover B2, so removing either alone left B2 green — this
// is the case where only the overlap refusal stands between us and a guess:
// the seed IS product_match, but its FK names a refinedProductId that does not
// exist, so exactMatchCandidate returns null and the overlap would fire.
function mediaMatchedButDanglingFk() {
  const m = mediaWith({ outcome: 'product_match', refinedProductId: 'r_missing' });
  return m;
}

check('B6 flag ON: a product_match seed with a dangling FK anchors NOTHING (no overlap guess)', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'true' }, () => {
    assert.equal(
      attachmentTierForProduct({ product: PRODUCT, media: mediaMatchedButDanglingFk() }),
      'product_match',
      'precondition: the tier gate must PASS so this isolates the overlap refusal'
    );
    assert.equal(
      productRegionForAd({ product: PRODUCT, media: mediaMatchedButDanglingFk() }),
      null,
      'strict mode must anchor only the FK-resolved box, never a token-overlap guess'
    );
  });
});

check('B6b flag OFF: that same seed DOES fall back to the overlap (pre-fix behaviour)', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: undefined }, () => {
    assert.ok(productRegionForAd({ product: PRODUCT, media: mediaMatchedButDanglingFk() }),
      'flag-off must keep the historical exact||overlap cascade');
  });
});

check('B5 the gate is === true, not truthy — the string "false" must not opt in', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'false' }, () => {
    assert.equal(videoAnchorRequireMatchEnabled(), false);
    assert.ok(productRegionForAd({ product: PRODUCT, media: mediaWith({ outcome: null }) }),
      'VIDEO_ANCHOR_REQUIRE_MATCH="false" must behave as OFF');
  });
});

console.log('\nC. the hold — VIDEO_SUBJECT_HOLD');

check('C1 subjectHoldRegionForMedia finds the person', () => {
  const held = subjectHoldRegionForMedia(mediaWith({ outcome: null }));
  assert.ok(held, 'expected a person hold region');
  assert.ok(/person|woman/i.test(held.label), `unexpected hold label ${held.label}`);
  assert.ok(held.region, 'hold region must be named');
});

check('C2 no person in frame → no hold region (a flat-lay must not get one)', () => {
  const m = { width: 1000, height: 1000, refinedProducts: [
    { id: 'r1', label: 'track pants', x1: 200, y1: 600, x2: 700, y2: 950 }
  ], subjects: [], matchedProducts: [] };
  assert.equal(subjectHoldRegionForMedia(m), null);
});

check('C3 a person filling the frame STILL yields a hold (no full-frame guard)', () => {
  const m = { width: 1000, height: 1000, refinedProducts: [], subjects: [
    { id: 's1', role: 'primary', description: 'a person', x1: 0.01, y1: 0.01, x2: 0.99, y2: 0.99 }
  ], matchedProducts: [] };
  assert.ok(subjectHoldRegionForMedia(m), 'holding a full-frame person is the normal UGC case');
});

check('C4 the block forbids movement, keeps the face, and stays under the cap', () => {
  const held = subjectHoldRegionForMedia(mediaWith({ outcome: null }));
  const block = buildSubjectHoldBlock(held);
  assert.ok(block, 'expected a hold block');
  assert.ok(block.length <= ANCHOR_BLOCK_MAX_CHARS, `block ${block.length} > ${ANCHOR_BLOCK_MAX_CHARS}`);
  assert.ok(/face/i.test(block), 'block must require the face in frame');
  assert.ok(/no push-in/i.test(block), 'block must forbid a push-in');
  assert.ok(/not identified|no specific product/i.test(block),
    'block must say no product is identified — that is why it exists');
  assert.ok(!/\d{2,}/.test(block), 'block must never carry pixel coords');
});

check('C5 the block never leaks raw coordinates even from a pixel box', () => {
  const block = buildSubjectHoldBlock({ label: 'person', region: 'x1=200,y1=600' });
  assert.equal(block, null, 'a coord-shaped region must be refused');
});

check('C6 hold is a FALLBACK — a resolved product anchor wins', () => {
  // Both flags on, and the seed IS confidently matched: the builder must emit
  // the product anchor, never the hold. Asserted on the builder's wiring.
  const src = read(SRC_BUILDER);
  const idx = src.indexOf('subjectHold = false');
  assert.ok(idx > 0, 'expected the over-cap reset');
  const guard = src.match(/if \(!hit && videoSubjectHoldEnabled\(\)\)/);
  assert.ok(guard, 'the hold must be gated on !hit so a product anchor always wins');
});

check('C7 BOUNDARY: catalog media has no matchedProducts, so strict mode refuses it', () => {
  // Correct today (lifestyle prompt is ugc-only) but a trap for whoever lands
  // VIDEO_LIFESTYLE_CATALOG. This check exists so that lands loudly.
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: 'true' }, () => {
    const catalogMedia = {
      width: 1000, height: 1000,
      refinedProducts: [{ id: 'r1', label: 'track pants', x1: 200, y1: 600, x2: 700, y2: 950 }],
      subjects: [], matchedProducts: []
    };
    assert.equal(productRegionForAd({ product: PRODUCT, media: catalogMedia }), null,
      'if this ever returns a hit, attachmentTierForProduct grew a catalog case — '
      + 'update the scope comment in videoProductAnchor.js and this check together');
  });
  const src = read(SRC_ANCHOR);
  assert.ok(/VIDEO_LIFESTYLE_CATALOG/.test(src),
    'the catalog boundary must stay documented at the gate');
});

console.log('\nD. prompt consistency — no self-contradicting timeline');

check('D1 the hold timeline drops the product-hunting opener', () => {
  const src = read(SRC_BUILDER);
  const m = src.match(/\} else if \(lifestyle && subjectHold\) \{[\s\S]*?\n  \} else if \(lifestyle\) \{/);
  assert.ok(m, 'expected a dedicated lifestyle+subjectHold timeline branch');
  // Strip // comments: the branch's own comment QUOTES the stock opener in
  // order to explain why it is replaced, which a raw scan reads as the defect.
  // Only the string that reaches Omni is the subject of this assertion.
  const branch = m[0].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/camera finds the product/.test(branch),
    'the hold timeline must NOT tell the camera to find a product');
  assert.ok(/do not search for or single out a product/i.test(branch),
    'the hold timeline must forbid hunting for a product');
  assert.ok(/no push-in, no drift, no reframing/i.test(branch),
    'the hold timeline must clamp motion');
  assert.ok(/face/i.test(branch), 'the hold timeline must keep the face readable');
});

check('D2 the stock lifestyle timeline is UNCHANGED (byte-identity, B14 safety)', () => {
  const src = read(SRC_BUILDER);
  // The original opener must still exist verbatim on the flag-off path.
  assert.ok(src.includes(
    'Scene 1 (0.0–${t1}s): settle into the real moment — gentle camera finds the product already in the lifestyle plate;'
  ), 'the stock lifestyle Scene 1 was reworded — flag-off is no longer byte-identical');
});

check('D3 hold beat times reuse t1/t2 so Remotion specTimeScale still lines up', () => {
  const src = read(SRC_BUILDER);
  const m = src.match(/\} else if \(lifestyle && subjectHold\) \{[\s\S]*?\n  \} else if \(lifestyle\) \{/);
  assert.ok(/\$\{t1\}/.test(m[0]) && /\$\{t2\}/.test(m[0]),
    'the hold timeline must use the shared t1/t2 beats, not its own');
});

check('D4 an over-cap hold block cancels the hold timeline', () => {
  const src = read(SRC_BUILDER);
  assert.ok(/if \(subjectHold && !lines\.includes\(block\)\) subjectHold = false;/.test(src),
    'a dropped block must reset subjectHold, or the timeline holds nothing');
  // And it must NOT be an `else`: verifyVideoProductAnchor P6 rewrites the
  // preceding cap guard to an unconditional push, which a dangling else turns
  // into a syntax error — a revert-proof that dies for the wrong reason.
  assert.ok(!/else subjectHold = false;/.test(src),
    'the reset must be a separate statement, not an else clause (P6 compatibility)');
});

check('D5 both new flags default OFF', () => {
  withEnv({ VIDEO_ANCHOR_REQUIRE_MATCH: undefined, VIDEO_SUBJECT_HOLD: undefined }, () => {
    assert.equal(videoAnchorRequireMatchEnabled(), false);
    assert.equal(videoSubjectHoldEnabled(), false);
  });
});

check('D6 veoPromptBuilder IMPORTS every helper it calls (no-undef class)', () => {
  const src = read(SRC_BUILDER);
  const imp = src.match(/\}\s*=\s*require\('\.\/videoProductAnchor'\)/);
  assert.ok(imp, 'expected a destructured require of videoProductAnchor');
  const block = src.slice(src.lastIndexOf('const {', imp.index), imp.index);
  for (const name of ['videoSubjectHoldEnabled', 'subjectHoldRegionForMedia', 'buildSubjectHoldBlock']) {
    assert.ok(block.includes(name), `${name} is called but not imported`);
    assert.ok(src.includes(`${name}(`), `${name} imported but never called`);
  }
});

console.log(`\nverifyVideoSubjectHold: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
