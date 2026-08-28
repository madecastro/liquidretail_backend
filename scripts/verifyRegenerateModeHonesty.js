#!/usr/bin/env node
/**
 * Offline harness: the regenerate API must never REPORT a mode it does not RUN.
 * No DB, no network, no API key — every dependency is stubbed through
 * require.cache before the service under test is loaded.
 *
 * ── THE DEFECT THIS PINS (measured 2026-08-26; all three layers agreed on a lie)
 *
 * The frontend regenerate panel (liquidretail, ProductAds/index.tsx
 * AdDetailModal — canonical across five surfaces since PR #77) showed a
 * video-only checkbox, DEFAULT UNCHECKED, reading:
 *
 *     "Also re-roll the video (~$1.85, ~5 min) — otherwise only the chrome regenerates"
 *
 * and, while unchecked, "Chrome-only regenerate does not re-submit Omni."
 *
 * Unchecked posted `mode:'light'`. `routes/ads.js` defaulted an absent mode to
 * 'light' and ECHOED it back in the 202. And `regenerateAd` hardcoded
 * `effMode = 'full'`, so `runVideoFull` ran and `videoRouter.generateForAd`
 * submitted ONE billable Omni master (~$0.90 settled) every single time.
 *
 * The operator was told "only the chrome regenerates", the API confirmed
 * `mode:'light'`, and a video generation was billed. A billing
 * misrepresentation, not cosmetic doc drift.
 *
 * ── WHAT IS AND IS NOT BEING FIXED
 *
 * Video LIGHT mode was DELIBERATELY DELETED in a23801e7 (2026-07-07) along with
 * the HTML/Puppeteer chrome pipeline it depended on, and that decision stands.
 * The deleted `runVideoLight` only honoured an operator prompt through
 * `chromeService.generateForAd({operatorPrompt})` — an LLM-driven HTML chrome
 * generator that is now dead code (CLAUDE.md §1) — and on the brand-script path
 * that is 100% of renders today it already ignored the prompt outright. A
 * re-implemented light mode would be a button that DEMANDS a refinement prompt
 * it cannot act on, then re-renders deterministic chrome over the same master.
 * So the resolution is the other one: the PROMISE is corrected to match the
 * BEHAVIOUR. Billing behaviour is deliberately UNCHANGED by this PR.
 *
 * That is precisely why group B asserts the billing side. The justification for
 * correcting copy instead of code is that a 'light' request really does buy a
 * video generation. If that ever stops being true, the copy shipped here
 * becomes wrong in the other direction and both must be revisited together.
 *
 * Run: node scripts/verifyRegenerateModeHonesty.js
 */
const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const SERVICES = path.join(ROOT, 'services');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ── stub plumbing ─────────────────────────────────────────────────────────
// Resolve a module id the way services/adRegenerateService.js would, then
// pre-seed require.cache so the real file is never loaded. Established
// pattern in this repo (scripts/verifyPmaxVideoExpansion.js and friends).
//
// A module we cannot resolve is left alone rather than cached under a bogus
// key: require() resolves BEFORE consulting the cache, so a fake key would be
// silently dead and the real (or missing) module would load anyway. Returning
// false lets the caller see that, instead of believing in a stub that is not
// installed.
function stub(id, exports) {
  let resolved;
  try {
    resolved = require.resolve(id, { paths: [SERVICES] });
  } catch {
    return false;
  }
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports, children: [], paths: []
  };
  return true;
}

// A chainable Mongoose-query stand-in: .select().lean() → the given doc.
function query(doc) {
  const q = {
    select: () => q,
    lean:   async () => doc,
    then:   (res, rej) => Promise.resolve(doc).then(res, rej),
    catch:  (fn) => Promise.resolve(doc).catch(fn)
  };
  return q;
}

function makeModel(doc, log, label) {
  return {
    findById:  (id) => { log.push(`${label}.findById(${String(id)})`); return query(doc); },
    findOne:   () => query(doc),
    updateOne: async () => { log.push(`${label}.updateOne`); return { modifiedCount: 1 }; },
    countDocuments: async () => 0
  };
}

const AD_ID = '6a6a4d58054561c15f3ff8a2';

