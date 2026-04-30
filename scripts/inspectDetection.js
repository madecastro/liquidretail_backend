#!/usr/bin/env node
//
// inspectDetection.js — dump the input/output of a detect run for offline review.
//
// Loads a DetectionArtifact, downloads the source image, re-crops every
// yoloProduct's bounding box to disk alongside its identification block.
// Use this to verify integrity of the YOLO+enrichment pipeline:
//
//   - Does the bounding box of detection p2 actually frame what the
//     identification.label claims?
//   - Are all detections accounted for, or is something missing?
//   - Is the YOLO class plausible given what's in the crop?
//
// The script also writes a `*-bgr.jpg` variant of each crop with R/B
// channels swapped — useful for SIMULATING what GPT-4.1 saw before the
// yolo_microservice color fix landed (where safe_crop emitted RGB pixels
// through cv2.imencode which expected BGR). After the microservice fix
// deploys, the "real" crop and the "bgr" crop should look obviously
// different on color-rich images; before the fix, the "bgr" version
// matches what GPT actually received.
//
// Usage:
//   node scripts/inspectDetection.js --mediaId <id>          # latest artifact for media
//   node scripts/inspectDetection.js --runId <id>            # specific run
//   node scripts/inspectDetection.js --artifactId <id>       # specific artifact
//   node scripts/inspectDetection.js --mediaId <id> --out ./inspect-foo
//
// Output directory contains:
//   source.jpg                  full source image
//   p1.jpg, p2.jpg, ...         per-detection crops (correct color)
//   p1-bgr.jpg, p2-bgr.jpg      simulated R/B-swap versions
//   identifications.json        bbox + yolo + identification per detection

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const Media              = require('../models/Media');
const DetectionArtifact  = require('../models/DetectionArtifact');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mediaId && !args.runId && !args.artifactId) usage();

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  const artifact = await loadArtifact(args);
  if (!artifact) {
    console.error('No DetectionArtifact found for the given selector');
    process.exit(1);
  }

  const media = await Media.findById(artifact.mediaId).lean();
  if (!media?.fileUrl) {
    console.error('Source media not found or has no fileUrl');
    process.exit(1);
  }

  const outDir = args.out || path.join('inspect-' + String(artifact._id));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Inspecting DetectionArtifact ${artifact._id} ===`);
  console.log(`mediaId:     ${artifact.mediaId}`);
  console.log(`runId:       ${artifact.runId}`);
  console.log(`source URL:  ${media.fileUrl}`);
  console.log(`output dir:  ${outDir}\n`);

  // Download source
  const imgRes = await axios.get(media.fileUrl, {
    responseType: 'arraybuffer',
    timeout: 30000
  });
  const sourceBuf = Buffer.from(imgRes.data);
  fs.writeFileSync(path.join(outDir, 'source.jpg'), sourceBuf);

  const meta = await sharp(sourceBuf).metadata();
  console.log(`source dimensions: ${meta.width}×${meta.height}`);

  const products = artifact.yoloProducts || [];
  console.log(`yolo detections:   ${products.length}\n`);

  const summary = [];
  for (const p of products) {
    const id = p.id || `p?`;
    const x1 = Math.max(0, Math.round(p.x1 || 0));
    const y1 = Math.max(0, Math.round(p.y1 || 0));
    const x2 = Math.min(meta.width,  Math.round(p.x2 || 0));
    const y2 = Math.min(meta.height, Math.round(p.y2 || 0));
    const w  = x2 - x1;
    const h  = y2 - y1;

    if (w <= 0 || h <= 0) {
      console.warn(`   ⚠️  ${id}: degenerate bbox (${p.x1},${p.y1})→(${p.x2},${p.y2}) — skipping`);
      summary.push({ id, bbox: { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 }, error: 'degenerate bbox' });
      continue;
    }

    const cropPath = path.join(outDir, `${id}.jpg`);
    await sharp(sourceBuf)
      .extract({ left: x1, top: y1, width: w, height: h })
      .jpeg({ quality: 90 })
      .toFile(cropPath);

    // Simulate the buggy R/B-swapped encoding by manually flipping channels
    // on the raw pixel buffer, then re-encoding. This is what GPT-4.1 saw
    // before the safe_crop fix in the microservice.
    const bgrPath = path.join(outDir, `${id}-bgr.jpg`);
    const raw = await sharp(sourceBuf)
      .extract({ left: x1, top: y1, width: w, height: h })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const swapped = Buffer.from(raw.data);
    for (let i = 0; i < swapped.length; i += 3) {
      const r = swapped[i];
      swapped[i] = swapped[i + 2];
      swapped[i + 2] = r;
    }
    await sharp(swapped, { raw: { width: raw.info.width, height: raw.info.height, channels: 3 } })
      .jpeg({ quality: 90 })
      .toFile(bgrPath);

    const ident = p.identification || {};
    summary.push({
      id,
      bbox: { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 },
      yolo: { className: p.className, confidence: p.confidence },
      identification: ident,
      cropPath: `${id}.jpg`,
      bgrPath:  `${id}-bgr.jpg`
    });

    const labelStr = ident.label || '(none)';
    const idConf   = typeof ident.confidence === 'number' ? ident.confidence.toFixed(2) : '?';
    const yoloConf = typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '?';
    console.log(
      `   ${id}  yolo="${p.className}" (${yoloConf})  →  label="${labelStr}" (id-conf=${idConf}) brand="${ident.brand || '∅'}"  bbox=${w}×${h} at (${x1},${y1})`
    );
  }

  fs.writeFileSync(path.join(outDir, 'identifications.json'), JSON.stringify({
    artifactId:    String(artifact._id),
    runId:         String(artifact.runId),
    mediaId:       String(artifact.mediaId),
    sourceUrl:     media.fileUrl,
    sourceDims:    { width: meta.width, height: meta.height },
    detectionCount: products.length,
    detections:    summary
  }, null, 2));

  console.log(`\n✓ Wrote source + ${summary.length} crop pair(s) + identifications.json to ${outDir}/`);
  console.log(`  Open ${outDir}/source.jpg side-by-side with each ${outDir}/p*.jpg to verify`);
  console.log(`  bbox correctness, and compare against ${outDir}/p*-bgr.jpg to see what GPT`);
  console.log(`  received before the yolo_microservice color fix.\n`);

  await mongoose.disconnect();
}

async function loadArtifact(args) {
  if (args.artifactId) {
    return DetectionArtifact.findById(args.artifactId).lean();
  }
  if (args.runId) {
    return DetectionArtifact.findOne({ runId: args.runId }).sort({ createdAt: -1 }).lean();
  }
  return DetectionArtifact.findOne({ mediaId: args.mediaId }).sort({ createdAt: -1 }).lean();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--mediaId')    out.mediaId    = argv[++i];
    else if (a === '--runId')      out.runId      = argv[++i];
    else if (a === '--artifactId') out.artifactId = argv[++i];
    else if (a === '--out')        out.out        = argv[++i];
  }
  return out;
}

function usage() {
  console.error('Usage: node scripts/inspectDetection.js (--mediaId <id> | --runId <id> | --artifactId <id>) [--out <dir>]');
  process.exit(2);
}

main().catch(err => {
  console.error('Error:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
