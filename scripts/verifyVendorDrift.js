#!/usr/bin/env node
'use strict';
//
// verifyVendorDrift — the check that would have caught tonight's repeated
// "fixed it in backend, never ported to adgen" mistake, AND the quieter
// cousin: a fully implemented module copied into src/services/ that
// nothing requires (campaignRunHeartbeat.js, PR #16).
//
// ── WHY A MANIFEST, NOT BYTE-EQUALITY ──────────────────────────────────
// adgen vendors ~230 files from liquidretail_backend. A naive
// "vendored files must be byte-identical" check is useless: adgen has
// large legitimate divergence (usableAttribution, composeCorrectiveOverride,
// buildQcRetryArgs, submitEditImageWithSeedFallback; directImageRenderService
// is not a wholesale copy). Byte-equality would cry wolf on every one of
// those, every run, and get muted in a day.
//
// The question this harness answers is bounded: "has anyone LOOKED at this
// file since backend moved on it?" A committed manifest records, per
// vendored file, the sha256 of the backend blob we last reconciled against
// plus the last backend commit that touched that path (human provenance)
// plus a short reason when the copy is a deliberate fork or is present
// but unwired.
//
//   (a) DELIBERATE FORK — adgen differs; backend hash still matches the
//       recorded look → pass. The difference is attested, not ignored.
//   (b) DRIFT — backend's blob hash no longer matches the recorded look
//       and nobody updated the manifest → FAIL. This fires whether the
//       file is a fork or not: a fork whose upstream moved still needs
//       a human to re-look (port, or re-attest).
//   (c) VENDORED-BUT-DEAD — the file exists, exports something, and
//       nothing under src/ requires it or names it via
//       path.join(__dirname, 'lit', …). FAIL unless the manifest marks
//       it unused with a reason. campaignRunHeartbeat.js would have
//       failed this from the day it was copied. Reachability starts at
//       adgen-owned files (entrypoint/renderer/orchestrator/…), so a
//       module only required from another unused copy is still dead.
//       unused exempts THIS check only — backend drift still FAILs.
//
// ── HOW VENDORED FILES ARE IDENTIFIED ──────────────────────────────────
// Derived, not hand-maintained: walk src/, strip the leading `src/`, ask
// the sibling backend whether that relative path exists at the comparison
// ref. Intersection = vendored. Adgen-only files (entrypoint, renderer,
// orchestrator, remotion child supervisor) are out. Backend-only files
// are out (verifyRequireGraph.js already fails a require of a file that
// exists in backend and was never copied).
//
// ── HASH vs COMMIT SHA ─────────────────────────────────────────────────
// The FAIL signal is a content hash of the backend file (sha256 of the
// blob at origin/main, not of adgen's copy). A backend commit sha of the
// whole repo would flag all ~230 files every time origin/main moved on
// an unrelated path — that is the wolf. A per-file last-touching-commit
// sha is closer, but merge commits and empty-touch commits can retouch a
// path without changing bytes, and it requires complete git history.
// Hash is the actual question: "did the bytes we last looked at change?"
// The last-touching commit sha is stored alongside as provenance so a
// failure can print `git log <recorded>..<current> -- path` instead of
// leaving a human to reconstruct that.
//
// ── BACKEND ABSENT / UNEXPECTED REVISION ───────────────────────────────
// Backend location: scripts/lib/siblingBackend.js (ADGEN_BACKEND_PATH,
// else ../liquidretail_backend). Absent → drift SKIPPED with an INFO
// line, exit 0 for that part; dead-module check still runs against the
// manifest. We never need the backend working tree at a particular
// commit: we read `git show origin/main:<path>` (override
// ADGEN_BACKEND_REF). A dirty feature-branch checkout is ignored. If
// git is missing we hash the working tree and say so. We do not fetch.
//
// ── RECONCILE ──────────────────────────────────────────────────────────
// The FAIL message prints the exact command. After looking at the
// backend diff, either port the change and then:
//
//   node scripts/verifyVendorDrift.js --reconcile services/foo.js --reason "…"
//
// or re-attest a still-deliberate fork with a new reason. --seed adds
// any newly discovered files at the current backend ref without
// clobbering existing reasons. The suite path never writes.
//
// ── SUITE, NOT AN OPT-IN SCRIPT ────────────────────────────────────────
// Tonight's evidence is that an opt-in check does not run. This file
// matches verify*.js so runVerifySuite.js picks it up. Dead-module
// check is local (no backend). Drift skips cleanly when backend is
// absent so a narrow CI clone does not go red for the wrong reason.
//
// Fully offline: fs + git show of an already-fetched ref. No DB, no
// network, no API key, no new npm dependency.
//
const fs = require('fs');
const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const {
  MANIFEST_VERSION,
  sha256Hex,
  resolveRefSha,
  readBackendBlob,
  loadManifest,
  saveManifest,
  analyze,
  makeEntry,
  findDeadServices,
} = require('./lib/vendorDrift');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'vendor-manifest.json');
const BACKEND_ROOT = resolveBackendRoot(ROOT);

