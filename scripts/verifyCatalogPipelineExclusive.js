#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogPipelineExclusive — Stage 1 fence for the catalog product-ad
 * pipeline exclusivity work (CLAUDE.md §00).
 *
 * Asserts the three doors that kept Puppeteer reachable are closed on WRITE
 * (without deleting any renderer code yet):
 *
 *   1. Brand.staticImagePipeline cannot be set to 'html' — normalize rejects
 *      it, and every value a write can produce resolves to direct_image.
 *   2. SUPPORTED_TEMPLATES is only ai_* templates (cartesian cannot queue
 *      the 7 dead legacy templates that route to renderViaSpec).
 *   3. adRegenerateService.runImage no longer requires aiCanvasArtifactId
 *      and routes through directImageRenderService.
 *
 * Also asserts that EXISTING Ads referencing a legacy template still resolve
 * labels (and canvas geometry where the registry has it) without throwing —
 * reads must survive the queueable-set shrink.
 *
 * Offline: no DB, no network, no API keys.
 *   node scripts/verifyCatalogPipelineExclusive.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const {
  DIRECT_IMAGE,
  HTML,
  STATIC_PIPELINES,
  DEPRECATED_INPUTS,
  normalizeStaticPipelineInput,
  resolveStaticPipeline,
  isHtmlPipeline,
  isDirectImagePipeline
} = require(path.join(ROOT, 'services', 'staticPipeline.js'));

