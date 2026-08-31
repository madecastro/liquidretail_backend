'use strict';
//
// renderTitlePreview.js — offline Remotion title-rendering repro/debug tool.
// NOT a verify* harness (deliberately outside scripts/verify*.{js,mjs}, so
// runVerifySuite.js's glob never picks it up and it never gates CI). This is
// a manual dev tool: point it at a preset + format + synthetic face
// scenario, get a still PNG back in a few seconds, look at it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Built 2026-08-31 while tracking down overlapping title text on production
// ad 6a93ade2e4f1d02784398630. Root cause: Canonical.jsx's resolveGroupAnchor()
// nudges a slot GROUP's anchor (top/upperThird/center/lowerThird/bottom) away
// from any band a face occupies, but it does this PER GROUP with no
// awareness of what anchor a DIFFERENT, simultaneously-visible group already
// landed on. canonical-conversion's vertical hook phase authors an
// `upperThird` group (badge+headline, exits ~2.2s) and a separate,
// never-exiting `lowerThird` group (productName+rating+deliveryLine, enters
// ~1.5s) that are BOTH on screen for a window (~1.5s-2.2s). If a face
// occupies the lower/middle bands, the lowerThird group's keep-out fallback
// chain (lowerThird -> center -> upperThird, see KEEP_OUT_CANDIDATES in
// Canonical.jsx) can push it onto the SAME upperThird anchor the other group
// already occupies. safeZones.js's stackContainerStyle() positions each
// group with position:absolute purely from its resolved anchor — no
// collision detection between groups — so both land at byte-identical
// screen coordinates and their text renders directly on top of each other.
//
// That is a real defect in Canonical.jsx / safeZones.js. THIS SCRIPT DOES
// NOT FIX IT — it exists so a human (or a future Claude session) can
// reproduce and visually confirm the defect, and later confirm a fix,
// without a production DB, without real footage, and without spending a
// cent on Atlas.
//
// ── WHY NO DB / NETWORK ACCESS IS NEEDED (and must never be added here) ────
// Every input this script needs is already synthetic:
//   - The composition + the render pipeline (renderPreview) are the REAL,
//     already-exported production code in src/services/remotionRenderService.js
//     — just fed a flat-color plate (plateColor) instead of a real video, so
//     no footage download and no video probe are needed.
//   - The plate "keep-out" signal (which bands a face occupies) is the REAL,
//     already-exported production function applyFaceKeepOut() from
//     src/services/plateIntelService.js — fed a HAND-BUILT plateHints +
//     faceSamples object matching the exact shape analyzePlate()/
//     basePlateCropService normally produce from real footage + a vision
//     API call. Same math, zero vision calls.
//   - renderPreview()'s plateHintsOverride parameter (see
//     src/services/remotionRenderService.js) is the hook that lets us inject
//     that hand-built plateHints object directly, bypassing analyzePlate()
//     entirely. It defaults to null (fully backward compatible / byte-
//     identical to before) — do NOT remove or rework it, this whole tool
//     depends on it. Grep `plateHintsOverride` if you need the exact diff.
//   - requiring remotionRenderService.js does NOT require src/config.js (no
//     ADGEN_ROLE / MONGODB_URI exit(1) gate — that file is never on this
//     require graph) and does NOT touch mongoose. Verified by tracing its
//     requires: fontResolverService/fontLoader (disk-cached webfont
//     resolution, no DB) and remotionChildSupervisor (Node builtins only,
//     see that file's own "WHY THIS FILE IS SEPARATE" header). plateIntel's
//     only network path (Gemini semantic scan, atlasLlmService) is gated on
//     TITLE_PLATE_SCAN=gemini and is never reached here because this tool
//     always injects plateHints directly and never calls analyzePlate().
// Do NOT add MongoDB/production-database connectivity to this tool, even
// optionally behind a flag — that is explicitly out of scope. If a future
// session is tempted to "just read the real ad's spec from Mongo instead of
// a preset file", export the spec to a local JSON file by hand instead and
// point --preset-file at it (not implemented here — add it the same way, as
// a pure local-file read, if it's ever needed).
//
// ── GOTCHA 1: raw preset JSON is NOT render-ready ───────────────────────────
// The files under src/remotion/presets/*.json are the AUTHORED shorthand —
// production always normalizes them through titleSpecValidator's
// validateTitleSpec(rawSpec, { format }) first, which fills in each slot's
// default `bind` chain from DEFAULT_BIND (among other defaults). Skip this
// step and every slot with no explicit `bind` resolves to null content, so
// you render a blank plate with no title text at all — which looks like
// "nothing happened", not an obvious "you forgot a step" error. This script
// always validates before rendering; if you ever bypass it, don't repeat that
// mistake.
//
// ── GOTCHA 2: chrome-headless-shell first-run download path (macOS dev) ────
// scripts/ensureRemotionBrowser.js (see its own long header) pre-warms
// @remotion/renderer's browser cache at DOCKER BUILD time, but it explicitly
// no-ops on darwin (`resolvePlatform()` returns null off-linux) — it only
// ever prepares the Linux target this image ships to Render with. On a local
// macOS dev box there is no equivalent prewarm, so @remotion/renderer's own
// ensureBrowser() has to download Chrome Headless Shell itself on first use,
// and that first-run install has been observed to throw
// `ENOENT ... .remotion/chrome-headless-shell/VERSION` unless the target
// directory tree already exists on disk. get-download-destination.js's
// getDownloadsCacheDir() resolves the cache dir by walking UP from
// process.cwd() to the nearest ancestor with a package.json — from this
// repo's root that lands on <repo>/node_modules/.remotion, but
// src/remotion/ ALSO carries its own package.json (it's bundled by
// @remotion/bundler as a semi-independent island), so a cwd or resolution
// difference can just as easily land on
// src/remotion/node_modules/.remotion/chrome-headless-shell instead. Rather
// than depend on getting that resolution exactly right, this script just
// pre-creates BOTH candidate directories, unconditionally, before the first
// render — mkdir -p is idempotent and costs nothing on every run after the
// first. Once chrome-headless-shell is actually downloaded once, this is a
// no-op forever after (the download itself is cached on disk).
//
// ── USAGE ────────────────────────────────────────────────────────────────
//   node scripts/renderTitlePreview.js [flags]
//
//   --format=<vertical|feed|square|landscape>   default: vertical
//   --preset=<name>                             default: canonical-conversion
//                                                (a .json filename, without
//                                                the extension, under
//                                                src/remotion/presets/)
//   --at=<sec[,sec...]>                         default: 2.0 (still frame
//                                                timestamp(s); comma-separate
//                                                for multiple stills in one run)
//   --face=<none|face-top|face-middle|face-bottom|face-bottom-and-middle|custom>
//                                                default: none (no band flagged
//                                                — the clean control case)
//   --face-box=<left,top,right,bottom>          required only when --face=custom
//                                                (fractions 0..1 of the full frame,
//                                                same shape basePlateCropService's
//                                                real face detection produces)
//   --meta=<path/to/meta.json>                  optional; shallow-merged over the
//                                                built-in placeholder meta (file
//                                                wins on any key it sets)
//   --set=<field>=<value>                       optional, repeatable; last-mile
//                                                inline meta override applied
//                                                AFTER --meta (e.g. --set
//                                                headline="Custom Headline").
//                                                Value is JSON-parsed when
//                                                possible (so --set rating=4.2
//                                                becomes a number), else kept
//                                                as a raw string.
//   --out=<path.png>                            optional; default is an
//                                                auto-named file under
//                                                title-preview-output/. With
//                                                multiple --at values, each
//                                                frame gets its own
//                                                `<out>_<frame>.png`.
//   --include-video                             also render a full (slow) mp4
//                                                preview clip alongside the
//                                                still(s). Default off — stills
//                                                only, the fast ~1-3s path.
//   --scale=<n>                                 still/video render scale,
//                                                default 1 (full resolution;
//                                                production preview UI uses
//                                                0.5 for speed — bump this back
//                                                down if you want faster
//                                                iteration and don't need
//                                                pixel-exact output).
//   --duration=<sec>                             nominal clip length in
//                                                seconds, default 8 (matches
//                                                what these presets are
//                                                authored against).
//   --plate-color=<#RRGGBB>                     flat background plate color,
//                                                default #3D3D3D (matches the
//                                                production preview default).
//   --list-presets                               print available preset files
//                                                and exit.
//   --list-faces                                 print the named face scenario
//                                                library and exit.
//   --help, -h                                   print this usage and exit.
//
// ── CONCRETE EXAMPLE: reproduce today's exact bug ───────────────────────────
//   node scripts/renderTitlePreview.js \
//     --preset=canonical-conversion --format=vertical \
//     --face=face-bottom-and-middle --at=2.0 \
//     --out=title-preview-output/repro.png
//
//   Expect: OVERLAPPING title text — the lowerThird group
//   (productName/rating/deliveryLine) gets pushed off its authored band by
//   the synthetic face and lands on the same upperThird anchor the
//   badge/headline group already occupies. Watch stdout for a `keepOut:
//   lowerThird->upperThird (...)` line (Canonical.jsx's resolveGroupAnchor
//   console sweep — see below) confirming the shift actually happened.
//
// ── CONTROL: confirm it's clean without the face ────────────────────────────
//   node scripts/renderTitlePreview.js \
//     --preset=canonical-conversion --format=vertical \
//     --face=none --at=2.0 \
//     --out=title-preview-output/control.png
//
//   Expect: clean, non-overlapping layout — badge+headline up top,
//   productName/rating/deliveryLine in the lower third, no `keepOut:` line
//   at all (nothing was flagged `avoid`, so every group keeps its authored
//   anchor).
//
// ── STDOUT: keepOut: / inkVote: / inkBand: ─────────────────────────────────
// Canonical.jsx's resolveGroupAnchor(), plateIsLightGlobal(), and the
// per-slot ink-band resolver all console.log() diagnostic lines prefixed
// `keepOut:` / `inkVote:` / `inkBand:` respectively (see that file's own
// "Render console — sweeps grep ..." comments). Those are BROWSER console
// lines from inside the headless Chrome page Remotion drives — they surface
// here because @remotion/renderer forwards page console output to the
// parent Node process's stdout by default when neither
// renderStill/renderMedia/selectComposition is given a quieter logLevel, and
// remotionRenderService.js's renderPreview() (the direct, in-process Node
// API path this script calls) never overrides that default. Just watch this
// script's own stdout; no special flag is needed to see them.
//
// OBSERVABILITY GAP THIS SCRIPT DOES NOT FIX: production's OTHER render path
// — renderTitlesJob() run inside a SPAWNED CHILD PROCESS via
// superviseRemotionChild() (see remotionRenderService.js's renderTitles(),
// the real production titling call) — captures that child's stdout/stderr
// for its own timeout/report plumbing rather than passing Chrome's console
// straight through, so these same keepOut:/inkVote:/inkBand: lines are NOT
// visible the same way on the production path the way they are here. That
// is a real, separate observability gap in renderTitlesJob's child-process
// path; it is out of scope for this tool and is not touched here — this
// script's direct, in-process renderPreview() call is the one place these
// lines show up for free today.
//
// ── NAMED FACE SCENARIOS ────────────────────────────────────────────────────
// Y-extents are read live from plateIntelService's own bandsFor(safeZoneKey)
// (not hardcoded), so scenarios stay correct for whichever --format you pick
// — bandsFor derives the bottom band from that surface's own safe-zone inset
// (see plateIntelService.js's SURFACE_INSETS block) rather than assuming
// vertical's [0.52, 0.65] applies everywhere. X-extent is always
// [BAND_X0, BAND_X1] = [0.08, 0.92], matching the default full-width sample
// stackContainerStyle uses. All named scenarios apply for the WHOLE clip
// (faceSamples atSec:null — the same "envelope fallback" shape
// basePlateCropService's real, whole-clip face union produces).
//
//   none                    — nothing flagged (the control case)
//   face-top                — face box == the `top` band's full rect
//   face-middle              — face box == the `middle` band's full rect
//   face-bottom              — face box == the `bottom` band's full rect
//   face-bottom-and-middle   — face box spans from the `middle` band's top
//                              edge to the `bottom` band's bottom edge (the
//                              shape that reproduced the 6a93ade2e4f1d02784398630
//                              overlap: it flags BOTH middle and bottom,
//                              leaving only `top` clear).
//   custom                  — pass --face-box=left,top,right,bottom yourself
//

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PRESETS_DIR = path.join(REPO_ROOT, 'src', 'remotion', 'presets');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'title-preview-output');

