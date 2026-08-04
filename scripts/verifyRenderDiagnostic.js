#!/usr/bin/env node
'use strict';
// verifyRenderDiagnostic — proves services/renderDiagnostic.js is a BYTE-IDENTICAL
// extraction of the former inline row + diagnostic builder in routes/ads.js.
//
// Offline: no DB, no network, no API key.
//
// HOW THIS REVERT-PROVES ITSELF, and why it is built this way:
// the reference implementation below is a FROZEN VERBATIM COPY of the inline
// code as it stood in routes/ads.js at commit bee82b7, immediately before the
// extraction. It is NOT to be "kept in sync" with renderDiagnostic.js — that
// would defeat the entire test. If the two ever disagree, this harness fails,
// which is exactly the signal we want: the extraction was supposed to change
// nothing, so any divergence is a regression.
//
// Date.now() is frozen during every comparison. Both implementations read the
// clock independently, so a real millisecond boundary between the two calls
// could flip a Math.round() and produce a spurious 1-second diff.

const path = require('path');
const rd = require(path.join(__dirname, '..', 'services', 'renderDiagnostic'));

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`);
}

function eq(name, actual, expected) {
  const same = actual === expected;
  ok(name, same, same ? null
    : `expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ── FROZEN REFERENCE — verbatim from routes/ads.js @ bee82b7. DO NOT EDIT. ────
// The only edits are (a) taking `now`/`userById`/`run` as parameters instead of
// closing over route locals, and (b) nothing else.
function referenceRow(a, now, run, userById) {
  const predictionId = a.imageGeneration?.predictionId || a.veoPredictionId || null;
  const stageAgeSec = a.renderStageAt ? Math.round((now - new Date(a.renderStageAt).getTime()) / 1000) : null;
  const t = a.renderStages || {};
  const row = {
    assetId:       String(a._id),
    status:        a.status,
    stage:         a.renderStage || null,
    stageAgeSec,
    stalled:       a.status === 'rendering' && stageAgeSec != null && stageAgeSec > 600,
    kind:          a.kind,
    template:      a.template,
    platformFormat: a.platformFormat,
    aspectRatio:   a.aspectRatio,
    pipeline:      a.imageGeneration?.pipeline || (a.kind === 'video' ? 'veo' : null),
    model:         a.imageGeneration?.model || null,
    predictionId,
    derivedFromMaster: a.kind === 'video' && a.veoAspectRatio === '9:16' && a.aspectRatio !== '9:16',
    timingsMs:     { derive: t.deriveMs ?? null, render: t.renderMs ?? null, upload: t.uploadMs ?? null },
    intent:        a.intentResolution
      ? { requested: a.intentResolution.requested, delivered: a.intentResolution.delivered,
          fellBackFrom: a.intentResolution.fellBackFrom || null,
          dropped: a.intentResolution.droppedRoles || [] }
      : null,
    visionQc:      a.visionQc
      ? { passed: a.visionQc.passed, finalAttempt: a.visionQc.finalAttempt,
          skipped: !!a.visionQc.skipped, disabled: !!a.visionQc.disabled,
          attempts: (a.visionQc.attempts || []).map(t2 => ({
            attempt: t2.attempt, pass: t2.pass, summary: t2.summary,
            discarded: !!t2.discarded, renderUrl: t2.renderUrl || null,
            discardedRenderUrl: t2.discardedRenderUrl || null
          })) }
      : null,
    assetUrl:      a.renderUrl || null,
    error:         a.renderError?.message || (typeof a.renderError === 'string' ? a.renderError : null),
    attempts:      a.renderAttempts ?? null,
    ids:           {
      campaignId: a.campaignId ? String(a.campaignId) : null,
      runId:      run?.runId || (a.campaignRunIds || [])[0] || null,
      productId:  a.productId ? String(a.productId) : null,
      mediaId:    a.mediaId ? String(a.mediaId) : null,
      brandId:    a.brandId ? String(a.brandId) : null,
      conceptId:  a.conceptId || null
    },
    requestedBy:   (() => {
      const uid = run?.requestedBy ? String(run.requestedBy) : null;
      if (!uid) return null;
      const u = userById.get(uid);
      return u?.email || u?.name || uid;
    })(),
    run:           run ? { status: run.status, total: run.total, succeeded: run.succeeded, failed: run.failed, skipped: run.skipped } : null,
    queuedAt:      a.queuedAt || null,
    renderedAt:    a.renderedAt || null,
    updatedAt:     a.updatedAt || null
  };
  row.diagnostic = [
    `asset=${row.assetId}`,
    `status=${row.status}${row.stalled ? ' STALLED' : ''}`,
    `stage=${row.stage || '-'}${row.stageAgeSec != null ? ` (${row.stageAgeSec}s)` : ''}`,
    `kind=${row.kind} fmt=${row.platformFormat} aspect=${row.aspectRatio}`,
    `pipeline=${row.pipeline || '-'} model=${row.model || '-'}`,
    `prediction=${row.predictionId || '-'}`,
    row.derivedFromMaster ? 'derivedFromMaster=true (cropped, not generated)' : null,
    `timings(ms) derive=${row.timingsMs.derive ?? '-'} render=${row.timingsMs.render ?? '-'} upload=${row.timingsMs.upload ?? '-'}`,
    row.intent ? `intent=${row.intent.delivered}${row.intent.fellBackFrom ? ` (fellBackFrom ${row.intent.fellBackFrom})` : ''}${row.intent.dropped.length ? ` dropped=${row.intent.dropped.join('+')}` : ''}` : null,
    `run=${row.ids.runId || '-'} by=${row.requestedBy || '-'}`,
    `product=${row.ids.productId || '-'} media=${row.ids.mediaId || '-'} concept=${row.ids.conceptId || '-'}`,
    row.error ? `error=${row.error}` : null,
    row.assetUrl ? `asset=${row.assetUrl}` : null
  ].filter(Boolean).join('\n');
  return row;
}
// ── end frozen reference ─────────────────────────────────────────────────────

