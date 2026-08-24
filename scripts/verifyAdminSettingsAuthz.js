#!/usr/bin/env node
'use strict';
//
// verifyAdminSettingsAuthz — pins the super-admin gate on /api/admin
// and the strict tri-state body contract on PATCH /api/admin/qc-config.
//
// THE SURFACE. /api/admin is platform-wide (not tenant-scoped). Auth is
// requireUserOnly then requireSuperAdmin, mounted at the ROUTER level so
// a future added route cannot forget the gate. requireSuperAdmin re-reads
// isSuperAdmin off req.userDoc (the User document requireUserOnly already
// loaded from Mongo) — never a JWT claim, never req.user.role, never a
// tenant-shaped field.
//
// THE BODY CONTRACT. PATCH {staticEnabled?, videoEnabled?} rejects anything
// that is not strictly true | false | null, INCLUDING the strings "true"
// and "false". A truthy string coercing into an enable is exactly the
// class of bug that must not happen on a billable QC gate.
//
// Offline: no DB, no network, no API keys.
//   node scripts/verifyAdminSettingsAuthz.js
//
// Revert-prove: section D removes the requireSuperAdmin mount from a
// temporary SIBLING copy of routes/admin.js (same technique as
// scripts/verifyMembersAuthz.js's withMutatedSibling) and asserts the
// mutated router no longer carries that middleware — i.e. the stack pin
// that normally PASSES would go red if the mount were dropped.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ── https-proxy-agent worktree gotcha (CLAUDE.md §4) ──────────────────────
function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through to a stub */ }
  const orig = Module._load;
  Module._load = function loadStub(request, parent, isMain) {
    if (request === 'https-proxy-agent') {
      return { HttpsProxyAgent: function HttpsProxyAgent() { return {}; } };
    }
    return orig.apply(this, arguments);
  };
  return 'stub';
}
const PROXY_MODE = ensureHttpsProxyAgent();

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 300)}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${(err && err.message || String(err)).split('\n')[0].slice(0, 300)}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Strip comments, keep string contents (so a require('...') path and a
// forbidden identifier used as CODE are still visible). A header comment
// documenting the forbidden pattern is allowed; a handler that reads it
// is not. Naive — these files are small and do not embed comments in
// regex literals.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function walkJs(dirAbs) {
  if (!fs.existsSync(dirAbs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkJs(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function drive(mw, req) {
  const res = fakeRes();
  let nextCalled = false;
  let nextErr;
  await mw(req, res, (err) => { nextCalled = true; nextErr = err; });
  if (nextErr) throw nextErr;
  return { res, nextCalled };
}

function findLayer(router, methodLower, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods && l.route.methods[methodLower]
  );
  if (!layer) throw new Error(`route ${methodLower.toUpperCase()} ${routePath} not found on router`);
  const handles = layer.route.stack.map((s) => s.handle);
  return { gate: handles[0], handler: handles[handles.length - 1], count: handles.length, handles };
}

function routerLevelHandles(router) {
  return router.stack.filter((l) => !l.route).map((l) => l.handle);
}

console.log('\nverifyAdminSettingsAuthz\n');

const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireUserOnly   = require('../middleware/requireUserOnly');

// ═══════════════════ A. requireSuperAdmin, direct ═══════════════════════
console.log('A. requireSuperAdmin — 403 / allow');

check('A1 default export is the middleware function', () => {
  assert.strictEqual(typeof requireSuperAdmin, 'function');
});

check('A2 non-super-admin userDoc is 403 NOT_SUPER_ADMIN, next() never called', () => {
  const req = { userDoc: { email: 'viewer@x.com', isSuperAdmin: false } };
  const res = fakeRes();
  let nextCalled = false;
  requireSuperAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body && res.body.code, 'NOT_SUPER_ADMIN');
  assert.strictEqual(nextCalled, false);
});

check('A3 missing userDoc is 403 (fail closed), next() never called', () => {
  const req = {};
  const res = fakeRes();
  let nextCalled = false;
  requireSuperAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body && res.body.code, 'NOT_SUPER_ADMIN');
  assert.strictEqual(nextCalled, false);
});

check('A4 userDoc.isSuperAdmin === true is allowed through', () => {
  const req = { userDoc: { email: 'nick@x.com', isSuperAdmin: true } };
  const res = fakeRes();
  let nextCalled = false;
  requireSuperAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'expected next()');
  assert.strictEqual(res.body, null, 'must not respond on the allow path');
  assert.strictEqual(res.statusCode, 200);
});

