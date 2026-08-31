'use strict';
//
// ingestStatusFeedService — Slack live status for catalog/brand INGEST runs
// (OperationRun), sibling to services/runFeedService.js (which does the same
// job for ad-generation CampaignRun/Ad). Two separate modules on purpose —
// see the design note below.
//
// ONE Slack message per OperationRun, chat.update'd in place as stages
// complete, ending as a final stage-by-stage timing summary. No thread: an
// ingest run has a handful of named stages (2-8 typically — see
// progressService's CANCELLABLE_KINDS / call sites), not the hundreds of
// per-ad events runFeedService's ring buffer exists to batch, so the parent
// message's own growing body IS the detailed log; a thread would add
// complexity (claim races, batching, a second Slack call per flush) for no
// real benefit at this volume.
//
// Why NOT extend runFeedService instead of writing a sibling: runFeedService
// is intrinsically Ad/CampaignRun-shaped — it aggregates Ad.status via
// `campaignRunIds`, reads Ad.renderError for failure reasons, and claims its
// parent ts on CampaignRun.slackFeed. Retrofitting it to be model-agnostic
// would touch a heavily-tested, money-adjacent file (verifyRunFeed.js,
// verifySlackRunVerbosity.js, wired from the paid render loop) for a feature
// that has nothing to do with ad rendering. A new, small, single-purpose
// module keyed on OperationRun is the lower-risk change and mirrors this
// repo's own precedent of NOT sharing alertService's transport with
// runFeedService either — each has its own inlined `slackApi`.
//
// ── SAFETY CONTRACT (mirrors runFeedService's) ─────────────────────────────
//   1. Every export is fire-and-forget-safe: never throws, never returns a
//      promise a caller needs to await, never blocks a caller's stack.
//   2. All Slack I/O happens on a DETACHED interval timer, never inside
//      progressService's own call stack.
//   3. Completely inert unless INGEST_STATUS_SLACK_ENABLED (default true)
//      AND SLACK_BOT_TOKEN AND SLACK_INGEST_STATUS_CHANNEL are all set —
//      one warn per process at most, zero fetches otherwise.
//   4. HTTP 429 → log Retry-After, drop that flush. NEVER sleep.
//   5. Updates are throttled per run (INGEST_STATUS_SLACK_MIN_UPDATE_MS,
//      default 4000ms) — comfortably under Slack's ~1/sec chat.update limit
//      even with several ingest runs in flight at once.
//   6. A run whose process died mid-flight (progressService.sweepStaleRuns
//      flips it to status:'failed') gets ONE more touch() from the reaper
//      itself — the next flush renders the now-terminal doc as "interrupted"
//      instead of leaving the Slack message stuck "in progress" forever.
//
// Hook surface: services/progressService.js calls touch(runId, kind) at
// startRun, every stage()/tick()/note(), every terminal write, and from its
// own sweepStaleRuns reaper. That is the ONLY integration point — this
// module never requires progressService itself (no cycle) and reads
// everything else it needs (stage history, counts, brand name, ingest
// method) straight back out of Mongo on its own timer.

const OperationRunModel = () => require('../models/OperationRun');
const BrandModel = () => require('../models/Brand');
// Loaded eagerly (module load time, alongside progressService's own
// require chain at process boot) rather than lazily inside enrichBrand()
// on the first Slack flush — a lazy require here would pull in
// apifyIngestService's own dependency graph (Brand/Media/DetectRun/
// CatalogProduct/apifyPullService/cloudinaryService/...) as a synchronous,
// unpredictable hitch on the shared event loop the first time an ingest
// run's Slack message is rendered, rather than once, predictably, at boot.
let resolveCatalogMethodFn = null;
try {
  ({ resolveCatalogMethod: resolveCatalogMethodFn } = require('./apifyIngestService'));
} catch { /* degrades to the raw stored value in enrichBrand below */ }

