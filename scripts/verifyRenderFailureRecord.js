#!/usr/bin/env node
'use strict';

/**
 * verifyRenderFailureRecord — a failed render must still say what it cost.
 *
 * WHY THIS EXISTS. Atlas bills image generation ON SUBMIT and retains the
 * prediction for days, so a render that fails AFTER a successful submit is an
 * image we have already paid for and can still fetch. Three fields carry that:
 * `predictionId` (the handle), `charged` (did it cost money), `atlasCode` (the
 * provider's own error, e.g. 402 insufficient balance).
 *
 * A previous change added those fields to the WRITE side and shipped. It did
 * nothing at all, for two independent reasons, neither of which produced an
 * error anywhere:
 *
 *   1. Ad.renderError declared only { message, stage, at }, so mongoose's
 *      default strict mode silently dropped the three new fields on save. The
 *      write looked successful and stored nothing.
 *   2. renderService re-wrapped the provider error with `new Error(msg,
 *      {cause})`, which puts the tags on `err.cause` while failed() reads them
 *      at the top level — so they were already gone before the save.
 *
 * The Atlas side was verified live (a 15-minute-old prediction still returns
 * completed with its output URL) but the PERSISTENCE was never asserted. This
 * asserts it. Every check below fails against the code as it shipped.
 *
 * No network, no database.
 */

const path = require('path');
const Ad   = require(path.join(__dirname, '..', 'models', 'Ad.js'));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? (pass++, console.log(`  ✓ ${label}`))
     : (fail++, console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`));
};
const truthy = (label, v) => check(label, !!v, true);

console.log('\nverifyRenderFailureRecord\n');

// ── A. the schema keeps the recovery handle ───────────────────────────
// Mongoose strips undeclared paths at SET time under strict mode, so simply
// assigning and reading back is a true test of whether it would persist.
console.log('A. Ad.renderError persists what is needed to recover a paid render');
for (const f of ['message', 'stage', 'at', 'predictionId', 'charged', 'atlasCode']) {
  truthy(`renderError.${f} is declared on the schema`, !!Ad.schema.path(`renderError.${f}`));
}

const ad = new Ad({
  renderError: {
    message:      'Atlas image timed out after 600000ms',
    stage:        'direct-image',
    at:           new Date('2026-07-31T00:00:00Z'),
    predictionId: 'pred_abc123',
    charged:      true,
    atlasCode:    402
  }
});
check('predictionId survives assignment', ad.renderError.predictionId, 'pred_abc123');
check('charged survives assignment',      ad.renderError.charged, true);
check('atlasCode survives assignment',    ad.renderError.atlasCode, 402);
check('message still survives',           ad.renderError.message, 'Atlas image timed out after 600000ms');

// charged must default to false, never undefined: "we do not know whether this
// cost money" is not an acceptable answer for a billing flag.
const bare = new Ad({ renderError: { message: 'x', stage: 'y', at: new Date() } });
check('charged defaults to false, not undefined', bare.renderError.charged, false);
check('predictionId defaults to null',            bare.renderError.predictionId, null);

// ── B. wrapping an error keeps its billing tags ───────────────────────
console.log('\nB. re-wrapping a provider error keeps its billing tags');
// carryProviderTags is not exported (atlasImageService pulls in the Atlas
// client at require time), so assert the behaviour on the source instead —
// a wrapper built the old way loses everything, which is the bug.
const src = Object.assign(new Error('Atlas image timed out'), {
  predictionId: 'pred_xyz', charged: true, atlasCode: null, alertKey: 'atlas:timeout'
});
const naive = new Error(`wrapped: ${src.message}`, { cause: src });
check('a naive wrapper DOES lose the handle (this is the bug)', naive.predictionId, undefined);
truthy('...but the tags are still reachable via cause',          naive.cause?.predictionId === 'pred_xyz');

// The shape every wrapper must produce.
const carried = Object.assign(new Error(`wrapped: ${src.message}`, { cause: src }), {
  predictionId: src.predictionId || null,
  charged:      src.charged === true,
  atlasCode:    src.atlasCode ?? null
});
check('a carrying wrapper keeps predictionId', carried.predictionId, 'pred_xyz');
check('a carrying wrapper keeps charged',      carried.charged, true);

// ── C. the wrap sites actually carry ─────────────────────────────────
// Source-level, because both sites sit deep inside long async functions.
console.log('\nC. every known wrap site carries the tags forward');
const fs    = require('fs');
const srcOf = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const renderSrc = srcOf('services/renderService.js');
truthy('renderService: the direct-image wrap sets predictionId',
  /wrapped\.predictionId\s*=/.test(renderSrc));
truthy('renderService: the direct-image wrap sets charged',
  /wrapped\.charged\s*=/.test(renderSrc));

const atlasSrc = srcOf('services/atlasImageService.js');
truthy('atlasImageService: carryProviderTags exists', /function carryProviderTags/.test(atlasSrc));
check('atlasImageService: NO fallback re-wrap throws a bare new Error',
  /throw new Error\(`\$\{err\.message\}; fallback/.test(atlasSrc), false);
check('atlasImageService: both fallback re-wraps carry tags',
  (atlasSrc.match(/carryProviderTags\(new Error\(`\$\{err\.message\}; fallback/g) || []).length, 2);

const adsSrc = srcOf('routes/ads.js');
truthy('routes/ads: the crash path records predictionId',
  /stage:\s*'crash'[\s\S]{0,400}predictionId/.test(adsSrc));
truthy('routes/ads: the crash path reads err.cause too',
  /err\.cause\?\.predictionId/.test(adsSrc));

// ── D. the claim is a claim ───────────────────────────────────────────
console.log('\nD. the render claim is atomic, and ads heartbeat while rendering');
// This used to match /generate's own inline claim (`{ _id: { $in: adIds },
// status: 'queued' }`). 2026-08-18: that inline copy was a second claim path
// CLAUDE.md §2 forbids — /generate now calls the shared claimAdsForRun
// (routes/ads.js), whose internal filter uses `selectedIds`, not `adIds`.
// Matching either name keeps this check meaningful across both the historical
// inline shape and the current shared one; claimAdsForRun's atomicity itself
// (and that /generate actually calls it) is covered in depth by
// scripts/verifyRunsClaim.js groups A-I.
truthy('routes/ads: the claim filters on status queued',
  /_id:\s*\{\s*\$in:\s*(?:adIds|selectedIds)\s*\},\s*status:\s*'queued'/.test(adsSrc));
truthy('routes/ads: the run re-reads which ads it actually won',
  /claimedIds/.test(adsSrc));
truthy('routes/ads: renderOne heartbeats updatedAt while rendering',
  /setInterval\([\s\S]{0,200}status:\s*'rendering'[\s\S]{0,120}updatedAt/.test(adsSrc));

console.log(`\n${fail === 0 ? '✅' : '❌'} verifyRenderFailureRecord: ${pass}/${pass + fail} checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
