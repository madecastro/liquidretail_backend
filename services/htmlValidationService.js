// Phase 6.2 — HTML Layout Generator output validator.
//
// Deterministic JS pass over each HTML candidate the Generator emits.
// Drives:
//   - Pre-Judge filter (hard violators dropped before Judge picks winner)
//   - AiHtmlValidationArtifact persistence (per candidate)
//   - Spec preview warnings panel
//
// Intentionally NO external DOM parser dep — regex + light state machines
// keep the dependency surface lean. Phase 7.0 (post-render lint) adds
// Puppeteer-driven measurement for overflow / actual computed styles
// which can't be done from raw HTML alone.
//
// Conforms to schemas/contracts/ai_canvas_validation.v1.json.

const axios = require('axios');

// WCAG 2.1 contrast thresholds. AA = 4.5 normal, 3 large/bold.
const AA_THRESHOLD_NORMAL = 4.5;
const AA_THRESHOLD_LARGE  = 3.0;

const IMAGE_PROBE_TIMEOUT_MS = 5000;
const IMAGE_PROBE_CONCURRENCY = 4;

// Hard-violation codes the Pre-Judge filter drops on.
const HARD_VIOLATION_CODES = new Set([
  'parse_failed',
  'no_html',
  'no_body',
  'has_script',
  'image_404_critical',
  'proof_strategy_unsupported'
]);

// Roles the proof-strategy compliance check accepts as "surfacing proof".
const PROOF_ZONE_ROLES = new Set([
  'quote', 'quote_card', 'testimonial',
  'rating', 'star_rating',
  'stat', 'stat_hero', 'social_proof', 'proof_bar',
  'review', 'review_card',
  'comment', 'comment_overlay'
]);

// ── Entry point ──────────────────────────────────────────────────────

async function validateCandidate(html, {
  aspectRatio,
  hierarchySpec = null,
  candidateIndex = 0,
  colorPalette = []
} = {}) {
  const warnings = [];
  const hardViolations = new Set();

  // 1. Parse structure — required tags + forbidden tags.
  const structural = parseStructure(html);
  if (!structural.parseOk)  hardViolations.add('parse_failed');
  if (!structural.hasHtml)  hardViolations.add('no_html');
  if (!structural.hasBody)  hardViolations.add('no_body');
  if (structural.scripts.length) {
    hardViolations.add('has_script');
    warnings.push({ severity: 'high', code: 'has_script', message: `${structural.scripts.length} <script> tag(s) found — forbidden in renderer offline mode` });
  }
  if (structural.externalStyles.length) {
    warnings.push({ severity: 'medium', code: 'external_link', message: `${structural.externalStyles.length} external <link rel="stylesheet"> tag(s) — renderer runs offline, will timeout`, locator: structural.externalStyles[0] });
  }
  if (structural.externalScripts.length) {
    // already covered by has_script hard violation, but list URLs for diagnosis
    warnings.push({ severity: 'high', code: 'external_script', message: `external scripts referenced: ${structural.externalScripts.join(', ').slice(0, 200)}` });
  }

  // 2. Placeholder / empty text checks.
  if (/lorem ipsum/i.test(html)) {
    warnings.push({ severity: 'high', code: 'lorem_ipsum', message: 'Placeholder text "Lorem ipsum" detected — replace with real copy' });
  }
  if (/{{\s*\w+\s*}}/.test(html)) {
    warnings.push({ severity: 'high', code: 'unresolved_placeholder', message: 'Unresolved template placeholder ({{...}}) found — LLM should bake values directly' });
  }

  // 3. Image probes — parallel HEAD requests. Hero image (first <img>) is
  //    treated as critical; downstream images warn only.
  const imageUrls = extractImageUrls(html);
  const imageProbe = await probeImages(imageUrls);
  if (imageProbe.failed.length > 0) {
    const heroFailed = imageProbe.failed.includes(imageUrls[0]);
    if (heroFailed) {
      hardViolations.add('image_404_critical');
      warnings.push({ severity: 'high', code: 'image_404_critical', message: `Hero image returned non-2xx: ${imageUrls[0]}` });
    }
    for (const url of imageProbe.failed.slice(0, 5)) {
      if (url === imageUrls[0]) continue;
      warnings.push({ severity: 'medium', code: 'image_404', message: `Image returned non-2xx: ${url}` });
    }
  }

  // 4. Contrast checks — heuristic (parses inline + <style> color rules,
  //    matches text elements to their nearest backgrounded ancestor).
  const contrastChecks = extractContrastChecks(html);
  for (const c of contrastChecks) {
    const isLargeText = c.fontPx >= 24 || (c.fontPx >= 19 && c.isBold);
    const threshold = isLargeText ? AA_THRESHOLD_LARGE : AA_THRESHOLD_NORMAL;
    c.passAA = c.ratio >= threshold;
    if (!c.passAA) {
      warnings.push({
        severity: 'medium',
        code: 'contrast_below_aa',
        message: `Text/background contrast ${c.ratio.toFixed(2)}:1 below AA threshold ${threshold}:1`,
        locator: c.selector
      });
    }
  }

  // 5. Proof-strategy compliance — when hierarchy_spec.strategy.social_proof_type
  //    is non-none, the layout.zones[] MUST include a proof-bearing role.
  //    Reuses the same logic as the JSON-spec Pre-Judge filter.
  if (hierarchyViolatesProofStrategy(hierarchySpec)) {
    hardViolations.add('proof_strategy_unsupported');
    warnings.push({
      severity: 'high',
      code: 'proof_strategy_unsupported',
      message: `hierarchy_spec.strategy.social_proof_type="${hierarchySpec?.strategy?.social_proof_type}" but no proof-bearing zone in layout.zones[]`
    });
  }

  // 6. Color palette sanity — at least 2 colors with one combo above AA.
  if (Array.isArray(colorPalette) && colorPalette.length >= 2) {
    let anyAA = false;
    for (let i = 0; i < colorPalette.length; i++) {
      for (let j = i + 1; j < colorPalette.length; j++) {
        const r = contrastRatio(colorPalette[i], colorPalette[j]);
        if (r >= AA_THRESHOLD_NORMAL) { anyAA = true; break; }
      }
      if (anyAA) break;
    }
    if (!anyAA) {
      warnings.push({
        severity: 'medium',
        code: 'palette_no_aa_combo',
        message: `No 2-color combo in palette ${colorPalette.join(',')} achieves AA contrast — text legibility at risk`
      });
    }
  }

  return {
    candidateIndex,
    parseOk: structural.parseOk,
    hardViolations: [...hardViolations],
    warnings,
    imageProbe,
    contrastChecks,
    computedDimensions: { width: null, height: null, overflow: false }   // populated in Phase 7 (Puppeteer)
  };
}