// ── config (lazy — so a Render env change or a test can flip these live) ──
const BOT_TOKEN = () => (process.env.SLACK_BOT_TOKEN || '').trim();
const CHANNEL = () => (process.env.SLACK_INGEST_STATUS_CHANNEL || '').trim();

// Master switch. Default ON when the channel is set; set
// INGEST_STATUS_SLACK_ENABLED=false to mute without unsetting the channel.
const ENABLED = () => String(process.env.INGEST_STATUS_SLACK_ENABLED ?? 'true').toLowerCase() !== 'false';

const MIN_UPDATE_MS = () =>
  Math.max(1000, parseInt(process.env.INGEST_STATUS_SLACK_MIN_UPDATE_MS || '4000', 10) || 4000);
const SEND_TIMEOUT_MS = () =>
  Math.max(1000, parseInt(process.env.INGEST_STATUS_SLACK_SEND_TIMEOUT_MS || '8000', 10) || 8000);

const DEFAULT_KINDS = 'demo-sync,catalog-sync,social-ingest,enrichment';
// Memoized on the raw env string: touch() is called from progressService's
// tick()/note() on EVERY progress update across the WHOLE app, including
// hot ad-render paths ('ad-batch', 'veo-video', ...) that are never in the
// watch list — re-parsing+re-allocating a Set on every one of those calls
// would be needless churn on a path this repo is otherwise careful about.
// Re-parses only when the env var value actually changes (env flip in a
// test, or a live Render dashboard edit read on the next call).
let _watchedKindsCache = { raw: undefined, set: null };
const WATCHED_KINDS = () => {
  const raw = process.env.INGEST_STATUS_SLACK_KINDS;
  if (_watchedKindsCache.set && _watchedKindsCache.raw === raw) return _watchedKindsCache.set;
  const src = (raw == null || raw === '') ? DEFAULT_KINDS : raw;
  const set = new Set(
    String(src).split(',').map((s) => s.trim()).filter(Boolean)
  );
  _watchedKindsCache = { raw, set };
  return set;
};

const ENV_LABEL = () => process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'prod';
const ROLE = () => process.env.ALERT_ROLE || (process.env.RENDER_SERVICE_TYPE === 'background_worker' ? 'worker' : 'web');
const os = require('os');
const INSTANCE = () => (process.env.RENDER_INSTANCE_ID || os.hostname() || '?').slice(-8);

const SLACK_MAX = 3900; // leave headroom under Slack's ~4000 text limit

// Hard cap on concurrently tracked runs in this process. Ingest runs are far
// rarer than ad-render runs; this is generous, not a tuned ceiling.
const MAX_TRACKED_RUNS = 40;

// ── in-process state ───────────────────────────────────────────────────────
/** @type {Map<string, TrackedRun>} runId → state */
const tracked = new Map();

let timer = null;
let flushInFlight = false;
let warnedUnconfigured = false;

// Injectable deps for offline tests (no real Mongo / network).
let _OperationRun = null;
let _Brand = null;
let _fetch = null;
let _now = () => Date.now();
let _forceThrow = false;

function OperationRunDep() { return _OperationRun || OperationRunModel(); }
function BrandDep() { return _Brand || BrandModel(); }
function doFetch(url, opts) {
  const f = _fetch || global.fetch;
  return f(url, opts);
}

function isConfigured() {
  return Boolean(ENABLED() && BOT_TOKEN() && CHANNEL());
}

function warnUnconfiguredOnce() {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  try {
    console.warn('🚚 ingestStatusFeed: SLACK_BOT_TOKEN / SLACK_INGEST_STATUS_CHANNEL not set — feed disabled');
  } catch { /* ignore */ }
}

