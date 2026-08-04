// Title style spec + brand token resolution for the Remotion titling engine.
//
//   spec   = WHAT/WHERE/WHEN  (slots, positions, timing, motion, treatments)
//   tokens = LOOK             (brand colors as hex, resolved font files)
//
// Spec resolution per format (render path, TITLE_SPEC_IGNORE_PERSISTED=true
// by default): brand.titleStylePreset → remotion/presets/<name>.json, else
// the shipped canonical preset. Persisted titleStyleSpec docs on
// ad/product/category/brand are IGNORED on render (stale brand specs were
// shadowing the no-scrim cinema standard). Title Studio authoring passes
// honourPersistedOverrides:true to still read them. Named curated presets
// (soludos-*, pelagic-*, babyboo-*) stay live via titleStylePreset.

'use strict';

const path = require('path');
const fs = require('fs');
const {
  validateTitleSpec,
  SLOT_KEYS,
  slotTypeForKey,
  DEFAULT_BIND,
} = require('./titleSpecValidator');
const { resolveBrandFonts } = require('./fontResolverService');

// Auto-hydrate stub entries for every SLOT_KEYS entry not already in the
// spec. The stubs are `visible: false` so they don't render — they exist
// purely to expose the slot key to the Title Studio dropdown and the
// AI-modify prompt (which reads spec.slots). Operators can enable them
// via UI toggle or natural-language request; the LLM can reference them
// by name because they now appear in the CURRENT SPEC it edits against.
// Runtime rendering already skips invisible slots, so this is a no-op
// for actual output.
function hydrateAllSlotKeys(spec) {
  if (!spec || !Array.isArray(spec.slots)) return spec;
  const present = new Set(spec.slots.map((s) => s.key));
  const firstPhase = spec.phases?.[0]?.key || 'p0';
  const stubs = [];
  for (const key of SLOT_KEYS) {
    if (present.has(key)) continue;
    // Sensible defaults per slot type — visible:false, so exact position
    // and timing only matter once the operator enables the slot. Chosen
    // to be inoffensive placeholders that read well when flipped on.
    const type = slotTypeForKey(key);
    stubs.push({
      key,
      visible: false,
      bind: DEFAULT_BIND[key] || [],
      brandMode: 'keep',
      brandModeBind: null,
      phase: firstPhase,
      position: {
        anchor: type === 'image' ? 'center' : 'lowerThird',
        align: type === 'image' ? 'center' : 'left',
        offsetX: 0,
        offsetY: 0,
        maxWidthPct: 0.85,
        row: null,
      },
    });
  }
  if (!stubs.length) return spec;
  // Re-run through the validator so the stubs pick up full default
  // treatments (varies by slot type — multi and image get their own
  // treatment fields via the validator's type-conditional branch).
  const merged = {
    ...spec,
    slots: [...spec.slots, ...stubs],
  };
  const res = validateTitleSpec(merged, { format: 'feed' /* format-neutral for stubs */ });
  // If the stubs fail (shouldn't — the validator seeds all defaults),
  // fall back to the original spec rather than crashing the API.
  return res.ok ? res.normalized : spec;
}

const PRESET_DIR = path.join(__dirname, '..', 'remotion', 'presets');
const CANONICAL_PRESET = 'canonical';

const presetCache = new Map(); // name -> parsed file or null

function loadPresetFile(name) {
  if (presetCache.has(name)) return presetCache.get(name);
  const file = path.join(PRESET_DIR, `${String(name).replace(/[^a-z0-9_-]/gi, '')}.json`);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`🎬 titleSpec: preset '${name}' unreadable (${e.message})`);
    // Misses are NOT cached: a preset deployed later (or fixed on disk)
    // must become loadable without a restart, and the cache stays bounded
    // to real preset names instead of arbitrary PATCH input.
    return null;
  }
  presetCache.set(name, parsed);
  return parsed;
}

/** Clear the preset cache (used by tests / after editing preset files). */
function clearPresetCache() {
  presetCache.clear();
}