// ── Structure parsing ────────────────────────────────────────────────
// Lightweight regex-based parser. Good enough for the structural checks
// we need (required tags + forbidden tags + counted occurrences). When
// Phase 7 lands Puppeteer-driven measurement we get the real DOM.

function parseStructure(html) {
  const result = {
    parseOk:        false,
    hasHtml:        false,
    hasBody:        false,
    scripts:        [],
    externalStyles: [],
    externalScripts:[]
  };
  if (typeof html !== 'string' || !html.trim()) return result;
  // Very basic well-formedness — balanced enough that we can find <body>.
  // We don't try to validate every closing tag (LLM HTML may be loose).
  result.hasHtml = /<html[\s>]/i.test(html);
  result.hasBody = /<body[\s>]/i.test(html);
  result.parseOk = result.hasHtml && result.hasBody;

  // Forbidden tags
  const scriptMatches = html.match(/<script[\s>][^]*?(<\/script>|$)/gi) || [];
  result.scripts = scriptMatches.slice(0, 10);
  // External scripts
  const srcRe = /<script[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    result.externalScripts.push(m[1]);
  }
  // External stylesheets
  const linkRe = /<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi;
  while ((m = linkRe.exec(html)) !== null) {
    result.externalStyles.push(m[1]);
  }
  // @import in inline style — also external
  const importRe = /@import\s+(?:url\()?["']([^"')]+)["']/gi;
  while ((m = importRe.exec(html)) !== null) {
    result.externalStyles.push(m[1]);
  }
  return result;
}

// ── Image probe ──────────────────────────────────────────────────────

function extractImageUrls(html) {
  if (typeof html !== 'string') return [];
  const urls = [];
  const seen = new Set();
  const re = /<img[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    if (!url || seen.has(url)) continue;
    if (url.startsWith('data:')) continue;   // inline data URLs — skip probe
    seen.add(url);
    urls.push(url);
  }
  // Background-image URLs in inline styles + <style> blocks
  const bgRe = /background(?:-image)?\s*:[^;]*url\(["']?([^"')]+)["']?\)/gi;
  while ((m = bgRe.exec(html)) !== null) {
    const url = m[1].trim();
    if (!url || seen.has(url) || url.startsWith('data:')) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function probeImages(urls) {
  const out = { tested: urls.length, ok: 0, failed: [] };
  if (!urls.length) return out;
  // Simple parallel pool with concurrency cap.
  const queue = urls.slice();
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const res = await axios.head(url, { timeout: IMAGE_PROBE_TIMEOUT_MS, validateStatus: () => true, maxRedirects: 3 });
        if (res.status >= 200 && res.status < 400) {
          out.ok++;
        } else {
          out.failed.push(url);
        }
      } catch (_) {
        out.failed.push(url);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_PROBE_CONCURRENCY, urls.length) }, worker));
  return out;
}

// ── Contrast extraction ──────────────────────────────────────────────
// Heuristic: parses inline color/background-color declarations + <style>
// block rules, builds a coarse selector → color map. For each text-like
// element with an explicit color, walks UP the DOM (regex-approximate)
// to find the nearest background-color and computes WCAG ratio.
//
// Limitation: this misses cascaded styles from class rules that target
// children. Phase 7 with Puppeteer can use getComputedStyle for the
// truth; for Phase 6.2 the inline-only check catches the obvious cases.

