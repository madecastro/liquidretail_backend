#!/usr/bin/env node
/**
 * verifyFormatAwareCharCaps.mjs — character caps track the painted box.
 * Offline: no DB, no network. ESM because remotion/lib/slotContent.js is
 * "type":"module".
 *
 * THE DEFECT THIS PINS
 * --------------------
 * remotion/lib/slotContent.js used a SINGLE GLOBAL TEXT_CHAR_CAP table
 * (headline:72, quote:120, …) with no knowledge of format, slot width,
 * line count, or font size. Width-fraction scaling alone left vertical
 * at 72; a delivered Marine Layer 9:16 still clamp-cut a ~51-char
 * headline mid-phrase via CSS -webkit-line-clamp. The char cap must fire
 * BEFORE the browser clamp, word-safe.
 *
 * MODEL (same arithmetic as services/videoHeadlineService.js):
 *   chars ≈ (usableWidthPx × maxLines) / (0.70 × fontPx) × 0.91
 *
 * Contract:
 *   1. No context → caps EXACTLY equal today's TEXT_CHAR_CAP (inertness)
 *   2. landscape < vertical for headline + quote; both tightened
 *   3. panel-column cap <= landscape cap
 *   4. every derived cap >= readable floor (no single-word stubs)
 *   5. truncateWordSafe never cuts mid-word at any derived cap
 *   6. long headline at landscape produces a shorter string than vertical
 *   7. malformed context falls back to today's caps (no throw, no NaN)
 *   8. vertical ~46 / landscape ~32 (videoHeadlineService budgets)
 *   9. real delivered Marine Layer string cut word-safe at vertical cap
 *  10. monotonicity: more lines / bigger font / wider box
 *
 * REVERT-PROOF: drop maxLines from the model (or force scale-only) →
 * vertical checks that demand ~46 go red.
 */

import {
  TEXT_CHAR_CAP,
  TEXT_CHAR_FLOOR,
  CAP_REF_MAX_WIDTH_PCT,
  LANDSCAPE_DEFAULT_MAX_WIDTH_PCT,
  PANEL_DEFAULT_WIDTH_FRAC,
  AVG_CHAR_WIDTH_EM,
  CHAR_CAP_SAFETY,
  CANVAS_WIDTH_DEFAULT,
  DEFAULT_MAX_LINES,
  DEFAULT_BASE_FONT_PX,
  DEFAULT_SIZE_SCALE,
  deriveCharCap,
  resolveEffectiveMaxWidthPct,
  resolveUsableWidthPx,
  resolveMaxLines,
  resolveFontPx,
  truncateWordSafe,
  fitProductNameToCap,
  resolveSlotContent,
  resolveSlotContentCore,
} from '../remotion/lib/slotContent.js';

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('verifyFormatAwareCharCaps\n');

// Frozen snapshot of today's table — the inertness contract.
const TODAY_CAPS = {
  productName: 48,
  headline: 72,
  quote: 120,
  deliveryLine: 40,
  badge: 28,
  promo: 28,
  productDescription: 80,
  tagline: 56,
};

// videoHeadlineService.js documented budgets (do NOT import that module —
// different lane; just agree with the numbers it documents).
const VHS_LANDSCAPE_HEADLINE = 32;
const VHS_VERTICAL_HEADLINE = 46;

// ── 1. No context => caps EXACTLY equal today's TEXT_CHAR_CAP ─────────────
{
  for (const key of Object.keys(TODAY_CAPS)) {
    check(
      `1 TEXT_CHAR_CAP.${key} === ${TODAY_CAPS[key]} (shipped baseline)`,
      TEXT_CHAR_CAP[key] === TODAY_CAPS[key],
      `got ${TEXT_CHAR_CAP[key]}`
    );
    check(
      `1 deriveCharCap('${key}', undefined) === TEXT_CHAR_CAP`,
      deriveCharCap(key, undefined) === TEXT_CHAR_CAP[key]
    );
    check(
      `1 deriveCharCap('${key}', null) === TEXT_CHAR_CAP`,
      deriveCharCap(key, null) === TEXT_CHAR_CAP[key]
    );
    check(
      `1 deriveCharCap('${key}', {}) === TEXT_CHAR_CAP (empty ctx inert)`,
      deriveCharCap(key, {}) === TEXT_CHAR_CAP[key]
    );
  }
  // End-to-end: resolveSlotContent with no ctx must truncate at base.
  const long = 'A'.repeat(200);
  const slot = {
    key: 'headline',
    visible: true,
    bind: ['headline'],
  };
  const noCtx = resolveSlotContentCore(slot, { headline: long });
  const expected = truncateWordSafe(long, TODAY_CAPS.headline);
  check(
    '1 resolveSlotContentCore no-ctx truncates at TEXT_CHAR_CAP.headline',
    noCtx === expected,
    `got len=${noCtx?.length} expected len=${expected.length}`
  );
}

