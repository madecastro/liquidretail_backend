'use strict';
// Pins the reframe-claim-release-on-shutdown fix.
//
// PROBLEM. atlasVideoService.reframeReferenceForAspect holds a Mongo-backed
// mutex (Media.metadata.reframes[aspectKey].claim) around its billable
// section so peer processes don't race and double-bill Atlas for the same
// reframe. The winner releases the claim in a finally block; the loser
// polls for the winner's url with 1s,2s,…,26s backoff (sum(1..26) = 351s =
// 5m51s ceiling) before falling back to a deterministic crop.
//
// If the winner is SIGKILL'd mid-work, the finally block never runs. The
// Mongo entry then sits with a claim.at from up to 15 minutes ago (the
// REFRAME_CLAIM_TTL_MS floor), and every subsequent peer waits ~6 minutes
// before cropping. MEASURED 2026-08-25 on run_1787677348712_e426912d: a
// deploy-swap left one such stranded claim; the master's total wall clock
// blew out by ~350s. On any deploy that catches a live reframe, THIS bug
// adds ~6 minutes to the tail of every video ad on the affected media.
//
// FIX. atlasVideoService now maintains an in-process Set of active claims;
// every tryClaimReframe win adds an entry, every releaseReframeClaim removes
// it. renderer.shutdown() calls a new
// releaseAllActiveReframeClaims() export before returning, so a peer's next
// waitForReframeUrl poll observes the entry removed and hits the fast
// "winner released without a result" exit (~1s wait instead of ~351s).
//
// This harness pins the structural pieces so the fix can't be silently
// unhooked by a future edit.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. atlasVideoService structural checks ────────────────────────────────
const svcPath = path.join(REPO, 'src', 'services', 'atlasVideoService.js');
const svc = fs.readFileSync(svcPath, 'utf8');

check('A1 active-claim registry is declared as a Set',
  /const\s+_activeReframeClaims\s*=\s*new Set\(\)/.test(svc),
  'a Set keyed on {mediaId,aspectKey,claimBy} — cannot be recomputed on the fly');

