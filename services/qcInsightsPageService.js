'use strict';
/**
 * Pure HTML builder for the QC-insights report page. No DB import.
 * Every interpolated string goes through esc() — findings text and LLM
 * proposal text are untrusted.
 */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 1000) / 10}%`;
}

function onOff(v) {
  return v ? 'ON' : 'OFF';
}

function trendSvg(history) {
  const points = (history || [])
    .filter((r) => r && r.totals && Number.isFinite(r.totals.passRate))
    .slice()
    .reverse();
  if (points.length < 2) return '';
  const w = 640;
  const h = 120;
  const pad = 8;
  const ys = points.map((p) => p.totals.passRate);
  const min = Math.min(...ys, 0);
  const max = Math.max(...ys, 1);
  const span = (max - min) || 1;
  const coords = points.map((p, i) => {
    const x = pad + (i * (w - pad * 2)) / (points.length - 1);
    const y = h - pad - ((p.totals.passRate - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="pass-rate trend">
  <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${coords.join(' ')}" />
</svg>`;
}

function badge(text, kind) {
  const color = kind === 'on' ? '#166534' : kind === 'off' ? '#92400e' : kind === 'implement' ? '#166534' : kind === 'test' ? '#1e40af' : '#6b7280';
  const bg = kind === 'on' ? '#dcfce7' : kind === 'off' ? '#fef3c7' : kind === 'implement' ? '#dcfce7' : kind === 'test' ? '#dbeafe' : '#f3f4f6';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${color};font-size:12px;font-weight:600">${esc(text)}</span>`;
}

function overrideEntryBlock(p) {
  const match = {};
  if (p.scope && p.scope.type === 'segment') {
    if (p.scope.dimension === 'seedStyle') match.seedStyle = p.scope.value;
    else if (p.scope.dimension === 'surface') match.surface = p.scope.value;
    else if (p.scope.dimension === 'intent') match.intent = p.scope.value;
    else if (p.scope.dimension === 'shotType') match.shotType = p.scope.value;
    else if (p.scope.dimension === 'categoryTop') match.categoryPrefix = p.scope.value;
  }
  const entry = {
    id: p.issueKey || 'untitled',
    enabled: false,
    match,
    appendText: p.appendText || '',
    source: 'qc-insights',
    adoptedAt: null
  };
  return JSON.stringify(entry, null, 2);
}

