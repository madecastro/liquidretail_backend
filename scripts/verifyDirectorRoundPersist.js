#!/usr/bin/env node
'use strict';
//
// verifyDirectorRoundPersist — money + plumbing for Director-round artifact
// insert races and the Atlas max_tokens ceiling that lets DIRECTOR_ROUND_TOKENS
// actually reach the provider.
//
// WHY THIS EXISTS (2026-08-06 production defect):
//   Three concurrent directConceptsRound calls for the same brand+product both
//   paid anthropic/claude-sonnet-5 via Atlas, then TWO lost on
//   CreativeDirectionArtifact.create with E11000 on the 6-field unique index
//   (roundIndex collision). The paid concepts were thrown away. Root cause:
//   read-then-write roundIndex pick with no lock, billable call in between,
//   unhandled insert error.
//
//   Separately: DIRECTOR_ROUND_TOKENS was raised 8000 → 30000, but
//   atlasLlmService.buildAtlasBody clamped Math.min(16384, max_tokens), so the
//   raise was a silent no-op at the wire.
//
// This harness is pure + offline: no DB, no network, no API key.
//   node scripts/verifyDirectorRoundPersist.js
//
// Revert-prove (each mutation must fail this harness):
//   1. In createRoundArtifactWithRetry, remove the E11000 retry (rethrow all
//      errors) → D* money assertions fail.
//   2. Retry ALL Errors as transient (or drop permanent throw) → N* permanent
//      non-duplicate propagation fails.
//   3. Remove isTransientInsertError branch (throw non-dup immediately) →
//      R* transient-retry money assertions fail.
//   4. Remove the findLast try/catch (let re-read throw escape) → F* fails.
//   5. Set ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS to Infinity or remove the bound
//      → B* bound assertions fail. Drop back to 5 → B1 fails (must stay ~25).
//   6. Restore Math.min(16_384, …) in buildAtlasBody → T* token-ceiling fails.
//   7. Clamp + reserve in one Math.min (swallow reserve) → T* reserve fails.
//   8. Remove `contractWarnings` from directConceptsRound's return object
//      (2026-08-19) → W12 fails. Move it into an unrelated object literal
//      elsewhere in the function → W13 fails (catches "added the key but not
//      to the actual return").
//   Restoring each makes them pass. Report failing output verbatim.
//
// Covered:
//   D*  MONEY: duplicate-key on insert is retried; paid concepts persist;
//       returned roundIndex matches what was written
//   R*  MONEY: transient non-duplicate insert faults are retried; paid concepts
//       persist; permanent non-duplicate still propagates on first attempt
//   F*  MONEY: findLast re-read throw falls back to idx+1 (paid payload kept)
//   N*  permanent non-duplicate insert errors still propagate (no silent swallow)
//   B*  retry is bounded (finite attempts ~25); exhaustion rethrows
//   I*  detector scopes to THIS index (roundIndex), not bare message match
//   P*  isTransientInsertError allowlist precision
//   W*  directConceptsRound wires the retry helper (source pin); W12-W13
//       pin the 2026-08-19 contractWarnings addition to its return value
//   T*  DIRECTOR_ROUND_TOKENS=30000 survives buildAtlasBody; reserve still added

const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', 'services', 'aiCreativeDirectorService.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const {
  createRoundArtifactWithRetry,
  isRoundIndexDuplicateKeyError,
  isTransientInsertError,
  ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS,
  DIRECTOR_ROUND_TOKENS
} = require('../services/aiCreativeDirectorService');

const {
  buildAtlasBody,
  REASONING_RESERVE_TOKENS,
  ATLAS_MAX_OUTPUT_TOKENS
} = require('../services/atlasLlmService');

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

// ── helpers for mock create / findLast ───────────────────────────────

function mongoDup(roundIndex) {
  const err = new Error(
    `E11000 duplicate key error collection: liquidRetail.creativedirectionartifacts ` +
    `index: brandId_1_productId_1_campaignKind_1_creativeIntent_1_platformFormat_1_roundIndex_1 ` +
    `dup key: { roundIndex: ${roundIndex} }`
  );
  err.code = 11000;
  err.name = 'MongoServerError';
  err.keyPattern = {
    brandId: 1, productId: 1, campaignKind: 1,
    creativeIntent: 1, platformFormat: 1, roundIndex: 1
  };
  err.keyValue = { roundIndex };
  return err;
}

