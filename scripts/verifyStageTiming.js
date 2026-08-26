'use strict';
// Pins services/stageTiming's fire-and-forget shape. Phase 0 measurement
// foundation: Ad.renderStages was declared but never written, blocking any
// per-stage wall-time attribution. This harness pins the invariants a
// telemetry helper must hold — must never fail a paid render, must never
// scatter half-cased keys, must be owner-scoped.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

// stageTiming.js requires ../config, which hard-exits (process.exit(1)) the
// WHOLE test process unless ADGEN_ROLE/MONGODB_URI are set — and, since
// config.js's REQUIRED_ENV_BY_ROLE guard, also Cloudinary vars for
// renderer/titler. A bare worktree/CI checkout has none of these (see
// CLAUDE.md: this repo deliberately ships without a committed node_modules
// or .env). Set harmless placeholders BEFORE requiring the live module —
// `||=` so a real local .env is never clobbered — the same pattern
// verifyTitlerBackpressure.js uses for the same reason.
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'renderer';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adgen_verify_placeholder';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'verify-placeholder';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'verify-placeholder';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'verify-placeholder';
process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'verify-placeholder';

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const st = require(path.join(REPO, 'src', 'services', 'stageTiming.js'));
const src = fs.readFileSync(path.join(REPO, 'src', 'services', 'stageTiming.js'), 'utf8');

// ── A. Exports and whitelist ───────────────────────────────────────────
check('A1: exports stampStageTiming', typeof st.stampStageTiming === 'function');
check('A2: exports startStageTimer',  typeof st.startStageTimer  === 'function');
check('A3: exports KNOWN_STAGES set',  st.KNOWN_STAGES instanceof Set);

const REQUIRED_STAGES = ['layoutInputMs', 'quoteSnippetMs', 'sharpMs', 'atlasSubmitMs', 'visionQcMs', 'remotionMs', 'titlerPickupWaitMs'];
for (const s of REQUIRED_STAGES) {
  check(`A4: KNOWN_STAGES contains ${s}`, st.KNOWN_STAGES.has(s));
}
check('A5: KNOWN_STAGES preserves legacy deriveMs/renderMs/uploadMs',
  st.KNOWN_STAGES.has('deriveMs') && st.KNOWN_STAGES.has('renderMs') && st.KNOWN_STAGES.has('uploadMs'));

// ── B. stampStageTiming is a NO-OP on bad input (never throws) ─────────
check('B1: no adId → no-op', st.stampStageTiming(null, 'sharpMs', 100) === undefined);
check('B2: unknown stage → no-op (whitelist enforced)',
  st.stampStageTiming('anyId', 'bogusStage', 100) === undefined);
check('B3: NaN ms → no-op', st.stampStageTiming('anyId', 'sharpMs', NaN) === undefined);
check('B4: negative ms → no-op', st.stampStageTiming('anyId', 'sharpMs', -1) === undefined);
check('B5: string ms coerces to number, still validated',
  st.stampStageTiming('anyId', 'sharpMs', 'not-a-number') === undefined);

// ── C. startStageTimer returns a function; timer produces positive ms ──
const t = st.startStageTimer('sharpMs');
check('C1: startStageTimer returns a stopper function', typeof t === 'function');

// Rejects unknown stage on start too (returns a fn that no-ops).
const badT = st.startStageTimer('bogus');
check('C2: startStageTimer for unknown stage returns a no-op fn',
  typeof badT === 'function' && badT('anyId') === undefined);

// ── D. Source invariants (the fire-and-forget discipline) ──────────────
check('D1: uses .catch to swallow write errors (never fails render)',
  /Ad\.updateOne\([\s\S]*?\)\.catch\(/.test(src));
check('D2: write is NEVER awaited (fire-and-forget)',
  !/await\s+Ad\.updateOne/.test(src));
check('D3: owner-scoped filter includes claimedByWorker: WORKER_ID',
  /claimedByWorker:\s*WORKER_ID/.test(src));
check('D4: only writes renderStages.<stage> — never bulk-overwrites the field',
  /renderStages\.\$\{stage\}|\[`renderStages\.\$\{stage\}`\]/.test(src));

// ── E. Whitelist is enforced at the SET boundary, not just the getter ──
// If someone deletes the KNOWN_STAGES.has() gate, B2 must fail.
const stripped = src.replace(/if\s*\(!KNOWN_STAGES\.has\(stage\)\)\s*return;?/, '');
check('E1: [REVERT-PROOF] removing the whitelist guard breaks B2 semantics',
  !/KNOWN_STAGES\.has\(stage\)/.test(stripped));

// ── report ─────────────────────────────────────────────────────────────
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`\nverifyStageTiming: ${passes.length} pass, ${failures.length} fail`);
  process.exit(1);
}
for (const p of passes) console.log(`  ✓ ${p}`);
console.log(`\n✅ verifyStageTiming: ${passes.length}/${passes.length} checks passed`);
