// scripts/rpd/lib/autoEval.js — vision grading of settled RPD cells.
//
// Turns a gallery into a dataset: every settled cell gets a machine verdict so
// a nightly loop can flag a regression without a human watching. Verdicts are
// ADVISORY — written as auto-notes badged "verify before trusting", never
// overwriting a human note, never gating anything.
//
// MONEY:
//   - Vision calls are billable (~$0.01-0.03 per 2-image check on
//     gemini-2.5-pro). They are gated by their OWN budget (`--eval-max-usd`,
//     default $0.50) which is SEPARATE from the generation cap: an eval must
//     never be able to consume budget the operator set aside for generations,
//     and a generation cap must never silently authorise eval spend.
//   - The budget is checked BEFORE each cell, using a conservative per-cell
//     estimate. Generation is already paid for by this point, so running out of
//     eval budget is a clean stop, never a failure.
//   - Statics reuse the production judge (adVisionQcService.judgeRender) rather
//     than a second rubric, so harness verdicts and production QC verdicts are
//     comparable. Video has no production judge, so it gets its own frames
//     rubric through the same model role.
//
// STATIC vs VIDEO: statics hand the plate straight to the judge. Video cannot
// be judged as a file, so ffmpeg extracts frames and those go in as data URIs
// (the vision API accepts `data:image/...;base64,` alongside https).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeManifest } = require('./manifest');

// Conservative per-cell ceiling for the budget gate. Measured 2-image QC is
// ~$0.01-0.03; video sends 5 images (seed + 4 frames) so it reasons longer.
// Over-estimating stops early (safe); under-estimating would overspend.
const EVAL_COST_CEILING_USD = { static: 0.04, video: 0.08 };

const VIDEO_FRAME_COUNT = 4;

function dataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// Evenly spaced frames across the clip. Returns absolute paths in a temp dir
// the caller is responsible for removing.
function extractFrames(videoPath, count = VIDEO_FRAME_COUNT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-frames-'));
  const res = spawnSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-i', videoPath,
    // fps filter chosen over -vf select so spacing does not depend on knowing
    // the frame count up front; `count` frames then cap with -frames:v.
    '-vf', `fps=${count}/8,scale=512:-2`,
    '-frames:v', String(count),
    path.join(dir, 'f%02d.png')
  ], { encoding: 'utf8', timeout: 120_000 });
  if (res.error || res.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`ffmpeg frame extraction failed: ${res.error ? res.error.message : res.stderr || `exit ${res.status}`}`);
  }
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
    .map((f) => path.join(dir, f));
  if (!frames.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('ffmpeg produced no frames');
  }
  return { dir, frames };
}

const VIDEO_RUBRIC = [
  'You are grading an AI-generated product video against the ORIGINAL product photo it was animated from.',
  'The video should animate a virtual camera over the supplied product photography without altering the product.',
  '',
  'Score each category 0-10 (10 = flawless):',
  '  seed_fidelity      — is the product identical to the original (colour, materials, logos, printed text, shape, proportions)? Any redrawn/regenerated detail scores low.',
  '  hallucinated_parts — did the model invent views, parts, tags, or angles absent from the supplied photo? Fewer inventions = higher score.',
  '  transition_quality — ghosting, double-exposure, cross-dissolve smear, morphing between frames. Clean single views = high score.',
  '  text_legibility    — is any text that appears on the product still crisp and correctly spelled?',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"categories":{"seed_fidelity":N,"hallucinated_parts":N,"transition_quality":N,"text_legibility":N},',
  ' "overall":N,"findings":["short, specific, frame-referenced"],"summary":"one sentence"}',
  'Judge only what the frames show. Do not speculate about motion smoothness between frames.'
].join('\n');

