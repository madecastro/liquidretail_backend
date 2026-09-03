// Title Style Spec — schema contract + validator (v1).
//
// A title style spec is a declarative, per-format JSON document that the
// Remotion canonical compositions RENDER. The shipped canonical looks are
// presets of this same schema (remotion/presets/*.json); a brand may carry
// per-format overrides in Brand.titleStyleSpec = { vertical, feed, landscape }.
// The LLM "enter modifications" flow edits this document — never code — so
// everything an operator can ask for (fonts, colors, which info shows,
// where it sits, when it appears, how it moves) must be expressible here,
// and everything expressible here must validate before it can be saved.
//
// ── Spec shape ────────────────────────────────────────────────────────────
// {
//   version: 1,
//   phases: [ { key: 'hook', startSec: 0, endSec: 3 }, ... ]      // 1..4
//   stack:  { rowGapPct: 0.018 },                                  // optional
//   tokenOverrides: {                                              // optional
//     colors: { primary: '#0072CE', ... },      // any BRAND_COLOR_KEYS subset
//     fonts:  { heading: { family, weight? }, body: {...}, quote: {...} }
//   },
//   slots: [ {
//     key: 'headline',              // one of SLOT_KEYS (duplicates allowed when
//                                   // phases need the same renderer twice —
//                                   // e.g. proof claim fallback + hook headline)
//     visible: true,
//     bind: ['headline'],           // meta fields tried in order (text slots)
//     brandMode: 'keep'|'hide',     // behavior when meta.endcardMode==='brand'
//     brandModeBind: ['brandTagline'],   // alternate binding in brand mode
//     visibleWhenEmpty: 'quote',    // optional: render ONLY when named sibling
//                                   // slot resolves to no content this render
//     phase: 'hook',                // must reference phases[].key
//     position: {
//       anchor: 'top'|'upperThird'|'center'|'lowerThird'|'bottom',
//       align: 'left'|'center'|'right',
//       offsetX: 0, offsetY: 0,     // fraction of W/H, clamped ±0.25
//       maxWidthPct: 0.85,          // 0.2..1 fraction of safe width
//       row: null                   // slots sharing anchor+row render side by side
//     },
//     timing: {
//       enterAtSec: 0.33,           // absolute seconds into the clip
//       exitAtSec: null,            // null = hold to end of clip
//       enterDurationSec: 0.4,
//       exitDurationSec: 0.4
//     },
//     transition: {
//       type: 'fade'|'slide'|'pop'|'wipe'|'none',
//       direction: 'up'|'down'|'left'|'right',
//       spring: { damping, stiffness, mass } | null   // pop/slide physics
//     },
//     treatment: {
//       scrim: 'frosted'|'solid'|'card'|'none',   // default 'none' (no-scrim standard)
//       scrimOpacity: 0.7,          // 0..1
//       shadow: 'layered'|'soft'|'none',          // default 'layered'
//       casing: 'upper'|'title'|'none',
//       fontRole: 'heading'|'body'|'quote',
//       weight: 700,                // 100..900
//       sizeScale: 1,               // 0.5..2 multiplier on the slot's base size
//       maxLines: 2,                // 1..4
//       trackingPx: 0,              // letter-spacing px at 1080-wide base
//       colorToken: 'textPrimary',  // any TOKEN_COLOR_KEYS entry
//       accent: { type: 'underline'|'bar'|'none', colorToken: 'accent', animate: true }
//     }
//   } ]
// }
//
// Slots stack: slots sharing (phase, anchor) render as a column in array
// order (rowGapPct apart); a shared position.row renders side by side.
// Times are authored against the nominal 8s clip and clamped to the real
// plate duration at render time. Positions are clamped inside per-format
// safe zones by the composition — a spec cannot push text under platform UI.

'use strict';

// SLOT_KEYS — every semantic element the titling engine can render. The
// LLM prompt (see routes/brand.js titleSpecSchemaPrompt) surfaces the
// full list, so extending here is enough for AI-modify to reference the
// new slots. Kinds:
//   text   — single-value string binding (bind chain reads meta.<field>)
//   multi  — array-value binding (bind chain reads meta.<arrayField>); renders
//            each item as its own visual unit, controlled by treatment.itemLayout /
//            itemDelaySec / maxItems / itemStyle
//   image  — URL-value binding (bind chain reads a meta URL served via the
//            asset server); renders as <Img> with treatment.fit / sizePct / radiusPct
//   rating — composite (rating value + reviewCount + star row); no bind chain
const SLOT_KEYS = [
  // Existing text slots
  'headline', 'quote', 'reviewer', 'rating', 'badge', 'brandPill',
  'productName', 'price', 'deliveryLine', 'cta', 'promo',
  // Additional single-value text slots — enable the LLM to reference
  // brand tagline, website, product description, per-slot review count,
  // and engagement (likes) independently of the composite pills.
  'productDescription', 'tagline', 'website', 'likes', 'reviewCount',
  // Multi-value text slots — render an array of items with layout + stagger
  'badges', 'benefits',
  // Image slots — render the product-only image or brand logo standalone
  'productImage', 'brandLogo',
];