const FIXED_NOW = 1754200000000;

function withFrozenClock(fn) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try { return fn(); } finally { Date.now = realNow; }
}

// ── fixtures — chosen to exercise every conditional line in the block ────────
const users = new Map([['u1', { email: 'op@reach-social.io', name: 'Op' }]]);

const FIXTURES = [
  {
    name: 'video ad, cropped from master, stalled, intent + error + asset',
    run: { runId: 'run-1', requestedBy: 'u1', status: 'running', total: 3, succeeded: 1, failed: 1, skipped: 0 },
    userById: users,
    ad: {
      _id: 'ad-video-1',
      status: 'rendering',
      renderStage: 'veo poll',
      renderStageAt: new Date(FIXED_NOW - 700 * 1000),   // > 600 → STALLED
      kind: 'video',
      template: 'ai_brand_led',
      platformFormat: 'meta_reels_9_16',
      aspectRatio: '1:1',
      veoAspectRatio: '9:16',                             // → derivedFromMaster
      veoPredictionId: 'pred-abc',
      renderStages: { deriveMs: 120, renderMs: 8400, uploadMs: 300 },
      intentResolution: { requested: 'a', delivered: 'social_proof_led', fellBackFrom: 'objection_resolved', droppedRoles: ['quote', 'rating'] },
      renderError: { message: 'titling failed: font 404' },
      renderUrl: 'https://cdn/x.mp4',
      renderAttempts: 2,
      campaignId: 'camp-1', productId: 'prod-1', mediaId: 'med-1', brandId: 'brand-1', conceptId: 'concept-1',
      campaignRunIds: ['run-1'],
      queuedAt: new Date(FIXED_NOW - 900000), renderedAt: null, updatedAt: new Date(FIXED_NOW)
    }
  },
  {
    name: 'minimal static ad — every optional line filtered out',
    run: null,
    userById: users,
    ad: { _id: 'ad-static-1', status: 'queued', kind: 'image', template: 'ai_editorial', platformFormat: 'meta_feed_1_1', aspectRatio: '1:1' }
  },
  {
    name: 'static ad with imageGeneration pipeline/model + string renderError',
    run: { runId: 'run-2', status: 'done', total: 1, succeeded: 0, failed: 1, skipped: 0 },
    userById: users,
    ad: {
      _id: 'ad-static-2', status: 'failed', kind: 'image',
      template: 'ai_editorial', platformFormat: 'meta_story_9_16', aspectRatio: '9:16',
      imageGeneration: { pipeline: 'direct_image', model: 'openai/gpt-image-2-developer/edit', predictionId: 'pred-img' },
      renderError: 'plain string error',                  // the typeof-string branch
      renderStages: { deriveMs: 0 },
      campaignRunIds: ['run-2']
    }
  },
  {
    name: 'run.requestedBy present but user NOT in the map — falls back to raw id',
    run: { runId: 'run-3', requestedBy: 'u-missing', status: 'running', total: 1, succeeded: 0, failed: 0, skipped: 0 },
    userById: users,
    ad: { _id: 'ad-3', status: 'rendering', kind: 'image', template: 't', platformFormat: 'f', aspectRatio: '4:5' }
  },
  {
    name: 'visionQc present with attempts',
    run: null,
    userById: users,
    ad: {
      _id: 'ad-4', status: 'done', kind: 'image', template: 't', platformFormat: 'f', aspectRatio: '1:1',
      visionQc: { passed: false, finalAttempt: 2, skipped: false, disabled: false,
        attempts: [{ attempt: 1, pass: false, summary: 'competitor mark', discarded: true, renderUrl: null, discardedRenderUrl: 'https://cdn/d.png' }] }
    }
  }
];