// Load the service under test against a fresh set of stubs + counters.
function loadServiceWithStubs() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('adRegenerateService')) delete require.cache[k];
  }

  const calls = {
    generateForAd: 0, prepareStoryboard: 0, renderDirectImage: 0,
    chrome: 0, qc: 0, stages: [], log: [], unstubbed: []
  };

  const videoAd = {
    _id: AD_ID, kind: 'video', brandId: 'b1', mediaId: 'm1',
    aspectRatio: '9:16', platformFormat: 'meta_stories_9_16',
    variantKind: 'product_image', veoVideoUrl: 'https://cdn/existing-master.mp4',
    copy: {}, campaignRunIds: []
  };

  const need = (id, exports) => { if (!stub(id, exports)) calls.unstubbed.push(id); };

  need('../models/Ad',          makeModel(videoAd, calls.log, 'Ad'));
  need('../models/Media',       makeModel({ _id: 'm1', brandId: 'b1', fileType: 'image' }, calls.log, 'Media'));
  need('../models/Brand',       makeModel({ _id: 'b1', name: 'Test', advertiserId: 'a1', styleTheme: 'x' }, calls.log, 'Brand'));
  need('../models/CampaignRun', makeModel(null, calls.log, 'CampaignRun'));

  need('./videoRouter', {
    prepareStoryboard: async () => { calls.prepareStoryboard++; return { storyboard: null }; },
    // THE BILLABLE CALL. One invocation = one Omni submit = real money.
    generateForAd: async () => {
      calls.generateForAd++;
      return {
        videoUrl: 'https://cdn/new-master.mp4', aspectRatio: '9:16',
        prompt: 'p', storyboard: null, model: 'omni', referenceImages: []
      };
    },
    MODEL_CAPS: {}
  });
  need('./brandScriptExecutor', {
    // renderBrandScriptAndSave is kept on the stub (never expected to be
    // called after the 2026-08-28 titling removal — see B6) so a stray
    // call fails loudly as "is not a function" would if it were dropped
    // entirely by mistake, rather than silently no-op'ing.
    renderBrandScriptAndSave: async () => { calls.chrome++; return { skipped: false }; },
    qcAndStampVideoAd: async () => { calls.qc++; return {}; }
  });
  need('./cloudinaryService',        { uploadBufferToCloudinary: async () => ({ secure_url: 'https://cdn/x.png' }) });
  need('./directImageRenderService', { renderDirectImage: async () => { calls.renderDirectImage++; return { url: 'https://cdn/i.png' }; } });
  need('./campaignAdsGenerationService', { resolveDeriveFromMaster: () => null });
  need('./seededUniverseService',        { isUgcFirstSeedingEnabled: () => false });
  need('./ugcVideoPipeline',             { preparePassthroughMaster: async () => ({ passthrough: false, skip: false, reason: 'harness' }) });
  need('./adgenBridge',                  { isAdgenRendererEnabled: () => false });
  need('./adStage',                      { adStage: () => {} });

  class CancelledError extends Error {}
  need('./progressService', {
    CancelledError,
    startRun: async () => ({
      checkpoint: async () => {},
      stage: (s) => { calls.stages.push(s); },
      succeed: async () => {},
      fail: async () => {}
    })
  });

  const svc = require(path.join(SERVICES, 'adRegenerateService.js'));
  return { svc, calls };
}

// ── A — the pure resolver is the single source of truth ───────────────────
function groupA() {
  const { svc, calls } = loadServiceWithStubs();
  check('A0 every dependency the harness intends to stub resolved',
    calls.unstubbed.length === 0, `unstubbed: ${calls.unstubbed.join(', ')}`);

  check('A1 resolveEffectiveRegenMode is exported as a function',
    typeof svc.resolveEffectiveRegenMode === 'function',
    `got ${typeof svc.resolveEffectiveRegenMode}`);
  if (typeof svc.resolveEffectiveRegenMode !== 'function') return;

  // Sweep the parameter space rather than sampling one point near a threshold:
  // every (kind, requestedMode) pair a client can produce must resolve to full.
  const kinds = ['video', 'image', null, undefined, 'VIDEO', 'unknown'];
  const modes = ['light', 'full', null, undefined, '', 'LIGHT', 'chrome', 0, false, 'true'];
  const offenders = [];
  for (const kind of kinds) {
    for (const requestedMode of modes) {
      const got = svc.resolveEffectiveRegenMode({ kind, requestedMode });
      if (got !== 'full') offenders.push(`{kind:${String(kind)},mode:${String(requestedMode)}}→${String(got)}`);
    }
  }
  check('A2 every (kind, requestedMode) pair resolves to full',
    offenders.length === 0, offenders.slice(0, 5).join(' '));

  check('A3 a bare call with no argument resolves to full',
    svc.resolveEffectiveRegenMode() === 'full', String(svc.resolveEffectiveRegenMode()));

  // The whole point: it must NOT honour the request. A resolver that ever
  // returned the caller's 'light' would re-open the misrepresentation.
  check('A4 requestedMode light is ignored, never echoed',
    svc.resolveEffectiveRegenMode({ kind: 'video', requestedMode: 'light' }) === 'full');
}

