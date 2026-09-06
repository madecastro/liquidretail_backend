// Brand-scoped LIVE CONTENT SAMPLE for the title-spec director
// (POST /api/brand/:id/title-spec/modify).
//
// One definition, imported from runModifyTitleSpec — never reimplemented
// per caller. Benefits resolve through the SAME cascade titling already
// uses (DEFAULT_META_CASCADES.benefits → resolveField): CatalogProduct.
// shortBenefits first, LayoutInputArtifact as historical fallback. Specs
// go through the already-exported normalizeProductSpecs.
//
// Empty is still cheap/silent/not-an-error (ingest/backfill has not
// written the catalog field yet). Never call buildLayoutInput / any
// derivation writer from this file.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');
const { resolveField, DEFAULT_META_CASCADES } = require('./metaCascadeResolver');

const BENEFIT_ITEM_CAP = 5;     // C2: keeps every real prod row (max observed 5)
const BENEFIT_CHAR_CAP = 56;    // C1: longest live short_benefits string is 42
const BENEFIT_ITEM_FLOOR = 3;   // C2: never truncate a list that has ≥3 items to fewer than 3
const SAMPLE_BENEFITS_EXAMPLES = 3;
const SAMPLE_SPECS_EXAMPLES = 3;
const SAMPLE_CHAR_CAP = 2100; // heading + examples + BENEFITS FORMATTING; never clip warnings
const PRODUCT_QUERY_LIMIT = 20;
const ARTIFACT_QUERY_LIMIT = 12;

function normalizeBenefitList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= BENEFIT_ITEM_CAP) break;
    if (typeof item !== 'string') continue;
    const trimmed = item.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    out.push(trimmed.length <= BENEFIT_CHAR_CAP
      ? trimmed
      : trimmed.slice(0, BENEFIT_CHAR_CAP).trimEnd());
  }
  return out;
}

function benefitsFromDocs({ catalogProduct = null, layoutInput = null } = {}) {
  // Same cascade brandScriptExecutor.buildMetaForAd uses for meta.benefits.
  // One definition (DEFAULT_META_CASCADES.benefits), imported, never copied.
  const { value } = resolveField(DEFAULT_META_CASCADES.benefits, { catalogProduct, layoutInput });
  return normalizeBenefitList(value);
}

function benefitsFromArtifact(artifact) {
  return benefitsFromDocs({ layoutInput: artifact });
}

function specsFromProduct(product) {
  // Lazy require: this module is also required by aiCreativeDirectorService
  // (normalizeBenefitList). A top-level require would cycle.
  const { normalizeProductSpecs } = require('./aiCreativeDirectorService');
  return normalizeProductSpecs(product && product.specs);
}

function emptyStats(nProducts) {
  return {
    n_products_sampled: nProducts || 0,
    item_count: { min: null, median: null, max: null },
    max_item_chars: null,
  };
}