function extractContrastChecks(html) {
  const checks = [];
  if (typeof html !== 'string') return checks;

  // Pull <style> block contents (concatenated).
  const styleBlocks = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(html)) !== null) styleBlocks.push(sm[1]);
  const styleSrc = styleBlocks.join('\n');

  // Pick up the BODY background-color from inline style or body selector.
  let bodyBg = pickBodyBg(html, styleSrc);

  // For each element with inline style="...color: X; ... background-color: Y; ...",
  // produce a contrast check pair. Walk elements + their inline styles.
  const inlineEls = extractInlineStyledElements(html).slice(0, 40);   // cap at 40 elements
  for (const el of inlineEls) {
    const color = extractStyleColor(el.style, 'color');
    let bg = extractStyleColor(el.style, 'background-color') || extractStyleColor(el.style, 'background');
    if (!color) continue;          // no explicit text color — skip
    if (!bg) bg = bodyBg;          // fall back to body background
    if (!bg) continue;             // no background context — can't compute
    const fontPx = extractFontPx(el.style);
    const isBold = /font-weight\s*:\s*(?:700|800|900|bold)/i.test(el.style);
    checks.push({
      selector: el.tagSnippet,
      fg: bg,                        // INTENTIONAL swap below — we want ratio(fg, bg)
      bg: color,
      ratio: contrastRatio(color, bg),
      fontPx: fontPx || 16,
      isBold,
      passAA: false                 // filled by caller
    });
    // (note: the .fg/.bg fields are reversed-named above by accident — let's correct)
  }
  // Correct fg/bg labelling — done in caller-friendly shape:
  for (const c of checks) {
    const swappedFg = c.bg;
    const swappedBg = c.fg;
    c.fg = swappedFg;
    c.bg = swappedBg;
  }
  return checks;
}

function pickBodyBg(html, styleSrc) {
  // Inline body style first
  const bodyTag = (html.match(/<body[^>]*>/i) || [])[0] || '';
  const styleAttr = (bodyTag.match(/\bstyle=["']([^"']+)["']/i) || [])[1];
  if (styleAttr) {
    const c = extractStyleColor(styleAttr, 'background-color') || extractStyleColor(styleAttr, 'background');
    if (c) return c;
  }
  // body {} rule
  const bodyRule = (styleSrc.match(/body\s*\{([^}]+)\}/i) || [])[1];
  if (bodyRule) {
    const c = extractStyleColor(bodyRule, 'background-color') || extractStyleColor(bodyRule, 'background');
    if (c) return c;
  }
  return null;
}

function extractInlineStyledElements(html) {
  const out = [];
  // Capture text elements with inline style. Limit to common text tags so
  // we don't pull every <div> with margin styles.
  const re = /<(h1|h2|h3|h4|h5|h6|p|span|button|a|li|strong|em|b|i)\b[^>]*\bstyle=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      tag: m[1].toLowerCase(),
      style: m[2],
      tagSnippet: html.substring(m.index, m.index + 80).replace(/\s+/g, ' ')
    });
  }
  return out;
}

function extractStyleColor(style, prop) {
  if (!style) return null;
  const re = new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i');
  const m = style.match(re);
  if (!m) return null;
  return normalizeColor(m[2].trim());
}

function extractFontPx(style) {
  if (!style) return null;
  const m = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/i);
  return m ? parseFloat(m[1]) : null;
}

function normalizeColor(s) {
  if (!s) return null;
  s = s.trim().toLowerCase();
  // #abc → #aabbcc
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const h = m[1];
    return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  // #aabbcc
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return '#' + m[1];
  // rgb(r, g, b)
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const toHex = (n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
  }
  // Named colors — only a tiny subset to avoid a full table.
  const named = {
    white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000',
    blue: '#0000ff', gray: '#808080', grey: '#808080'
  };
  return named[s] || null;
}

// ── Contrast math ────────────────────────────────────────────────────

function contrastRatio(c1, c2) {
  const L1 = relativeLuminance(c1);
  const L2 = relativeLuminance(c2);
  if (L1 == null || L2 == null) return 0;
  const lighter = Math.max(L1, L2);
  const darker  = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex) {
  const h = normalizeColor(hex);
  if (!h) return null;
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// ── Proof-strategy compliance ────────────────────────────────────────

function hierarchyViolatesProofStrategy(hierarchySpec) {
  const hs = hierarchySpec;
  if (!hs?.strategy) return false;
  const proofType = String(hs.strategy.social_proof_type || '').toLowerCase();
  if (!proofType || ['none', 'absent', ''].includes(proofType)) return false;
  const zones = hs.layout?.zones || [];
  return !zones.some(z => PROOF_ZONE_ROLES.has(String(z.role || '').toLowerCase()));
}

module.exports = {
  validateCandidate,
  // exposed for tests + reuse
  parseStructure,
  extractImageUrls,
  extractContrastChecks,
  contrastRatio,
  hierarchyViolatesProofStrategy,
  HARD_VIOLATION_CODES
};