// Known reasons applied at --seed for files that already differ. These
// are the 2026-08-24 snapshot; --reconcile is how they get updated.
const SEED_FORK_REASONS = {
  'models/Ad.js':
    'comment-only: adgen still documents AD_VISION_QC_ENABLED env; backend retired the env fallback',
  'models/SystemConfig.js':
    'adgen keeps the env-fallback bridge on the QC split fields; backend reads SystemConfig only',
  'services/adVisionQcService.js':
    'adgen still honors AD_VISION_QC_ENABLED / pipeline env fallbacks; backend retired them',
  'services/alertService.js':
    'adgen dropped notify() channel override; backend still has it',
  'services/atlasModelMap.js':
    'adgen routing table is a narrower extract; not a wholesale copy',
  'services/brandFontIngestService.js':
    'UNPORTED: backend #323 cross-sheet CSS generics / icon-font drop (port in flight at seed)',
  'services/brandScriptExecutor.js':
    'adgen video QC/titling path (Remotion child OOM/timeout); colourway gate hunk-ported from backend #324',
  'services/directImageRenderService.js':
    'deliberate fork: adgen owns usableAttribution, composeCorrectiveOverride, buildQcRetryArgs, submitEditImageWithSeedFallback; colourway gate hunk-ported from backend #324; logo-safe-box inset hunk-ported from backend fix/logo-safe-area',
  'services/fontClassification.js':
    'UNPORTED: backend #323 icon-font role-evidence drop (port in flight at seed)',
  'services/plateIntelService.js':
    'adgen extract is smaller than backend (backend grew after the copy)',
  'services/quoteProvenance.js':
    'comment-only: adgen dropped CLAUDE.md §4 cross-ref; colourway sibling comment ported from backend #324',
  'services/remotionRenderService.js':
    'adgen child-supervisor / isolation path; not a wholesale copy',
  'services/staticAdIntents.js':
    'hunk-ported backend #325 (adgen #18); remaining divergence is not a wholesale copy',
  'services/systemConfigService.js':
    'adgen QC resolvers still fall through to env; backend does not',
  'services/titlingResumeService.js':
    'adgen-only QC-verdict guard + remotion-child-OOM retry; ported independently of backend',
};

