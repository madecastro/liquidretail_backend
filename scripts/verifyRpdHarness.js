#!/usr/bin/env node
//
// verifyRpdHarness.js — offline harness for scripts/rpd (rapid product
// development harness). No network, no DB, no ATLAS_API_KEY needed.
//
// The RPD harness holds a billable door (atlasVideoService.submitGeneration),
// so its money gates are pinned here the same way the pipeline's are:
//
//   A. Budget gates: --live without --max-usd refuses; over-cap refuses
//      BEFORE any submit; a cell with no pricing data is never live-submitted.
//   B. `rpd resume` is STRUCTURALLY incapable of spending: neither
//      lib/resume.js nor lib/atlasPoll.js may reference submitGeneration or
//      POST anything (same invariant shape as titlingResumeService T6/T10).
//   C. Receipt ordering: runner flushes predictionId to the manifest BEFORE
//      polling (a crash after submit must never lose a spend receipt).
//   D. Prompt engine: baseline is byte-identical to production buildVeoPrompt;
//      the directives lever restores the module singleton byte-identically;
//      patch/guidance/raw behave as documented; misuse is a hard error.
//   E. Wiring: submitGeneration is exported; dry-run mints no receipts.
//
// Revert-proofs (each was backed out and confirmed to fail):
//   - drop the `!(Number.isFinite(maxUsd)...)` check in assertBudget → A2
//   - move the writeManifest receipt flush below settleCell → C2
//   - remove the `finally` restore in buildWithDirectivePatch → D5

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

