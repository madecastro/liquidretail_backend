// verifyStageVisibility — the operator must be able to see WHAT STAGE every ad
// is at, on every surface that shows ads.
//
// THE DEFECT. The backend already writes a rich stage vocabulary through
// services/adStage.js — "queued for titling (3 ahead)", "titling 4:5",
// "vision QC (meta_feed_1_1)". Exactly one page ever showed it
// (/render-activity). The galleries the operator actually works in showed a
// bare `status`, so an ad three-deep in the titling queue and an ad that had
// not started were both the word "Queued".
//
// Three separate omissions, all in the PAYLOAD rather than the UI:
//   1. projectAd serialised renderStage but NOT renderStageAt, so no surface
//      except /render-activity could say how long a stage had been running.
//      "Titling" that never moves is the failure most worth seeing, and it is
//      invisible without the timestamp.
//   2. GET /api/catalog/:id/ads-detail  — projection omitted both fields.
//   3. GET /api/campaigns/:id/ads-detail — same.
// Product Ads and Campaigns render the same tiles as the gallery, so they
// inherited the blindness. (regenerationStage IS projected there, which is a
// DIFFERENT field covering only the regen banner — never first generation.
// That near-miss is why the gap read as intentional.)
//
// THE CROSS-REPO CONTRACT. The SPA maps these strings to human labels by
// PREFIX. The mapping table lives in the other repo, so nothing here would fail
// if someone renamed a stage — the UI would just silently degrade to a generic
// label, which is the exact failure being fixed. Group C pins the prefixes the
// UI keys on, so a rename breaks a test in the same repo as the rename.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyStageVisibility\n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// ── Group A — projectAd actually SERIALISES the fields (called, not regexed).
// A source check would pass against a projectAd that mentioned the field in a
// comment; the gallery can only render what it is sent.
const adsRoute = require('../routes/ads');
const projectAd = adsRoute.projectAd;

ok('A1 projectAd is exported for behavioural pinning', () => {
  assert.strictEqual(typeof projectAd, 'function',
    'routes/ads.js must export projectAd or this suite tests nothing');
});

const STAGE_AT = new Date('2026-08-12T17:53:15.000Z');
const sampleAd = {
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  kind: 'video',
  status: 'draft',
  renderStage: 'queued for titling (3 ahead)',
  renderStageAt: STAGE_AT,
  renderUrl: 'https://res.cloudinary.com/x/video/upload/atlas_renders/omni.mp4',
  aspectRatio: '9:16',
  platformFormat: 'meta_stories_9_16'
};

ok('A2 [THE FIX] projectAd carries renderStageAt', () => {
  const out = projectAd(sampleAd, false);
  assert.ok('renderStageAt' in out,
    'without renderStageAt no gallery can show elapsed — "Titling" that never moves stays invisible');
  assert.strictEqual(new Date(out.renderStageAt).getTime(), STAGE_AT.getTime());
});

ok('A3 projectAd still carries renderStage verbatim (no lossy pre-mapping)', () => {
  const out = projectAd(sampleAd, false);
  assert.strictEqual(out.renderStage, 'queued for titling (3 ahead)',
    'the queue position must survive to the client — it is the most useful number on the page');
});

ok('A4 an ad with no stage yields nulls, never undefined', () => {
  // The SPA types these as `string | null`; undefined would drop out of JSON
  // entirely and read as "field absent" rather than "no stage yet".
  const out = projectAd({ _id: 'b'.repeat(24), kind: 'image', status: 'queued' }, false);
  assert.strictEqual(out.renderStage, null);
  assert.strictEqual(out.renderStageAt, null);
});

ok('A5 the full projection is a superset of the list projection', () => {
  const lite = projectAd(sampleAd, false);
  const full = projectAd(sampleAd, true);
  for (const k of ['renderStage', 'renderStageAt']) {
    assert.ok(k in full, `full projection lost ${k}`);
    assert.strictEqual(String(full[k]), String(lite[k]), `${k} disagrees between projections`);
  }
});

