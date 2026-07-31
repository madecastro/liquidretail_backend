#!/usr/bin/env node
'use strict';

/**
 * verifyPlatformSurfaces — every declared platform surface is a first-class
 * citizen end to end.
 *
 * WHY THIS EXISTS. platformFormats.js is the single table of surfaces we
 * advertise on, but three separate places had hand-written subsets of it:
 *
 *   - AiCanvasArtifact.platformFormat's enum listed 2 of the 5. Saving a canvas
 *     spec for Stories, Feed 4:5 or PMax threw a ValidationError, so three
 *     surfaces could not persist a spec at all.
 *   - buildFormatConstraintsBlock was `if (reels) {...} else {feed 1:1}`, so
 *     Stories was told it was SQUARE and that it had NO reserved bands — when
 *     it reserves 250px top and bottom for the creator chip and reply input.
 *     The generator was instructed to place chrome exactly where IG covers it.
 *   - ARCHETYPE_WEIGHTING had entries for Reels and PMax only, so Stories got
 *     archetype guidance tuned for square Feed.
 *
 * Each of those is the same bug: a surface added to the table but not to the
 * code that consumes it, failing silently or wrongly rather than loudly. This
 * asserts the table IS the contract, so a new surface — or a new
 * per-surface canonical template — cannot be half-wired.
 *
 * No network, no database.
 */

const path = require('path');
const P    = require(path.join(__dirname, '..', 'services', 'platformFormats.js'));
const spec = require(path.join(__dirname, '..', 'services', 'aiCanvasSpecService.js'));
const AiCanvasArtifact = require(path.join(__dirname, '..', 'models', 'AiCanvasArtifact.js'));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? (pass++, console.log(`  ✓ ${label}`))
     : (fail++, console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`));
};
const truthy = (label, v) => check(label, !!v, true);

console.log('\nverifyPlatformSurfaces\n');

const KEYS = P.PLATFORM_FORMAT_KEYS;
console.log(`A. the surface table (${KEYS.length} surfaces: ${KEYS.join(', ')})`);
truthy('more than one surface is declared', KEYS.length > 1);
for (const k of KEYS) {
  const caps = P.getFormatCaps(k);
  truthy(`${k}: has aspectRatio, canvas, deliveryDims, kinds`,
    caps?.aspectRatio && caps?.canvas?.width && caps?.deliveryDims?.width && Array.isArray(caps?.kinds) && caps.kinds.length);
  truthy(`${k}: declares a safeArea (top and bottom, may be 0)`,
    caps?.safeArea && typeof caps.safeArea.top === 'number' && typeof caps.safeArea.bottom === 'number');
}

// ── B. the artifact can actually persist every surface ────────────────
console.log('\nB. AiCanvasArtifact accepts every declared surface');
for (const k of KEYS) {
  const doc = new AiCanvasArtifact({ platformFormat: k });
  const err = doc.validateSync();
  const rejected = !!err?.errors?.platformFormat;
  check(`${k} passes the platformFormat enum`, rejected, false);
}
const bogus = new AiCanvasArtifact({ platformFormat: 'not_a_surface' });
truthy('an undeclared surface is still rejected', !!bogus.validateSync()?.errors?.platformFormat);

// ── C. format constraints are per-surface, not Feed-for-everyone ──────
console.log('\nC. the generator is told the truth about each surface');
const blocks = {};
for (const k of KEYS) {
  const caps = P.getFormatCaps(k);
  const block = spec.buildFormatConstraintsBlock(k, caps.canvas.width, caps.canvas.height);
  blocks[k] = block;
  truthy(`${k}: names itself in the constraints block`, block.includes(k));
  truthy(`${k}: states its own aspect ratio (${caps.aspectRatio})`, block.includes(caps.aspectRatio));
  truthy(`${k}: states its own canvas height (${caps.canvas.height})`, block.includes(String(caps.canvas.height)));

  const reserves = (caps.safeArea.top || 0) > 0 || (caps.safeArea.bottom || 0) > 0;
  if (reserves) {
    truthy(`${k}: declares its reserved band(s)`, /Reserved (top|bottom) band/.test(block));
    truthy(`${k}: states the HARD chrome rule`, block.includes('HARD:'));
    // The exact band depth must come from the table, not a constant.
    if (caps.safeArea.top)    truthy(`${k}: top band is ${caps.safeArea.top}px per the table`, block.includes(`h:${caps.safeArea.top}}`));
    truthy(`${k}: does NOT claim it has no safe zones`, !block.includes('Safe zones:         none'));
  } else {
    truthy(`${k}: correctly reports no reserved bands`, block.includes('Safe zones:         none'));
  }
}

// The specific regression: Stories must not be handed the Feed block.
console.log('\nD. Stories is not Reels, and is not Feed');
const stories = blocks['meta_stories_9_16'];
const reels   = blocks['meta_reels_9_16'];
const feed    = blocks['meta_feed_1_1'];
if (stories && reels && feed) {
  truthy('Stories does not claim to be square 1:1',      !stories.includes('square 1:1'));
  truthy('Stories does not claim the full canvas',        !stories.includes('Chrome can use the full canvas'));
  truthy('Stories reserves a deeper band than Reels',
    P.getFormatCaps('meta_stories_9_16').safeArea.top > P.getFormatCaps('meta_reels_9_16').safeArea.top);
  truthy('Stories and Reels get DIFFERENT blocks',        stories !== reels);
  truthy('Stories and Feed get DIFFERENT blocks',         stories !== feed);
  truthy('Stories advertises that it accepts image+video',
    stories.includes('image') && stories.includes('video'));
} else {
  fail++; console.log('  ✗ expected meta_stories_9_16, meta_reels_9_16 and meta_feed_1_1 to be declared');
}

// ── E. every surface that reserves screen gets archetype guidance ─────
console.log('\nE. archetype weighting covers every surface with reserved chrome');
const directorSrc = require('fs').readFileSync(
  path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js'), 'utf8');
for (const k of KEYS) {
  const caps = P.getFormatCaps(k);
  const reserves = (caps.safeArea.top || 0) > 0 || (caps.safeArea.bottom || 0) > 0;
  if (!reserves) continue;
  truthy(`${k}: has an ARCHETYPE_WEIGHTING entry`, directorSrc.includes(`${k}: [`));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyPlatformSurfaces: ${pass}/${pass + fail} checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