// ── formatting (small inlined trio — same convention as alertService.js /
// runFeedService.js, each of which already inlines its own copy rather than
// sharing a transport module across three call sites) ─────────────────────
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function clip(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}
function redact(text) {
  const token = BOT_TOKEN();
  let s = String(text ?? '');
  if (token && token.length > 4) s = s.split(token).join('<token>');
  return s.replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox<redacted>');
}
function shortId(id) {
  const s = String(id || '');
  return s.length <= 6 ? s : s.slice(-6);
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(r).padStart(2, '0')}`;
  return `${r}s`;
}

function statusIcon(status) {
  if (status === 'succeeded') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'cancelled') return '⊘';
  if (status === 'cancelling') return '⏳';
  return '▶';
}

function countBitFor(note, itemsDone, itemsTotal) {
  if (note) return note;
  if (itemsTotal != null) return `${itemsDone || 0}/${itemsTotal}`;
  if (itemsDone) return `${itemsDone} done`;
  return '';
}

function stageLine(icon, name, note, itemsDone, itemsTotal, durationMs) {
  const countBit = countBitFor(note, itemsDone, itemsTotal);
  const durBit = durationMs != null ? ` (${fmtElapsed(durationMs)})` : '';
  return `${icon} ${esc(name || '?')}${countBit ? ` — ${esc(countBit)}` : ''}${durBit}`;
}

/**
 * Pure — builds the full message text for one OperationRun doc.
 * `st.brandName` / `st.method` are best-effort enrichments (see enrichBrand);
 * both are optional and the render degrades cleanly without them.
 */
function buildStatusText(doc, st = {}) {
  const icon = statusIcon(doc.status);
  const label = doc.label || doc.kind;
  const brandBit = st.brandName
    ? ` · ${esc(st.brandName)}`
    : (doc.brandId ? ` · ${shortId(doc.brandId)}` : '');
  const lines = [`${icon} *Ingest — ${esc(label)}*${brandBit}`];
  if (st.method) lines.push(`Method: *${esc(st.method)}*`);

  const stages = Array.isArray(doc.stages) ? doc.stages : [];
  for (const s of stages) {
    lines.push(`    ${stageLine('✅', s.name, s.note, s.itemsDone, s.itemsTotal, s.durationMs)}`);
  }

  // A stage the doc still names as "current" (doc.stage) that never made
  // it into the closed stages[] history above — either genuinely still in
  // progress, or the stage a process was in when it died and
  // progressService's reaper (sweepStaleRuns) terminal-stamped the run out
  // from under it (that path writes status/endedAt/error directly to
  // Mongo — it never runs through a live handle's closeOpenStagePush(), so
  // the stage it was in is never closed the normal way). Rendering it
  // either way is what turns an interrupted run's summary into "died
  // during X" instead of one that silently stops at the last CLOSED stage
  // with no explanation of what was actually running.
  const isOpen = doc.status === 'running' || doc.status === 'cancelling';
  const lastClosedName = stages.length ? stages[stages.length - 1].name : null;
  const hasOpenStage = !!doc.stage && doc.stage !== lastClosedName;

  if (hasOpenStage && isOpen) {
    const openStartMs = stages.length
      ? new Date(stages[stages.length - 1].endedAt).getTime()
      : new Date(doc.startedAt).getTime();
    const elapsed = _now() - openStartMs;
    lines.push(`    ${stageLine('▶', doc.stage, doc.note, doc.itemsDone, doc.itemsTotal, elapsed)}`);
  } else if (hasOpenStage && !isOpen) {
    const countBit = countBitFor(null, doc.itemsDone, doc.itemsTotal);
    lines.push(`    ⚠ ${esc(doc.stage)} — interrupted${countBit ? ` (${esc(countBit)})` : ''}`);
  } else if (isOpen && !stages.length) {
    lines.push('    starting…');
  }

  const endMs = doc.endedAt ? new Date(doc.endedAt).getTime() : _now();
  const totalMs = endMs - new Date(doc.startedAt).getTime();
  lines.push(`⏱ Total: ${fmtElapsed(totalMs)}`);

  if (doc.status === 'failed' && doc.error) {
    lines.push(`Error: ${esc(clip(doc.error, 300))}`);
  }
  if (doc.status === 'cancelled') {
    lines.push('Cancelled — partial results kept');
  }
  if (doc.meta && typeof doc.meta === 'object' && !Array.isArray(doc.meta)) {
    const bits = Object.entries(doc.meta)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${esc(k)}=${esc(v)}`);
    if (bits.length) lines.push(bits.join(' · '));
  }

  lines.push(`\`${ENV_LABEL()}·${ROLE()}·${INSTANCE()}\``);
  return clip(lines.join('\n'), SLACK_MAX);
}

