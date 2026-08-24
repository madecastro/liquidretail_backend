#!/usr/bin/env node
'use strict';
//
// verifyMembersAuthz — pins the caller-role gate on routes/members.js +
// routes/invitations.js.
//
// THE BUG (owner-confirmed, no re-litigation needed here): both files were
// mounted in index.js behind requireAuth ONLY. requireAuth proves the caller
// has an ACTIVE membership in SOME Advertiser and populates req.user.role /
// req.membership / req.advertiserId / req.user.isSuperAdmin — but neither
// route file ever READ req.user.role. So any active member of ANY role
// (including 'viewer') could:
//   1. PATCH their own userId to role:'owner' (self-promotion)
//   2. DELETE any other member, including an owner (arbitrary revoke)
//   3. POST an invitation at admin/editor/viewer (uncontrolled invites)
// Chain: an invited viewer escalates to owner, then revokes the real owner.
//
// THE FIX: middleware/requireMembershipRole.js — ONE shared, exported
// guard/helper set (requireMembershipRole() factory + canActOnRole() +
// canGrantRole() + roleRank()), imported by both route files. No per-route
// reimplementation — this repo's own history
// (resolveDeriveFromMaster / receiptFree / isHookFirstVideoPromptEnabled,
// see CLAUDE.md) is that a per-caller copy of a guard is exactly how a
// hole reopens.
//
// THIS HARNESS drives the REAL exported guard and, where feasible, the REAL
// route handlers — extracted directly off each Router's `.stack` (the same
// technique scripts/verifyGenerateProductTenancy.js uses for POST /generate)
// — rather than reimplementing or string-matching the authz logic. Fixtures
// are faithful in-memory stubs of AdvertiserMembership / User, monkey-patched
// onto the real Mongoose model objects for the duration of each check.
//
// Offline: no DB, no network, no API keys.
//   node scripts/verifyMembersAuthz.js
//
// Revert-prove: section E removes one guard at a time from temporary SIBLING
// copies of the real route files (same technique as
// verifyGenerateProductTenancy.js's withMutatedSibling) and asserts the
// specific check that guard protects goes RED.
//
// Import-scan (section D): asserts every file that CALLS
// `requireMembershipRole(` also actually `require()`s it from
// middleware/requireMembershipRole — not just that the call is present as
// text. CLAUDE.md, verbatim: "a source-text regex ... cannot see an unbound
// identifier ... This has now shipped to production three times." Comment
// stripping here is regex-literal-aware (tracks regex-vs-division), not the
// naive quote-tracker that desyncs on a `/regex/` literal elsewhere in a
// scanned file — routes/ads.js and other scanned files are large enough that
// a naive tracker could silently corrupt string-tracking for the rest of the
// file and produce a false-clean scan.

const fs = require('fs');
const os = require('os');
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