// ── B — EXECUTION: a "light" video request bills one video generation ─────
// Runs the real performRegeneration (the shared work function both the local
// path and adgen's consumer drive) with the caller asking for 'light', and
// counts provider submits.
async function groupB() {
  const { svc, calls } = loadServiceWithStubs();

  check('B0 performRegeneration is exported', typeof svc.performRegeneration === 'function');
  if (typeof svc.performRegeneration !== 'function') return;

  let threw = null;
  try {
    await svc.performRegeneration({
      adId: AD_ID, kind: 'video', prompt: 'warmer light',
      mode: 'light',                    // ← the operator left the checkbox unchecked
      requestedBy: 'harness', videoModel: null, promptOverride: null,
      videoPromptRaw: null, videoPromptGuidance: null, imagePromptRaw: null,
      startedAt: Date.now()
    });
  } catch (e) {
    threw = e;
  }

  // performRegeneration funnels its own errors into markComplete, so a throw
  // reaching here is harness plumbing, not a product failure.
  check('B1 performRegeneration ran without a plumbing throw', !threw, threw && threw.message);

  // ASSERT THE BRANCH WAS ACTUALLY REACHED — a count of 1 only means something
  // if the video worker really executed. Two independent witnesses: the
  // storyboard prep only runVideoFull calls, and the stages it pushes.
  check('B2 the VIDEO worker branch was reached (storyboard prep ran)',
    calls.prepareStoryboard === 1, `prepareStoryboard=${calls.prepareStoryboard}`);
  check('B3 the video worker pushed its own progress stage',
    calls.stages.includes('generating video'), `stages=[${calls.stages.join(',')}]`);
  check('B4 the static worker was NOT reached',
    calls.renderDirectImage === 0, `renderDirectImage=${calls.renderDirectImage}`);

  // THE MONEY ASSERTION. mode:'light' still buys exactly one Omni master —
  // never zero (that would mean light silently became real and the shipped
  // copy is now wrong) and never two (a double-bill).
  check('B5 mode:light on a video ad submits EXACTLY ONE billable video generation',
    calls.generateForAd === 1, `generateForAd=${calls.generateForAd}`);

  // CORRECTED 2026-08-28 (backend titling removal, owner directive: "remove
  // and disable the backend titling function"). This used to assert chrome
  // (renderBrandScriptAndSave) ran once, so "otherwise only the chrome
  // regenerates" never even described a cheaper subset — it described a
  // strict subset of what ran. runVideoFull no longer calls
  // renderBrandScriptAndSave at all (brand or no brand); it always ships
  // the raw regenerated master through qcAndStampVideoAd instead. The money
  // point survives unchanged: mode:'light' still buys a full video worth of
  // work (Omni submit above, plus this vision-QC pass), not a cheaper
  // subset.
  check('B6 chrome/titling never runs any more (backend titling removed) — qcAndStampVideoAd ran instead',
    calls.chrome === 0 && calls.qc === 1, `chrome=${calls.chrome} qc=${calls.qc}`);
}

