'use strict';
// Pins the three render-pipeline timeouts (2026-08-26 investigation):
//   REMOTION_TIMEOUT_MS          — Remotion's internal delayRender() watchdog
//   REMOTION_CHILD_TIMEOUT_MS    — parent wall-clock SIGKILL of the Remotion child
//   BRAND_SCRIPT_CHILD_TIMEOUT_MS — parent wall-clock SIGKILL of the CANVAS child
//
// The investigation's headline finding: these are NOT three nested timeouts
// on one call. The first two nest correctly on the Remotion path (180s
// inside the child's own delayRender bound; 480s around the whole child
// process — see remotionChildSupervisor.js's own header, which already
// documents this well). The third bounds a GENUINELY DIFFERENT child
// process (brandScriptRunner.child.js, the @napi-rs/canvas titling engine)
// that does not call Remotion and is not called BY the Remotion path —
// they are siblings dispatched by resolveTitlingEngine(), not nested. That
// engine is currently kill-switched off in production (always returns
// engine:'remotion'), so BRAND_SCRIPT_CHILD_TIMEOUT_MS cannot fire on the
// money-critical video-master path today. This harness pins BOTH halves of
// that finding so a future change can't quietly reintroduce a real nesting
// (e.g. someone re-enabling the canvas cascade AND routing it through
// renderTitles) without this going red.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const supervisorPath = path.join(REPO, 'src', 'services', 'remotionChildSupervisor.js');
const bseSrc = fs.readFileSync(path.join(REPO, 'src', 'services', 'brandScriptExecutor.js'), 'utf8');
const defaultsEnv = fs.readFileSync(path.join(REPO, 'config', 'defaults.env'), 'utf8');