/**
 * When true (default), the render path ignores persisted titleStyleSpec
 * override documents (ad/product/category/brand). Named presets
 * (`brand.titleStylePreset` → remotion/presets/<name>.json) and the
 * canonical floor still apply. Owner 2026-08-05: stale brand specs were
 * permanently shadowing the no-scrim cinema standard. Flip to false via
 * env (or pass honourPersistedOverrides:true for Title Studio authoring)
 * to restore the old override cascade without a deploy.
 */
function ignoresPersistedTitleSpecs() {
  return String(process.env.TITLE_SPEC_IGNORE_PERSISTED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Resolve the normalized spec for a scope + format. Cascade, most-specific
 * wins, WHOLE per-format spec (not slot-merged — each override tier is a
 * complete, self-validated per-format spec that the scope-parameterized
 * Title Studio always saves in full; "revert to a broader scope" = clear
 * that tier's override). Tiers, highest→lowest:
 *   presetOverride arg            (explicit, never persisted) [TIER 0]
 *   ad.titleStyleSpec[format]      (per-video override)     [TIER 1]
 *   product.titleStyleSpec[format] (per-product override)   [TIER 1]
 *   category.titleStyleSpec[format] (each leaf→root)        [TIER 1]
 *   brand.titleStyleSpec[format]   (per-brand override)     [TIER 1]
 *   brand.titleStylePreset         (pinned named preset)    [TIER 2]
 *   canonical                      (guaranteed floor)       [TIER 3]
 *
 * TIER 0 (`presetOverride`) is a render-time ARGUMENT only — never written
 * to Brand/Ad/Product. A valid named file in remotion/presets/ wins over
 * every other tier (including brand.titleStylePreset). Invalid/missing
 * names log a warning and fall through to the normal ladder.
 *
 * TIER 1 is SKIPPED when ignoresPersistedTitleSpecs() is true (the default)
 * unless `honourPersistedOverrides: true` is passed — Title Studio
 * authoring/preview uses that so operators can still see/edit stored
 * specs. The live render path does NOT pass it. Stored docs stay on disk;
 * this is a read-path change only.
 *
 * An invalid override validates+warns+falls through, never throws (only a
 * broken canonical throws — a deploy bug). Returns { spec, source } where
 * source ∈ 'override:<name>' | 'ad' | 'product' | 'category:<breadcrumbKey>'
 * | 'brand' | 'preset:<name>' | 'canonical'.
 *
 * Brand parity: with no product/ad/category overrides this is byte-identical
 * to the previous brand→preset→canonical resolver.
 */
function resolveSpec({
  brand = null,
  product = null,
  ad = null,
  format,
  categories = [],
  honourPersistedOverrides = false,
  presetOverride = null,
} = {}) {
  const ignorePersisted = !honourPersistedOverrides && ignoresPersistedTitleSpecs();

  // 0. explicit named-preset override (argument only — never persisted).
  // Wins over brand.titleStylePreset and tier-1 docs when valid.
  if (presetOverride != null && String(presetOverride).trim() !== '') {
    const name = String(presetOverride).trim();
    const preset = loadPresetFile(name);
    const raw = preset?.byFormat?.[format];
    if (raw) {
      const res = validateTitleSpec(raw, { format });
      if (res.ok) {
        return { spec: res.normalized, source: `override:${name}` };
      }
      console.warn(
        `🎬 titleSpec: presetOverride '${name}' invalid for ${format} (${res.errors[0]}) — falling through`
      );
    } else {
      console.warn(
        `🎬 titleSpec: presetOverride '${name}' missing or has no ${format} — falling through`
      );
    }
  }

  // 1. override documents, most-specific first
  const overrideTiers = [
    ['ad',      ad?.titleStyleSpec],
    ['product', product?.titleStyleSpec],
    ...((Array.isArray(categories) ? categories : []).map((c) => [
      `category:${c?.breadcrumbKey || c?._id || 'unknown'}`,
      c?.titleStyleSpec
    ])),
    ['brand',   brand?.titleStyleSpec],
  ];
  // When ignoring, remember the most-specific valid tier that WOULD have
  // won so we can log it after resolving the real source. Silence here is
  // what let stale brand specs hide for weeks.
  let ignoredTier = null;
  for (const [tier, doc] of overrideTiers) {
    if (doc && typeof doc === 'object' && doc[format]) {
      const res = validateTitleSpec(doc[format], { format });
      if (res.ok) {
        if (!ignorePersisted) return { spec: res.normalized, source: tier };
        if (!ignoredTier) ignoredTier = tier;
        // Keep scanning only long enough to find the winner for the log;
        // lower tiers cannot win over this one.
        break;
      }
      console.warn(`🎬 titleSpec: ${tier} override has invalid ${format} spec (${res.errors[0]}) — falling through`);
    }
  }

  // 2. pinned named preset (brand-level) — ALWAYS honoured (curated files)
  const presetName = brand?.titleStylePreset;
  if (presetName) {
    const preset = loadPresetFile(presetName);
    const spec = preset?.byFormat?.[format];
    if (spec) {
      const res = validateTitleSpec(spec, { format });
      if (res.ok) {
        if (ignoredTier) {
          console.log(
            `🎬 titleSpec: ignoring persisted ${ignoredTier} override (brand-specific specs disabled) -> using preset:${presetName}`
          );
        }
        return { spec: res.normalized, source: `preset:${presetName}` };
      }
      console.warn(`🎬 titleSpec: preset '${presetName}' invalid for ${format} (${res.errors[0]}) — falling back to canonical`);
    } else {
      console.warn(`🎬 titleSpec: preset '${presetName}' missing ${format} — falling back to canonical`);
    }
  }

  // 3. canonical (guaranteed floor)
  const canonical = loadPresetFile(CANONICAL_PRESET);
  const spec = canonical?.byFormat?.[format];
  if (!spec) throw new Error(`canonical preset missing for format '${format}' (remotion/presets/canonical.json)`);
  const res = validateTitleSpec(spec, { format });
  if (!res.ok) throw new Error(`canonical preset invalid for '${format}': ${res.errors.join('; ')}`);
  if (ignoredTier) {
    console.log(
      `🎬 titleSpec: ignoring persisted ${ignoredTier} override (brand-specific specs disabled) -> using canonical`
    );
  }
  return { spec: res.normalized, source: 'canonical' };
}

/**
 * Brand-only convenience wrapper.
 * @param {object} brand
 * @param {string} format
 * @param {{ honourPersistedOverrides?: boolean }} [opts]
 *   Pass honourPersistedOverrides:true for Title Studio authoring so a
 *   stored brand.titleStyleSpec is still readable for edit/preview.
 *   Production render uses resolveSpec() without that flag.
 */
function resolveSpecForBrand(brand, format, opts = {}) {
  return resolveSpec({ brand, format, ...opts });
}

function hexOrNull(v) {
  const s = String(v || '').trim();
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m6) return `#${m6[1].toUpperCase()}`;
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m3) return `#${m3[1].split('').map((c) => c + c).join('').toUpperCase()}`;
  return null;
}

function rgbArrToHex(arr) {
  if (!Array.isArray(arr) || arr.length !== 3) return null;
  return `#${arr.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// styleTheme colors may be [r,g,b] arrays (canvas idiom) or hex strings.
function themeColor(theme, key) {
  const v = theme?.[key];
  return hexOrNull(v) || rgbArrToHex(v);
}

/**
 * Build the token object consumed by the compositions.
 * Sources (first hit wins): Brand.styleTheme → Brand color fields (the
 * website-scan output) → LayoutInputArtifact input.brand.* → defaults.
 * `specFontOverrides` = normalizedSpec.tokenOverrides.fonts (resolved here,
 * server-side, because a family change may need a new font file).
 */
async function buildBrandTokens(brand, { layoutInputBrand = null, specFontOverrides = {} } = {}) {
  const theme = brand?.styleTheme || {};
  const primary = themeColor(theme, 'primaryColor') || hexOrNull(brand?.primaryColor) || hexOrNull(layoutInputBrand?.primary_color);
  const secondary = themeColor(theme, 'secondaryColor') || hexOrNull(brand?.secondaryColor) || hexOrNull(layoutInputBrand?.secondary_color);
  const accent = themeColor(theme, 'accentColor') || hexOrNull(brand?.accentColor) || hexOrNull(layoutInputBrand?.accent_color) || primary;

  // A pill's INK MUST BE DERIVED FROM ITS OWN FILL, never assumed.
  //
  // ctaText defaulted to '#FFFFFF' and promoText to '#16161A' — both fixed,
  // whatever the pill was filled with. ctaBg falls back to the brand accent, so a
  // brand with a light accent shipped WHITE TEXT ON A CREAM PILL. Owner, on a
  // delivered Gymshark 4:5: *"if it is supposed to be there for that surface then
  // it should be visible, not white on white."* promoText carries the mirror bug:
  // a dark promo fill got dark ink.
  //
  // An explicit brand value always wins — this only replaces the blind default.
  // Same principle as the composited logomark and the text-shadow polarity: pick
  // the ink from the thing it sits on.
  const readableOn = (bgHex, explicit) => {
    if (explicit) return explicit;
    const s = String(bgHex || '').replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return '#FFFFFF';
    const lum = (0.2126 * parseInt(s.slice(0, 2), 16)
               + 0.7152 * parseInt(s.slice(2, 4), 16)
               + 0.0722 * parseInt(s.slice(4, 6), 16)) / 255;
    return lum > 0.55 ? '#16181D' : '#FFFFFF';
  };

  const ctaBgResolved   = themeColor(theme, 'ctaBgColor') || themeColor(theme, 'ctaBg') || accent || primary || '#46783E';
  const promoBgResolved = themeColor(theme, 'promoBgColor') || themeColor(theme, 'promoBg') || accent || '#F5B70A';
  const badgeBgResolved = themeColor(theme, 'badgeBgColor') || themeColor(theme, 'badgeBg') || themeColor(theme, 'calloutBgColor') || accent || '#BEC282';

  // Curated styleTheme docs use the CANVAS engine's key vocabulary
  // (ctaBgColor, badgeTextColor, promoBgColor, accentGold, …) — read those
  // first so a brand renders identically on both engines; the short forms
  // are accepted as aliases for hand-written specs.
  const colors = {
    primary: primary || '#0B0F14',
    secondary: secondary || '#DCDCDC',
    accent: accent || '#F5B70A',
    ctaBg: ctaBgResolved,
    ctaText: readableOn(ctaBgResolved, themeColor(theme, 'ctaTextColor') || themeColor(theme, 'ctaText')),
    scrim: themeColor(theme, 'scrimColor') || '#0C0906',
    textPrimary: themeColor(theme, 'textPrimary') || '#FFFFFF',
    textSecondary: themeColor(theme, 'textSecondary') || secondary || '#DCDCDC',
    // stars deliberately never fall to brand accent (dark accents = invisible
    // stars) — same rule as the canvas deriveTheme.
    stars: themeColor(theme, 'starColor') || themeColor(theme, 'accentGold') || '#F5B70A',
    badgeBg: badgeBgResolved,
    badgeText: readableOn(badgeBgResolved, themeColor(theme, 'badgeTextColor') || themeColor(theme, 'badgeText')),
    promoBg: promoBgResolved,
    promoText: readableOn(promoBgResolved, themeColor(theme, 'promoTextColor') || themeColor(theme, 'promoText')),
    // Plate-intelligence contrast flips (light footage → dark type).
    textOnLight: themeColor(theme, 'textOnLight') || primary || '#16181D',
    textSecondaryOnLight: themeColor(theme, 'textSecondaryOnLight') || '#3A4048',
  };

  const fonts = await resolveBrandFonts(brand, { overrides: specFontOverrides, layoutInputBrand });
  return { colors, fonts };
}

module.exports = {
  resolveSpec,
  resolveSpecForBrand,
  buildBrandTokens,
  hydrateAllSlotKeys,
  loadPresetFile,
  clearPresetCache,
  ignoresPersistedTitleSpecs,
  PRESET_DIR,
  CANONICAL_PRESET,
};
