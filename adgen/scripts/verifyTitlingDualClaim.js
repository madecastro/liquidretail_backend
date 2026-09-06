'use strict';
//
// verifyTitlingDualClaim — pins the SINGLE-OWNER invariant on a resumable
// titling failure (2026-08-26).
//
// THE DEFECT. `brandScriptExecutor.stampTitlingFailureAndThrow`'s resumable
// branch wrote, in one $set: status:'draft', titlingResumeState:'pending',
// claimedByWorker:null — and left `titlingNeeded` alone. On any row that came
// through the renderer's titler handoff (`renderer.js`'s handoffMode $set
// stamps titlingNeeded:true + veoVideoUrl + renderUrl and releases the claim)
// `titlingNeeded` is TRUE, so the resting state satisfied BOTH claim filters
// at once:
//
//   titler.claimOne()               keys on titlingNeeded:true
//                                     + claimedByWorker:null
//                                     + status:{$in:['rendering','draft']}
//                                     + veoVideoUrl:{$ne:null}
//   titlingResumeService (arm 1)    keys on titlingResumeState:'pending'
//                                     + status:'draft'
//
// Neither claimant's claim write touches the other's arbitrating field —
// claimOne sets only claimedByWorker/claimedAt, the resume CAS sets only
// titlingResumeState — so BOTH could win and run Remotion on the SAME
// already-paid Omni master: two ~1.97 GiB render slots, two Cloudinary
// uploads, and a last-writer-wins race on the delivered renderUrl. In
// production both claimants are live in DIFFERENT processes (the titler
// service polls every ADGEN_POLL_MS; titlingResumeService sweeps from the
// renderer process every 5 min), so this is not a single-process
// impossibility.
//
// `titler.js`'s catch DID try to clear titlingNeeded afterwards, but its
// filter is `{_id, claimedByWorker: WORKER_ID}` — the field the stamp nulls in
// the same $set — so it could never match. The fix moves the clear INTO the
// stamp's $set, where it is atomic with the claim release.
//
// WHY EXECUTION, NOT SOURCE TEXT. A text harness passes against a
// reimplementation that merely keeps the right words. Sections A and B run the
// REAL exported `stampTitlingFailureAndThrow`, the REAL exported
// `titlingResumeService.buildResumeFilter`, and the REAL `titler.claimOne`
// (executed against a stub collection so the recorded filter is the one the
// service actually sends), with Mongo modelled by scripts/lib/miniMongoStub.js.
// No DB, no network, no Chrome/ffmpeg. Section C is deliberately narrow and
// structural, and says so at its own site. Section D is a whole-file scan
// because "EVERY writer of this state also writes that one" is a claim about
// all writers, which execution of one path cannot make.
//
// WHAT THE MUTATIONS BELOW ACTUALLY PROVE — stated so nobody reads "12
// mutations" as "all 34 checks are load-bearing". The 12 turn 18 distinct ids
// red: A1, A2, A6, B1, B2, B3, B4, B5, C2, C5, D1, D2, D3, E1, E3, E4, E5.
// The rest are not claims about this fix and no mutation targets them:
//   A3/A4/A5  — regression guards on the stamp's OTHER invariants (claim
//               released, status draft, paid master untouched), which this
//               change does not touch.
//   B0/C0     — no-vacuum guards (the filter was captured; the branch was
//               found). They exist to fail when a refactor makes the checks
//               around them meaningless.
//   C1/C3/C4  — forward-looking agreement invariants on titler.js's write.
//               C2 is the one a mutation exercises; C3/C4 guard values the
//               current code does not write at all.
//
// REVERT-PROVE RECIPE (run by hand, not by this script — see the PR):
//   M1 drop `titlingNeeded: false` from the resumable $set
//      (brandScriptExecutor.js)  → RED on A2, A6, B2, B3, D1
//      ^ THIS IS THE ORIGINAL DEFECT — M1 reproducing it behaviourally is the
//        evidence the bug was real rather than argued.
//   M2 drop `titlingNeeded: false` from the terminal $set   → RED on B5
//   M3 revert titler.js's follow-up write to set titlingNeeded:true
//                                                          → RED on C2
//   M4 move `titlingNeeded:false` out of the stamp's $set into a SECOND
//      updateOne right after it (end state correct, atomicity gone)
//                                                          → RED on A6, D1
//   M5 drop `titlingNeeded: true` from titler.claimOne's filter
//                                                          → RED on B2, B3
//      (the loosened filter now matches the post-stamp row, so the dual claim
//       is back — caught from the CLAIMANT side rather than the stamp side)
//   M6 make the resumable stamp write titlingResumeState:null instead of
//      'pending'                                  → RED on A1, A6, B1, B3
//   M7 add `titlingNeeded: true` to titlingResumeService's claim $set
//                                                          → RED on D2, D3
//   M8 give claimOne's filter an UNSATISFIABLE term (a status value no
//      document has)                                       → RED on B4 ONLY
//      ^ B4 is the positive control, and M8 is what proves it load-bearing:
//        under M8 both B2 and B3 still pass — VACUOUSLY, because the filter
//        can no longer match anything at all. B4 is the only check that can
//        tell "the state changed" apart from "the filter broke".
//   M9  remove the follow-up write's try/catch wrapper    → RED on C5
//   M10 make the stamp clear titlingNeeded inside a NESTED object rather than
//       the $set itself                          → RED on A2, A6, D1
//       ^ pins sameLevelOnly(). No other mutation exercises the nesting hole,
//         because M1/M4 both delete the same-level key outright.
//   M11 remove PR #75's titler-handoff exclusion from the REAL exported
//       buildRecoverySweepFilter — i.e. simulate this branch being rebased
//       onto anything predating c02c7ff        → RED on E3, E4
//       ^ THE MERGE-ORDER GUARD. Without #75, boot recovery plants
//         draft+pending on a stamp-failed handoff row and the dual claim
//         reopens through bootRecoveryService instead of through the stamp.
//         This is the one mutation that catches a regression introduced by
//         REBASING rather than by editing any file this PR touches.
//   M12 drop `titlingNeeded: false` from bootRecoveryService's pending $set
//                                                          → RED on D1

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { MiniCollection, matches } = require('./lib/miniMongoStub');

