#!/usr/bin/env node
'use strict';
//
// verifyReframeUploadCeiling — pins the Cloudinary upload ceiling on the reframe
// path, and pins that an oversized-but-VALID generation is refitted rather than
// thrown away.
//
// WHY THIS EXISTS (2026-08-04 production crash):
//   REFRAME_RESOLUTION is '4k', so reframeReferenceForAspect's outpaint tier
//   can return MORE than Cloudinary's upload limit. That limit is PLAN-
//   DEPENDENT, not a fixed API constant — production hit it at 20971520
//   (20 MiB) and the account was upgraded to 40 MiB the same day, so the
//   ceiling is read from CLOUDINARY_MAX_UPLOAD_BYTES and the fixture below is
//   sized FROM it. The
//   pre-upload guard had only a FLOOR:
//       if (outBuf.length >= 512 && await outputRatioOk(...)) {
//         const up = await uploadBufferToCloudinary(outBuf, ...)
//   ...and no ceiling. A healthy 4K generation passed the check and 400'd on
//   upload:
//       💥 unhandledRejection: {
//         message: 'File size too large. Got 24232221. Maximum is 20971520.',
//         name: 'Error', http_code: 400 }
//   The web process died one second after a 411s Omni master had ALREADY been
//   paid for, taking the run with it (4 ads requeued, 1 run marked failed).
//
//   TWO distinct defects, both pinned here:
//     1. MONEY. `billed = true` is set at the outpaint submit, so the charge is
//        committed before the upload. Discarding the output on a storage error
//        pays for a 4K generation and keeps nothing — the exact loss the
//        "a single blip here used to discard a generation we had already paid
//        for" comment on the same path exists to prevent.
//     2. CRASH CLASS. buildReferenceImages fans reframes out through
//        Promise.all, which settles on the FIRST rejection; a sibling rejecting
//        afterwards has no listener and is FATAL on Node 20.
//
// This harness is pure + offline: no DB, no network, no API key. It does real
// sharp work, so it is slower than the other verifiers (~5-10s).
//   node scripts/verifyReframeUploadCeiling.js
//
// Revert-prove:
//   (a) In atlasVideoService, replace the `fitBufferForCloudinary(outBuf, ...)`
//       call with `outBuf` -> S2 fails (source no longer refits before upload).
//   (b) Drop the `.catch(...)` from the buildReferenceImages Promise.all map
//       -> S3/S4 fail. That is the crash itself: restore it and they pass.
//   (c) Hardcode the ceiling instead of reading the env -> C1 fails. Setting
//       the env below 1 MiB must NOT shrink the effective ceiling (C3).
//   Report the failing output verbatim when proving.
//
// Covered:
//   C*  the ceiling is env-driven with a sane floor (it is plan-dependent)
//   F*  fitBufferForCloudinary behaviour: identity under the limit, refit over
//       it, aspect ratio preserved, never throws
//   S*  source wiring a unit test cannot see: the outpaint AND pad uploads both
//       go through the refit, and the reframe fan-out cannot reject

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_PATH = path.join(__dirname, '..', 'services', 'atlasVideoService.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const {
  fitBufferForCloudinary,
  CLOUDINARY_MAX_UPLOAD_BYTES: MAX
} = require('../services/atlasVideoService');

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

// A noisy raw buffer so PNG compression cannot shrink it — this is what makes
// the fixture genuinely exceed the limit, the way a real photographic 4K
// outpaint does. A flat-colour image would compress to nothing and prove zero.
async function oversizedForCeiling(max) {
  // Size the fixture FROM the ceiling. A hardcoded 4K image silently stopped
  // exceeding the limit the moment the Cloudinary plan moved 20 MiB -> 40 MiB,
  // which made F0 go red on an upgrade that had actually fixed the problem.
  // 9:16 at 3 bytes/px, uncompressed: pixels = 144k^2, so k = sqrt(max/432).
  const k = Math.ceil(Math.sqrt(max / 432)) + 24;   // +24 for headroom
  const W = 9 * k, H = 16 * k;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < px.length; i++) px[i] = (Math.floor(i * 2654435761 % 251)) & 0xff;
  return { buf: await sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer(), W, H };
}