const { validateTitleSpec } = require('../src/services/titleSpecValidator');
const {
  applyFaceKeepOut,
  bandsFor,
  BAND_X0,
  BAND_X1,
  resolveSafeZoneKeyCjs,
} = require('../src/services/plateIntelService');
const { renderPreview } = require('../src/services/remotionRenderService');

const FORMATS = ['vertical', 'feed', 'square', 'landscape'];
const FACE_SCENARIOS = ['none', 'face-top', 'face-middle', 'face-bottom', 'face-bottom-and-middle', 'custom'];

// ── clearly-fake placeholder meta — never real customer/product data ──────
// Covers the common text-slot binds (see titleSpecValidator's DEFAULT_BIND)
// across the shipped canonical presets. Image-typed slots (productImage,
// brandLogo) are left null by default so this never triggers a network
// download of a real asset — override via --meta with a LOCAL file path if
// you need to exercise those slots (renderPreview's cleanMeta branch serves
// a local brandLogoUrl path the same way it serves the plate; see
// remotionRenderService.js's "Local logo path (tests, cached assets)" comment).
const DEFAULT_META = {
  brandName: 'TEST BRAND',
  brandTagline: 'TEST BRAND TAGLINE',
  brandWebsiteUrl: 'https://example.test',
  badgeText: 'LIMITED TIME',
  headline: 'THIS IS A TEST HEADLINE FOR PREVIEW',
  productName: 'TEST PRODUCT NAME HERE',
  productDescription: 'Placeholder product description for preview purposes only.',
  price: '$49.99',
  rating: 4.8,
  reviewsText: '1,234 reviews',
  reviewCount: 1234,
  likes: 42,
  deliveryLine: 'Free shipping today',
  ctaText: 'Shop Now',
  cta: 'Shop Now',
  promoText: 'Save 20% today',
  quoteSnippet: 'This product changed how I shop — highly recommend it.',
  quote: 'This product changed how I shop — highly recommend it.',
  reviewer: 'Jordan T.',
  badges: ['Free Returns', 'Fast Shipping'],
  benefits: ['Durable build', 'Easy to use', 'Great value'],
  productImageUrl: null,
  brandLogoUrl: null,
};