const REPO = path.resolve(__dirname, '..');

// Same placeholder-env pattern verifyTitlerClaimReclaim.js /
// verifyTitlerBackpressure.js use — titler.js requires ../config, which
// hard-exits without these in a bare worktree/CI checkout.
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'titler';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adgen_verify_placeholder';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'verify-placeholder';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'verify-placeholder';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'verify-placeholder';
// claimOne() returns null BEFORE building a filter unless this gate is open —
// which would make B2 pass vacuously. B0 asserts the filter was actually
// recorded so a future gate change cannot silently re-vacuum it.
process.env.ADGEN_RENDERER_ENABLED = 'true';
process.env.ADGEN_TITLER_ENABLED = 'true';

const failures = [];
const passes = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('returned false');
    passes.push(name);
  } catch (err) {
    failures.push(`${name} — ${err && err.message ? err.message : err}`);
  }
}
const adModelPath   = require.resolve(path.join(REPO, 'src/models/Ad.js'));
const bsePath       = require.resolve(path.join(REPO, 'src/services/brandScriptExecutor.js'));
const titlerPath    = require.resolve(path.join(REPO, 'src/services/titler.js'));
const resumeSvcPath = require.resolve(path.join(REPO, 'src/services/titlingResumeService.js'));

function stubAd(col) {
  require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
}

// The EXACT shape the renderer's titler handoff leaves behind. Every field
// here is load-bearing: `renderUrl` non-null keeps buildResumeFilter's arm 3
// (the migration arm, `{veoVideoUrl:{$ne:null}, renderUrl:null}`) OUT of play,
// so a B1 pass can only come from arm 1 — otherwise B1 would go green for the
// wrong reason.
function handoffDoc(over = {}) {
  return {
    _id: 'ad-handoff',
    kind: 'video',
    status: 'rendering',
    veoVideoUrl: 'https://res.cloudinary.com/x/video/upload/master.mp4',
    renderUrl: 'https://res.cloudinary.com/x/video/upload/master.mp4',
    // The Omni spend receipt a real handoff row carries. Load-bearing for E3:
    // bootRecoveryService's sweep is `status:'rendering' + HAS_RECEIPT`, so a
    // receipt-free fixture would make that check pass for the wrong reason.
    // No filter in A/B/C/D reads it.
    veoPredictionId: 'pred_abc',
    imageGeneration: null,
    titlingNeeded: true,
    titlingResumeState: null,
    claimedByWorker: null,
    claimedAt: null,
    titlingAttempts: 0,
    updatedAt: new Date(),
    ...over
  };
}

function oomErr() {
  const e = new Error('remotion child OOM-killed');
  e.oomKilled = true;
  e.code = 'REMOTION_CHILD_OOM';
  return e;
}

// ── A. resting state after a RESUMABLE stamp (execution) ────────────────────
let postStamp = null;

