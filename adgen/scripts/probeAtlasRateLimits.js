'use strict';
// Atlas rate-limit probe. Measures the actual submit ceiling for the two
// billable endpoints prod uses (gpt-image-2/edit + Omni i2v/developer), so
// scaling decisions past current fleet size are informed by real numbers
// rather than published caps or guesses.
//
// SPENDS REAL MONEY. Dry-run by default; --yes + --cost-cap=<usd> required
// to actually submit. Reuses the exact axios transport shape from
// atlasImageService.submitAndPoll (URL, headers, maxRedirects:0,
// validateStatus:()=>true) so any limit prod would hit shows up here.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const fs = require('fs');
const zlib = require('zlib');

const BASE = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
const KEY = process.env.ATLAS_API_KEY;

const STATIC_MODEL = 'openai/gpt-image-2/edit';
const VIDEO_MODEL = 'google/gemini-omni-flash/image-to-video-developer';

// Measured unit costs (CLAUDE.md §2, MEASURED settled prices)
const STATIC_UNIT_USD = 0.067;
const VIDEO_UNIT_USD = 0.90;

const PHASE_A = { name: 'A: sustained (image)', count: 20, unit: STATIC_UNIT_USD, levels: [1, 2, 4, 8, 16] };
const PHASE_B = { name: 'B: burst (image)',     count: 50, unit: STATIC_UNIT_USD, sizes: ['1024x1024', '1088x1360', '2048x1152'] };
const PHASE_C = { name: 'C: video Omni',        count: 10, unit: VIDEO_UNIT_USD };

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dryRun: true, costCap: 0, phases: ['A', 'B', 'C'], output: null };
  for (const a of argv.slice(2)) {
    if (a === '--yes') args.dryRun = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--cost-cap=')) args.costCap = Number(a.split('=')[1]);
    else if (a.startsWith('--phases=')) args.phases = a.split('=')[1].split(',').map(s => s.trim().toUpperCase());
    else if (a.startsWith('--output=')) args.output = a.split('=')[1];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/probeAtlasRateLimits.js [flags]

  --dry-run             Print plan only, spend nothing (DEFAULT)
  --yes                 Actually submit (costs real money — requires --cost-cap)
  --cost-cap=<usd>      Refuse to run if estimated cost exceeds this
  --phases=A,B,C        Which phases to run (default: all three)
  --output=<path>       Write JSON results here (default: probe-results/<ts>.json)

Phases:
  A  Sustained image submits at concurrency [1,2,4,8,16] — 20 submits, ~$1.34
  B  Burst 50 image submits — ~$3.35
  C  10 concurrent Omni video submits — ~$9.00
`);
}

// ── minimal PNG generator (256×256 solid gray) ─────────────────────────────
// Embedding a base64 blob would work too; this keeps the script self-contained
// and lets us regenerate cleanly if a size ever needs to change.
function makeReferencePng(w = 256, h = 256, gray = 200) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crc32 = (buf) => {
    let c;
    if (!crc32.table) {
      crc32.table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc32.table[n] = c;
      }
    }
    c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // grayscale
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; raw.fill(gray, y * (w + 1) + 1, (y + 1) * (w + 1)); }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── transport (matches atlasImageService.submitAndPoll) ────────────────────
async function uploadRef() {
  const FormData = require('form-data');
  const buf = makeReferencePng();
  const fd = new FormData();
  fd.append('file', buf, { filename: 'probe-ref.png', contentType: 'image/png' });
  const res = await axios.post(`${BASE}/model/uploadMedia`, fd, {
    headers: { Authorization: `Bearer ${KEY}`, ...fd.getHeaders() },
    timeout: 60_000, validateStatus: () => true
  });
  if (res.status !== 200) throw new Error(`uploadMedia ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  const url = res.data?.data?.download_url;
  if (!url) throw new Error(`uploadMedia no URL: ${JSON.stringify(res.data).slice(0, 200)}`);
  return url;
}

async function submitStatic(refUrl, size = '1024x1024') {
  const submitStart = Date.now();
  const submit = await axios.post(`${BASE}/model/generateImage`, {
    model: STATIC_MODEL,
    prompt: 'photorealistic product on a plain white background, studio lighting',
    images: [refUrl],
    size, quality: 'medium'
    // NOTE: input_fidelity intentionally omitted — gpt-image-2/edit rejects it
    // ~22% of the time (fix landed in atlasImageService.buildParams same day).
  }, {
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    timeout: 60_000, validateStatus: () => true, maxRedirects: 0
  });
  return {
    submitStart, submitMs: Date.now() - submitStart,
    httpStatus: submit.status,
    predictionId: submit.data?.data?.id || submit.data?.id || null,
    retryAfter: submit.headers?.['retry-after'] || null,
    errCode: submit.status >= 400 ? (submit.data?.code || submit.data?.error?.code || null) : null,
    errBody: submit.status >= 400 ? JSON.stringify(submit.data).slice(0, 300) : null
  };
}

