// Full LayoutInput → Director → Generator (candidates+winner) → Judge →
// Resolver trace for one AiCanvasArtifact. Prints per-zone drift between
// the winning LLM JSON and the Resolver output.
//
// Usage:
//   node scripts/traceCanvasArtifact.js --id <aiCanvasArtifactId>

require('dotenv').config();
const mongoose = require('mongoose');

const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const AiJudgeResultArtifact     = require('../models/AiJudgeResultArtifact');
const ResolvedLayoutArtifact    = require('../models/ResolvedLayoutArtifact');

const args = process.argv.slice(2);
const ART_ID = pickArg('--id');

function pickArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function preview(v, n = 60) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return null;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

(async function main() {
  if (!ART_ID) {
    console.error('Usage: node scripts/traceCanvasArtifact.js --id <aiCanvasArtifactId>');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const canvas = await AiCanvasArtifact.findById(ART_ID).lean();
  if (!canvas) {
    console.error(`AiCanvasArtifact ${ART_ID} not found`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ───── AiCanvasArtifact summary ─────
  console.log('\n=== AiCanvasArtifact ===');
  console.log(JSON.stringify({
    template:         canvas.template,
    aspect:           canvas.aspectRatio,
    creativeStyle:    canvas.creativeStyle,
    directionArtifact: canvas.directionArtifactId,
    conceptId:        canvas.directionConceptId,
    candidatesCount:  (canvas.candidates || []).length,
    winnerSpecIndex:  canvas.winnerSpecIndex,
    judgeResult:      canvas.judgeResultId,
    outputKind:       canvas.outputKind,
    htmlSchemaVersion: canvas.htmlSchemaVersion,
    elementsUsed:     canvas.elementsUsed,
    elementsSkipped:  canvas.elementsSkipped,
    winnerZones: (canvas.canvasSpec?.zones || []).map(z => ({
      id: z.id, kind: z.kind, slot: z.slot, layer: z.layer,
      style_variant: z.style_variant, rect: z.rect, has_clip: !!z.clipPolygon
    }))
  }, null, 2));

  // ───── All candidates summarized ─────
  console.log(`\n=== Candidates (winner = index ${canvas.winnerSpecIndex}) ===`);
  (canvas.candidates || []).forEach((c, i) => {
    console.log(`-- candidate[${i}]${i === canvas.winnerSpecIndex ? ' *WINNER*' : ''} --`);
    console.log(JSON.stringify({
      rationale_head:    preview(c.rationale, 140),
      elements_used:     c.elements_used,
      elements_skipped:  c.elements_skipped,
      zone_ids: (c.zones || []).map(z => `${z.id}/${z.kind}`)
    }, null, 2));
  });

  // ───── LayoutInputArtifact ─────
  const layoutInput = await LayoutInputArtifact.findOne({
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    campaignContextHash: canvas.campaignContextHash,
    paletteSource:       canvas.paletteSource
  }).lean();
  const li = layoutInput?.input || {};
  console.log('\n=== LayoutInputArtifact ===');
  console.log(JSON.stringify({
    _id:                layoutInput?._id,
    schemaVersion:      layoutInput?.schemaVersion,
    copy_keys:          Object.keys(li.copy || {}),
    headline_candidates: Array.isArray(li.copy_candidates?.headline) ? li.copy_candidates.headline.length : 0,
    subheadline_candidates: Array.isArray(li.copy_candidates?.subheadline) ? li.copy_candidates.subheadline.length : 0,
    product_keys:       Object.keys(li.product || {}),
    social_proof_present: !!li.social_proof,
    badges:             li.product?.badges,
    hero_image:         preview(li.product?.hero_media?.image, 80),
    cta:                li.cta
  }, null, 2));

  // ───── Director concept ─────
  if (canvas.directionArtifactId) {
    const dir = await CreativeDirectionArtifact.findById(canvas.directionArtifactId).lean();
    const winnerConcept = (dir?.concepts || []).find(c => c.concept_id === canvas.directionConceptId);
    console.log('\n=== Director concept handed to Generator ===');
    console.log(JSON.stringify({
      signalsVersion:   dir?.signalsVersion,
      all_concept_ids:  (dir?.concepts || []).map(c => c.concept_id),
      chosen: winnerConcept ? {
        id:                     winnerConcept.concept_id,
        archetype:              winnerConcept.archetype,
        emotional_hook:         winnerConcept.emotional_hook,
        strategy:               winnerConcept.strategy,
        recommended_components: winnerConcept.recommended_components
      } : 'NOT FOUND'
    }, null, 2));
  }

  // ───── Judge result ─────
  if (canvas.judgeResultId) {
    const judge = await AiJudgeResultArtifact.findById(canvas.judgeResultId).lean();
    console.log('\n=== Judge result ===');
    console.log(JSON.stringify({
      winnerIndex:    judge?.winnerIndex,
      scores:         judge?.candidateScores,
      rationale_head: preview(judge?.rationale, 300)
    }, null, 2));
  }

  // ───── ResolvedLayoutArtifact ─────
  const resolved = await ResolvedLayoutArtifact
    .findOne({ aiCanvasArtifactId: canvas._id })
    .sort({ createdAt: -1 })
    .lean();
  console.log('\n=== ResolvedLayoutArtifact ===');
  console.log(JSON.stringify({
    status:       resolved?.resolutionStatus,
    validation:   resolved?.validation,
    fallbacks:    resolved?.fallbacksUsed,
    warnings:     resolved?.warnings,
    resolvedZones: (resolved?.resolvedZones || []).map(z => ({
      id: z.id, role: z.role, kind: z.kind, slot: z.slot,
      component_style: z.component_style, removed: z.removed,
      rect: z.rect, adjustments: z.adjustments
    })),
    slots: Object.entries(resolved?.resolvedData?.slots || {}).map(([k, v]) => ({
      id: k, asset_type: v.asset_type, from_path: v.from_path, from_fallback: v.from_fallback,
      value_preview: preview(v.resolved_value, 60)
    }))
  }, null, 2));

  // ───── Drift: winner zones vs resolved zones ─────
  console.log('\n=== DRIFT: winner LLM zones vs resolved zones ===');
  const winner = (canvas.candidates && canvas.candidates[canvas.winnerSpecIndex]) || {
    zones: canvas.canvasSpec?.zones || []
  };
  const winnerById   = new Map((winner.zones || []).map(z => [z.id, z]));
  const resolvedById = new Map((resolved?.resolvedZones || []).map(z => [z.id, z]));
  const allIds = new Set([...winnerById.keys(), ...resolvedById.keys()]);
  for (const id of allIds) {
    const w = winnerById.get(id);
    const r = resolvedById.get(id);
    if (!w) { console.log(`+ resolver added:   ${id} (NOT in LLM zones)`); continue; }
    if (!r) { console.log(`- resolver dropped: ${id}`); continue; }
    const drifts = [];
    if (w.style_variant !== r.component_style) {
      drifts.push(`style ${w.style_variant} → ${r.component_style}`);
    }
    if (JSON.stringify(w.rect) !== JSON.stringify(r.rect)) {
      drifts.push(`rect ${JSON.stringify(w.rect)} → ${JSON.stringify(r.rect)}`);
    }
    if (r.removed) {
      drifts.push(`REMOVED (${r.adjustments?.[0]?.reason || '?'})`);
    }
    console.log(drifts.length ? `~ ${id}: ${drifts.join('; ')}` : `= ${id}: clean`);
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('trace failed:', err.stack || err.message || err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
