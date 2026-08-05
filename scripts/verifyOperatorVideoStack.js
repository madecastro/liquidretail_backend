#!/usr/bin/env node
'use strict';
//
// verifyOperatorVideoStack — pins the owner's 2026-08-05 rule that an operator
// who picks images for a deterministic VIDEO gets EXACTLY those images, in
// their pick order, and is TOLD when no catalog image was among them.
//
// Owner, verbatim: "When the user overrides the default and chooses the images
// and the order to send to the video model ... they are the only images sent,
// and they are sent in the order demarcated by the ordering icons (1,2,3)."
// And: "if it doesn't have a catalog image just signal the user there is no
// catalog image and if they choose to override that is at their discretion."
//
// WHAT USED TO HAPPEN: expandDeterministicVideo appended a catalog "anchor"
// the operator never chose whenever none of their picks was a catalog mirror
// for that product. So the stack was picks + 1 surprise image, silently.
//
// THE TRAP THIS HARNESS EXISTS FOR: `perProduct` is a SKIP channel.
// normalizePerProductEntry does `const reason = raw.skipped || raw.reason;
// const skipped = !!reason;` — so stamping the advisory as a `reason` would
// mark a product that SUCCESSFULLY QUEUED as skipped:true and replace its
// "Queued 1 creative(s)." message with a skip message. Hence a separate
// WARNING enum and a separate `warning` field, which must never touch
// `skipped`. Group W pins exactly that separation.
//
// Offline: no DB, no network, no key.

const path = require('path');
const fs   = require('fs');

const {
  REASON, WARNING, normalizePerProductEntry, summarizeEmptyExpansion
} = require('../services/perProductReasons');
const CampaignRun = require('../models/CampaignRun');
const campaignSvc = require('../services/campaignAdsGenerationService');