function printHelp() {
  console.log(`
Usage: node scripts/renderTitlePreview.js [flags]

  --format=<vertical|feed|square|landscape>   default: vertical
  --preset=<name>                             default: canonical-conversion
  --at=<sec[,sec...]>                         default: 2.0
  --face=<${FACE_SCENARIOS.join('|')}>
                                               default: none
  --face-box=<left,top,right,bottom>          required only for --face=custom
  --meta=<path/to/meta.json>                  optional, shallow-merged over defaults
  --set=<field>=<value>                       optional, repeatable inline meta override
  --out=<path.png>                            default: auto-named under title-preview-output/
  --include-video                             also render a full mp4 preview (slow)
  --scale=<n>                                 default: 1
  --duration=<sec>                            default: 8
  --plate-color=<#RRGGBB>                     default: #3D3D3D
  --lum=<0..1 | top:0.5,middle:0.2>           synthetic band luminance. Sub-AA ONLY for
                                              0.470-0.500 (worst 0.485 = 4.24:1); 0.45 and 0.55
                                              both CLEAR AA. Use --lum=0.485 for worst case.
  --busy=<0..1>                               synthetic texture; >0.45 trips the busy escalation
  --real-scan                                 IGNORE --lum/--busy/--face and run the REAL
                                              plateIntelService scan over --plate-video's actual
                                              frames. The only honest way to ask whether a REAL
                                              delivered ad is hard to read. Free (basic scan).
  --plate-video=<path.mp4>                    real base plate instead of a flat colour;
                                              probes true fps/duration. Use an ad's
                                              UNTITLED veoVideoUrl (not renderUrl, which
                                              already has titles burned in). Required to
                                              judge placement against real footage.
  --list-presets                              print available presets and exit
  --list-faces                                print the named face scenario library and exit
  --help, -h                                  print this help and exit

Example — reproduce the 6a93ade2e4f1d02784398630 overlap:
  node scripts/renderTitlePreview.js --preset=canonical-conversion --format=vertical \\
    --face=face-bottom-and-middle --at=2.0 --out=title-preview-output/repro.png

Control — same everything, no face:
  node scripts/renderTitlePreview.js --preset=canonical-conversion --format=vertical \\
    --face=none --at=2.0 --out=title-preview-output/control.png
`);
}

