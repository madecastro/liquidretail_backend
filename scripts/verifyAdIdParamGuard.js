#!/usr/bin/env node
'use strict';
//
// verifyAdIdParamGuard — pins the router.param ObjectId guard on ads routes.
//
// Without it, unmatched paths (GET /api/ads/zzz-not-a-route, or a not-yet-
// registered named route) fall through to /:id, Mongoose casts the segment,
// and the client gets 500 with a raw CastError that leaks model/path
// internals. That also destroyed the 404-vs-other deploy signal.
//
// Offline: no DB, no network, no key.
//   node scripts/verifyAdIdParamGuard.js

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const adsSrc = fs.readFileSync(path.join(__dirname, '../routes/ads.js'), 'utf8');
const compact = adsSrc.replace(/\s+/g, ' ');

// ── 1. Param guards for both names used in this file ────────────────
check("router.param('id', ...) is registered",
  /router\.param\(\s*['"]id['"]/.test(adsSrc));
check("router.param('adId', ...) is registered",
  /router\.param\(\s*['"]adId['"]/.test(adsSrc));
check('requireValidAdObjectId is defined once and reused',
  /function requireValidAdObjectId\s*\(/.test(adsSrc) &&
  (adsSrc.match(/requireValidAdObjectId/g) || []).length >= 3);
check('invalid id returns 404 ad not found (matches missing-but-valid)',
  /status\(404\).*ad not found/.test(compact));
check('guard uses mongoose.isValidObjectId (not a home-rolled regex)',
  /requireValidAdObjectId[\s\S]{0,200}mongoose\.isValidObjectId/.test(adsSrc));

// ── 2. Guard sits BEFORE the first /:id handler ─────────────────────
const guardIdx = adsSrc.indexOf("router.param('id'");
const firstIdHandler = adsSrc.search(/router\.(get|post|patch|delete)\('\/:id/);
check('param guard is registered before the first /:id handler',
  guardIdx > 0 && firstIdHandler > 0 && guardIdx < firstIdHandler,
  `guard@${guardIdx} firstHandler@${firstIdHandler}`);

// ── 3. Shapes that previously 500'd are not valid ObjectIds ─────────
// Live repro was GET /api/ads/zzz-not-a-route → 500 CastError.
check("mongoose rejects 'zzz-not-a-route'",
  mongoose.isValidObjectId('zzz-not-a-route') === false);
check("mongoose rejects 'formats' (named-route miss before registration)",
  mongoose.isValidObjectId('formats') === false);
check("mongoose rejects 'render-activity'",
  mongoose.isValidObjectId('render-activity') === false);
// Mongoose treats ANY 12-char string as a potential ObjectId (12 bytes).
// 'video-models' is 12 chars and isValidObjectId → true. That is why the
// named routes MUST stay registered above /:id — the param guard alone
// cannot protect a 12-char slug. Pin the quirk so nobody "tightens" the
// harness by asserting the wrong thing.
check("mongoose ACCEPTS 'video-models' (12-char quirk — named route must win)",
  mongoose.isValidObjectId('video-models') === true);
// 24-hex still reaches the real lookup (valid-but-missing → same 404).
check('24-hex still validates (real lookup still runs)',
  mongoose.isValidObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') === true);

// ── 4. No handler still depends on CastError text for control flow ──
check('routes/ads.js does not mention Cast to ObjectId (no control-flow on cast)',
  !/Cast to ObjectId/.test(adsSrc));

// ── report ──────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nverifyAdIdParamGuard: ${failures.length} FAIL(s), ${pass} pass\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`verifyAdIdParamGuard: ${pass} pass, 0 fail`);
process.exit(0);