// ── 2. landscape cap < vertical cap; vertical is tightened (not base 72) ──
{
  const vHead = deriveCharCap('headline', { format: 'vertical' });
  const lHead = deriveCharCap('headline', { format: 'landscape' });
  const vQuote = deriveCharCap('quote', { format: 'vertical' });
  const lQuote = deriveCharCap('quote', { format: 'landscape' });

  check(
    '2 vertical headline meaningfully below historical 72',
    vHead < TEXT_CHAR_CAP.headline && vHead <= 50,
    `vertical=${vHead}`
  );
  check('2 landscape headline < vertical headline', lHead < vHead,
    `landscape=${lHead} vertical=${vHead}`);
  check(
    '2 vertical quote below historical 120',
    vQuote < TEXT_CHAR_CAP.quote,
    `vertical=${vQuote}`
  );
  check('2 landscape quote < vertical quote OR both floored',
    lQuote <= vQuote,
    `landscape=${lQuote} vertical=${vQuote}`);

  // Explicit maxWidthPct path (what Canonical passes from the preset).
  const lHeadPct = deriveCharCap('headline', {
    format: 'landscape',
    maxWidthPct: LANDSCAPE_DEFAULT_MAX_WIDTH_PCT,
  });
  check(
    '2 landscape+maxWidthPct 0.46 matches format-only landscape',
    lHeadPct === lHead,
    `pct=${lHeadPct} formatOnly=${lHead}`
  );

  // Full geometry path matching videoHeadlineService arithmetic.
  const lHeadFull = deriveCharCap('headline', {
    format: 'landscape',
    canvasWidth: 1920,
    maxWidthPct: 0.46,
    maxLines: 2,
    fontPx: 72,
  });
  const vHeadFull = deriveCharCap('headline', {
    format: 'vertical',
    canvasWidth: 1080,
    maxWidthPct: 0.9,
    maxLines: 3,
    fontPx: 81.6,
  });
  check('2 landscape full-geometry headline', lHeadFull === lHead
    || Math.abs(lHeadFull - lHead) <= 1,
    `full=${lHeadFull} formatOnly=${lHead}`);
  check('2 vertical full-geometry headline', vHeadFull === vHead
    || Math.abs(vHeadFull - vHead) <= 1,
    `full=${vHeadFull} formatOnly=${vHead}`);
}

// ── 3. panel-column cap <= landscape cap ──────────────────────────────────
{
  const lHead = deriveCharCap('headline', { format: 'landscape', maxWidthPct: 0.46 });
  const pHead = deriveCharCap('headline', {
    format: 'landscape',
    maxWidthPct: 0.46,
    panelColumn: true,
    panelWidthFrac: PANEL_DEFAULT_WIDTH_FRAC,
  });
  const lQuote = deriveCharCap('quote', { format: 'landscape', maxWidthPct: 0.46 });
  const pQuote = deriveCharCap('quote', {
    format: 'landscape',
    maxWidthPct: 0.46,
    panelSide: 'west',
    panelWidthFrac: PANEL_DEFAULT_WIDTH_FRAC,
  });

  check('3 panel headline <= landscape headline', pHead <= lHead,
    `panel=${pHead} landscape=${lHead}`);
  check('3 panel quote <= landscape quote', pQuote <= lQuote,
    `panel=${pQuote} landscape=${lQuote}`);

  // Tighter east panel (landscapeYt right chrome 0.15 → ~0.33 width) must
  // not exceed the west/default panel cap.
  const eastHead = deriveCharCap('headline', {
    format: 'landscape',
    maxWidthPct: 0.46,
    panelColumn: true,
    panelWidthFrac: 0.33,
  });
  check('3 east-narrow panel headline <= default panel', eastHead <= pHead,
    `east=${eastHead} west=${pHead}`);
}