function parseArgs(argv) {
  const args = {
    format: 'vertical',
    preset: 'canonical-conversion',
    at: [2.0],
    face: 'none',
    faceBox: null,
    metaFile: null,
    sets: [],
    out: null,
    includeVideo: false,
    scale: 1,
    duration: 8,
    plateColor: '#3D3D3D',
    plateVideo: null,
    lum: null,
    busy: null,
    realScan: false,
    listPresets: false,
    listFaces: false,
    help: false,
  };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--list-presets') args.listPresets = true;
    else if (a === '--list-faces') args.listFaces = true;
    else if (a === '--include-video') args.includeVideo = true;
    else if (a === '--real-scan') args.realScan = true;
    else if (a.startsWith('--format=')) args.format = a.split('=')[1];
    else if (a.startsWith('--preset=')) args.preset = a.split('=')[1];
    else if (a.startsWith('--at=')) {
      args.at = a.split('=')[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    } else if (a.startsWith('--face-box=')) {
      args.faceBox = a.split('=')[1].split(',').map((s) => Number(s.trim()));
    } else if (a.startsWith('--face=')) {
      args.face = a.split('=')[1];
    } else if (a.startsWith('--meta=')) {
      args.metaFile = a.slice('--meta='.length);
    } else if (a.startsWith('--set=')) {
      args.sets.push(a.slice('--set='.length));
    } else if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
    } else if (a.startsWith('--scale=')) {
      args.scale = Number(a.split('=')[1]);
    } else if (a.startsWith('--duration=')) {
      args.duration = Number(a.split('=')[1]);
    } else if (a.startsWith('--plate-color=')) {
      args.plateColor = a.slice('--plate-color='.length);
    } else if (a.startsWith('--plate-video=')) {
      args.plateVideo = a.slice('--plate-video='.length);
    } else if (a.startsWith('--lum=')) {
      args.lum = a.slice('--lum='.length);
    } else if (a.startsWith('--busy=')) {
      args.busy = Number(a.slice('--busy='.length));
    } else {
      console.warn(`renderTitlePreview: ignoring unrecognized flag '${a}'`);
    }
  }
  return args;
}