// ── Group B — every ads-detail projection carries the fields.
// DERIVED BY SCANNING, not a hardcoded file list: the lesson from the
// receiptFree incident is that a hardcoded list leaves the next call site
// unguarded. Any route that $projects an ad list must opt in.
// Finds every `$project: { ... }` object body in `src` by walking brace depth
// from each `$project:` marker to its TRUE matching close, instead of a fixed
// character window. A fixed window (formerly {0,1400}) silently stops
// "scanning" a real projection the moment unrelated, legitimate growth pushes
// its body past the guess — exactly the failure mode
// scripts/verifyCostAttribution.js's `captureCallArgs` helper was already
// fixed for elsewhere in this repo; same defect class, same fix shape here.
// Blind to braces inside string literals (property values in a Mongo
// projection are simple `1`/`0`/field-path strings without embedded braces in
// this codebase today), consistent with that same known, documented
// limitation.
function findProjectBodies(src) {
  const bodies = [];
  const marker = /\$project\s*:\s*\{/g;
  for (let m = marker.exec(src); m; m = marker.exec(src)) {
    const openIdx = m.index + m[0].length - 1; // index of the opening '{'
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx !== -1) bodies.push(src.slice(openIdx + 1, closeIdx));
  }
  return bodies;
}

ok('B1 every ads-detail $project includes renderStage and renderStageAt', () => {
  const routesDir = path.join(ROOT, 'routes');
  const offenders = [];
  let scanned = 0;
  // !f.startsWith('.') — same convention as verifyMetaApiVersion.js's fix
  // (real, reproduced revertprove-race in CI: a sibling harness briefly
  // writes a `.__revertprove_*.js` transient into routes/).
  for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js') && !f.startsWith('.'))) {
    const src = stripComments(fs.readFileSync(path.join(routesDir, file), 'utf8'));
    // A $project that names the ad-tile shape. `renderUrl` + `posterUrl`
    // together are the signature of an ad-tile projection specifically — a
    // product or media projection has neither.
    for (const body of findProjectBodies(src)) {
      if (!/renderUrl:\s*1/.test(body) || !/posterUrl:\s*1/.test(body)) continue;
      scanned += 1;
      const missing = ['renderStage', 'renderStageAt']
        .filter(f => !new RegExp(`\\b${f}:\\s*1`).test(body));
      if (missing.length) offenders.push(`${file}: missing ${missing.join(', ')}`);
    }
  }
  assert.ok(scanned >= 2,
    `expected to find at least the catalog + campaigns ad projections, scanned ${scanned}`);
  assert.strictEqual(offenders.length, 0,
    `ad-tile projections that cannot show a stage:\n     ${offenders.join('\n     ')}`);
});

// ── Group C — the stage vocabulary the SPA keys on, pinned HERE.
// The mapping table is in the other repo. Renaming a stage string is a silent
// UI regression unless something in THIS repo fails, so this is the contract.
//
// REMOVED 2026-09-07 (dormant render fallback deletion — see session.d/):
// 'no titling (' (bare-master ship), 'preparing video context', 'deriving
// layout', 'plate submit', 'static image generation', 'uploading static'.
// All six were emitted ONLY from the in-process render loop / renderDirectImage
// (routes/ads.js's renderOneInner and services/directImageRenderService.js's
// renderDirectImage), both deleted along with the rest of the fallback —
// adgen now submits and polls every render, and ported the identical stage
// strings to its own adPhase.js/renderer.js/directImageRenderService.js
// (confirmed: grep for each fragment under adgen/ finds it there). The SPA
// contract these fragments protect is unbroken, just no longer testable from
// THIS repo's source — adgen's own verify suite (e.g.
// adgen/scripts/verifyAdgenRunFeedWired.js) is where a rename of any of them
// would now be caught. Do not re-add any of the six here without re-adding
// the backend code that actually produces it.
const STAGE_CONTRACT = [
  // [literal fragment that must survive, why the UI needs it]
  //
  // 'queued for titling (N ahead)' and 'master rendered; titling failed'
  // REMOVED from this contract 2026-08-28 (backend titling removal, owner
  // directive: "remove and disable the backend titling function"). Both
  // were emitted ONLY by the in-process titling call in routes/ads.js
  // (the queue-depth diagnostic and the titling-failed terminal outcome),
  // which is deleted along with the call — there is no more Remotion
  // titling in-process to queue behind or fail. Confirmed zero remaining
  // occurrences (grep across every file this contract scans; the sole
  // surviving "queued for titling" substring is an unrelated
  // bootRecoveryService.js console.log, not in the scanned list and not an
  // adStage/renderStage write). Do not re-add either fragment without
  // re-adding the code that produced it.
  ['titling ',                  'the active titling label (brandScriptExecutor live titling)'],
  ['face-safe crop',            'distinguishes cropping from titling in the tail'],
  ['uploading titled video',    'the last video step before done'],
  ['master video generation',   'the paid, slow step (atlasVideoService stagePrefix)'],
  ['vision QC',                 'quality gate (brandScriptExecutor live titling)']
];