const SEED_UNUSED_REASONS = {
  'services/adReadinessService.js': 'backend ad-readiness HTTP surface; adgen renderer does not call it',
  'services/adgenBridge.js': 'backend→adgen handshake copy; adgen is the callee, not the caller',
  'services/aiVideoPosterService.js': 'backend poster path; adgen does not invoke it',
  'services/amazonService.js': 'Amazon marketplace scrape is backend-owned',
  'services/atlasLlmStreamService.js': 'streaming LLM path not used by the renderer',
  'services/atlasTextService.js': 'backend text helper; renderer uses atlasLlmService / atlasImageService',
  'services/bootRecoveryService.js': 'backend boot-recovery sweeper; not wired into adgen entrypoint (look before wiring)',
  'services/brandScripts/u_beauty.script.js': 'brand-specific script, not in adgen\'s canonical set',
  'services/brandStyles/index.js': 'backend brand-style registry; adgen does not load it',
  'services/capabilityRegistry.js': 'operator-agent capability surface is backend-owned',
  'services/creativeMatcherCore.js': 'backend matcher; adgen does not call it',
  'services/enrichmentReconciler.js': 'backend catalog enrichment; adgen does not call it',
  'services/frontendOriginValidator.js': 'HTTP origin check for backend API routes',
  'services/generationGate.js': 'backend /generate 409 gate; adgen is downstream of the mint (look before wiring)',
  'services/imagePreviewUrl.js': 'backend preview helper; no adgen caller',
  'services/inFlight.js': 'backend process-wide inflight counter; adgen uses a per-run map in renderer.js (look before wiring)',
  'services/judgeService.js': 'legacy judge; adgen uses aiJudgeService',
  'services/mediaAssignmentService.js': 'backend media assignment; adgen does not call it',
  'services/nerService.js': 'backend NER; adgen does not call it',
  'services/openaiService.js': 'backend OpenAI wrapper; adgen spends via Atlas',
  'services/pushToShopify.js': 'Shopify push is backend-owned',
  'services/queuedArchiveSweeper.js': 'backend archive sweeper; not wired into adgen entrypoint',
  'services/reviewAdapters/index.js': 'adapter fan-out is backend scrape; adgen only requires helpers.js via quoteRotationService',
  'services/salesDemosService.js': 'sales-demo admin is backend-owned',
  'services/semaphore.js': 'backend semaphore helper; no adgen caller',
  'services/spendGuard.js': 'backend spend cap; adgen has costTracker but does not require spendGuard (look before wiring — money-adjacent)',
  'services/strandedRunSweeper.js': 'backend stranded-run sweeper; not wired into adgen entrypoint (look before wiring)',
  'services/textEmbeddingService.js': 'backend embeddings; adgen does not call it',
  'services/videoCompositeService.js': 'backend composite helper; no adgen caller',
  'services/videoPreviewUrl.js': 'backend preview helper; no adgen caller',
  'services/videoRefPrewarmService.js': 'backend ref-prewarm; no adgen caller',
  'services/whisperService.js': 'backend transcription; adgen does not call it',
  'services/yoloService.js': 'backend detection; adgen does not call it',
  'services/adArchiveDigest.js': 'only reached from queuedArchiveSweeper, which adgen does not boot',
  'services/adRegenerateService.js': 'only reached from unused capability executor / backend regenerate HTTP',
  'services/blockClassifier.js': 'scrape bot-classifier; only reached from unused http scrape path',
  'services/brandStyles/camelback_flowers.js': 'backend brand-style module; adgen does not load the registry',
  'services/brandStyles/u_beauty.js': 'backend brand-style module; adgen does not load the registry',
  'services/capabilityExecutors/adRegenerate.js': 'only required from unused capabilityRegistry',
  'services/geminiImageService.js': 'only reached from unused backend scrape/enrichment path',
  'services/httpScrapeClient.js': 'only reached from unused vendor adapters / scrape services',
  'services/imageRecoveryService.js': 'only reached from unwired bootRecovery / strandedRunSweeper',
  'services/reviewAdapters/bazaarvoice.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/fera.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/judgeme.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/junip.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/okendo.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/powerreviews.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/reviewsio.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/stamped.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewAdapters/yotpo.js': 'only required from unused reviewAdapters/index.js; adgen uses helpers.js only',
  'services/reviewSiteProfileService.js': 'backend review-site admin; adgen does not call it',
  'services/spendReceipt.js': 'only reached from unused spendGuard (look before wiring — money-adjacent)',
  'services/superAdminService.js': 'backend super-admin surface; adgen does not call it',
  'services/titlingResumeService.js': 'only required from unwired bootRecoveryService — not on adgen renderer path (look before wiring)',
  'services/ugcVideoPipeline.js': 'backend UGC pipeline; adgen renderer does not call it',
}

// Reconstruction probes: if the manifest had recorded the backend blob
// from BEFORE these commits, today's origin/main would flag drift.
// These are the measured "fixed in backend, inert in adgen until ported"
// events of 2026-08-24.
const HISTORICAL_PROBES = [
  {
    rel: 'services/quoteProvenance.js',
    beforeSpec: '5ff4671b^',
    landed: '5ff4671b',
    label: 'backend #318 usableAttribution',
  },
  {
    rel: 'services/ratingDisplay.js',
    beforeSpec: '887b4f46^',
    landed: '887b4f46',
    label: 'backend #321 brand-consistency (ratingDisplay)',
  },
  {
    rel: 'services/staticAdIntents.js',
    beforeSpec: '7cc2c7df^',
    landed: '7cc2c7df',
    label: 'backend #325 rating furniture',
  },
];

const FORK_HELD_PROBE = 'services/directImageRenderService.js';

