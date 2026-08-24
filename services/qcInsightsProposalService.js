'use strict';
/**
 * LLM proposal stage for QC insights. Ships dark
 * (QC_INSIGHTS_PROPOSALS_ENABLED must be the exact string 'true').
 *
 * HARD BOUND: at most 2 LLM calls per report, ever. Never throws to the
 * scheduler or the manual-run route.
 */

const crypto = require('crypto');
const { chatCompletion } = require('./atlasLlmService');

const MAX_APPEND = 400;
const MAX_PROPOSALS = 5;
const RAW_TRUNC = 20000;
const RECOMMENDATIONS = new Set(['implement', 'test', 'hold']);
const CATEGORIES = new Set([
  'competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box'
]);

const SYSTEM_PROMPT = `You propose AT MOST 5 ADDITIVE prompt directives for static product ads.
Each directive is appended to an already-assembled prompt; never rewrite or remove existing text.
appendText must be <= 400 characters.
Scope is either {"type":"general"} or {"type":"segment","dimension":"...","value":"..."} — segment scope only where n>=20 and lift>=1.5.
recommendation is implement|test|hold. Use implement only when evidence is strong AND risk is low; prefer test.
OUTPUT CONTRACT: reply with strict JSON only, no prose, no markdown fences:
{"proposals":[{"issueKey","qcCategory","scope":{"type":"general"}|{"type":"segment","dimension","value"},"appendText","rationale","expectedEffect","risk","recommendation"}]}
If the data is too thin to justify a change, return {"proposals":[]}.
Thin data is not a stop — it is an empty list.`;

function stripFences(raw) {
  return String(raw || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

function balancedObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseProposalsJson(raw) {
  const cleaned = stripFences(raw);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (_) {
    const span = balancedObject(cleaned);
    if (!span) return { ok: false, value: null };
    try {
      return { ok: true, value: JSON.parse(span) };
    } catch (err) {
      return { ok: false, value: null, error: err };
    }
  }
}

function coerceScope(scope) {
  if (scope && scope.type === 'general') return { type: 'general' };
  if (scope && scope.type === 'segment' && scope.dimension && scope.value != null && String(scope.value).trim()) {
    return { type: 'segment', dimension: String(scope.dimension), value: String(scope.value) };
  }
  return null;
}

function validateProposal(p) {
  if (!p || typeof p !== 'object') return null;
  const issueKey = String(p.issueKey || '').trim();
  const appendText = String(p.appendText || '').trim().slice(0, MAX_APPEND);
  if (!issueKey || !appendText) return null;
  const qcCategory = CATEGORIES.has(p.qcCategory) ? p.qcCategory : 'product_fidelity';
  let scope = coerceScope(p.scope);
  let recommendation = RECOMMENDATIONS.has(p.recommendation) ? p.recommendation : 'hold';
  if (!scope) {
    scope = { type: 'general' };
    recommendation = 'hold';
  }
  return {
    issueKey,
    qcCategory,
    scope,
    appendText,
    rationale: String(p.rationale || '').slice(0, 800),
    expectedEffect: String(p.expectedEffect || '').slice(0, 400),
    risk: String(p.risk || '').slice(0, 400),
    recommendation
  };
}

function compactPayload(report) {
  const segs = (report.segments || []).slice().sort((a, b) => (b.attempt1FailRate || 0) - (a.attempt1FailRate || 0)).slice(0, 15);
  const clusters = (report.findingsClusters || []).slice(0, 15);
  return {
    totals: report.totals || {},
    categories: report.categories || {},
    segmentVerdicts: report.segmentVerdicts || {},
    worstSegments: segs,
    findingsClusters: clusters,
    overridePerformance: report.overridePerformance || []
  };
}

async function callOnce(messages) {
  const result = await chatCompletion(
    { stage: 'qc_insights', service: 'qcInsightsProposalService', purpose: 'prompt-improvement proposals' },
    {
      model: 'qc-insights',
      messages,
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: 'json_object' }
    }
  );
  const content = result && result.content != null
    ? result.content
    : (result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '';
  const model = (result && (result.model || result.usedModel)) || 'qc-insights';
  return { content: String(content || ''), model };
}

async function generateAndAttachProposals(report) {
  const empty = [];
  if (!report) return empty;
  try {
    const payload = compactPayload(report);
    const user = `Propose additive prompt directives from this QC-insights snapshot:\n${JSON.stringify(payload)}`;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user }
    ];
    let raw = '';
    let model = 'qc-insights';
    let correctiveReask = false;
    let calls = 0;

    const first = await callOnce(messages);
    calls += 1;
    raw = first.content;
    model = first.model || model;
    let parsed = parseProposalsJson(raw);

    if (!parsed.ok && calls < 2) {
      correctiveReask = true;
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: 'Your previous reply was not valid JSON matching the OUTPUT CONTRACT. Reply with JSON only: {"proposals":[...]} or {"proposals":[]}.'
      });
      const second = await callOnce(messages);
      calls += 1;
      raw = second.content;
      model = second.model || model;
      parsed = parseProposalsJson(raw);
    }

    if (calls > 2) {
      throw new Error('qc-insights proposals exceeded the 2-call bound');
    }

    if (!parsed.ok) {
      try {
        require('./alertService').notifyAsync({
          level: 'warn',
          key: 'qc-insights:proposals-unparseable',
          title: 'QC insights proposals unparseable after 2 calls'
        });
      } catch (_) { /* ignore */ }
      report.proposals = [];
      report.proposalsProvenance = {
        error: 'unparseable',
        model,
        promptSha256: crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
        rawResponseTruncated: String(raw).slice(0, RAW_TRUNC),
        generatedAt: new Date(),
        correctiveReask,
        droppedInvalid: 0,
        llmCalls: calls
      };
      if (typeof report.save === 'function') await report.save();
      return [];
    }

    const rawList = Array.isArray(parsed.value && parsed.value.proposals) ? parsed.value.proposals : [];
    const valid = [];
    let droppedInvalid = 0;
    for (const item of rawList) {
      if (valid.length >= MAX_PROPOSALS) { droppedInvalid += 1; continue; }
      const v = validateProposal(item);
      if (!v) { droppedInvalid += 1; continue; }
      valid.push(v);
    }

    report.proposals = valid;
    report.proposalsProvenance = {
      model,
      promptSha256: crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex'),
      rawResponseTruncated: String(raw).slice(0, RAW_TRUNC),
      generatedAt: new Date(),
      correctiveReask,
      droppedInvalid,
      llmCalls: calls
    };
    if (typeof report.save === 'function') await report.save();
    return valid;
  } catch (err) {
    try {
      require('./alertService').notifyAsync({
        level: 'error',
        key: 'qc-insights:proposals-error',
        title: `QC insights proposals failed: ${err && err.message ? err.message : err}`
      });
    } catch (_) { /* ignore */ }
    try {
      if (report) {
        report.proposals = report.proposals || [];
        report.proposalsProvenance = Object.assign({}, report.proposalsProvenance || {}, {
          error: (err && err.message) ? err.message : String(err || 'unknown'),
          generatedAt: new Date()
        });
        if (typeof report.save === 'function') await report.save();
      }
    } catch (_) { /* ignore */ }
    return [];
  }
}

module.exports = {
  generateAndAttachProposals,
  parseProposalsJson,
  validateProposal,
  SYSTEM_PROMPT
};