// ── 4. Every derived cap >= readable floor ────────────────────────────────
{
  const contexts = [
    { label: 'vertical', ctx: { format: 'vertical' } },
    { label: 'landscape', ctx: { format: 'landscape' } },
    { label: 'landscape+0.46', ctx: { format: 'landscape', maxWidthPct: 0.46 } },
    {
      label: 'panel-west',
      ctx: {
        format: 'landscape',
        maxWidthPct: 0.46,
        panelColumn: true,
        panelWidthFrac: PANEL_DEFAULT_WIDTH_FRAC,
      },
    },
    {
      label: 'panel-east-narrow',
      ctx: {
        format: 'landscape',
        maxWidthPct: 0.46,
        panelColumn: true,
        panelWidthFrac: 0.33,
      },
    },
    // Pathological: force a tiny width; floor must still hold.
    {
      label: 'pathological-0.1',
      ctx: { maxWidthPct: 0.1, panelColumn: true, panelWidthFrac: 0.1 },
    },
  ];
  for (const { label, ctx } of contexts) {
    for (const key of Object.keys(TEXT_CHAR_CAP)) {
      const cap = deriveCharCap(key, ctx);
      const floor = TEXT_CHAR_FLOOR[key];
      check(
        `4 ${label} ${key} cap ${cap} >= floor ${floor}`,
        Number.isFinite(cap) && cap >= floor,
        `cap=${cap}`
      );
      check(
        `4 ${label} ${key} cap ${cap} <= base ${TEXT_CHAR_CAP[key]}`,
        cap <= TEXT_CHAR_CAP[key]
      );
    }
  }
}

// ── 5. truncateWordSafe never cuts mid-word at any derived cap ────────────
{
  const sample =
    'Meet the all new Short Sleeve Strato Breathe Tech Tee for everyday runs';
  const capsToTry = new Set([
    TEXT_CHAR_CAP.headline,
    deriveCharCap('headline', { format: 'landscape' }),
    deriveCharCap('headline', { format: 'vertical' }),
    deriveCharCap('headline', {
      format: 'landscape',
      panelColumn: true,
      panelWidthFrac: PANEL_DEFAULT_WIDTH_FRAC,
    }),
    deriveCharCap('quote', { format: 'landscape' }),
    TEXT_CHAR_FLOOR.headline,
    TEXT_CHAR_FLOOR.quote,
    40,
    37,
    32,
    46,
  ]);
  for (const cap of capsToTry) {
    const out = truncateWordSafe(sample, cap);
    const body = out.endsWith('…') ? out.slice(0, -1) : out;
    if (body.length === 0) {
      check(`5 cap=${cap} produced empty body`, false);
      continue;
    }
    check(
      `5 cap=${cap} result is a prefix of source (modulo ellipsis)`,
      sample.startsWith(body),
      `out=${JSON.stringify(out)}`
    );
    if (out.endsWith('…') && body.length < sample.length) {
      const atWordBoundary = sample[body.length] === ' ' || sample[body.length] === undefined;
      const window = sample.slice(0, cap);
      const hardCutFallback = window.lastIndexOf(' ') < Math.floor(cap * 0.5);
      check(
        `5 cap=${cap} ellipsis only between words (or documented hard-cut)`,
        atWordBoundary || hardCutFallback,
        `body=${JSON.stringify(body)} next=${JSON.stringify(sample[body.length])} hardCut=${hardCutFallback}`
      );
      if (!hardCutFallback) {
        check(
          `5 cap=${cap} does not end mid-word when space available`,
          atWordBoundary,
          `body ends with ${JSON.stringify(body.slice(-8))}`
        );
      }
    }
  }
}

