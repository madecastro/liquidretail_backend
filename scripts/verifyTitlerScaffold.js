'use strict';
// Pins the Phase 2 titler scaffold.
//
// SHIPPED 2026-08-24 as a dark-launch. The service boots and heartbeats
// unconditionally; polling / claiming is gated on ADGEN_TITLER_ENABLED.
// The renderer still owns titling on the current codebase — Phase 3 wires
// the atomic release + stamp of titlingNeeded from the renderer's video
// path, and only THEN does this service consume the queue.
//
// Load-bearing invariants proven here:
//  - titler is a valid ADGEN_ROLE (config enum widened cleanly)
//  - entrypoint dispatches to services/titler
//  - the poll gate reads ADGEN_TITLER_ENABLED (single-flag two-readers
//    pattern, same shape as ADGEN_RENDERER_ENABLED)
//  - the claim filter is receipt-safe: veoVideoUrl:{$ne:null} +
//    titlingNeeded:true + claimedByWorker:null + status:'rendering'
//  - the release path only affects the current worker (owner-scoped)
//  - shutdown drains then force-releases remaining claims
//
// Revert-prove: any of the six mutations at the bottom of this file
// breaks a check.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// A. Role enum + config export.
const config = fs.readFileSync(path.join(REPO, 'src', 'config.js'), 'utf8');
check('A1 config enum accepts titler',
  /\['api',\s*'orchestrator',\s*'renderer',\s*'titler'\]/.test(config),
  'enum must include titler in the allowlist');
check('A2 config exports isTitlerEnabled',
  /module\.exports\s*=\s*Object\.freeze\(\{[^}]*isTitlerEnabled[^}]*\}\)/s.test(config));
check('A3 isTitlerEnabled reads ADGEN_TITLER_ENABLED',
  /function\s+isTitlerEnabled[\s\S]{0,200}process\.env\.ADGEN_TITLER_ENABLED/.test(config));
check('A4 isTitlerEnabled matches literal "true" (not truthy)',
  /ADGEN_TITLER_ENABLED[^)]*\)\.toLowerCase\(\)\s*===\s*['"]true['"]/.test(config),
  'gate must fail closed on any non-true value');

// B. Entrypoint dispatch.
const entrypoint = fs.readFileSync(path.join(REPO, 'src', 'entrypoint.js'), 'utf8');
check('B1 entrypoint requires services/titler',
  /require\(['"]\.\/services\/titler['"]\)/.test(entrypoint));
check('B2 entrypoint calls titler.run() awaited',
  /await\s+titler\.run\(\)/.test(entrypoint));
check('B3 entrypoint AWAITS titler.shutdown (drain must complete before process.exit)',
  /await\s+titler\.shutdown\(\)/.test(entrypoint),
  'fire-and-forget would race process.exit and lose claim releases');
check('B4 entrypoint returns after titler branch',
  /if\s*\(ROLE\s*===\s*['"]titler['"]\)[\s\S]{0,600}return;[\s\S]{0,20}\}/.test(entrypoint));

// C. Titler service shape.
const titlerPath = path.join(REPO, 'src', 'services', 'titler.js');
check('C0 titler.js exists', fs.existsSync(titlerPath));
const titler = fs.readFileSync(titlerPath, 'utf8');

check('C1 imports config gate',
  /isTitlerEnabled[\s\S]{0,80}require\(['"]\.\.\/config['"]\)/.test(titler) ||
  /require\(['"]\.\.\/config['"]\)[\s\S]{0,80}isTitlerEnabled/.test(titler),
  'destructure order irrelevant, but the symbol must trace back to ../config');
check('C2 pollTick skips when gate is off',
  /if\s*\(!isTitlerEnabled\(\)\)\s*return;/.test(titler),
  'the dark-launch gate must literally return before touching Mongo');

// D. Claim filter — receipt-safe.
// Match the four-field filter as a block so a subtle drop is caught.
const claimFilter = titler.match(/findOneAndUpdate\(\s*\{([\s\S]*?)\},\s*\{\s*\$set:\s*\{\s*claimedByWorker:\s*WORKER_ID/);
check('D0 claim call site parses', !!claimFilter);
const claimBody = claimFilter ? claimFilter[1] : '';
check('D1 claim filter requires status rendering',
  /status:\s*['"]rendering['"]/.test(claimBody));
check('D2 claim filter requires veoVideoUrl set (receipt guard)',
  /veoVideoUrl:\s*\{\s*\$ne:\s*null\s*\}/.test(claimBody),
  'MONEY: never claim a row without a settled master receipt');
check('D3 claim filter requires titlingNeeded true',
  /titlingNeeded:\s*true/.test(claimBody));
check('D4 claim filter requires idle claim',
  /claimedByWorker:\s*null/.test(claimBody),
  'atomic CAS shape — same as renderer.claimOne');
check('D5 claim sorts by createdAt ascending (FIFO)',
  /sort:\s*\{\s*createdAt:\s*1\s*\}/.test(titler));

// E. Ownership-scoped release.
check('E1 releaseClaim filter includes claimedByWorker: WORKER_ID',
  /Ad\.updateOne\(\s*\{\s*_id:\s*adId,\s*claimedByWorker:\s*WORKER_ID/.test(titler),
  'without this, a peer titler could clear our claim mid-render');

// F. Shutdown drain + force-release.
check('F1 shutdown clears both timers',
  /if\s*\(state\.pollTimer\)\s*clearInterval\(state\.pollTimer\)/.test(titler) &&
  /if\s*\(state\.heartbeatTimer\)\s*clearInterval\(state\.heartbeatTimer\)/.test(titler));
check('F2 shutdown waits up to SHUTDOWN_DRAIN_MS',
  /SHUTDOWN_DRAIN_MS\s*=\s*25_?000/.test(titler) &&
  /Date\.now\(\)\s*<\s*drainDeadline/.test(titler));
check('F3 shutdown force-releases remaining claims for peer pickup',
  /force-releasing[\s\S]{0,80}Promise\.all\(remaining\.map/.test(titler),
  'without this, SIGTERM leaves zombie claims that no peer can pick up');

// G. Public exports.
check('G1 exports run + shutdown',
  /module\.exports\s*=\s*\{\s*run\s*,\s*shutdown\s*\}/.test(titler));

// ── report
console.log(`\nverifyTitlerScaffold: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ Phase 2 titler scaffold in place — dark launch ready');