// ── Slack transport (never throws; never sleeps) ──────────────────────────
async function slackApi(method, body) {
  const token = BOT_TOKEN();
  if (!token) return { ok: false, error: 'no_token' };

  const ctl = new AbortController();
  const timeoutHandle = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS());
  try {
    const res = await doFetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });

    // 429: log Retry-After, drop this flush. NEVER sleep.
    if (res.status === 429) {
      const ra = (res.headers && (res.headers.get?.('retry-after') || res.headers.get?.('Retry-After'))) || '?';
      console.warn(`🚚 ingestStatusFeed: Slack 429 (Retry-After: ${ra}s) — dropping this flush`);
      return { ok: false, error: 'rate_limited', status: 429, retryAfter: ra };
    }

    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (!res.ok) {
      const why = json ? JSON.stringify(json) : `HTTP ${res.status}`;
      console.warn(`🚚 ingestStatusFeed: Slack ${res.status} — ${redact(clip(why, 300))}`);
      return { ok: false, error: 'http_error', status: res.status };
    }

    // CRITICAL: Slack returns HTTP 200 + {ok:false} on logical failure.
    if (!json || json.ok !== true) {
      const errName = (json && json.error) ? String(json.error) : 'unknown (no ok field)';
      console.warn(`🚚 ingestStatusFeed: Slack ok=false — ${redact(clip(errName, 300))}`);
      return { ok: false, error: errName, body: json };
    }
    return { ok: true, body: json };
  } catch (err) {
    const why = err && err.name === 'AbortError'
      ? `timeout after ${SEND_TIMEOUT_MS()}ms`
      : (err && err.message) || String(err);
    console.warn(`🚚 ingestStatusFeed: Slack ${method} failed — ${redact(why)}`);
    return { ok: false, error: why };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── atomic parent-ts claim (same pattern as runFeedService.claimParentTs,
// on OperationRun.slackFeed instead of CampaignRun.slackFeed) ─────────────
async function claimParentTs(runId, channel, ts, OperationRun = OperationRunDep()) {
  const rid = String(runId);
  const ch = String(channel);
  const parentTs = String(ts);

  const writeResult = await OperationRun.updateOne(
    {
      _id: rid,
      $or: [
        { slackFeed: { $exists: false } },
        { slackFeed: null },
        { 'slackFeed.ts': { $exists: false } },
        { 'slackFeed.ts': null },
        { 'slackFeed.ts': '' }
      ]
    },
    { $set: { slackFeed: { ts: parentTs, channel: ch } } }
  );
  const modified = Number(writeResult && (writeResult.modifiedCount ?? writeResult.nModified)) || 0;
  if (modified > 0) return { won: true, ts: parentTs, channel: ch };

  const doc = await OperationRun.findOne({ _id: rid }).select('slackFeed').lean();
  const existing = doc && doc.slackFeed && doc.slackFeed.ts ? String(doc.slackFeed.ts) : null;
  const existingCh = doc && doc.slackFeed && doc.slackFeed.channel ? String(doc.slackFeed.channel) : ch;
  return { won: false, ts: existing, channel: existingCh };
}

// ── brand enrichment (name + resolved ingest method, best-effort, once) ───
// Kinds where "ingest method" is actually meaningful — today that is
// EXACTLY 'demo-sync' (apifyIngestService.syncBrandApify is the only call
// site that resolves/uses Brand.apifyDemo.method at all). Gating on
// shopifyUrl ALONE (an earlier version of this function did) is wrong: a
// demo brand's OWN 'enrichment' or 'social-ingest' run has nothing to do
// with catalog-method selection, but would still show a shopifyUrl on the
// SAME Brand doc — which produced a real, misleading "Method: shopify-
// direct" line on runs that never touched the catalog.
const METHOD_AWARE_KINDS = new Set(['demo-sync']);

async function enrichBrand(st, brandId) {
  st.brandTried = true;
  try {
    const Brand = BrandDep();
    const b = await Brand.findById(brandId).select('name apifyDemo.method apifyDemo.shopifyUrl').lean();
    if (!b) return;
    st.brandName = b.name || null;
    if (!METHOD_AWARE_KINDS.has(st.kind)) return;
    // Only meaningful when a catalog sync actually runs for this brand —
    // resolveCatalogMethod mirrors apifyIngestService.js's own resolution
    // (method:null still runs as 'shopify-direct' whenever shopifyUrl is
    // set) so this never reports a misleading blank for the common case.
    const apifyDemo = b.apifyDemo || {};
    if (apifyDemo.shopifyUrl) {
      st.method = typeof resolveCatalogMethodFn === 'function'
        ? resolveCatalogMethodFn(apifyDemo)
        : (apifyDemo.method || null);
    }
  } catch { /* best-effort — leave brandName/method unset */ }
}

// ── public entry point (the ONLY integration surface progressService uses) ─
/**
 * touch(runId, kind) — mark a run for tracking + schedule a flush.
 * Fire-and-forget, synchronous, never throws. Safe to call on every
 * stage()/tick()/note()/succeed()/fail() — actual Slack I/O only ever
 * happens later, on the detached timer, throttled per run.
 */
function touch(runId, kind) {
  try {
    if (_forceThrow) throw new Error('ingestStatusFeed forced throw');
    if (runId == null || !kind) return;
    if (!isConfigured()) {
      warnUnconfiguredOnce();
      return;
    }
    if (!WATCHED_KINDS().has(String(kind))) return;

    const rid = String(runId);
    if (!tracked.has(rid)) {
      if (tracked.size >= MAX_TRACKED_RUNS) pruneOldest();
      tracked.set(rid, {
        kind: String(kind),
        parentTs: null,
        channel: null,
        lastPostAt: 0,
        finalized: false,
        brandTried: false,
        brandName: null,
        method: null
      });
    }
    ensureTimer();
  } catch (err) {
    try { console.warn(`🚚 ingestStatusFeed.touch: ${err && err.message}`); } catch { /* ignore */ }
  }
}

function pruneOldest() {
  // Finished runs first, then oldest-inserted (Map preserves insertion order).
  for (const [rid, st] of tracked) {
    if (st.finalized) { tracked.delete(rid); return; }
  }
  const oldest = tracked.keys().next().value;
  if (oldest != null) tracked.delete(oldest);
}

function ensureTimer() {
  if (timer) return;
  if (!isConfigured()) return;
  timer = setInterval(() => {
    Promise.resolve().then(() => flushAll()).catch(() => {});
  }, MIN_UPDATE_MS());
  if (typeof timer.unref === 'function') timer.unref();
}

function stopTimerIfIdle() {
  if (!timer) return;
  if (tracked.size > 0) return;
  clearInterval(timer);
  timer = null;
}

async function ensureParent(rid, doc, st) {
  if (st.parentTs) return st.parentTs;

  if (doc.slackFeed && doc.slackFeed.ts) {
    st.parentTs = String(doc.slackFeed.ts);
    st.channel = doc.slackFeed.channel ? String(doc.slackFeed.channel) : CHANNEL();
    return st.parentTs;
  }

  const channel = CHANNEL();
  const text = buildStatusText(doc, st);
  const posted = await slackApi('chat.postMessage', { channel, text });
  if (!posted.ok || !posted.body || !posted.body.ts) return null; // retry next tick

  const newTs = String(posted.body.ts);
  const ch = posted.body.channel ? String(posted.body.channel) : channel;

  const claim = await claimParentTs(rid, ch, newTs);
  if (claim.won) {
    st.parentTs = claim.ts;
    st.channel = claim.channel || ch;
    return st.parentTs;
  }
  if (claim.ts) {
    st.parentTs = claim.ts;
    st.channel = claim.channel || ch;
    slackApi('chat.delete', { channel: ch, ts: newTs }).catch(() => {});
    return st.parentTs;
  }
  slackApi('chat.delete', { channel: ch, ts: newTs }).catch(() => {});
  return null;
}

async function flushOne(rid, st) {
  if (st.finalized) return;

  const now = _now();
  if (now - st.lastPostAt < MIN_UPDATE_MS()) return;

  const OperationRun = OperationRunDep();
  const doc = await OperationRun.findById(rid).lean();
  if (!doc) {
    tracked.delete(rid);
    return;
  }

  if (doc.brandId && !st.brandTried) {
    await enrichBrand(st, doc.brandId);
  }

  const parentTs = await ensureParent(rid, doc, st);
  if (!parentTs) return; // could not create/claim yet — retry next tick

  const channel = st.channel || CHANNEL();
  const text = buildStatusText(doc, st);
  const res = await slackApi('chat.update', { channel, ts: parentTs, text });
  if (res.ok) {
    st.lastPostAt = now;
    const terminal = doc.status !== 'running' && doc.status !== 'cancelling';
    if (terminal) st.finalized = true;
  }
  // On failure: leave lastPostAt/finalized alone so the next tick retries.
}

async function flushAll() {
  if (flushInFlight) return;
  if (!isConfigured()) {
    stopTimerIfIdle();
    return;
  }
  flushInFlight = true;
  try {
    for (const [rid, st] of [...tracked.entries()]) {
      try {
        await flushOne(rid, st);
      } catch (err) {
        try { console.warn(`🚚 ingestStatusFeed.flushOne(${rid}): ${err && err.message}`); } catch { /* ignore */ }
      }
      if (st.finalized) tracked.delete(rid);
    }
    stopTimerIfIdle();
  } finally {
    flushInFlight = false;
  }
}

// ── test seams ──────────────────────────────────────────────────────────
function _resetState() {
  tracked.clear();
  if (timer) { clearInterval(timer); timer = null; }
  flushInFlight = false;
  warnedUnconfigured = false;
  _forceThrow = false;
  _OperationRun = null;
  _Brand = null;
  _fetch = null;
  _now = () => Date.now();
}

function _setDeps(deps = {}) {
  if ('OperationRun' in deps) _OperationRun = deps.OperationRun;
  if ('Brand' in deps) _Brand = deps.Brand;
  if ('fetch' in deps) _fetch = deps.fetch;
  if ('now' in deps) _now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  if ('forceThrow' in deps) _forceThrow = !!deps.forceThrow;
}

function _getTracked(runId) {
  return tracked.get(String(runId)) || null;
}

function _trackedCount() {
  return tracked.size;
}

/** Force one flush cycle (tests). Still never throws to the caller. */
async function _flushOnce() {
  try {
    await flushAll();
  } catch {
    // absolute backstop
  }
}

module.exports = {
  touch,
  isConfigured,
  // pure helpers (tests + potential reuse)
  buildStatusText,
  claimParentTs,
  fmtElapsed,
  statusIcon,
  // test seams
  _resetState,
  _setDeps,
  _getTracked,
  _trackedCount,
  _flushOnce,
  _MAX_TRACKED_RUNS: MAX_TRACKED_RUNS,
  _DEFAULT_KINDS: DEFAULT_KINDS
};
