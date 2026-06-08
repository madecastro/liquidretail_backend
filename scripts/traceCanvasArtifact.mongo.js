// Full LayoutInput → Director → Generator (candidates+winner) → Judge → Resolver
// trace for a single AiCanvasArtifact. Run from mongosh:
//   load("scripts/traceCanvasArtifact.mongo.js")
// Set ART before loading, or edit the constant below.
const ART = typeof globalART !== 'undefined' ? globalART : ObjectId("6a272e9b78b98bb12c0914af");
const canvas = db.aicanvasartifacts.findOne({ _id: ART }, {
  mediaId: 1, template: 1, aspectRatio: 1,
  productId: 1, variantKind: 1, paletteSource: 1, campaignContextHash: 1,
  creativeStyle: 1, brandId: 1,
  directionArtifactId: 1, directionConceptId: 1,
  winnerSpecIndex: 1, judgeResultId: 1,
  elementsUsed: 1, elementsSkipped: 1,
  rationale: 1, candidates: 1,
  "canvasSpec.zones": 1, "canvasSpec.canvas": 1,
  "canvasSpec.style_bindings": 1, "canvasSpec.hierarchy_spec": 1, "canvasSpec.copy_picks": 1,
  outputKind: 1, htmlSchemaVersion: 1, htmlValidationId: 1, createdAt: 1
});
if (!canvas) { print("AiCanvasArtifact " + ART + " not found"); }
print("=== AiCanvasArtifact ===");
printjson({
  template: canvas.template, aspect: canvas.aspectRatio, creativeStyle: canvas.creativeStyle,
  directionArtifact: canvas.directionArtifactId, conceptId: canvas.directionConceptId,
  candidatesCount: (canvas.candidates || []).length, winnerSpecIndex: canvas.winnerSpecIndex,
  judgeResult: canvas.judgeResultId, outputKind: canvas.outputKind,
  htmlSchemaVersion: canvas.htmlSchemaVersion,
  elementsUsed: canvas.elementsUsed, elementsSkipped: canvas.elementsSkipped,
  winnerZones: (canvas.canvasSpec && canvas.canvasSpec.zones || []).map(function (z) {
    return { id: z.id, kind: z.kind, slot: z.slot, layer: z.layer, style_variant: z.style_variant, rect: z.rect, has_clip: !!z.clipPolygon };
  })
});
print("=== Candidates (winner = index " + canvas.winnerSpecIndex + ") ===");
(canvas.candidates || []).forEach(function (c, i) {
  print("-- candidate[" + i + "]" + (i === canvas.winnerSpecIndex ? " *WINNER*" : "") + " --");
  printjson({
    rationale_head: (c.rationale || "").slice(0, 140),
    elements_used: c.elements_used, elements_skipped: c.elements_skipped,
    zone_ids: (c.zones || []).map(function (z) { return z.id + "/" + z.kind; })
  });
});
const layoutInput = db.layoutinputartifacts.findOne({
  mediaId: canvas.mediaId, template: canvas.template, aspectRatio: canvas.aspectRatio,
  productId: canvas.productId, variantKind: canvas.variantKind,
  campaignContextHash: canvas.campaignContextHash, paletteSource: canvas.paletteSource
}, { input: 1, createdAt: 1, schemaVersion: 1 });
print("=== LayoutInputArtifact ===");
printjson({
  _id: layoutInput && layoutInput._id, schemaVersion: layoutInput && layoutInput.schemaVersion,
  copy_keys: Object.keys((layoutInput && layoutInput.input && layoutInput.input.copy) || {}),
  headline_candidates: Array.isArray(layoutInput && layoutInput.input && layoutInput.input.copy_candidates && layoutInput.input.copy_candidates.headline) ? layoutInput.input.copy_candidates.headline.length : 0,
  subheadline_candidates: Array.isArray(layoutInput && layoutInput.input && layoutInput.input.copy_candidates && layoutInput.input.copy_candidates.subheadline) ? layoutInput.input.copy_candidates.subheadline.length : 0,
  product_keys: Object.keys((layoutInput && layoutInput.input && layoutInput.input.product) || {}),
  social_proof_present: !!(layoutInput && layoutInput.input && layoutInput.input.social_proof),
  badges: layoutInput && layoutInput.input && layoutInput.input.product && layoutInput.input.product.badges,
  hero_image: layoutInput && layoutInput.input && layoutInput.input.product && layoutInput.input.product.hero_media && layoutInput.input.product.hero_media.image ? layoutInput.input.product.hero_media.image.slice(0, 80) : null,
  cta: layoutInput && layoutInput.input && layoutInput.input.cta
});
if (canvas.directionArtifactId) {
  const dir = db.creativedirectionartifacts.findOne({ _id: canvas.directionArtifactId }, {
    "concepts.concept_id": 1, "concepts.archetype": 1, "concepts.emotional_hook": 1,
    "concepts.recommended_components": 1, "concepts.strategy": 1, signalsVersion: 1
  });
  const winnerConcept = ((dir && dir.concepts) || []).find(function (c) { return c.concept_id === canvas.directionConceptId; });
  print("=== Director concept handed to Generator ===");
  printjson({
    signalsVersion: dir && dir.signalsVersion,
    all_concept_ids: ((dir && dir.concepts) || []).map(function (c) { return c.concept_id; }),
    chosen: winnerConcept ? {
      id: winnerConcept.concept_id, archetype: winnerConcept.archetype,
      emotional_hook: winnerConcept.emotional_hook, strategy: winnerConcept.strategy,
      recommended_components: winnerConcept.recommended_components
    } : "NOT FOUND"
  });
}
if (canvas.judgeResultId) {
  const judge = db.aijudgeresultartifacts.findOne({ _id: canvas.judgeResultId });
  print("=== Judge result ===");
  printjson({
    winnerIndex: judge && judge.winnerIndex,
    scores: judge && judge.candidateScores,
    rationale_head: ((judge && judge.rationale) || "").slice(0, 300)
  });
}
const resolved = db.resolvedlayoutartifacts.findOne({ aiCanvasArtifactId: ART }, {
  resolutionStatus: 1, validation: 1, fallbacksUsed: 1, warnings: 1,
  "resolvedZones.id": 1, "resolvedZones.role": 1, "resolvedZones.kind": 1,
  "resolvedZones.slot": 1, "resolvedZones.component_style": 1, "resolvedZones.css_class": 1,
  "resolvedZones.removed": 1, "resolvedZones.rect": 1, "resolvedZones.adjustments": 1,
  "resolvedData.slots": 1
});
print("=== ResolvedLayoutArtifact ===");
printjson({
  status: resolved && resolved.resolutionStatus, validation: resolved && resolved.validation,
  fallbacks: resolved && resolved.fallbacksUsed, warnings: resolved && resolved.warnings,
  resolvedZones: ((resolved && resolved.resolvedZones) || []).map(function (z) {
    return { id: z.id, role: z.role, kind: z.kind, slot: z.slot, component_style: z.component_style, removed: z.removed, rect: z.rect, adjustments: z.adjustments };
  }),
  slots: Object.entries((resolved && resolved.resolvedData && resolved.resolvedData.slots) || {}).map(function (entry) {
    const k = entry[0], v = entry[1];
    return { id: k, asset_type: v.asset_type, from_path: v.from_path, from_fallback: v.from_fallback,
      value_preview: typeof v.resolved_value === 'string' ? v.resolved_value.slice(0, 60) : JSON.stringify(v.resolved_value).slice(0, 60) };
  })
});
print("=== DRIFT: winner LLM zones vs resolved zones ===");
const winner = (canvas.candidates && canvas.candidates[canvas.winnerSpecIndex]) || { zones: (canvas.canvasSpec && canvas.canvasSpec.zones) || [] };
const winnerZones = new Map((winner.zones || []).map(function (z) { return [z.id, z]; }));
const resolvedById = new Map(((resolved && resolved.resolvedZones) || []).map(function (z) { return [z.id, z]; }));
const allIds = new Set([].concat(Array.from(winnerZones.keys()), Array.from(resolvedById.keys())));
allIds.forEach(function (id) {
  const w = winnerZones.get(id), r = resolvedById.get(id);
  if (!w) { print("+ resolver added: " + id + " (NOT in LLM zones)"); return; }
  if (!r) { print("- resolver dropped: " + id); return; }
  const drifts = [];
  if (w.style_variant !== r.component_style) drifts.push("style " + w.style_variant + " -> " + r.component_style);
  if (JSON.stringify(w.rect) !== JSON.stringify(r.rect)) drifts.push("rect " + JSON.stringify(w.rect) + " -> " + JSON.stringify(r.rect));
  if (r.removed) drifts.push("REMOVED (" + ((r.adjustments && r.adjustments[0] && r.adjustments[0].reason) || "?") + ")");
  if (drifts.length) print("~ " + id + ": " + drifts.join("; "));
  else print("= " + id + ": clean");
});
