// Offline verifier for the home-page-agent registry + endpoint.
//
// No network, no DB. Loads the registry, exercises the executor
// contract with a mock req, and asserts structural invariants. If this
// fails, the agent should not deploy.
//
// Usage: node scripts/verifyAgentRegistry.js
// Exit 0 = clean, exit 1 = failure. Prints one line per assertion.

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;

function ok(label)              { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail)    { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }

function assert(cond, label, detail) {
  cond ? ok(label) : fail(label, detail);
}

// ── 1. node --check on every file we ship ─────────────────────────
console.log('\n[1] Syntax check');
const FILES = [
  'services/capabilityRegistry.js',
  'services/agentTools.js',
  'services/capabilityExecutors/catalogListProducts.js',
  'services/capabilityExecutors/adInspect.js',
  'services/capabilityExecutors/spendToday.js',
  'routes/agent.js'
];
for (const rel of FILES) {
  const abs = path.join(__dirname, '..', rel);
  try {
    execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    ok(`syntax ok: ${rel}`);
  } catch (err) {
    fail(`syntax error: ${rel}`, err.stderr?.toString().slice(0, 200));
  }
}

// ── 2. Registry loads + validates ─────────────────────────────────
console.log('\n[2] Registry structural checks');
const registry = require('../services/capabilityRegistry');
const problems = registry.validateManifest();
assert(problems.length === 0, `validateManifest() clean`, problems.join(' / '));
assert(Array.isArray(registry.CAPABILITIES) && registry.CAPABILITIES.length > 0,
  `CAPABILITIES non-empty (found ${registry.CAPABILITIES.length})`);

// Every capability id is unique.
const ids = registry.CAPABILITIES.map((c) => c.id);
assert(new Set(ids).size === ids.length, `capability ids unique`);

// Every execute path resolves to a real file.
for (const c of registry.CAPABILITIES) {
  if (c.execute?.kind !== 'service') continue;
  const rel = c.execute.service;
  try {
    // require handles resolution incl. ./
    require(rel.startsWith('.') ? path.join(__dirname, '..', 'services', rel) : rel);
    ok(`executor loads: ${c.id} → ${rel}`);
  } catch (err) {
    fail(`executor missing: ${c.id} → ${rel}`, err.message);
  }
}

// ── 3. Tool schemas convert cleanly ───────────────────────────────
console.log('\n[3] Tool schema conversion');
const tools = registry.capabilitiesToTools();
assert(tools.length === registry.CAPABILITIES.length, `one tool per capability`);
for (const t of tools) {
  assert(t.type === 'function', `${t.function?.name}: type=function`);
  assert(/^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name),
    `${t.function.name}: name matches OpenAI regex`);
  assert(typeof t.function.description === 'string' && t.function.description.length > 20,
    `${t.function.name}: describe non-trivial`);
  assert(t.function.parameters?.type === 'object',
    `${t.function.name}: parameters.type=object`);
}

// ── 4. Round-trip: toolName → capability ──────────────────────────
console.log('\n[4] Tool name round-trip');
for (const c of registry.CAPABILITIES) {
  const mangled = c.id.replace(/\./g, '__');
  const back = registry.capabilityByToolName(mangled);
  assert(back && back.id === c.id, `${c.id} ↔ ${mangled}`);
}

// ── 5. Executor contract: rejects a missing advertiser scope ──────
console.log('\n[5] Executor contract — tenant-scope enforcement');
async function checkTenantGuard() {
  const noScopeReq = { /* no advertiserId */ };
  for (const c of registry.CAPABILITIES) {
    const executor = require(path.join(__dirname, '..', 'services', c.execute.service));
    const result = await executor.run({ req: noScopeReq, args: {} });
    assert(result && result.ok === false && /advertiser scope/i.test(result.error || ''),
      `${c.id}: rejects missing advertiser scope`, result?.error);
  }
}

// ── 6. Env & flag sanity ──────────────────────────────────────────
console.log('\n[6] Env / flag / mount readiness');
const defaultsPath = path.join(__dirname, '..', 'config', 'defaults.env');
assert(fs.existsSync(defaultsPath), `config/defaults.env exists`);
const defaultsRaw = fs.existsSync(defaultsPath) ? fs.readFileSync(defaultsPath, 'utf8') : '';
assert(/AGENT_ENABLED\s*=/.test(defaultsRaw), `AGENT_ENABLED declared in defaults.env`);
assert(/AGENT_MODEL\s*=/.test(defaultsRaw), `AGENT_MODEL declared in defaults.env`);
assert(/agentRoutes|routes\/agent/.test(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')),
  `index.js mounts the agent router`);

// ── Final ─────────────────────────────────────────────────────────
(async () => {
  await checkTenantGuard();
  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
