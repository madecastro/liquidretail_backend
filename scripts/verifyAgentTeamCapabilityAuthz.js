#!/usr/bin/env node
'use strict';
//
// verifyAgentTeamCapabilityAuthz — pins the caller-role gate on the four
// team.* CAPABILITY EXECUTORS reachable through POST /api/agent/chat.
//
// THE BUG (independently confirmed, no re-litigation needed here):
// scripts/verifyMembersAuthz.js pins the caller-role gate on
// routes/members.js + routes/invitations.js. That gate was reachable-AROUND.
// index.js mounts `app.use('/api/agent', requireAuth, agentRoutes)` — no role
// middleware. POST /api/agent/chat dispatches capability tool-calls to
// executors in services/capabilityExecutors/, and four of them
// (teamMemberPatch, teamMemberDelete, teamInviteCreate, teamInviteDelete)
// each declare "Mirrors <the HTTP route>" in their header while mirroring the
// route's BEHAVIOUR and omitting its AUTHORIZATION. Net effect: a `viewer`
// could dispatch team__member__patch with {userId: <self>, role: 'owner'} and
// self-promote, completely defeating the members.js fix.
//
// Why the agent path really is caller-reachable, not LLM-only:
//   - routes/agent.js:523 builds `working` from req.body.messages verbatim,
//   - :531-538 runs replayConfirmations BEFORE any LLM call whenever the body
//     carries `confirmations: [...]`,
//   - :314-327 replays any client-supplied assistant tool_call whose id is in
//     that array and which has a matching role:'tool' stub — also entirely
//     client-supplied.
// So the tool-call history is caller-authored. The tier / explicitConfirmation
// phrase system is NOT a mitigation: the phrase is read from the request body
// (`explicitConfirmations[callId]`, :245-249) and compared only against the
// capability manifest, never against the caller's role. team.member.patch is
// tier 1 and declares no phrase at all.
//
// THE FIX: services/capabilityExecutors/_teamAuthzCommon.js — ONE adapter
// that imports canActOnRole/canGrantRole from middleware/requireMembershipRole
// (the SAME helpers the routes use — no third copy of the rank table) and
// exposes them in the executor result contract. The four executors import it.
//
// THIS HARNESS drives the REAL exported executor run() functions with real
// inputs against faithful in-memory AdvertiserMembership / User stubs — it
// does not reimplement or string-match the authz logic. Section A
// additionally IMPORT-scans, because a source-text check alone passes against
// a reimplementation that merely keeps the function name, and because
// `npx eslint .` enables no-undef precisely for the unbound-identifier case a
// text scan cannot see.
//
// Offline: no DB, no network, no API keys.
//   node scripts/verifyAgentTeamCapabilityAuthz.js
//
// Revert-prove (section E): removes ONE guard at a time from temporary
// SIBLING copies of the real executor files (same technique as
// verifyMembersAuthz.js / verifyGenerateProductTenancy.js) and asserts the
// specific escalation that guard blocks becomes POSSIBLE again. A mutation
// that turns out to be a no-op is itself a failure — mutateOrThrow enforces
// that the pattern actually matched real source.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const EXEC_DIR = path.join(ROOT, 'services', 'capabilityExecutors');