async function sectionA() {
  console.log('\n── A: resting state after a resumable titling failure (execution, real stamp) ──');

  const originalAd  = require.cache[adModelPath];
  const originalBse = require.cache[bsePath];
  let col;
  try {
    col = new MiniCollection([handoffDoc()]);
    stubAd(col);
    delete require.cache[bsePath];
    const bse = require(bsePath);

    const err = oomErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad-handoff' }, err));
    assert.strictEqual(err.titlingResumable, true, 'fixture must exercise the RESUMABLE branch');
    postStamp = { ...col.docs[0] };

    check('A1 titlingResumeState === \'pending\' (titlingResumeService owns the row)',
      () => assert.strictEqual(postStamp.titlingResumeState, 'pending'));

    check('A2 [THE FIX] titlingNeeded === false (titler.claimOne no longer owns it)',
      () => assert.strictEqual(postStamp.titlingNeeded, false));

    check('A3 claim released (claimedByWorker AND claimedAt both null)', () => {
      assert.strictEqual(postStamp.claimedByWorker, null);
      assert.strictEqual(postStamp.claimedAt, null);
    });

    check('A4 status === \'draft\' (buildResumeFilter\'s top-level requirement)',
      () => assert.strictEqual(postStamp.status, 'draft'));

    check('A5 the PAID MASTER is untouched — veoVideoUrl and renderUrl unchanged', () => {
      const before = handoffDoc();
      assert.strictEqual(postStamp.veoVideoUrl, before.veoVideoUrl);
      assert.strictEqual(postStamp.renderUrl, before.renderUrl);
    });

    // ATOMICITY, not just end state. A second write that fixes titlingNeeded
    // afterwards leaves a window in which both claimants match — which is the
    // whole defect. So the clear has to be in the SAME $set as the release.
    check('A6 [ATOMICITY] exactly ONE updateOne carries the handover, and it sets titlingResumeState:\'pending\' AND titlingNeeded:false AND claimedByWorker:null together', () => {
      const writes = col.calls.filter((c) => c.op === 'updateOne' && c.update && c.update.$set);
      const handovers = writes.filter((c) => c.update.$set.titlingResumeState === 'pending');
      assert.strictEqual(handovers.length, 1,
        `expected exactly 1 handover $set, saw ${handovers.length} (a split write reopens the dual-claim window)`);
      const set = handovers[0].update.$set;
      assert.strictEqual(set.titlingNeeded, false, 'titlingNeeded:false must be in the SAME $set');
      assert.strictEqual(set.claimedByWorker, null, 'claim release must be in the SAME $set');
      // And no write may touch titlingNeeded on its own.
      const loners = writes.filter((c) => 'titlingNeeded' in c.update.$set
        && c.update.$set.titlingResumeState === undefined);
      assert.strictEqual(loners.length, 0,
        `${loners.length} write(s) set titlingNeeded outside the handover $set`);
    });
  } finally {
    if (originalAd) require.cache[adModelPath] = originalAd; else delete require.cache[adModelPath];
    if (originalBse) require.cache[bsePath] = originalBse; else delete require.cache[bsePath];
  }
}