function parseArgs(argv) {
  const opts = {
    seed: false,
    reconcile: null,
    reason: null,
    unused: false,
    prove: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--seed') opts.seed = true;
    else if (arg === '--reconcile') { opts.reconcile = argv[++i]; if (!opts.reconcile) throw new Error('--reconcile needs a path'); }
    else if (arg.startsWith('--reconcile=')) opts.reconcile = arg.slice('--reconcile='.length);
    else if (arg === '--reason') { opts.reason = argv[++i]; if (opts.reason == null) throw new Error('--reason needs a string'); }
    else if (arg.startsWith('--reason=')) opts.reason = arg.slice('--reason='.length);
    else if (arg === '--unused') opts.unused = true;
    else if (arg === '--no-prove') opts.prove = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 70).join('\n');
  console.log(header);
  console.log(`
USAGE
  node scripts/verifyVendorDrift.js
      Check the committed manifest against backend origin/main (or
      ADGEN_BACKEND_REF) and fail on drift / untracked / stale / dead.

  node scripts/verifyVendorDrift.js --seed
      Add every currently discovered vendored file at the current backend
      ref. Does not clobber an existing entry's status/reason.

  node scripts/verifyVendorDrift.js --reconcile services/foo.js --reason "…"
      Record a new look at foo.js. If adgen still differs, status=fork
      and --reason is required. If identical, status=synced.

  node scripts/verifyVendorDrift.js --reconcile services/foo.js --unused --reason "…"
      Mark foo.js as present-but-unwired (dead-module check will not fail it).
      Backend drift still FAILs — unused is not a drift mute.

  --no-prove   skip the historical / in-memory probes (used by --seed/--reconcile).
`);
}

function normalizeRel(p) {
  let rel = String(p).split(path.sep).join('/');
  if (rel.startsWith('src/')) rel = rel.slice(4);
  if (rel.startsWith('/')) rel = rel.replace(/^\/+/, '');
  return rel;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 8) : '(none)';
}

function shortHash(h) {
  return h ? String(h).slice(0, 12) : '(none)';
}

function emptyManifest() {
  return {
    version: MANIFEST_VERSION,
    backendRef: null,
    backendHead: null,
    generatedAt: new Date().toISOString(),
    files: {},
  };
}

function seedStatusFor(v, graphDeadSet) {
  if (graphDeadSet.has(v.rel)) {
    return {
      status: 'unused',
      reason: SEED_UNUSED_REASONS[v.rel] || 'no src/ requirer at seed (bulk extract); replace this reason if it should be wired',
    };
  }
  if (v.identical === false) {
    return {
      status: 'fork',
      reason: SEED_FORK_REASONS[v.rel] || 'adgen bytes differ from backend at seed; replace this reason on next reconcile',
    };
  }
  return { status: 'synced', reason: undefined };
}

function runSeed() {
  if (!BACKEND_ROOT) {
    console.error('verifyVendorDrift --seed: no sibling backend checkout; cannot hash backend blobs.');
    process.exit(1);
  }
  const existing = loadManifest(MANIFEST_PATH) || emptyManifest();
  const report = analyze({ adgenRoot: ROOT, manifest: existing, backendRoot: BACKEND_ROOT, includeSha: true });
  const deadForSeed = findDeadServices({
    adgenRoot: ROOT,
    vendoredRels: report.vendored.map((v) => v.rel),
    unusedSet: new Set(),
  }).dead;
  const graphDeadSet = new Set(deadForSeed);

  const files = Object.assign({}, existing.files);
  let added = 0;
  let kept = 0;
  for (const v of report.vendored) {
    if (files[v.rel]) { kept += 1; continue; }
    const { status, reason } = seedStatusFor(v, graphDeadSet);
    files[v.rel] = makeEntry(v, status, reason);
    added += 1;
  }
  const next = {
    version: MANIFEST_VERSION,
    backendRef: report.backendRef,
    backendHead: report.backendHead,
    generatedAt: new Date().toISOString(),
    files,
  };
  saveManifest(MANIFEST_PATH, next);
  console.log(`verifyVendorDrift --seed: wrote ${MANIFEST_PATH}`);
  console.log(`  discovered ${report.vendored.length} vendored file(s) at ${report.backendRef} ${shortSha(report.backendHead)}`);
  console.log(`  added ${added}, kept ${kept}`);
  console.log(`  identical ${report.identicalCount}, divergent ${report.divergentCount}, unwired-at-seed ${deadForSeed.length}`);
}