check('A5 string "true" on the User doc is NOT a grant (strict === true)', () => {
  const req = { userDoc: { email: 'spoof@x.com', isSuperAdmin: 'true' } };
  const res = fakeRes();
  let nextCalled = false;
  requireSuperAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
});

check('A6 JWT-shaped req.user.isSuperAdmin=true does not grant when userDoc is false', () => {
  const req = {
    user:    { isSuperAdmin: true, role: 'owner' },
    userDoc: { email: 'not-admin@x.com', isSuperAdmin: false }
  };
  const res = fakeRes();
  let nextCalled = false;
  requireSuperAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
});

// ═══════════════════ B. source pins ═════════════════════════════════════
console.log('B. source pins — JWT claims absent, no tenant-scoped reads');

const superAdminSrc = read('middleware/requireSuperAdmin.js');
const superAdminCode = stripComments(superAdminSrc);

check('B1 requireSuperAdmin source contains neither payload.isSuperAdmin nor decoded.isSuperAdmin', () => {
  assert.ok(!superAdminSrc.includes('payload.isSuperAdmin'), 'payload.isSuperAdmin present');
  assert.ok(!superAdminSrc.includes('decoded.isSuperAdmin'), 'decoded.isSuperAdmin present');
});

check('B2 requireSuperAdmin does not read req.user.role or req.user.isSuperAdmin', () => {
  assert.ok(!superAdminCode.includes('req.user.role'), 'req.user.role present in code');
  assert.ok(!superAdminCode.includes('req.user.isSuperAdmin'), 'req.user.isSuperAdmin present in code');
});

check('B3 requireSuperAdmin DOES read req.userDoc.isSuperAdmin (the fresh Mongo doc)', () => {
  assert.ok(superAdminCode.includes('req.userDoc.isSuperAdmin'), 'missing the DB-doc read');
  assert.ok(superAdminCode.includes('!== true') || superAdminCode.includes('=== true'),
    'must compare strictly against true');
});

const adminFiles = [
  path.join(ROOT, 'routes', 'admin.js'),
  ...walkJs(path.join(ROOT, 'routes', 'admin'))
];

check('B4 no admin route file contains req.advertiserId or tenantFilter (comments stripped)', () => {
  assert.ok(adminFiles.length >= 1, 'expected routes/admin.js to exist');
  for (const abs of adminFiles) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    assert.ok(!code.includes('req.advertiserId'),
      `${path.relative(ROOT, abs)} contains req.advertiserId`);
    assert.ok(!code.includes('tenantFilter'),
      `${path.relative(ROOT, abs)} contains tenantFilter`);
  }
});

check('B5 routes/admin.js mounts requireUserOnly then requireSuperAdmin at router-level (not per-route)', () => {
  const src = read('routes/admin.js');
  const useUser = src.indexOf('router.use(requireUserOnly)');
  const useSuper = src.indexOf('router.use(requireSuperAdmin)');
  assert.ok(useUser >= 0, 'missing router.use(requireUserOnly)');
  assert.ok(useSuper >= 0, 'missing router.use(requireSuperAdmin)');
  assert.ok(useSuper > useUser, 'requireSuperAdmin must mount AFTER requireUserOnly');
  // Per-route mounting of the super-admin gate would look like
  // router.get('/qc-config', requireSuperAdmin, ...) — forbidden; the
  // whole point of router.use is that a future route cannot forget it.
  const perRoute = /router\.(get|patch|post|put|delete)\([^)]*requireSuperAdmin/.test(src);
  assert.strictEqual(perRoute, false, 'requireSuperAdmin must not be per-route');
});