(async () => {
  // ── C: the constant ────────────────────────────────────────────────
  // PLAN-DEPENDENT, so this pins the CONTRACT (env-driven, sane floor), not a
  // fixed number. The 2026-08-04 crash was 24232221 against a 20 MiB plan; the
  // account moved to 40 MiB the same day, which is precisely why the value is
  // not hardcoded. Asserting `=== 20971520` here would have gone red on an
  // upgrade that fixed the problem.
  checkTrue('C1 ceiling comes from CLOUDINARY_MAX_UPLOAD_BYTES', /process\.env\.CLOUDINARY_MAX_UPLOAD_BYTES/.test(SRC));
  checkTrue('C1b ceiling is declared in config/defaults.env (so prod is not on the code default)',
    /^CLOUDINARY_MAX_UPLOAD_BYTES=\d+$/m.test(
      fs.readFileSync(path.join(__dirname, '..', 'config', 'defaults.env'), 'utf8')));
  checkTrue('C2 resolved ceiling is a sane byte count, not MB or a typo',
    Number.isFinite(MAX) && MAX >= 1048576, String(MAX));
  checkTrue('C3 a bad/absent value cannot refit everything (floor is enforced)',
    /raw >= 1048576/.test(SRC));

  // ── F: the refit ───────────────────────────────────────────────────
  const { buf: big, W: bigW, H: bigH } = await oversizedForCeiling(MAX);
  checkTrue('F0 fixture genuinely exceeds the limit', big.length > MAX,
    `${big.length} vs ceiling ${MAX}`);

  const fitted = await fitBufferForCloudinary(big, 'harness');
  checkTrue('F1 an oversized buffer is refitted, not rejected', !!fitted);
  checkTrue('F2 the refit result is under the ceiling',
    !!fitted && fitted.length <= MAX, fitted ? String(fitted.length) : 'null');

  // The whole point: we keep the generation we paid for. If the refit had to
  // destroy the frame to fit, this would be a worse outcome than failing.
  if (fitted) {
    const md = await sharp(fitted).metadata();
    const origRatio = bigW / bigH;
    checkTrue('F3 aspect ratio survives the refit (the ratio check already passed on the original)',
      Math.abs((md.width / md.height) - origRatio) < 0.01,
      `${md.width}x${md.height}`);
    checkTrue('F4 the refit keeps usable resolution rather than shrinking to nothing',
      md.width >= 640, `${md.width}px wide`);
  }

  // Identity path — must not spend CPU re-encoding something that already fits.
  const small = Buffer.from('not an image, but under the limit');
  checkTrue('F5 a buffer under the ceiling is returned UNTOUCHED (same object)',
    (await fitBufferForCloudinary(small)) === small);

  // Never throws: a non-buffer or corrupt input must degrade, not crash — this
  // function runs on the path whose whole problem was a fatal rejection.
  let threw = false;
  try {
    const r = await fitBufferForCloudinary(Buffer.alloc(MAX + 1, 0x41), 'corrupt');
    checkTrue('F6 an oversized NON-image degrades to null instead of throwing', r === null, String(r));
  } catch (err) { threw = true; }
  checkTrue('F6 fitBufferForCloudinary never throws', !threw);
  for (const bad of [null, undefined, 'string', 123, {}]) {
    let t = false;
    try { await fitBufferForCloudinary(bad); } catch { t = true; }
    checkTrue(`F7 non-buffer input (${typeof bad}) does not throw`, !t);
  }

  // ── S: source wiring ───────────────────────────────────────────────
  checkTrue('S1 the ceiling is applied via a named helper, not an inline magic number',
    /function fitBufferForCloudinary/.test(SRC));
  checkTrue('S2 the OUTPAINT upload goes through the refit',
    /const fitted = await fitBufferForCloudinary\(outBuf/.test(SRC)
    && /uploadBufferToCloudinary\(fitted/.test(SRC));
  checkTrue('S2b the PAD upload goes through the refit too (a 4K pad can also exceed)',
    /fitBufferForCloudinary\(padBuf/.test(SRC)
    && /uploadBufferToCloudinary\(paddedFitted/.test(SRC));

  // THE CRASH CLASS. Promise.all settles on the first rejection; a sibling
  // rejecting afterwards is an unhandled — and fatal — rejection.
  const fanout = SRC.slice(SRC.indexOf('// Reframe all in parallel'));
  checkTrue('S3 the reframe fan-out attaches a per-item catch',
    /reframeReferenceForAspect\(\{[\s\S]{0,400}?\}\)\.catch\(/.test(fanout));
  checkTrue('S4 that catch resolves to null so the dedupe loop drops it',
    /\.catch\(\([\s\S]{0,300}?return null;/.test(fanout));
  checkTrue('S5 the dedupe loop still skips falsy entries (what makes null safe)',
    /for \(const u of reframed\)[\s\S]{0,120}if \(!u \|\| seenFinal\.has\(u\)\) continue;/.test(SRC));

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyReframeUploadCeiling: ${pass}/${total} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error('  FAIL', f);
    process.exit(1);
  }
  console.log(`verifyReframeUploadCeiling: ${pass}/${total} passed`);
  process.exit(0);
})().catch((err) => {
  console.error('verifyReframeUploadCeiling: harness error —', err.message);
  process.exit(1);
});