// Slot type per key. Drives which treatment fields the validator accepts
// and which resolver runs at render time. Anything not listed defaults
// to 'text'.
const SLOT_TYPE_BY_KEY = {
  rating: 'rating',
  badges: 'multi',
  benefits: 'multi',
  productImage: 'image',
  brandLogo: 'image',
  // brandPill is a composite (logo image + text pill fallback) with its
  // own dedicated renderer; treat it as 'text' for validation purposes —
  // the extra 'logoMode' treatment field is already handled below.
};

function slotTypeForKey(key) {
  return SLOT_TYPE_BY_KEY[key] || 'text';
}

// Meta fields a text-typed slot may bind to (buildMetaForAd output). The
// resolver iterates the bind chain and picks the first non-empty value.
const BINDABLE_META_FIELDS = [
  'headline', 'quote', 'quoteSnippet', 'reviewer', 'badgeText', 'brandName',
  'productName', 'productDescription', 'price', 'deliveryLine', 'ctaText',
  'cta', 'promoText', 'brandTagline', 'brandWebsiteDomain', 'reviewsText',
  // Numeric-formatted meta fields the resolver stringifies for display
  'likes', 'reviewCount',
];

// Array-valued meta fields a multi-typed slot may bind to.
const BINDABLE_MULTI_META_FIELDS = ['badges', 'benefits'];

// URL-valued meta fields (asset-server URLs, not disk paths) an image-typed
// slot may bind to. `brandLogoUrl` is downloaded + served during setup;
// `productImageUrl` mirrors that flow (see remotionRenderService).
const BINDABLE_IMAGE_META_FIELDS = ['productImageUrl', 'brandLogoUrl'];

const TOKEN_COLOR_KEYS = [
  'primary', 'secondary', 'accent', 'ctaBg', 'ctaText', 'scrim',
  'textPrimary', 'textSecondary', 'stars', 'badgeBg', 'badgeText',
  'promoBg', 'promoText', 'textOnLight', 'textSecondaryOnLight',
];

const FONT_ROLES = ['heading', 'body', 'quote'];
const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
const ALIGNS = ['left', 'center', 'right'];
const TRANSITIONS = ['fade', 'slide', 'pop', 'wipe', 'none'];
const DIRECTIONS = ['up', 'down', 'left', 'right'];
const SCRIMS = ['frosted', 'solid', 'card', 'none'];
const SHADOWS = ['layered', 'soft', 'none'];
const CASINGS = ['upper', 'title', 'none'];
const BRAND_MODES = ['keep', 'hide'];
// 'square' (1:1, 1080x1080) added 2026-07-29 alongside the CanonicalSquare
// composition. Order matches remotion/Root.jsx and canonical.json's byFormat.
// Adding a format here is not sufficient on its own — a format with no
// `byFormat.<format>` entry in remotion/presets/canonical.json makes
// titleSpecService.resolveSpec THROW at its guaranteed-floor step, so the preset
// and this list must move together.
const FORMATS = ['vertical', 'feed', 'square', 'landscape'];

// Multi-value + image treatment vocabularies.
const ITEM_LAYOUTS = ['stack', 'row', 'grid'];
const ITEM_STYLES  = ['pill', 'bullet', 'plain', 'chip'];
const IMAGE_FITS   = ['contain', 'cover'];

const MAX_PHASES = 4;
const MAX_CLIP_SEC = 15;   // specs are authored for ≤15s clips (nominal 8s)
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Default binding chain per slot (mirrors the canvas canonicals). Each
// entry's shape must match the slot's type (text arrays for 'text', array
// meta fields for 'multi', URL fields for 'image'). Rating is composite —
// no bind chain, resolver reads rating/reviewCount directly.
const DEFAULT_BIND = {
  // Existing text slots
  headline: ['headline'],
  quote: ['quoteSnippet', 'quote'],
  reviewer: ['reviewer'],
  rating: [],
  badge: ['badgeText'],
  brandPill: ['brandName'],
  productName: ['productName'],
  price: ['price'],
  deliveryLine: ['deliveryLine'],
  cta: ['ctaText', 'cta'],
  promo: ['promoText'],
  // Added text slots
  productDescription: ['productDescription'],
  tagline: ['brandTagline'],
  website: ['brandWebsiteDomain'],
  likes: ['likes'],
  reviewCount: ['reviewCount', 'reviewsText'],
  // Multi-value slots — bind to array meta fields
  badges: ['badges'],
  benefits: ['benefits'],
  // Image slots — bind to asset-server URL meta fields
  productImage: ['productImageUrl'],
  brandLogo: ['brandLogoUrl'],
};