check('B6 index.js mounts /api/admin WITHOUT requireAuth', () => {
  const src = read('index.js');
  assert.ok(
    /app\.use\(\s*['"]\/api\/admin['"]\s*,\s*require\(\s*['"]\.\/routes\/admin['"]\s*\)\s*\)/.test(src),
    'expected app.use(\'/api/admin\', require(\'./routes/admin\'))'
  );
  assert.ok(
    !/app\.use\(\s*['"]\/api\/admin['"]\s*,\s*requireAuth/.test(src),
    '/api/admin must not sit behind requireAuth'
  );
});

// ═══════════════════ C. PATCH body contract (real handler) ═══════════════
console.log('C. PATCH /qc-config body contract — real handler, stubbed writers');

const systemConfig = require('../services/systemConfigService');
const adVisionQc   = require('../services/adVisionQcService');
const adminRouter  = require('../routes/admin');

check('C0 router-level stack is [requireUserOnly, requireSuperAdmin] by identity', () => {
  const handles = routerLevelHandles(adminRouter);
  assert.ok(handles.length >= 2, `expected ≥2 router-level layers, got ${handles.length}`);
  assert.strictEqual(handles[0], requireUserOnly, 'first router.use must be requireUserOnly');
  assert.strictEqual(handles[1], requireSuperAdmin, 'second router.use must be requireSuperAdmin');
});

const patchLayer = findLayer(adminRouter, 'patch', '/qc-config');
const getLayer   = findLayer(adminRouter, 'get', '/qc-config');

check('C0b GET and PATCH /qc-config exist', () => {
  assert.strictEqual(typeof patchLayer.handler, 'function');
  assert.strictEqual(typeof getLayer.handler, 'function');
});

(async () => {

function installQcStubs({ settingStatic = null, settingVideo = null, effectiveStatic = false, effectiveVideo = false } = {}) {
  const orig = {
    getStatic: systemConfig.getStaticVisionQcEnabled,
    getVideo:  systemConfig.getVideoVisionQcEnabled,
    setStatic: systemConfig.setStaticVisionQcEnabled,
    setVideo:  systemConfig.setVideoVisionQcEnabled,
    resolveStatic: adVisionQc.resolveStaticEnabled,
    resolveVideo:  adVisionQc.resolveVideoEnabled
  };
  const calls = { setStatic: [], setVideo: [] };
  let staticSetting = settingStatic;
  let videoSetting  = settingVideo;
  systemConfig.getStaticVisionQcEnabled = async () => staticSetting;
  systemConfig.getVideoVisionQcEnabled  = async () => videoSetting;
  systemConfig.setStaticVisionQcEnabled = async (value, updatedBy) => {
    calls.setStatic.push({ value, updatedBy });
    staticSetting = value;
    return { staticVisionQcEnabled: value };
  };
  systemConfig.setVideoVisionQcEnabled = async (value, updatedBy) => {
    calls.setVideo.push({ value, updatedBy });
    videoSetting = value;
    return { videoVisionQcEnabled: value };
  };
  adVisionQc.resolveStaticEnabled = async () => effectiveStatic;
  adVisionQc.resolveVideoEnabled  = async () => effectiveVideo;
  return {
    calls,
    restore() {
      systemConfig.getStaticVisionQcEnabled = orig.getStatic;
      systemConfig.getVideoVisionQcEnabled  = orig.getVideo;
      systemConfig.setStaticVisionQcEnabled = orig.setStatic;
      systemConfig.setVideoVisionQcEnabled  = orig.setVideo;
      adVisionQc.resolveStaticEnabled = orig.resolveStatic;
      adVisionQc.resolveVideoEnabled  = orig.resolveVideo;
    }
  };
}

function patchReq(body) {
  return {
    body,
    userDoc: { email: 'nick@x.com', isSuperAdmin: true }
  };
}

await checkAsync('C1 PATCH staticEnabled:"false" is 400 and does not call the setter', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ staticEnabled: 'false' }));
    assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode} body=${JSON.stringify(res.body)}`);
    assert.strictEqual(stub.calls.setStatic.length, 0, 'setter must not run on a string value');
    assert.strictEqual(stub.calls.setVideo.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C2 PATCH staticEnabled:"true" is 400 and does not call the setter', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ staticEnabled: 'true' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(stub.calls.setStatic.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C3 PATCH videoEnabled:"false" is 400 and does not call the setter', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ videoEnabled: 'false' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(stub.calls.setVideo.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C4 PATCH videoEnabled:"true" is 400 and does not call the setter', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ videoEnabled: 'true' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(stub.calls.setVideo.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C5 PATCH with neither key is 400 and does not call either setter', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({}));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(stub.calls.setStatic.length, 0);
    assert.strictEqual(stub.calls.setVideo.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C5b PATCH with unrelated keys only is 400 (not a silent no-op write)', async () => {
  const stub = installQcStubs();
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ enabled: true }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(stub.calls.setStatic.length, 0);
    assert.strictEqual(stub.calls.setVideo.length, 0);
  } finally { stub.restore(); }
});

await checkAsync('C6 positive control — PATCH staticEnabled:true (boolean) reaches the setter with updatedBy=email', async () => {
  const stub = installQcStubs({ settingStatic: null, effectiveStatic: true });
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ staticEnabled: true }));
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode} body=${JSON.stringify(res.body)}`);
    assert.strictEqual(stub.calls.setStatic.length, 1, 'static setter must run once');
    assert.strictEqual(stub.calls.setStatic[0].value, true);
    assert.strictEqual(stub.calls.setStatic[0].updatedBy, 'nick@x.com');
    assert.strictEqual(stub.calls.setVideo.length, 0, 'video setter must not run when its key is absent');
    assert.ok(res.body && res.body.static, 'response must be GET-shaped');
    assert.strictEqual(res.body.static.setting, true);
  } finally { stub.restore(); }
});

