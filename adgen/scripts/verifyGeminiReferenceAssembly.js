#!/usr/bin/env node
'use strict';
//
// verifyGeminiReferenceAssembly — pins that the Gemini video path can never
// submit with zero references or an empty prompt.
//
// ── WHY THIS EXISTS: TWO BUGS OF THE SAME CLASS, BOTH SHIPPED ────────────
// geminiVideoService merged in #108 taking `images` AND `prompt` as
// parameters. Both of its callers passed:
//
//     images: storyboard?.images || []
//     prompt: storyboard?.prompt || ad.veoPrompt
//
// On the gemini path `videoRouter.prepareStoryboard` returns
// `{storyboard:null}` for EVERY non-atlas provider, so:
//
//   * `images` was ALWAYS `[]` — text-to-video instead of
//     reference-to-video, on a ~$1 billable call, with nothing in the
//     response saying why the output ignored the product.
//   * `prompt` fell through to `ad.veoPrompt`, which is stamped as part of
//     the RECEIPT — i.e. AFTER the submit. Null on every first render.
//
// The shared root cause is asking a CALLER to supply state it cannot have.
// The fix was not to patch two call sites; it was to make the provider own
// both, so a caller cannot forget. These checks pin that ownership, because
// "the caller passes it" is exactly the shape that broke.
//
// OFFLINE. No DB, no network, no API key. The modules under test require
// mongoose/axios, which a BARE adgen worktree deliberately lacks (see
// CLAUDE.md — an npm ci here breaks verifyModelParity), so this asserts on
// source structure and on the pure helpers, and says so where it does.
//
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC = path.join(ROOT, 'src', 'services');
const ASSEMBLY_SRC = fs.readFileSync(path.join(SVC, 'geminiReferenceAssembly.js'), 'utf8');
const PROVIDER_SRC = fs.readFileSync(path.join(SVC, 'geminiVideoService.js'), 'utf8');
const ROUTER_SRC = fs.readFileSync(path.join(SVC, 'videoRouter.js'), 'utf8');
const RENDERER_SRC = fs.readFileSync(path.join(SVC, 'renderer.js'), 'utf8');

let pass = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

// Comment-stripped view. A source scan that matches this file's own
// explanatory prose is the trap verifyLlmErrorCodes D5 records, and
// verifyGeminiVideoProvider hit it three times on its first run.
function stripComments(src) {
  let out = ''; let i = 0; const n = src.length;
  let inS = null; let inRe = false;
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (inS) { out += c; if (c === '\\') { out += d || ''; i += 2; continue; } if (c === inS) inS = null; i += 1; continue; }
    if (inRe) { out += c; if (c === '\\') { out += d || ''; i += 2; continue; } if (c === '/') inRe = false; i += 1; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; out += c; i += 1; continue; }
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev)) { inRe = true; out += c; i += 1; continue; }
    }
    out += c; i += 1;
  }
  return out;
}
const ASSEMBLY = stripComments(ASSEMBLY_SRC);
const PROVIDER = stripComments(PROVIDER_SRC);
const ROUTER = stripComments(ROUTER_SRC);
const RENDERER = stripComments(RENDERER_SRC);

console.log('\nverifyGeminiReferenceAssembly\n');

