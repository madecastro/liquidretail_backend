// scripts/rpd/lib/atlasPoll.js — FREE Atlas reads for the RPD harness:
// poll a prediction to settlement, read its settled price, download output.
//
// MONEY RULE: nothing in this file may submit. It is shared by the run path
// and the resume path; resume imports ONLY this module, which is what makes
// `rpd resume` structurally incapable of spending (same invariant shape as
// services/titlingResumeService — pinned by scripts/verifyRpdHarness.js).

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  peekPrediction,
  parseAtlasSettledPrice
} = require('../../../services/atlasVideoService');

const BASE_URL = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';

const POLL_MS = () => parseInt(process.env.RPD_POLL_INTERVAL_MS, 10)
  || parseInt(process.env.ATLAS_POLL_INTERVAL_MS, 10) || 15000;
const POLL_BUDGET_MS = () => parseInt(process.env.RPD_POLL_TIMEOUT_MS, 10) || 15 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll one prediction until terminal or the budget runs out. Polls are free;
// a timeout leaves the receipt in the manifest for a later `rpd resume`.
async function pollToSettlement(predictionId, { onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    const peek = await peekPrediction(predictionId);
    if (peek.state === 'done' || peek.state === 'failed') return peek;
    if (Date.now() - start > POLL_BUDGET_MS()) {
      return {
        state: 'timeout',
        message: `still ${peek.state} after ${Math.round((Date.now() - start) / 1000)}s — receipt kept; run \`rpd resume\` later`
      };
    }
    if (onTick) onTick(peek, Date.now() - start);
    await sleep(POLL_MS());
  }
}

// The settled `price` is the ONLY figure that may be reported as spend
// (owner rule — estimates are floor-grade). Free GET; also returns the
// provider-side timing telemetry Atlas publishes on the settled prediction
// (`executionTime`, `timings.inference`, …) for time forecasting.
async function fetchSettledDetail(predictionId) {
  try {
    const res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` },
      timeout: 15000,
      validateStatus: () => true
    });
    const data = res.data?.data || {};
    return {
      price: parseAtlasSettledPrice(data.price),
      executionTime: data.executionTime ?? null,
      timings: data.timings ?? null,
      status: data.status ?? null
    };
  } catch {
    return { price: null, executionTime: null, timings: null, status: null };
  }
}

async function fetchSettledPrice(predictionId) {
  return (await fetchSettledDetail(predictionId)).price;
}

// Time a free GET of each prepared reference URL. For Cloudinary crop URLs
// the FIRST fetch pays the on-the-fly transform (cold derivation), which is
// exactly the latency Atlas pays on the production path — so this measures a
// real, forecastable component of total generation time. Records the CDN
// cache header so cold vs warm is distinguishable.
async function probeUrls(urls) {
  const out = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxRedirects: 3,
        validateStatus: () => true
      });
      out.push({
        url,
        ms: Date.now() - t0,
        status: res.status,
        bytes: res.data ? res.data.length : 0,
        cache: res.headers?.['x-cache'] || res.headers?.['cf-cache-status'] || null
      });
    } catch (err) {
      out.push({ url, ms: Date.now() - t0, status: null, error: err.message });
    }
  }
  return out;
}

async function downloadVideo(videoUrl, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await axios.get(videoUrl, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 3 // free GET — CDN redirects are fine here
  });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.data.on('error', reject);
  });
  return destPath;
}

// Shared by run + resume: take a cell that holds a receipt, poll it to
// settlement, download the output, and record the settled price. Mutates the
// cell in place; caller persists the manifest.
async function settleCell(cell, runDir, log = console.log) {
  const peek = await pollToSettlement(cell.predictionId, {
    onTick: (p, elapsed) => log(`   … ${cell.id}: ${p.state} (${Math.round(elapsed / 1000)}s)`)
  });
  if (peek.state === 'timeout') {
    cell.status = 'submitted';
    cell.error = peek.message;
    return cell;
  }
  if (peek.state === 'failed') {
    cell.status = 'failed';
    cell.error = peek.message || 'prediction failed';
    cell.charged = peek.charged ?? null; // tri-state; null = unknown = assume charged
    if (peek.priceUsd != null) { cell.costUsd = peek.priceUsd; cell.costSource = 'actual'; }
    return cell;
  }
  cell.videoUrl = peek.videoUrl;
  cell.settledAt = new Date().toISOString();
  if (cell.submittedAt) cell.latencyMs = Date.parse(cell.settledAt) - Date.parse(cell.submittedAt);
  const rel = path.join('cells', cell.id, 'master.mp4');
  const dl0 = Date.now();
  const dest = await downloadVideo(peek.videoUrl, path.join(runDir, rel));
  cell.localPath = rel;
  cell.timings = cell.timings || {};
  cell.timings.queueToTerminalMs = cell.latencyMs ?? null;
  cell.timings.downloadMs = Date.now() - dl0;
  try { cell.timings.downloadBytes = fs.statSync(dest).size; } catch { /* non-fatal */ }
  const detail = await fetchSettledDetail(cell.predictionId);
  cell.timings.atlasExecutionTime = detail.executionTime;
  cell.timings.atlasTimings = detail.timings;
  if (detail.price != null) {
    cell.costUsd = detail.price;
    cell.costSource = 'actual';
  } // else: keep the estimate; a row still on 'estimated' means the price was
    // never published, not that the formula is authoritative.
  cell.status = 'done';
  cell.charged = true;
  return cell;
}

module.exports = {
  pollToSettlement, fetchSettledPrice, fetchSettledDetail,
  probeUrls, downloadVideo, settleCell
};
