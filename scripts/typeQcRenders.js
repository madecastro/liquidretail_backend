#!/usr/bin/env node
//
// typeQcRenders.js — judge every rendered row for READABILITY and ON-BRAND FEEL.
//
// Owner, 2026-08-04: "make sure you closely scrutinize readability and whether
// they feel on brand. If they don't then regenerate."
//
// Reads a frame from each delivered render (the moment the type is on screen) and
// scores it against the defects that have actually been reported on this project,
// rather than a generic "is this nice" question:
//   - copy over a face                    (reported twice by the owner)
//   - the reviews/rating line illegible   (reported: "simply not legible")
//   - coloured or tacky type              (reported: "the red lettering ... tacky")
//   - a halo/shadow that kills crispness  (reported: "the halo is way too much")
//   - type clipped, overlapping, or outside the safe area
//
// It does NOT re-title anything itself. It emits a verdict file naming the rows
// that must be regenerated and WHY, so the regeneration is a deliberate step with
// a reason attached to each row.
//
//   node scripts/typeQcRenders.js --results=/tmp/typeexp/results.json --out=/tmp/typeexp/qc.json
//   node scripts/typeQcRenders.js --results=... --arms=armA,armB,armC
//   node scripts/typeQcRenders.js --results=... --dry-run
//
// SPEND: one vision call per (row, arm). A 30-row three-arm run is 90 calls of a
// few cents each. Ledgered, never auto-retried. Use --arms to narrow.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const fs = require('fs');
const axios = require('axios');
const { chatCompletion } = require('../services/atlasLlmService');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const has = (n) => args.includes(`--${n}`);

const RESULTS = flag('results', null);
const OUT = flag('out', null);
const DRY_RUN = has('dry-run');
const ARMS = (flag('arms', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_CALLS = parseInt(flag('max-calls', '120'), 10);
const FRAME_AT = flag('frame-at', '4.6');
const PASS_MARK = Number(flag('pass-mark', '3.5'));

function frameUrlFor(videoUrl, { at = FRAME_AT, width = 720 } = {}) {
  if (!videoUrl || !/res\.cloudinary\.com/.test(videoUrl)) return null;
  const marker = '/video/upload/';
  const i = videoUrl.indexOf(marker);
  if (i === -1) return null;
  return `${videoUrl.slice(0, i + marker.length)}so_${at},w_${width},c_scale/` +
    `${videoUrl.slice(i + marker.length).replace(/\.(mp4|mov|webm)(\?.*)?$/i, '')}.jpg`;
}

const SHAPE = `{
  "readability": 1-5,
  "onBrand": 1-5,
  "defects": ["typeOverFace" | "ratingLineIllegible" | "lowContrast" | "colouredType" |
              "halationOrBlur" | "clipped" | "overlapping" | "outsideSafeArea" | "crowded"],
  "worstProblem": "<= 100 chars, the single thing to fix, or empty if none",
  "verdict": "pass" | "regenerate",
  "notes": "<= 160 chars"
}`;

const SYSTEM = `You are a demanding art director reviewing a finished social advertisement before it goes
live for a paying client. You are looking for reasons to REJECT it. You answer with a single JSON
object and nothing else.`;

function promptFor(row, arm) {
  return `Review the TYPE on this finished ${row.brand} ad (${row.aspectRatio}).

Score two things, 1-5, where 3 is "acceptable but not good" and 5 is "I would show this to the client
without changes":
- "readability": can every line be read instantly at phone size? Small supporting lines and the
  review count are where this usually fails — judge the WORST line, not the headline.
- "onBrand": does the type feel like it belongs to this brand and to a professional paid ad? Type
  that looks like a default template, or a colour that looks arbitrary, is not on brand.

Known failure modes on this product — check each one specifically:
- type sitting over a person's face
- the star rating / review-count line too small or too low-contrast to read
- letterforms in a saturated colour (this product's rule is black or white type only)
- a glow, halo or heavy shadow that makes the type look soft instead of crisp
- text clipped at an edge, overlapping other text, or pushed outside the visible safe area

Be strict. If you would ask for a change, "verdict" is "regenerate".

Answer with exactly this JSON shape, no prose, no markdown fence:
${SHAPE}`;
}

const DEFECTS = ['typeOverFace', 'ratingLineIllegible', 'lowContrast', 'colouredType',
  'halationOrBlur', 'clipped', 'overlapping', 'outsideSafeArea', 'crowded'];

function normalizeVerdict(raw) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null; };
  const readability = num(raw?.readability);
  const onBrand = num(raw?.onBrand);
  const defects = Array.isArray(raw?.defects) ? raw.defects.filter((d) => DEFECTS.includes(d)) : [];
  // The model's own verdict is advisory; the SCORES decide, so one lenient
  // "pass" cannot wave through a 2/5 readability. A hard defect fails outright
  // regardless of score — these are the ones the owner has personally reported.
  const hardDefect = defects.some((d) => ['typeOverFace', 'colouredType', 'clipped', 'outsideSafeArea'].includes(d));
  const scored = readability != null && onBrand != null
    ? (readability + onBrand) / 2 >= PASS_MARK && readability >= 3
    : false;
  return {
    readability, onBrand, defects,
    worstProblem: String(raw?.worstProblem || '').slice(0, 100),
    notes: String(raw?.notes || '').slice(0, 160),
    modelVerdict: raw?.verdict === 'pass' ? 'pass' : 'regenerate',
    verdict: (!hardDefect && scored && raw?.verdict === 'pass') ? 'pass' : 'regenerate',
    failedBecause: hardDefect ? `hard defect: ${defects.join(',')}`
      : !scored ? `scores readability=${readability} onBrand=${onBrand} below the bar`
        : raw?.verdict !== 'pass' ? 'the reviewer asked for a change' : null,
  };
}