function runReconcile(rel, reason, unused) {
  if (!BACKEND_ROOT) {
    console.error('verifyVendorDrift --reconcile: no sibling backend checkout.');
    process.exit(1);
  }
  rel = normalizeRel(rel);
  const existing = loadManifest(MANIFEST_PATH) || emptyManifest();
  const report = analyze({ adgenRoot: ROOT, manifest: existing, backendRoot: BACKEND_ROOT, includeSha: true });
  const v = report.vendored.find((x) => x.rel === rel);
  if (!v) {
    console.error(`verifyVendorDrift --reconcile: ${rel} is not a vendored file (no backend counterpart at ${report.backendRef}).`);
    process.exit(1);
  }
  let status;
  let usedReason = reason ? String(reason).trim() : '';
  if (unused) {
    status = 'unused';
    if (!usedReason) {
      console.error('--unused requires --reason (why is this copy allowed to stay unwired?)');
      process.exit(1);
    }
  } else if (v.identical === false) {
    status = 'fork';
    if (!usedReason) {
      console.error(`${rel} still differs from backend; --reason is required to re-attest a fork.`);
      process.exit(1);
    }
  } else {
    status = 'synced';
    usedReason = '';
  }
  existing.files[rel] = makeEntry(v, status, usedReason || undefined);
  existing.backendRef = report.backendRef;
  existing.backendHead = report.backendHead;
  existing.generatedAt = new Date().toISOString();
  saveManifest(MANIFEST_PATH, existing);
  console.log(`verifyVendorDrift --reconcile: ${rel}`);
  console.log(`  status=${status} hash=${shortHash(v.backendHash)} sha=${shortSha(v.backendSha)} identical=${v.identical}`);
  if (usedReason) console.log(`  reason: ${usedReason}`);
}

function printDriftHint(item, backendRoot, backendRef) {
  const recordedSha = item.recorded.backendSha;
  const currentSha = item.current.backendSha;
  const lines = [
    `  ${item.rel}`,
    `    last look: ${shortSha(recordedSha)}  sha256:${shortHash(item.recorded.backendHash)}…  status=${item.recorded.status}${item.recorded.reason ? ` — ${item.recorded.reason}` : ''}`,
    `    backend now: ${backendRef} ${shortSha(currentSha)}  sha256:${shortHash(item.current.backendHash)}…`,
  ];
  if (backendRoot && recordedSha && currentSha) {
    lines.push(`    what changed: git -C "${backendRoot}" log --oneline ${recordedSha}..${currentSha} -- ${item.rel}`);
  }
  lines.push(`    after looking (port or keep the fork): node scripts/verifyVendorDrift.js --reconcile ${item.rel} --reason "…"`);
  return lines;
}

function runHistoricalProbes(manifest, backendRoot, backendRef) {
  const results = [];
  if (!backendRoot) {
    return { skipped: 'no backend', results };
  }
  for (const probe of HISTORICAL_PROBES) {
    const beforeSha = resolveRefSha(backendRoot, probe.beforeSpec);
    const beforeBlob = beforeSha ? readBackendBlob(backendRoot, beforeSha, probe.rel) : null;
    if (!beforeBlob || !manifest.files[probe.rel]) {
      results.push({
        label: probe.label,
        rel: probe.rel,
        skipped: `could not read ${probe.rel} at ${probe.beforeSpec} or it is not in the manifest (shallow clone?)`,
      });
      continue;
    }
    const overlay = JSON.parse(JSON.stringify(manifest));
    overlay.files[probe.rel] = Object.assign({}, overlay.files[probe.rel], {
      backendHash: sha256Hex(beforeBlob.bytes),
      backendSha: beforeSha,
    });
    const overlaid = analyze({ adgenRoot: ROOT, manifest: overlay, backendRoot, includeSha: false });
    const flagged = overlaid.drift.find((d) => d.rel === probe.rel) || null;
    results.push({
      label: probe.label,
      rel: probe.rel,
      wouldFlag: !!flagged,
      beforeSpec: probe.beforeSpec,
      landed: probe.landed,
      flagged,
    });
  }
  return { skipped: null, results };
}

