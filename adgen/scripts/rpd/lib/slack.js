// scripts/rpd/lib/slack.js — optional experiment-share ping for the RPD harness.
//
// This is NOT an operational alert. alertService has no channel param and
// drops info-level, so we copy its proven chat.postMessage sender rather
// than requiring that module (or mongoose). Slack returns HTTP 200 with
// {ok:false,error:"..."} on logical failure — success is body.ok === true,
// not res.ok. This module NEVER throws: missing config, network failure,
// and Slack's ok:false all become {ok:false, error}.

const SEND_TIMEOUT_MS = 8000;
const TEXT_MAX = 1000;

function configuredError() {
  return { ok: false, error: 'slack not configured (SLACK_BOT_TOKEN + RPD_SLACK_CHANNEL)' };
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function clip(s, max) {
  const t = String(s);
  if (max <= 0) return '';
  if (t.length <= max) return t;
  if (max === 1) return '…';
  return `${t.slice(0, max - 1)}…`;
}

// Plain text, no alert chrome. Run name, settled spend + status counts,
// optional takeaway, gallery URL last. Capped at ~1000 chars so a long
// takeaway cannot push the URL off the message.
function buildText({ runName, cells, takeaway, galleryUrl }) {
  const list = Array.isArray(cells) ? cells.filter((c) => c && typeof c === 'object') : [];
  let settled = 0;
  const byStatus = Object.create(null);
  for (const c of list) {
    if (c.costSource === 'actual' && Number.isFinite(Number(c.costUsd))) {
      settled += Number(c.costUsd);
    }
    const st = c.status != null && c.status !== '' ? String(c.status) : 'unknown';
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  const statusPart = Object.keys(byStatus).sort()
    .map((k) => `${k}=${byStatus[k]}`)
    .join(' ') || 'no cells';
  const header = `${runName || '(unnamed)'}\nsettled ${fmtUsd(settled)} · ${statusPart}`;
  const url = galleryUrl ? String(galleryUrl) : '';
  const urlTail = url ? `\n${url}` : '';
  let budget = TEXT_MAX - header.length - urlTail.length;
  let mid = '';
  if (takeaway != null && takeaway !== '' && budget > 1) {
    const raw = String(takeaway);
    mid = raw.length + 1 <= budget ? `\n${raw}` : `\n${clip(raw, budget - 1)}`;
  }
  const text = header + mid + urlTail;
  return text.length > TEXT_MAX ? clip(text, TEXT_MAX) : text;
}

// Send arbitrary text. Exported so callers that are NOT reporting a finished run
// (e.g. a spend receipt escaping an ephemeral host) do not have to fake a cells
// array and get a misleading "settled $0.00" line in their message.
async function postText(text, { channel } = {}) {
  return sendRaw(text, channel);
}

async function postExperiment({ channel, runName, galleryUrl, cells, takeaway } = {}) {
  const text = buildText({ runName, cells, takeaway, galleryUrl });
  return sendRaw(text, channel);
}

async function sendRaw(rawText, channel) {
  try {
    const token = String(process.env.SLACK_BOT_TOKEN || '').trim();
    const dest = String(channel || process.env.RPD_SLACK_CHANNEL || '').trim();
    if (!token || !dest) return configuredError();

    const text = rawText.length > TEXT_MAX ? clip(rawText, TEXT_MAX) : rawText;

    // Copied from services/alertService.js sendSlack (~226-291): Node 20+
    // global fetch, abort on timeout. Token appears only in the header.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({ channel: dest, text }),
        signal: ctl.signal
      });

      if (res.status === 429) {
        return { ok: false, error: 'rate_limited' };
      }

      // CRITICAL TRAP: Slack returns HTTP 200 with { ok: false, error: "..." }
      // for logical failures (bad token, channel_not_found, not_in_channel,
      // is_archived, …). A res.ok check alone reports success while nothing
      // was delivered. Always parse the body and require ok === true.
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      if (!res.ok) {
        const why = (body && body.error) ? String(body.error) : `HTTP ${res.status}`;
        return { ok: false, error: why };
      }
      if (!body || body.ok !== true) {
        const errName = (body && body.error) ? String(body.error) : 'unknown (no ok field)';
        return { ok: false, error: errName };
      }
      return { ok: true };
    } catch (err) {
      const why = err && err.name === 'AbortError'
        ? `timeout after ${SEND_TIMEOUT_MS}ms`
        : (err && err.message) || 'send failed';
      return { ok: false, error: String(why) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'send failed' };
  }
}

module.exports = { postExperiment, postText };