// ── C — the route reports the mode it will RUN, never the one asked for ───
function groupC() {
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8');
  // Strip comments before scanning: this repo has twice been burned by a source
  // regex satisfied by the very COMMENT documenting the thing it checks.
  const handler = sliceRegenerateHandler(stripComments(routeSrc));

  check('C0 the regenerate route handler was located', !!handler,
    'could not slice POST /:id/regenerate out of routes/ads.js');
  if (!handler) return;

  const modeLine = handler.split('\n').find(l => /^\s*mode:/.test(l));
  check('C1 the 202 response sets a mode field', !!modeLine, 'no `mode:` line in the handler');
  if (modeLine) {
    const trimmed = modeLine.trim().replace(/,$/, '');
    const expr    = trimmed.replace(/^mode:\s*/, '');

    // The value may be the resolver call inlined, OR a local assigned from it
    // (the shipped shape computes `billedMode` once so the stale-client log
    // and the response cannot drift apart). Accept either, and RESOLVE the
    // indirection rather than trusting the name — a check that accepted any
    // identifier would pass on `mode` itself.
    const RESOLVER = 'resolveEffectiveRegenMode';
    let derived = expr.includes(RESOLVER);
    let how = 'inlined';
    if (!derived && /^[A-Za-z_$][\w$]*$/.test(expr)) {
      const assign = new RegExp(`(?:const|let|var)\\s+${expr}\\s*=\\s*[^;]*${RESOLVER}`);
      derived = assign.test(handler);
      how = `via local \`${expr}\``;
    }
    check(`C2 the 202 mode is derived from ${RESOLVER} (${how})`, derived, trimmed);

    // The old shape was `mode: ad.kind === 'image' ? 'full' : mode` — a bare
    // reference to the request-derived variable. Forbid that ending outright.
    check('C3 the 202 mode does not end in a bare `mode` reference',
      !/(^|[^.\w])mode$/.test(expr), trimmed);
    check('C4 the 202 mode is not a light literal',
      !/['"]light['"]/.test(expr), trimmed);
  }

  // The handler may still ACCEPT mode (back-compat). Assert it does, so a
  // future change that 400s an older client is deliberate and visible.
  check('C5 the handler still accepts req.body.mode for back-compat',
    /req\.body\?\.mode/.test(handler));

  // The route's doc comment IS the API contract operators and agents read.
  const docStart = routeSrc.indexOf('// POST /api/ads/:id/regenerate');
  const docEnd   = routeSrc.indexOf("router.post('/:id/regenerate'");
  const docBlock = docStart >= 0 && docEnd > docStart ? routeSrc.slice(docStart, docEnd) : '';
  check('C6 the route doc block was located', docBlock.length > 0);
  if (docBlock) {
    check('C7 the doc block no longer claims light leaves Veo unchanged',
      !/Veo unchanged/i.test(docBlock), 'stale "Veo unchanged" contract still documented');
    check('C8 the doc block says mode is ignored',
      /ignored/i.test(docBlock), 'doc block does not state mode is accepted-and-ignored');
  }
}

// Bound the slice on a SYNTACTIC boundary (the next top-level `router.` call),
// never a magic character count that drifts stale.
function sliceRegenerateHandler(code) {
  const start = code.indexOf("router.post('/:id/regenerate'");
  if (start < 0) return null;
  const after = code.indexOf('\nrouter.', start + 10);
  return code.slice(start, after > 0 ? after : code.length);
}

function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';          // code | line | block | sq | dq | tpl | re
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line';  i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq';  out += c; i++; continue; }
      if (c === '"') { state = 'dq';  out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      if (c === '/' && isRegexStart(out)) { state = 're'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line')  { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i++; }
      continue;
    }
    // inside a literal: copy verbatim, honour escapes
    out += c;
    if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
    if (state === 'sq'  && c === "'") state = 'code';
    if (state === 'dq'  && c === '"') state = 'code';
    if (state === 'tpl' && c === '`') state = 'code';
    if (state === 're'  && c === '/') state = 'code';
    i++;
  }
  return out;
}

// Regex-vs-division: a `/` opens a regex literal only where a value cannot
// already have ended. Without this a `/pattern/` desyncs the tokenizer for the
// rest of the file — a real bug class this repo has hit before.
function isRegexStart(soFar) {
  const prev = soFar.replace(/\s+$/, '').slice(-1);
  return prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev);
}

(async () => {
  groupA();
  await groupB();
  groupC();

  if (failures.length) {
    console.error(`\n❌ verifyRegenerateModeHonesty: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyRegenerateModeHonesty: ${pass}/${pass} checks passed`);
})();