function listPresets() {
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
  console.log('Available presets (src/remotion/presets/):');
  for (const f of files) console.log(`  ${f.replace(/\.json$/, '')}`);
}

function listFaceScenarios(format) {
  const safeZoneKey = resolveSafeZoneKeyCjs({ format });
  const bands = bandsFor(safeZoneKey);
  console.log(`Named face scenarios for --format=${format} (safeZoneKey='${safeZoneKey}'):`);
  console.log(`  none                    — nothing flagged (control)`);
  console.log(`  face-top                — box [${BAND_X0}, ${bands.top[0]}, ${BAND_X1}, ${bands.top[1]}]`);
  console.log(`  face-middle             — box [${BAND_X0}, ${bands.middle[0]}, ${BAND_X1}, ${bands.middle[1]}]`);
  console.log(`  face-bottom             — box [${BAND_X0}, ${bands.bottom[0]}, ${BAND_X1}, ${bands.bottom[1]}]`);
  console.log(`  face-bottom-and-middle  — box [${BAND_X0}, ${bands.middle[0]}, ${BAND_X1}, ${bands.bottom[1]}]`);
  console.log(`  custom                  — pass --face-box=left,top,right,bottom yourself`);
}

// Baseline plateHints: one sample, nothing flagged. Shape matches
// plateIntelService.analyzePlate's real output (see that file's header).
// Synthetic plate hints. The defaults (lum 0.4 / busy 0.1) describe a well-behaved
// plate: worst-case ink there measures ~5.74:1, comfortably above the 4.5:1 AA
// floor, so every legibility escalation in Canonical.jsx correctly stays DORMANT.
// That is the right default for placement/overlap work — and useless for testing
// the escalations themselves, which is what --lum / --busy are for.
//
//   --lum   0..1 band luminance. The genuinely sub-AA window is NARROW and was
//           computed, not guessed: best-ink contrast dips below 4.5:1 ONLY for
//           lum 0.470-0.500, bottoming at 0.485 (4.24:1). Neighbours are fine —
//           0.45 gives 4.76:1 and 0.55 gives 5.30:1, both clearing AA. Use
//           --lum=0.485 for the worst case; 0.0 and 1.0 are the EASY ends.
//           (An earlier version of this note claimed "0.45-0.55 is hostile".
//           That was wrong at both ends — corrected against the real sRGB
//           relative-luminance maths, INK_DARK_LUM 0.0091 / INK_LIGHT_LUM 1.0.)
//
//           CONSEQUENCE WORTH KNOWING: because that window is only ~3 points
//           wide, the marginal-gated treatments (contour stroke, weight bump)
//           fire rarely on a STATIC band. They fire more often than that window
//           suggests on real footage because placement scores WORST-CASE across
//           all time samples — a clip whose band merely PASSES THROUGH 0.47-0.50
//           at any sampled moment is penalised.
//   --busy  0..1 local luma variance. Above BUSY_SHADOW_THRESHOLD (0.45) the
//           band is treated as too textured to read on regardless of its mean
//           contrast, which also triggers the escalations.
//
// Per-band overrides use `top:0.5` syntax so a single band can be made hostile
// while its neighbours stay clean — the shape needed to exercise the contrast
// term in resolveGroupAnchor's band SELECTION (a stack should walk off a
// mid-tone band toward a legible one).
function controlPlateHints(atSec, { lum = 0.4, busy = 0.1, perBand = {} } = {}) {
  const band = (name) => ({
    lum: Number.isFinite(perBand[name]) ? perBand[name] : lum,
    busy,
    avoid: false,
  });
  return {
    samples: [
      {
        atSec,
        bands: { top: band('top'), middle: band('middle'), bottom: band('bottom') },
      },
    ],
  };
}