const gen = require(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'));
const registry = require(path.join(ROOT, 'services', 'templateRegistry.js'));
const direct = require(path.join(ROOT, 'services', 'directImageRenderService.js'));
const regen = require(path.join(ROOT, 'services', 'adRegenerateService.js'));

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const LEGACY_TEMPLATES = [
  'creator_endorsement',
  'product_overlay',
  'results_proof',
  'review_collage',
  'testimonial_overlay',
  'testimonial_spotlight',
  'ugc_split_screen'
];

// ── Door 1: brand HTML opt-in closed on write ───────────────────────────
console.log('\nDoor 1 — staticImagePipeline write fence');
check('STATIC_PIPELINES is only direct_image (html not writeable)',
  Array.isArray(STATIC_PIPELINES) &&
  STATIC_PIPELINES.length === 1 &&
  STATIC_PIPELINES[0] === DIRECT_IMAGE &&
  !STATIC_PIPELINES.includes(HTML));

check("normalizeStaticPipelineInput('html') rejects (returns null)",
  normalizeStaticPipelineInput('html') === null);
check("normalizeStaticPipelineInput('HTML') rejects",
  normalizeStaticPipelineInput('HTML') === null);
check("normalizeStaticPipelineInput(' direct_image ') → direct_image",
  normalizeStaticPipelineInput(' direct_image ') === DIRECT_IMAGE);
check("normalizeStaticPipelineInput('direct_overlay') → direct_image (deprecated absorb)",
  normalizeStaticPipelineInput('direct_overlay') === DIRECT_IMAGE);
check("normalizeStaticPipelineInput('garbage') rejects",
  normalizeStaticPipelineInput('garbage') === null);
check("normalizeStaticPipelineInput(null) rejects",
  normalizeStaticPipelineInput(null) === null);

// Every value a successful brand write can now produce (normalize ≠ null)
// must resolve to DIRECT_IMAGE — never HTML.
const writeableSamples = [
  'direct_image', 'DIRECT_IMAGE', ' direct_image ',
  'direct_overlay', 'Direct_Overlay'
];
for (const sample of writeableSamples) {
  const written = normalizeStaticPipelineInput(sample);
  check(
    `writeable input ${JSON.stringify(sample)} normalises then resolves to direct_image`,
    written != null && resolveStaticPipeline(written) === DIRECT_IMAGE && !isHtmlPipeline(written)
  );
}

// resolveStaticPipeline still reads a stored 'html' safely (no throw) but
// a brand write can no longer PRODUCE that value via normalize.
check("resolveStaticPipeline('html') still reads as HTML (legacy stored rows)",
  resolveStaticPipeline('html') === HTML);
check("resolveStaticPipeline(null) → direct_image (fail-safe)",
  resolveStaticPipeline(null) === DIRECT_IMAGE);
check("resolveStaticPipeline('direct_overlay') → direct_image",
  resolveStaticPipeline('direct_overlay') === DIRECT_IMAGE);
check("isDirectImagePipeline(null) true", isDirectImagePipeline(null) === true);
check("isHtmlPipeline('direct_image') false", isHtmlPipeline('direct_image') === false);
check("DEPRECATED_INPUTS does not re-admit html",
  !Object.prototype.hasOwnProperty.call(DEPRECATED_INPUTS, 'html') &&
  !Object.prototype.hasOwnProperty.call(DEPRECATED_INPUTS, HTML));

// Brand model enum must not list 'html' as a writeable value.
{
  const brandSrc = fs.readFileSync(path.join(ROOT, 'models', 'Brand.js'), 'utf8');
  // Narrow: the staticImagePipeline enum block.
  const enumMatch = brandSrc.match(/staticImagePipeline:\s*\{[\s\S]*?enum:\s*\[([^\]]+)\]/);
  check('Brand.staticImagePipeline enum block located', !!enumMatch);
  if (enumMatch) {
    const enumBody = enumMatch[1];
    check("Brand.staticImagePipeline enum does not include 'html'",
      !/['"]html['"]/.test(enumBody));
    check("Brand.staticImagePipeline enum includes 'direct_image'",
      /['"]direct_image['"]/.test(enumBody));
  }
}

// brand write route must 400 on 'html' with a clear message (source contract).
{
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'brand.js'), 'utf8');
  check("routes/brand.js rejects literal 'html' for staticImagePipeline",
    /staticImagePipeline[\s\S]{0,800}?=== 'html'/.test(routeSrc) ||
    /trim\(\)\.toLowerCase\(\) === 'html'/.test(routeSrc));
  check('routes/brand.js mentions retired in the html reject path',
    /html[\s\S]{0,400}?retired|retired[\s\S]{0,400}?html/i.test(routeSrc));
}

// ── Door 2: legacy templates not queueable ──────────────────────────────
console.log('\nDoor 2 — SUPPORTED_TEMPLATES is ai_* only');
const supported = gen.SUPPORTED_TEMPLATES;
check('SUPPORTED_TEMPLATES is a Set', supported instanceof Set);
check('SUPPORTED_TEMPLATES is non-empty', supported.size > 0);

const supportedList = [...supported];
check('every SUPPORTED_TEMPLATES entry starts with ai_',
  supportedList.every((t) => String(t).startsWith('ai_')),
  `got ${supportedList.join(', ')}`);

for (const legacy of LEGACY_TEMPLATES) {
  check(`legacy template ${legacy} is NOT in SUPPORTED_TEMPLATES`,
    !supported.has(legacy));
}

// Queueable templates must take the direct-image branch condition used by
// renderService (template.startsWith('ai_')).
for (const t of supportedList) {
  check(`queueable ${t} routes to direct-image branch (startsWith ai_)`,
    String(t).startsWith('ai_'));
}

// ── Door 3: image regenerate no longer requires aiCanvasArtifactId ──────
console.log('\nDoor 3 — adRegenerateService.runImage on direct_image path');
check('runImage is exported (harness can inspect)',
  typeof regen.runImage === 'function');

{
  const regenSrc = fs.readFileSync(
    path.join(ROOT, 'services', 'adRegenerateService.js'),
    'utf8'
  );
  // Extract runImage body (brace-match from function declaration).
  const start = regenSrc.indexOf('async function runImage');
  check('runImage source located', start >= 0);
  if (start >= 0) {
    let i = regenSrc.indexOf('{', start);
    let depth = 0;
    let end = i;
    for (; end < regenSrc.length; end++) {
      const ch = regenSrc[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }
    const body = regenSrc.slice(start, end);
    // The exact precondition that broke every current-pipeline ad.
    check('runImage body does not require aiCanvasArtifactId',
      !/if\s*\(\s*!ad\.aiCanvasArtifactId\s*\)/.test(body) &&
      !/Ad has no aiCanvasArtifactId/.test(body));
    check('runImage does not call htmlGen / generateForArtifact',
      !/htmlGen\.|generateForArtifact|aiCanvasHtmlGeneratorService/.test(body));
    check('runImage does not call screenshotHtml / puppeteer',
      !/screenshotHtml|require\(['"]puppeteer['"]\)/.test(body));
    check('runImage calls directImage.renderDirectImage (or directImageRenderService)',
      /renderDirectImage\s*\(/.test(body));
    // Money: no retry loop around the billable call.
    check('runImage has no retry loop around the image submit',
      !/for\s*\([^)]*retr/i.test(body) &&
      !/while\s*\([^)]*retr/i.test(body) &&
      !/\.retry\s*\(/.test(body));
  }
}

// Prompt override hook exists on the direct path.
check('resolveImagePromptOverride is exported',
  typeof direct.resolveImagePromptOverride === 'function');
check('resolveImagePromptOverride joins {system,user} into one channel',
  direct.resolveImagePromptOverride({ system: 'SYS', user: 'USR' }) === 'SYS\n\nUSR');
check('resolveImagePromptOverride accepts a bare string',
  direct.resolveImagePromptOverride('  flat prompt  ') === 'flat prompt');
check('resolveImagePromptOverride(null) → null',
  direct.resolveImagePromptOverride(null) === null);

// ── Existing Ad with legacy template: labels/geometry still resolve ─────
console.log('\nRead-safety — existing Ads with legacy templates');
for (const id of LEGACY_TEMPLATES) {
  let label = null;
  let threw = false;
  try {
    const cat = registry.getCatalog(id);
    label = cat?.ui_label || cat?.name || null;
    // Normalized shim / entry for ratio gates — must not throw.
    registry.getNormalized(id);
    // Canvas geometry: present for some hand-authored templates, null for
    // others (overlay mode). Either is fine; throwing is not.
    for (const ar of ['1:1', '4:5', '9:16']) {
      registry.getCanvas(id, ar);
    }
  } catch (err) {
    threw = true;
    label = err.message;
  }
  check(`legacy ${id}: getCatalog/getNormalized/getCanvas do not throw`,
    !threw, threw ? label : '');
  check(`legacy ${id}: catalog label resolves`,
    typeof label === 'string' && label.length > 0, `label=${label}`);
}

// listTemplates still surfaces legacy entries for the board/inspector.
{
  const listed = registry.listTemplates().map((t) => t.id);
  for (const id of LEGACY_TEMPLATES) {
    check(`listTemplates still includes legacy ${id} (read path)`,
      listed.includes(id));
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n❌ catalogPipelineExclusive: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`\n✅ catalogPipelineExclusive: ${pass} checks passed`);
