#!/usr/bin/env node
'use strict';
/**
 * verifyVideoDurationPolicy — pins the 8s→10s standardization fallback.
 *
 * THE DEFECT. config/defaults.env has META_VIDEO_DURATION_SEC=10 (owner
 * 2026-08-11/18) and real Omni clips measure ~10s, but several live
 * fallbacks still used a leftover `|| 8` / `: 8` from the provider
 * default. Video cost is (4k ? $1 : $0.2) + duration × $0.1, so a stale
 * 8s fallback on estimateRenderCostUsd or generateForAd is a real
 * money-adjacent miss.
 *
 * WHAT THIS PINS
 *   A. META_VIDEO_DURATION_SEC reader (10 default, 0 → provider 8s)
 *   B. resolveAdVideoDurationSec prefers a stamped Ad.videoDurationSec
 *   C. estimateRenderCostUsd omitted-duration uses 10s, not leftover 8s
 *
 * Remotion title-timing 8s literals are a DIFFERENT, still-correct
 * concept (authored 8s grid, timeScale onto the real plate) and are
 * not covered here on purpose.
 *
 * Pure + offline except C, which loads atlasVideoService (same as
 * verifyVideoCostReconcile). No DB, no network, no API key.
 */

const assert = require('assert');
const path = require('path');

const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const policy = require(path.join(ROOT, 'src/services/videoDurationPolicy'));
const ATLAS_PATH = path.join(ROOT, 'src/services/atlasVideoService.js');
const atlasSrc = fs.readFileSync(ATLAS_PATH, 'utf8');
let estimateRenderCostUsd = null;
try {
  ({ estimateRenderCostUsd } = require(ATLAS_PATH));
} catch (err) {
  // Bare adgen worktrees have no node_modules (never npm ci — see CLAUDE.md).
  // C1–C3 below degrade to a source pin of the same invariant.
  estimateRenderCostUsd = null;
}

const OMNI = 'google/gemini-omni-flash/image-to-video-developer';

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}: ${err.message}`); console.log(`  ✗ ${label}`); }
}

function withEnv(value, fn) {
  const prev = process.env.META_VIDEO_DURATION_SEC;
  if (value === undefined) delete process.env.META_VIDEO_DURATION_SEC;
  else process.env.META_VIDEO_DURATION_SEC = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.META_VIDEO_DURATION_SEC;
    else process.env.META_VIDEO_DURATION_SEC = prev;
  }
}

console.log('\nverifyVideoDurationPolicy\n');

check('A1 unset env → 10s standard (8s→10s standardization)', () => {
  withEnv(undefined, () => {
    assert.strictEqual(policy.metaVideoDurationSec(), 10);
    assert.strictEqual(policy.fallbackVideoDurationSec(), 10);
  });
});

check('A2 META_VIDEO_DURATION_SEC=10 → 10', () => {
  withEnv('10', () => {
    assert.strictEqual(policy.metaVideoDurationSec(), 10);
    assert.strictEqual(policy.fallbackVideoDurationSec(), 10);
  });
});

check('A3 [KILL SWITCH] META_VIDEO_DURATION_SEC=0 → provider 8s', () => {
  withEnv('0', () => {
    assert.strictEqual(policy.metaVideoDurationSec(), null);
    assert.strictEqual(policy.fallbackVideoDurationSec(), 8);
  });
});

check('B1 stamped Ad.videoDurationSec wins over the standard', () => {
  withEnv('10', () => {
    assert.strictEqual(policy.resolveAdVideoDurationSec({ videoDurationSec: 12 }), 12);
    assert.strictEqual(policy.resolveAdVideoDurationSec({ videoDurationSec: 8 }), 8);
  });
});

check('B2 missing / invalid Ad.videoDurationSec uses the standard', () => {
  withEnv('10', () => {
    assert.strictEqual(policy.resolveAdVideoDurationSec({}), 10);
    assert.strictEqual(policy.resolveAdVideoDurationSec({ videoDurationSec: null }), 10);
    assert.strictEqual(policy.resolveAdVideoDurationSec({ videoDurationSec: 0 }), 10);
  });
});

check('C0 estimateRenderCostUsd omitted-duration uses fallbackVideoDurationSec, not leftover 8', () => {
  const fn = atlasSrc.slice(atlasSrc.indexOf('function estimateRenderCostUsd'));
  const body = fn.slice(0, fn.indexOf('\nfunction ', 10));
  assert.ok(body.includes('fallbackVideoDurationSec'),
    'estimateRenderCostUsd must read META_VIDEO_DURATION_SEC via fallbackVideoDurationSec');
  assert.ok(!/durationSec\s*=\s*8/.test(body),
    'estimateRenderCostUsd still has a leftover durationSec = 8 default');
});

if (estimateRenderCostUsd) {
  check('C1 Omni 720p estimate is $1.00 @ 8s and $1.20 @ 10s (base $0.20 + $0.10/sec)', () => {
    assert.strictEqual(estimateRenderCostUsd({ model: OMNI, durationSec: 8, resolution: '720p' }), 1);
    assert.strictEqual(estimateRenderCostUsd({ model: OMNI, durationSec: 10, resolution: '720p' }), 1.2);
  });

  check('C2 [MONEY] omitted duration estimates the 10s standard, not leftover 8s', () => {
    withEnv('10', () => {
      assert.strictEqual(
        estimateRenderCostUsd({ model: OMNI, resolution: '720p' }),
        1.2,
        'omitted duration fell back to 8s ($1.00) instead of META_VIDEO_DURATION_SEC=10 ($1.20)'
      );
    });
  });

  check('C3 kill switch omitted duration estimates provider 8s', () => {
    withEnv('0', () => {
      assert.strictEqual(estimateRenderCostUsd({ model: OMNI, resolution: '720p' }), 1);
    });
  });
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n` + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`\n${pass} passed`);