/** `0.5` -> {lum:0.5}; `top:0.5,middle:0.2` -> per-band. */
function parseLumArg(raw) {
  const str = String(raw || '').trim();
  if (!str) return { lum: undefined, perBand: {} };
  if (!str.includes(':')) return { lum: Number(str), perBand: {} };
  const perBand = {};
  for (const part of str.split(',')) {
    const [k, v] = part.split(':').map((x) => x.trim());
    if (['top', 'middle', 'bottom'].includes(k) && Number.isFinite(Number(v))) perBand[k] = Number(v);
  }
  return { lum: undefined, perBand };
}

function faceRectForScenario(face, format, faceBoxArg) {
  const safeZoneKey = resolveSafeZoneKeyCjs({ format });
  const bands = bandsFor(safeZoneKey);
  switch (face) {
    case 'none':
      return null;
    case 'face-top':
      return { left: BAND_X0, top: bands.top[0], right: BAND_X1, bottom: bands.top[1] };
    case 'face-middle':
      return { left: BAND_X0, top: bands.middle[0], right: BAND_X1, bottom: bands.middle[1] };
    case 'face-bottom':
      return { left: BAND_X0, top: bands.bottom[0], right: BAND_X1, bottom: bands.bottom[1] };
    case 'face-bottom-and-middle':
      return { left: BAND_X0, top: bands.middle[0], right: BAND_X1, bottom: bands.bottom[1] };
    case 'custom': {
      if (!Array.isArray(faceBoxArg) || faceBoxArg.length !== 4 || !faceBoxArg.every(Number.isFinite)) {
        throw new Error(`--face=custom requires --face-box=left,top,right,bottom (four finite fractions 0..1), got ${JSON.stringify(faceBoxArg)}`);
      }
      const [left, top, right, bottom] = faceBoxArg;
      if (!(right > left) || !(bottom > top)) {
        throw new Error(`--face-box must have right>left and bottom>top (got ${JSON.stringify(faceBoxArg)})`);
      }
      return { left, top, right, bottom };
    }
    default:
      throw new Error(`unknown --face '${face}' — valid: ${FACE_SCENARIOS.join(', ')}`);
  }
}

// mkdir -p BOTH candidate chrome-headless-shell cache roots, once, before the
// first render — see this file's header "GOTCHA 2". Idempotent; a no-op on
// every run after the browser is actually downloaded.
function preWarmHeadlessShellDirs() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '.remotion', 'chrome-headless-shell'),
    path.join(REPO_ROOT, 'src', 'remotion', 'node_modules', '.remotion', 'chrome-headless-shell'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.warn(`renderTitlePreview: could not pre-create ${dir} (${e.message}) — continuing anyway`);
    }
  }
}