const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failures.push(label); console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`); }
}
function checkTrue(label, cond) { if (!cond) { failures.push(label); console.log(`FAIL ${label}`); } }

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.entries(vars).forEach(([k, v]) => { if (v == null) delete process.env[k]; else process.env[k] = v; });
  try { return fn(); } finally {
    Object.entries(prev).forEach(([k, v]) => { if (v == null) delete process.env[k]; else process.env[k] = v; });
  }
}

// ── W. The warning channel must never masquerade as a skip ────────────────
(function testWarningChannel() {
  const queued = normalizePerProductEntry({
    productId: 'p1', mediaId: 'm1', referenceMediaIds: ['m1', 'm2'],
    payloads: 1, warning: WARNING.NO_CATALOG_IMAGE
  });
  check('W1 a warning row is NOT skipped', queued.skipped, false);
  check('W1 …and carries no skip reason', queued.reason, null);
  check('W1 …and preserves its payload count', queued.payloads, 1);
  check('W1 …and surfaces the warning code', queued.warning, WARNING.NO_CATALOG_IMAGE);
  checkTrue('W2 the success message is KEPT, not replaced by the advisory',
    /Queued 1 creative\(s\)\./.test(queued.message));
  checkTrue('W2 …and the advisory is appended to it',
    /catalog image/i.test(queued.message) && queued.message.length > 'Queued 1 creative(s).'.length);
  checkTrue('W2 …and it does not read like a skip', !/^Skipped/i.test(queued.message));

  const bothCodes = [WARNING.NO_CATALOG_IN_PICKS, WARNING.NO_CATALOG_IMAGE];
  for (const code of bothCodes) {
    const row = normalizePerProductEntry({ productId: 'p', payloads: 1, warning: code });
    checkTrue(`W3 ${code} produces a distinct human clause`,
      typeof row.message === 'string' && row.message.length > 25);
    check(`W3 ${code} stays non-skipping`, row.skipped, false);
  }

  // A genuinely skipped product must not gain a success-shaped message just
  // because a warning tagged along.
  const skippedRow = normalizePerProductEntry({
    productId: 'p2', skipped: REASON.NO_HERO_MEDIA, warning: WARNING.NO_CATALOG_IMAGE
  });
  check('W4 a skip reason still wins over a warning', skippedRow.skipped, true);
  check('W4 …reason is preserved', skippedRow.reason, REASON.NO_HERO_MEDIA);
  check('W4 …and the warning is dropped entirely', skippedRow.warning, undefined);

  const plain = normalizePerProductEntry({ productId: 'p3', payloads: 1 });
  check('W5 a row with no warning has no warning key at all', 'warning' in plain, false);

  // WARNING must not leak into REASON — that is the whole separation.
  for (const code of Object.values(WARNING)) {
    checkTrue(`W6 WARNING.${code} is not a REASON code`, !Object.values(REASON).includes(code));
  }

  // An empty-run summary must not blame a product that actually queued.
  const summary = summarizeEmptyExpansion({
    perProduct: [normalizePerProductEntry({ productId: 'p1', payloads: 1, warning: WARNING.NO_CATALOG_IMAGE })],
    alreadyQueued: 0
  });
  checkTrue('W7 a warning-only row is not counted as a skip cause',
    !/catalog image/i.test(summary) || !/skipped/i.test(summary));
})();

// ── P. The field must survive persistence (Mongoose strict drops unknowns) ─
(function testPersistence() {
  const perProductPath = CampaignRun.schema.path('perProduct');
  checkTrue('P1 CampaignRun.perProduct is a subdocument array', !!perProductPath && !!perProductPath.schema);
  if (perProductPath?.schema) {
    checkTrue('P2 perProduct declares `warning` (undeclared keys are silently dropped on $set)',
      !!perProductPath.schema.path('warning'));
    checkTrue('P2 …and it is a String', perProductPath.schema.path('warning')?.instance === 'String');
    checkTrue('P3 `reason` still exists and is separate from `warning`',
      !!perProductPath.schema.path('reason'));
  }
})();

// ── K. Kill switch parser must match the house shape exactly ──────────────
(function testKillSwitch() {
  const { isVideoOperatorStackOnlyEnabled: on } = campaignSvc;
  checkTrue('K0 the kill switch helper is exported', typeof on === 'function');
  if (typeof on !== 'function') return;
  check('K1 unset  → ON  (default)',      withEnv({ VIDEO_OPERATOR_STACK_ONLY: null },    on), true);
  check('K1 empty  → ON',                 withEnv({ VIDEO_OPERATOR_STACK_ONLY: '' },      on), true);
  for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
    check(`K2 "${v}" → OFF`, withEnv({ VIDEO_OPERATOR_STACK_ONLY: v }, on), false);
  }
  for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
    check(`K3 "${v}" → ON`, withEnv({ VIDEO_OPERATOR_STACK_ONLY: v }, on), true);
  }
})();

// ── S. Source pins — the append must be gated, not merely reworded ────────
(function testSourcePins() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'campaignAdsGenerationService.js'), 'utf8');

  // The ONLY push onto referenceMediaIds in the anchor block must sit on the
  // flag-OFF branch. If a future edit hoists it above the switch, the operator
  // silently gets an image they did not choose again.
  const anchorStart = src.indexOf('const hasCatalogAnchor');
  const anchorEnd   = src.indexOf('// excludePairings on (productId, mediaId)');
  checkTrue('S0 the anchor block was located', anchorStart > 0 && anchorEnd > anchorStart);
  const block = src.slice(anchorStart, anchorEnd);

  checkTrue('S1 the anchor block consults the kill switch',
    /isVideoOperatorStackOnlyEnabled\(\)/.test(block));
  checkTrue('S2 the append still exists for the flag-OFF path',
    /referenceMediaIds\.push\(anchor\._id\)/.test(block));
  checkTrue('S3 the append is NOT reachable before the switch is consulted',
    block.indexOf('isVideoOperatorStackOnlyEnabled()') < block.indexOf('referenceMediaIds.push(anchor._id)'));
  checkTrue('S4 the flag-ON path stamps a warning instead of mutating the stack',
    /productWarning\s*=\s*PER_PRODUCT_WARNING\.NO_CATALOG_IN_PICKS/.test(block)
    && /productWarning\s*=\s*PER_PRODUCT_WARNING\.NO_CATALOG_IMAGE/.test(block));
  checkTrue('S5 the warning rides the SUCCESS row, never a skip',
    /if \(productWarning\) successRow\.warning = productWarning/.test(src));
  checkTrue('S6 the product is not skipped for lacking a catalog image',
    !/productWarning[\s\S]{0,200}?PER_PRODUCT_REASON\./.test(block));

  // The operator's order is the stack. Nothing may re-sort or dedupe it.
  checkTrue('S7 the stack is a straight copy of the picks, in pick order',
    /referenceMediaIds = picks\.slice\(\)/.test(src));
  const picksBranch = src.slice(src.indexOf('if (picks.length) {'), anchorStart);
  checkTrue('S8 the picks branch does not sort the operator stack', !/\.sort\(/.test(picksBranch));

  // S9 — the flag-ON branch must not GROW the stack by ANY means, not just
  // `.push`. An adversarial review flagged that pinning only `.push` would let
  // a re-append sneak back in as concat/spread/splice/unshift and still pass.
  const onBranchStart = block.indexOf('if (isVideoOperatorStackOnlyEnabled()) {');
  const onBranchEnd   = block.indexOf('} else if (anchor?._id');
  checkTrue('S9 the flag-ON branch was located', onBranchStart >= 0 && onBranchEnd > onBranchStart);
  const onBranch = block.slice(onBranchStart, onBranchEnd);
  for (const mutator of ['push', 'concat', 'unshift', 'splice']) {
    checkTrue(`S9 the flag-ON branch never calls referenceMediaIds.${mutator}`,
      !new RegExp(`referenceMediaIds\\s*\\.\\s*${mutator}\\s*\\(`).test(onBranch));
  }
  checkTrue('S9 …and never reassigns referenceMediaIds with a spread',
    !/referenceMediaIds\s*=\s*\[\s*\.\.\./.test(onBranch));
})();

// ── F. PRODUCT FIDELITY: the prompt must not claim catalog views we lack ──
// Removing the append means an operator stack can now be 100% non-catalog.
// hasProductReference gates a prompt sentence asserting every supplied image
// is a view of the exact catalog SKU — asserting that over three lifestyle
// shots is a false source-of-truth claim on a billable render. Caught by
// adversarial review of this very change.
(function testProductFidelityGate() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8');

  checkTrue('F1 hasProductAnchor is NOT a bare image-count proxy any more',
    !/const hasProductAnchor = imageUrls\.length >= 2;\s*\n/.test(src));
  checkTrue('F2 it requires the stack to actually contain a catalog ref',
    /const hasProductAnchor = imageUrls\.length >= 2 && stackHasCatalogRef/.test(src));
  checkTrue('F3 the catalog test matches on metadata.catalogProductId for THIS product',
    /catalogProductId[\s\S]{0,160}?productOidStr/.test(src));
  checkTrue('F4 an operator-ordered stack is judged on its own docs',
    /orderedReferenceMedia\.some\(isCatalogRefFor\)/.test(src));
  checkTrue('F5 auto-assembly still resolves true (refs are catalog by construction)',
    /:\s*true;/.test(src.slice(src.indexOf('const stackHasCatalogRef'), src.indexOf('const hasProductAnchor'))));

  // The two prompt branches must still exist and stay distinguishable.
  const prompt = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'veoPromptBuilder.js'), 'utf8');
  checkTrue('F6 the multi-view claim is still gated on hasProductReference',
    /if \(hasProductReference\)/.test(prompt));
  checkTrue('F7 …and the seed-only fidelity wording still exists as the else branch',
    /The product visible in the scene image is the catalog product/.test(prompt));
})();

// ── D. MONEY: dropping the anchor changes the ad identity ─────────────────
(function testDigest() {
  const { computeDeterministicVideoDigest: digest } = campaignSvc;
  checkTrue('D0 computeDeterministicVideoDigest is exported', typeof digest === 'function');
  if (typeof digest !== 'function') return;

  const base = {
    campaignId: 'c1', productId: 'p1', mediaId: 'a',
    platformFormat: 'meta_video_9_16', ctaText: 'Shop', ctaUrl: 'https://x', ctaUrlParams: ''
  };
  const withAnchor    = digest({ ...base, referenceMediaIds: ['a', 'b', 'anchor'] });
  const withoutAnchor = digest({ ...base, referenceMediaIds: ['a', 'b'] });
  const reordered     = digest({ ...base, referenceMediaIds: ['b', 'a'] });

  checkTrue('D1 dropping the appended anchor CHANGES the ad identity — a re-Generate mints a new ad and can bill again (documented, intended)',
    withAnchor !== withoutAnchor);
  checkTrue('D2 pick ORDER is part of the identity (1,2,3 is load-bearing)',
    withoutAnchor !== reordered);
  check('D3 the same stack is stable — identical post-change stacks still dedupe',
    digest({ ...base, referenceMediaIds: ['a', 'b'] }), withoutAnchor);
})();

console.log(failures.length
  ? `\nverifyOperatorVideoStack: ${failures.length} FAILED`
  : 'verifyOperatorVideoStack: all checks passed');
process.exit(failures.length ? 1 : 0);
