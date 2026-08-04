// Shared Ad row + diagnostic block for GET /api/ads/render-activity and
// crash/alert paths.
//
// Extracted verbatim from the former inline builder in routes/ads.js
// (render-activity handler). BYTE-IDENTICAL output is load-bearing: a
// harness diffs against the pre-extraction behaviour. Do not reformat,
// reorder lines, rename fields, or change `-` placeholders.
//
// buildAdRow must tolerate a lean/partial Ad (crash paths often hold only
// an _id + a couple of fields) — every field access is null-safe and must
// never throw. userById may be null; then requestedBy falls back to the
// raw id string.

/**
 * Build the render-activity row object for one Ad.
 * @param {object|null} ad  Ad doc (full, lean, or partial {_id,...})
 * @param {{ run?: object|null, userById?: Map|null }} [opts]
 * @returns {object} row (without `diagnostic` — call buildAdDiagnostic)
 */
function buildAdRow(ad, { run = null, userById = null } = {}) {
  const a = ad || {};
  const now = Date.now();
  const predictionId = a.imageGeneration?.predictionId || a.veoPredictionId || null;
  const stageAgeSec = a.renderStageAt ? Math.round((now - new Date(a.renderStageAt).getTime()) / 1000) : null;
  const t = a.renderStages || {};
  return {
    assetId:       a._id != null ? String(a._id) : '',
    status:        a.status,
    stage:         a.renderStage || null,
    stageAgeSec,
    // A render sitting in one stage far longer than that stage's normal cost
    // is the signal worth surfacing; 600s is the Atlas image deadline and the
    // video poll ceiling, so past that something is genuinely wrong.
    stalled:       a.status === 'rendering' && stageAgeSec != null && stageAgeSec > 600,
    kind:          a.kind,
    template:      a.template,
    platformFormat: a.platformFormat,
    aspectRatio:   a.aspectRatio,
    pipeline:      a.imageGeneration?.pipeline || (a.kind === 'video' ? 'veo' : null),
    model:         a.imageGeneration?.model || null,
    predictionId,
    // Provenance for the multi-size video story: a 1:1 or 4:5 video whose
    // veoAspectRatio is 9:16 was CROPPED from a master, not generated.
    derivedFromMaster: a.kind === 'video' && a.veoAspectRatio === '9:16' && a.aspectRatio !== '9:16',
    timingsMs:     { derive: t.deriveMs ?? null, render: t.renderMs ?? null, upload: t.uploadMs ?? null },
    intent:        a.intentResolution
      ? { requested: a.intentResolution.requested, delivered: a.intentResolution.delivered,
          fellBackFrom: a.intentResolution.fellBackFrom || null,
          dropped: a.intentResolution.droppedRoles || [] }
      : null,
    visionQc:      a.visionQc
      ? { passed: a.visionQc.passed, finalAttempt: a.visionQc.finalAttempt,
          skipped: !!a.visionQc.skipped, disabled: !!a.visionQc.disabled,
          attempts: (a.visionQc.attempts || []).map(t => ({
            attempt: t.attempt, pass: t.pass, summary: t.summary,
            discarded: !!t.discarded, renderUrl: t.renderUrl || null,
            discardedRenderUrl: t.discardedRenderUrl || null
          })) }
      : null,
    assetUrl:      a.renderUrl || null,
    error:         a.renderError?.message || (typeof a.renderError === 'string' ? a.renderError : null),
    attempts:      a.renderAttempts ?? null,
    ids:           {
      campaignId: a.campaignId ? String(a.campaignId) : null,
      runId:      run?.runId || (a.campaignRunIds || [])[0] || null,
      productId:  a.productId ? String(a.productId) : null,
      mediaId:    a.mediaId ? String(a.mediaId) : null,
      brandId:    a.brandId ? String(a.brandId) : null,
      conceptId:  a.conceptId || null
    },
    requestedBy:   (() => {
      const uid = run?.requestedBy ? String(run.requestedBy) : null;
      if (!uid) return null;
      // userById may be null on crash paths — fall back to the raw id string.
      const u = userById && typeof userById.get === 'function' ? userById.get(uid) : null;
      return u?.email || u?.name || uid;   // id is still useful; never blank
    })(),
    run:           run ? { status: run.status, total: run.total, succeeded: run.succeeded, failed: run.failed, skipped: run.skipped } : null,
    queuedAt:      a.queuedAt || null,
    renderedAt:    a.renderedAt || null,
    updatedAt:     a.updatedAt || null
  };
}

/**
 * Pre-formatted one-paste diagnostic block (newline-joined).
 * Byte-identical to the former inline join in routes/ads.js.
 * @param {object} row  from buildAdRow
 * @returns {string}
 */
function buildAdDiagnostic(row) {
  // Verbatim former inline join — do not reformat or reorder.
  return [
    `asset=${row.assetId}`,
    `status=${row.status}${row.stalled ? ' STALLED' : ''}`,
    `stage=${row.stage || '-'}${row.stageAgeSec != null ? ` (${row.stageAgeSec}s)` : ''}`,
    `kind=${row.kind} fmt=${row.platformFormat} aspect=${row.aspectRatio}`,
    `pipeline=${row.pipeline || '-'} model=${row.model || '-'}`,
    `prediction=${row.predictionId || '-'}`,
    row.derivedFromMaster ? 'derivedFromMaster=true (cropped, not generated)' : null,
    `timings(ms) derive=${row.timingsMs.derive ?? '-'} render=${row.timingsMs.render ?? '-'} upload=${row.timingsMs.upload ?? '-'}`,
    row.intent ? `intent=${row.intent.delivered}${row.intent.fellBackFrom ? ` (fellBackFrom ${row.intent.fellBackFrom})` : ''}${row.intent.dropped.length ? ` dropped=${row.intent.dropped.join('+')}` : ''}` : null,
    `run=${row.ids.runId || '-'} by=${row.requestedBy || '-'}`,
    `product=${row.ids.productId || '-'} media=${row.ids.mediaId || '-'} concept=${row.ids.conceptId || '-'}`,
    row.error ? `error=${row.error}` : null,
    row.assetUrl ? `asset=${row.assetUrl}` : null
  ].filter(Boolean).join('\n');
}

/**
 * Convenience: buildAdDiagnostic(buildAdRow(ad, opts)).
 * @param {object|null} ad
 * @param {{ run?: object|null, userById?: Map|null }} [opts]
 * @returns {string}
 */
function diagnosticForAd(ad, opts) {
  return buildAdDiagnostic(buildAdRow(ad, opts));
}

module.exports = {
  buildAdRow,
  buildAdDiagnostic,
  diagnosticForAd
};