// Balanced-brace salvage: routed models ignore response_format often enough
// that a bare JSON.parse throws on a fenced or prose-wrapped reply.
function safeParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { /* fall through to salvage */ }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function evalVideoCell(cell, runDir, { chat, model }) {
  const abs = path.join(runDir, cell.localPath);
  const { dir, frames } = extractFrames(abs);
  try {
    const content = [
      { type: 'text', text: VIDEO_RUBRIC },
      { type: 'text', text: 'IMAGE 1 — ORIGINAL PRODUCT PHOTO:' },
      { type: 'image_url', image_url: { url: cell.seedUrlForEval } }
    ];
    frames.forEach((f, i) => {
      content.push({ type: 'text', text: `FRAME ${i + 1} of ${frames.length} (in order):` });
      content.push({ type: 'image_url', image_url: { url: dataUri(f) } });
    });
    const res = await chat(
      { stage: 'rpd_auto_eval', service: 'rpd', purposeTag: 'experiment_eval', visionImages: frames.length + 1 },
      {
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        // Thinking models spend reasoning tokens before the verdict; a tight
        // ceiling returns EMPTY content (measured on 2.5-pro). Unused ceiling
        // is free — billing is per token generated.
        max_tokens: 5000,
        response_format: { type: 'json_object' }
      }
    );
    const parsed = safeParseJson(res && res.choices && res.choices[0] && res.choices[0].message
      ? res.choices[0].message.content : null);
    if (!parsed) return { ok: false, error: 'vision reply was not parseable JSON' };
    return { ok: true, verdict: parsed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function evalStaticCell(cell, runDir, { judge, brandName }) {
  const abs = path.join(runDir, cell.localPath);
  // The production judge takes URLs; a local plate goes in as a data URI.
  const renderUrl = cell.uploadedUrl && /^https?:\/\//.test(cell.uploadedUrl)
    ? cell.uploadedUrl
    : dataUri(abs);
  const verdict = await judge({
    originalProductUrl: cell.seedUrlForEval,
    renderUrl,
    brandName: brandName || 'the brand',
    // Text expectations unknown: the harness does not assert copy strings, so
    // the judge must not fail a plate for text it was never told to expect.
    expectedTextUnknown: true
  });
  if (!verdict) return { ok: false, error: 'judge returned nothing' };
  return { ok: true, verdict };
}

function summarizeVerdict(verdict) {
  const cats = verdict.categories || {};
  const scores = Object.entries(cats)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([k, v]) => `${k} ${Number(v)}/10`);
  const overall = Number.isFinite(Number(verdict.overall)) ? `overall ${Number(verdict.overall)}/10` : null;
  const pass = verdict.pass === true ? 'PASS' : verdict.pass === false ? 'FAIL' : null;
  const findings = Array.isArray(verdict.findings) && verdict.findings.length
    ? ` Findings: ${verdict.findings.slice(0, 4).join(' · ')}`
    : '';
  return [
    [pass, overall].filter(Boolean).join(' '),
    scores.join(', '),
    verdict.summary ? String(verdict.summary) : '',
    findings
  ].filter(Boolean).join(' — ').trim();
}

// Grade every settled cell that does not already carry an auto verdict.
// deps are injectable so the offline harness can exercise this with no network.
async function evalRun(runDir, {
  maxUsd = 0.5,
  deps = {},
  log = console
} = {}) {
  const { readManifest } = require('./manifest');
  const manifest = readManifest(runDir);
  const chat = deps.chatCompletion
    || require('../../../services/atlasLlmService').chatCompletion;
  const judge = deps.judgeRender
    || require('../../../services/adVisionQcService').judgeRender;
  // 'ad-vision-qc' is a ROLE, resolved to google/gemini-2.5-pro by
  // atlasModelMap. Never pass a bare legacy id like gpt-4o here — those are
  // silently rerouted to a different model.
  const model = deps.model || 'ad-vision-qc';

  // The per-cell ceiling below is calibrated for gemini-2.5-pro. That role can
  // be REPOINTED by env (ATLAS_MODEL_AD_VISION_QC / AD_VISION_QC_MODEL), and a
  // pricier model would blow the ceiling silently while the notes still claimed
  // 'ad-vision-qc' — adversarial finding, 2026-08-18. So resolve the EFFECTIVE
  // model, record that, and refuse to spend on an unrecognised one.
  // Two hops, because resolveQcModel returns the ROLE name unless an env
  // override is set, and the role only becomes a real slug via atlasModelMap.
  // Checking the role string alone refused every normal run (measured).
  let effectiveModel = model;
  if (!deps.model) {
    try {
      const { resolveQcModel } = require('../../../services/adVisionQcService');
      if (typeof resolveQcModel === 'function') effectiveModel = resolveQcModel() || model;
    } catch { /* keep the role name */ }
  }
  let resolvedSlug = effectiveModel;
  try {
    const { resolveModel } = require('../../../services/atlasModelMap');
    const r = resolveModel(effectiveModel);
    if (r && r.atlas) resolvedSlug = r.atlas;
  } catch { /* fall back to whatever we have */ }
  const CALIBRATED = /gemini-2\.5-(pro|flash)/;
  if (!deps.chatCompletion && !deps.judgeRender && !CALIBRATED.test(String(resolvedSlug))) {
    throw new Error(
      `rpd eval: the vision model resolves to "${resolvedSlug}" (role "${effectiveModel}"), which the per-cell budget ceiling ` +
      `(static $${EVAL_COST_CEILING_USD.static} / video $${EVAL_COST_CEILING_USD.video}) was not calibrated for. ` +
      'Unset ATLAS_MODEL_AD_VISION_QC / AD_VISION_QC_MODEL, or measure that model and update ' +
      'EVAL_COST_CEILING_USD deliberately — a ceiling that under-states real spend is not a budget.'
    );
  }
  const brandName = (manifest.spec && manifest.spec.titling && manifest.spec.titling.brandName) || null;
  const seedUrl = manifest.spec && manifest.spec.seed ? manifest.spec.seed.url : null;
  if (!seedUrl) throw new Error('rpd eval: the manifest has no seed url to compare against');

  const targets = (manifest.cells || []).filter((c) =>
    c.status === 'done' && c.localPath && !(c.notes || []).some((n) => n.auto)
  );
  if (!targets.length) {
    log.log('rpd eval: nothing to grade (no settled, ungraded cells).');
    return manifest;
  }

  let spent = 0;
  let graded = 0;
  for (const cell of targets) {
    const ceiling = EVAL_COST_CEILING_USD[cell.kind === 'static' ? 'static' : 'video'];
    if (spent + ceiling > maxUsd) {
      log.warn(
        `rpd eval: stopping before ${cell.id} — the next check could reach ` +
        `$${(spent + ceiling).toFixed(2)} against --eval-max-usd $${maxUsd.toFixed(2)}. ` +
        `${graded} graded, ${targets.length - graded} left (re-run with a higher cap).`
      );
      break;
    }
    cell.seedUrlForEval = seedUrl;
    let out;
    try {
      out = cell.kind === 'static'
        ? await evalStaticCell(cell, runDir, { judge, brandName })
        : await evalVideoCell(cell, runDir, { chat, model });
    } catch (err) {
      out = { ok: false, error: err.message };
    }
    delete cell.seedUrlForEval;
    spent += ceiling; // charge the ceiling: the real figure is not returned here
    if (!out.ok) {
      log.warn(`  ⚠️  ${cell.id}: eval failed — ${out.error}`);
      cell.autoEvalError = out.error;
      writeManifest(runDir, manifest);
      continue;
    }
    cell.notes = cell.notes || [];
    cell.notes.push({
      at: new Date().toISOString(),
      auto: true,
      // The EFFECTIVE model, not the role name: a repointed role must be
      // visible on the verdict that it produced.
      model: resolvedSlug,
      text: summarizeVerdict(out.verdict)
    });
    cell.autoEval = out.verdict;
    delete cell.autoEvalError;
    graded++;
    writeManifest(runDir, manifest);
    log.log(`  🤖 ${cell.id}: ${summarizeVerdict(out.verdict).slice(0, 120)}`);
  }

  manifest.autoEval = {
    at: new Date().toISOString(),
    model: resolvedSlug,
    role: model,
    graded,
    budgetUsd: maxUsd,
    estimatedSpendUsd: Number(spent.toFixed(4)),
    note: 'estimatedSpendUsd charges a per-check CEILING, not a settled price. atlasLlmService may '
      + 'retry (ATLAS_LLM_MAX_ATTEMPTS) and can fall back to a direct provider, so a single check can '
      + 'cost more than one call — treat this as an order-of-magnitude bound, and the model gate above '
      + 'as what keeps it honest.'
  };
  writeManifest(runDir, manifest);
  log.log(`\nrpd eval: graded ${graded}/${targets.length} cell(s), ≤ ~$${spent.toFixed(2)} of eval budget.`);
  return manifest;
}

module.exports = {
  evalRun,
  extractFrames,
  safeParseJson,
  summarizeVerdict,
  VIDEO_RUBRIC,
  EVAL_COST_CEILING_USD
};