// ── B. THE INVARIANT: exactly one claimant matches (execution, real filters) ─
async function sectionB() {
  console.log('\n── B: exactly ONE claimant can select the row (execution, both REAL filters) ──');

  // The REAL titler.claimOne filter, read off the audit trail rather than
  // retyped. Empty collection → nothing is claimed; we only want the filter.
  const originalAd = require.cache[adModelPath];
  const originalTitler = require.cache[titlerPath];
  let claimFilter = null;
  try {
    const emptyCol = new MiniCollection([]);
    stubAd(emptyCol);
    delete require.cache[titlerPath];
    const titler = require(titlerPath);
    assert.strictEqual(typeof titler.claimOne, 'function', 'titler must export claimOne');
    await titler.claimOne();
    const call = emptyCol.calls.find((c) => c.op === 'findOneAndUpdate');
    claimFilter = call ? call.filter : null;
  } finally {
    if (originalAd) require.cache[adModelPath] = originalAd; else delete require.cache[adModelPath];
    if (originalTitler) require.cache[titlerPath] = originalTitler; else delete require.cache[titlerPath];
  }

  // NO-VACUUM GUARD. If claimOne's gate short-circuits (or a future refactor
  // stops issuing the query), claimFilter is null and every "does not match"
  // check below would pass for a reason that has nothing to do with the fix.
  check('B0 [no-vacuum] titler.claimOne actually issued a findOneAndUpdate — its real filter was captured', () => {
    assert.ok(claimFilter && typeof claimFilter === 'object',
      'claimOne never queried — the ADGEN_RENDERER_ENABLED gate closed, so B2/B4 would be vacuous');
    assert.ok(Object.keys(claimFilter).length > 0, 'captured filter is empty');
  });

  const resumeSvc = require(resumeSvcPath);
  const staleCutoff = new Date(Date.now() - resumeSvc.CLAIM_STALE_MIN * 60 * 1000);
  const resumeFilter = resumeSvc.buildResumeFilter(staleCutoff);

  check('B1 the REAL resume filter DOES match the post-stamp row (the intended single owner — the fix must not orphan the ad)', () => {
    assert.ok(postStamp, 'section A did not produce a post-stamp document');
    assert.strictEqual(matches(postStamp, resumeFilter), true);
    // and specifically via arm 1, not the migration arm
    assert.strictEqual(matches(postStamp, { status: 'draft', titlingResumeState: 'pending' }), true,
      'matched, but not through the pending arm');
  });

  check('B2 [THE FIX] the REAL titler.claimOne filter does NOT match the post-stamp row', () => {
    assert.strictEqual(matches(postStamp, claimFilter), false,
      'titler.claimOne can still claim a row titlingResumeService already owns — DUAL CLAIM');
  });

  check('B3 [SINGLE OWNER] exactly one of the two real filters matches — not zero, not two', () => {
    const n = [matches(postStamp, resumeFilter), matches(postStamp, claimFilter)].filter(Boolean).length;
    assert.strictEqual(n, 1, `${n} claimants match the post-stamp row (must be exactly 1)`);
  });

  check('B4 [POSITIVE CONTROL] the same claimOne filter DOES match the PRE-stamp handoff row', () => {
    // Without this, B2 could pass because the filter is broken/empty rather
    // than because the stamp changed the state.
    assert.strictEqual(matches(handoffDoc(), claimFilter), true,
      'claimOne cannot match a live handoff row at all — B2 is vacuous');
  });

  // ── terminal (cap-exceeded) branch: a dead row is owned by NOBODY ──
  const originalAd2 = require.cache[adModelPath];
  const originalBse2 = require.cache[bsePath];
  const originalMax = process.env.TITLING_ATTEMPTS_MAX;
  let postTerminal = null;
  try {
    // titlingAttemptsMax() reads the env at CALL time (not cached), so this
    // makes the very first failure terminal.
    process.env.TITLING_ATTEMPTS_MAX = '1';
    const col = new MiniCollection([handoffDoc({ _id: 'ad-terminal' })]);
    stubAd(col);
    delete require.cache[bsePath];
    const bse = require(bsePath);
    const err = oomErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad-terminal' }, err));
    assert.strictEqual(err.titlingResumable, false, 'fixture must exercise the TERMINAL branch');
    postTerminal = { ...col.docs[0] };
  } finally {
    if (originalMax === undefined) delete process.env.TITLING_ATTEMPTS_MAX;
    else process.env.TITLING_ATTEMPTS_MAX = originalMax;
    if (originalAd2) require.cache[adModelPath] = originalAd2; else delete require.cache[adModelPath];
    if (originalBse2) require.cache[bsePath] = originalBse2; else delete require.cache[bsePath];
  }

  check('B5 after a TERMINAL stamp the row is owned by NOBODY (status failed, both ownership signals cleared, neither real filter matches)', () => {
    assert.strictEqual(postTerminal.status, 'failed');
    assert.strictEqual(postTerminal.titlingResumeState, null);
    assert.strictEqual(postTerminal.titlingNeeded, false, 'terminal stamp must clear titlingNeeded too');
    assert.strictEqual(matches(postTerminal, resumeFilter), false, 'titlingResumeService would resurrect a dead row');
    assert.strictEqual(matches(postTerminal, claimFilter), false, 'titler.claimOne would resurrect a dead row');
  });
}