await checkAsync('C7 PATCH staticEnabled:null is accepted (tri-state clear) and forwarded as null, not coerced', async () => {
  const stub = installQcStubs({ settingStatic: true });
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ staticEnabled: null }));
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}`);
    assert.strictEqual(stub.calls.setStatic.length, 1);
    assert.strictEqual(stub.calls.setStatic[0].value, null);
  } finally { stub.restore(); }
});

await checkAsync('C8 PATCH staticEnabled:false (boolean) is accepted — distinct from the string "false" 400', async () => {
  const stub = installQcStubs({ settingStatic: true, effectiveStatic: false });
  try {
    const { res } = await drive(patchLayer.handler, patchReq({ staticEnabled: false }));
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}`);
    assert.strictEqual(stub.calls.setStatic[0].value, false);
  } finally { stub.restore(); }
});

// ═══════════════════ D. revert-prove ═════════════════════════════════════
console.log('D. revert-prove — drop requireSuperAdmin from a sibling copy of routes/admin.js');

async function withMutatedSibling(realAbsPath, mutatedSrc, fn) {
  const dir = path.dirname(realAbsPath);
  const base = path.basename(realAbsPath, '.js');
  const tmpAbsPath = path.join(
    dir,
    `.__revertprove_${base}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(tmpAbsPath, mutatedSrc);
  try {
    delete require.cache[tmpAbsPath];
    const mod = require(tmpAbsPath);
    return await fn(mod, tmpAbsPath);
  } finally {
    try { fs.unlinkSync(tmpAbsPath); } catch { /* best effort */ }
    delete require.cache[tmpAbsPath];
  }
}

function mutateOrThrow(src, from, to, label) {
  const mutated = src.replace(from, to);
  if (mutated === src) throw new Error(`revert-prove mutation ${label} was a no-op — pattern missed the real source`);
  return mutated;
}

const adminAbsPath = path.join(ROOT, 'routes', 'admin.js');
const adminSrc = fs.readFileSync(adminAbsPath, 'utf8');

await checkAsync('D1 dropping router.use(requireSuperAdmin) removes it from the stack (the mount pin would go red)', async () => {
  const mutated = mutateOrThrow(
    adminSrc,
    'router.use(requireSuperAdmin);',
    '',
    'D1'
  );
  await withMutatedSibling(adminAbsPath, mutated, async (mutatedRouter) => {
    const handles = routerLevelHandles(mutatedRouter);
    assert.ok(
      !handles.includes(requireSuperAdmin),
      'expected the reverted router to lack requireSuperAdmin — if this assertion fails, the mount pin is not actually looking at the stack'
    );
    assert.ok(
      handles.includes(requireUserOnly),
      'requireUserOnly must still be present so the mutation isolated the super-admin gate'
    );
    // Behavioural: a non-super-admin driving the remaining router-level
    // chain no longer hits a 403 from requireSuperAdmin, because it is
    // gone. We skip requireUserOnly (it wants a JWT) and assert the
    // remaining router-level layers do not 403 a non-admin userDoc.
    const remaining = handles.filter((h) => h !== requireUserOnly);
    const req = { userDoc: { email: 'viewer@x.com', isSuperAdmin: false } };
    const res = fakeRes();
    let nextCalled = true;
    for (const mw of remaining) {
      nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      if (!nextCalled) break;
    }
    assert.notStrictEqual(res.statusCode, 403,
      'without requireSuperAdmin, remaining router-level middleware must not 403 a non-admin — that was the gate\'s job');
  });
});

await checkAsync('D2 the REAL router still has requireSuperAdmin after the sibling was restored', async () => {
  const handles = routerLevelHandles(adminRouter);
  assert.ok(handles.includes(requireSuperAdmin), 'live router lost requireSuperAdmin');
  assert.strictEqual(handles[1], requireSuperAdmin);
});

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`\nharness loaded https-proxy-agent via: ${PROXY_MODE}`);
  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyAdminSettingsAuthz: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyAdminSettingsAuthz: ${total}/${total} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error('verifyAdminSettingsAuthz: harness crashed', err && err.stack || err);
  process.exit(1);
});