// Brand-mode defaults: what happens when meta.endcardMode === 'brand'
// (mirrors feed/landscape canonical reskins).
const DEFAULT_BRAND_MODE = {
  badge: 'hide',
  rating: 'hide',
  price: 'hide',
  promo: 'hide',
  // Multi + image slots hide by default in brand mode — brand
  // campaigns typically want a cleaner identity endcard.
  badges: 'hide',
  benefits: 'hide',
  reviewCount: 'hide',
  likes: 'hide',
  productDescription: 'hide',
  productImage: 'hide',
};
const DEFAULT_BRAND_MODE_BIND = {
  productName: ['brandTagline', 'headline'],
  deliveryLine: ['brandWebsiteDomain'],
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v, lo, hi) {
  return num(v) && v >= lo && v <= hi;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Validate (and normalize) a single-format title style spec.
 * Returns { ok, errors: string[], normalized: spec|null }.
 * `normalized` has every optional field filled with its default so the
 * compositions never branch on undefined.
 */
function validateTitleSpec(spec, { format = 'feed' } = {}) {
  const errors = [];
  const err = (msg) => { errors.push(msg); };

  if (!FORMATS.includes(format)) return { ok: false, errors: [`unknown format '${format}'`], normalized: null };
  if (!isPlainObject(spec)) return { ok: false, errors: ['spec must be an object'], normalized: null };
  if (spec.version !== 1) err(`version must be 1 (got ${JSON.stringify(spec.version)})`);

  // phases
  const phases = [];
  if (!Array.isArray(spec.phases) || spec.phases.length < 1) {
    err('phases must be a non-empty array');
  } else if (spec.phases.length > MAX_PHASES) {
    err(`at most ${MAX_PHASES} phases (got ${spec.phases.length})`);
  } else {
    const seen = new Set();
    for (const [i, p] of spec.phases.entries()) {
      if (!isPlainObject(p) || typeof p.key !== 'string' || !p.key.trim()) { err(`phases[${i}] needs a string key`); continue; }
      if (seen.has(p.key)) { err(`duplicate phase key '${p.key}'`); continue; }
      seen.add(p.key);
      if (!inRange(p.startSec, 0, MAX_CLIP_SEC)) { err(`phases[${i}].startSec out of range 0..${MAX_CLIP_SEC}`); continue; }
      if (!inRange(p.endSec, 0, MAX_CLIP_SEC) || p.endSec <= p.startSec) { err(`phases[${i}].endSec must be > startSec and ≤ ${MAX_CLIP_SEC}`); continue; }
      phases.push({ key: p.key, startSec: p.startSec, endSec: p.endSec });
    }
  }
  const phaseKeys = new Set(phases.map((p) => p.key));

  // tokenOverrides
  const tokenOverrides = { colors: {}, fonts: {} };
  if (spec.tokenOverrides != null) {
    if (!isPlainObject(spec.tokenOverrides)) err('tokenOverrides must be an object');
    else {
      const { colors, fonts } = spec.tokenOverrides;
      if (colors != null) {
        if (!isPlainObject(colors)) err('tokenOverrides.colors must be an object');
        else for (const [k, v] of Object.entries(colors)) {
          if (!TOKEN_COLOR_KEYS.includes(k)) { err(`tokenOverrides.colors: unknown key '${k}' — valid: ${TOKEN_COLOR_KEYS.join(', ')}`); continue; }
          if (typeof v !== 'string' || !HEX_RE.test(v)) { err(`tokenOverrides.colors.${k} must be #RRGGBB (got ${JSON.stringify(v)})`); continue; }
          tokenOverrides.colors[k] = v.toUpperCase();
        }
      }
      if (fonts != null) {
        if (!isPlainObject(fonts)) err('tokenOverrides.fonts must be an object');
        else for (const [role, f] of Object.entries(fonts)) {
          if (!FONT_ROLES.includes(role)) { err(`tokenOverrides.fonts: unknown role '${role}' — valid: ${FONT_ROLES.join(', ')}`); continue; }
          if (!isPlainObject(f) || typeof f.family !== 'string' || !f.family.trim() || f.family.length > 80) { err(`tokenOverrides.fonts.${role} needs a family string (≤80 chars)`); continue; }
          const entry = { family: f.family.trim() };
          if (f.weight != null) {
            if (!inRange(f.weight, 100, 900)) { err(`tokenOverrides.fonts.${role}.weight must be 100..900`); continue; }
            entry.weight = Math.round(f.weight);
          }
          tokenOverrides.fonts[role] = entry;
        }
      }
    }
  }

  // stack
  let rowGapPct = 0.018;
  if (spec.stack != null) {
    if (!isPlainObject(spec.stack)) err('stack must be an object');
    else if (spec.stack.rowGapPct != null) {
      if (!inRange(spec.stack.rowGapPct, 0, 0.08)) err('stack.rowGapPct must be 0..0.08');
      else rowGapPct = spec.stack.rowGapPct;
    }
  }

  // slots
  // Ceiling allows one extra per key for phase-local repeats (e.g. hook
  // headline + proof claim fallback both key:'headline'). Hard cap keeps
  // LLM-authored specs from exploding.
  const MAX_SLOTS = SLOT_KEYS.length + 4;
  const slots = [];
  if (!Array.isArray(spec.slots) || spec.slots.length < 1) {
    err('slots must be a non-empty array');
  } else if (spec.slots.length > MAX_SLOTS) {
    err(`at most ${MAX_SLOTS} slots (got ${spec.slots.length})`);
  } else {
    // Duplicate keys are legal (same renderer in two phases). React keys in
    // Canonical.jsx include phase+index so the tree stays stable.
    for (const [i, s] of spec.slots.entries()) {
      const where = `slots[${i}]`;
      if (!isPlainObject(s)) { err(`${where} must be an object`); continue; }
      if (!SLOT_KEYS.includes(s.key)) { err(`${where}.key '${s.key}' unknown — valid: ${SLOT_KEYS.join(', ')}`); continue; }

      const out = { key: s.key, visible: s.visible !== false };
      const slotType = slotTypeForKey(s.key);
      out.slotType = slotType;

      // bind — chain shape depends on slot type. Each entry may be
      // either a meta-field NAME (string from the type-appropriate
      // whitelist) OR a LITERAL fallback ({ literal: <value> } object)
      // that renders directly when reached. Literals act as a floor
      // value — always non-empty by construction. Rating is composite
      // so an empty chain is legal; every other type needs at least
      // one entry. Multi slots additionally require at least one of
      // BINDABLE_MULTI_META_FIELDS, with any literal AFTER that field
      // (a leading/only literal would freeze SKU strings into the spec).
      const bind = s.bind == null ? DEFAULT_BIND[s.key] : s.bind;
      const validFields = slotType === 'multi'  ? BINDABLE_MULTI_META_FIELDS
                        : slotType === 'image'  ? BINDABLE_IMAGE_META_FIELDS
                        : slotType === 'rating' ? []
                        : BINDABLE_META_FIELDS;
      if (!Array.isArray(bind)) {
        err(`${where}.bind must be an array`); continue;
      }
      // Validate + normalize each entry. Strings pass through as-is;
      // literal entries are shape-checked against the slot's type
      // (string for text, array for multi, string URL for image).
      const cleanBind = [];
      let bindError = null;
      for (let bi = 0; bi < bind.length; bi++) {
        const b = bind[bi];
        if (typeof b === 'string') {
          if (slotType !== 'rating' && !validFields.includes(b)) {
            bindError = `${where}.bind[${bi}] '${b}' unknown for slot type '${slotType}' (valid: ${validFields.join(', ')})`;
            break;
          }
          cleanBind.push(b);
        } else if (isPlainObject(b) && Object.prototype.hasOwnProperty.call(b, 'literal')) {
          const v = b.literal;
          // Shape check per slot type. Undefined → skip validation
          // (defer to render time — same tolerance the existing
          // multi/image treatment fields use).
          if (v == null) {
            bindError = `${where}.bind[${bi}]: literal cannot be null (omit the entry to have no fallback)`;
            break;
          }
          if (slotType === 'multi' && !Array.isArray(v)) {
            bindError = `${where}.bind[${bi}]: multi-slot literal must be an array`; break;
          }
          if (slotType !== 'multi' && Array.isArray(v)) {
            bindError = `${where}.bind[${bi}]: literal for a ${slotType} slot must be a scalar, not an array`; break;
          }
          if (slotType === 'image' && typeof v !== 'string') {
            bindError = `${where}.bind[${bi}]: image-slot literal must be a URL string`; break;
          }
          cleanBind.push({ literal: v });
        } else {
          bindError = `${where}.bind[${bi}]: expected a meta-field name string or { literal: <value> } object`;
          break;
        }
      }
      // LIVE-FIELD-BEFORE-LITERAL. A leading (or only) {literal} freezes one
      // SKU's strings into a spec, and two changes made that reachable rather
      // than latent: TITLE_SPEC_IGNORE_PERSISTED is gone, so a persisted
      // tier-1 spec now ALWAYS wins at render; and runModifyTitleSpec hands
      // the authoring LLM real per-SKU benefit/spec sample strings, restrained
      // otherwise only by prose. One Title Studio save would then print one
      // product's copy on every render for that brand+format — invisibly,
      // because the preview looks right for the SKU under review.
      //
      // SCOPE: MULTI ONLY. It deliberately does NOT apply to text slots.
      // A literal-only TEXT bind is a supported operator feature, not a bug —
      // adgen's scripts/verifyBrandTaglineNoInversion.js group F asserts
      // `bind: [{literal:'Shop the whole collection today'}]` on a productName
      // slot MUST validate, and tests that such an operator-authored literal
      // is not run through the noun-preserving fitter. Banning it here broke
      // that harness. (An adversarial review recommended the blanket ban; the
      // suite caught that it destroys a documented capability. The real risk —
      // the authoring LLM copying per-SKU SAMPLE strings into a literal — is
      // guarded where the sample is actually in scope, in
      // routes/brand.js runModifyTitleSpec, not here where it is invisible.)
      // Multi slots have no equivalent legitimate literal-only case: their
      // whole purpose is to iterate a live array.
      // Also NOT applied to: rating (composite, empty chain legal) and image
      // (a hardcoded asset URL is legitimate authoring).
      if (!bindError && slotType === 'multi') {
        const firstMetaIdx = cleanBind.findIndex(
          (b) => typeof b === 'string' && validFields.includes(b)
        );
        if (firstMetaIdx < 0) {
          bindError = `${where}.bind for a ${slotType} slot must include at least one of ${validFields.join('|')} (a literal-only bind would freeze SKU strings into the spec)`;
        } else if (cleanBind.slice(0, firstMetaIdx).some((b) => isPlainObject(b) && Object.prototype.hasOwnProperty.call(b, 'literal'))) {
          bindError = `${where}.bind: a ${slotType}-slot {literal} must come AFTER a live meta field (a leading literal always wins and freezes SKU strings)`;
        }
      }
      if (bindError) { err(bindError); continue; }
      out.bind = cleanBind;

      // brand mode — mirrors the same mixed-entry acceptance as bind.
      const brandMode = s.brandMode == null ? (DEFAULT_BRAND_MODE[s.key] || 'keep') : s.brandMode;
      if (!BRAND_MODES.includes(brandMode)) { err(`${where}.brandMode must be one of ${BRAND_MODES.join('|')}`); continue; }
      out.brandMode = brandMode;
      const bmBindRaw = s.brandModeBind == null ? (DEFAULT_BRAND_MODE_BIND[s.key] || null) : s.brandModeBind;
      let bmBind = null;
      if (bmBindRaw != null) {
        if (!Array.isArray(bmBindRaw)) {
          err(`${where}.brandModeBind must be an array`); continue;
        }
        const cleanBmBind = [];
        let bmErr = null;
        for (let bi = 0; bi < bmBindRaw.length; bi++) {
          const b = bmBindRaw[bi];
          if (typeof b === 'string') {
            if (!BINDABLE_META_FIELDS.includes(b)) {
              bmErr = `${where}.brandModeBind[${bi}] '${b}' unknown`; break;
            }
            cleanBmBind.push(b);
          } else if (isPlainObject(b) && Object.prototype.hasOwnProperty.call(b, 'literal')) {
            if (b.literal == null) { bmErr = `${where}.brandModeBind[${bi}]: literal cannot be null`; break; }
            cleanBmBind.push({ literal: b.literal });
          } else {
            bmErr = `${where}.brandModeBind[${bi}]: expected string or { literal: <value> }`; break;
          }
        }
        // NOTE: no live-field-before-literal rule here, for the same reason as
        // `bind` above — brandModeBind is text-typed and an operator-authored
        // literal is a legitimate brand-mode line. The sample-collision guard
        // in routes/brand.js runModifyTitleSpec covers BOTH chains, because
        // that is the only place the brand's sample strings are in scope.
        if (bmErr) { err(bmErr); continue; }
        bmBind = cleanBmBind;
      }
      out.brandModeBind = bmBind;

      // visibleWhenEmpty — optional sibling gate. Slot renders ONLY when the
      // named sibling resolves to no content (e.g. claim restated when quote
      // is withheld). Ref must be a slot key present in this format; checked
      // in a post-pass once every slot key is known.
      if (s.visibleWhenEmpty != null) {
        if (typeof s.visibleWhenEmpty !== 'string' || !s.visibleWhenEmpty.trim()) {
          err(`${where}.visibleWhenEmpty must be a non-empty string slot key`); continue;
        }
        if (s.visibleWhenEmpty.trim() === s.key) {
          err(`${where}.visibleWhenEmpty cannot reference the slot's own key`); continue;
        }
        out.visibleWhenEmpty = s.visibleWhenEmpty.trim();
      }

      // phase
      if (typeof s.phase !== 'string' || !phaseKeys.has(s.phase)) {
        err(`${where}.phase '${s.phase}' does not reference a declared phase (${[...phaseKeys].join(', ')})`); continue;
      }
      out.phase = s.phase;
      const phase = phases.find((p) => p.key === s.phase);

      // position
      const pos = isPlainObject(s.position) ? s.position : {};
      const anchor = pos.anchor ?? 'lowerThird';
      const align = pos.align ?? 'left';
      if (!ANCHORS.includes(anchor)) { err(`${where}.position.anchor must be one of ${ANCHORS.join('|')}`); continue; }
      if (!ALIGNS.includes(align)) { err(`${where}.position.align must be one of ${ALIGNS.join('|')}`); continue; }
      const offsetX = pos.offsetX ?? 0;
      const offsetY = pos.offsetY ?? 0;
      if (!inRange(offsetX, -0.25, 0.25)) { err(`${where}.position.offsetX must be −0.25..0.25 (fraction of width)`); continue; }
      if (!inRange(offsetY, -0.25, 0.25)) { err(`${where}.position.offsetY must be −0.25..0.25 (fraction of height)`); continue; }
      const maxWidthPct = pos.maxWidthPct ?? 0.85;
      if (!inRange(maxWidthPct, 0.2, 1)) { err(`${where}.position.maxWidthPct must be 0.2..1`); continue; }
      const row = pos.row == null ? null : String(pos.row);
      out.position = { anchor, align, offsetX, offsetY, maxWidthPct, row };

      // timing (defaults derive from the slot's phase)
      const t = isPlainObject(s.timing) ? s.timing : {};
      const enterAtSec = t.enterAtSec ?? phase.startSec;
      const exitAtSec = t.exitAtSec === undefined ? null : t.exitAtSec;
      const enterDurationSec = t.enterDurationSec ?? 0.4;
      const exitDurationSec = t.exitDurationSec ?? 0.4;
      if (!inRange(enterAtSec, 0, MAX_CLIP_SEC)) { err(`${where}.timing.enterAtSec must be 0..${MAX_CLIP_SEC}`); continue; }
      if (exitAtSec !== null && (!inRange(exitAtSec, 0, MAX_CLIP_SEC) || exitAtSec <= enterAtSec)) {
        err(`${where}.timing.exitAtSec must be null (hold) or > enterAtSec`); continue;
      }
      if (!inRange(enterDurationSec, 0, 2)) { err(`${where}.timing.enterDurationSec must be 0..2`); continue; }
      if (!inRange(exitDurationSec, 0, 2)) { err(`${where}.timing.exitDurationSec must be 0..2`); continue; }
      out.timing = { enterAtSec, exitAtSec, enterDurationSec, exitDurationSec };

      // transition
      const tr = isPlainObject(s.transition) ? s.transition : {};
      const trType = tr.type ?? 'fade';
      const direction = tr.direction ?? 'up';
      if (!TRANSITIONS.includes(trType)) { err(`${where}.transition.type must be one of ${TRANSITIONS.join('|')}`); continue; }
      if (!DIRECTIONS.includes(direction)) { err(`${where}.transition.direction must be one of ${DIRECTIONS.join('|')}`); continue; }
      let spring = null;
      if (tr.spring != null) {
        if (!isPlainObject(tr.spring)) { err(`${where}.transition.spring must be an object`); continue; }
        const damping = tr.spring.damping ?? 200;
        const stiffness = tr.spring.stiffness ?? 100;
        const mass = tr.spring.mass ?? 1;
        if (!inRange(damping, 1, 1000) || !inRange(stiffness, 1, 1000) || !inRange(mass, 0.1, 10)) {
          err(`${where}.transition.spring values out of range (damping 1..1000, stiffness 1..1000, mass 0.1..10)`); continue;
        }
        spring = { damping, stiffness, mass };
      }
      out.transition = { type: trType, direction, spring };

      // treatment
      const tm = isPlainObject(s.treatment) ? s.treatment : {};
      const scrim = tm.scrim ?? 'none';
      const shadow = tm.shadow ?? 'layered';
      const casing = tm.casing ?? 'none';
      const fontRole = tm.fontRole ?? 'body';
      if (!SCRIMS.includes(scrim)) { err(`${where}.treatment.scrim must be one of ${SCRIMS.join('|')}`); continue; }
      if (!SHADOWS.includes(shadow)) { err(`${where}.treatment.shadow must be one of ${SHADOWS.join('|')}`); continue; }
      if (!CASINGS.includes(casing)) { err(`${where}.treatment.casing must be one of ${CASINGS.join('|')}`); continue; }
      if (!FONT_ROLES.includes(fontRole)) { err(`${where}.treatment.fontRole must be one of ${FONT_ROLES.join('|')}`); continue; }
      const scrimOpacity = tm.scrimOpacity ?? 0.7;
      const scrimColorToken = tm.scrimColorToken ?? 'scrim';
      if (!TOKEN_COLOR_KEYS.includes(scrimColorToken)) { err(`${where}.treatment.scrimColorToken '${scrimColorToken}' unknown`); continue; }
      const weight = tm.weight ?? 600;
      const sizeScale = tm.sizeScale ?? 1;
      const maxLines = tm.maxLines ?? 2;
      const trackingPx = tm.trackingPx ?? 0;
      const colorToken = tm.colorToken ?? 'textPrimary';
      if (!inRange(scrimOpacity, 0, 1)) { err(`${where}.treatment.scrimOpacity must be 0..1`); continue; }
      if (!inRange(weight, 100, 900)) { err(`${where}.treatment.weight must be 100..900`); continue; }
      if (!inRange(sizeScale, 0.5, 2)) { err(`${where}.treatment.sizeScale must be 0.5..2`); continue; }
      if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 4) { err(`${where}.treatment.maxLines must be an integer 1..4`); continue; }
      if (!inRange(trackingPx, 0, 8)) { err(`${where}.treatment.trackingPx must be 0..8`); continue; }
      if (!TOKEN_COLOR_KEYS.includes(colorToken)) { err(`${where}.treatment.colorToken '${colorToken}' unknown — valid: ${TOKEN_COLOR_KEYS.join(', ')}`); continue; }
      // brandPill only: 'auto' renders the brand's actual logo when the ad
      // meta carries one (text pill is the no-logo fallback); 'text' forces
      // the text pill.
      const logoMode = tm.logoMode ?? 'auto';
      if (!['auto', 'text'].includes(logoMode)) { err(`${where}.treatment.logoMode must be 'auto' or 'text'`); continue; }
      let accent = { type: 'none', colorToken: 'accent', animate: true };
      if (tm.accent != null) {
        if (!isPlainObject(tm.accent)) { err(`${where}.treatment.accent must be an object`); continue; }
        const aType = tm.accent.type ?? 'none';
        const aColor = tm.accent.colorToken ?? 'accent';
        if (!['underline', 'bar', 'none'].includes(aType)) { err(`${where}.treatment.accent.type must be underline|bar|none`); continue; }
        if (!TOKEN_COLOR_KEYS.includes(aColor)) { err(`${where}.treatment.accent.colorToken unknown`); continue; }
        accent = { type: aType, colorToken: aColor, animate: tm.accent.animate !== false };
      }
      out.treatment = {
        scrim, scrimOpacity, scrimColorToken, shadow, casing, fontRole,
        weight: Math.round(weight), sizeScale, maxLines, trackingPx, colorToken, accent, logoMode,
      };

      // Multi-value slot treatment fields — validated + defaulted only when
      // the slot is a multi type. Keep them off other slot types so specs
      // don't accumulate irrelevant knobs the renderer ignores.
      if (slotType === 'multi') {
        const itemLayout = tm.itemLayout ?? (s.key === 'benefits' ? 'stack' : 'row');
        const itemStyle  = tm.itemStyle  ?? (s.key === 'benefits' ? 'bullet' : 'pill');
        const itemDelaySec = tm.itemDelaySec ?? 0.12;
        const itemGap      = tm.itemGap ?? 0.012;
        const maxItems     = tm.maxItems ?? 4;
        if (!ITEM_LAYOUTS.includes(itemLayout)) { err(`${where}.treatment.itemLayout must be one of ${ITEM_LAYOUTS.join('|')}`); continue; }
        if (!ITEM_STYLES.includes(itemStyle))   { err(`${where}.treatment.itemStyle must be one of ${ITEM_STYLES.join('|')}`); continue; }
        if (!inRange(itemDelaySec, 0, 2))       { err(`${where}.treatment.itemDelaySec must be 0..2`); continue; }
        if (!inRange(itemGap, 0, 0.05))         { err(`${where}.treatment.itemGap must be 0..0.05 (fraction of canvas short edge)`); continue; }
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 8) { err(`${where}.treatment.maxItems must be an integer 1..8`); continue; }
        out.treatment.itemLayout   = itemLayout;
        out.treatment.itemStyle    = itemStyle;
        out.treatment.itemDelaySec = itemDelaySec;
        out.treatment.itemGap      = itemGap;
        out.treatment.maxItems     = maxItems;
      }

      // Image slot treatment fields — same conditional pattern.
      if (slotType === 'image') {
        const fit          = tm.fit ?? 'contain';
        const sizePct      = tm.sizePct ?? 0.35;
        const radiusPct    = tm.radiusPct ?? 0;
        const borderWidthPct = tm.borderWidthPct ?? 0;
        const borderColorToken = tm.borderColorToken ?? 'accent';
        if (!IMAGE_FITS.includes(fit))         { err(`${where}.treatment.fit must be one of ${IMAGE_FITS.join('|')}`); continue; }
        if (!inRange(sizePct, 0.05, 0.9))      { err(`${where}.treatment.sizePct must be 0.05..0.9 (fraction of canvas short edge)`); continue; }
        if (!inRange(radiusPct, 0, 0.5))       { err(`${where}.treatment.radiusPct must be 0..0.5`); continue; }
        if (!inRange(borderWidthPct, 0, 0.02)) { err(`${where}.treatment.borderWidthPct must be 0..0.02`); continue; }
        if (!TOKEN_COLOR_KEYS.includes(borderColorToken)) { err(`${where}.treatment.borderColorToken unknown`); continue; }
        out.treatment.fit              = fit;
        out.treatment.sizePct          = sizePct;
        out.treatment.radiusPct        = radiusPct;
        out.treatment.borderWidthPct   = borderWidthPct;
        out.treatment.borderColorToken = borderColorToken;
      }

      slots.push(out);
    }
  }

  // Post-pass: visibleWhenEmpty must name a slot key present in this format.
  if (!errors.length && slots.length) {
    const keysPresent = new Set(slots.map((s) => s.key));
    for (const [i, s] of slots.entries()) {
      if (!s.visibleWhenEmpty) continue;
      if (!keysPresent.has(s.visibleWhenEmpty)) {
        err(`slots[${i}] ('${s.key}').visibleWhenEmpty '${s.visibleWhenEmpty}' does not reference a slot key in this format (have: ${[...keysPresent].join(', ')})`);
      }
    }
  }

  if (errors.length) return { ok: false, errors, normalized: null };
  return {
    ok: true,
    errors: [],
    normalized: { version: 1, phases, stack: { rowGapPct }, tokenOverrides, slots },
  };
}