// ── C. titler.js's follow-up write cannot DISAGREE with the stamp ───────────
//
// STRUCTURAL, DELIBERATELY, AND NARROW. The write lives inside titleAd()'s
// catch, which is not reachable without standing up a Brand, a Media, a
// heartbeat and a real renderBrandScriptAndSave — i.e. rewriting titler.js to
// be testable, a bigger blast radius than this fix warrants. What actually
// needs proving is only that the write's VALUES agree with the stamp's; the
// "it cannot match a stamped row" half is already proven by EXECUTION in A3
// (the stamp leaves claimedByWorker null) combined with C1 (the filter demands
// a non-null WORKER_ID). The scan window is brace-matched, never a magic
// character count that drifts stale as the file grows.
function braceBlockAfter(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

function sectionC() {
  console.log('\n── C: titler.js\'s follow-up write agrees with the stamp (structural, brace-bounded) ──');
  const src = fs.readFileSync(titlerPath, 'utf8');
  const anchor = src.indexOf('scriptErr.titlingResumable');
  const block = anchor === -1 ? null : braceBlockAfter(src, anchor);

  check('C0 the resumable branch was located and brace-bounded', () => {
    assert.ok(block, 'could not find/bound the `scriptErr.titlingResumable` block in titler.js');
  });
  if (!block) return;

  // Strip line comments so the prose above the write (which quotes the old
  // buggy shape verbatim) cannot satisfy or break these checks.
  const code = block.replace(/^\s*\/\/.*$/gm, '');

  check('C1 the write stays owner-scoped on claimedByWorker: WORKER_ID (which is what makes it unable to match a successfully-stamped row — see A3)',
    () => assert.ok(/claimedByWorker:\s*WORKER_ID/.test(code), 'filter is no longer owner-scoped'));

  check('C2 [AGREEMENT] it clears titlingNeeded — never sets it back to true', () => {
    assert.ok(/titlingNeeded:\s*false/.test(code), 'does not clear titlingNeeded');
    assert.ok(!/titlingNeeded:\s*true/.test(code), 'sets titlingNeeded:true — contradicts the stamp');
  });

  check('C3 [AGREEMENT] if it mentions titlingResumeState at all, the value is \'pending\' — the same value the stamp writes', () => {
    const m = code.match(/titlingResumeState:\s*([^,\n}]+)/g) || [];
    for (const hit of m) {
      assert.ok(/'pending'|STATE_PENDING/.test(hit),
        `follow-up write sets ${hit.trim()} — the stamp writes 'pending'; they must not disagree`);
    }
  });

  // A SAFETY NET MUST NOT BE ABLE TO FAIL THE THING IT PROTECTS. The stamp's
  // own updateOne is warn-only; this write was not, and that asymmetry meant a
  // Mongo blip on the net escaped the inner catch, became titleAd's throw, and
  // processAd's catch stamped status:'failed' + bumpRunCounter('failed') — an
  // already-paid, genuinely resumable master written off by a transient error
  // in its own recovery path.
  check('C5 the follow-up write is wrapped in a warn-only try/catch, like the stamp it backs up', () => {
    assert.ok(/try\s*\{[\s\S]{0,600}?Ad\.updateOne\([\s\S]{0,400}?\}\s*catch/.test(code),
      'the follow-up Ad.updateOne is not inside a try/catch — a Mongo blip on the net terminally fails a resumable paid master');
  });

  check('C4 [AGREEMENT] if it mentions status at all, the value is \'draft\' — the same value the stamp writes', () => {
    const m = code.match(/status:\s*'([a-z]+)'/g) || [];
    for (const hit of m) {
      assert.ok(/'draft'/.test(hit),
        `follow-up write sets ${hit.trim()} — the stamp writes 'draft'; they must not disagree`);
    }
  });
}

// ── D. the general invariant across ALL writers in this PR's scope ──────────
//
// A claim about EVERY writer of a state cannot be made by executing one path,
// so this one parses. Object literals are sliced at a brace-matched boundary.
//
// SCOPE — `bootRecoveryService.js` is INCLUDED, as of PR #75 (commit c02c7ff)
// landing on master and becoming an ancestor of this branch. It writes
// titlingResumeState:STATE_PENDING and was, before #75, a THIRD independent
// route to the dual-claim state because it cleared neither ownership signal;
// #75's pending $set now clears titlingNeeded in the same write, so the
// invariant holds there too and this check guards it from regressing.
//
// With all three files covered, `titlingNeeded:true` and a non-null
// `titlingResumeState` are mutually exclusive repo-wide — which is what makes
// titlingResumeService's own two release-backs to 'pending' (~:311, ~:379)
// safe, since any row entering resume already has titlingNeeded:false.
const OWNED_FILES = ['brandScriptExecutor.js', 'titler.js', 'bootRecoveryService.js'];

function objectLiteralsWriting(src, keyValueRe) {
  // Return brace-bounded object-literal slices that contain a match.
  const out = [];
  const re = new RegExp(keyValueRe.source, 'g');
  let m;
  while ((m = re.exec(src))) {
    // Walk backwards to the enclosing '{'.
    let depth = 0;
    let i = m.index;
    for (; i >= 0; i--) {
      if (src[i] === '}') depth++;
      else if (src[i] === '{') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (i < 0) continue;
    const block = braceBlockAfter(src, i - 1 >= 0 ? i - 1 : 0);
    if (!block) continue;
    const cleaned = block.replace(/^\s*\/\/.*$/gm, '');
    // DESYNC GUARD. The walk above scans BACKWARDS for the enclosing '{' by
    // counting braces, which a '{' inside a string or a template literal's
    // ${…} could in principle throw off. If it desyncs, the returned slice
    // would not even contain the text we matched on — and every assertion
    // made against that slice would be meaningless but GREEN. Requiring the
    // slice to contain its own match turns that into a loud failure.
    if (!cleaned.includes(m[0])) {
      throw new Error(
        `objectLiteralsWriting: brace walk desynced — the extracted object literal does not contain its own match (${m[0].trim()}). Slice starts: ${cleaned.slice(0, 80)}`
      );
    }
    out.push(cleaned);
  }
  return out;
}

// Strip NESTED object literals so a key can only satisfy a check at the SAME
// level as the one that matched. Without this, D1 tested a substring of the
// whole enclosing literal, so
//   { titlingResumeState: 'pending', nested: { titlingNeeded: false } }
// kept it green while the actual $set never cleared the field. Found by the
// adversarial pass, not by a mutation — M1/M4 both happen to delete the
// same-level key, so no mutation exercised the nesting hole.
function sameLevelOnly(block) {
  const open = block.indexOf('{');
  if (open === -1) return block;
  let out = '';
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    const ch = block[i];
    if (ch === '{') { depth++; if (depth === 1) continue; }
    else if (ch === '}') { depth--; if (depth === 0) break; }
    if (depth === 1) out += ch;
  }
  return out;
}

function sectionD() {
  console.log('\n── D: general invariant — \'pending\' implies not-needed, in this PR\'s files ──');

  // Per-file: any pending-writer present must clear titlingNeeded. The
  // no-vacuum guard is GLOBAL, not per-file — titler.js legitimately has zero
  // pending-writers (its follow-up write is the stamp-failed net and writes
  // only the fields the stamp writes for the same keys), so requiring one per
  // file would assert a shape the fix deliberately does not have.
  let totalPendingWriters = 0;
  for (const file of OWNED_FILES) {
    const p = path.join(REPO, 'src/services', file);
    const src = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const blocks = objectLiteralsWriting(src, /titlingResumeState:\s*(?:'pending'|STATE_PENDING)/);
    totalPendingWriters += blocks.length;
    check(`D1 [${file}] every $set writing titlingResumeState:'pending' also writes titlingNeeded:false AT THE SAME LEVEL (found ${blocks.length} writer(s))`, () => {
      blocks.forEach((b, i) => {
        assert.ok(/titlingNeeded:\s*false/.test(sameLevelOnly(b)),
          `pending-writer #${i + 1} in ${file} does not clear titlingNeeded at the same level — dual-claim state is reachable again`);
      });
    });
  }

  check(`D1z [no-vacuum] the pending-writer scan found at least one writer across ${OWNED_FILES.join(' + ')} (saw ${totalPendingWriters})`, () => {
    // Without this, a refactor that renames the field or reshapes the literal
    // makes every D1 check above pass over an empty set.
    assert.ok(totalPendingWriters > 0,
      'no titlingResumeState:\'pending\' writer found in this PR\'s files — the D1 scan has gone stale');
  });

  // The mirror image: nothing may pair titlingNeeded:true WITH a pending
  // resume state. renderer.js's handoffMode $set is the one legitimate
  // titlingNeeded:true writer and it correctly pairs with
  // titlingResumeState:null.
  for (const file of ['renderer.js', 'titler.js', 'brandScriptExecutor.js', 'titlingResumeService.js']) {
    const p = path.join(REPO, 'src/services', file);
    const src = fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const blocks = objectLiteralsWriting(src, /titlingNeeded:\s*true/);
    // "object literal", not "$set": the scan deliberately also picks up
    // claimOne's / reclaimStaleTitlerClaims' FILTERS, which mention
    // titlingNeeded:true too. Pairing a resume state with titlingNeeded:true
    // is wrong in a filter as well as in a write, so the wider net is
    // intentional — but the label must not claim it is $set-only.
    check(`D2 [${file}] no object literal pairs titlingNeeded:true with a 'pending'/'claimed' resume state (found ${blocks.length} literal(s))`, () => {
      blocks.forEach((b, i) => {
        assert.ok(!/titlingResumeState:\s*(?:'pending'|'claimed'|STATE_PENDING|STATE_CLAIMED)/.test(b),
          `writer #${i + 1} in ${file} stamps titlingNeeded:true alongside a resume state — both claimants would match`);
      });
    });
  }

  // Same rule from titlingResumeService's side: its CLAIM $set must not
  // reintroduce titlingNeeded.
  check('D3 titlingResumeService\'s claim $set never writes titlingNeeded (it must not hand the row back to titler.claimOne)', () => {
    const src = fs.readFileSync(resumeSvcPath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const claimSet = src.match(/const claimSet\s*=\s*\{[\s\S]*?\n\s*\};/);
    assert.ok(claimSet, 'could not locate claimSet in titlingResumeService.js');
    assert.ok(!/titlingNeeded/.test(claimSet[0]),
      'claimSet writes titlingNeeded — recreates the dual-claim state from the other side');
  });
}

// ── E. the STAMP-FAILED net, executed (not just described) ──────────────────
//
// Added after an adversarial pass observed that A–D pin only the stamp-SUCCESS
// path, while the call-site comment makes claims about the stamp-FAILED path
// that nothing executed. One of those claims — that reclaimStaleTitlerClaims
// backstops it — was WRONG, and no check would have caught it. E drives the
// real stamp with its write forced to throw, then evaluates the resulting
// document against the REAL filters.
//
// HAS_RECEIPT carries this repo's one dotted path
// ('imageGeneration.predictionId'), and miniMongoStub's matches() resolves keys
// FLAT — so boot recovery's filter is evaluated with a local nested resolver
// instead. Using matches() here would silently mis-evaluate it, which is the
// exact defect class PR #80 guarded the other harnesses against.
function nestedMatches(doc, filter) {
  const getPath = (d, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((s) => nestedMatches(doc, s));
    if (k === '$and') return cond.every((s) => nestedMatches(doc, s));
    const v = getPath(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, a]) => {
        switch (op) {
          case '$ne': return v !== a;
          case '$lt': return v != null && v < a;
          case '$in': return a.includes(v === undefined ? null : v);
          case '$nin': return !a.includes(v === undefined ? null : v);
          case '$exists': return a ? v !== undefined : v === undefined;
          default: throw new Error(`nestedMatches: unsupported operator ${op}`);
        }
      });
    }
    return v === cond;
  });
}