// ── 6. Long headline: landscape string shorter than vertical (e2e plumbing)
{
  const longHeadline =
    'Meet the all-new Short Sleeve Strato Breathe Tech performance tee designed for everyday miles and long weekend adventures';
  const slot = {
    key: 'headline',
    visible: true,
    bind: ['headline'],
    position: { maxWidthPct: 0.9 },
  };
  const vertical = resolveSlotContent(
    { ...slot, position: { maxWidthPct: 0.9 }, treatment: { maxLines: 3, sizeScale: 1.2 } },
    { headline: longHeadline },
    null,
    { format: 'vertical', maxWidthPct: 0.9, maxLines: 3, fontPx: 81.6 }
  );
  const landscape = resolveSlotContent(
    { ...slot, position: { maxWidthPct: 0.46 }, treatment: { maxLines: 2, sizeScale: 1.2 } },
    { headline: longHeadline },
    null,
    { format: 'landscape', maxWidthPct: 0.46, maxLines: 2, fontPx: 72 }
  );
  check('6 vertical resolves a string', typeof vertical === 'string' && vertical.length > 0);
  check('6 landscape resolves a string', typeof landscape === 'string' && landscape.length > 0);
  check(
    '6 landscape truncated string is shorter than vertical',
    landscape.length < vertical.length,
    `landscape len=${landscape?.length} vertical len=${vertical?.length}`
  );
  const lCap = deriveCharCap('headline', {
    format: 'landscape', maxWidthPct: 0.46, maxLines: 2, fontPx: 72,
  });
  const vCap = deriveCharCap('headline', {
    format: 'vertical', maxWidthPct: 0.9, maxLines: 3, fontPx: 81.6,
  });
  check(
    '6 landscape result length respects landscape cap (not base 72)',
    landscape.replace(/…$/, '').length <= lCap
      && landscape.length <= lCap + 1,
    `len=${landscape.length} cap=${lCap}`
  );
  check(
    '6 vertical result length respects vertical derived cap (not base 72)',
    vertical.replace(/…$/, '').length <= vCap
      && vertical.length <= vCap + 1,
    `len=${vertical.length} cap=${vCap}`
  );
  check(
    '6 vertical cap is below historical 72',
    vCap < TEXT_CHAR_CAP.headline,
    `vCap=${vCap}`
  );
}

// ── 7. Malformed context falls back to today's caps ───────────────────────
{
  const bads = [
    null,
    undefined,
    { format: 'notAFormat' },
    { maxWidthPct: NaN },
    { maxWidthPct: -1 },
    { maxWidthPct: 0 },
    { panelWidthFrac: NaN, panelColumn: true, format: 'nope' },
    { format: null },
    { format: 123 },
  ];
  for (const ctx of bads) {
    let threw = false;
    let cap;
    try {
      cap = deriveCharCap('headline', ctx);
    } catch (e) {
      threw = true;
      cap = e;
    }
    const label = ctx === undefined ? 'undefined' : JSON.stringify(ctx);
    check(
      `7 deriveCharCap does not throw on ${label}`,
      !threw,
      threw ? String(cap) : ''
    );
    check(
      `7 deriveCharCap falls back to base on ${label}`,
      cap === TEXT_CHAR_CAP.headline,
      `got ${cap}`
    );
    check(
      `7 cap is finite (not NaN) for ${label}`,
      Number.isFinite(cap)
    );
  }

  // NaN maxWidthPct with a KNOWN format: ignore the NaN, keep the format
  // default (same as omitting maxWidthPct). Must not throw or emit NaN.
  {
    let threw = false;
    let cap;
    try {
      cap = deriveCharCap('headline', { format: 'landscape', maxWidthPct: NaN });
    } catch (e) {
      threw = true;
      cap = e;
    }
    const landscapeOnly = deriveCharCap('headline', { format: 'landscape' });
    check('7 NaN maxWidthPct + landscape does not throw', !threw);
    check('7 NaN maxWidthPct + landscape uses format default (not NaN, not base)',
      cap === landscapeOnly && Number.isFinite(cap) && cap < TEXT_CHAR_CAP.headline,
      `got ${cap} expected ${landscapeOnly}`);
  }

  // resolveEffectiveMaxWidthPct / resolveUsableWidthPx same fail-closed.
  for (const ctx of [null, undefined, { format: 'xyz' }, { maxWidthPct: NaN }]) {
    let threw = false;
    let out;
    let outPx;
    try {
      out = resolveEffectiveMaxWidthPct(ctx);
      outPx = resolveUsableWidthPx(ctx);
    } catch (e) {
      threw = true;
      out = e;
    }
    check(`7 resolveEffectiveMaxWidthPct no throw on ${JSON.stringify(ctx)}`, !threw);
    check(
      `7 resolveEffectiveMaxWidthPct not NaN on ${JSON.stringify(ctx)}`,
      out == null || Number.isFinite(out),
      `got ${out}`
    );
    check(
      `7 resolveUsableWidthPx not NaN on ${JSON.stringify(ctx)}`,
      outPx == null || Number.isFinite(outPx),
      `got ${outPx}`
    );
  }

  // resolveSlotContent itself must not throw on bad ctx.
  const slot = { key: 'headline', visible: true, bind: ['headline'] };
  let threw = false;
  let resolved;
  try {
    resolved = resolveSlotContent(slot, { headline: 'Hello world product' }, null, {
      format: 'nope',
      maxWidthPct: NaN,
    });
  } catch (e) {
    threw = true;
    resolved = e;
  }
  check('7 resolveSlotContent does not throw on malformed ctx', !threw);
  check(
    '7 resolveSlotContent returns full short string under malformed ctx',
    resolved === 'Hello world product',
    `got ${JSON.stringify(resolved)}`
  );
}