console.log('\nverifyRenderDiagnostic — byte-identity vs the frozen pre-extraction builder\n');

for (const f of FIXTURES) {
  withFrozenClock(() => {
    const ref = referenceRow(f.ad, FIXED_NOW, f.run, f.userById);
    const got = rd.buildAdRow(f.ad, { run: f.run, userById: f.userById });
    got.diagnostic = rd.buildAdDiagnostic(got);

    eq(`[${f.name}] diagnostic block byte-identical`, got.diagnostic, ref.diagnostic);

    // The whole row must match too — the route returns it as JSON, so a changed
    // field would be an API regression even if the diagnostic string matched.
    const refJson = JSON.stringify(ref);
    const gotJson = JSON.stringify(got);
    eq(`[${f.name}] full row JSON byte-identical`, gotJson, refJson);
  });
}

// ── lean/partial docs must never throw (crash paths hold only an _id) ────────
const LEAN = [
  ['null ad', null],
  ['empty object', {}],
  ['id only', { _id: 'ad-lean' }],
  ['id + status', { _id: 'ad-lean2', status: 'rendering' }],
  ['renderStageAt garbage', { _id: 'x', renderStageAt: 'not-a-date' }],
  ['visionQc with no attempts array', { _id: 'y', visionQc: { passed: true } }],
  ['intentResolution with no droppedRoles', { _id: 'z', intentResolution: { delivered: 'd' } }]
];

for (const [label, ad] of LEAN) {
  let threw = null;
  let out = null;
  try { out = rd.diagnosticForAd(ad); } catch (e) { threw = e; }
  ok(`lean doc never throws — ${label}`, threw === null, threw && threw.message);
  ok(`lean doc yields a string — ${label}`, typeof out === 'string');
}

// userById omitted entirely — the crash-path signature.
let leanThrew = null;
let leanOut = null;
try {
  leanOut = rd.diagnosticForAd(
    { _id: 'ad-nouser' },
    { run: { runId: 'r9', requestedBy: 'u1' } }   // no userById at all
  );
} catch (e) { leanThrew = e; }
ok('userById omitted never throws', leanThrew === null, leanThrew && leanThrew.message);
ok('userById omitted falls back to the raw id',
  typeof leanOut === 'string' && leanOut.includes('by=u1'),
  `got: ${JSON.stringify(leanOut)}`);

// A partial doc must not fabricate an 'undefined' asset id.
const leanRow = rd.buildAdRow({ status: 'rendering' });
ok('missing _id yields empty assetId, never the string "undefined"',
  leanRow.assetId === '', `got: ${JSON.stringify(leanRow.assetId)}`);

// ── exports contract ────────────────────────────────────────────────────────
for (const fn of ['buildAdRow', 'buildAdDiagnostic', 'diagnosticForAd']) {
  ok(`exports ${fn}`, typeof rd[fn] === 'function');
}

console.log(`\nverifyRenderDiagnostic: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error('  FAILED — the extraction is not behaviour-preserving.\n');
  process.exit(1);
}
console.log('  all checks passed\n');