(async () => {
  if (!RESULTS) { console.error('need --results=<results.json>'); process.exit(2); }
  const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  const arms = ARMS.length ? ARMS : (results.columns || []).filter((c) => c !== 'baseline');
  console.log(`=== QC: ${Object.keys(results.rows || {}).length} rows x arms [${arms.join(', ')}] ===`);

  const verdicts = {};
  let calls = 0, regen = 0;

  for (const [adId, row] of Object.entries(results.rows || {})) {
    verdicts[adId] = {};
    for (const arm of arms) {
      const url = row[arm];
      if (!url) { verdicts[adId][arm] = { verdict: 'missing', failedBecause: 'no render for this arm' }; continue; }
      const frame = frameUrlFor(url);
      if (!frame) { verdicts[adId][arm] = { verdict: 'unjudged', failedBecause: 'no derivable frame' }; continue; }
      if (DRY_RUN) { verdicts[adId][arm] = { verdict: 'dry-run', frame }; continue; }
      if (calls >= MAX_CALLS) { verdicts[adId][arm] = { verdict: 'unjudged', failedBecause: 'max-calls reached' }; continue; }
      calls++;
      try {
        const res = await chatCompletion(
          { service: 'typeQcRenders', purpose: 'type-readability-qc', visionImages: 1 },
          {
            model: 'gemini-2.5-pro',
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: [
                { type: 'text', text: promptFor(row, arm) },
                { type: 'image_url', image_url: { url: frame } },
              ] },
            ],
            // Reasoning tokens come out of this budget on gemini-2.5 — too small
            // and the body comes back EMPTY but still billed.
            temperature: 0.0, max_tokens: 5000,
            response_format: { type: 'json_object' },
          }
        );
        const raw = res?.choices?.[0]?.message?.content || '';
        const finish = res?.choices?.[0]?.finish_reason || '?';
        if (!String(raw).trim()) throw new Error(`empty response (finish_reason=${finish})`);
        const v = normalizeVerdict(JSON.parse(String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '')));
        v.frame = frame;
        verdicts[adId][arm] = v;
        if (v.verdict === 'regenerate') regen++;
        console.log(`${v.verdict === 'pass' ? '✅' : '✖ '} ${row.brand} ${row.aspectRatio} [${arm}] ` +
          `r=${v.readability} b=${v.onBrand} ${v.defects.join(',') || '-'} ${v.worstProblem}`);
      } catch (err) {
        verdicts[adId][arm] = { verdict: 'unjudged', failedBecause: String(err.message || err).slice(0, 90) };
        console.warn(`⚠️  ${row.brand} [${arm}]: ${String(err.message).slice(0, 70)}`);
      }
    }
  }

  // Per-arm summary — the actual answer to "which approach is better".
  const summary = {};
  for (const arm of arms) {
    const vs = Object.values(verdicts).map((v) => v[arm]).filter((v) => v && v.readability != null);
    const avg = (k) => (vs.length ? +(vs.reduce((s, v) => s + v[k], 0) / vs.length).toFixed(2) : null);
    const defectCounts = {};
    for (const v of vs) for (const d of v.defects) defectCounts[d] = (defectCounts[d] || 0) + 1;
    summary[arm] = {
      judged: vs.length,
      passed: vs.filter((v) => v.verdict === 'pass').length,
      readability: avg('readability'), onBrand: avg('onBrand'), defects: defectCounts,
    };
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  const regenerate = [];
  for (const [adId, byArm] of Object.entries(verdicts)) {
    for (const [arm, v] of Object.entries(byArm)) {
      if (v.verdict === 'regenerate') regenerate.push({ adId, arm, reason: v.failedBecause, worst: v.worstProblem });
    }
  }
  const out = { generatedAt: new Date().toISOString(), llmCalls: calls, passMark: PASS_MARK, summary, verdicts, regenerate };
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`📝 wrote ${OUT}`); }
  console.log(`💰 billable vision calls: ${calls}`);
  console.log(`♻️  rows needing regeneration: ${regen}`);
  process.exit(0);
})().catch((err) => { console.error('💥', err); process.exit(1); });