function loadMeta(args) {
  let meta = { ...DEFAULT_META };
  if (args.metaFile) {
    const filePath = path.resolve(args.metaFile);
    const fileMeta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    meta = { ...meta, ...fileMeta };
  }
  for (const setArg of args.sets) {
    const eq = setArg.indexOf('=');
    if (eq < 0) {
      console.warn(`renderTitlePreview: ignoring malformed --set '${setArg}' (expected field=value)`);
      continue;
    }
    const field = setArg.slice(0, eq);
    const rawValue = setArg.slice(eq + 1);
    let value = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // not valid JSON — keep as a raw string, e.g. --set headline=Some Text
    }
    meta[field] = value;
  }
  return meta;
}

(async () => {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }
  if (args.listPresets) { listPresets(); process.exit(0); }
  if (!FORMATS.includes(args.format)) {
    console.error(`renderTitlePreview: --format must be one of ${FORMATS.join(', ')} (got '${args.format}')`);
    process.exit(1);
  }
  if (args.listFaces) { listFaceScenarios(args.format); process.exit(0); }
  if (!FACE_SCENARIOS.includes(args.face)) {
    console.error(`renderTitlePreview: --face must be one of ${FACE_SCENARIOS.join(', ')} (got '${args.face}')`);
    process.exit(1);
  }
  if (!args.at.length) {
    console.error('renderTitlePreview: --at produced no valid seconds — check the value');
    process.exit(1);
  }

  // 1. Load + validate the preset (GOTCHA 1 — see header).
  const presetPath = path.join(PRESETS_DIR, `${args.preset}.json`);
  if (!fs.existsSync(presetPath)) {
    console.error(`renderTitlePreview: no preset file at ${presetPath}`);
    listPresets();
    process.exit(1);
  }
  const presetJson = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  const rawSpec = presetJson?.byFormat?.[args.format];
  if (!rawSpec) {
    console.error(`renderTitlePreview: preset '${args.preset}' has no byFormat.${args.format} entry — available formats: ${Object.keys(presetJson?.byFormat || {}).join(', ')}`);
    process.exit(1);
  }
  const validated = validateTitleSpec(rawSpec, { format: args.format });
  if (!validated.ok) {
    console.error(`renderTitlePreview: preset '${args.preset}' failed validateTitleSpec for format '${args.format}':`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const spec = validated.normalized;

  // 2. Build synthetic plateHints from the requested face scenario.
  const safeZoneKey = resolveSafeZoneKeyCjs({ format: args.format });
  let plateHints;
  let faceRect = null;
  try {
    faceRect = faceRectForScenario(args.face, args.format, args.faceBox);
  } catch (e) {
    console.error(`renderTitlePreview: ${e.message}`);
    process.exit(1);
  }
  const baseAtSec = Math.min(args.duration - 0.1, Math.max(0.1, args.duration / 2));
  const parsedLum = parseLumArg(args.lum);
  const hintOpts = {};
  if (Number.isFinite(parsedLum.lum)) hintOpts.lum = parsedLum.lum;
  if (Object.keys(parsedLum.perBand).length) hintOpts.perBand = parsedLum.perBand;
  if (Number.isFinite(args.busy)) hintOpts.busy = args.busy;
  if (!faceRect) {
    plateHints = controlPlateHints(baseAtSec, hintOpts);
  } else {
    const faceSamples = [{ atSec: null, face: faceRect }]; // envelope — applies to whole clip
    plateHints = applyFaceKeepOut(controlPlateHints(baseAtSec, hintOpts), faceSamples, { safeZoneKey });
  }

  console.log(`renderTitlePreview: preset=${args.preset} format=${args.format} safeZoneKey=${safeZoneKey} face=${args.face}`);
  if (faceRect) console.log(`renderTitlePreview: face box = ${JSON.stringify(faceRect)}`);
  console.log(`renderTitlePreview: plateHints bands = ${JSON.stringify(plateHints.samples[0].bands)}`);

  // 3. Build meta (defaults + optional --meta file + optional --set overrides).
  const meta = loadMeta(args);

  // 4. GOTCHA 2 — pre-warm both candidate chrome-headless-shell cache dirs.
  preWarmHeadlessShellDirs();

  // 5. Render. keepOut:/inkVote:/inkBand: lines (Canonical.jsx's own console
  // sweeps) surface directly on this process's stdout below — see header
  // "STDOUT: keepOut: / inkVote: / inkBand:" for why, and the note on the
  // separate renderTitlesJob child-process observability gap this script
  // does not have and does not attempt to fix.
  // ⚠️ FONTS IN THIS OUTPUT ARE NOT THE BRAND'S FONTS. `tokens: {}` below means
  // remotion/lib/tokens.js falls back to FONT_DEFAULTS — Playfair Display /
  // Inter / Lora. Production resolves real brand faces through
  // fontResolverService (Brand.customFonts -> Google -> library match) and
  // logs the winner per role as `fonts=heading:X(custom|google|library-match|
  // default)` in brandScriptExecutor. This banner exists because output from
  // this script was once mistaken for a production font regression (2026-08-31)
  // — the serif is this harness, not the pipeline. Judge GEOMETRY here
  // (placement, overlap, clipping, safe zones); judge TYPEFACE from the render
  // log or the delivered asset.
  console.log('renderTitlePreview: NOTE — fonts below are harness defaults '
    + '(Playfair/Inter/Lora), NOT the brand\'s real fonts. Geometry is accurate; typeface is not.');
  console.log('renderTitlePreview: rendering...');
  const result = await renderPreview({
    meta,
    spec,
    tokens: {},
    format: args.format,
    safeZoneKey,
    // A REAL base plate (an ad's untitled veoVideoUrl, downloaded to disk)
    // instead of the flat colour. renderPreview probes its true fps/duration
    // and composites the titles onto the actual source frame at each
    // --at timestamp, so what comes out is frame-accurate to production —
    // the only way to judge a PLACEMENT question ("does this copy sit on the
    // model's face?"), which a flat plate cannot answer at all.
    // plateHintsOverride still wins over the scan, so band flags stay
    // reproducible and no Gemini/vision call is made.
    plateVideoPath: args.plateVideo || null,
    plateColor: args.plateColor,
    scale: args.scale,
    durationSec: args.duration,
    stillTimesSec: args.at,
    includeVideo: args.includeVideo,
    // --real-scan: hand renderPreview NOTHING, so it runs the REAL
    // plateIntelService.analyzePlate over the REAL frames of --plate-video and
    // the composition reads genuine measured luminance/texture instead of a
    // hand-built fixture. This is the only mode that can answer "is this
    // ACTUAL delivered ad hard to read", which a synthetic plate cannot.
    // Keep TITLE_PLATE_SCAN=basic (the default) for it: basic is pure local
    // sharp luminance — free, no network, no vision call. `gemini` would add a
    // billable per-video call and only contributes `avoid` flags, which are a
    // placement signal, not a contrast one.
    plateHintsOverride: args.realScan ? null : plateHints,
  });

  // 6. Write output(s).
  fs.mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseOut = args.out
    ? path.resolve(args.out)
    : path.join(DEFAULT_OUT_DIR, `${args.preset}_${args.format}_${args.face}_${ts}.png`);
  const baseOutNoExt = baseOut.replace(/\.png$/i, '');

  const multi = result.frames.length > 1;
  for (const frame of result.frames) {
    const outPath = multi ? `${baseOutNoExt}_f${frame.index}.png` : baseOut;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const b64 = frame.dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    console.log(`renderTitlePreview: wrote still (frame ${frame.index}) -> ${outPath}`);
  }

  if (args.includeVideo && result.videoDataUrl) {
    const videoPath = `${baseOutNoExt}.mp4`;
    const b64 = result.videoDataUrl.replace(/^data:video\/mp4;base64,/, '');
    fs.writeFileSync(videoPath, Buffer.from(b64, 'base64'));
    console.log(`renderTitlePreview: wrote video -> ${videoPath} (${result.sizeBytes} bytes)`);
  }

  if (args.realScan && result.plateHints?.samples?.length) {
    console.log('renderTitlePreview: REAL measured bands from the actual footage:');
    for (const smp of result.plateHints.samples) {
      console.log(`    t=${String(smp.atSec).padStart(5)}s  ${JSON.stringify(smp.bands)}`);
    }
  } else if (args.realScan) {
    console.log('renderTitlePreview: --real-scan produced NO hints (scan off, or plate unreadable).');
  }
  console.log(`renderTitlePreview: done. timings=${JSON.stringify(result.timings)}`);
  console.log('renderTitlePreview: scan the log above for keepOut:/inkVote:/inkBand: lines to see what Canonical.jsx actually decided.');
  process.exit(0);
})().catch((e) => {
  console.error('renderTitlePreview FAILED:', e);
  process.exit(1);
});
