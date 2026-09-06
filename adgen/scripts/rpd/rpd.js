#!/usr/bin/env node
//
// rpd.js — Rapid Product Development harness CLI. A/B video models × prompt
// variants against the REAL production prompt builder, outside the Ad
// pipeline (no Mongo, no Ad rows, no CostLog). See scripts/rpd/README.md.
//
//   node scripts/rpd/rpd.js run <spec.json> [--live --max-usd N] [--out rpd-runs]
//   node scripts/rpd/rpd.js resume <runDir>
//   node scripts/rpd/rpd.js gallery <runDir>
//   node scripts/rpd/rpd.js note <runDir> <cellId|run> "text"
//   node scripts/rpd/rpd.js publish <runDir> [--project rs-rpd]
//   node scripts/rpd/rpd.js prompt [--kind video|static] [--key NAME] [--profile P]
//   node scripts/rpd/rpd.js models
//
// Dry-run is the default; --live is the only billable door and requires
// --max-usd. Money invariants pinned by scripts/verifyRpdHarness.js.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'config', 'defaults.env') });

const path = require('path');

// OFFLINE-SAFE LEDGER WRITES. The image path (atlasImageService.submitAndPoll)
// calls recordFlatCost → costTracker.persistCost → CostLog.create at its charge
// point. That write is wrapped in a try/catch, but with no mongoose CONNECTION
// the default `bufferCommands: true` queues it instead of failing: the process
// then refuses to exit until bufferTimeoutMS (10s) after the last write.
//
// GATED ON THE COMMAND, NOT ON MONGODB_URI (adversarial finding, 2026-08-18):
// keying off the env var was wrong twice over — this repo's `.env` almost
// always HAS a URI, so the guard never fired on the common run; and when a spec
// does use DB seed mode we genuinely connect, so real CostLog rows are written
// and buffering must stay on. What actually matters is whether THIS invocation
// connects, which only DB seed mode does — and that is a property of the spec,
// resolved below. Default to no buffering and let dbSeed re-enable it.
try {
  require('mongoose').set('bufferCommands', false);
} catch { /* mongoose absent is fine — nothing to disable */ }

function flag(args, name) {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}
// Supports both `--flag value` and `--flag=value`. A following token that is
// itself a flag is NOT a value — `--out --max-usd 5` must not name the run
// directory "--max-usd" (adversarial finding 5).
function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (next == null || next.startsWith('--')) {
    throw new Error(`rpd: ${name} needs a value (got ${next == null ? 'nothing' : `"${next}"`})`);
  }
  return next;
}

