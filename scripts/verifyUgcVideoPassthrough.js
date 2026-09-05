#!/usr/bin/env node
'use strict';
//
// verifyUgcVideoPassthrough — pins the UGC-ads Phase 5 short-path.
//
// The whole point of this phase is that a UGC video ad never submits to
// Omni: cost drops from ~$3/master to ~$0, wall-time from ~2 min to ~15s.
// The pipeline achieves that by mirroring the source URL into Cloudinary
// on the first pass and reading a segment URL back — no billable call.
// A silent fall-through to Omni on any failure would defeat the whole
// phase, so the harness pins:
//
//   1. Kill switch UGC_VIDEO_PASSTHROUGH default OFF (opposite of the
//      other UGC-ads switches — passthrough is on the money path, so
//      the rollout default is fail-closed).
//   2. UGC-video eligibility rule: fileType='video' AND (UGC source OR
//      any operator-added attachment). Same OR-clause the /api/media
//      ?ugc=true filter uses.
//   3. Three-way return contract of preparePassthroughMaster:
//      { passthrough: true, ... } OR
//      { passthrough: false, reason } OR
//      { skip: true, reason, code }
//      The dispatcher must be able to case-split without collapsing skip
//      into passthrough:false — the skip case cannot fall through to Omni.
//   4. Source-scan of routes/ads.js and adRegenerateService.js:
//      • the passthrough is invoked BEFORE the existing Cloudinary-
//        segment / Grok / Omni branches
//      • the ugcPassthroughSkip path in /generate short-circuits into
//        a terminal failed state (mirrors the veoResult.skipped handling)
//      • the regen path THROWS on skip (never falls through to Omni)
//
// Revert-proof by keeping the kill switch off in verification and
// injecting a fake Cloudinary URL onto a stub Media — the pure isUgc
// checks and the isCloudinaryVideoUrl gate run without a Cloudinary
// account.

const mongoose = require('mongoose');
const path = require('path');
const fs   = require('fs');

const ugc = require('../services/ugcVideoPipeline');

const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures.push(label);
    console.log(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}
function checkTrue(label, cond) {
  if (!cond) { failures.push(label); console.log(`FAIL ${label}`); }
}