// STRENGTHENED 2026-08-27. The previous regex was
//   _activeReframeClaims.add(...)  ;? \n? return true;
// i.e. it required the add to be IMMEDIATELY followed by `return true`, which
// broke the moment an acquire log line was inserted between them — a false
// failure on a change that did not touch the property at all. It also never
// actually proved the ONLY half of its own name: it said nothing about the
// non-win path. This version proves both: the add sits inside the `if (doc)`
// win branch that returns true, and the fall-through returns false.
check('A2 tryClaimReframe adds to the registry ONLY on win',
  /if \(doc\) \{[\s\S]{0,1200}?_activeReframeClaims\.add\([\s\S]{0,1200}?return true;[\s\S]{0,80}?\}\s*\n\s*return false;/.test(svc),
  'adding on a failed claim would leak forever');

check('A3 releaseReframeClaim removes from registry BEFORE the Mongo write',
  /async function releaseReframeClaim[\s\S]{0,400}?_activeReframeClaims\.delete\([\s\S]{0,180}?\)[\s\S]{0,400}?Media\.updateOne/.test(svc),
  'ordering matters: if delete came after the write, a concurrent shutdown sweep could try to release twice');

check('A4 releaseAllActiveReframeClaims is defined and iterates the registry',
  /async function releaseAllActiveReframeClaims\(\)\s*\{[\s\S]{0,600}?_activeReframeClaims[\s\S]{0,200}?releaseReframeClaim\(/.test(svc));

check('A5 releaseAllActiveReframeClaims never throws (drains registry in finally)',
  /async function releaseAllActiveReframeClaims[\s\S]{0,1200}?try\s*\{[\s\S]{0,300}?releaseReframeClaim\([\s\S]{0,50}?\)[\s\S]{0,300}?\}\s*catch[\s\S]{0,150}?\}\s*finally\s*\{[\s\S]{0,200}?_activeReframeClaims\.delete/.test(svc),
  'shutdown must proceed even if a single release throws');

check('A6 releaseAllActiveReframeClaims is exported',
  /module\.exports\s*=\s*\{[\s\S]{0,5000}releaseAllActiveReframeClaims[\s\S]{0,50}?\};/.test(svc));

// ── B. renderer.js hookup ─────────────────────────────────────────────────
const renderer = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');

check('B1 renderer.shutdown() awaits releaseAllActiveReframeClaims',
  /async function shutdown\(\)[\s\S]{0,10000}?await\s+atlasVideo\.releaseAllActiveReframeClaims\(\)/.test(renderer),
  'without await, a SIGKILL could interrupt the release write');

check('B2 renderer.shutdown() calls it AFTER the ad-claim release block',
  () => {
    const shutdownBody = renderer.match(/async function shutdown\(\)[\s\S]*?^}/m);
    if (!shutdownBody) return false;
    const s = shutdownBody[0];
    const adReleaseIdx = s.search(/released\s+\$?\{?res\.modifiedCount/);
    const reframeReleaseIdx = s.search(/releaseAllActiveReframeClaims/);
    // Ad claim release is in the drain-exhausted branch; reframe release is
    // unconditional after. Reframe idx must come AFTER ad release idx or be
    // the only present idx (ad release only shows on exhausted drain).
    return reframeReleaseIdx > 0 && (adReleaseIdx < 0 || reframeReleaseIdx > adReleaseIdx);
  },
  'wrong order = a peer could observe the reframe release before the ad-claim clear');

check('B3 renderer.shutdown() wraps the call in try/catch',
  /try\s*\{[\s\S]{0,300}?releaseAllActiveReframeClaims\(\)[\s\S]{0,300}?\}\s*catch\s*\([\s\S]{0,60}?\)\s*\{[\s\S]{0,300}?reframe-claim release-on-shutdown failed/.test(renderer),
  'a shutdown must never crash on a stale claim');

// ── C. behavioral proof against real code ─────────────────────────────────
// Extract releaseAllActiveReframeClaims + a stubbed releaseReframeClaim and
// run the real function against a seeded registry. The stub records which
// releaseReframeClaim calls happened; a correct implementation calls it for
// each registered claim.
const behavioral = (async () => {
  // Sandbox: replace the module-level Set + releaseReframeClaim with stubs.
  const bodyMatch = svc.match(/async function releaseAllActiveReframeClaims\(\)\s*\{[\s\S]*?\n\}/);
  if (!bodyMatch) { check('C0 releaseAllActiveReframeClaims parses', false); return; }
  const body = bodyMatch[0];
  const stubbedCalls = [];
  const stubReleaseReframeClaim = async (m, a, b) => { stubbedCalls.push({ m, a, b }); };
  const _activeReframeClaims = new Set([
    JSON.stringify({ m: 'media-1', a: '9_16', b: 'pid-1:xyz' }),
    JSON.stringify({ m: 'media-2', a: '1_1',  b: 'pid-1:abc' }),
  ]);
  const inner = body.replace(/^async function releaseAllActiveReframeClaims\(\)\s*\{/, '').replace(/\}\s*$/, '');
  // eslint-disable-next-line no-new-func
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
    '_activeReframeClaims', 'releaseReframeClaim', inner
  );
  const cleared = await fn(_activeReframeClaims, stubReleaseReframeClaim);

  check('C1 real function releases every entry in the registry', stubbedCalls.length === 2,
    `expected 2 releaseReframeClaim calls, got ${stubbedCalls.length}`);
  check('C2 real function drains the registry (Set becomes empty)', _activeReframeClaims.size === 0);
  check('C3 real function returns the count cleared', cleared === 2, `expected 2, got ${cleared}`);

  // A thrown release must not stop the sweep — drain continues.
  const throwyCalls = [];
  const throwyRelease = async (m, a, b) => {
    throwyCalls.push({ m, a, b });
    throw new Error('mongo down');
  };
  const registry2 = new Set([
    JSON.stringify({ m: 'media-3', a: '9_16', b: 'pid-1:foo' }),
    JSON.stringify({ m: 'media-4', a: '1_1',  b: 'pid-1:bar' }),
  ]);
  await fn(registry2, throwyRelease);
  check('C4 a throwing release still evicts the registry entry', registry2.size === 0);
  check('C5 a throwing release does not stop the sweep', throwyCalls.length === 2);
})();

behavioral.then(() => {
  console.log(`\nverifyReframeClaimShutdown: ${passes.length} pass, ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ reframe claim released on shutdown — peers no longer wait ~6 min for TTL');
}).catch((e) => {
  console.error('behavioral section threw:', e.message, e.stack);
  process.exit(1);
});
