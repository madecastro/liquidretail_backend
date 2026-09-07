// verifyTitlingOrphanResume — routes/ads.js no longer ships video masters
// in-process, so it no longer keeps titling-debt bookkeeping of its own.
//
// REWRITTEN 2026-08-28 (backend titling removal, owner directive: "remove
// and disable the backend titling function, we are not going to go back to
// it"). This file used to be ~300 lines pinning services/titlingResumeService.js's
// buildResumeFilter (Groups A-D) plus routes/ads.js's stamp/clear/heartbeat
// bookkeeping (Group E). That service is DELETED.
//
// REWRITTEN AGAIN (dormant in-process render-loop deletion): the remaining
// E1/E3/E4/E5 pins targeted renderOneInner — pre-shipment
// `renderUrl: veoVideoUrl` + `titlingResumeState:'claimed'`, terminal
// `titlingResumeState:null` clears, the in-loop Ad heartbeat covering a
// claimed draft, and `qcAndStampVideoAd` as the draft-before-shipment
// anchor. That whole function is gone: `runRenderLoop` now flips
// CampaignRun to 'running' and returns; adgen's renderer stamps the
// paid master `draft` and owns titling-resume. Backend's live titling
// chain (`brandScriptExecutor.renderBrandScriptAndSave`, called from
// `POST /:id/render-script`, `scripts/retitleDriver.js`, and the ads
// debug path) does not mint paid Omni masters and is not this file's
// subject.
//
// What survives: E2, the anti-reintroduction guard that ads.js must not
// stamp `titlingResumeState:'pending'` (that sweeper arm had no staleness
// bound). E1/E3/E4/E5 are now absence pins of the deleted in-process
// shipment bookkeeping.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyTitlingOrphanResume\n');

const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

ok('E1 [ABSENCE] ads.js no longer stamps renderUrl:veoVideoUrl (in-process master shipment is gone)', () => {
  // The two pre-shipment $sets (master + derive-only) lived in renderOneInner.
  // Adgen's renderer now writes the paid master. A new write here would mean
  // backend is shipping video again.
  const stamps = adsSrc.match(/renderUrl:\s*veoVideoUrl/g) || [];
  assert.strictEqual(stamps.length, 0,
    `expected 0 in-process shipment stamps, found ${stamps.length}`);
});

ok('E2 [ANTI-DOUBLE-RENDER] the stamp is claimed, never pending', () => {
  // 'pending' is arm 1 of the (now-deleted) sweeper's filter, which had NO
  // staleness bound. Kept as a guard against reintroducing that literal.
  assert.ok(!/titlingResumeState:\s*'pending'/.test(adsSrc),
    "routes/ads.js must not stamp 'pending' — that arm had no staleness bound");
});

ok('E3 [ABSENCE] ads.js no longer clears titlingResumeState on a terminal in-process outcome', () => {
  // The four terminal clears (2 paths x {settle-and-succeed, kept-verdict})
  // lived in renderOneInner. Clearing from ads.js again would mean backend
  // is settling titling debt it no longer owns.
  const cleared = adsSrc.match(/titlingResumeState:\s*null/g) || [];
  assert.strictEqual(cleared.length, 0,
    `expected 0 in-process titlingResumeState:null clears, found ${cleared.length}`);
});

ok('E4 [ABSENCE] ads.js no longer heartbeats claimed ads from the render loop', () => {
  // The in-loop `setInterval(..., 60_000)` Ad heartbeat lived next to the
  // worker pools. runRenderLoop no longer holds ads, so it must not beat them.
  assert.ok(!/const heartbeat = setInterval/.test(adsSrc),
    'in-process Ad heartbeat setInterval returned — the render loop no longer holds ads');
});

ok('E5 [ABSENCE] qcAndStampVideoAd is gone — ads.js no longer ships a video master in-process', () => {
  // Was: draft stamped BEFORE renderBrandScriptAndSave, then before
  // qcAndStampVideoAd. Both call sites lived in renderOneInner. The money
  // invariant "draft before shipment" now lives in adgen's renderer.
  assert.ok(!/qcAndStampVideoAd\s*\(/.test(adsSrc),
    'qcAndStampVideoAd returned — that was the last in-process video-shipment anchor');
  assert.ok(!/async function renderOneInner\s*\(/.test(adsSrc),
    'renderOneInner returned — backend must not ship video masters in-process');
});

if (process.exitCode) {
  console.log(`\n❌ verifyTitlingOrphanResume: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyTitlingOrphanResume: ${checks}/${checks} checks passed`);
}