function oid(n) { return new mongoose.Types.ObjectId(`68fc${String(n).padStart(20, '0')}`); }

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function braceBlockFrom(src, anchorLiteral) {
  const anchorIdx = src.indexOf(anchorLiteral);
  if (anchorIdx < 0) return '';
  const open = src.indexOf('{', anchorIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.entries(vars).forEach(([k, v]) => {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  });
  try { return fn(); } finally {
    Object.entries(prev).forEach(([k, v]) => {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    });
  }
}
async function withEnvAsync(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.entries(vars).forEach(([k, v]) => {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  });
  try { return await fn(); } finally {
    Object.entries(prev).forEach(([k, v]) => {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    });
  }
}

// ── 1. Kill switch — DEFAULT OFF (opposite of UGC_FIRST_SEEDING) ──────
(function testKillSwitch() {
  withEnv({ UGC_VIDEO_PASSTHROUGH: null }, () => {
    check('K1 unset → default OFF (passthrough is on the money path; fail-closed)',
      ugc.isUgcVideoPassthroughEnabled(), false);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: '' }, () => {
    check('K2 empty → default OFF', ugc.isUgcVideoPassthroughEnabled(), false);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: 'true' }, () => {
    check('K3 "true" → ON',  ugc.isUgcVideoPassthroughEnabled(), true);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: '1' }, () => {
    check('K4 "1" → ON',     ugc.isUgcVideoPassthroughEnabled(), true);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: 'yes' }, () => {
    check('K5 "yes" → ON',   ugc.isUgcVideoPassthroughEnabled(), true);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: 'on' }, () => {
    check('K6 "on" → ON',    ugc.isUgcVideoPassthroughEnabled(), true);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: 'false' }, () => {
    check('K7 "false" → OFF', ugc.isUgcVideoPassthroughEnabled(), false);
  });
  withEnv({ UGC_VIDEO_PASSTHROUGH: 'anything-else' }, () => {
    check('K8 unknown → OFF (fail-CLOSED — opposite of UGC_FIRST_SEEDING)',
      ugc.isUgcVideoPassthroughEnabled(), false);
  });
})();

// ── 2. isUgcVideoSeed — the eligibility rule ─────────────────────────
(function testEligibility() {
  check('E1 no media → false', ugc.isUgcVideoSeed(null), false);
  check('E2 image (any source) → false',
    ugc.isUgcVideoSeed({ fileType: 'image', source: 'instagram' }),
    false);
  check('E3 video from IG → true',
    ugc.isUgcVideoSeed({ fileType: 'video', source: 'instagram' }),
    true);
  check('E4 video from Apify → true',
    ugc.isUgcVideoSeed({ fileType: 'video', source: 'apify-ig' }),
    true);
  check('E5 video from unknown source, no attachments → false',
    ugc.isUgcVideoSeed({ fileType: 'video', source: 'manual' }),
    false);
  check('E6 video from manual + operator product attachment → true (attachment overrides source)',
    ugc.isUgcVideoSeed({
      fileType: 'video', source: 'manual',
      matchedProducts: [{ source: 'operator', catalogProductId: oid(1) }]
    }),
    true);
  check('E6b video from manual + DETECT-only product attachment → false (operator is the signal)',
    ugc.isUgcVideoSeed({
      fileType: 'video', source: 'manual',
      matchedProducts: [{ source: 'detect', catalogProductId: oid(1) }]
    }),
    false);
  check('E7 video from manual + branding assignment → true',
    ugc.isUgcVideoSeed({
      fileType: 'video', source: 'manual',
      brandingAssignment: { assignedAt: new Date() }
    }),
    true);
  check('E8 video from manual + promotional assignment → true',
    ugc.isUgcVideoSeed({
      fileType: 'video', source: 'manual',
      promotionalAssignment: { assignedAt: new Date() }
    }),
    true);
  check('E9 video from manual + operator category attachment → true',
    ugc.isUgcVideoSeed({
      fileType: 'video', source: 'manual',
      matchedCategories: [{ source: 'operator', categoryId: oid(2) }]
    }),
    true);
})();

// ── 3. isCloudinaryVideoUrl gate ─────────────────────────────────────
(function testCloudinaryUrl() {
  check('C1 Cloudinary /video/upload/ URL → true',
    ugc.isCloudinaryVideoUrl('https://res.cloudinary.com/x/video/upload/v1/foo.mp4'),
    true);
  check('C2 Cloudinary /image/upload/ URL → false',
    ugc.isCloudinaryVideoUrl('https://res.cloudinary.com/x/image/upload/v1/foo.mp4'),
    false);
  check('C3 non-Cloudinary URL → false',
    ugc.isCloudinaryVideoUrl('https://cdn.instagram.com/foo.mp4'),
    false);
  check('C4 null → false', ugc.isCloudinaryVideoUrl(null), false);
  check('C5 non-string → false', ugc.isCloudinaryVideoUrl(42), false);
})();

// ── 4. preparePassthroughMaster — three-way return ───────────────────
(async function testPreparePassthroughMaster() {
  // 4a — flag off → passthrough:false, reason present
  await withEnvAsync({ UGC_VIDEO_PASSTHROUGH: 'false' }, async () => {
    const r = await ugc.preparePassthroughMaster({
      media:       { fileType: 'video', source: 'instagram', fileUrl: 'https://res.cloudinary.com/x/video/upload/v1/foo.mp4' },
      aspectRatio: '9:16'
    });
    check('P1 flag off → passthrough:false', r.passthrough, false);
    checkTrue('P1b reason names the flag', typeof r.reason === 'string' && r.reason.includes('UGC_VIDEO_PASSTHROUGH'));
  });

  // 4b — flag on + not a UGC video → passthrough:false
  await withEnvAsync({ UGC_VIDEO_PASSTHROUGH: 'true' }, async () => {
    const r = await ugc.preparePassthroughMaster({
      media:       { fileType: 'image', source: 'instagram', fileUrl: 'https://res.cloudinary.com/x/image/upload/v1/foo.jpg' },
      aspectRatio: '9:16'
    });
    check('P2 flag on + image seed → passthrough:false (not a UGC video)',
      r.passthrough, false);
  });

  // 4c — flag on + UGC video already Cloudinary → passthrough:true, mirrored:false
  await withEnvAsync({ UGC_VIDEO_PASSTHROUGH: 'true' }, async () => {
    const r = await ugc.preparePassthroughMaster({
      media:       { _id: oid(10), fileType: 'video', source: 'instagram', fileUrl: 'https://res.cloudinary.com/x/video/upload/v1/foo.mp4' },
      aspectRatio: '9:16'
    });
    check('P3 flag on + UGC video already-Cloudinary → passthrough:true', r.passthrough, true);
    check('P3b mirrored:false (no upload was needed)', r.mirrored, false);
    checkTrue('P3c videoUrl looks like a Cloudinary segment URL',
      typeof r.videoUrl === 'string' && r.videoUrl.includes('/video/upload/'));
  });
})();

// ── 5. Source-scan: dispatcher routing in routes/ads.js ──────────────
(function testDispatcherRouting() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ads.js'), 'utf8');

  // D1 — ugcVideoPipeline is required.
  checkTrue('D1 routes/ads.js requires ugcVideoPipeline',
    /require\(['"]\.\.\/services\/ugcVideoPipeline['"]\)/m.test(src));

  // D2 — preparePassthroughMaster is called INSIDE the isVideoSeed
  // branch (before the existing Cloudinary-segment / Grok branches).
  // We match on the surrounding block: `if (isVideoSeed)` … `await ugcVideoPipeline.preparePassthroughMaster`.
  const inVideoSeedBlock = /if\s*\(isVideoSeed\)[\s\S]{0,500}await\s+ugcVideoPipeline\.preparePassthroughMaster/m;
  checkTrue('D2 preparePassthroughMaster called inside the isVideoSeed branch',
    inVideoSeedBlock.test(src));

  // D3 — passthrough success sets veoVideoUrl (no Omni submit).
  checkTrue('D3 passthrough success sets veoVideoUrl',
    /ugcResult\.passthrough[\s\S]{0,200}veoVideoUrl\s*=\s*ugcResult\.videoUrl/m.test(src));

  // D4 — skip case is captured into ugcPassthroughSkip (NEVER falls
  // through to Omni). Regression class: dropping this branch would
  // silently continue into the existing Grok path — the exact wasted
  // spend Phase 5 exists to close.
  checkTrue('D4 skip case captures into ugcPassthroughSkip (no fall-through to Omni)',
    /ugcResult\.skip[\s\S]{0,600}ugcPassthroughSkip\s*=\s*ugcResult/m.test(src));

  // D5 — ugcPassthroughSkip short-circuits into a terminal failed state
  // BEFORE the Omni submit line. The order matters: falling out of the
  // if-block into the veoGenerateForAd call would double-spend.
  // Brace-walk the if-body after stripping comments — a `// status: 'failed'`
  // leftover next to a real `'draft'` write used to satisfy the `{0,600}`
  // window on its own.
  const skipBlock = braceBlockFrom(stripComments(src), 'if (ugcPassthroughSkip)');
  checkTrue('D5 ugcPassthroughSkip → terminal failed state (before any Omni submit)',
    /\$set:\s*\{[\s\S]*\bstatus:\s*['"]failed['"]/.test(skipBlock)
      && /\breturn;/.test(skipBlock));

  // D6 — order-of-operations: the ugcPassthroughSkip handler MUST sit
  // BEFORE any call to veoGenerateForAd() in the same function. This
  // is the money-invariant assertion.
  const skipHandlerIdx = src.indexOf('if (ugcPassthroughSkip)');
  const veoSubmitIdx   = src.indexOf('await veoGenerateForAd(');
  checkTrue('D6 skip handler sits BEFORE veoGenerateForAd (money invariant)',
    skipHandlerIdx > 0 && veoSubmitIdx > skipHandlerIdx);
})();

// ── 6. Source-scan: regen path in adRegenerateService.js ─────────────
(function testRegenRouting() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'adRegenerateService.js'), 'utf8');

  // R1 — ugcVideoPipeline required.
  checkTrue('R1 adRegenerateService.js requires ugcVideoPipeline',
    /require\(['"]\.\/ugcVideoPipeline['"]\)/m.test(src));

  // R2 — passthrough gate exists inside runVideoFull.
  checkTrue('R2 runVideoFull calls preparePassthroughMaster',
    /preparePassthroughMaster/m.test(src));

  // R3 — passthrough branch synthesizes a veoResult without calling
  // veoService.generateForAd. Verified by pattern: passthrough:true →
  // veoResult = { videoUrl: … } literal.
  checkTrue('R3 passthrough success synthesizes veoResult without Omni submit',
    /ugcPass\.passthrough[\s\S]{0,200}veoResult\s*=\s*\{[\s\S]{0,200}videoUrl:\s*ugcPass\.videoUrl/m.test(src));

  // R4 — skip case THROWS (does NOT fall through to Omni).
  checkTrue('R4 ugcPass.skip → throw (never falls through to Omni submit)',
    /ugcPass\.skip[\s\S]{0,600}throw\s+new\s+Error/m.test(src));

  // R5 — the else branch (existing Omni path) sits AFTER passthrough
  // handling. Order-of-operations again — reversed order would run Omni
  // regardless of the passthrough result.
  const passthroughIdx = src.indexOf('ugcPass.passthrough');
  const veoGenIdx      = src.indexOf('await veoService.generateForAd(');
  checkTrue('R5 passthrough branch handled BEFORE veoService.generateForAd',
    passthroughIdx > 0 && veoGenIdx > passthroughIdx);
})();

// ── 7. Timeout constant is bounded ───────────────────────────────────
// The mirror timeout is user-facing: too long and a wedged Cloudinary
// pull stalls the whole Generate run. Assert it is bounded.
(function testTimeoutBound() {
  checkTrue('T1 MIRROR_TIMEOUT_MS ≤ 60_000 (a stall must surface within one minute)',
    ugc.MIRROR_TIMEOUT_MS <= 60_000);
  checkTrue('T2 MIRROR_TIMEOUT_MS ≥ 5_000 (a healthy Reels pull needs a couple seconds)',
    ugc.MIRROR_TIMEOUT_MS >= 5_000);
})();

// ── Report ───────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(failures.length
    ? `\nverifyUgcVideoPassthrough: ${failures.length} FAILED`
    : 'verifyUgcVideoPassthrough: all checks passed');
  process.exit(failures.length ? 1 : 0);
}, 50);