async function submitVideo(refUrl) {
  const submitStart = Date.now();
  const submit = await axios.post(`${BASE}/model/generateVideo`, {
    model: VIDEO_MODEL,
    prompt: 'slow cinematic reveal of the product on a plain white background, studio lighting, 10 seconds',
    images: [refUrl],
    aspect_ratio: '9:16', duration: 10, resolution: '1080p'
  }, {
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    timeout: 60_000, validateStatus: () => true, maxRedirects: 0
  });
  return {
    submitStart, submitMs: Date.now() - submitStart,
    httpStatus: submit.status,
    predictionId: submit.data?.data?.id || submit.data?.id || null,
    retryAfter: submit.headers?.['retry-after'] || null,
    errCode: submit.status >= 400 ? (submit.data?.code || submit.data?.error?.code || null) : null,
    errBody: submit.status >= 400 ? JSON.stringify(submit.data).slice(0, 300) : null
  };
}

async function pollUntilTerminal(predictionId, maxMs = 600_000) {
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < maxMs) {
    polls++;
    const res = await axios.get(`${BASE}/model/prediction/${predictionId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      timeout: 15_000, validateStatus: () => true
    });
    const d = res.data?.data || res.data || {};
    const status = d.status;
    if (['completed', 'failed', 'canceled'].includes(status)) {
      return { pollMs: Date.now() - t0, polls, finalStatus: status, price: Number(d.price) || null };
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return { pollMs: Date.now() - t0, polls, finalStatus: 'timeout', price: null };
}

// ── phase runners ──────────────────────────────────────────────────────────
async function runPhaseA(refUrl) {
  console.log(`\n═══ ${PHASE_A.name} ═══`);
  const results = [];
  for (const concurrency of PHASE_A.levels) {
    const wave = Math.min(concurrency, PHASE_A.count - results.length);
    if (wave <= 0) break;
    console.log(`  concurrency=${concurrency}, submitting ${wave} in parallel...`);
    const t0 = Date.now();
    const submits = await Promise.all(Array.from({ length: wave }, () => submitStatic(refUrl)));
    const submitWallMs = Date.now() - t0;
    // Poll settlements in parallel for accurate concurrent behaviour
    const settles = await Promise.all(submits.map(s =>
      s.predictionId ? pollUntilTerminal(s.predictionId) : Promise.resolve({ pollMs: 0, polls: 0, finalStatus: 'no-id', price: null })
    ));
    for (let i = 0; i < wave; i++) {
      results.push({ concurrency, wave, waveSubmitWallMs: submitWallMs, ...submits[i], ...settles[i] });
    }
    const codes = submits.map(s => s.httpStatus);
    console.log(`    HTTP: ${codes.join(', ')}  submitWall=${submitWallMs}ms`);
  }
  return { phase: 'A', results };
}

async function runPhaseB(refUrl) {
  console.log(`\n═══ ${PHASE_B.name} ═══`);
  console.log(`  firing ${PHASE_B.count} submits in parallel across ${PHASE_B.sizes.length} sizes...`);
  const t0 = Date.now();
  const submits = await Promise.all(Array.from({ length: PHASE_B.count }, (_, i) => {
    const size = PHASE_B.sizes[i % PHASE_B.sizes.length];
    return submitStatic(refUrl, size).then(r => ({ ...r, size }));
  }));
  const submitWallMs = Date.now() - t0;
  const settles = await Promise.all(submits.map(s =>
    s.predictionId ? pollUntilTerminal(s.predictionId) : Promise.resolve({ pollMs: 0, polls: 0, finalStatus: 'no-id', price: null })
  ));
  const codes = submits.reduce((m, s) => { m[s.httpStatus] = (m[s.httpStatus] || 0) + 1; return m; }, {});
  console.log(`  HTTP status distribution: ${JSON.stringify(codes)}  submitWall=${submitWallMs}ms`);
  return { phase: 'B', submitWallMs, results: submits.map((s, i) => ({ ...s, ...settles[i] })) };
}

async function runPhaseC(refUrl) {
  console.log(`\n═══ ${PHASE_C.name} ═══`);
  console.log(`  firing ${PHASE_C.count} Omni submits in parallel...`);
  const t0 = Date.now();
  const submits = await Promise.all(Array.from({ length: PHASE_C.count }, () => submitVideo(refUrl)));
  const submitWallMs = Date.now() - t0;
  const settles = await Promise.all(submits.map(s =>
    s.predictionId ? pollUntilTerminal(s.predictionId, 600_000) : Promise.resolve({ pollMs: 0, polls: 0, finalStatus: 'no-id', price: null })
  ));
  const codes = submits.reduce((m, s) => { m[s.httpStatus] = (m[s.httpStatus] || 0) + 1; return m; }, {});
  console.log(`  HTTP status distribution: ${JSON.stringify(codes)}  submitWall=${submitWallMs}ms`);
  return { phase: 'C', submitWallMs, results: submits.map((s, i) => ({ ...s, ...settles[i] })) };
}

// ── summary ────────────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(phase) {
  const ok = phase.results.filter(r => r.httpStatus === 200 && r.finalStatus === 'completed');
  const err = phase.results.filter(r => r.httpStatus !== 200);
  const submitMs = phase.results.map(r => r.submitMs).filter(Number.isFinite);
  const pollMs = ok.map(r => r.pollMs).filter(Number.isFinite);
  const prices = ok.map(r => r.price).filter(Number.isFinite);
  const codes = phase.results.reduce((m, r) => { const k = r.httpStatus; m[k] = (m[k] || 0) + 1; return m; }, {});
  const errCodes = err.reduce((m, r) => { const k = r.errCode || `HTTP_${r.httpStatus}`; m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    total: phase.results.length,
    ok: ok.length,
    err: err.length,
    httpCodes: codes,
    errCodes,
    submitMs: { p50: percentile(submitMs, 0.5), p90: percentile(submitMs, 0.9), p99: percentile(submitMs, 0.99) },
    pollMs: { p50: percentile(pollMs, 0.5), p90: percentile(pollMs, 0.9), p99: percentile(pollMs, 0.99) },
    settledPrice: { count: prices.length, total: prices.reduce((a, b) => a + b, 0), mean: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null }
  };
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv);
  const phases = args.phases.filter(p => ['A', 'B', 'C'].includes(p));
  if (!phases.length) { console.error('No valid phases selected.'); process.exit(1); }

  const estimate =
    (phases.includes('A') ? PHASE_A.count * PHASE_A.unit : 0) +
    (phases.includes('B') ? PHASE_B.count * PHASE_B.unit : 0) +
    (phases.includes('C') ? PHASE_C.count * PHASE_C.unit : 0);

  console.log('=== Atlas rate-limit probe ===');
  console.log(`  BASE:      ${BASE}`);
  console.log(`  KEY:       ${KEY ? KEY.slice(0, 8) + '…' + KEY.slice(-4) : '(missing)'}`);
  console.log(`  phases:    ${phases.join(', ')}`);
  console.log(`  estimate:  $${estimate.toFixed(2)}  (A:$${(PHASE_A.count * PHASE_A.unit).toFixed(2)}  B:$${(PHASE_B.count * PHASE_B.unit).toFixed(2)}  C:$${(PHASE_C.count * PHASE_C.unit).toFixed(2)})`);
  console.log(`  cost cap:  ${args.costCap ? '$' + args.costCap.toFixed(2) : '(unset)'}`);
  console.log(`  mode:      ${args.dryRun ? 'DRY-RUN (no submits)' : 'LIVE (submits + spends)'}`);

  if (args.dryRun) {
    console.log('\n🟡 Dry run. Re-run with --yes --cost-cap=<usd> to actually submit.');
    process.exit(0);
  }

  if (!KEY) { console.error('❌ ATLAS_API_KEY not set'); process.exit(1); }
  if (!args.costCap || args.costCap <= 0) { console.error('❌ --cost-cap=<usd> required with --yes'); process.exit(1); }
  if (estimate > args.costCap) {
    console.error(`❌ Estimated cost $${estimate.toFixed(2)} exceeds cap $${args.costCap.toFixed(2)}`);
    process.exit(1);
  }

  console.log('\n  Uploading reference PNG...');
  const refUrl = await uploadRef();
  console.log(`  refUrl: ${refUrl.slice(0, 80)}...`);

  const t0 = Date.now();
  const output = { startedAt: new Date().toISOString(), base: BASE, phases: {} };

  if (phases.includes('A')) output.phases.A = await runPhaseA(refUrl);
  if (phases.includes('B')) output.phases.B = await runPhaseB(refUrl);
  if (phases.includes('C')) output.phases.C = await runPhaseC(refUrl);

  output.completedAt = new Date().toISOString();
  output.wallMs = Date.now() - t0;

  console.log('\n═══ SUMMARY ═══');
  for (const p of Object.keys(output.phases)) {
    const s = summarize(output.phases[p]);
    console.log(`\n  Phase ${p}:`);
    console.log(`    OK:            ${s.ok}/${s.total}    err:${s.err}`);
    console.log(`    HTTP codes:    ${JSON.stringify(s.httpCodes)}`);
    if (Object.keys(s.errCodes).length) console.log(`    err codes:     ${JSON.stringify(s.errCodes)}`);
    console.log(`    submit ms:     p50=${s.submitMs.p50}  p90=${s.submitMs.p90}  p99=${s.submitMs.p99}`);
    console.log(`    poll   ms:     p50=${s.pollMs.p50}  p90=${s.pollMs.p90}  p99=${s.pollMs.p99}`);
    console.log(`    settled $:     n=${s.settledPrice.count}  total=$${s.settledPrice.total.toFixed(4)}  mean=$${(s.settledPrice.mean || 0).toFixed(4)}`);
    output.phases[p].summary = s;
  }

  const outPath = args.output || path.join('probe-results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n  Wrote: ${outPath}`);
  console.log(`  Wall:  ${(output.wallMs / 1000).toFixed(1)}s`);
})().catch(e => { console.error('probe failed:', e.message, e.stack); process.exit(1); });