// ── https-proxy-agent worktree gotcha (CLAUDE.md §4) ──────────────────────
function ensureHttpsProxyAgent() {
  try {
    require.resolve('https-proxy-agent');
    return 'present';
  } catch { /* fall through to a stub */ }
  const orig = Module._load;
  Module._load = function loadStub(request) {
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
async function checkAsync(label, fn) {
  try {
    await fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${((err && err.message) || String(err)).split('\n')[0].slice(0, 300)}`);
  }
}
function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${((err && err.message) || String(err)).split('\n')[0].slice(0, 300)}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────
let oidSeq = 0;
function oid() {
  oidSeq += 1;
  return (100000000000000000000000 + oidSeq).toString().padStart(24, '0').slice(0, 24);
}

const ADV      = '64b0000000000000000000ad';
const OTHERADV = '64b0000000000000000000be';
const U_OWNER  = '64b000000000000000000001';
const U_OWNER2 = '64b000000000000000000002';
const U_ADMIN  = '64b000000000000000000003';
const U_EDITOR = '64b000000000000000000004';
const U_VIEWER = '64b000000000000000000005';
const U_VIEWR2 = '64b000000000000000000006';
const INVITE_ID = '64b0000000000000000000c1';

// One active membership row per role, plus a second owner so the last-owner
// guard is never the thing doing the blocking in an authz assertion — every
// denial below must come from the role check, not from LAST_OWNER.
function baseRows() {
  return [
    { _id: oid(), advertiserId: ADV, userId: U_OWNER,  email: 'owner@x.com',  role: 'owner',  status: 'active' },
    { _id: oid(), advertiserId: ADV, userId: U_OWNER2, email: 'owner2@x.com', role: 'owner',  status: 'active' },
    { _id: oid(), advertiserId: ADV, userId: U_ADMIN,  email: 'admin@x.com',  role: 'admin',  status: 'active' },
    { _id: oid(), advertiserId: ADV, userId: U_EDITOR, email: 'editor@x.com', role: 'editor', status: 'active' },
    { _id: oid(), advertiserId: ADV, userId: U_VIEWER, email: 'viewer@x.com', role: 'viewer', status: 'active' },
    { _id: oid(), advertiserId: ADV, userId: U_VIEWR2, email: 'viewer2@x.com', role: 'viewer', status: 'active' },
    { _id: INVITE_ID, advertiserId: ADV, userId: null, email: 'invitee@x.com', role: 'editor', status: 'pending', inviteToken: 'tok-abc' }
  ];
}

// Faithful in-memory AdvertiserMembership store. Returns real, mutable
// "documents" with an attached .save() so each executor's own
// `target.role = role; await target.save();` behaves as against a real
// Mongoose doc — mutating in place.
function makeMembershipStore(rows) {
  const docs = rows.map((r) => ({ ...r }));
  docs.forEach((d) => { d.save = async function save() { /* mutation already in place */ }; });

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
  const orig = {
    findOne: AdvertiserMembership.findOne,
    countDocuments: AdvertiserMembership.countDocuments,
    create: AdvertiserMembership.create
  };
  AdvertiserMembership.findOne = store.findOne;
  AdvertiserMembership.countDocuments = store.countDocuments;
  AdvertiserMembership.create = store.create;
  return {
    store,
    restore() {
      AdvertiserMembership.findOne = orig.findOne;
      AdvertiserMembership.countDocuments = orig.countDocuments;
      AdvertiserMembership.create = orig.create;
    }
  };
}

function installUserStub({ existingEmails = [] } = {}) {
  const User = require('../models/User');
  const orig = { findOne: User.findOne, find: User.find };
  User.findOne = (query) => ({
    select() { return this; },
    lean: async () => (existingEmails.includes(query.email) ? { _id: oid() } : null)
  });
  User.find = () => ({ select() { return this; }, lean: async () => [] });
  return {
    restore() {
      User.findOne = orig.findOne;
      User.find = orig.find;
    }
  };
}

async function withStubs(rows, fn) {
  const membership = installMembershipStub(rows);
  const user = installUserStub({});
  try { return await fn(membership.store); }
  finally { membership.restore(); user.restore(); }
}

// The req an executor sees. Mirrors exactly what requireAuth stamps
// (middleware/requireAuth.js) — role comes off the SELECTED membership.
function reqAs(userId, role, extra = {}) {
  return {
    advertiserId: ADV,
    user: { userId, role, email: `${role}@x.com`, isSuperAdmin: false },
    ...extra
  };
}

const FORBIDDEN = 'ROLE_FORBIDDEN';

function assertDenied(result, label) {
  assert.ok(result && result.ok === false, `${label}: expected ok:false, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.strictEqual(result.code, FORBIDDEN,
    `${label}: expected code ${FORBIDDEN}, got ${JSON.stringify(result).slice(0, 200)}`);
}
function assertAllowed(result, label) {
  assert.ok(result && result.ok === true, `${label}: expected ok:true, got ${JSON.stringify(result).slice(0, 200)}`);
}

// Real executors under test.
const patchExec  = require(path.join(EXEC_DIR, 'teamMemberPatch'));
const deleteExec = require(path.join(EXEC_DIR, 'teamMemberDelete'));
const inviteExec = require(path.join(EXEC_DIR, 'teamInviteCreate'));
const revokeExec = require(path.join(EXEC_DIR, 'teamInviteDelete'));

(async function main() {
  console.log(`verifyAgentTeamCapabilityAuthz (https-proxy-agent: ${PROXY_MODE})\n`);

  // ═════════════ A. shared-helper reuse, proven by IMPORT ════════════════
  console.log('A. the rank logic is IMPORTED, not re-derived');

  check('A1 _teamAuthzCommon requires middleware/requireMembershipRole', () => {
    const src = fs.readFileSync(path.join(EXEC_DIR, '_teamAuthzCommon.js'), 'utf8');
    assert.ok(/require\(\s*['"]\.\.\/\.\.\/middleware\/requireMembershipRole['"]\s*\)/.test(src),
      '_teamAuthzCommon.js must require ../../middleware/requireMembershipRole');
  });

  check('A2 _teamAuthzCommon defines NO rank table of its own', () => {
    const src = fs.readFileSync(path.join(EXEC_DIR, '_teamAuthzCommon.js'), 'utf8');
    // A third copy of the hierarchy is the failure mode this file exists to
    // prevent. Assert no local rank map and no local numeric ordering.
    assert.ok(!/viewer\s*:\s*0/.test(src), '_teamAuthzCommon.js must not declare its own ROLE_RANK map');
    assert.ok(!/function\s+roleRank/.test(src), '_teamAuthzCommon.js must not define its own roleRank()');
  });

  check('A3 the helpers _teamAuthzCommon uses are the SAME objects the routes use', () => {
    const common = require(path.join(EXEC_DIR, '_teamAuthzCommon'));
    const mw = require(path.join(ROOT, 'middleware', 'requireMembershipRole'));
    assert.strictEqual(typeof mw.canActOnRole, 'function', 'middleware must export canActOnRole');
    assert.strictEqual(typeof mw.canGrantRole, 'function', 'middleware must export canGrantRole');
    // Behavioural identity across the full 4x4 matrix — if _teamAuthzCommon
    // ever forks the logic, one of these 32 comparisons diverges.
    const ROLES = ['viewer', 'editor', 'admin', 'owner'];
    for (const caller of ROLES) {
      for (const target of ROLES) {
        const actAllowed   = mw.canActOnRole(caller, target);
        const grantAllowed = mw.canGrantRole(caller, target);
        assert.strictEqual(common.requireCanActOn(reqAs('u', caller), target) === null, actAllowed,
          `requireCanActOn(${caller},${target}) must agree with canActOnRole`);
        assert.strictEqual(common.requireCanGrant(reqAs('u', caller), target) === null, grantAllowed,
          `requireCanGrant(${caller},${target}) must agree with canGrantRole`);
      }
    }
  });

  check('A4 every team executor IMPORTS _teamAuthzCommon (not just names it)', () => {
    for (const f of ['teamMemberPatch', 'teamMemberDelete', 'teamInviteCreate', 'teamInviteDelete']) {
      const src = fs.readFileSync(path.join(EXEC_DIR, `${f}.js`), 'utf8');
      assert.ok(/require\(\s*['"]\.\/_teamAuthzCommon['"]\s*\)/.test(src),
        `${f}.js must require ./_teamAuthzCommon`);
      assert.ok(/requireManagerRole/.test(src),
        `${f}.js must reference requireManagerRole`);
    }
  });

  // ═════════════ B. the escalations the bug allowed are now blocked ══════
  console.log('B. real executors — the four escalations from the report');

  await checkAsync('B1 viewer CANNOT self-promote to owner via team.member.patch', async () => {
    await withStubs(baseRows(), async (store) => {
      const before = store.docs.find((d) => String(d.userId) === U_VIEWER).role;
      const r = await patchExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_VIEWER, role: 'owner' } });
      assertDenied(r, 'B1');
      const after = store.docs.find((d) => String(d.userId) === U_VIEWER).role;
      assert.strictEqual(after, before, 'B1: the viewer\'s role must be unchanged on disk');
      assert.strictEqual(after, 'viewer', 'B1: viewer must still be a viewer');
    });
  });

  await checkAsync('B2 viewer CANNOT revoke another member via team.member.delete', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await deleteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_EDITOR } });
      assertDenied(r, 'B2');
      const victim = store.docs.find((d) => String(d.userId) === U_EDITOR);
      assert.strictEqual(victim.status, 'active', 'B2: the target must still be active');
    });
  });

  await checkAsync('B3 viewer CANNOT revoke an OWNER via team.member.delete', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await deleteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_OWNER } });
      assertDenied(r, 'B3');
      assert.notStrictEqual(r.code, 'LAST_OWNER',
        'B3: must be denied by the ROLE gate, not incidentally by the last-owner guard');
      const victim = store.docs.find((d) => String(d.userId) === U_OWNER);
      assert.strictEqual(victim.status, 'active', 'B3: the owner must still be active');
    });
  });

  await checkAsync('B4 viewer CANNOT invite via team.invite.create', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await inviteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { email: 'new@x.com', role: 'editor' } });
      assertDenied(r, 'B4');
      // Also at 'viewer' — the one role a viewer could grant on rank, so this
      // case is carried by the manager gate alone (see F6).
      const r2 = await inviteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { email: 'new2@x.com', role: 'viewer' } });
      assertDenied(r2, 'B4.same-rank');
      // And with no role at all — the executor defaults to 'editor'.
      const r3 = await inviteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { email: 'new3@x.com' } });
      assertDenied(r3, 'B4.default-role');
      assert.strictEqual(store.calls.create.length, 0, 'B4: no invitation row may be created');
    });
  });

  await checkAsync('B5 viewer CANNOT revoke a pending invite via team.invite.delete', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await revokeExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { invitationId: INVITE_ID } });
      assertDenied(r, 'B5');
      const inv = store.docs.find((d) => String(d._id) === INVITE_ID);
      assert.strictEqual(inv.status, 'pending', 'B5: the invitation must still be pending');
    });
  });

  await checkAsync('B6 editor CANNOT do any of the four', async () => {
    await withStubs(baseRows(), async () => {
      assertDenied(await patchExec.run({ req: reqAs(U_EDITOR, 'editor'), args: { userId: U_VIEWER, role: 'editor' } }), 'B6.patch');
      assertDenied(await deleteExec.run({ req: reqAs(U_EDITOR, 'editor'), args: { userId: U_VIEWER } }), 'B6.delete');
      assertDenied(await inviteExec.run({ req: reqAs(U_EDITOR, 'editor'), args: { email: 'n@x.com' } }), 'B6.invite');
      assertDenied(await revokeExec.run({ req: reqAs(U_EDITOR, 'editor'), args: { invitationId: INVITE_ID } }), 'B6.revoke');
    });
  });

  // ═════════════ C. admin may not reach owner, by any of the four ════════
  console.log('C. admin cannot grant or revoke owner');

  await checkAsync('C1 admin CANNOT grant owner via team.member.patch', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_EDITOR, role: 'owner' } });
      assertDenied(r, 'C1');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_EDITOR).role, 'editor',
        'C1: the editor must not have become an owner');
    });
  });

  await checkAsync('C2 admin CANNOT self-promote to owner', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_ADMIN, role: 'owner' } });
      assertDenied(r, 'C2');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_ADMIN).role, 'admin',
        'C2: the admin must still be an admin');
    });
  });

  await checkAsync('C3 admin CANNOT demote an owner (canActOnRole, not last-owner)', async () => {
    // TWO owners exist in baseRows(), so LAST_OWNER cannot be what blocks this.
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_OWNER, role: 'admin' } });
      assertDenied(r, 'C3');
      assert.notStrictEqual(r.code, 'LAST_OWNER', 'C3: must be denied by the rank gate, not the last-owner guard');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_OWNER).role, 'owner',
        'C3: the owner must still be an owner');
    });
  });

  await checkAsync('C4 admin CANNOT revoke an owner (escalation-by-deletion)', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await deleteExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_OWNER } });
      assertDenied(r, 'C4');
      assert.notStrictEqual(r.code, 'LAST_OWNER', 'C4: must be denied by the rank gate, not the last-owner guard');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_OWNER).status, 'active',
        'C4: the owner must still be active');
    });
  });

  // ═════════════ D. the legitimate paths still work ══════════════════════
  console.log('D. positive control — the guards did not brick the feature');

  await checkAsync('D1 owner CAN promote an editor to admin', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_OWNER, 'owner'), args: { userId: U_EDITOR, role: 'admin' } });
      assertAllowed(r, 'D1');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_EDITOR).role, 'admin');
    });
  });

  await checkAsync('D2 owner CAN grant owner', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_OWNER, 'owner'), args: { userId: U_ADMIN, role: 'owner' } });
      assertAllowed(r, 'D2');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_ADMIN).role, 'owner');
    });
  });

  await checkAsync('D3 admin CAN patch a viewer (peer/below rank)', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_VIEWER, role: 'editor' } });
      assertAllowed(r, 'D3');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWER).role, 'editor');
    });
  });

  await checkAsync('D4 a VIEWER CAN still resign (self-target carve-out)', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await deleteExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_VIEWER } });
      assertAllowed(r, 'D4');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWER).status, 'revoked',
        'D4: a viewer resigning must actually be revoked');
    });
  });

  await checkAsync('D5 an OWNER can still resign while another owner remains', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await deleteExec.run({ req: reqAs(U_OWNER, 'owner'), args: { userId: U_OWNER } });
      assertAllowed(r, 'D5');
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_OWNER).status, 'revoked');
    });
  });

  await checkAsync('D6 owner and admin CAN invite and revoke invites', async () => {
    await withStubs(baseRows(), async () => {
      assertAllowed(await inviteExec.run({ req: reqAs(U_OWNER, 'owner'), args: { email: 'a@x.com', role: 'admin' } }), 'D6.owner-invite');
    });
    await withStubs(baseRows(), async () => {
      assertAllowed(await inviteExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { email: 'b@x.com', role: 'editor' } }), 'D6.admin-invite');
    });
    await withStubs(baseRows(), async () => {
      assertAllowed(await revokeExec.run({ req: reqAs(U_ADMIN, 'admin'), args: { invitationId: INVITE_ID } }), 'D6.admin-revoke');
    });
  });

  // ═════════════ E. fail-closed + ordering preconditions ═════════════════
  console.log('E. fail-closed on junk role, and validate-before-rank ordering');

  await checkAsync('E1 an unrecognised caller role is denied (fails closed)', async () => {
    await withStubs(baseRows(), async () => {
      // roleRank() ranks an unknown role -Infinity; the manager gate must
      // reject it outright rather than let a rank comparison decide.
      assertDenied(await patchExec.run({ req: reqAs(U_VIEWER, 'superuser'), args: { userId: U_VIEWER, role: 'owner' } }), 'E1.patch');
      assertDenied(await deleteExec.run({ req: reqAs(U_VIEWER, 'superuser'), args: { userId: U_EDITOR } }), 'E1.delete');
      assertDenied(await inviteExec.run({ req: reqAs(U_VIEWER, 'superuser'), args: { email: 'n@x.com' } }), 'E1.invite');
      assertDenied(await revokeExec.run({ req: reqAs(U_VIEWER, 'superuser'), args: { invitationId: INVITE_ID } }), 'E1.revoke');
    });
  });

  await checkAsync('E2 a MISSING req.user is denied, not crashed through', async () => {
    await withStubs(baseRows(), async () => {
      const bare = { advertiserId: ADV };
      assertDenied(await patchExec.run({ req: bare, args: { userId: U_VIEWER, role: 'owner' } }), 'E2.patch');
      assertDenied(await deleteExec.run({ req: bare, args: { userId: U_EDITOR } }), 'E2.delete');
      assertDenied(await inviteExec.run({ req: bare, args: { email: 'n@x.com' } }), 'E2.invite');
      assertDenied(await revokeExec.run({ req: bare, args: { invitationId: INVITE_ID } }), 'E2.revoke');
    });
  });

  await checkAsync('E3 a garbage REQUESTED role is rejected by VALID_ROLES before canGrantRole sees it', async () => {
    // canGrantRole(anyRealRole, 'garbage') is TRUE (rank -Infinity <= any),
    // so if the ordering ever inverted, an owner-equivalent grant of a junk
    // role would slip through as "allowed". Assert the VALID_ROLES error
    // wins — that is the ordering contract _teamAuthzCommon documents.
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_OWNER, 'owner'), args: { userId: U_VIEWER, role: 'superuser' } });
      assert.strictEqual(r.ok, false, 'E3: junk role must be refused');
      assert.ok(/role must be one of/.test(r.error), `E3: expected the VALID_ROLES error, got ${JSON.stringify(r)}`);
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWER).role, 'viewer');
    });
  });

  await checkAsync('E4 the manager gate runs BEFORE any membership lookup (no existence leak)', async () => {
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_OWNER, role: 'admin' } });
      assertDenied(r, 'E4');
      assert.strictEqual(store.calls.findOne.length, 0,
        'E4: an unauthorized caller must be rejected before the executor queries AdvertiserMembership');
    });
  });

  await checkAsync('E5 cross-advertiser scope still holds under the new gate', async () => {
    // An owner of a DIFFERENT advertiser must not reach this advertiser's
    // rows. requireAuth scopes req.advertiserId; the executor filters on it.
    await withStubs(baseRows(), async (store) => {
      const r = await patchExec.run({
        req: { advertiserId: OTHERADV, user: { userId: U_OWNER, role: 'owner', isSuperAdmin: false } },
        args: { userId: U_VIEWER, role: 'owner' }
      });
      assert.strictEqual(r.ok, false, 'E5: cross-advertiser patch must fail');
      // Assert the SPECIFIC denial, not merely "some failure": the caller is
      // a legitimate owner and clears every role gate, so the only thing that
      // may stop them is the advertiserId filter on the lookup. If this ever
      // starts failing with ROLE_FORBIDDEN instead, the tenancy scope has been
      // replaced by a role check and this test would otherwise still pass.
      assert.ok(/member not found/.test(r.error),
        `E5: expected the tenancy-scoped 'member not found', got ${JSON.stringify(r).slice(0, 160)}`);
      assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWER).role, 'viewer');
    });
  });

  // ═════════════ F. revert-prove ═════════════════════════════════════════
  console.log('F. revert-prove — mutate temp sibling copies of the real executors');

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

  const patchPath  = path.join(EXEC_DIR, 'teamMemberPatch.js');
  const deletePath = path.join(EXEC_DIR, 'teamMemberDelete.js');
  const invitePath = path.join(EXEC_DIR, 'teamInviteCreate.js');
  const revokePath = path.join(EXEC_DIR, 'teamInviteDelete.js');
  const patchSrc  = fs.readFileSync(patchPath, 'utf8');
  const deleteSrc = fs.readFileSync(deletePath, 'utf8');
  const inviteSrc = fs.readFileSync(invitePath, 'utf8');
  const revokeSrc = fs.readFileSync(revokePath, 'utf8');

  const GATE_PATCH = `  const notManager = requireManagerRole(req);
  if (notManager) return notManager;
`;

  // F1 — drop the manager gate from teamMemberPatch.
  // Scenario note: removing ONLY this gate does not reproduce raw "viewer
  // self-promotes to owner" — canGrantRole is an independent rank check and
  // still blocks viewer(0) -> owner(3). That is genuine defense in depth, not
  // a weak mutation. What the gate ALONE owns is keeping non-owner/admin
  // callers out entirely, so this proves an EDITOR (zero patch access per the
  // matrix) can promote a viewer to editor once it is gone: canActOnRole
  // ('editor','viewer') and canGrantRole('editor','editor') both pass on rank.
  await checkAsync('F1 removing the manager gate lets an editor patch roles (must go RED)', async () => {
    const mutated = mutateOrThrow(patchSrc, GATE_PATCH, '', 'F1');
    await withMutatedSibling(patchPath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_EDITOR, 'editor'), args: { userId: U_VIEWER, role: 'editor' } });
        assert.strictEqual(r.ok, true,
          `F1: with the gate removed an editor MUST succeed — otherwise the gate is not what blocks B6.patch (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWER).role, 'editor');
      });
    });
  });

  // F2 — drop canGrantRole from teamMemberPatch → admin can mint an owner.
  await checkAsync('F2 removing canGrantRole lets an admin grant owner (must go RED)', async () => {
    const mutated = mutateOrThrow(
      patchSrc,
      `  const cannotGrant = requireCanGrant(req, role);
  if (cannotGrant) return cannotGrant;
`,
      '',
      'F2'
    );
    await withMutatedSibling(patchPath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_EDITOR, role: 'owner' } });
        assert.strictEqual(r.ok, true,
          `F2: with canGrantRole removed an admin MUST be able to grant owner (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d.userId) === U_EDITOR).role, 'owner',
          'F2: the escalation must actually land, proving C1 depends on this check');
      });
    });
  });

  // F3 — drop canActOnRole from teamMemberPatch → admin can demote an owner.
  await checkAsync('F3 removing canActOnRole lets an admin demote an owner (must go RED)', async () => {
    const mutated = mutateOrThrow(
      patchSrc,
      `  const cannotAct = requireCanActOn(req, target.role, 'modify');
  if (cannotAct) return cannotAct;
`,
      '',
      'F3'
    );
    await withMutatedSibling(patchPath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_OWNER, role: 'admin' } });
        assert.strictEqual(r.ok, true,
          `F3: with canActOnRole removed an admin MUST be able to demote an owner (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d.userId) === U_OWNER).role, 'admin',
          'F3: the demotion must actually land, proving C3 depends on this check');
      });
    });
  });

  // F4 — drop the manager gate from teamMemberDelete.
  // canActOnRole survives the mutation and still blocks viewer -> editor
  // (rank 0 < 1), so the scenario that isolates the GATE is a viewer revoking
  // a PEER viewer: canActOnRole('viewer','viewer') passes on rank.
  await checkAsync('F4 removing the manager gate lets a viewer revoke a peer (must go RED)', async () => {
    const mutated = mutateOrThrow(
      deleteSrc,
      `  const selfResign = isSelfTarget(req, rawUserId);
  if (!selfResign) {
    const notManager = requireManagerRole(req);
    if (notManager) return notManager;
  }
`,
      '',
      'F4'
    );
    await withMutatedSibling(deletePath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_VIEWER, 'viewer'), args: { userId: U_VIEWR2 } });
        assert.strictEqual(r.ok, true,
          `F4: with the gate removed a viewer MUST be able to revoke a peer viewer (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d.userId) === U_VIEWR2).status, 'revoked');
      });
    });
  });

  // F5 — drop canActOnRole from teamMemberDelete → admin can revoke an owner.
  await checkAsync('F5 removing canActOnRole lets an admin revoke an owner (must go RED)', async () => {
    const mutated = mutateOrThrow(
      deleteSrc,
      `  const isSelf = isSelfTarget(req, target.userId);
  if (!isSelf) {
    const cannotAct = requireCanActOn(req, target.role, 'revoke');
    if (cannotAct) return cannotAct;
  }
`,
      '',
      'F5'
    );
    await withMutatedSibling(deletePath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_ADMIN, 'admin'), args: { userId: U_OWNER } });
        assert.strictEqual(r.ok, true,
          `F5: with canActOnRole removed an admin MUST be able to revoke an owner (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d.userId) === U_OWNER).status, 'revoked',
          'F5: the revoke must actually land, proving C4 depends on this check');
      });
    });
  });

  // F6 — drop the manager gate from teamInviteCreate.
  // Isolation note, same shape as F1/F4: canGrantRole survives this mutation
  // and still blocks a viewer inviting an EDITOR (rank 0 < 1) — real defense
  // in depth. The scenario that isolates the GATE is therefore a viewer
  // inviting at 'viewer', which canGrantRole('viewer','viewer') permits on
  // rank, leaving the now-removed manager gate as the only thing that had
  // been standing between a viewer and creating an invitation at all.
  await checkAsync('F6 removing the manager gate lets a viewer invite (must go RED)', async () => {
    const mutated = mutateOrThrow(inviteSrc, GATE_PATCH, '', 'F6');
    await withMutatedSibling(invitePath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_VIEWER, 'viewer'), args: { email: 'new@x.com', role: 'viewer' } });
        assert.strictEqual(r.ok, true,
          `F6: with the gate removed a viewer MUST be able to invite (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.calls.create.length, 1, 'F6: an invitation row must actually be created');
      });
    });
  });

  // F7 — drop the manager gate from teamInviteDelete.
  await checkAsync('F7 removing the manager gate lets a viewer revoke an invite (must go RED)', async () => {
    const mutated = mutateOrThrow(revokeSrc, GATE_PATCH, '', 'F7');
    await withMutatedSibling(revokePath, mutated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_VIEWER, 'viewer'), args: { invitationId: INVITE_ID } });
        assert.strictEqual(r.ok, true,
          `F7: with the gate removed a viewer MUST be able to revoke a pending invite (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.docs.find((d) => String(d._id) === INVITE_ID).status, 'revoked');
      });
    });
  });

  // F8 — canGrantRole on teamInviteCreate is a NO-OP against today's
  // VALID_ROLES (max invitable rank is admin=2, and the manager gate already
  // restricts callers to admin=2 or owner=3), exactly as on the HTTP route.
  // So it cannot be revert-proven directly — a plain removal changes nothing,
  // and mutateOrThrow would pass while proving nothing. Instead prove it is
  // load-bearing under the ONE scenario it exists for: VALID_ROLES growing to
  // include 'owner'. With the check present, an admin is still refused; with
  // BOTH mutations, the admin mints an owner invitation.
  await checkAsync('F8 canGrantRole on invite.create is load-bearing if VALID_ROLES ever grows', async () => {
    const grown = mutateOrThrow(
      inviteSrc,
      "const VALID_ROLES = ['admin', 'editor', 'viewer'];",
      "const VALID_ROLES = ['owner', 'admin', 'editor', 'viewer'];",
      'F8-grow'
    );
    // (a) check present + VALID_ROLES grown → admin still refused.
    await withMutatedSibling(invitePath, grown, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_ADMIN, 'admin'), args: { email: 'esc@x.com', role: 'owner' } });
        assertDenied(r, 'F8a');
        assert.strictEqual(store.calls.create.length, 0, 'F8a: no owner invitation may be created');
      });
    });
    // (b) check ALSO removed → the escalation lands, proving (a) was the check.
    const grownAndUngated = mutateOrThrow(
      grown,
      `  const cannotGrant = requireCanGrant(req, role);
  if (cannotGrant) return cannotGrant;
`,
      '',
      'F8-ungate'
    );
    await withMutatedSibling(invitePath, grownAndUngated, async (mod) => {
      await withStubs(baseRows(), async (store) => {
        const r = await mod.run({ req: reqAs(U_ADMIN, 'admin'), args: { email: 'esc@x.com', role: 'owner' } });
        assert.strictEqual(r.ok, true,
          `F8b: with canGrantRole removed the admin MUST be able to mint an owner invite (got ${JSON.stringify(r).slice(0, 160)})`);
        assert.strictEqual(store.calls.create.length, 1, 'F8b: the owner invitation must actually be created');
        assert.strictEqual(store.calls.create[0].role, 'owner');
      });
    });
  });

  // ── report ──────────────────────────────────────────────────────────────
  console.log('');
  if (failures.length) {
    console.error(`❌ verifyAgentTeamCapabilityAuthz: ${failures.length} failed, ${pass} passed`);
    failures.forEach((f) => console.error(`   - ${f}`));
    process.exit(1);
  }
  console.log(`✅ verifyAgentTeamCapabilityAuthz: all ${pass} checks passed`);
})().catch((err) => {
  console.error('verifyAgentTeamCapabilityAuthz: harness crashed', (err && err.stack) || err);
  process.exit(1);
});