// ── 8. Cross-check videoHeadlineService budgets (within ~2 chars) ─────────
{
  const vHead = deriveCharCap('headline', {
    format: 'vertical',
    canvasWidth: 1080,
    maxWidthPct: 0.9,
    maxLines: 3,
    fontPx: 81.6,
  });
  const lHead = deriveCharCap('headline', {
    format: 'landscape',
    canvasWidth: 1920,
    maxWidthPct: 0.46,
    maxLines: 2,
    fontPx: 72,
  });
  // Format-only defaults must also land in the same band.
  const vHeadFmt = deriveCharCap('headline', { format: 'vertical' });
  const lHeadFmt = deriveCharCap('headline', { format: 'landscape' });

  check(
    `8 vertical headline within ~2 of videoHeadlineService ${VHS_VERTICAL_HEADLINE}`,
    Math.abs(vHead - VHS_VERTICAL_HEADLINE) <= 2,
    `got ${vHead}`
  );
  check(
    `8 landscape headline within ~2 of videoHeadlineService ${VHS_LANDSCAPE_HEADLINE}`,
    Math.abs(lHead - VHS_LANDSCAPE_HEADLINE) <= 2,
    `got ${lHead}`
  );
  check(
    `8 format-only vertical headline within ~2 of ${VHS_VERTICAL_HEADLINE}`,
    Math.abs(vHeadFmt - VHS_VERTICAL_HEADLINE) <= 2,
    `got ${vHeadFmt}`
  );
  check(
    `8 format-only landscape headline within ~2 of ${VHS_LANDSCAPE_HEADLINE}`,
    Math.abs(lHeadFmt - VHS_LANDSCAPE_HEADLINE) <= 2,
    `got ${lHeadFmt}`
  );

  // Reproduce the raw model arithmetic the comments claim.
  const landRaw = (0.46 * 1920 * 2) / (AVG_CHAR_WIDTH_EM * 72);
  const vertRaw = (0.9 * 1080 * 3) / (AVG_CHAR_WIDTH_EM * 81.6);
  check('8 landscape raw geometric estimate ≈ 35', Math.abs(landRaw - 35) < 0.1, `got ${landRaw}`);
  check('8 vertical raw geometric estimate ≈ 51', Math.abs(vertRaw - 51) < 0.1, `got ${vertRaw}`);
  check('8 landscape × safety ≈ 32', Math.round(landRaw * CHAR_CAP_SAFETY) === 32);
  check('8 vertical × safety ≈ 46', Math.round(vertRaw * CHAR_CAP_SAFETY) === 46);
}

