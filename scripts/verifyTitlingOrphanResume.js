// verifyTitlingOrphanResume — routes/ads.js's own titling-debt bookkeeping
// around the (now-removed) in-process titling call.
//
// REWRITTEN 2026-08-28 (backend titling removal, owner directive: "remove
// and disable the backend titling function, we are not going to go back to
// it"). This file used to be ~300 lines pinning services/titlingResumeService.js's
// buildResumeFilter (Groups A-D: the matcher, the orphan/live/derive-orphan
// selection, everything that must NOT be swept, the two pre-existing filter
// arms) plus routes/ads.js's own stamp/clear/heartbeat bookkeeping (Group E).
// That service is DELETED — it could still race adgen's own titling-resume
// path with no lease between the two processes. Groups A-D tested nothing
// that exists any more and are gone with it.
//
// What survives (renumbered E1-E5, was E1-E6 minus E6): routes/ads.js's OWN
// money-guard bookkeeping around shipping a video master is UNCHANGED by the
// titling removal — the ad still needs to be stamped `draft` +
// `titlingResumeState:'claimed'` BEFORE anything else runs (so a process
// death mid-shipment does not leave an invisible orphan), and the debt still
// needs to be cleared on every terminal outcome. The removal deleted the
// SWEEPER that used to read this field when something went wrong, and
// deleted the "titling failed" terminal outcome (there is no titling to
// fail any more) — E3's expected count drops from 6 to 4 accordingly (2
// paths x {success-clear, kept-verdict-clear}, not x{titled-clear,
// failed-clear} + 2 kept-verdict clears). E5 now anchors on
// `qcAndStampVideoAd`, the call that replaced `renderBrandScriptAndSave` on
// this path.
//
// These are still source-level checks (not filter-object checks, since
// there is no more filter object to test) against the real routes/ads.js —
// not a regex over a comment, since comments are stripped first.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let checks = 0;
const ok = (label, fn) => {
  try { fn(); checks += 1; }
  catch (err) { console.error(`  ❌ ${label}\n     ${err.message}`); process.exitCode = 1; }
};

console.log('verifyTitlingOrphanResume\n');

// ── The render path's own stamp/clear bookkeeping. Source-level, because
// these are literal object keys in a 6000-line route handler with no
// callable seam. Comments are STRIPPED before matching: a check that passes
// because it found its own explanatory prose teaches the next reader to
// ignore it.
const adsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

ok('E1 both pre-shipment stamps declare the titling debt', () => {
  // Located PER SITE rather than counted file-wide. A whole-file count of
  // "claimed" also catches the heartbeat's filter (E4), so it would pass while
  // a stamp was missing — the count would just be satisfied by the wrong line.
  const stampIdxs = [];
  const re = /renderUrl:\s*veoVideoUrl/g;
  for (let m = re.exec(adsSrc); m; m = re.exec(adsSrc)) stampIdxs.push(m.index);
  assert.strictEqual(stampIdxs.length, 2,
    `expected 2 pre-shipment stamps (master + derive-only), found ${stampIdxs.length}`);

  for (const idx of stampIdxs) {
    // Scope to the remainder of this $set object literal — up to its $inc
    // sibling or the update's close, whichever comes first.
    const rest = adsSrc.slice(idx);
    const end = Math.min(
      ...['$inc:', '\n      );', '\n  );'].map(t => {
        const i = rest.indexOf(t);
        return i === -1 ? Infinity : i;
      })
    );
    const block = rest.slice(0, Number.isFinite(end) ? end : 1200);
    assert.ok(/titlingResumeState:\s*'claimed'/.test(block),
      `the pre-shipment stamp at offset ${idx} does not declare the titling debt`);
  }
});

ok('E2 [ANTI-DOUBLE-RENDER] the stamp is claimed, never pending', () => {
  // 'pending' is arm 1 of the (now-deleted) sweeper's filter, which had NO
  // staleness bound. Kept as a guard against reintroducing that literal.
  assert.ok(!/titlingResumeState:\s*'pending'/.test(adsSrc),
    "routes/ads.js must not stamp 'pending' — that arm had no staleness bound");
});

ok('E3 every terminal outcome clears the debt', () => {
  const cleared = adsSrc.match(/titlingResumeState:\s*null/g) || [];
  // 4, not 6: since the titling removal there is no more "titling failed"
  // terminal outcome (there is nothing left to fail) — each of the 2 paths
  // (master, derive-only) now clears the debt on exactly ONE remaining
  // terminal branch (settle-and-succeed) PLUS the "a terminal verdict is
  // already on the row, still settle the debt" kept-verdict arm. That is
  // 2 paths x 2 clears = 4. Deliberately still strictEqual: this pins the
  // exact number of terminal outcomes, so a NEW unguarded one fails here.
  assert.strictEqual(cleared.length, 4,
    `expected 4 terminal clears (2 paths x {settle-and-succeed, kept-verdict}), found ${cleared.length}`);
});

ok('E4 the heartbeat covers a claimed draft, not just rendering', () => {
  // Without this the sweeper cannot distinguish "waiting behind
  // REMOTION_QUEUE_CONCURRENCY" from "process died" — moot for titling now
  // that nothing waits behind it here, but the heartbeat still protects the
  // SAME draft+claimed window against the reaper for other reasons (a slow
  // vision QC call, a slow Cloudinary poster derivation) so this must not
  // silently narrow back to rendering-only.
  const hb = adsSrc.slice(adsSrc.indexOf('const heartbeat = setInterval'));
  const body = hb.slice(0, hb.indexOf('}, 60_000)'));
  assert.ok(/status:\s*'rendering'/.test(body), 'heartbeat lost its rendering arm');
  assert.ok(/status:\s*'draft'/.test(body) && /titlingResumeState:\s*'claimed'/.test(body),
    'heartbeat must also refresh a draft ad that still owes a title');
});

ok('E5 the money guard is intact — draft is still stamped before shipment', () => {
  // Was: draft stamped BEFORE renderBrandScriptAndSave (Remotion titling).
  // That call is deleted; the equivalent anchor now is qcAndStampVideoAd,
  // which is the only thing this path still does before settling the ad.
  const stampIdx = adsSrc.indexOf("status:             'draft'");
  const shipIdx  = adsSrc.indexOf('qcAndStampVideoAd({ ad: adFinal');
  assert.ok(stampIdx > 0 && shipIdx > 0 && stampIdx < shipIdx,
    'draft must still be stamped BEFORE shipping — reverting that reopens the double-bill hole');
});

if (process.exitCode) {
  console.log(`\n❌ verifyTitlingOrphanResume: failures above (${checks} passed)`);
} else {
  console.log(`\n✅ verifyTitlingOrphanResume: ${checks}/${checks} checks passed`);
}