/**
 * Validate a Brand.titleStyleSpec value: an object with per-format keys.
 * Unknown format keys are rejected. Returns { ok, errors, normalized }.
 */
function validateTitleStyleSpecDoc(doc) {
  if (!isPlainObject(doc)) return { ok: false, errors: ['titleStyleSpec must be an object with vertical/feed/landscape keys'], normalized: null };
  const errors = [];
  const normalized = {};
  for (const [fmt, spec] of Object.entries(doc)) {
    if (!FORMATS.includes(fmt)) { errors.push(`unknown format key '${fmt}' — valid: ${FORMATS.join(', ')}`); continue; }
    const res = validateTitleSpec(spec, { format: fmt });
    if (!res.ok) errors.push(...res.errors.map((e) => `${fmt}: ${e}`));
    else normalized[fmt] = res.normalized;
  }
  if (errors.length) return { ok: false, errors, normalized: null };
  return { ok: true, errors: [], normalized };
}

module.exports = {
  validateTitleSpec,
  validateTitleStyleSpecDoc,
  slotTypeForKey,
  SLOT_KEYS,
  SLOT_TYPE_BY_KEY,
  BINDABLE_META_FIELDS,
  BINDABLE_MULTI_META_FIELDS,
  BINDABLE_IMAGE_META_FIELDS,
  TOKEN_COLOR_KEYS,
  FONT_ROLES,
  ANCHORS,
  ALIGNS,
  TRANSITIONS,
  SCRIMS,
  SHADOWS,
  CASINGS,
  ITEM_LAYOUTS,
  ITEM_STYLES,
  IMAGE_FITS,
  FORMATS,
  DEFAULT_BIND,
  clamp,
};