function runDeadProbe() {
  // Temporary tree, not a repo edit. An adgen-only entry (not vendored)
  // requires A, A requires B, C exports and has no requirer. C is
  // campaignRunHeartbeat.js's shape. The 33 currently-unwired services
  // are seeded unused so the suite starts clean; this probe cannot rot
  // when the real tree has no live dead file.
  const fakeRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vendor-drift-dead-'));
  const src = path.join(fakeRoot, 'src');
  const services = path.join(src, 'services');
  fs.mkdirSync(services, { recursive: true });
  fs.writeFileSync(path.join(src, 'entry.js'), `'use strict';\nrequire('./services/a');\n`);
  fs.writeFileSync(path.join(services, 'a.js'), `'use strict';\nrequire('./b');\nmodule.exports = { a: true };\n`);
  fs.writeFileSync(path.join(services, 'b.js'), `'use strict';\nmodule.exports = { b: true };\n`);
  fs.writeFileSync(path.join(services, 'c.js'), `'use strict';\nmodule.exports = { c: true };\n`);
  let dead;
  try {
    dead = findDeadServices({
      adgenRoot: fakeRoot,
      vendoredRels: ['services/a.js', 'services/b.js', 'services/c.js'],
      unusedSet: new Set(),
    }).dead;
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
  return dead;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`verifyVendorDrift: ${err.message}`);
    process.exit(2);
  }
  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.seed) { runSeed(); return; }
  if (opts.reconcile) { runReconcile(opts.reconcile, opts.reason, opts.unused); return; }

  const manifest = loadManifest(MANIFEST_PATH);
  const failures = [];
  const infos = [];
  let pass = 0;

  function check(label, fn) {
    try {
      fn();
      pass += 1;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }

  check('manifest present', () => {
    if (!manifest) {
      throw new Error(
        `missing ${path.relative(ROOT, MANIFEST_PATH)} — first run is noisy by design. ` +
        `Seed today's backend state with: node scripts/verifyVendorDrift.js --seed`
      );
    }
  });

  let report;
  try {
    report = analyze({
      adgenRoot: ROOT,
      manifest: manifest || emptyManifest(),
      backendRoot: BACKEND_ROOT,
    });
  } catch (err) {
    console.error(`verifyVendorDrift: ${err.message}`);
    process.exit(1);
  }

  if (report.skippedDrift) infos.push(report.skippedDrift);
  if (report.worktreeFallback) {
    infos.push('backend git ref origin/main|origin/master|HEAD not found — hashing the working tree (unexpected revision risk)');
  }
  if (report.backendRoot && report.backendRef && report.backendHead && report.workingTreeHead &&
      report.backendHead !== report.workingTreeHead) {
    infos.push(
      `comparing backend ${report.backendRef} ${shortSha(report.backendHead)}; ` +
      `working tree HEAD ${shortSha(report.workingTreeHead)} is ignored`
    );
  }
  if (report.backendRef === 'HEAD') {
    infos.push('backend origin/main and origin/master were missing — comparing HEAD. Fetch the trunk or set ADGEN_BACKEND_REF.');
  }

  check('no untracked vendored files', () => {
    if (!report.untracked.length) return;
    const names = report.untracked.map((v) => `    ${v.rel}`).join('\n');
    throw new Error(
      `${report.untracked.length} vendored file(s) are not in the manifest (copied, never recorded). ` +
      `node scripts/verifyVendorDrift.js --seed  OR  --reconcile <path> --reason "…"\n${names}`
    );
  });

  check('no stale manifest entries', () => {
    if (!report.stale.length) return;
    throw new Error(
      `${report.stale.length} manifest path(s) no longer exist in adgen src/ and backend ${report.backendRef}: ` +
      report.stale.join(', ')
    );
  });

  check('no backend drift since last look', () => {
    if (!report.drift.length) return;
    const lines = [`${report.drift.length} file(s) moved on backend since the last recorded look:`];
    for (const item of report.drift) lines.push(...printDriftHint(item, report.backendRoot, report.backendRef));
    throw new Error(lines.join('\n'));
  });

  check('synced files still match backend', () => {
    if (report.backendAbsent) return;
    const lies = [];
    for (const v of report.vendored) {
      const entry = manifest && manifest.files[v.rel];
      if (!entry || entry.status !== 'synced') continue;
      if (v.identical === false) lies.push(v.rel);
    }
    if (!lies.length) return;
    throw new Error(
      `${lies.length} file(s) recorded as synced but adgen now differs from backend ` +
      `(adgen moved, or a port was incomplete). ` +
      `node scripts/verifyVendorDrift.js --reconcile <path> --reason "…"\n    ` +
      lies.join('\n    ')
    );
  });

  check('no vendored-but-dead service modules', () => {
    if (!report.dead.length) return;
    const names = report.dead.map((rel) => `    ${rel}`).join('\n');
    throw new Error(
      `${report.dead.length} vendored service module(s) export something and have no require() / ` +
      `path.join(__dirname,…) reference anywhere in src/ (campaignRunHeartbeat.js's original shape). ` +
      `Wire the caller, or: node scripts/verifyVendorDrift.js --reconcile <path> --unused --reason "…"\n${names}`
    );
  });

  if (opts.prove) {
    check('dead-module detector flags a module with no requirer', () => {
      const dead = runDeadProbe();
      if (!dead.includes('services/c.js')) {
        throw new Error(`expected services/c.js in ${JSON.stringify(dead)}`);
      }
      if (dead.includes('services/b.js') || dead.includes('services/a.js')) {
        throw new Error(`false dead: ${JSON.stringify(dead)}`);
      }
      infos.push(`dead-module catch: fixture services/c.js (no requirer) flagged; a.js/b.js (wired from an adgen-only entry) not flagged`);
    });

    if (report.backendRoot && manifest) {
      const hist = runHistoricalProbes(manifest, report.backendRoot, report.backendRef);
      for (const p of hist.results) {
        if (p.skipped) {
          infos.push(`historical ${p.label} skipped: ${p.skipped}`);
        } else {
          check(`historical ${p.label} would flag`, () => {
            if (!p.wouldFlag) {
              throw new Error(
                `overlaying ${p.rel}'s last look at ${p.beforeSpec} (pre-${p.landed}) ` +
                `did not flag drift against ${report.backendRef}`
              );
            }
          });
          if (p.wouldFlag) {
            infos.push(
              `historical catch: ${p.label} — recording ${p.rel} at ${p.beforeSpec} ` +
              `(parent of ${p.landed}) flags drift against ${report.backendRef} ${shortSha(report.backendHead)}`
            );
          }
        }
      }

      check(`deliberate fork ${FORK_HELD_PROBE} is recorded and not flagged`, () => {
        const entry = manifest.files[FORK_HELD_PROBE];
        if (!entry) throw new Error(`${FORK_HELD_PROBE} missing from manifest`);
        if (entry.status !== 'fork') throw new Error(`${FORK_HELD_PROBE} status=${entry.status}, expected fork`);
        if (!entry.reason) throw new Error(`${FORK_HELD_PROBE} fork has empty reason`);
        const flagged = report.drift.some((d) => d.rel === FORK_HELD_PROBE);
        if (flagged) throw new Error(`${FORK_HELD_PROBE} is in the drift list — the fork was not held`);
        const v = report.vendored.find((x) => x.rel === FORK_HELD_PROBE);
        if (v && v.identical === true) {
          throw new Error(`${FORK_HELD_PROBE} is byte-identical; fork probe needs a real divergence`);
        }
        infos.push(
          `fork held: ${FORK_HELD_PROBE} status=fork, adgen differs, backend hash matches last look — not flagged`
        );
      });
    } else {
      infos.push('historical / fork probes skipped (no backend or no manifest)');
    }
  }

  const vendoredN = report.vendored.length;
  console.log(
    `verifyVendorDrift: ${vendoredN} vendored file(s)` +
    (report.backendRef ? ` vs backend ${report.backendRef} ${shortSha(report.backendHead)}` : ' (backend absent)') +
    `; identical ${report.identicalCount}, divergent ${report.divergentCount}` +
    `, drift ${report.drift.length}` +
    `, untracked ${report.untracked.length}` +
    `, stale ${report.stale.length}, dead ${report.dead.length}` +
    `, forks-held ${report.forksHeld.length}.`
  );
  for (const line of infos) console.log(`  info: ${line}`);

  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifyVendorDrift: ${failures.length} of ${total} check(s) FAILED`);
    for (const f of failures) {
      for (const line of String(f).split('\n')) console.log(`   ${line}`);
    }
    process.exit(1);
  }
  console.log(`\n✅ verifyVendorDrift: ${total}/${total} checks passed`);
}

main();