ok('C1 every stage string the UI maps still exists in the backend', () => {
  // renderService.js / directImageRenderService.js no longer emit stages
  // (finishPlate does not adStage; mint-time static is adgen). Scan the
  // live writers only.
  const sources = ['services/atlasImageService.js', 'services/atlasVideoService.js',
    'services/brandScriptExecutor.js']
    .map(read).join('\n');
  const missing = STAGE_CONTRACT.filter(([frag]) => !sources.includes(frag));
  assert.strictEqual(missing.length, 0,
    'renaming these silently degrades the SPA badge to a generic label:\n     '
    + missing.map(([f, why]) => `"${f}"  (${why})`).join('\n     '));
});

ok('C2 "done" remains an accepted terminal sentinel (no backend writer; UI still keys on it)', () => {
  // The UI treats `renderStage === 'done'` as "not in progress". Backend's
  // in-process render loop no longer stamps it (ZERO adStage(adId, 'done')
  // matches); adgen does. Pin that (1) this backend does not write it,
  // (2) adStage still ACCEPTS any string (no enum that would reject 'done'
  // when adgen's write lands on the shared Ad doc), and (3) projectAd still
  // serialises renderStage verbatim so a 'done' payload reaches the SPA.
  const adsJs = stripComments(read('routes/ads.js'));
  assert.ok(!/adStage\([^,]+,\s*'done'\)/.test(adsJs),
    'routes/ads.js must not regain an in-process adStage(..., \'done\') write — adgen stamps it');
  const stageSrc = stripComments(read('services/adStage.js'));
  assert.ok(/function adStage\s*\(\s*adId,\s*stage\s*\)/.test(stageSrc),
    'adStage signature must still take a free-text stage');
  assert.ok(!/enum|allowlist|ALLOWED_STAGES/.test(stageSrc),
    'adStage must not grow an enum that would reject adgen\'s literal \'done\'');
  const out = projectAd({
    _id: 'c'.repeat(24), kind: 'video', status: 'draft', renderStage: 'done'
  }, false);
  assert.strictEqual(out.renderStage, 'done',
    'projectAd must pass renderStage===\'done\' through verbatim — the SPA keys on it');
});

ok('C3 adStage still writes renderStageAt beside renderStage', () => {
  // Elapsed is derived from this write. If adStage ever stops stamping it, every
  // badge silently loses its clock while still showing a stage.
  const src = stripComments(read('services/adStage.js'));
  const m = src.match(/\$set:\s*\{([^}]*)\}/);
  assert.ok(m, 'could not find adStage\'s $set');
  assert.ok(/renderStage:/.test(m[1]) && /renderStageAt:/.test(m[1]),
    'adStage must write both fields in one $set or they can disagree');
});

ok('C4 the poll suffix keeps its parseable shape', () => {
  // The UI strips ' — polling <elapsed> (<n>)' into a detail line. stageBase
  // already depends on that shape to throttle, so this pins one format for both.
  const src = read('services/adStage.js');
  assert.ok(/polling/.test(src),
    'adStage.stageBase must still recognise the polling suffix');
});

if (process.exitCode) {
  console.log(`\n❌ verifyStageVisibility: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyStageVisibility: ${checks}/${checks} checks passed`);
}