// Titling pass over settled masters. Shared by `run --live` and `resume` so
// "finished" means the same thing on both paths: settled → master on disk →
// titled (when the spec asks for titling). Free — no Atlas spend — so it is
// safe to re-run; failures keep the master (untitled ≠ lost) and are retried
// on the next resume unless a titled file already exists.
async function titlePass(runDir, manifest) {
  const titlingSpec = manifest.spec && manifest.spec.titling;
  if (!titlingSpec || !titlingSpec.enabled) return;
  const { titleCell } = require('./lib/titling');
  const { writeManifest } = require('./lib/manifest');
  const eligible = manifest.cells.filter((c) => c.status === 'done' && c.localPath && !c.titledPath);
  for (const cell of eligible) {
    console.log(`🎬 titling ${cell.id}…`);
    const t0 = Date.now();
    const res = await titleCell({ runDir, cell, titlingSpec });
    cell.timings = cell.timings || {};
    cell.timings.titlingMs = Date.now() - t0;
    if (res.timings) cell.timings.titling = res.timings;
    if (res.ok) {
      cell.titledPath = path.relative(runDir, res.titledPath);
      delete cell.titlingError;
    } else {
      cell.titlingError = res.error; // master kept — untitled ≠ lost
      console.warn(`   ⚠️ titling failed (master kept): ${res.error}`);
    }
    writeManifest(runDir, manifest);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'run') {
    const specPath = args[0];
    if (!specPath || specPath.startsWith('--')) throw new Error('usage: rpd run <spec.json> [--live --max-usd N] [--out dir] [--allow-duplicate-prompts]');
    const { runSpec } = require('./lib/runner');
    const { buildGallery } = require('./lib/gallery');
    const live = flag(args, '--live');
    const maxUsd = flagValue(args, '--max-usd') != null ? Number(flagValue(args, '--max-usd')) : null;
    const outRoot = flagValue(args, '--out') || 'rpd-runs';
    const upload = flag(args, '--upload');
    // Escape hatch for a DELIBERATE duplicate — e.g. submitting one fixed
    // input twice to measure generation variance. Off by default because the
    // common case is a prompt lever that silently stopped applying.
    const allowDuplicates = flag(args, '--allow-duplicate-prompts');
    const { runDir, manifest } = await runSpec(specPath, { live, maxUsd, outRoot, upload, allowDuplicates });

    // Optional titling pass over settled masters (spec.titling.enabled).
    if (live) await titlePass(runDir, manifest);

    console.log(`\nGallery: ${buildGallery(runDir)}`);
    console.log(`Next: node scripts/rpd/rpd.js note ${runDir} <cellId|run> "observation"`);
    console.log(`      node scripts/rpd/rpd.js publish ${runDir}`);
    return;
  }

  if (cmd === 'resume') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd resume <runDir>');
    const { resumeRun } = require('./lib/resume');
    const { buildGallery } = require('./lib/gallery');
    const manifest = await resumeRun(runDir);
    await titlePass(runDir, manifest); // free; makes resume finish cells the same way run does
    console.log(`Gallery: ${buildGallery(runDir)}`);
    return;
  }

  if (cmd === 'eval') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd eval <runDir> [--eval-max-usd 0.5]');
    const { evalRun } = require('./lib/autoEval');
    const { buildGallery } = require('./lib/gallery');
    const raw = flagValue(args, '--eval-max-usd');
    const maxUsd = raw != null ? Number(raw) : 0.5;
    if (!(Number.isFinite(maxUsd) && maxUsd > 0)) {
      throw new Error('rpd: --eval-max-usd must be a positive number (vision calls are billable)');
    }
    await evalRun(runDir, { maxUsd });
    console.log(`Gallery: ${buildGallery(runDir)}`);
    return;
  }

  // What can I change, and what does it say NOW? The grounding step for any
  // "what if we changed this part of the prompt" conversation — free and offline.
  if (cmd === 'prompt') {
    const cat = require('./lib/promptCatalog');
    const kind = (flagValue(args, '--kind') || 'video').toLowerCase();
    const key = flagValue(args, '--key') || null;
    const full = flag(args, '--full');

    if (kind === 'static') {
      const els = cat.staticElements();
      if (key) {
        const hit = els.find((e) => e.key === key);
        if (!hit) throw new Error(`rpd: unknown static element "${key}" (have: ${els.map((e) => e.key).join(', ')})`);
        if (hit.meaning) console.log(`\nWHAT IT DOES: ${hit.meaning}`);
        console.log(`\n=== ${hit.key} (static) — CURRENT TEXT ===\n`);
        console.log(hit.text || '(resolved to nothing — this block may be flag-gated off)');
        console.log(`\n=== to test a replacement, add this variant to spec.static.variants ===\n`);
        console.log(cat.exampleVariant('static', hit.key));
        return;
      }
      console.log('\nSTATIC prompt elements you can replace (spec.static.variants[].blocks):\n');
      for (const e of els) {
        console.log(`  ${e.key}`);
        if (e.meaning) console.log(`      WHAT IT DOES: ${e.meaning}`);
        console.log(`      NOW: ${e.text ? cat.truncate(e.text, 110) : '(flag-gated off)'}`);
      }
      console.log(`\nIntents available (spec.static.intent): ${cat.staticIntents().join(', ')}`);
      console.log('\nSee one in full:  node scripts/rpd/rpd.js prompt --kind static --key PRODUCT_FIDELITY');
      return;
    }

    // --core: print the prompt that is ACTUALLY submitted. Without this there
    // was no CLI way to see it (only manifest.json after a dry run), so anyone
    // told "use `patch`" would copy a find-string out of the LEGACY element
    // listing below and hard-error with "patch.find not present in prompt".
    if (flag(args, '--core')) {
      const { corePromptText } = require('../../src/services/veoPromptBuilder');
      const dur = flagValue(args, '--duration') != null ? Number(flagValue(args, '--duration')) : 8;
      console.log(`\n=== LIVE VIDEO PROMPT (CORE, durationSec=${dur}) — this is what gets submitted ===\n`);
      console.log(corePromptText(dur));
      console.log('\nCopy a `patch.find` string from THIS text, not from the element listing.');
      console.log('Only guidance / raw / patch change what is submitted; `directives` is inert.\n');
      return;
    }

    const profile = flagValue(args, '--profile') || 'gemini-omni';
    if (!cat.videoProfiles().includes(profile)) {
      throw new Error(`rpd: unknown profile "${profile}" (have: ${cat.videoProfiles().join(', ')})`);
    }
    const els = cat.videoElements(profile);
    if (key) {
      const hit = els.find((e) => e.key === key);
      if (!hit) throw new Error(`rpd: unknown video element "${key}" (have: ${els.map((e) => e.key).join(', ')})`);
      if (hit.meaning) console.log(`\nWHAT IT DOES: ${hit.meaning}`);
      console.log(`\n=== ${hit.key} (video, ${profile}) — CURRENT TEXT ===\n`);
      console.log(hit.text);
      // ⚠️ These per-element texts are the LEGACY assembled prompt. The live
      // video prompt is one frozen CORE paragraph, so a `directives` override
      // of this element does NOT change what is submitted — it builds a prompt
      // byte-identical to baseline and still bills ~$1.00. Measured 2026-09-06
      // on specs/example-prompt-ab.json. Point people at the levers that work.
      console.log(`\n=== to test a replacement ===\n`);
      console.log('⚠️  `directives` no longer changes the video prompt (it is now ONE frozen');
      console.log('    CORE paragraph). A directives-only variant bills full price for a');
      console.log('    prompt identical to baseline — the runner will refuse it on --live.');
      console.log('    Use one of these instead:');
      console.log('      guidance — prepend your text to the CORE prompt');
      console.log('      raw      — replace the whole prompt');
      console.log('      patch    — find/replace against the CORE text (see `rpd prompt --core`)');
      console.log('\n(legacy shape, kept for reference only:)\n');
      console.log(cat.exampleVariant('video', hit.key));
      return;
    }
    console.log(`\nVIDEO prompt elements — profile "${profile}".`);
    console.log('⚠️  LEGACY VIEW: the live prompt is one frozen CORE paragraph; overriding these');
    console.log('    via spec.variants[].directives is INERT and still bills. Use guidance / raw / patch.\n');
    for (const e of els) {
      console.log(`  ${e.key}`);
      if (e.meaning) console.log(`      WHAT IT DOES: ${e.meaning}`);
      console.log(`      NOW: ${full ? '\n      ' + e.text + '\n' : cat.truncate(e.text, 110)}`);
    }
    console.log(`\nProfiles: ${cat.videoProfiles().join(', ')}   (--profile <name>)`);
    console.log('See one in full:  node scripts/rpd/rpd.js prompt --key transitions');
    console.log('Static side:      node scripts/rpd/rpd.js prompt --kind static');
    return;
  }

  if (cmd === 'stats') {
    const { collectStats, formatTable, toCsv } = require('./lib/stats');
    const outRoot = flagValue(args, '--out') || 'rpd-runs';
    const rows = collectStats(outRoot);
    if (!rows.length) {
      console.log(`rpd stats: no run manifests under ${outRoot}`);
      return;
    }
    console.log(flag(args, '--csv') ? toCsv(rows) : formatTable(rows));
    return;
  }

  if (cmd === 'gallery') {
    const runDir = args[0];
    if (!runDir) throw new Error('usage: rpd gallery <runDir>');
    const { buildGallery } = require('./lib/gallery');
    console.log(buildGallery(runDir));
    return;
  }

  if (cmd === 'note') {
    const [runDir, scope, ...rest] = args;
    const text = rest.join(' ');
    if (!runDir || !scope || !text) throw new Error('usage: rpd note <runDir> <cellId|run> "text"');
    const { addNote } = require('./lib/manifest');
    const { buildGallery } = require('./lib/gallery');
    addNote(runDir, scope, text);
    console.log(`noted. Gallery: ${buildGallery(runDir)}`);
    return;
  }

  if (cmd === 'publish') {
    const runDir = args[0];
    if (!runDir) {
      throw new Error('usage: rpd publish <runDir> [--host netlify|cloudflare] [--site|--project rs-rpd] [--team <slug>] [--cli] [--no-slack]');
    }
    // Netlify is the default host: it keeps galleries on the same platform as the
    // frontend. Cloudflare Pages stays fully supported (and is the one with a
    // free real access gate via Zero Trust) — RPD_PUBLISH_HOST or --host picks.
    const host = (flagValue(args, '--host') || process.env.RPD_PUBLISH_HOST || 'netlify').toLowerCase();
    const target = flagValue(args, '--site') || flagValue(args, '--project') || 'rs-rpd';
    let url = null;
    if (host === 'netlify') {
      // API path by default: a token selects the account, so publishing does not
      // depend on which login `netlify switch` last left active. --cli forces the
      // CLI path for a machine that only has an interactive login.
      const team = flagValue(args, '--team');
      if (flag(args, '--cli')) {
        const { publishRunNetlify } = require('./lib/publishNetlify');
        ({ url } = publishRunNetlify(runDir, { site: target, team }));
      } else {
        const { publishRunNetlifyApi } = require('./lib/publishNetlifyApi');
        ({ url } = await publishRunNetlifyApi(runDir, { site: target, team }));
      }
    } else if (host === 'cloudflare' || host === 'pages') {
      const { publishRun } = require('./lib/publish');
      ({ url } = publishRun(runDir, { project: target }));
    } else {
      throw new Error(`rpd: unknown --host "${host}" (netlify | cloudflare)`);
    }

    // Announce it. Opt-in by env (RPD_SLACK_CHANNEL + SLACK_BOT_TOKEN): a
    // published gallery nobody hears about is a learning nobody shares. Never
    // fatal — the deploy already succeeded by this point.
    if (url && !flag(args, '--no-slack')) {
      const { readManifest } = require('./lib/manifest');
      const { postExperiment } = require('./lib/slack');
      try {
        const manifest = readManifest(runDir);
        const runNote = (manifest.observations || []).find((o) => !o.scope || o.scope === 'run');
        const res = await postExperiment({
          runName: manifest.name,
          galleryUrl: url,
          cells: manifest.cells || [],
          takeaway: runNote ? runNote.text : null
        });
        if (res.ok) console.log('Posted to Slack.');
        else if (!/not configured/.test(res.error || '')) console.warn(`Slack: ${res.error}`);
      } catch (err) {
        console.warn(`Slack: ${err.message}`);
      }
    }
    return;
  }

  if (cmd === 'models') {
    const { MODEL_CAPS, estimateRenderCostUsd } = require('../../src/services/atlasVideoService');
    console.log('\n═══ ATLAS (via videoRouter VIDEO_PROVIDER=atlas) ═══');
    for (const [slug, caps] of Object.entries(MODEL_CAPS)) {
      const dur = caps.defaultDuration || 8;
      const res = caps.defaultResolution || '720p';
      const est = estimateRenderCostUsd({ model: slug, durationSec: dur, resolution: res });
      console.log(`\n${slug}`);
      console.log(`  label:       ${caps.label || '-'} ${caps.selectable ? '(operator-selectable)' : ''}`);
      console.log(`  paramShape:  ${caps.paramShape}   refs: ${caps.maxReferenceImages || 1}   promptByteCap: ${caps.promptByteCap || 4096}`);
      console.log(`  aspects:     ${(caps.supportedAspectRatios || []).join(', ') || '-'}`);
      console.log(`  duration:    ${caps.durationEnum ? caps.durationEnum.join('/') : `${caps.minDuration || '?'}-${caps.maxDuration || '?'}`}s (default ${dur})`);
      console.log(`  resolutions: ${(caps.resolutions || []).join(', ') || '-'} (default ${res})`);
      const { UNVERIFIED_PRICING_SLUGS } = require('./lib/runner');
      const unv = UNVERIFIED_PRICING_SLUGS.has(slug) ? ' ⚠️ RATE UNVERIFIED — settled price may differ in either direction' : '';
      console.log(`  est @ ${dur}s/${res}: ${est != null ? `~$${est.toFixed(2)} (floor-grade estimate — settled price is the truth)${unv}` : 'NO PRICING DATA (live runs refused)'}`);
      if (caps.requiresVideoSeed) console.log('  requires a VIDEO seed — skipped by the harness (image seeds only today)');
    }

    console.log('\n\n═══ GEMINI DIRECT (videoRouter VIDEO_PROVIDER=gemini — the current live path) ═══');
    const gv = require('../../src/services/geminiVideoService');
    // GEMINI_VIDEO_RESOLUTION default is '1080p' (geminiVideoService.js
    // DEFAULT_RESOLUTION) but that constant isn't exported — read the real
    // env override if one is set, else use the documented default.
    const gDur = 10, gRes = process.env.GEMINI_VIDEO_RESOLUTION || '1080p';
    const gEst = gv.estimateCost({ durationSec: gDur, resolution: gRes });
    console.log(`\n${gv.MODEL}`);
    console.log(`  label:       ${gv.PROVIDER} direct (Google Developer API, not Atlas) — currently one production model`);
    console.log(`  endpoint:    ${gv.ENDPOINT}`);
    console.log(`  aspects:     ${[...gv.SUPPORTED_ASPECTS].join(', ')}`);
    console.log(`  duration:    3-10s, fractional allowed (default ${gDur})`);
    console.log(`  resolutions: ${[...gv.PRICED_RESOLUTIONS].join(', ')} (default ${gRes})`);
    console.log(`  seed:        NOT SUPPORTED by this API — repeatability means fixing every other input, not an RNG seed`);
    console.log(`  est @ ${gDur}s/${gRes}: ${gEst.costUsd != null ? `~$${gEst.costUsd.toFixed(2)} (${gEst.costSource})` : 'NO PRICING DATA'}`);
    console.log('  a spec.models entry matching /^gemini-/i routes here automatically');
    return;
  }

  console.error('rpd — rapid product development harness. Commands: run | resume | gallery | note | publish | models');
  console.error('See scripts/rpd/README.md');
  process.exit(cmd ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