// ── 9. Real delivered Marine Layer string — cap fires before line-clamp ───
{
  // Owner measured on the shipped Cloudinary 9:16 frame:
  //   "The ridiculously soft sweatshirt you'll live in all…"
  // That is the CSS -webkit-line-clamp (maxLines:3) cut of a ~63-char
  // string at roughly 51 chars — mid-phrase, not word-safe. Our vertical
  // cap (~46) must fire first and cut WORD-SAFE, shorter than the clamp
  // would have allowed.
  const DELIVERED =
    "The ridiculously soft sweatshirt you'll live in all winter long";
  const CLAMP_OBSERVED =
    "The ridiculously soft sweatshirt you'll live in all…";
  // Exact expected at the vertical model cap (46): assert the string so a
  // future model change must consciously re-bless it.
  const EXPECTED_AT_VERTICAL_CAP =
    "The ridiculously soft sweatshirt you'll live…";

  check('9 delivered source length is 63', DELIVERED.length === 63, `got ${DELIVERED.length}`);
  check(
    '9 clamp-observed body is ~51 chars (pre-ellipsis)',
    CLAMP_OBSERVED.replace(/…$/, '').length === 51
      || CLAMP_OBSERVED.replace(/…$/, '').length === 50,
    `got ${CLAMP_OBSERVED.replace(/…$/, '').length}`
  );

  const vCap = deriveCharCap('headline', {
    format: 'vertical',
    canvasWidth: 1080,
    maxWidthPct: 0.9,
    maxLines: 3,
    fontPx: 81.6,
  });
  check('9 vertical cap is below the ~51-char clamp ceiling', vCap < 51, `cap=${vCap}`);
  check('9 vertical cap is below historical 72', vCap < 72, `cap=${vCap}`);

  const cut = truncateWordSafe(DELIVERED, vCap);
  check(
    '9 exact word-safe cut at vertical cap (re-bless if model changes)',
    cut === EXPECTED_AT_VERTICAL_CAP,
    `got ${JSON.stringify(cut)} expected ${JSON.stringify(EXPECTED_AT_VERTICAL_CAP)}`
  );
  check(
    '9 cut is shorter than the clamp-observed string',
    cut.length < CLAMP_OBSERVED.length,
    `cut=${cut.length} clamp=${CLAMP_OBSERVED.length}`
  );
  // Word-safe: body is a prefix and the next source char is whitespace.
  const body = cut.endsWith('…') ? cut.slice(0, -1) : cut;
  check('9 cut body is a prefix of source', DELIVERED.startsWith(body));
  check(
    '9 cut is at a word boundary',
    DELIVERED[body.length] === ' ',
    `next=${JSON.stringify(DELIVERED[body.length])}`
  );

  // e2e through resolveSlotContent with vertical geometry.
  const resolved = resolveSlotContent(
    {
      key: 'headline',
      visible: true,
      bind: ['headline'],
      position: { maxWidthPct: 0.9 },
      treatment: { maxLines: 3, sizeScale: 1.2 },
    },
    { headline: DELIVERED },
    null,
    {
      format: 'vertical',
      canvasWidth: 1080,
      maxWidthPct: 0.9,
      maxLines: 3,
      fontPx: 81.6,
    }
  );
  check(
    '9 resolveSlotContent yields the same word-safe cut',
    resolved === EXPECTED_AT_VERTICAL_CAP,
    `got ${JSON.stringify(resolved)}`
  );
}

// ── 10. Monotonicity: vary ONE input at a time ────────────────────────────
{
  const base = {
    format: 'vertical',
    canvasWidth: 1080,
    maxWidthPct: 0.9,
    maxLines: 3,
    fontPx: 81.6,
  };
  // More lines => larger cap
  const lines2 = deriveCharCap('headline', { ...base, maxLines: 2 });
  const lines3 = deriveCharCap('headline', { ...base, maxLines: 3 });
  const lines4 = deriveCharCap('headline', { ...base, maxLines: 4 });
  check('10 more lines => larger cap (2 < 3)', lines2 < lines3,
    `2=${lines2} 3=${lines3}`);
  check('10 more lines => larger cap (3 < 4)', lines3 < lines4,
    `3=${lines3} 4=${lines4}`);

  // Bigger font => smaller cap
  const font60 = deriveCharCap('headline', { ...base, fontPx: 60 });
  const font82 = deriveCharCap('headline', { ...base, fontPx: 82 });
  const font100 = deriveCharCap('headline', { ...base, fontPx: 100 });
  check('10 bigger font => smaller cap (60 > 82)', font60 > font82,
    `60=${font60} 82=${font82}`);
  check('10 bigger font => smaller cap (82 > 100)', font82 > font100,
    `82=${font82} 100=${font100}`);

  // Wider box => larger cap
  const w600 = deriveCharCap('headline', {
    ...base, maxWidthPct: null, usableWidthPx: 600,
  });
  const w900 = deriveCharCap('headline', {
    ...base, maxWidthPct: null, usableWidthPx: 900,
  });
  const w1200 = deriveCharCap('headline', {
    ...base, maxWidthPct: null, usableWidthPx: 1200,
  });
  check('10 wider box => larger cap (600 < 900)', w600 < w900,
    `600=${w600} 900=${w900}`);
  check('10 wider box => larger cap (900 < 1200)', w900 < w1200,
    `900=${w900} 1200=${w1200}`);

  // Sanity: resolveMaxLines / resolveFontPx helpers
  check('10 resolveMaxLines vertical headline default is 3',
    resolveMaxLines('headline', { format: 'vertical' }) === 3);
  check('10 resolveMaxLines landscape headline default is 2',
    resolveMaxLines('headline', { format: 'landscape' }) === 2);
  check('10 resolveFontPx vertical headline ≈ 81.6',
    Math.abs(resolveFontPx('headline', { format: 'vertical' }) - 81.6) < 0.01,
    `got ${resolveFontPx('headline', { format: 'vertical' })}`);
  check('10 resolveFontPx landscape headline is 72',
    resolveFontPx('headline', { format: 'landscape' }) === 72,
    `got ${resolveFontPx('headline', { format: 'landscape' })}`);
}