// ── regex-literal-aware comment stripper ───────────────────────────────────
// Same contract as the repo's existing stripComments() (see
// scripts/verifyReceiptAwareRequeue.js): strip comments, PRESERVE string
// contents verbatim (so a require('...') path is still readable by a regex
// afterwards) — but additionally track a fourth state, REGEX, that the
// existing helper does not. A naive tracker that only knows ' " ` desyncs
// the moment it walks past a `/regex/` literal containing a quote character
// (or a bare `/` used as division) — everything after is misread as
// inside/outside a string, which can silently swallow a real require(...)
// call later in the same file (this is the exact "naive quote tracker
// desyncs on regex literals" class of bug). `/` starts a regex literal (not
// division) using the standard heuristic: the previous significant token is
// an operator/punctuator/keyword rather than an identifier/number/closing
// bracket.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let quote = null; // ' " ` or 'REGEX'
  let lastSignificant = ''; // last non-whitespace chars actually emitted
  const regexPrecedingKeywords = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  function canStartRegex(preceding) {
    if (preceding === '') return true;
    const lastChar = preceding.slice(-1);
    if (/[\w$)\]]/.test(lastChar) && !regexPrecedingKeywords.test(preceding)) return false;
    return true;
  }
  function noteSignificant(str) {
    lastSignificant += str;
    if (lastSignificant.length > 40) lastSignificant = lastSignificant.slice(-40);
  }
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote === 'REGEX') {
      if (c === '\\') { out += c + (n || ''); noteSignificant(c + (n || '')); i += 2; continue; }
      if (c === '[') { // char class — a bare '/' inside it doesn't end the regex
        out += c; i++;
        while (i < src.length && src[i] !== ']') {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
          out += src[i]; i++;
        }
        if (i < src.length) { out += src[i]; i++; }
        continue;
      }
      if (c === '/') { quote = null; out += c; noteSignificant(c); i++; continue; }
      if (c === '\n') { quote = null; out += '\n'; i++; continue; } // unterminated — bail safely
      out += c; i++; continue;
    }
    if (quote) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === quote) { quote = null; out += c; noteSignificant(c); i++; continue; }
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
      continue;
    }
    if (c === '/' && canStartRegex(lastSignificant)) {
      quote = 'REGEX'; out += c; noteSignificant(c); i++; continue;
    }
    out += c;
    if (!/\s/.test(c)) noteSignificant(c);
    i++;
  }
  return out;
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue;
      out.push(...walkJs(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

console.log('\nverifyMembersAuthz\n');

// ═══════════════════ fixtures ═══════════════════════════════════════════
const oidCounter = { n: 0 };
function oid() {
  oidCounter.n += 1;
  return `68f1${'0'.repeat(15)}${String(oidCounter.n).padStart(5, '0')}`;
}

const ADV = oid();

function makeUserIds() {
  return { owner: oid(), owner2: oid(), admin: oid(), editor: oid(), viewer: oid() };
}

// Faithful in-memory AdvertiserMembership store. Returns real, mutable
// "documents" (plain objects with an attached .save()) so the routes' own
// `target.role = role; await target.save();` pattern behaves as it would
// against a real Mongoose document — mutating in place, no need to
// re-persist through a separate write.
function makeMembershipStore(rows) {
  const docs = rows.map((r) => ({ ...r }));
  docs.forEach((d) => { d.save = async function save() { /* mutation is already in place */ }; });

  function matches(doc, query) {
    return Object.keys(query).every((k) => {
      if (query[k] === undefined) return true;
      return String(doc[k]) === String(query[k]);
    });
  }

  const calls = { findOne: [], countDocuments: [], create: [] };

  function findOneThenable(query) {
    calls.findOne.push(query);
    const found = docs.find((d) => matches(d, query)) || null;
    const p = Promise.resolve(found);
    p.lean = async () => (found ? { ...found, save: undefined } : null);
    return p;
  }

  return {
    docs,
    calls,
    findOne: findOneThenable,
    countDocuments: async (query) => {
      calls.countDocuments.push(query);
      return docs.filter((d) => matches(d, query)).length;
    },
    create: async (doc) => {
      calls.create.push(doc);
      const row = { ...doc, _id: oid(), save: async function save() {} };
      docs.push(row);
      return row;
    }
  };
}

function installMembershipStub(rows) {
  const AdvertiserMembership = require('../models/AdvertiserMembership');
  const store = makeMembershipStore(rows);
  const origFindOne = AdvertiserMembership.findOne;
  const origCount = AdvertiserMembership.countDocuments;
  const origCreate = AdvertiserMembership.create;
  AdvertiserMembership.findOne = store.findOne;
  AdvertiserMembership.countDocuments = store.countDocuments;
  AdvertiserMembership.create = store.create;
  return {
    store,
    restore() {
      AdvertiserMembership.findOne = origFindOne;
      AdvertiserMembership.countDocuments = origCount;
      AdvertiserMembership.create = origCreate;
    }
  };
}

function installUserStub({ existingEmails = [] } = {}) {
  const User = require('../models/User');
  const origFindOne = User.findOne;
  const origFind = User.find;
  User.findOne = (query) => ({
    select() { return this; },
    lean: async () => (existingEmails.includes(query.email) ? { _id: oid() } : null)
  });
  User.find = () => ({
    select() { return this; },
    lean: async () => []
  });
  return {
    restore() {
      User.findOne = origFindOne;
      User.find = origFind;
    }
  };
}

async function withStubs(rows, fn) {
  const membership = installMembershipStub(rows);
  const user = installUserStub({});
  try { return await fn(membership.store); }
  finally { membership.restore(); user.restore(); }
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function reqAs(userId, role, extra = {}) {
  return {
    advertiserId: ADV,
    user: { userId, role, isSuperAdmin: false },
    params: {},
    body: {},
    ...extra
  };
}

// Extract [gate, ..., handler] handles for a given method+path off a
// required Router. Only the first (gate) and last (handler) are driven —
// any middle layer (express.json()) is a body-parser irrelevant to authz;
// callers set req.body directly instead of feeding a real stream through it.
function findLayer(router, methodLower, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods && l.route.methods[methodLower]
  );
  if (!layer) throw new Error(`route ${methodLower.toUpperCase()} ${routePath} not found on router`);
  const handles = layer.route.stack.map((s) => s.handle);
  return { gate: handles[0], handler: handles[handles.length - 1], count: handles.length };
}

// Drives gate then (if the gate did not short-circuit) handler. Mirrors
// Express: a middleware that responds without calling next() stops the
// chain; a middleware that calls next() lets the next layer run.
async function driveChain(gate, handler, req) {
  const res = fakeRes();
  let calledNext = false;
  let nextErr;
  await gate(req, res, (err) => { calledNext = true; nextErr = err; });
  if (nextErr) throw nextErr;
  if (!calledNext) return { res, stoppedAtGate: true };
  // Gate called next() — but it may ALSO have sent a response first in a
  // buggy implementation; treat "response already sent" as authoritative.
  if (res.body !== null) return { res, stoppedAtGate: false, gateAlsoResponded: true };
  await handler(req, res, (err) => { if (err) throw err; });
  return { res, stoppedAtGate: false };
}

// ═══════════════════ A. pure functions ═══════════════════════════════════
console.log('A. roleRank / canActOnRole / canGrantRole — pure functions');

const guardModule = require('../middleware/requireMembershipRole');
const { roleRank, canActOnRole, canGrantRole, ROLE_RANK } = guardModule;

check('A1 module surface', () => {
  assert.strictEqual(typeof guardModule, 'function', 'default export must be the middleware factory');
  assert.strictEqual(typeof roleRank, 'function');
  assert.strictEqual(typeof canActOnRole, 'function');
  assert.strictEqual(typeof canGrantRole, 'function');
  assert.deepStrictEqual(ROLE_RANK, { viewer: 0, editor: 1, admin: 2, owner: 3 });
});

check('A2 roleRank strict order viewer < editor < admin < owner', () => {
  assert.ok(roleRank('viewer') < roleRank('editor'));
  assert.ok(roleRank('editor') < roleRank('admin'));
  assert.ok(roleRank('admin') < roleRank('owner'));
});

check('A3 roleRank fails closed on unknown/missing role', () => {
  assert.strictEqual(roleRank('bogus'), -Infinity);
  assert.strictEqual(roleRank(undefined), -Infinity);
  assert.strictEqual(roleRank(null), -Infinity);
  assert.strictEqual(roleRank(''), -Infinity);
});

check('A4 canActOnRole — same rank is allowed (peer), lower target is allowed, higher target is blocked', () => {
  assert.strictEqual(canActOnRole('admin', 'admin'), true);
  assert.strictEqual(canActOnRole('admin', 'editor'), true);
  assert.strictEqual(canActOnRole('admin', 'viewer'), true);
  assert.strictEqual(canActOnRole('admin', 'owner'), false, 'admin must not act on an owner');
  assert.strictEqual(canActOnRole('owner', 'owner'), true);
  assert.strictEqual(canActOnRole('viewer', 'editor'), false);
});

check('A5 canGrantRole — requested role at or below caller rank is grantable; above is not', () => {
  assert.strictEqual(canGrantRole('owner', 'owner'), true);
  assert.strictEqual(canGrantRole('owner', 'admin'), true);
  assert.strictEqual(canGrantRole('admin', 'admin'), true, 'admin may create a peer admin');
  assert.strictEqual(canGrantRole('admin', 'owner'), false, 'only an owner may grant owner');
  assert.strictEqual(canGrantRole('editor', 'admin'), false);
  assert.strictEqual(canGrantRole('viewer', 'viewer'), true);
});

check('A6 canActOnRole / canGrantRole fail closed on garbage role strings', () => {
  assert.strictEqual(canActOnRole('owner', 'sudo'), true, 'an unrecognised target role ranks below everything, so acting on it is allowed');
  assert.strictEqual(canActOnRole('sudo', 'viewer'), false, 'an unrecognised CALLER role must never outrank a real one');
  assert.strictEqual(canGrantRole('sudo', 'viewer'), false, 'an unrecognised caller role must never be treated as high-ranked enough to grant anything');
});

// ═══════════════════ B. requireMembershipRole() middleware, direct ═══════
console.log('B. requireMembershipRole() middleware — direct unit tests');

function collectMw(mw, req) {
  const res = fakeRes();
  let nextCalled = false;
  const result = mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled, result };
}

check('B1 disallowed role is 403 ROLE_FORBIDDEN, next() never called', () => {
  const mw = guardModule(['owner', 'admin']);
  const { res, nextCalled } = collectMw(mw, reqAs('u1', 'viewer', { params: {} }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, 'ROLE_FORBIDDEN');
});

check('B2 allowed role calls next(), no response sent', () => {
  const mw = guardModule(['owner', 'admin']);
  const { res, nextCalled } = collectMw(mw, reqAs('u1', 'admin', { params: {} }));
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.body, null);
});

check('B3 missing/null role is fail-closed 403 (not a crash)', () => {
  const mw = guardModule(['owner', 'admin']);
  const { res, nextCalled } = collectMw(mw, { user: {}, params: {} });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

check('B4 allowSelfTargetParam bypasses the allowlist ONLY when the param equals the caller\'s own userId', () => {
  const mw = guardModule(['owner', 'admin'], { allowSelfTargetParam: 'userId' });
  const self = collectMw(mw, reqAs('u1', 'viewer', { params: { userId: 'u1' } }));
  assert.strictEqual(self.nextCalled, true, 'self-target must bypass for resign, even as viewer');
  const other = collectMw(mw, reqAs('u1', 'viewer', { params: { userId: 'u2' } }));
  assert.strictEqual(other.nextCalled, false, 'non-self target must still be gated');
  assert.strictEqual(other.res.statusCode, 403);
});

check('B5 without allowSelfTargetParam, a self-targeting viewer is still blocked (PATCH shape)', () => {
  const mw = guardModule(['owner', 'admin']);
  const { nextCalled, res } = collectMw(mw, reqAs('u1', 'viewer', { params: { userId: 'u1' } }));
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

// ═══════════════════ C. real routes, real router.stack ═══════════════════
console.log('C. real route handlers extracted off routes/members.js + routes/invitations.js');

const membersRouter = require('../routes/members.js');
const invitationsRouter = require('../routes/invitations.js');

const patchMembers = findLayer(membersRouter, 'patch', '/:userId');
const deleteMembers = findLayer(membersRouter, 'delete', '/:userId');
const postInvitations = findLayer(invitationsRouter, 'post', '/');
const deleteInvitations = findLayer(invitationsRouter, 'delete', '/:id');
const byTokenAccept = findLayer(invitationsRouter, 'post', '/by-token/:token/accept');

check('C0 route surfaces resolved (4 mutating + 1 by-token) with the expected handle counts', () => {
  assert.strictEqual(patchMembers.count, 3, 'PATCH /:userId = [gate, express.json(), handler]');
  assert.strictEqual(deleteMembers.count, 2, 'DELETE /:userId = [gate, handler]');
  assert.strictEqual(postInvitations.count, 3, 'POST / = [gate, express.json(), handler]');
  assert.strictEqual(deleteInvitations.count, 2, 'DELETE /:id = [gate, handler]');
  assert.strictEqual(byTokenAccept.count, 2, 'by-token/accept = [requireUserOnly, handler]');
});

check('C0b by-token/accept is wired to requireUserOnly (reference identity), NOT requireMembershipRole', () => {
  const requireUserOnly = require('../middleware/requireUserOnly');
  assert.strictEqual(byTokenAccept.gate, requireUserOnly,
    'this PR must not touch the pre-membership accept path');
});

(async () => {
  const U = makeUserIds();
  function baseRows() {
    return [
      { _id: oid(), advertiserId: ADV, userId: U.owner, email: 'owner@x.com', role: 'owner', status: 'active' },
      { _id: oid(), advertiserId: ADV, userId: U.admin, email: 'admin@x.com', role: 'admin', status: 'active' },
      { _id: oid(), advertiserId: ADV, userId: U.editor, email: 'editor@x.com', role: 'editor', status: 'active' },
      { _id: oid(), advertiserId: ADV, userId: U.viewer, email: 'viewer@x.com', role: 'viewer', status: 'active' }
    ];
  }
  function twoOwnerRows() {
    return [
      ...baseRows(),
      { _id: oid(), advertiserId: ADV, userId: U.owner2, email: 'owner2@x.com', role: 'owner', status: 'active' }
    ];
  }

  // ── PATCH /api/members/:userId ──────────────────────────────────────
  await checkAsync('C1 viewer CANNOT PATCH anyone\'s role, including their own -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.viewer, 'viewer', { params: { userId: U.viewer }, body: { role: 'owner' } });
      const { res, stoppedAtGate } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C2 editor CANNOT PATCH anyone\'s role -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.editor, 'editor', { params: { userId: U.viewer }, body: { role: 'admin' } });
      const { res, stoppedAtGate } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C3 admin CAN PATCH the permitted subset (viewer -> editor)', async () => {
    await withStubs(baseRows(), async (store) => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.viewer }, body: { role: 'editor' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.viewer);
      assert.strictEqual(row.role, 'editor');
    });
  });

  await checkAsync('C4 admin CANNOT grant owner to anyone, including self (nobody can raise their own role)', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.admin }, body: { role: 'owner' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.code, 'ROLE_FORBIDDEN');
    });
  });

  await checkAsync('C5 admin CANNOT grant owner to a third party either', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.viewer }, body: { role: 'owner' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C6 admin CANNOT modify an owner\'s role at all (escalation-by-demotion guard)', async () => {
    await withStubs(twoOwnerRows(), async () => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.owner }, body: { role: 'admin' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C7 owner CAN demote another owner (not the last one)', async () => {
    await withStubs(twoOwnerRows(), async (store) => {
      const req = reqAs(U.owner, 'owner', { params: { userId: U.owner2 }, body: { role: 'admin' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.owner2);
      assert.strictEqual(row.role, 'admin');
    });
  });

  await checkAsync('C8 owner self-demote is allowed by role rank but LAST_OWNER guard still blocks it when sole owner', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.owner, 'owner', { params: { userId: U.owner }, body: { role: 'admin' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.code, 'LAST_OWNER');
    });
  });

  await checkAsync('C9 owner self-demote succeeds when a second owner exists (lowering own role IS allowed)', async () => {
    await withStubs(twoOwnerRows(), async (store) => {
      const req = reqAs(U.owner, 'owner', { params: { userId: U.owner }, body: { role: 'admin' } });
      const { res } = await driveChain(patchMembers.gate, patchMembers.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.owner);
      assert.strictEqual(row.role, 'admin');
    });
  });

  // ── DELETE /api/members/:userId ──────────────────────────────────────
  await checkAsync('C10 viewer CANNOT DELETE another member -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.viewer, 'viewer', { params: { userId: U.editor } });
      const { res, stoppedAtGate } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C11 editor CANNOT DELETE another member -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.editor, 'editor', { params: { userId: U.viewer } });
      const { res, stoppedAtGate } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C12 a viewer CAN revoke (resign) their OWN membership — legitimate carve-out preserved', async () => {
    await withStubs(baseRows(), async (store) => {
      const req = reqAs(U.viewer, 'viewer', { params: { userId: U.viewer } });
      const { res, stoppedAtGate } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(stoppedAtGate, false, 'self-target must bypass the gate');
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.viewer);
      assert.strictEqual(row.status, 'revoked');
    });
  });

  await checkAsync('C13 admin CANNOT revoke an owner (escalation-by-deletion)', async () => {
    await withStubs(twoOwnerRows(), async () => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.owner } });
      const { res } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C14 admin CAN revoke an editor (permitted subset)', async () => {
    await withStubs(baseRows(), async (store) => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.editor } });
      const { res } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.editor);
      assert.strictEqual(row.status, 'revoked');
    });
  });

  await checkAsync('C15 owner CAN revoke another owner (not the last one)', async () => {
    await withStubs(twoOwnerRows(), async (store) => {
      const req = reqAs(U.owner, 'owner', { params: { userId: U.owner2 } });
      const { res } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d.userId) === U.owner2);
      assert.strictEqual(row.status, 'revoked');
    });
  });

  await checkAsync('C16 last-owner guard still blocks self-resign when sole owner', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.owner, 'owner', { params: { userId: U.owner } });
      const { res, stoppedAtGate } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      assert.strictEqual(stoppedAtGate, false, 'self-target bypasses the gate; the block is the last-owner guard');
      assert.strictEqual(res.statusCode, 409);
      assert.strictEqual(res.body.code, 'LAST_OWNER');
    });
  });

  await checkAsync('C17 last-owner guard still blocks a THIRD PARTY revoking the sole owner (would be moot — 403 fires first)', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.admin, 'admin', { params: { userId: U.owner } });
      const { res } = await driveChain(deleteMembers.gate, deleteMembers.handler, req);
      // admin can never touch an owner at all, so this is 403 (canActOnRole),
      // not 409 — asserting this pins that the escalation-by-deletion guard
      // is checked, and reached, ahead of the last-owner guard.
      assert.strictEqual(res.statusCode, 403);
    });
  });

  // ── POST /api/invitations ───────────────────────────────────────────
  await checkAsync('C18 viewer CANNOT POST an invitation -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.viewer, 'viewer', { body: { email: 'new@x.com', role: 'viewer' } });
      const { res, stoppedAtGate } = await driveChain(postInvitations.gate, postInvitations.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C19 editor CANNOT POST an invitation -> 403 at the gate', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.editor, 'editor', { body: { email: 'new@x.com', role: 'viewer' } });
      const { res, stoppedAtGate } = await driveChain(postInvitations.gate, postInvitations.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C20 admin CAN invite at admin/editor/viewer (permitted, capped at own rank)', async () => {
    await withStubs(baseRows(), async (store) => {
      const req = reqAs(U.admin, 'admin', { body: { email: 'new-admin@x.com', role: 'admin' } });
      const { res } = await driveChain(postInvitations.gate, postInvitations.handler, req);
      assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.invitation.role, 'admin');
      assert.ok(store.calls.create.length === 1);
    });
  });

  await checkAsync('C21 owner CAN invite at admin/editor/viewer', async () => {
    await withStubs(baseRows(), async () => {
      const req = reqAs(U.owner, 'owner', { body: { email: 'new-viewer@x.com', role: 'viewer' } });
      const { res } = await driveChain(postInvitations.gate, postInvitations.handler, req);
      assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    });
  });

  // ── DELETE /api/invitations/:id ──────────────────────────────────────
  await checkAsync('C22 viewer CANNOT cancel a pending invitation -> 403 at the gate', async () => {
    const invId = oid();
    const rows = [...baseRows(), { _id: invId, advertiserId: ADV, email: 'pending@x.com', role: 'editor', status: 'pending' }];
    await withStubs(rows, async () => {
      const req = reqAs(U.viewer, 'viewer', { params: { id: invId } });
      const { res, stoppedAtGate } = await driveChain(deleteInvitations.gate, deleteInvitations.handler, req);
      assert.strictEqual(stoppedAtGate, true);
      assert.strictEqual(res.statusCode, 403);
    });
  });

  await checkAsync('C23 admin CAN cancel a pending invitation', async () => {
    const invId = oid();
    const rows = [...baseRows(), { _id: invId, advertiserId: ADV, email: 'pending@x.com', role: 'editor', status: 'pending' }];
    await withStubs(rows, async (store) => {
      const req = reqAs(U.admin, 'admin', { params: { id: invId } });
      const { res } = await driveChain(deleteInvitations.gate, deleteInvitations.handler, req);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      const row = store.docs.find((d) => String(d._id) === invId);
      assert.strictEqual(row.status, 'revoked');
    });
  });

  // ── /by-token/:token/accept — must still work with NO membership ────
  await checkAsync('C24 by-token accept still works for a caller with ZERO memberships (pre-membership flow untouched)', async () => {
    const invId = oid();
    const rows = [
      ...baseRows(), // an unrelated, fully-populated Advertiser
      { _id: invId, advertiserId: ADV, email: 'invitee@new.com', role: 'editor', status: 'pending', inviteToken: 'tok-abc', userId: null }
    ];
    await withStubs(rows, async (store) => {
      // The accept handler reads req.userDoc, not req.user/req.membership —
      // requireUserOnly (untouched by this PR) is what populates req.userDoc,
      // and it does NOT require any AdvertiserMembership to exist.
      let savedUserDoc = null;
      const req = {
        params: { token: 'tok-abc' },
        userDoc: {
          _id: 'invitee-user-id',
          email: 'invitee@new.com',
          advertiserId: null,
          save: async function save() { savedUserDoc = { ...this }; }
        }
      };
      const res = fakeRes();
      await byTokenAccept.handler(req, res, (err) => { if (err) throw err; });
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.role, 'editor');
      const row = store.docs.find((d) => String(d._id) === invId);
      assert.strictEqual(row.status, 'active');
      assert.strictEqual(String(row.userId), 'invitee-user-id');
      assert.ok(savedUserDoc, 'User.advertiserId default-fill should have saved the user doc');
    });
  });

  // ═══════════════════ D. import-scan ═══════════════════════════════════
  console.log('D. import-scan — every requireMembershipRole( call site must import it');

  const callSites = [];
  function scanFile(full) {
    if (path.basename(full) === 'requireMembershipRole.js') return; // definition, not a call site
    const raw = fs.readFileSync(full, 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    if (!/\brequireMembershipRole\s*\(/.test(stripped)) return;
    callSites.push({ rel: path.relative(ROOT, full), full, raw, stripped });
  }
  for (const dir of [path.join(ROOT, 'routes'), path.join(ROOT, 'middleware')]) {
    for (const full of walkJs(dir)) scanFile(full);
  }

  check('D0 the scan found at least the two known call sites (members.js, invitations.js)', () => {
    const rels = callSites.map((c) => c.rel);
    assert.ok(rels.includes(path.join('routes', 'members.js')), rels.join(', '));
    assert.ok(rels.includes(path.join('routes', 'invitations.js')), rels.join(', '));
  });

  const unbound = [];
  for (const site of callSites) {
    // require(...) of a path containing 'requireMembershipRole', either
    // `const x = require('../middleware/requireMembershipRole')` (used as
    // x(...) directly) or a destructure that still binds the identifier
    // used at the call site. We only need to prove the MODULE is required
    // somewhere in this file — the call site regex above already proved the
    // identifier `requireMembershipRole` is invoked as a function.
    const importsIt = /require\s*\(\s*['"][^'"]*requireMembershipRole['"]\s*\)/.test(site.stripped);
    if (!importsIt) unbound.push(site.rel);
  }
  check('D1 every file that calls requireMembershipRole( also require()s it from middleware/requireMembershipRole', () => {
    assert.strictEqual(unbound.length, 0, unbound.join(', '));
  });

  check('D2 regex-literal-aware stripper does not desync on a real regex literal containing a quote-like char', () => {
    // Adversarial self-check: a naive ' " ` tracker would flip "inside a
    // string" state forever after the apostrophe inside this regex, and
    // then silently swallow the require(...) call that follows, which
    // would make D1 pass even if the import were missing.
    const sample = "const re = /it's a \"test\"/; const x = require('../middleware/requireMembershipRole');";
    const stripped = stripCommentsAndStrings(sample);
    assert.ok(/require\s*\(\s*['"][^'"]*requireMembershipRole['"]\s*\)/.test(stripped),
      'require(...) call must still be visible after a regex literal containing quote characters');
  });

  check('D3 modules actually resolve at runtime — require(...) is not merely textually present but unbound', () => {
    // Genuine runtime binding proof: routes/members.js and routes/invitations.js
    // already loaded above (section C) without throwing a ReferenceError, and
    // both exported routers were usable. Re-assert the identity explicitly.
    const shared = require('../middleware/requireMembershipRole');
    assert.strictEqual(typeof shared, 'function');
    assert.strictEqual(typeof shared.canActOnRole, 'function');
    assert.strictEqual(typeof shared.canGrantRole, 'function');
  });

  // ═══════════════════ E. revert-prove ═══════════════════════════════════
  console.log('E. revert-prove — mutate temp sibling copies of the real route files');

  const REVERT_ROWS = [];

  async function withMutatedSibling(realAbsPath, mutatedSrc, fn) {
    const dir = path.dirname(realAbsPath);
    const base = path.basename(realAbsPath, '.js');
    const tmpAbsPath = path.join(dir, `.__revertprove_${base}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
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

  const membersAbsPath = path.join(ROOT, 'routes', 'members.js');
  const invitationsAbsPath = path.join(ROOT, 'routes', 'invitations.js');
  const membersSrc = fs.readFileSync(membersAbsPath, 'utf8');
  const invitationsSrc = fs.readFileSync(invitationsAbsPath, 'utf8');

  // M1 — drop the gate off PATCH /:userId. A viewer must now be able to
  // reach the handler and (absent any other check) self-promote.
  // NOTE on scenario choice: removing ONLY the route-level gate does NOT
  // reproduce raw "viewer self-promotes to owner" — canGrantRole inside the
  // handler is a rank check independent of who is allowed to call the route
  // at all, and it still blocks a viewer (rank 0) from requesting owner
  // (rank 3) even with the gate gone. That is a genuine defense-in-depth
  // property of this design, not a flaw in the mutation. What the gate
  // ALONE is responsible for is stopping non-owner/admin callers from
  // reaching PATCH at all, regardless of whether the requested change is
  // rank-respecting — so this mutation instead proves an EDITOR (who must
  // have ZERO PATCH access per the brief) can, once the gate is gone,
  // promote a VIEWER to editor: canActOnRole('editor','viewer') and
  // canGrantRole('editor','editor') both legitimately pass rank-wise, so
  // only the now-missing gate was standing between an editor and this call.
  await checkAsync('E-M1 dropping the gate off PATCH /:userId lets an editor (zero PATCH access) reach the handler (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      "router.patch('/:userId', requireMembershipRole(['owner', 'admin']), express.json(), async (req, res) => {",
      "router.patch('/:userId', express.json(), async (req, res) => {",
      'M1'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        // The gate was the FIRST layer; with it removed, express.json() (a
        // real body-parser expecting a real stream) shifts into that slot,
        // so this drives the terminal handler directly rather than through
        // findLayer's generic first-layer-as-gate assumption — the point of
        // this mutation is the HANDLER's own reachability, not re-testing
        // body-parser wiring.
        const mutatedPatch = findLayer(mutatedRouter, 'patch', '/:userId');
        const req = reqAs(U.editor, 'editor', { params: { userId: U.viewer }, body: { role: 'editor' } });
        const res = fakeRes();
        await mutatedPatch.handler(req, res, (err) => { if (err) throw err; });
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let an editor reach and execute the PATCH handler');
        const row = store.docs.find((d) => String(d.userId) === U.viewer);
        assert.strictEqual(row.role, 'editor', 'expected the editor caller to have successfully promoted the viewer');
        REVERT_ROWS.push('M1 — dropping the PATCH gate reproduced an editor (zero PATCH access) reaching the handler');
      });
    });
  });

  // M2 — drop canActOnRole from the PATCH handler. An admin must now be
  // able to modify an owner's role.
  await checkAsync('E-M2 dropping canActOnRole from the PATCH handler lets admin modify an owner (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      `    if (!canActOnRole(req.user.role, target.role)) {
      return res.status(403).json({
        error: 'cannot modify a member with a higher role than your own',
        code:  'ROLE_FORBIDDEN'
      });
    }
`,
      '',
      'M2'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(twoOwnerRows(), async (store) => {
        const mutatedPatch = findLayer(mutatedRouter, 'patch', '/:userId');
        const req = reqAs(U.admin, 'admin', { params: { userId: U.owner }, body: { role: 'admin' } });
        const { res } = await driveChain(mutatedPatch.gate, mutatedPatch.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let admin demote an owner');
        const row = store.docs.find((d) => String(d.userId) === U.owner);
        assert.strictEqual(row.role, 'admin');
        REVERT_ROWS.push('E-M2 — dropping canActOnRole reproduced admin-demotes-owner');
      });
    });
  });

  // M3 — drop canGrantRole from the PATCH handler. An admin must now be
  // able to self-promote to owner.
  await checkAsync('E-M3 dropping canGrantRole from the PATCH handler lets admin self-promote to owner (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      `    if (!canGrantRole(req.user.role, role)) {
      return res.status(403).json({
        error: \`only a role at or below your own (\${req.user.role}) can be granted\`,
        code:  'ROLE_FORBIDDEN'
      });
    }
`,
      '',
      'M3'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        const mutatedPatch = findLayer(mutatedRouter, 'patch', '/:userId');
        const req = reqAs(U.admin, 'admin', { params: { userId: U.admin }, body: { role: 'owner' } });
        const { res } = await driveChain(mutatedPatch.gate, mutatedPatch.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let admin self-promote to owner');
        const row = store.docs.find((d) => String(d.userId) === U.admin);
        assert.strictEqual(row.role, 'owner');
        REVERT_ROWS.push('E-M3 — dropping canGrantRole reproduced self-promotion');
      });
    });
  });

  // M4 — drop the gate off DELETE /:userId. A viewer must now be able to
  // revoke someone else.
  await checkAsync('E-M4 dropping the gate off DELETE /:userId lets a viewer revoke ANYONE (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      "router.delete('/:userId', requireMembershipRole(['owner', 'admin'], { allowSelfTargetParam: 'userId' }), async (req, res) => {",
      "router.delete('/:userId', async (req, res) => {",
      'M4'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      // A SECOND viewer as the target, not U.editor — this mutation removes
      // only the ROUTE-LEVEL gate. The in-handler canActOnRole check (a
      // SEPARATE guard, its own removal is M5 below) is still present and
      // would correctly 403 a viewer targeting a higher-ranked editor,
      // masking exactly what M4 is supposed to isolate. A same-rank (viewer
      // -> viewer) target passes canActOnRole trivially, so only the
      // now-missing gate stands between the caller and the revoke.
      const viewer2 = oid();
      const rows = [...baseRows(), { _id: oid(), advertiserId: ADV, userId: viewer2, email: 'viewer2@x.com', role: 'viewer', status: 'active' }];
      await withStubs(rows, async (store) => {
        const mutatedDelete = findLayer(mutatedRouter, 'delete', '/:userId');
        const req = reqAs(U.viewer, 'viewer', { params: { userId: viewer2 } });
        const { res } = await driveChain(mutatedDelete.gate, mutatedDelete.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let a viewer revoke another member');
        const row = store.docs.find((d) => String(d.userId) === viewer2);
        assert.strictEqual(row.status, 'revoked');
        REVERT_ROWS.push('E-M4 — dropping the DELETE gate reproduced arbitrary revoke');
      });
    });
  });

  // M5 — drop the non-self canActOnRole check from the DELETE handler.
  // An admin must now be able to revoke an owner.
  await checkAsync('E-M5 dropping canActOnRole from the DELETE handler lets admin revoke an owner (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      `    const isSelf = String(target.userId) === String(req.user.userId);
    if (!isSelf && !canActOnRole(req.user.role, target.role)) {
      return res.status(403).json({
        error: 'cannot revoke a member with a higher role than your own',
        code:  'ROLE_FORBIDDEN'
      });
    }
`,
      '',
      'M5'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(twoOwnerRows(), async (store) => {
        const mutatedDelete = findLayer(mutatedRouter, 'delete', '/:userId');
        const req = reqAs(U.admin, 'admin', { params: { userId: U.owner } });
        const { res } = await driveChain(mutatedDelete.gate, mutatedDelete.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let admin revoke an owner');
        const row = store.docs.find((d) => String(d.userId) === U.owner);
        assert.strictEqual(row.status, 'revoked');
        REVERT_ROWS.push('E-M5 — dropping the DELETE canActOnRole check reproduced escalation-by-deletion');
      });
    });
  });

  // M6 — drop the gate off POST /api/invitations. A viewer must now be
  // able to invite.
  // Same scenario-choice note as E-M1: canGrantRole('viewer','admin') is
  // independently false, so a viewer inviting at 'admin' stays blocked even
  // with the gate gone. Invite at 'viewer' (rank-respecting: 0 <= 0) isolates
  // what the gate alone contributes — a viewer must have ZERO invite access,
  // full stop, regardless of the requested role's rank.
  await checkAsync('E-M6 dropping the gate off POST /api/invitations lets a viewer invite at their own rank (must fail)', async () => {
    const mutated = mutateOrThrow(
      invitationsSrc,
      "router.post('/', requireMembershipRole(['owner', 'admin']), express.json(), async (req, res) => {",
      "router.post('/', express.json(), async (req, res) => {",
      'M6'
    );
    await withMutatedSibling(invitationsAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        // Same reasoning as E-M1: with the gate removed, express.json()
        // shifts into the first-layer slot, so drive the terminal handler
        // directly.
        const mutatedPost = findLayer(mutatedRouter, 'post', '/');
        const req = reqAs(U.viewer, 'viewer', { body: { email: 'evil@x.com', role: 'viewer' } });
        const res = fakeRes();
        await mutatedPost.handler(req, res, (err) => { if (err) throw err; });
        assert.strictEqual(res.statusCode, 201, 'expected the REVERTED code to let a viewer create an invitation');
        assert.strictEqual(store.calls.create.length, 1);
        REVERT_ROWS.push('E-M6 — dropping the invitations POST gate reproduced a viewer (zero invite access) inviting');
      });
    });
  });

  // M7 — drop canGrantRole from POST /api/invitations AND widen VALID_ROLES
  // to include 'owner' in the mutated sibling only, so the check's absence
  // is actually observable. VALID_ROLES already excludes 'owner' in
  // production (structural belt), so this mutation proves canGrantRole is
  // the substantive second belt the brief asks for ("cap the invitable role
  // by the inviter's own role"), not a check that merely looks present.
  await checkAsync('E-M7 dropping canGrantRole (with VALID_ROLES widened) lets admin invite as owner — escalation laundering (must fail)', async () => {
    let mutated = mutateOrThrow(
      invitationsSrc,
      "const VALID_ROLES = ['admin', 'editor', 'viewer'];   // owner can't be invited; only first user gets owner",
      "const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];   // TEST MUTATION — widened to prove canGrantRole is load-bearing",
      'M7a'
    );
    mutated = mutateOrThrow(
      mutated,
      `    if (!canGrantRole(req.user.role, role)) {
      return res.status(403).json({
        error: \`only a role at or below your own (\${req.user.role}) can be invited\`,
        code:  'ROLE_FORBIDDEN'
      });
    }
`,
      '',
      'M7b'
    );
    await withMutatedSibling(invitationsAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        const mutatedPost = findLayer(mutatedRouter, 'post', '/');
        const req = reqAs(U.admin, 'admin', { body: { email: 'laundered-owner@x.com', role: 'owner' } });
        const { res } = await driveChain(mutatedPost.gate, mutatedPost.handler, req);
        assert.strictEqual(res.statusCode, 201, 'expected the REVERTED+widened code to let admin invite at role owner');
        assert.strictEqual(store.calls.create[0].role, 'owner');
        REVERT_ROWS.push('E-M7 — dropping canGrantRole (VALID_ROLES widened) reproduced invite-as-owner laundering');
      });
    });
  });

  // M8 — drop the gate off DELETE /api/invitations/:id. A viewer must now
  // be able to cancel a pending invite.
  await checkAsync('E-M8 dropping the gate off DELETE /api/invitations/:id lets a viewer cancel it (must fail)', async () => {
    const mutated = mutateOrThrow(
      invitationsSrc,
      "router.delete('/:id', requireMembershipRole(['owner', 'admin']), async (req, res) => {",
      "router.delete('/:id', async (req, res) => {",
      'M8'
    );
    await withMutatedSibling(invitationsAbsPath, mutated, async (mutatedRouter) => {
      const invId = oid();
      const rows = [...baseRows(), { _id: invId, advertiserId: ADV, email: 'pending@x.com', role: 'editor', status: 'pending' }];
      await withStubs(rows, async (store) => {
        const mutatedDelete = findLayer(mutatedRouter, 'delete', '/:id');
        const req = reqAs(U.viewer, 'viewer', { params: { id: invId } });
        const { res } = await driveChain(mutatedDelete.gate, mutatedDelete.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let a viewer cancel a pending invitation');
        const row = store.docs.find((d) => String(d._id) === invId);
        assert.strictEqual(row.status, 'revoked');
        REVERT_ROWS.push('E-M8 — dropping the invitations DELETE gate reproduced uncontrolled invite cancellation');
      });
    });
  });

  // M9 — drop the last-owner guard from PATCH. Sole owner self-demote must
  // now succeed instead of 409.
  await checkAsync('E-M9 dropping the PATCH last-owner guard lets the sole owner demote themselves to zero owners (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      `    // Last-owner guard: don't allow demoting the only owner.
    if (target.role === 'owner' && role !== 'owner') {
      const ownerCount = await AdvertiserMembership.countDocuments({
        advertiserId: req.advertiserId,
        status:       'active',
        role:         'owner'
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'cannot demote the only owner — promote someone else first',
          code:  'LAST_OWNER'
        });
      }
    }

`,
      '',
      'M9'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        const mutatedPatch = findLayer(mutatedRouter, 'patch', '/:userId');
        const req = reqAs(U.owner, 'owner', { params: { userId: U.owner }, body: { role: 'admin' } });
        const { res } = await driveChain(mutatedPatch.gate, mutatedPatch.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let the sole owner demote themselves');
        const row = store.docs.find((d) => String(d.userId) === U.owner);
        assert.strictEqual(row.role, 'admin');
        REVERT_ROWS.push('E-M9 — dropping the PATCH last-owner guard left an Advertiser with zero owners');
      });
    });
  });

  // M10 — drop the last-owner guard from DELETE. Sole owner self-resign
  // must now succeed instead of 409.
  await checkAsync('E-M10 dropping the DELETE last-owner guard lets the sole owner resign, leaving zero owners (must fail)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      `    if (target.role === 'owner') {
      const ownerCount = await AdvertiserMembership.countDocuments({
        advertiserId: req.advertiserId,
        status:       'active',
        role:         'owner'
      });
      if (ownerCount <= 1) {
        return res.status(409).json({
          error: 'cannot remove the only owner — promote someone else to owner first',
          code:  'LAST_OWNER'
        });
      }
    }

`,
      '',
      'M10'
    );
    await withMutatedSibling(membersAbsPath, mutated, async (mutatedRouter) => {
      await withStubs(baseRows(), async (store) => {
        const mutatedDelete = findLayer(mutatedRouter, 'delete', '/:userId');
        const req = reqAs(U.owner, 'owner', { params: { userId: U.owner } });
        const { res } = await driveChain(mutatedDelete.gate, mutatedDelete.handler, req);
        assert.strictEqual(res.statusCode, 200, 'expected the REVERTED code to let the sole owner resign');
        const row = store.docs.find((d) => String(d.userId) === U.owner);
        assert.strictEqual(row.status, 'revoked');
        REVERT_ROWS.push('E-M10 — dropping the DELETE last-owner guard left an Advertiser with zero owners');
      });
    });
  });

  // M11 — the exact failure class CLAUDE.md calls out by name: a call site
  // that survives with its IMPORT removed. "A regex over source text cannot
  // see an unbound identifier, and node --check cannot either — a
  // ReferenceError is runtime, not syntax." This repo has shipped that
  // exact defect to production three times (receiptFree, preferUgcMediaId,
  // usableProofCommentsOrNone). D1 above only proves the CURRENT file still
  // has the import; this proves that if it did not, module load itself
  // would crash loudly (router.patch(...) evaluates requireMembershipRole(...)
  // synchronously at require time) — i.e. the failure mode is real and
  // observable, not something only a text scanner could miss silently.
  await checkAsync('E-M11 dropping the import (keeping the calls) crashes at require-time with a ReferenceError (must fail == must throw)', async () => {
    const mutated = mutateOrThrow(
      membersSrc,
      "const requireMembershipRole = require('../middleware/requireMembershipRole');\nconst { canActOnRole, canGrantRole } = requireMembershipRole;\n",
      '',
      'M11'
    );
    let threw = null;
    try {
      await withMutatedSibling(membersAbsPath, mutated, async () => {
        // requiring the sibling alone is enough — router.patch(...) calls
        // requireMembershipRole(...) synchronously while the module body runs.
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'expected requiring the import-stripped sibling to throw');
    assert.ok(threw instanceof ReferenceError, `expected a ReferenceError, got ${threw && threw.constructor && threw.constructor.name}: ${threw && threw.message}`);
    assert.match(threw.message, /requireMembershipRole is not defined/);
    REVERT_ROWS.push('E-M11 — dropping the import (keeping the calls) reproduced the exact "shipped to prod three times" unbound-identifier class');
  });

  check('E table recorded all 11 revert-prove mutations, each reproducing its bug', () => {
    assert.strictEqual(REVERT_ROWS.length, 11, `only ${REVERT_ROWS.length} of 11 recorded: ${REVERT_ROWS.join(' | ')}`);
  });

  // ── report ──────────────────────────────────────────────────────────────
  console.log('\nrevert-prove table');
  for (const row of REVERT_ROWS) console.log(`  ✓ ${row}`);
  console.log(`\nharness loaded https-proxy-agent via: ${PROXY_MODE}`);
  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyMembersAuthz: ${failures.length} of ${total} checks FAILED`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyMembersAuthz: ${total}/${total} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error('verifyMembersAuthz: harness crashed', err && err.stack || err);
  process.exit(1);
});