function buildQcInsightsHtml({ report, history }) {
  const r = report || {};
  const cfg = r.qcConfig || {};
  const staticOn = cfg.staticQcEnabled === true;
  const videoOn = cfg.videoQcEnabled === true;
  const eitherOff = !staticOn || !videoOn;
  const totals = r.totals || {};
  const bannerBg = eitherOff ? '#fef3c7' : '#ecfdf5';
  const bannerFg = eitherOff ? '#92400e' : '#166534';

  const catRows = Object.entries(r.categories || {}).map(([key, c]) => {
    const sv = (r.segmentVerdicts && r.segmentVerdicts[key]) || {};
    const conc = (sv.concentrations || []).map((x) =>
      `${esc(x.dimension)}=${esc(x.value)} n=${esc(x.n)} lift=${esc((x.lift || 0).toFixed(2))}`
    ).join('; ') || '—';
    const n = c && c.n ? c.n : 0;
    const fails = c && c.fails ? c.fails : 0;
    const rate = n ? fails / n : 0;
    return `<tr><td>${esc(key)}</td><td>${esc(n)}</td><td>${esc(fails)}</td><td>${esc(pct(rate))}</td><td>${esc(sv.verdict || '—')}</td><td>${conc}</td></tr>`;
  }).join('');

  const dimGroups = {};
  for (const s of r.segments || []) {
    const dim = s.dimension || 'unknown';
    if (!dimGroups[dim]) dimGroups[dim] = [];
    dimGroups[dim].push(s);
  }
  const segSections = Object.entries(dimGroups).map(([dim, list]) => {
    const rows = list.map((s) =>
      `<tr><td>${esc(s.value)}</td><td>${esc(s.n)}</td><td>${esc(pct(s.passRate))}</td><td>${esc(pct(s.attempt1FailRate))}</td></tr>`
    ).join('');
    return `<h3>${esc(dim)}</h3><table><thead><tr><th>value</th><th>n</th><th>pass</th><th>attempt-1 fail</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');

  const clusterRows = (r.findingsClusters || []).slice(0, 20).map((c) =>
    `<tr><td>${esc(c.category)}</td><td>${esc(c.text)}</td><td>${esc(c.n)}</td></tr>`
  ).join('');

  const armRows = (r.armComparison || []).slice(0, 20).map((a) =>
    `<tr><td>${esc(a.key)}</td><td>${esc(a.n)}</td><td>${esc(pct(a.passRate))}</td><td>${esc(pct(a.attempt1FailRate))}</td></tr>`
  ).join('');

  const ovRows = (r.overridePerformance || []).map((o) =>
    `<tr><td>${esc(o.id)}</td><td>${esc(o.n)}</td><td>${esc(pct(o.attempt1FailRate))}</td><td>${esc(pct(o.baselineAttempt1FailRate))}</td><td>${badge(o.recommendation, o.recommendation)}</td></tr>`
  ).join('');

  const proposals = (r.proposals || []).map((p) => {
    const scope = p.scope && p.scope.type === 'segment'
      ? `${p.scope.dimension}=${p.scope.value}`
      : 'general';
    return `<article style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
  <header style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <strong>${esc(p.issueKey || 'untitled')}</strong>
    ${badge(scope, 'test')}
    ${badge(p.qcCategory || '—')}
    ${badge(p.recommendation || 'hold', p.recommendation)}
  </header>
  <p><em>rationale:</em> ${esc(p.rationale)}</p>
  <p><em>expected:</em> ${esc(p.expectedEffect)}</p>
  <p><em>risk:</em> ${esc(p.risk)}</p>
  <pre style="white-space:pre-wrap;background:#111827;color:#f9fafb;padding:12px;border-radius:6px;overflow:auto">${esc(overrideEntryBlock(p))}</pre>
</article>`;
  }).join('') || '<p>No proposals on this report.</p>';

  const generated = r.generatedAt ? new Date(r.generatedAt).toISOString() : '—';
  const trend = trendSvg(history);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>QC insights ${esc(generated)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
    th, td { border-bottom: 1px solid #e5e7eb; text-align: left; padding: 6px 8px; font-size: 14px; }
    .tiles { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
    .tile { background: #f9fafb; border-radius: 8px; padding: 12px 16px; min-width: 140px; }
    .tile .n { font-size: 28px; font-weight: 700; }
    footer { margin-top: 48px; color: #6b7280; font-size: 13px; }
  </style>
</head>
<body>
  <h1>QC insights</h1>
  <p>Generated ${esc(generated)} · scanned ${esc(r.adsScanned || 0)} ads · ${esc(r.adsWithVerdicts || 0)} with verdicts</p>
  <div style="background:${bannerBg};color:${bannerFg};padding:12px 16px;border-radius:8px;font-weight:600">
    Static QC: ${esc(onOff(staticOn))} · Video QC: ${esc(onOff(videoOn))}
    ${eitherOff ? ' — coverage gap: a gate is off, so this report under-represents that pipeline.' : ''}
  </div>
  <div class="tiles">
    <div class="tile"><div class="n">${esc(totals.judged || 0)}</div><div>judged</div></div>
    <div class="tile"><div class="n">${esc(pct(totals.passRate))}</div><div>pass rate</div></div>
    <div class="tile"><div class="n">${esc(pct(totals.attempt1FailRate))}</div><div>attempt-1 fail</div></div>
    <div class="tile"><div class="n">${esc(pct(totals.regenRescueRate))}</div><div>regen rescue</div></div>
  </div>
  ${trend ? `<h2>Trend</h2>${trend}` : ''}
  <h2>Per-category</h2>
  <table><thead><tr><th>category</th><th>n</th><th>fails</th><th>rate</th><th>verdict</th><th>concentrations</th></tr></thead><tbody>${catRows}</tbody></table>
  <h2>Segments</h2>
  ${segSections || '<p>No segments above the noise floor.</p>'}
  <h2>Top findings</h2>
  <table><thead><tr><th>category</th><th>finding</th><th>n</th></tr></thead><tbody>${clusterRows}</tbody></table>
  <h2>Prompt arms</h2>
  <table><thead><tr><th>arm</th><th>n</th><th>pass</th><th>attempt-1 fail</th></tr></thead><tbody>${armRows}</tbody></table>
  <h2>Override performance</h2>
  <table><thead><tr><th>id</th><th>n</th><th>fail rate</th><th>baseline</th><th>recommendation</th></tr></thead><tbody>${ovRows}</tbody></table>
  <h2>Proposals</h2>
  ${proposals}
  <footer>
    Scope is STATIC ads only. Video prompt text is frozen and out of scope for
    prompt overrides even though video now has its own QC gate — the override
    mechanism only ever touches services/staticAdIntents.js. Ready-to-paste
    entries land in config/segmentPromptOverrides.js.
  </footer>
</body>
</html>`;
}

module.exports = { buildQcInsightsHtml, esc };