// ── Constants sanity (documentation anchors) ──────────────────────────────
{
  check('C CAP_REF_MAX_WIDTH_PCT is 0.9 (vertical hook headline)', CAP_REF_MAX_WIDTH_PCT === 0.9);
  check('C LANDSCAPE_DEFAULT_MAX_WIDTH_PCT is 0.46 (canonical landscape)', LANDSCAPE_DEFAULT_MAX_WIDTH_PCT === 0.46);
  check('C PANEL_DEFAULT_WIDTH_FRAC is 0.405 (landscapeYt west)', PANEL_DEFAULT_WIDTH_FRAC === 0.405);
  check('C AVG_CHAR_WIDTH_EM is 0.70 (videoHeadlineService measure)', AVG_CHAR_WIDTH_EM === 0.70);
  check('C CHAR_CAP_SAFETY is 0.91 (32/35 margin)', Math.abs(CHAR_CAP_SAFETY - 0.91) < 0.001);
  check('C CANVAS_WIDTH_DEFAULT.vertical is 1080', CANVAS_WIDTH_DEFAULT.vertical === 1080);
  check('C CANVAS_WIDTH_DEFAULT.landscape is 1920', CANVAS_WIDTH_DEFAULT.landscape === 1920);
  check('C DEFAULT_MAX_LINES.headline.vertical is 3', DEFAULT_MAX_LINES.headline.vertical === 3);
  check('C DEFAULT_MAX_LINES.headline.landscape is 2', DEFAULT_MAX_LINES.headline.landscape === 2);
  check('C DEFAULT_BASE_FONT_PX.headline.vertical is 68', DEFAULT_BASE_FONT_PX.headline.vertical === 68);
  check('C DEFAULT_BASE_FONT_PX.headline.landscape is 60', DEFAULT_BASE_FONT_PX.headline.landscape === 60);
  check('C DEFAULT_SIZE_SCALE.headline.vertical is 1.2', DEFAULT_SIZE_SCALE.headline.vertical === 1.2);
  check('C DEFAULT_SIZE_SCALE.headline.landscape is 1.2', DEFAULT_SIZE_SCALE.headline.landscape === 1.2);
}