const RPD = path.join(__dirname, 'rpd');
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  // ── B. resume path cannot spend (source scans + import-resolves) ──────
  console.log('\nB. resume path is structurally incapable of spending');
  const resumeSrc = read(path.join(RPD, 'lib', 'resume.js'));
  const pollSrc = read(path.join(RPD, 'lib', 'atlasPoll.js'));
  check('B1 resume.js never references submitGeneration or generateVideo', () => {
    assert(!/submitGeneration|generateVideo|buildSubmissionBody/.test(resumeSrc));
  });
  check('B2 atlasPoll.js never POSTs (no axios.post, no submit reference)', () => {
    assert(!/axios\.post|submitGeneration|generateVideo/.test(pollSrc));
  });
  check('B3 resume.js requires only manifest + atlasPoll', () => {
    const reqs = [...resumeSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(reqs.sort(), ['./atlasPoll', './manifest']);
  });
  check('B4 modules import-resolve (regex cannot see unbound identifiers)', () => {
    const { resumeRun } = require(path.join(RPD, 'lib', 'resume'));
    const poll = require(path.join(RPD, 'lib', 'atlasPoll'));
    assert(typeof resumeRun === 'function');
    assert(typeof poll.settleCell === 'function' && typeof poll.fetchSettledPrice === 'function');
  });

  // ── C. spend receipts (FUNCTIONAL — submitCells takes injectable deps) ─
  console.log('\nC. spend receipts survive every failure mode');
  const runnerSrc = read(path.join(RPD, 'lib', 'runner.js'));
  const { submitCells } = require(path.join(RPD, 'lib', 'runner'));
  const mkCell = (id) => ({
    id, model: 'google/gemini-omni-flash/image-to-video-developer',
    prompt: 'p', imageUrls: ['u'], aspectRatio: '9:16', durationSec: 4,
    status: 'planned', estUsd: 0.6, charged: false, timings: {}
  });
  const silentLog = { log: () => {}, error: () => {}, warn: () => {} };

  await checkAsync('C1 a successful submit lands the receipt on the persisted manifest', async () => {
    const cell = mkCell('c1');
    const persisted = [];
    await submitCells([cell], {
      runDir: '/nowhere', manifest: { cells: [cell] },
      submit: async () => 'pred_123',
      persist: (_dir, m) => persisted.push(JSON.stringify(m)),
      log: silentLog
    });
    assert.strictEqual(cell.predictionId, 'pred_123');
    assert.strictEqual(cell.status, 'submitted');
    assert(persisted.some((s) => s.includes('pred_123')), 'a persist call must carry the receipt');
  });
  await checkAsync('C2 a persist failure AFTER a billed submit aborts loudly and never reclassifies the cell as failed', async () => {
    const cell = mkCell('c2');
    let calls = 0;
    await assert.rejects(
      submitCells([cell], {
        runDir: '/nowhere', manifest: { cells: [cell] },
        submit: async () => 'pred_456',
        // First persist (status=submitting) succeeds; the receipt flush throws.
        persist: () => { calls++; if (calls >= 2) throw new Error('disk full'); },
        log: silentLog
      }),
      /disk full/
    );
    assert.strictEqual(cell.status, 'submitted', 'a billed submit must never be downgraded to failed by a persistence error');
    assert.strictEqual(cell.predictionId, 'pred_456', 'the receipt must stay on the in-memory cell');
  });
  await checkAsync('C3 a submit throw marks the cell failed with UNKNOWN charge and continues the batch', async () => {
    const a = mkCell('c3a'); const b = mkCell('c3b');
    let threw = false;
    await submitCells([a, b], {
      runDir: '/nowhere', manifest: { cells: [a, b] },
      submit: async () => { if (!threw) { threw = true; throw new Error('boom'); } return 'pred_b'; },
      persist: () => {},
      log: silentLog
    });
    assert.strictEqual(a.status, 'failed');
    assert.strictEqual(a.charged, null, 'no receipt ⇒ charge state unknowable, never false');
    assert(!a.predictionId);
    assert.strictEqual(b.status, 'submitted');
    assert.strictEqual(b.predictionId, 'pred_b');
  });
  check('C4 the runner itself never retries a billable submit, and gates before submitting', () => {
    // The only retry loop lives inside submitGeneration (structured-429 only),
    // and runSpec must consult the budget gate before the submit phase.
    assert(!/for\s*\(.*attempt/.test(runnerSrc), 'no attempt loop in the runner');
    const gate = runnerSrc.indexOf('assertBudget(');
    const submitPhase = runnerSrc.indexOf('await submitCells(');
    assert(gate !== -1 && submitPhase !== -1 && gate < submitPhase, 'assertBudget must precede submitCells in runSpec');
  });

  // ── A. budget gates (functional) ───────────────────────────────────────
  console.log('\nA. budget gates');
  const { assertBudget, expandCells, loadSpec } = require(path.join(RPD, 'lib', 'runner'));
  const mkCells = () => ([
    { id: 'a', status: 'planned', estUsd: 1.0 },
    { id: 'b', status: 'planned', estUsd: 0.9 },
    { id: 'c', status: 'skipped', estUsd: 5 }
  ]);
  check('A1 live without --max-usd refuses', () => {
    assert.throws(() => assertBudget(mkCells(), null), /--max-usd/);
    assert.throws(() => assertBudget(mkCells(), NaN), /--max-usd/);
    assert.throws(() => assertBudget(mkCells(), 0), /--max-usd/);
  });
  check('A2 over-cap refuses before any submit', () => {
    assert.throws(() => assertBudget(mkCells(), 1.5), /exceeds --max-usd/);
  });
  check('A3 unpriced cells are skipped, never live-submitted', () => {
    const cells = [{ id: 'x', status: 'planned', estUsd: null }, { id: 'y', status: 'planned', estUsd: 0.5 }];
    const { live } = assertBudget(cells, 10);
    assert.strictEqual(live.length, 1);
    assert.strictEqual(cells[0].status, 'skipped');
    assert(/no pricing data/.test(cells[0].error));
  });
  check('A4 under-cap passes with the correct total', () => {
    const { live, total } = assertBudget(mkCells(), 2.5);
    assert.strictEqual(live.length, 2);
    assert(Math.abs(total - 1.9) < 1e-9);
  });
  check('A5 a NaN estimate is not a price — skipped, never summed past the cap', () => {
    // NaN > cap is false; an unguarded sum would sail through the gate.
    const cells = [{ id: 'n', status: 'planned', estUsd: NaN }, { id: 'y', status: 'planned', estUsd: 0.5 }];
    const { live, total } = assertBudget(cells, 1.0);
    assert.strictEqual(cells[0].status, 'skipped');
    assert.strictEqual(live.length, 1);
    assert(Number.isFinite(total));
  });

  // ── D. prompt engine vs production builder ────────────────────────────
  console.log('\nD. prompt engine');
  const { buildForCell, buildFixture } = require(path.join(RPD, 'lib', 'promptVariants'));
  const { buildVeoPrompt, enforceRawByteCap, OMNI_DIRECTIVES } =
    require(path.join(__dirname, '..', 'services', 'veoPromptBuilder'));
  const { capsFor, BUILT_IN_DEFAULT_MODEL } =
    require(path.join(__dirname, '..', 'services', 'atlasVideoService'));

  const model = BUILT_IN_DEFAULT_MODEL;
  const caps = capsFor(model);
  const spec = {
    name: 'verify', seed: { url: 'https://res.cloudinary.com/x/image/upload/v1/s.jpg', productTitle: 'Verify Product', refs: [] },
    aspectRatio: '9:16', durationSec: 8
  };

  check('D1 baseline is byte-identical to production buildVeoPrompt', () => {
    const { prompt, fixture } = buildForCell({ spec, model, caps, variant: { id: 'baseline' } });
    assert.strictEqual(prompt, buildVeoPrompt(fixture));
    assert.strictEqual(prompt, buildVeoPrompt(buildFixture({ spec, model, caps, variant: { id: 'baseline' } })));
  });
  check('D2 guidance lever prepends the operator refinement', () => {
    const g = 'Verify guidance sentence.';
    const { prompt, promptMeta } = buildForCell({ spec, model, caps, variant: { id: 'g', guidance: g } });
    assert(prompt.includes(g));
    assert(/OPERATOR REFINEMENT/.test(prompt));
    assert.strictEqual(promptMeta.lever, 'guidance');
    assert(Array.isArray(promptMeta.baselineDiff) && promptMeta.baselineDiff.some((l) => l.type === 'add'));
  });
  check('D3 raw lever bypasses the builder via enforceRawByteCap', () => {
    const raw = 'Full replacement prompt for verification.';
    const { prompt, promptMeta } = buildForCell({ spec, model, caps, variant: { id: 'r', raw } });
    assert.strictEqual(prompt, enforceRawByteCap(raw, caps));
    assert.strictEqual(promptMeta.lever, 'raw');
    assert(!/OPERATOR REFINEMENT|Ken Burns/.test(prompt));
  });
  check('D4 directives lever patches the profile set for one build', () => {
    const objective = 'Objective: Verification objective sentence, entirely distinct.';
    const { prompt } = buildForCell({ spec, model, caps, variant: { id: 'd', directives: { objective } } });
    assert(prompt.includes(objective));
    assert(!prompt.includes(OMNI_DIRECTIVES.objective));
  });
  check('D5 directive singleton is restored byte-identically after the build', () => {
    const before = JSON.stringify(OMNI_DIRECTIVES);
    buildForCell({ spec, model, caps, variant: { id: 'd', directives: { objective: 'Objective: temp.' } } });
    assert.strictEqual(JSON.stringify(OMNI_DIRECTIVES), before);
    // ...even when the build throws mid-flight:
    try {
      buildForCell({ spec, model, caps, variant: { id: 'd2', directives: { objective: 'Objective: temp.', nonsenseKey: 'x' } } });
    } catch { /* expected */ }
    assert.strictEqual(JSON.stringify(OMNI_DIRECTIVES), before);
  });
  check('D6 unknown directive key is a hard error naming valid keys', () => {
    assert.throws(
      () => buildForCell({ spec, model, caps, variant: { id: 'd3', directives: { cameraStile: 'typo' } } }),
      /does not exist on the gemini-omni directive set/
    );
  });
  check('D7 patch lever enforces exactly-once find', () => {
    const { prompt } = buildForCell({
      spec, model, caps,
      variant: { id: 'p', patch: [{ find: 'Smooth crossfades only', replace: 'Hard cuts only' }] }
    });
    assert(prompt.includes('Hard cuts only'));
    assert.throws(
      () => buildForCell({ spec, model, caps, variant: { id: 'p2', patch: [{ find: 'NOT IN THE PROMPT', replace: 'x' }] } }),
      /not present/
    );
    assert.throws(
      () => buildForCell({ spec, model, caps, variant: { id: 'p3', patch: [{ find: 'the', replace: 'x' }] } }),
      /more than once/
    );
  });
  check('D8 multiple levers on one variant refuse', () => {
    assert.throws(
      () => buildForCell({ spec, model, caps, variant: { id: 'm', guidance: 'a', raw: 'b' } }),
      /multiple levers/
    );
  });
  check('D9 over-byte-cap prompt refuses', () => {
    const tinyCaps = { ...caps, promptByteCap: 64 };
    assert.throws(
      () => buildForCell({ spec, model, caps: tinyCaps, variant: { id: 'big' } }),
      /over the 64-byte cap/
    );
  });

  // ── E. wiring ──────────────────────────────────────────────────────────
  console.log('\nE. wiring');
  check('E1 atlasVideoService exports submitGeneration for the harness', () => {
    const svc = require(path.join(__dirname, '..', 'services', 'atlasVideoService'));
    assert.strictEqual(typeof svc.submitGeneration, 'function');
  });
  check('E2 unsupported aspect is an honest per-cell skip, not a reroute', () => {
    const cells = expandCells({
      ...spec, aspectRatio: '1:1',
      models: [model], variants: [{ id: 'baseline' }]
    });
    assert.strictEqual(cells[0].status, 'skipped');
    assert(/does not support 1:1/.test(cells[0].error));
  });
  check('E3 duration snaps to the model enum and both values are recorded', () => {
    const cells = expandCells({ ...spec, durationSec: 7, models: [model], variants: [{ id: 'baseline' }] });
    assert(cells[0].status === 'planned');
    assert((caps.allowedDurations || [4, 6, 8, 10]).includes(cells[0].durationSec));
    assert.deepStrictEqual(cells[0].durationSnapped, { requested: 7, effective: cells[0].durationSec });
    // The prompt's Timeline must be built from the EFFECTIVE duration.
    assert(cells[0].prompt.includes(`Output: ${cells[0].durationSec}`));
  });
  check('E5 an unknown spec.resolution is refused per cell, never priced as 720p and submitted verbatim', () => {
    const prev = process.env.ATLAS_VIDEO_RESOLUTION;
    process.env.ATLAS_VIDEO_RESOLUTION = '4K'; // typo: enum is lowercase '4k'
    try {
      const cells = expandCells({ ...spec, models: [model], variants: [{ id: 'baseline' }] });
      assert.strictEqual(cells[0].status, 'skipped');
      assert(/resolution "4K" is not in the model's enum/.test(cells[0].error));
    } finally {
      if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION;
      else process.env.ATLAS_VIDEO_RESOLUTION = prev;
    }
  });
  check('E6 a reference-to-video model is skipped (image seeds only), not submitted seedless', () => {
    const cells = expandCells({
      ...spec,
      models: ['google/gemini-omni-flash/reference-to-video-developer'],
      variants: [{ id: 'baseline' }]
    });
    assert.strictEqual(cells[0].status, 'skipped');
    assert(/requires a video seed/.test(cells[0].error));
  });
  check('E7 a lifestyle (ugc) build patches the directive set the builder actually reads', () => {
    // With VIDEO_LIFESTYLE_PROMPT on, variantKind 'ugc' builds from
    // LIFESTYLE_DIRECTIVES — patching the Omni set there would be a silent
    // no-op reported as an experiment arm.
    const prev = process.env.VIDEO_LIFESTYLE_PROMPT;
    process.env.VIDEO_LIFESTYLE_PROMPT = 'true';
    try {
      const { LIFESTYLE_DIRECTIVES } = require(path.join(__dirname, '..', 'services', 'veoPromptBuilder'));
      const before = JSON.stringify(LIFESTYLE_DIRECTIVES);
      const objective = 'Objective: Lifestyle patch sentence, entirely distinct.';
      const { prompt, promptMeta } = buildForCell({
        spec, model, caps,
        variant: { id: 'ugc-d', variantKind: 'ugc', directives: { objective } }
      });
      assert(prompt.includes(objective), 'the patch must reach the prompt');
      assert(Array.isArray(promptMeta.baselineDiff) && promptMeta.baselineDiff.some((l) => l.type === 'add'), 'the diff must not be empty');
      assert.strictEqual(JSON.stringify(LIFESTYLE_DIRECTIVES), before, 'lifestyle singleton must be restored');
    } finally {
      if (prev === undefined) delete process.env.VIDEO_LIFESTYLE_PROMPT;
      else process.env.VIDEO_LIFESTYLE_PROMPT = prev;
    }
  });
  check('E8 titling fixture never defaults proof-class copy (a defaulted quote is a fabricated testimonial)', () => {
    const { fixtureBrand, fixtureMeta } = require(path.join(RPD, 'lib', 'titling'));
    const meta = fixtureMeta({}, fixtureBrand('canonical', 'X'));
    for (const k of ['quote', 'quoteSnippet', 'reviewer', 'rating', 'reviewCount', 'reviewsText', 'badgeText', 'deliveryLine']) {
      assert.strictEqual(meta[k], null, `${k} must be null unless the operator supplies it`);
    }
    const withCopy = fixtureMeta({ quote: 'Real quote', rating: 4.2 }, fixtureBrand('canonical', 'X'));
    assert.strictEqual(withCopy.quote, 'Real quote');
    assert.strictEqual(withCopy.rating, 4.2);
  });
  await checkAsync('E4 dry-run mints no receipts and never flips a cell past planned/skipped', async () => {
    const { runSpec } = require(path.join(RPD, 'lib', 'runner'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-verify-'));
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({
      ...spec, name: 'verify-dry',
      models: [model], variants: [{ id: 'baseline' }, { id: 'g', guidance: 'test' }]
    }));
    const { manifest, runDir } = await runSpec(specPath, { live: false, outRoot: path.join(tmp, 'runs') });
    assert(manifest.cells.every((c) => !c.predictionId));
    assert(manifest.cells.every((c) => c.status === 'planned' || c.status === 'skipped'));
    assert(fs.existsSync(path.join(runDir, 'manifest.json')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