function netErr(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

const FILTER = {
  brandId: 'b1', productId: 'p1', campaignKind: 'product',
  creativeIntent: null, platformFormat: 'meta_feed_1_1'
};
const CONCEPTS = [{ id: 'paid-concept-A' }, { id: 'paid-concept-B' }];
const DOC = { concepts: CONCEPTS, contractVersion: '3.0', rawResponse: '{"concepts":[]}' };

// ── I: detector precision ────────────────────────────────────────────

check('I1 code 11000 + keyPattern.roundIndex → true',
  isRoundIndexDuplicateKeyError(mongoDup(2)) === true);

{
  const bare = new Error('something else');
  bare.code = 11000;
  bare.name = 'MongoServerError';
  check('I2 bare 11000 without roundIndex signal → false (do not retry)',
    isRoundIndexDuplicateKeyError(bare) === false);
}

{
  const other = new Error('E11000 duplicate key on someOtherIndex');
  other.code = 11000;
  other.name = 'MongoServerError';
  other.keyPattern = { brandId: 1, someOtherField: 1 };
  check('I3 11000 on a different unique index → false',
    isRoundIndexDuplicateKeyError(other) === false);
}

{
  const msgOnly = new Error('network blip mentioning roundIndex by accident');
  // no code 11000
  check('I4 message substring alone (no code 11000) → false',
    isRoundIndexDuplicateKeyError(msgOnly) === false);
}

{
  const wrapped = new Error('wrapper');
  wrapped.cause = mongoDup(3);
  check('I5 mongoose-wrapped cause with 11000+roundIndex → true',
    isRoundIndexDuplicateKeyError(wrapped) === true);
}

check('I6 null/undefined → false',
  isRoundIndexDuplicateKeyError(null) === false &&
  isRoundIndexDuplicateKeyError(undefined) === false);

// ── P: transient-insert allowlist precision ──────────────────────────

check('P1 ECONNRESET → transient true',
  isTransientInsertError(netErr('ECONNRESET')) === true);
check('P2 ETIMEDOUT → transient true',
  isTransientInsertError(netErr('ETIMEDOUT')) === true);
check('P3 ECONNREFUSED → transient true',
  isTransientInsertError(netErr('ECONNREFUSED', 'ECONNREFUSED mongodb')) === true);
check('P4 MongoNetworkError name → transient true',
  (() => {
    const e = new Error('connection lost');
    e.name = 'MongoNetworkError';
    return isTransientInsertError(e) === true;
  })());
check('P5 RetryableWriteError label → transient true',
  (() => {
    const e = new Error('retryable');
    e.errorLabels = ['RetryableWriteError'];
    return isTransientInsertError(e) === true;
  })());
check('P6 ValidationError → transient false (permanent)',
  (() => {
    const e = new Error('validation failed: concepts path required');
    e.name = 'ValidationError';
    return isTransientInsertError(e) === false;
  })());
check('P7 CastError → transient false (permanent)',
  (() => {
    const e = new Error('Cast to ObjectId failed');
    e.name = 'CastError';
    return isTransientInsertError(e) === false;
  })());
check('P8 bare application Error → transient false',
  isTransientInsertError(new Error('validation failed')) === false);
check('P9 roundIndex E11000 is NOT classified as transient (dup path owns it)',
  isTransientInsertError(mongoDup(1)) === false);
check('P10 null/undefined → false',
  isTransientInsertError(null) === false &&
  isTransientInsertError(undefined) === false);
check('P11 mongoose-wrapped cause with ECONNRESET → true',
  (() => {
    const outer = new Error('wrapper');
    outer.cause = netErr('ECONNRESET');
    return isTransientInsertError(outer) === true;
  })());

// ── D / R / F / N / B: async behaviour ───────────────────────────────

(async () => {
  // D1: first create collides on r2, second succeeds on re-derived r3
  {
    let createCalls = 0;
    const written = [];
    const findCalls = [];
    const result = await createRoundArtifactWithRetry({
      filter: FILTER,
      roundIndex: 2,
      doc: DOC,
      create: async (payload) => {
        createCalls++;
        written.push(payload.roundIndex);
        if (payload.roundIndex === 2) throw mongoDup(2);
        // success path — return a mongoose-ish doc
        return {
          ...payload,
          toObject() { return { ...payload, _id: 'art1' }; }
        };
      },
      findLast: async () => {
        findCalls.push(true);
        return 2; // winner already took 2
      }
    });
    check('D1a insert retried after E11000 (2 create calls)', createCalls === 2,
      `calls=${createCalls}`);
    check('D1b paid concepts persisted on successful insert',
      Array.isArray(result.artifact.concepts) &&
      result.artifact.concepts.length === 2 &&
      result.artifact.concepts[0].id === 'paid-concept-A',
      JSON.stringify(result.artifact.concepts));
    check('D1c returned roundIndex is the one actually written (3, not stale 2)',
      result.roundIndex === 3,
      `got ${result.roundIndex}`);
    check('D1d artifact.roundIndex matches return value',
      result.artifact.roundIndex === result.roundIndex,
      `artifact=${result.artifact.roundIndex} return=${result.roundIndex}`);
    check('D1e first attempt used colliding index, second used re-derived',
      written[0] === 2 && written[1] === 3,
      JSON.stringify(written));
    check('D1f findLast consulted to re-derive (insert-only path)',
      findCalls.length === 1, `findCalls=${findCalls.length}`);
    check('D1g insertAttempts reports final successful attempt',
      result.insertAttempts === 2, `got ${result.insertAttempts}`);
  }

  // D2: no collision — single insert, original index kept
  {
    const result = await createRoundArtifactWithRetry({
      filter: FILTER,
      roundIndex: 0,
      doc: DOC,
      create: async (payload) => ({ ...payload, _id: 'ok' }),
      findLast: async () => { throw new Error('findLast must not run on clean insert'); }
    });
    check('D2a clean insert keeps original roundIndex', result.roundIndex === 0);
    check('D2b clean insert is one attempt', result.insertAttempts === 1);
    check('D2c clean insert still carries concepts',
      result.artifact.concepts[0].id === 'paid-concept-A');
  }

  // ── F: MONEY — findLast throw must not destroy paid payload ────────
  // Revert-prove: delete the try/catch around findLast → this block fails
  // (re-read Error escapes, create never succeeds, concepts never land).

  {
    let createCalls = 0;
    const written = [];
    let findThrows = 0;
    const result = await createRoundArtifactWithRetry({
      filter: FILTER,
      roundIndex: 4,
      doc: DOC,
      create: async (payload) => {
        createCalls++;
        written.push(payload.roundIndex);
        if (payload.roundIndex === 4) throw mongoDup(4);
        return { ...payload, _id: 'art-f' };
      },
      findLast: async () => {
        findThrows++;
        throw new Error('MongoNetworkError: connection pool closed mid re-read');
      }
    });
    check('F1 findLast throw did not abort retry (2 create calls)',
      createCalls === 2, `calls=${createCalls}`);
    check('F2 paid concepts persisted after findLast failure',
      result.artifact.concepts[0].id === 'paid-concept-A',
      JSON.stringify(result.artifact.concepts));
    check('F3 fallback used idx+1 (4 → 5) when re-read failed',
      result.roundIndex === 5 && written[0] === 4 && written[1] === 5,
      `written=${JSON.stringify(written)} roundIndex=${result.roundIndex}`);
    check('F4 findLast was attempted once then recovered',
      findThrows === 1, `findThrows=${findThrows}`);
  }

  // ── R: MONEY — transient non-dup insert retried; permanent not ─────

  {
    let createCalls = 0;
    const result = await createRoundArtifactWithRetry({
      filter: FILTER,
      roundIndex: 7,
      doc: DOC,
      create: async (payload) => {
        createCalls++;
        if (createCalls === 1) throw netErr('ECONNRESET', 'read ECONNRESET');
        return { ...payload, _id: 'art-r' };
      },
      findLast: async () => {
        throw new Error('findLast must not run on transient (same-index) retry');
      }
    });
    check('R1a transient ECONNRESET retried (2 create calls)', createCalls === 2,
      `calls=${createCalls}`);
    check('R1b paid concepts persisted after transient retry',
      result.artifact.concepts[0].id === 'paid-concept-A');
    check('R1c same roundIndex kept on transient retry (no re-derive)',
      result.roundIndex === 7, `got ${result.roundIndex}`);
    check('R1d insertAttempts reports success on attempt 2',
      result.insertAttempts === 2, `got ${result.insertAttempts}`);
  }

  {
    let createCalls = 0;
    const result = await createRoundArtifactWithRetry({
      filter: FILTER,
      roundIndex: 1,
      doc: DOC,
      create: async (payload) => {
        createCalls++;
        if (createCalls < 3) {
          const e = new Error('connection timed out');
          e.name = 'MongoNetworkError';
          throw e;
        }
        return { ...payload, _id: 'art-r2' };
      },
      findLast: async () => {
        throw new Error('findLast must not run on MongoNetworkError path');
      }
    });
    check('R2a MongoNetworkError retried until success (3 calls)', createCalls === 3,
      `calls=${createCalls}`);
    check('R2b paid concepts survived multi-transient retry',
      result.artifact.concepts[0].id === 'paid-concept-A');
  }

  // ── N: permanent non-duplicate errors propagate promptly ───────────

  {
    let threw = null;
    let createCalls = 0;
    try {
      await createRoundArtifactWithRetry({
        filter: FILTER,
        roundIndex: 1,
        doc: DOC,
        create: async () => {
          createCalls++;
          const e = new Error('validation failed: concepts path required');
          e.name = 'ValidationError';
          throw e;
        },
        findLast: async () => { throw new Error('findLast must not run'); }
      });
    } catch (err) { threw = err; }
    check('N1 permanent ValidationError propagates on first attempt',
      threw && threw.name === 'ValidationError' && createCalls === 1,
      `calls=${createCalls} threw=${threw && threw.name}`);
  }

  {
    let threw = null;
    let createCalls = 0;
    try {
      await createRoundArtifactWithRetry({
        filter: FILTER,
        roundIndex: 1,
        doc: DOC,
        create: async () => {
          createCalls++;
          const e = new Error('E11000 duplicate key on someOtherIndex');
          e.code = 11000;
          e.name = 'MongoServerError';
          e.keyPattern = { brandId: 1, other: 1 };
          throw e;
        },
        findLast: async () => { throw new Error('findLast must not run for other-index 11000'); }
      });
    } catch (err) { threw = err; }
    check('N2 unrelated 11000 propagates immediately (no retry)',
      threw && threw.code === 11000 && createCalls === 1,
      `calls=${createCalls} threw=${threw && threw.message}`);
  }

  {
    let threw = null;
    let createCalls = 0;
    try {
      await createRoundArtifactWithRetry({
        filter: FILTER,
        roundIndex: 1,
        doc: DOC,
        create: async () => {
          createCalls++;
          throw new Error('validation failed');
        },
        findLast: async () => 0
      });
    } catch (err) { threw = err; }
    check('N3 generic permanent Error propagates with single attempt',
      threw && /validation failed/.test(threw.message) && createCalls === 1,
      `calls=${createCalls} threw=${threw && threw.message}`);
  }

  // ── B: retry is bounded ────────────────────────────────────────────

  // ~25 is intentional cheap insurance for a paid payload; pin the raised
  // value so a silent drop back to 5 fails the harness.
  check('B1 ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS is finite int in insurance band [20,50]',
    Number.isInteger(ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS) &&
    ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS >= 20 &&
    ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS <= 50,
    `got ${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS}`);
  check('B1b ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS is exactly 25',
    ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS === 25,
    `got ${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS}`);

  {
    let createCalls = 0;
    let threw = null;
    try {
      await createRoundArtifactWithRetry({
        filter: FILTER,
        roundIndex: 0,
        doc: DOC,
        create: async (payload) => {
          createCalls++;
          throw mongoDup(payload.roundIndex);
        },
        findLast: async () => createCalls - 1 // always "last is what we just tried"
      });
    } catch (err) { threw = err; }
    check('B2 E11000 exhausts exactly MAX attempts then throws',
      createCalls === ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS,
      `calls=${createCalls} max=${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS}`);
    check('B3 exhausted E11000 path rethrows the duplicate-key error',
      threw && isRoundIndexDuplicateKeyError(threw),
      threw ? `${threw.name} code=${threw.code}` : 'no throw');
  }

  {
    // Bound exhaustion also applies to pure-transient create failures.
    let createCalls = 0;
    let threw = null;
    try {
      await createRoundArtifactWithRetry({
        filter: FILTER,
        roundIndex: 0,
        doc: DOC,
        create: async () => {
          createCalls++;
          throw netErr('ECONNRESET', 'read ECONNRESET');
        },
        findLast: async () => {
          throw new Error('findLast must not run on pure-transient exhaust');
        }
      });
    } catch (err) { threw = err; }
    check('B4 transient exhausts exactly MAX attempts then throws',
      createCalls === ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS,
      `calls=${createCalls} max=${ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS}`);
    check('B5 exhausted transient path rethrows the network error',
      threw && threw.code === 'ECONNRESET',
      threw ? `${threw.code} ${threw.message}` : 'no throw');
  }

  // ── W: source wiring pins ──────────────────────────────────────────

  // Isolate the directConceptsRound function body so we pin the LIVE path,
  // not a comment or a dead helper.
  const roundFnMatch = SRC.match(/async function directConceptsRound\([\s\S]*?\n^async function loadAvoidList/m);
  const roundFn = roundFnMatch ? roundFnMatch[0] : '';
  check('W1 directConceptsRound source region found', !!roundFn);

  check('W2 directConceptsRound calls createRoundArtifactWithRetry (not bare create only)',
    /createRoundArtifactWithRetry\s*\(/.test(roundFn));

  check('W3 directConceptsRound does NOT bare-call CreativeDirectionArtifact.create',
    !/CreativeDirectionArtifact\.create\s*\(/.test(roundFn));

  // Success log must sit AFTER the insert so it reports the final index.
  {
    const insertAt = roundFn.indexOf('createRoundArtifactWithRetry');
    // template literal in source is directorRound[r${roundIndex}/...
    const logAt2 = roundFn.search(/directorRound\[r\$\{roundIndex\}/);
    check('W4 success log is after createRoundArtifactWithRetry',
      insertAt >= 0 && logAt2 > insertAt,
      `insertAt=${insertAt} logAt=${logAt2}`);
  }

  check('W5 return assigns persistedRoundIndex (final value, not stale pre-collision)',
    /roundIndex\s*=\s*persistedRoundIndex/.test(roundFn) ||
    /roundIndex:\s*persistedRoundIndex/.test(roundFn) ||
    /persistedRoundIndex/.test(roundFn));

  // Bound must be documented (why finite) near the constant.
  check('W6 bound constant has a "why finite" comment nearby',
    /ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS[\s\S]{0,400}spin|cannot spin|unbounded|Bound exists/i.test(SRC) ||
    /Bound exists so[\s\S]{0,200}ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS|ROUND_ARTIFACT_INSERT_MAX_ATTEMPTS\s*=\s*\d+[\s\S]{0,300}bound/i.test(SRC));

  // Append-only contract preserved — no findOneAndReplace / upsert on this path.
  check('W7 no findOneAndReplace / findOneAndUpdate upsert in createRoundArtifactWithRetry',
    (() => {
      const m = SRC.match(/async function createRoundArtifactWithRetry[\s\S]*?\nasync function directConceptsRound/);
      if (!m) return false;
      return !/findOneAndReplace|findOneAndUpdate|upsert\s*:\s*true/.test(m[0]);
    })());

  // Persist-block comment must NOT overclaim absolute "never discarded".
  check('W8 persist comment does not claim absolute never-discarded',
    !/paid response is never discarded|so a paid response is never discarded/i.test(roundFn));
  check('W9 persist comment acknowledges residual bound/permanent risk',
    /residual|bound exhaustion|permanent insert/i.test(roundFn));

  // findLast re-read guard must exist (source pin for F*).
  check('W10 createRoundArtifactWithRetry wraps findLast in try/catch',
    (() => {
      const m = SRC.match(/async function createRoundArtifactWithRetry[\s\S]*?\nasync function directConceptsRound/);
      if (!m) return false;
      // try { const last = await findLast ... } catch
      return /try\s*\{[\s\S]*?await findLast[\s\S]*?\}\s*catch/.test(m[0]);
    })());

  // Transient path must be wired (not just exported).
  check('W11 createRoundArtifactWithRetry calls isTransientInsertError',
    (() => {
      const m = SRC.match(/async function createRoundArtifactWithRetry[\s\S]*?\nasync function directConceptsRound/);
      if (!m) return false;
      return /isTransientInsertError\s*\(/.test(m[0]);
    })());

  // 2026-08-19: the round-contract `reasons` array used to be console+Slack
  // only ('director:contract-warn' alert a few dozen lines above the return)
  // and never reached the caller in-memory, so it could never reach
  // CampaignRun (docs/ALERTING.md "In-app run status vs Slack" gap table).
  // Source-pinned like W1-W11 above: this function calls a live LLM, so the
  // full chain can't be exercised by calling it directly in an offline
  // harness. Behavioral coverage for what happens AFTER this return value
  // exists lives in scripts/verifyPerProductReasons.js (H/I/J sections).
  check('W12 directConceptsRound return object carries contractWarnings (same slice(0,6) as the Slack alert)',
    /contractWarnings:\s*reasons\.length\s*\?\s*reasons\.slice\(0,\s*6\)\s*:\s*\[\]/.test(roundFn));

  check('W13 contractWarnings sits in the SAME return object as avoidListCount (the real return, not a stray reference elsewhere in the function)',
    (() => {
      const retMatch = roundFn.match(/return\s*\{[\s\S]*?\};/);
      return !!retMatch && /avoidListCount/.test(retMatch[0]) && /contractWarnings/.test(retMatch[0]);
    })());

  // ── T: token ceiling — 30000 survives buildAtlasBody ───────────────

  check('T1 DIRECTOR_ROUND_TOKENS is 30000 (already-done raise still present)',
    DIRECTOR_ROUND_TOKENS === 30000, `got ${DIRECTOR_ROUND_TOKENS}`);

  check('T2 ATLAS_MAX_OUTPUT_TOKENS >= DIRECTOR_ROUND_TOKENS',
    ATLAS_MAX_OUTPUT_TOKENS >= DIRECTOR_ROUND_TOKENS,
    `clamp=${ATLAS_MAX_OUTPUT_TOKENS} director=${DIRECTOR_ROUND_TOKENS}`);

  {
    const body = buildAtlasBody(
      { messages: [], max_tokens: DIRECTOR_ROUND_TOKENS },
      'anthropic/claude-sonnet-5'
    );
    check('T3 Director 30000 is NOT clamped to 16384',
      body.max_tokens !== 16384 + REASONING_RESERVE_TOKENS,
      `got ${body.max_tokens}`);
    check('T4 Director budget survives clamp: 30000 + reserve',
      body.max_tokens === DIRECTOR_ROUND_TOKENS + REASONING_RESERVE_TOKENS,
      `got ${body.max_tokens}, want ${DIRECTOR_ROUND_TOKENS + REASONING_RESERVE_TOKENS}`);
  }

  {
    // Lower budgets unchanged — shared raise must not inflate smaller callers.
    const body = buildAtlasBody({ messages: [], max_tokens: 1500 }, 'openai/gpt-4.1');
    check('T5 lower caller budget still exact (1500 + reserve)',
      body.max_tokens === 1500 + REASONING_RESERVE_TOKENS,
      `got ${body.max_tokens}`);
  }

  {
    // Over-ceiling still clamped, then reserve ALWAYS added on top.
    const over = ATLAS_MAX_OUTPUT_TOKENS + 50_000;
    const body = buildAtlasBody({ messages: [], max_tokens: over }, 'anthropic/claude-sonnet-5');
    check('T6 over-ceiling request clamps then adds full reserve (reserve not swallowed)',
      body.max_tokens === ATLAS_MAX_OUTPUT_TOKENS + REASONING_RESERVE_TOKENS,
      `got ${body.max_tokens}`);
  }

  check('T7 REASONING_RESERVE_TOKENS is a positive number',
    Number.isFinite(REASONING_RESERVE_TOKENS) && REASONING_RESERVE_TOKENS > 0,
    `got ${REASONING_RESERVE_TOKENS}`);

  // ── report ─────────────────────────────────────────────────────────

  if (failures.length) {
    console.error(`FAIL ${failures.length}  (pass ${pass})`);
    for (const f of failures) console.error('  ✗', f);
    process.exit(1);
  }
  console.log(`OK ${pass} checks`);
})().catch((err) => {
  console.error('FAIL harness threw:', err);
  process.exit(1);
});