// ── J. productName Reels-vs-Stories width delta + noun-preserving fitter
//    (2026-08-19 truncation incident: "Women's Vuori Vintage Oversized…" on
//    Reels, a DIFFERENT cutoff on Stories for the SAME source string — the
//    tell that the clamp is width/box-driven, not a fixed source-string cap)
// ───────────────────────────────────────────────────────────────────────────
{
  const baseCtx = { format: 'vertical', canvasWidth: 1080, maxWidthPct: 0.9, maxLines: 2, fontPx: 56 * 1.2 };
  const reelsCap = deriveCharCap('productName', { ...baseCtx, platformFormat: 'meta_reels_9_16' });
  const storiesCap = deriveCharCap('productName', { ...baseCtx, platformFormat: 'meta_stories_9_16' });
  check('J1 stories productName cap === vertical (stories zone not narrower)',
    storiesCap === deriveCharCap('productName', baseCtx), `stories=${storiesCap}`);
  check('J2 reels productName cap < stories productName cap (the actual reported delta)',
    reelsCap < storiesCap, `reels=${reelsCap} stories=${storiesCap}`);
  check('J3 reels productName cap === verticalYt (same narrowed zone)',
    reelsCap === deriveCharCap('productName', { ...baseCtx, platformFormat: 'pmax_video_9_16' }),
    `reels=${reelsCap} verticalYt=${deriveCharCap('productName', { ...baseCtx, platformFormat: 'pmax_video_9_16' })}`);

  // fitProductNameToCap: fits as-is when already under cap (no-op, no ellipsis).
  check('J4 fitProductNameToCap: no-op when already under cap',
    fitProductNameToCap('Trail Shorts', 40) === 'Trail Shorts');

  // Drops the FEWEST leading words needed — a whole real phrase, no ellipsis.
  check('J5 fitProductNameToCap drops exactly one leading modifier when that alone fits',
    fitProductNameToCap('Vintage Oversized Denim Jacket', 26) === 'Oversized Denim Jacket',
    `got ${JSON.stringify(fitProductNameToCap('Vintage Oversized Denim Jacket', 26))}`);
  check('J6 fitProductNameToCap never emits an ellipsis when a whole-word fit exists',
    !fitProductNameToCap('Vintage Oversized Denim Jacket', 26).includes('…'));

  // Drops MORE than one word when needed — still minimal, still no ellipsis.
  check('J7 fitProductNameToCap drops multiple leading words when required',
    fitProductNameToCap('Vintage Oversized Cropped Denim Jacket', 12) === 'Denim Jacket',
    `got ${JSON.stringify(fitProductNameToCap('Vintage Oversized Cropped Denim Jacket', 12))}`);

  // Never drops the trailing noun down to nothing needlessly — the fitted
  // string is always the LONGEST candidate that still fits (fewest words
  // dropped), never over-shortened.
  check('J8 fitProductNameToCap keeps the longest fitting candidate (minimal drop)',
    fitProductNameToCap('Alpha Beta Gamma Delta', 11) === 'Gamma Delta',
    `got ${JSON.stringify(fitProductNameToCap('Alpha Beta Gamma Delta', 11))}`);

  // Even the last single word alone doesn't fit → falls back to the
  // standard tail-safe cap+ellipsis (the true last resort). Cap (4) is
  // smaller than "Jacket" itself (6) so no whole-word candidate can ever fit.
  check('J9 fitProductNameToCap falls back to truncateWordSafe when no whole-word phrase fits',
    fitProductNameToCap('Supercalifragilisticexpialidocious Jacket', 4)
      === truncateWordSafe('Supercalifragilisticexpialidocious Jacket', 4),
    `got ${JSON.stringify(fitProductNameToCap('Supercalifragilisticexpialidocious Jacket', 4))}`);

  // A single-word name has no leading word to drop → same fallback.
  check('J10 fitProductNameToCap on a single word falls back to truncateWordSafe',
    fitProductNameToCap('Supercalifragilisticexpialidocious', 10)
      === truncateWordSafe('Supercalifragilisticexpialidocious', 10));

  // END-TO-END through resolveSlotContent: productName gets the fitter,
  // quote does NOT (PR #250 depends on the quote's opening clause surviving
  // a plain tail cut — this must never change for any slot but productName).
  const pnSlot = { key: 'productName', visible: true, slotType: 'text', bind: ['productName'], position: {}, treatment: {} };
  const squareCtx = { format: 'square', canvasWidth: 1080, maxWidthPct: 0.9, maxLines: 1, fontPx: 36 * 1.2, platformFormat: 'pmax_video_1_1' };
  const squareOut = resolveSlotContent(pnSlot, { productName: 'Vintage Oversized Denim Jacket' }, [pnSlot], squareCtx);
  check('J11 squareYt productName end-to-end: noun-preserving fit, no ellipsis',
    squareOut === 'Oversized Denim Jacket', `got ${JSON.stringify(squareOut)}`);

  const quoteSlot = { key: 'quote', visible: true, slotType: 'text', bind: ['quote'], position: {}, treatment: {} };
  const openingClause = 'The fabric is so soft. I love that it is a bomber-style jacket and cinched at the waist but not tight.';
  const quoteOut = resolveSlotContent(quoteSlot, { quote: openingClause }, [quoteSlot], {
    format: 'vertical', canvasWidth: 1080, maxWidthPct: 0.92, maxLines: 3, fontPx: 56 * 1.15, platformFormat: 'meta_reels_9_16',
  });
  check('J12 quote slot is UNCHANGED by the productName fitter (still opening-clause tail cut)',
    quoteOut === truncateWordSafe(openingClause, deriveCharCap('quote', {
      format: 'vertical', canvasWidth: 1080, maxWidthPct: 0.92, maxLines: 3, fontPx: 56 * 1.15, platformFormat: 'meta_reels_9_16',
    })),
    `got ${JSON.stringify(quoteOut)}`);
  check('J13 quote slot keeps its opening clause (starts with "The fabric is so soft")',
    quoteOut.startsWith('The fabric is so soft'), `got ${JSON.stringify(quoteOut)}`);
}

// ── Derived caps table (all four formats × headline/quote) — report aid ───
{
  const formats = ['vertical', 'feed', 'square', 'landscape'];
  console.log('Derived caps (format-only defaults):');
  for (const fmt of formats) {
    const h = deriveCharCap('headline', { format: fmt });
    const q = deriveCharCap('quote', { format: fmt });
    console.log(`  ${fmt.padEnd(10)} headline=${h}  quote=${q}`);
  }
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyFormatAwareCharCaps: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyFormatAwareCharCaps: ${passed}/${total} checks passed`);