function emptySample() {
  return { benefitsExamples: [], specExamples: [], stats: emptyStats(0) };
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeStats(nProducts, lists) {
  if (!lists.length) return emptyStats(nProducts);
  const counts = lists.map((l) => l.length);
  let maxItemChars = 0;
  for (const list of lists) {
    for (const s of list) {
      if (s.length > maxItemChars) maxItemChars = s.length;
    }
  }
  return {
    n_products_sampled: nProducts,
    item_count: {
      min: Math.min(...counts),
      median: median(counts),
      max: Math.max(...counts),
    },
    max_item_chars: maxItemChars,
  };
}

// MONEY: CatalogProduct.findById of an already-persisted field, then a
// plain findOne of an already-existing artifact as fallback. Never
// buildLayoutInput, never fetchAndCache, never LLM/Gemini, never write.
async function loadProductBenefits(productId) {
  if (!productId) return [];
  try {
    const product = await CatalogProduct.findById(productId)
      .select('shortBenefits')
      .lean();
    const fromCatalog = benefitsFromDocs({ catalogProduct: product });
    if (fromCatalog.length) return fromCatalog;
    const artifact = await LayoutInputArtifact.findOne({ productId })
      .sort({ createdAt: -1 })
      .select('input.product.short_benefits input.product.benefits')
      .lean();
    if (!artifact) return [];
    return benefitsFromDocs({ catalogProduct: product, layoutInput: artifact });
  } catch (_) {
    return [];
  }
}

async function loadTitleSpecContentSample(brandId) {
  if (!brandId) return emptySample();
  try {
    // Filter on INDEXED fields only: brandId (indexed) + deletedAt (in the
    // compound {brandId, deletedAt, lastSyncedAt} index). Sort prefers
    // recently-enriched Immersive rows (the ones most likely to have specs).
    const products = await CatalogProduct.find({ brandId, deletedAt: null })
      .sort({ detailsRefreshedAt: -1, _id: -1 })
      .limit(PRODUCT_QUERY_LIMIT)
      .select('_id specs shortBenefits')
      .lean();
    const productIds = (products || []).map((p) => p._id).filter(Boolean);

    let artifacts = [];
    if (productIds.length) {
      // productId is indexed (LayoutInputArtifact.js:36). createdAt is NOT
      // indexed — keep the limit tight (12) so the in-memory sort stays
      // bounded. Artifact is a FALLBACK for products whose catalog field
      // is empty; catalog shortBenefits is the primary source.
      artifacts = await LayoutInputArtifact.find({ productId: { $in: productIds } })
        .sort({ createdAt: -1 })
        .limit(ARTIFACT_QUERY_LIMIT)
        .select('input.product.short_benefits input.product.benefits productId createdAt')
        .lean();
    }

    const artifactByProduct = new Map();
    for (const art of artifacts || []) {
      const pid = String(art.productId || '');
      if (pid && !artifactByProduct.has(pid)) artifactByProduct.set(pid, art);
    }

    const allLists = [];
    const benefitsExamples = [];
    for (const p of products || []) {
      const list = benefitsFromDocs({
        catalogProduct: p,
        layoutInput: artifactByProduct.get(String(p._id)) || null,
      });
      if (!list.length) continue;
      allLists.push(list);
      if (benefitsExamples.length < SAMPLE_BENEFITS_EXAMPLES) {
        benefitsExamples.push(list);
      }
    }

    const specExamples = [];
    for (const p of products || []) {
      if (specExamples.length >= SAMPLE_SPECS_EXAMPLES) break;
      const rows = specsFromProduct(p);
      if (!rows.length) continue;
      specExamples.push(rows.slice(0, 4));
    }

    return {
      benefitsExamples,
      specExamples,
      stats: computeStats(products.length, allLists),
    };
  } catch (_) {
    // C3: a read miss is the common case, not an error.
    return emptySample();
  }
}

const SAMPLE_HEADING = 'LIVE CONTENT SAMPLE (illustrative of this brand - NOT copy to put in the spec)';
const BIND_WARNING = 'To show benefits, bind:["benefits"] (the renderer fills per-ad from CatalogProduct.shortBenefits). do NOT add {literal:[...]} with these words — that freezes one SKU into every video.';
const SPECS_WARNING = 'there is no meta.specs field, do not invent a specs slot';
const EMPTY_BENEFITS_LINE = 'this brand currently has no derived catalog benefits. That is expected until ingest/backfill has written CatalogProduct.shortBenefits, not an error.';
const FLOOR_LINE = 'This brand\'s derived benefits lists have at least 3 lines whenever benefits exist — you have at least 3 lines to work with.';

const FORMATTING_BLOCK = [
  'BENEFITS FORMATTING:',
  '- Benefits belong in the `proof` or `close` phase, NOT as the hook hero. remotion/lib/stackFit.js planGroupFit never drops the FIRST contentful row (hero protection); a stack first in a tight box (Reels bottom 0.35) hits SHRINK_FLOOR 0.82 and still overflows.',
  '- Funnel intent is a SIGNAL not a template wipe: consideration prefers `proof`; conversion only if `close` has room; awareness never as the hook. Live generate also runs services/videoBenefitsDirector.js per ad with the same rules.',
  '- On `vertical`/`reels` prefer maxItems 3; 4 is fine on feed/square/landscape. (Measured: real arrays are 3-4 items, longest single string 42 chars.)',
  '- Keep `scrim: "none"` on a multi slot. slotRenderers.jsx wraps the WHOLE list in one scrim panel, which reads as a block rather than a list.',
  '- `itemDelaySec` is a FRACTION of the slot\'s own window (0..1-ish), NOT wall-clock seconds. 0.12 (the validator default) is a good cascade; 1.5 is not "1.5 seconds", it is broken.',
  '- `itemStyle: \'bullet\'` + `itemLayout: \'stack\'` is the default and the safe choice; \'pill\'/\'chip\' rows suit 2-3 SHORT items only.',
].join('\n');

function formatBenefitsSection(benefitsExamples, stats) {
  const lines = [];
  if (!benefitsExamples.length) {
    lines.push(EMPTY_BENEFITS_LINE);
  } else {
    lines.push('benefits examples:');
    benefitsExamples.forEach((list, i) => {
      lines.push(`  ${i + 1}. ${JSON.stringify(list)}`);
    });
  }
  lines.push(`benefits_stats: ${JSON.stringify(stats)}`);
  if (stats.item_count && stats.item_count.min >= BENEFIT_ITEM_FLOOR) {
    lines.push(FLOOR_LINE);
  }
  return lines;
}

function formatSpecsSection(specExamples) {
  if (!specExamples.length) return [];
  const lines = [`spec examples (attributes; ${SPECS_WARNING}):`];
  specExamples.forEach((rows, i) => {
    const compact = rows.map((r) => (r.label ? `${r.label}: ${r.value}` : r.value)).join('; ');
    lines.push(`  ${i + 1}. ${compact}`);
  });
  return lines;
}

function formatContentSampleBlock(sample) {
  const s = sample || emptySample();
  let benefitsExamples = Array.isArray(s.benefitsExamples) ? s.benefitsExamples.slice() : [];
  let specExamples = Array.isArray(s.specExamples) ? s.specExamples.slice() : [];
  const stats = s.stats || emptyStats(0);

  const header = [
    SAMPLE_HEADING,
    `${BIND_WARNING} ${SPECS_WARNING}.`,
  ];

  const assemble = (bens, specs) => [
    ...header,
    ...formatBenefitsSection(bens, stats),
    ...formatSpecsSection(specs),
    FORMATTING_BLOCK,
  ].join('\n');

  let block = assemble(benefitsExamples, specExamples);
  // ~1.5k cap: drop spec examples first, then extra benefit examples.
  // Never clip the heading, bind/literal warnings, empty-case line, or
  // BENEFITS FORMATTING — those are load-bearing even when over budget.
  if (block.length > SAMPLE_CHAR_CAP && specExamples.length) {
    specExamples = [];
    block = assemble(benefitsExamples, specExamples);
  }
  while (block.length > SAMPLE_CHAR_CAP && benefitsExamples.length > 1) {
    benefitsExamples = benefitsExamples.slice(0, -1);
    block = assemble(benefitsExamples, specExamples);
  }
  return block;
}

function composeModifyTitleSpecUserMsg({
  format,
  tokensJson,
  sampleBlock,
  historyBlock,
  currentSpec,
  request,
  extra,
} = {}) {
  return [
    `FORMAT: ${format}`,
    `BRAND TOKENS (defaults the spec inherits — override via tokenOverrides only when asked): ${tokensJson}`,
    sampleBlock,
    historyBlock,
    `CURRENT SPEC:\n${JSON.stringify(currentSpec, null, 2)}`,
    `OPERATOR REQUEST: ${request}`,
    extra || '',
  ].filter(Boolean).join('\n\n');
}

// ── Sample-collision guard ──────────────────────────────────────────────
// The titling LLM is shown REAL per-SKU benefit/spec strings so it can size a
// benefits slot sensibly. The danger is that it hardcodes one of those strings
// into a bind literal: that spec is brand+format scoped, and since
// TITLE_SPEC_IGNORE_PERSISTED was removed a persisted spec ALWAYS wins at
// render — so one SKU's copy would print on every render for that brand,
// invisibly (the preview looks right for the SKU under review).
//
// This guard lives HERE rather than in titleSpecValidator because the sample
// strings are only in scope at authoring time. A blanket "text slots may not
// bind a literal" rule was tried first and rejected: adgen's
// verifyBrandTaglineNoInversion.js group F proves an operator-authored literal
// in a text slot is a supported feature. The problem was never literals, it is
// literals COPIED FROM THE SAMPLE.

// Short strings collide by coincidence ("Black", "One size"), so only treat a
// reasonably long value as evidence of copying.
const SAMPLE_COLLISION_MIN_CHARS = 8;

function normalizeForCompare(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Every string in a content sample, normalized for comparison. Walks the
 * object rather than reading known keys so a shape change cannot silently
 * empty the guard (the failure mode would be invisible: guard passes, hole
 * open). Only strings >= SAMPLE_COLLISION_MIN_CHARS are collected.
 */
function collectSampleStrings(sample) {
  const out = new Set();
  const walk = (node, depth) => {
    if (node == null || depth > 6) return;
    if (typeof node === 'string') {
      const n = normalizeForCompare(node);
      if (n.length >= SAMPLE_COLLISION_MIN_CHARS) out.add(n);
      return;
    }
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node === 'object') {
      // Skip keys that hold no copyable creative text: stats are counts, and
      // a spec row's `label` is a field NAME ("Material", "Care") that an
      // operator could legitimately type — matching on it would be a false
      // positive. A row's `value` IS copyable and is walked.
      for (const [k, v] of Object.entries(node)) {
        if (k === 'stats' || k === 'item_count' || k === 'label' || k === 'productTitle') continue;
        walk(v, depth + 1);
      }
    }
  };
  walk(sample, 0);
  return out;
}

/**
 * Literals in a NORMALIZED spec whose value matches a sample string.
 * Checks both `bind` and `brandModeBind` — a guard on one chain only would be
 * bypassable by parking the literal in the other.
 * @returns {Array<{slotKey:string, chain:string, value:string}>}
 */
function findFrozenSampleLiterals(spec, sampleStrings) {
  const hits = [];
  if (!spec || !Array.isArray(spec.slots) || !sampleStrings || !sampleStrings.size) return hits;
  for (const slot of spec.slots) {
    for (const chain of ['bind', 'brandModeBind']) {
      const entries = Array.isArray(slot && slot[chain]) ? slot[chain] : [];
      for (const e of entries) {
        if (!e || typeof e !== 'object' || !Object.prototype.hasOwnProperty.call(e, 'literal')) continue;
        const vals = Array.isArray(e.literal) ? e.literal : [e.literal];
        for (const v of vals) {
          const n = normalizeForCompare(v);
          if (n.length >= SAMPLE_COLLISION_MIN_CHARS && sampleStrings.has(n)) {
            hits.push({ slotKey: slot.key, chain, value: String(v) });
          }
        }
      }
    }
  }
  return hits;
}

module.exports = {
  SAMPLE_COLLISION_MIN_CHARS,
  collectSampleStrings,
  findFrozenSampleLiterals,
  BENEFIT_ITEM_CAP,
  BENEFIT_CHAR_CAP,
  BENEFIT_ITEM_FLOOR,
  SAMPLE_CHAR_CAP,
  SAMPLE_HEADING,
  BIND_WARNING,
  SPECS_WARNING,
  EMPTY_BENEFITS_LINE,
  FLOOR_LINE,
  FORMATTING_BLOCK,
  normalizeBenefitList,
  benefitsFromDocs,
  benefitsFromArtifact,
  loadProductBenefits,
  loadTitleSpecContentSample,
  formatContentSampleBlock,
  composeModifyTitleSpecUserMsg,
};