async function sectionE() {
  console.log('\n── E: the stamp-FAILED net, executed against the real filters ──');

  const WORKER = 'titler-w1';
  const originalAd = require.cache[adModelPath];
  const originalBse = require.cache[bsePath];
  let stampFailed = null;
  let col;
  try {
    // A live titler-claimed row, mid-titling.
    col = new MiniCollection([handoffDoc({
      _id: 'ad-stampfail', claimedByWorker: WORKER, claimedAt: new Date()
    })]);
    // Force the stamp's own $set to throw, exactly as a Mongo blip would. The
    // $inc read-back (findOneAndUpdate) is left working so the resumable/
    // terminal decision is still the real one.
    const realUpdateOne = col.updateOne.bind(col);
    let blocked = 0;
    col.updateOne = (f, u) => {
      if (u && u.$set && 'titlingResumeState' in u.$set) { blocked++; return Promise.reject(new Error('simulated mongo blip')); }
      return realUpdateOne(f, u);
    };
    stubAd(col);
    delete require.cache[bsePath];
    const bse = require(bsePath);
    const err = oomErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad-stampfail' }, err));
    check('E0 [no-vacuum] the stamp\'s own $set was actually reached and forced to fail, and the failure was RESUMABLE', () => {
      assert.ok(blocked > 0, 'the stamp never attempted its $set — E is testing nothing');
      assert.strictEqual(err.titlingResumable, true);
    });
    col.updateOne = realUpdateOne;
    stampFailed = { ...col.docs[0] };
  } finally {
    if (originalAd) require.cache[adModelPath] = originalAd; else delete require.cache[adModelPath];
    if (originalBse) require.cache[bsePath] = originalBse; else delete require.cache[bsePath];
  }

  check('E1 a lost stamp write leaves the row CLAIMED with titlingNeeded:true and no resume debt (the shape the follow-up net exists for)', () => {
    assert.strictEqual(stampFailed.claimedByWorker, WORKER, 'claim should still be held');
    assert.strictEqual(stampFailed.titlingNeeded, true);
    assert.strictEqual(stampFailed.titlingResumeState, null);
    assert.strictEqual(stampFailed.status, 'rendering');
  });

  // Real filters.
  const resumeSvc = require(resumeSvcPath);
  const { HAS_RECEIPT } = require(require.resolve(path.join(REPO, 'src/services/spendReceipt')));
  const resumeFilter = resumeSvc.buildResumeFilter(new Date(Date.now() - resumeSvc.CLAIM_STALE_MIN * 60 * 1000));

  // Capture the two real titler filters by executing them.
  let claimFilter = null, reclaimFilter = null, reclaimUpdate = null;
  const oAd = require.cache[adModelPath], oT = require.cache[titlerPath];
  try {
    const c = new MiniCollection([]);
    stubAd(c);
    delete require.cache[titlerPath];
    const titler = require(titlerPath);
    await titler.claimOne();
    await titler.reclaimStaleTitlerClaims();
    claimFilter = (c.calls.find((x) => x.op === 'findOneAndUpdate') || {}).filter || null;
    const rm = c.calls.find((x) => x.op === 'updateMany') || {};
    reclaimFilter = rm.filter || null;
    reclaimUpdate = rm.update || null;
  } finally {
    if (oAd) require.cache[adModelPath] = oAd; else delete require.cache[adModelPath];
    if (oT) require.cache[titlerPath] = oT; else delete require.cache[titlerPath];
  }

  check('E2 [no-vacuum] both real titler filters were captured', () => {
    assert.ok(claimFilter && Object.keys(claimFilter).length, 'claimOne filter not captured');
    assert.ok(reclaimFilter && Object.keys(reclaimFilter).length, 'reclaim filter not captured');
  });

  // THE REAL exported boot-recovery sweep predicate (PR #75) — NOT a filter
  // composed here. An earlier version of E3 hand-built
  // `{status:'rendering', updatedAt:{$lt}, ...HAS_RECEIPT}`, which was the
  // pre-#75 shape, and it therefore "proved" a mechanism that #75 had already
  // closed. That is precisely the trap this whole harness exists to avoid:
  // a retyped filter tests the author's memory, not the code.
  const brs = require(require.resolve(path.join(REPO, 'src/services/bootRecoveryService')));
  const bootFilter = brs.buildRecoverySweepFilter(
    new Date(Date.now() - brs.RESUME_STALE_MIN * 60 * 1000),
    new Date(Date.now() - brs.RESUME_CLAIM_STALE_MIN * 60 * 1000)
  );

  // Both clocks stale: boot recovery keys on updatedAt (and claimedAt for a
  // claimed row), reclaim keys on claimedAt (see reclaimStaleTitlerClaims'
  // "STALENESS SIGNAL" note). 60 min is past every window involved.
  const staleAt = new Date(Date.now() - 60 * 60 * 1000);
  const stale = { ...stampFailed, updatedAt: staleAt, claimedAt: staleAt };

  check('E3 [#75 DEPENDENCY] the REAL boot-recovery sweep does NOT select the stamp-failed row — its titler-handoff exclusion (titlingNeeded:true AND a real veoVideoUrl) covers exactly this shape, so nothing plants draft+pending on it', () => {
    assert.strictEqual(nestedMatches(stale, bootFilter), false,
      'boot recovery selected a titler-handoff row — #75 has been reverted or this branch was rebased off it, and the dual claim is REOPEN');
    assert.strictEqual(matches(stale, claimFilter), false, 'claimOne needs claimedByWorker:null');
    assert.strictEqual(matches(stale, resumeFilter), false, 'buildResumeFilter needs status:draft');
  });

  check('E3b [POSITIVE CONTROL] the same sweep DOES select that row once the handoff signal is cleared — so E3 passes because of the exclusion, not because the filter matches nothing', () => {
    assert.strictEqual(nestedMatches({ ...stale, titlingNeeded: false }, bootFilter), true,
      'the real sweep matches nothing at all — E3 is vacuous');
  });

  check('E4 reclaimStaleTitlerClaims IS the backstop for this shape: it selects the row, clears ONLY the claim, and leaves exactly ONE claimant (titler.claimOne) — never two', () => {
    assert.strictEqual(matches(stale, reclaimFilter), true, 'reclaim should select a stale claimed titler row');
    const setKeys = Object.keys((reclaimUpdate && reclaimUpdate.$set) || {}).sort();
    assert.deepStrictEqual(setKeys, ['claimedAt', 'claimedByWorker'],
      `reclaim's $set is ${JSON.stringify(setKeys)} — E4's reasoning assumes it only clears the claim`);
    const afterReclaim = { ...stale, claimedByWorker: null, claimedAt: null };
    assert.strictEqual(matches(afterReclaim, claimFilter), true, 'titler should reclaim and retry');
    assert.strictEqual(matches(afterReclaim, resumeFilter), false, 'resume must NOT also match — that would be the dual claim');
    assert.strictEqual(nestedMatches(afterReclaim, bootFilter), false, 'boot recovery must still stand off the handoff shape');
    const n = [matches(afterReclaim, claimFilter), matches(afterReclaim, resumeFilter)].filter(Boolean).length;
    assert.strictEqual(n, 1, `${n} titling claimants after reclaim (must be exactly 1)`);
  });

  check('E5 the ONLY thing that keeps claimOne off a reclaimed row is titlingNeeded:false — which is why the clear has to live in the stamp', () => {
    const afterReclaimCleared = { ...stale, claimedByWorker: null, claimedAt: null, titlingNeeded: false };
    assert.strictEqual(matches(afterReclaimCleared, claimFilter), false);
  });
}

(async () => {
  await sectionA();
  await sectionB();
  sectionC();
  sectionD();
  await sectionE();

  console.log(`\nverifyTitlingDualClaim: ${passes.length} pass, ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  for (const p of passes) console.log('  ✓ ' + p);
  console.log('\n✅ a resumable titling failure leaves EXACTLY ONE claimant (titlingResumeService), a terminal one leaves none, and the clear is atomic with the claim release.');
})().catch((err) => {
  console.error('verifyTitlingDualClaim: uncaught error —', err);
  process.exit(1);
});
