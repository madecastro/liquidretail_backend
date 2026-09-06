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
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (err) { cond = false; detail = detail || err.message; }
  }
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function matchingBrace(src, startIdx) {
  if (src[startIdx] !== '{') return -1;
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  const close = matchingBrace(src, open);
  if (close < 0) return '';
  return src.slice(open, close + 1);
}
function stripJsComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function blockAt(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  if (src[open] !== '{') return '';
  const close = matchingBrace(src, open);
  if (close < 0) return '';
  return src.slice(open, close + 1);
}

// ── A. atlasVideoService structural checks ────────────────────────────────
const svcPath = path.join(REPO, 'src', 'services', 'atlasVideoService.js');
const svc = fs.readFileSync(svcPath, 'utf8');

check('A1 active-claim registry is declared as a Set',
  /const\s+_activeReframeClaims\s*=\s*new Set\(\)/.test(svc),
  'a Set keyed on {mediaId,aspectKey,claimBy} — cannot be recomputed on the fly');

// Brace-match each function (verifyShutdownReleaseReceiptAware.js:103-126)
// and strip comments so a commented-out add/delete cannot satisfy a positive
// check, and a 1200-char window cannot swallow a neighbor helper.
const tryClaimBody = stripJsComments(fnBody(svc, 'async function tryClaimReframe('));
const ifDocBody = blockAt(tryClaimBody, /if \(doc\) \{/);
const tryClaimWithoutWin = ifDocBody ? tryClaimBody.replace(ifDocBody, '') : tryClaimBody;
check('A2 tryClaimReframe adds to the registry ONLY on win',
  /_activeReframeClaims\.add\(/.test(ifDocBody) &&
  /return true;/.test(ifDocBody) &&
  /return false;/.test(tryClaimWithoutWin) &&
  !/_activeReframeClaims\.add\(/.test(tryClaimWithoutWin),
  'adding on a failed claim would leak forever');

const releaseBody = stripJsComments(fnBody(svc, 'async function releaseReframeClaim('));
check('A3 releaseReframeClaim removes from registry BEFORE the Mongo write',
  () => {
    const delIdx = releaseBody.indexOf('_activeReframeClaims.delete');
    const updIdx = releaseBody.indexOf('Media.updateOne');
    return delIdx >= 0 && updIdx >= 0 && delIdx < updIdx;
  },
  'ordering matters: if delete came after the write, a concurrent shutdown sweep could try to release twice');

const sweepBody = stripJsComments(fnBody(svc, 'async function releaseAllActiveReframeClaims('));
check('A4 releaseAllActiveReframeClaims is defined and iterates the registry',
  !!sweepBody && /_activeReframeClaims/.test(sweepBody) && /releaseReframeClaim\(/.test(sweepBody));

const sweepFinally = blockAt(sweepBody, /finally\s*\{/);
check('A5 releaseAllActiveReframeClaims never throws (drains registry in finally)',
  /try\s*\{/.test(sweepBody) && /catch\s*\(/.test(sweepBody) &&
  /_activeReframeClaims\.delete/.test(sweepFinally),
  'shutdown must proceed even if a single release throws');

const exportsDecl = /module\.exports\s*=\s*\{/.exec(svc);
const exportsClose = exportsDecl ? matchingBrace(svc, exportsDecl.index + exportsDecl[0].length - 1) : -1;
const exportsCode = (exportsDecl && exportsClose >= 0)
  ? stripJsComments(svc.slice(exportsDecl.index + exportsDecl[0].length - 1, exportsClose + 1))
  : '';
check('A6 releaseAllActiveReframeClaims is exported',
  /(?:^|[{\n,])\s*releaseAllActiveReframeClaims\s*[,}\s]/.test(exportsCode));

// ── B. renderer.js hookup ─────────────────────────────────────────────────
const renderer = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');
const shutdownBody = fnBody(renderer, 'async function shutdown(');
const shutdownCode = stripJsComments(shutdownBody);

check('B1 renderer.shutdown() awaits releaseAllActiveReframeClaims',
  /await\s+atlasVideo\.releaseAllActiveReframeClaims\(\)/.test(shutdownCode),
  'without await, a SIGKILL could interrupt the release write');

check('B2 renderer.shutdown() calls it AFTER the ad-claim release block',
  () => {
    if (!shutdownBody) return false;
    const adReleaseIdx = shutdownBody.search(/released\s+\$?\{?res\.modifiedCount/);
    const reframeReleaseIdx = shutdownBody.search(/releaseAllActiveReframeClaims/);
    // Ad claim release is in the drain-exhausted branch; reframe release is
    // unconditional after. Reframe idx must come AFTER ad release idx or be
    // the only present idx (ad release only shows on exhausted drain).
    return reframeReleaseIdx > 0 && (adReleaseIdx < 0 || reframeReleaseIdx > adReleaseIdx);
  },
  'wrong order = a peer could observe the reframe release before the ad-claim clear');

// The reframe release is the try whose body contains releaseAllActiveReframeClaims.
// Walk try blocks in shutdown by scanning stripped source.
function tryBlockContaining(src, needle) {
  const re = /try\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open, close + 1);
    if (body.includes(needle)) return { tryBody: body, after: src.slice(close + 1) };
  }
  return null;
}
const reframeTryHit = tryBlockContaining(shutdownCode, 'releaseAllActiveReframeClaims');
const reframeCatch = reframeTryHit ? blockAt(reframeTryHit.after, /^\s*catch\s*\([^)]*\)\s*\{/) : '';
check('B3 renderer.shutdown() wraps the call in try/catch',
  !!(reframeTryHit && /reframe-claim release-on-shutdown failed/.test(reframeCatch)),
  'a shutdown must never crash on a stale claim');

// ── C. behavioral proof against real code ─────────────────────────────────
// Extract releaseAllActiveReframeClaims + a stubbed releaseReframeClaim and
// run the real function against a seeded registry. The stub records which
// releaseReframeClaim calls happened; a correct implementation calls it for
// each registered claim.
const behavioral = (async () => {
  // Sandbox: replace the module-level Set + releaseReframeClaim with stubs.
  const body = fnBody(svc, 'async function releaseAllActiveReframeClaims(');
  if (!body) { check('C0 releaseAllActiveReframeClaims parses', false); return; }
  check('C0 releaseAllActiveReframeClaims parses', true);
  const stubbedCalls = [];
  const stubReleaseReframeClaim = async (m, a, b) => { stubbedCalls.push({ m, a, b }); };
  const _activeReframeClaims = new Set([
    JSON.stringify({ m: 'media-1', a: '9_16', b: 'pid-1:xyz' }),
    JSON.stringify({ m: 'media-2', a: '1_1',  b: 'pid-1:abc' }),
  ]);
  const inner = body.slice(1, -1);
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