// ── A. THE PROVIDER OWNS ITS OWN INPUTS ──────────────────────────────────
console.log('A. the provider owns references and prompt — a caller cannot forget');
{
  check('A1 the provider requires the assembly module',
    /require\(['"]\.\/geminiReferenceAssembly['"]\)/.test(PROVIDER));
  check('A2 the provider calls assembleReferences when none were supplied',
    /assembleReferences\(\{\s*ad/.test(PROVIDER));
  check('A3 the provider builds its own prompt via the single builder',
    /require\(['"]\.\/veoPromptBuilder['"]\)/.test(PROVIDER) && /buildVeoPrompt\(\{/.test(PROVIDER));

  // THE REGRESSION GUARDS. If either call site starts passing the old
  // always-empty expressions again, that is the exact bug returning.
  check('A4 NO caller passes the always-empty `storyboard?.images || []`',
    !/images:\s*storyboard\?\.images\s*\|\|\s*\[\]/.test(ROUTER + RENDERER));
  check('A5 the provider refuses an explicitly empty reference list',
    /GEMINI_NO_REFERENCES/.test(PROVIDER));
  check('A6 the provider refuses an empty prompt',
    /GEMINI_NO_PROMPT/.test(PROVIDER));
  check('A7 both refusals are marked provably UNBILLED (they precede the POST)',
    (PROVIDER.match(/billed = 'no'/g) || []).length >= 2);

  // ad.veoPrompt is the right source ONLY when resuming — that is what the
  // receipt is for. It must not be the primary source on a first render.
  check('A8 ad.veoPrompt is consulted as a RESUME source, after the explicit arg',
    /effectivePrompt[\s\S]{0,200}ad\?\.veoPrompt/.test(PROVIDER));
  // THE sibling of videoRouter's "NO prompt ARGUMENT" fix. renderer.js used
  // to pass `prompt: storyboard?.prompt || ad.veoPrompt`, which reduced to
  // ad.veoPrompt (storyboard is always null on gemini) and bypassed the
  // isResuming gate. Dropped so the provider owns precedence on every path.
  check('A9 renderer mint does not pass a prompt argument',
    !/generateForAd\(\{[^}]*\bprompt:/.test(RENDERER));
  check('A9b renderer mint does not pass an images argument',
    !/generateForAd\(\{[^}]*\bimages:/.test(RENDERER));
  check('A9c renderer mint goes through videoRouter.generateForAd, not a provider-named call',
    /videoRouter\.generateForAd\(/.test(RENDERER) &&
    !/(?:atlasVideo|geminiVideo)\.generateForAd\(/.test(RENDERER));
  check('A9d videoRouter gemini branch does not pass prompt: or images:',
    !/geminiVideoService\.generateForAd\(\{[\s\S]{0,800}\bprompt\s*:/.test(ROUTER) &&
    !/geminiVideoService\.generateForAd\(\{[\s\S]{0,800}\bimages\s*:/.test(ROUTER));
}

// ── B. RAW IMAGES ONLY — the owner directive, asserted ───────────────────
console.log('\nB. raw images only — no reframe ladder on this path');
{
  check('B1 the assembly does NOT call the reframe ladder',
    !/reframeReferenceForAspect|chooseStrategy|nano-banana/.test(ASSEMBLY));
  check('B2 the assembly does NOT import reframeStrategyChooser',
    !/reframeStrategyChooser/.test(ASSEMBLY));
  check('B3 it warns when a reference still carries a Cloudinary transform',
    /c_\(pad\|crop\|fill\|limit\)|c_\(pad/.test(ASSEMBLY) || /reframes/.test(ASSEMBLY));
}

// ── C. NO DUPLICATION OF REFERENCE ORDERING ──────────────────────────────
console.log('\nC. ordering is IMPORTED, never reimplemented');
{
  check('C1 buildReferenceImages is imported from atlasVideoService',
    /buildReferenceImages[\s\S]{0,120}require\(['"]\.\/atlasVideoService['"]\)/.test(ASSEMBLY));
  check('C2 sortCatalogMediasForReferenceStack is imported too',
    /sortCatalogMediasForReferenceStack/.test(ASSEMBLY));
  // A local copy of the ranking would drift the moment either side is tuned —
  // this repo's vendored-duplication history is the reason for the rule.
  check('C3 the assembly does NOT reimplement the packshot ranking',
    !/orderByPackshotProtectedRanking\s*\(|packshotRemainingBucket/.test(ASSEMBLY));
  check('C4 caps is NARROWED to maxReferenceImages, not an Atlas MODEL_CAPS entry',
    /caps:\s*\{\s*maxReferenceImages/.test(ASSEMBLY));
  check('C5 the assembly does not import MODEL_CAPS or a paramShape',
    !/MODEL_CAPS|paramShape/.test(ASSEMBLY));
}

// ── D. FAIL CLOSED, NEVER SHORT ──────────────────────────────────────────
console.log('\nD. every failure refuses to spend, rather than degrading quietly');
{
  for (const code of [
    'GEMINI_REFS_NO_SEED', 'GEMINI_REFS_SEED_UNUSABLE',
    'GEMINI_REFS_EMPTY', 'GEMINI_REFS_FETCH_FAILED', 'GEMINI_REFS_TOO_LARGE'
  ]) {
    check(`D1 ${code} is a distinct, machine-readable refusal`, ASSEMBLY.includes(code));
  }
  check('D2 the size ceiling THROWS rather than dropping a reference to fit',
    /GEMINI_REFS_TOO_LARGE[\s\S]{0,200}throw err/.test(ASSEMBLY) ||
    /throw err[\s\S]{0,80}GEMINI_REFS_TOO_LARGE/.test(ASSEMBLY));
  check('D3 content-type is validated — a 200 text/html error page is not an image',
    /content-type|startsWith\(['"]image\//.test(ASSEMBLY));
  check('D4 the fetch has a timeout (a hung CDN must not hold a lease slot)',
    /AbortController|FETCH_TIMEOUT_MS/.test(ASSEMBLY));
  check('D5 an empty body is rejected', /empty body/.test(ASSEMBLY_SRC));
}

// ── E. THE PURE HELPERS, EXECUTED ────────────────────────────────────────
console.log('\nE. pure helpers — executed, not just read');
{
  // b64Len is extracted and run: the size ceiling is only meaningful if the
  // base64 expansion is computed correctly (4 bytes out per 3 bytes in).
  const m = ASSEMBLY_SRC.match(/function b64Len\([\s\S]*?\n\}/);
  check('E0 b64Len is extractable', !!m);
  if (m) {
    // eslint-disable-next-line no-new-func
    const b64Len = new Function(`${m[0]}\nreturn b64Len;`)();
    check('E1 b64Len(3) === 4', b64Len(3) === 4, String(b64Len(3)));
    check('E2 b64Len(1) === 4 (padded, not 1.33)', b64Len(1) === 4, String(b64Len(1)));
    check('E3 b64Len grows ~4/3', b64Len(3_000_000) === 4_000_000, String(b64Len(3_000_000)));
    // A real measured stack must sit well under the ceiling: the largest
    // Pelagic 3-ref stack measured 2.11 MB on disk.
    const measuredLargest = 2.11 * 1024 * 1024;
    check('E4 the largest MEASURED stack fits the 20 MB ceiling with room',
      b64Len(measuredLargest) < 20 * 1024 * 1024,
      `${(b64Len(measuredLargest) / 1048576).toFixed(2)} MB`);
  }
  check('E5 the reference cap is 3 by default, not Atlas 7/5',
    /Number\.isFinite\(raw\) && raw >= 1 \? Math\.floor\(raw\) : 3/.test(ASSEMBLY));
}

console.log('');
if (failures.length) {
  console.log(`❌ geminiReferenceAssembly: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`✅ geminiReferenceAssembly: ${pass} checks passed\n`);