// ── A. All three are env-tunable ────────────────────────────────────────────
check('A1: RENDER_TIMEOUT_MS reads REMOTION_TIMEOUT_MS from env',
  /RENDER_TIMEOUT_MS\s*=\s*Number\(process\.env\.REMOTION_TIMEOUT_MS/.test(
    fs.readFileSync(supervisorPath, 'utf8')
  ));
check('A2: supervisor CHILD_TIMEOUT_MS reads REMOTION_CHILD_TIMEOUT_MS from env',
  /CHILD_TIMEOUT_MS\s*=\s*Number\(process\.env\.REMOTION_CHILD_TIMEOUT_MS/.test(
    fs.readFileSync(supervisorPath, 'utf8')
  ));
check('A3: brandScriptExecutor CHILD_TIMEOUT_MS reads BRAND_SCRIPT_CHILD_TIMEOUT_MS from env (was hardcoded until 2026-08-26)',
  /CHILD_TIMEOUT_MS\s*=\s*Number\(process\.env\.BRAND_SCRIPT_CHILD_TIMEOUT_MS\)\s*\|\|/.test(bseSrc));

// ── B. Defaults match config/defaults.env, and the Remotion pair orders correctly ──
const { RENDER_TIMEOUT_MS, CHILD_TIMEOUT_MS: SUPERVISOR_CHILD_TIMEOUT_MS } = require(supervisorPath);
check('B1: REMOTION_TIMEOUT_MS default is 180000', RENDER_TIMEOUT_MS === 180000, `got ${RENDER_TIMEOUT_MS}`);
check('B2: REMOTION_CHILD_TIMEOUT_MS default is 480000', SUPERVISOR_CHILD_TIMEOUT_MS === 480000, `got ${SUPERVISOR_CHILD_TIMEOUT_MS}`);
check('B3: REMOTION_TIMEOUT_MS (delayRender watchdog) < REMOTION_CHILD_TIMEOUT_MS (parent SIGKILL) — the inner bound must be tighter than the outer one it nests inside',
  RENDER_TIMEOUT_MS < SUPERVISOR_CHILD_TIMEOUT_MS,
  `${RENDER_TIMEOUT_MS} vs ${SUPERVISOR_CHILD_TIMEOUT_MS}`);
check('B4: config/defaults.env declares REMOTION_TIMEOUT_MS=180000',
  /^REMOTION_TIMEOUT_MS=180000$/m.test(defaultsEnv));
check('B5: config/defaults.env declares REMOTION_CHILD_TIMEOUT_MS=480000',
  /^REMOTION_CHILD_TIMEOUT_MS=480000$/m.test(defaultsEnv));
check('B6: config/defaults.env declares BRAND_SCRIPT_CHILD_TIMEOUT_MS=300000',
  /^BRAND_SCRIPT_CHILD_TIMEOUT_MS=300000$/m.test(defaultsEnv));

// ── C. Structural: the canvas child timeout does NOT wrap the Remotion path ──
// Extract renderWithRemotionAndSave's body and prove it never calls runChild
// (the canvas child spawner) or renderBrandScript (the canvas entry point).
const remotionFnMatch = bseSrc.match(/async function renderWithRemotionAndSave\([^)]*\)\s*\{[\s\S]*?\n\}\n/);
check('C1: renderWithRemotionAndSave() found', !!remotionFnMatch);
if (remotionFnMatch) {
  const body = remotionFnMatch[0];
  check('C2: renderWithRemotionAndSave() never calls runChild() (the canvas child spawner CHILD_TIMEOUT_MS bounds)',
    !/\brunChild\s*\(/.test(body));
  check('C3: renderWithRemotionAndSave() never calls renderBrandScript( (the canvas engine entry point)',
    !/\brenderBrandScript\s*\(/.test(body));
  check('C4: renderWithRemotionAndSave() DOES call renderTitles( (the actual Remotion entry point)',
    /\brenderTitles\s*\(/.test(body));
}

// resolveTitlingEngine's kill-switch: production always dispatches to
// remotion. If this ever flips, BRAND_SCRIPT_CHILD_TIMEOUT_MS's scope
// changes and the "cannot fire on the money path today" framing above (in
// both this harness's header and the source comments it pins) becomes
// stale — this check exists so that flip is loud, not silently true.
const engineFnMatch = bseSrc.match(/function resolveTitlingEngine\([^)]*\)\s*\{[\s\S]*?\n\}\n/);
check('C5: resolveTitlingEngine() found', !!engineFnMatch);
if (engineFnMatch) {
  const body = engineFnMatch[0];
  // The live kill-switch is an unconditional early return of engine:'remotion'
  // BEFORE the (commented-out) cascade that could choose 'canvas'.
  const returnIdx = body.search(/return\s*\{\s*engine:\s*['"]remotion['"]/);
  const commentIdx = body.indexOf('/*');
  check('C6: resolveTitlingEngine() unconditionally returns engine:\'remotion\' BEFORE any commented-out cascade — pins the kill-switch is still live',
    returnIdx !== -1 && (commentIdx === -1 || returnIdx < commentIdx),
    `returnIdx=${returnIdx} commentIdx=${commentIdx}`);
}

// ── D. Revert-proof: hardcoding BRAND_SCRIPT_CHILD_TIMEOUT_MS back breaks A3 ──
const stripped = bseSrc.replace(
  /const CHILD_TIMEOUT_MS = Number\(process\.env\.BRAND_SCRIPT_CHILD_TIMEOUT_MS\) \|\| 5 \* 60 \* 1000;/,
  'const CHILD_TIMEOUT_MS = 5 * 60 * 1000;'
);
check('D1: [REVERT-PROOF] the exact hardcoded-literal mutation is reachable (pattern matches the real source)',
  stripped !== bseSrc);
check('D2: [REVERT-PROOF] after reverting to the hardcoded literal, A3\'s pattern no longer matches',
  !/CHILD_TIMEOUT_MS\s*=\s*Number\(process\.env\.BRAND_SCRIPT_CHILD_TIMEOUT_MS\)\s*\|\|/.test(stripped));

// ── report ───────────────────────────────────────────────────────────────
console.log(`\nverifyTimeoutCoherence: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
for (const p of passes) console.log('  ✓ ' + p);
console.log('\n✅ all three render-pipeline timeouts are env-tunable, correctly ordered where they actually nest, and structurally disjoint where they do not.');
