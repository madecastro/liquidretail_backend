'use strict';
//
// runFeedService — per-CampaignRun Slack live feed.
//
// One parent message per run (chat.update'd on a throttle = the live status
// screen). A thread under it carries the FULL chronological event log, batched
// so a burst of stage transitions becomes one threaded post.
//
// Channel: SLACK_ALERT_CHANNEL_STATUS (committed in config/defaults.env).
//
// ── SAFETY CONTRACT (acceptance criterion — this sits on paid paths) ──────
//   1. Never awaited on a render path. Every export is fire-and-forget.
//   2. Never throws. Absolute try/catch backstop on every entry point.
//   3. BOUNDED memory. Fixed-size ring buffer per run; when full, DROP
//      OLDEST and count the drops. Surface "(N events dropped)" on the next
//      post so the log is honest about being lossy. Never buffer unboundedly,
//      never block a producer.
//   4. Never sleep on a render path. HTTP 429 → log Retry-After, drop that
//      flush. Same rule alertService already follows.
//   5. Completely inert when SLACK_ALERT_CHANNEL_STATUS or SLACK_BOT_TOKEN
//      is unset — no fetch, no timer, one warn per process at most.
//   6. All Slack I/O happens on a DETACHED interval, never inside a caller's
//      stack.
//
// Multi-instance: parent message ts is claimed atomically on CampaignRun
// (slackFeed: { ts, channel }). Conditional updateOne only sets when unset;
// the winner creates the parent, everyone else threads under the winner's ts.
// A lost claim must NOT create a second parent.
//
// Hook surface: services/adStage.js (every stage write) + runRenderLoop
// start/finish in routes/ads.js. Poll ticks
// ("… — polling 20s (7)") are filtered structurally from the thread log;
// they still refresh the parent's "now:" line.

const os = require('os');
const { stageBase, formatElapsed } = require('./adStage');
// Pure message builders — no Mongo/network at require-time (see that
// module's header). buildRunStartLine feeds the uncap context line;
// finishRun's extra completion-summary lines are built by the CALLER
// (routes/ads.js) via buildRunCompletionSummaryLines and simply rendered
// here, since only the caller has the claimed ads' final kind/outcome mix.
const { buildRunStartLine } = require('./slackRunVerbosity');

// ── config (lazy, so tests can flip env between cases) ────────────────────
const BOT_TOKEN = () => (process.env.SLACK_BOT_TOKEN || '').trim();
const CHANNEL   = () => (process.env.SLACK_ALERT_CHANNEL_STATUS || '').trim();

// Master switch. Default ON when the channel is set; set RUN_FEED_ENABLED=false
// to mute without unsetting the channel.
const ENABLED = () => String(process.env.RUN_FEED_ENABLED ?? 'true').toLowerCase() !== 'false';

const PARENT_THROTTLE_MS = () =>
  Math.max(1000, parseInt(process.env.RUN_FEED_PARENT_THROTTLE_MS || '10000', 10) || 10000);
const THREAD_FLUSH_MS = () =>
  Math.max(250, parseInt(process.env.RUN_FEED_THREAD_FLUSH_MS || '2000', 10) || 2000);
const RING_SIZE = () =>
  Math.max(1, parseInt(process.env.RUN_FEED_RING_SIZE || '200', 10) || 200);
const SEND_TIMEOUT_MS = () =>
  Math.max(1000, parseInt(process.env.RUN_FEED_SEND_TIMEOUT_MS || '8000', 10) || 8000);

// Hard cap on concurrently tracked runs in this process (finished runs are
// pruned first). Prevents a long-lived web instance from retaining forever.
const MAX_TRACKED_RUNS = 40;

const ENV_LABEL = () => process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'prod';
const ROLE      = () => process.env.ALERT_ROLE || (process.env.RENDER_SERVICE_TYPE === 'background_worker' ? 'worker' : 'web');
const INSTANCE  = () => (process.env.RENDER_INSTANCE_ID || os.hostname() || '?').slice(-8);

const SLACK_MAX = 3900; // leave headroom under Slack's ~4000 text limit

// ── poll-tick filter (structural — no caller flag) ────────────────────────
// Matches adStage.stageBase's suffix: " — polling 20s (7)" / " — polling 4m10s (17)".
// These are the same stage advancing, not new events. Parent still sees them
// via lastStageByAd; the thread log must not.
const POLL_TICK_RE = /\s*—\s*polling\s+\S+\s*\(\d+\)\s*$/i;

function isPollTick(stage) {
  return POLL_TICK_RE.test(String(stage || ''));
}

// ── ring buffer ───────────────────────────────────────────────────────────
// Fixed capacity. push() never blocks, never grows past capacity. When full,
// the oldest item is dropped and dropCount increments. drain() hands the
// consumer both the items and the accumulated drop count so the next post
// can honestly report "(N events dropped)".
class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.items = [];
    this.dropCount = 0;
  }
  get size() { return this.items.length; }
  push(item) {
    if (this.items.length >= this.capacity) {
      this.items.shift();
      this.dropCount++;
    }
    this.items.push(item);
  }
  /** Drain pending items + reset drop counter. Returns { items, dropped }. */
  drain() {
    const items = this.items;
    const dropped = this.dropCount;
    this.items = [];
    this.dropCount = 0;
    return { items, dropped };
  }
}

// ── in-process state ──────────────────────────────────────────────────────
/** @type {Map<string, RunState>} runId → state */
const runs = new Map();
/** adId → runId (so adStage can route without a Mongo round-trip) */
const adToRun = new Map();
/** adId → { template, aspectRatio, mediaId, platformFormat } */
const adMeta = new Map();

let timer = null;
let timerIntervalMs = 0;
let warnedUnconfigured = false;
let flushInFlight = false;

// Injectable deps for offline tests (no real Mongo / network).
let _CampaignRun = null;
let _Ad = null;
let _User = null;
let _fetch = null;
let _now = () => Date.now();
// Test seam: force an internal throw from entry points under the try/catch.
let _forceThrow = false;

function CampaignRunModel() {
  if (_CampaignRun) return _CampaignRun;
  // Lazy require — keeps module load free of mongoose side-effects for pure tests.
  // eslint-disable-next-line global-require
  return require('../models/CampaignRun');
}
function AdModel() {
  if (_Ad) return _Ad;
  // eslint-disable-next-line global-require
  return require('../models/Ad');
}
function UserModel() {
  if (_User) return _User;
  // Lazy require — same reason as CampaignRun/Ad. Optional _setDeps({ User })
  // seam; prod falls through to the guarded require.
  // eslint-disable-next-line global-require
  return require('../models/User');
}
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
    console.warn('📡 runFeed: SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL_STATUS not set — feed disabled');
  } catch { /* ignore */ }
}

// ── formatting ────────────────────────────────────────────────────────────
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
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox<redacted>');
  return s;
}

function hhmmss(ms) {
  try {
    return new Date(ms).toISOString().slice(11, 19);
  } catch {
    return '??:??:??';
  }
}

function shortId(id) {
  const s = String(id || '');
  return s.length <= 6 ? s : s.slice(-6);
}

function iconFor(stage) {
  const s = String(stage || '').toLowerCase();
  if (/^failed\b|fail|error/.test(s)) return '✗';
  if (/^done\b|shipping master/.test(s)) return '✔';
  if (/upload/.test(s)) return '☁';
  if (/submit/.test(s)) return '⬆';
  if (/titling|title/.test(s)) return '✎';
  if (/crop|logo|composite/.test(s)) return '✂';
  if (/skip|archived/.test(s)) return '⊘';
  if (/stall/.test(s)) return '⏱';
  if (/ready|download|mirror|plate generation(?!.*polling)/.test(s)) return '✓';
  if (/start|generat|render|static image|master video|preparing|deriving|fetching|building|reference|reusing/.test(s)) {
    return '▶';
  }
  return '•';
}

/**
 * One thread-log line.
 * e.g. "03:00:44  ▶ static image generation (meta_feed_1_1)  ai_brand_led/1:1  media=…7686"
 */
function formatThreadLine(ev) {
  const t = hhmmss(ev.t);
  const icon = iconFor(ev.stage);
  const base = stageBase(ev.stage) || ev.stage || '?';
  const meta = ev.meta || {};
  const bits = [`${t}  ${icon} ${base}`];
  if (meta.template || meta.aspectRatio) {
    bits.push(`${meta.template || '?'}/${meta.aspectRatio || '?'}`);
  }
  if (meta.mediaId) bits.push(`media=…${shortId(meta.mediaId)}`);
  if (ev.adId) bits.push(`ad=…${shortId(ev.adId)}`);
  // Vision QC meta — only when present (noteQcPass/FailToRunFeed).
  if (meta.attempt != null && meta.attempt !== '') bits.push(`attempt=${meta.attempt}`);
  if (meta.summary) bits.push(String(meta.summary).slice(0, 120));
  // Optional preview URL (e.g. Cloudinary render, app deep link). Only when
  // present so every existing caller of noteEvent/onStage is unchanged.
  if (meta.previewUrl) bits.push(String(meta.previewUrl));
  const line = bits.join('  ');
  // Full vision-QC detail block (adVisionQcService.buildQcSlackDetail) —
  // verdict, per-category scores + findings, attempt trail/preview. Only
  // noteQcPassToRunFeed/noteQcFailToRunFeed set this, so every other
  // existing caller of noteEvent/onStage renders byte-identical to before.
  // Owner request 2026-08-19: passes must be as visible as failures, not
  // just a truncated summary — see noteQcPassToRunFeed's docstring for why
  // this goes through the thread (unmetered) rather than alertQcAccepted
  // (dead in prod — would exhaust ALERT_RATE_LIMIT_MAX at real ad volume).
  if (meta.qcDetail) return `${line}\n${meta.qcDetail}`;
  return line;
}

function buildParentText(state, live) {
  const rid = String(state.runId || '');
  const shortRun = rid.length > 10 ? `${rid.slice(0, 8)}…` : rid;
  const brand = state.brandName || state.brandId || 'brand';
  const product = state.productLabel || null;
  const total = live?.total ?? state.total ?? 0;
  // Requester is user-controlled (Google displayName). Brand is interpolated
  // raw today — do not change that. Omit the whole " · by …" atom when neither
  // label nor id is known so the head stays byte-identical to the pre-change
  // format (no dangling separator, no "unknown").
  const byRaw = state.requesterLabel || (state.requestedBy ? shortId(state.requestedBy) : null);
  const byBit = byRaw ? ` · by ${esc(byRaw)}` : '';
  const head = product
    ? `▸ ${shortRun} · ${brand} · ${product} · ${total} ads${byBit}`
    : `▸ ${shortRun} · ${brand} · ${total} ads${byBit}`;

  const counts = live?.counts || state.counts || {};
  const parts = [];
  for (const k of ['draft', 'rendering', 'queued', 'failed', 'live', 'archived', 'succeeded', 'skipped']) {
    const n = Number(counts[k]) || 0;
    if (n <= 0) continue;
    // RETROFITTED 2026-08-31 (services/adPhase.js parity pass — that file's
    // own header names this "N draft" line as one of three independent
    // "what state is this ad in" derivations: a video ad sits raw
    // status:'draft' from the instant its paid master lands through the
    // ENTIRE titling pass (services/adTitlingTruth.js), so this count used
    // to read as "N delivered" even when some of those N were still
    // mid-flight — the exact 29/39-vs-16/39 undercount that motivated
    // adTitlingTruth.js in the first place, just re-surfacing here in
    // Slack's own count line instead of the run-finalization path.
    // `live.titlingIncomplete` is produced by THE canonical
    // services/campaignRunGuards.js classifyRunAdOutcome (itself now
    // retrofitted onto deriveAdPhase — see that function's header) over
    // this same ad set, so this reuses one shared answer rather than a
    // second re-derivation. Only the 'draft' bucket is annotated: a
    // titling-incomplete ad's raw status is draft/live/archived in
    // principle, but in production a video ad is never pushed 'live' or
    // 'archived' before its titling settles (see adTitlingTruth.js's own
    // header on when renderUrl===veoVideoUrl persists), so attributing the
    // whole count to 'draft' matches every real case without needing to
    // split live.titlingIncomplete across buckets it cannot itself name.
    if (k === 'draft' && live?.titlingIncomplete > 0) {
      parts.push(`${n} draft (${live.titlingIncomplete} still titling)`);
    } else {
      parts.push(`${n} ${k}`);
    }
  }
  // Prefer CampaignRun counters when Ad aggregation is empty (early run).
  if (!parts.length && live?.runCounters) {
    const rc = live.runCounters;
    if (rc.succeeded) parts.push(`${rc.succeeded} succeeded`);
    if (rc.failed) parts.push(`${rc.failed} failed`);
    if (rc.skipped) parts.push(`${rc.skipped} skipped`);
    const remaining = Math.max(0, (rc.total || total) - (rc.succeeded || 0) - (rc.failed || 0) - (rc.skipped || 0));
    if (remaining > 0 && state.status !== 'done') parts.push(`${remaining} in flight`);
  }
  const elapsedMs = Math.max(0, (live?.now || _now()) - (state.startedAt || _now()));
  const countLine = `${parts.join(' · ') || 'starting…'} · ${formatElapsed(elapsedMs)}`;

  // "now:" — collapse identical stages with xN
  const stageMap = live?.stages || state.lastStageByAd;
  const stageCounts = new Map();
  if (stageMap && typeof stageMap.forEach === 'function') {
    stageMap.forEach((st) => {
      const b = stageBase(st) || st;
      if (!b) return;
      stageCounts.set(b, (stageCounts.get(b) || 0) + 1);
    });
  } else if (stageMap && typeof stageMap === 'object') {
    for (const st of Object.values(stageMap)) {
      const b = stageBase(st) || st;
      if (!b) continue;
      stageCounts.set(b, (stageCounts.get(b) || 0) + 1);
    }
  }
  let nowLine = '';
  if (stageCounts.size) {
    const bits = [...stageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([s, n]) => (n > 1 ? `${s} x${n}` : s));
    nowLine = `now: ${bits.join(', ')}`;
  } else if (state.finished) {
    nowLine = state.cancelled ? 'stopped' : 'finished';
  }

  const foot = `\`${ENV_LABEL()}·${ROLE()}·${INSTANCE()}\``;
  const lines = [head, `    ${countLine}`];
  if (nowLine) lines.push(`    ${nowLine}`);
  if (state.finished && state.finishSummary) lines.push(`    ${state.finishSummary}`);
  // Per-kind completion summary (minted-vs-claimed gap / static+video
  // delivered-failed breakdown / reconciled-or-est. spend) — see finishRun.
  // Placed before finishReasons: this is the WHAT (counts by kind), the
  // reasons below are the WHY (grouped failure causes).
  if (state.finished && Array.isArray(state.finishExtraLines)) {
    for (const l of state.finishExtraLines) lines.push(`    ${l}`);
  }
  // One line per DISTINCT reason, most common first. Grouped because a
  // 20-ad run that fails identically 20 times is one fact, not twenty.
  if (state.finished && Array.isArray(state.finishReasons)) {
    for (const r of state.finishReasons) lines.push(`    ${r.count}✗ ${r.reason}`);
  }
  lines.push(foot);
  return clip(lines.join('\n'), SLACK_MAX);
}

// ── Slack transport (never throws; never sleeps) ──────────────────────────
async function slackApi(method, body) {
  const token = BOT_TOKEN();
  if (!token) return { ok: false, error: 'no_token' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS());
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
      console.warn(`📡 runFeed: Slack 429 (Retry-After: ${ra}s) — dropping this flush`);
      return { ok: false, error: 'rate_limited', status: 429, retryAfter: ra };
    }

    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (!res.ok) {
      const why = json ? JSON.stringify(json) : `HTTP ${res.status}`;
      console.warn(`📡 runFeed: Slack ${res.status} — ${redact(clip(why, 300))}`);
      return { ok: false, error: 'http_error', status: res.status };
    }

    // CRITICAL: Slack returns HTTP 200 + {ok:false} on logical failure.
    if (!json || json.ok !== true) {
      const errName = (json && json.error) ? String(json.error) : 'unknown (no ok field)';
      console.warn(`📡 runFeed: Slack ok=false — ${redact(clip(errName, 300))}`);
      return { ok: false, error: errName, body: json };
    }
    return { ok: true, body: json };
  } catch (err) {
    const why = err && err.name === 'AbortError'
      ? `timeout after ${SEND_TIMEOUT_MS()}ms`
      : (err && err.message) || String(err);
    console.warn(`📡 runFeed: Slack ${method} failed — ${redact(why)}`);
    return { ok: false, error: why };
  } finally {
    clearTimeout(timer);
  }
}

// ── atomic parent-ts claim ────────────────────────────────────────────────
/**
 * Claim parent message ts for a run. Only the winner's updateOne matches
 * (filter requires slackFeed.ts unset). Losers re-read the winner's ts.
 *
 * Mirrors claimAdsForRun: conditional write, then re-read ownership.
 *
 * @returns {Promise<{ won: boolean, ts: string|null, channel: string|null }>}
 */
async function claimParentTs(runId, channel, ts, CampaignRun = CampaignRunModel()) {
  const rid = String(runId);
  const ch = String(channel);
  const parentTs = String(ts);

  // Conditional set: only when slackFeed.ts is missing/null.
  // $or covers docs that never had slackFeed and docs with an empty shell.
  const writeResult = await CampaignRun.updateOne(
    {
      runId: rid,
      $or: [
        { slackFeed: { $exists: false } },
        { 'slackFeed.ts': { $exists: false } },
        { 'slackFeed.ts': null },
        { 'slackFeed.ts': '' }
      ]
    },
    { $set: { slackFeed: { ts: parentTs, channel: ch } } }
  );
  const modified = Number(writeResult && (writeResult.modifiedCount ?? writeResult.nModified)) || 0;

  if (modified > 0) {
    return { won: true, ts: parentTs, channel: ch };
  }

  // Lost the race (or already claimed). Re-read the winner.
  const doc = await CampaignRun.findOne({ runId: rid }).select('slackFeed').lean();
  const existing = doc && doc.slackFeed && doc.slackFeed.ts
    ? String(doc.slackFeed.ts)
    : null;
  const existingCh = doc && doc.slackFeed && doc.slackFeed.channel
    ? String(doc.slackFeed.channel)
    : ch;
  return { won: false, ts: existing, channel: existingCh };
}

/** Read already-claimed parent ts (no write). */
async function readParentTs(runId, CampaignRun = CampaignRunModel()) {
  const doc = await CampaignRun.findOne({ runId: String(runId) }).select('slackFeed').lean();
  if (!doc || !doc.slackFeed || !doc.slackFeed.ts) return null;
  return {
    ts: String(doc.slackFeed.ts),
    channel: doc.slackFeed.channel ? String(doc.slackFeed.channel) : CHANNEL()
  };
}

// ── run state ─────────────────────────────────────────────────────────────
/**
 * @typedef {object} RunState
 * @property {string} runId
 * @property {string|null} brandId
 * @property {string|null} brandName
 * @property {string|null} productLabel
 * @property {number} total
 * @property {number} startedAt
 * @property {string|null} parentTs
 * @property {string|null} channel
 * @property {boolean} claimInFlight
 * @property {boolean} parentCreateInFlight
 * @property {RingBuffer} ring
 * @property {Map<string,string>} lastStageByAd
 * @property {object} counts
 * @property {boolean} finished
 * @property {boolean} cancelled
 * @property {string|null} finishSummary
 * @property {number} lastParentAt
 * @property {boolean} parentDirty
 * @property {boolean} needsParent
 */

function makeRunState(opts) {
  return {
    runId: String(opts.runId),
    brandId: opts.brandId ? String(opts.brandId) : null,
    brandName: opts.brandName || null,
    productLabel: opts.productLabel || null,
    requestedBy: opts.requestedBy ? String(opts.requestedBy) : null,
    requesterLabel: opts.requesterLabel || null,
    requesterLookupDone: false,
    total: Number(opts.total) || 0,
    startedAt: _now(),
    parentTs: null,
    channel: CHANNEL(),
    claimInFlight: false,
    parentCreateInFlight: false,
    ring: new RingBuffer(RING_SIZE()),
    lastStageByAd: new Map(),
    counts: {},
    finished: false,
    cancelled: false,
    finishSummary: null,
    lastParentAt: 0,
    parentDirty: true,
    needsParent: true
  };
}

function pruneRuns() {
  if (runs.size <= MAX_TRACKED_RUNS) return;
  // Drop finished runs first (oldest startedAt).
  const finished = [...runs.entries()]
    .filter(([, s]) => s.finished)
    .sort((a, b) => a[1].startedAt - b[1].startedAt);
  for (const [rid, st] of finished) {
    if (runs.size <= MAX_TRACKED_RUNS) break;
    // Unmap ads for this run.
    for (const [adId, r] of adToRun) {
      if (r === rid) {
        adToRun.delete(adId);
        adMeta.delete(adId);
      }
    }
    runs.delete(rid);
    void st;
  }
  // If still over (all active), drop oldest by startedAt — lossy by design.
  if (runs.size > MAX_TRACKED_RUNS) {
    const ordered = [...runs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    while (runs.size > MAX_TRACKED_RUNS && ordered.length) {
      const [rid] = ordered.shift();
      for (const [adId, r] of adToRun) {
        if (r === rid) {
          adToRun.delete(adId);
          adMeta.delete(adId);
        }
      }
      runs.delete(rid);
    }
  }
}

function ensureTimer() {
  if (!isConfigured()) return;
  const ms = THREAD_FLUSH_MS();
  if (timer && timerIntervalMs === ms) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  timerIntervalMs = ms;
  timer = setInterval(() => {
    // Detached — never part of a caller's stack. unref so this timer alone
    // cannot keep a shutting-down process alive.
    Promise.resolve()
      .then(() => flushAll())
      .catch(() => {});
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopTimerIfIdle() {
  if (!timer) return;
  let anyActive = false;
  for (const st of runs.values()) {
    if (!st.finished || st.ring.size > 0 || st.parentDirty || st.needsParent) {
      anyActive = true;
      break;
    }
  }
  if (!anyActive) {
    clearInterval(timer);
    timer = null;
    timerIntervalMs = 0;
  }
}

// ── public entry points (never throw, never await by callers) ─────────────

/**
 * Register a CampaignRun for live feed updates. Fire-and-forget.
 * Call at runRenderLoop start (after claim).
 */
function startRun(opts = {}) {
  try {
    if (_forceThrow) throw new Error('runFeed forced throw');
    if (!opts || !opts.runId) return;
    if (!isConfigured()) {
      warnUnconfiguredOnce();
      return;
    }
    const rid = String(opts.runId);
    let st = runs.get(rid);
    if (!st) {
      st = makeRunState(opts);
      runs.set(rid, st);
    } else {
      // Re-entry (second pool / retry): refresh totals, keep parentTs.
      if (opts.total != null) st.total = Number(opts.total) || st.total;
      if (opts.brandName) st.brandName = opts.brandName;
      if (opts.productLabel) st.productLabel = opts.productLabel;
      if (opts.requestedBy && String(opts.requestedBy) !== st.requestedBy) {
        st.requestedBy = String(opts.requestedBy);
        st.requesterLookupDone = false;   // new requester → allow one fresh lookup
      }
      if (opts.requesterLabel) st.requesterLabel = opts.requesterLabel;
      st.finished = false;
      st.parentDirty = true;
    }
    const adIds = Array.isArray(opts.adIds) ? opts.adIds : [];
    for (const raw of adIds) {
      const id = String(raw);
      adToRun.set(id, rid);
    }
    // Optional preloaded meta: [{ _id, template, aspectRatio, mediaId, ... }]
    if (Array.isArray(opts.adDocs)) {
      for (const d of opts.adDocs) {
        if (!d || d._id == null) continue;
        const id = String(d._id);
        adToRun.set(id, rid);
        adMeta.set(id, {
          template: d.template || null,
          aspectRatio: d.aspectRatio || null,
          mediaId: d.mediaId ? String(d.mediaId) : null,
          platformFormat: d.platformFormat || null
        });
      }
    } else if (adIds.length) {
      // Fire-and-forget meta enrich — never on the caller's critical path.
      // Failures leave events without template/media suffixes; acceptable.
      Promise.resolve()
        .then(async () => {
          try {
            const docs = await AdModel()
              .find({ _id: { $in: adIds } })
              .select('template aspectRatio mediaId platformFormat')
              .lean();
            for (const d of docs || []) {
              if (!d || d._id == null) continue;
              adMeta.set(String(d._id), {
                template: d.template || null,
                aspectRatio: d.aspectRatio || null,
                mediaId: d.mediaId ? String(d.mediaId) : null,
                platformFormat: d.platformFormat || null
              });
            }
          } catch { /* ignore */ }
        })
        .catch(() => {});
    }
    // Lifecycle event into the ring (not a poll tick). Below the old
    // MAX_CREATIVES_PER_RUN cap of 20 this is byte-identical to the
    // historical text; above it, buildRunStartLine appends the uncap
    // marker + static/video mix so a big uncapped batch is visible in the
    // thread (CLAUDE.md §2 — MAX_CREATIVES_PER_RUN is 1000, effectively
    // uncapped, since 2026-08-18).
    st.ring.push({
      t: _now(),
      // requesterLabel goes THROUGH buildRunStartLine rather than being appended
      // here: verifySlackRunVerbosity G18 asserts this call stays
      // `stage: buildRunStartLine(...)` so the line has exactly one builder.
      // Named only when the caller already resolved a label — never a Mongo
      // read on this path.
      stage: buildRunStartLine({
        total: st.total,
        staticCount: opts.staticCount,
        veoCount: opts.veoCount,
        requesterLabel: opts.requesterLabel
      }),
      adId: null,
      meta: {}
    });
    st.parentDirty = true;
    st.needsParent = true;
    pruneRuns();
    ensureTimer();
  } catch (err) {
    try { console.warn(`📡 runFeed.startRun: ${err && err.message}`); } catch { /* ignore */ }
  }
}

/**
 * Mark a run finished. Fire-and-forget. Final parent update + last thread
 * flush happen on the next interval tick.
 */
function finishRun(opts = {}) {
  try {
    if (_forceThrow) throw new Error('runFeed forced throw');
    if (!opts || !opts.runId) return;
    if (!isConfigured()) {
      warnUnconfiguredOnce();
      return;
    }
    const rid = String(opts.runId);
    let st = runs.get(rid);
    if (!st) {
      // Finish without start (edge): still emit a one-shot summary if configured.
      st = makeRunState(opts);
      runs.set(rid, st);
    }
    st.finished = true;
    st.cancelled = !!opts.cancelled;
    const ok = Number(opts.succeeded) || 0;
    const fail = Number(opts.failed) || 0;
    const skip = Number(opts.skipped) || 0;
    const ms = Number(opts.totalMs) || 0;
    st.finishSummary = st.cancelled
      ? `stopped — ${ok}✓ / ${fail}✗ / ${skip}⊘ · ${formatElapsed(ms)}`
      : `finished — ${ok}✓ / ${fail}✗ / ${skip}⊘ · ${formatElapsed(ms)}`;
    // Per-kind completion summary (minted-vs-claimed gap, static/video
    // delivered/failed breakdown, reconciled-or-est. spend) — built by the
    // CALLER via slackVerbosity.buildRunCompletionSummaryLines and just
    // rendered here. Capped defensively; this module never trusts a
    // caller's array length.
    st.finishExtraLines = Array.isArray(opts.summaryLines)
      ? opts.summaryLines.filter((l) => typeof l === 'string' && l).slice(0, 6)
      : null;
    // WHY a run failed, not just how many. Until 2026-08-05 this summary said
    // "10✓ / 2✗" and nothing else, so the only way to learn that two ads were
    // rejected for CONTENT POLICY — deterministic, and never going to succeed on
    // a retry — was to ask someone to read the database. Owner did exactly that.
    // Fire-and-forget like everything else here: a reporting query must never
    // affect a run, so it is awaited only inside its own try and any failure
    // leaves the count-only summary intact.
    // DETACHED, not awaited: finishRun is sync for every caller, and this module's
    // whole contract is that it never sits on a render path. The lookup resolves a
    // moment later, sets the reasons and re-flags the parent dirty, and the
    // existing flush timer repaints the message. If it fails, the count-only
    // summary stands — a reporting query must never degrade a run.
    if (fail > 0) {
      summariseFailures(rid)
        .then((reasons) => {
          if (!reasons || !reasons.length) return;
          st.finishReasons = reasons;
          st.parentDirty = true;
          ensureTimer();
        })
        .catch((err) => {
          try { console.warn(`📡 runFeed: failure-reason lookup failed — ${err && err.message}`); } catch { /* ignore */ }
        });
    }
    st.ring.push({
      t: _now(),
      stage: st.cancelled
        ? `run stopped — ${ok}✓ ${fail}✗ ${skip}⊘`
        : `run finished — ${ok}✓ ${fail}✗ ${skip}⊘ · ${formatElapsed(ms)}`,
      adId: null,
      meta: {}
    });
    st.parentDirty = true;
    ensureTimer();
  } catch (err) {
    try { console.warn(`📡 runFeed.finishRun: ${err && err.message}`); } catch { /* ignore */ }
  }
}

/**
 * Group this run's failures into distinct, human-readable reasons.
 *
 * Reads Ad.renderError.message, which now LEADS with the operator-facing label
 * (atlasImageService/atlasVideoService both use `policy.label` first), so the
 * head of the string is already the useful part — "Model Moderation Error",
 * "Atlas image insufficientBalance", and so on.
 *
 * Deliberately truncates at the first ` (`, ` [` or `:` AFTER the label: the tail
 * is prediction ids and provider JSON, which is what the Render Activity board is
 * for. Slack gets the headline.
 *
 * RETROFITTED 2026-08-31 (services/adPhase.js parity pass — that file's own
 * header names this function as one of three independent "what state is
 * this ad in" derivations it exists to unify). The detailed reason text
 * above is UNCHANGED (owner requirement 2026-08-05: "10✓ / 2✗" alone was not
 * actionable, the specific cause is what matters) — this only adds the SAME
 * canonical `describeAdFailure` label routes/ads.js's per-ad `failure.isQc`
 * badge uses (owner requirement 2026-08-26: "for QC failures it should
 * specifically be noted as a QC Fail, not just Failed"). Only QC failures
 * get the prefix: every other stage's message already names itself (e.g.
 * "Model Moderation Error…") and prefixing a generic "Render Failed" on top
 * would just be noise on every non-QC line. QC is the one category whose
 * raw message text happens to say "vision QC" today at both call sites
 * (services/brandScriptExecutor.js, services/adVisionQcService.js) but
 * nothing enforces that staying true for a future one — describeAdFailure
 * is the structural signal, not a substring match on prose.
 */
async function summariseFailures(runId) {
  // AdModel() (not a direct require('../models/Ad')) — the same injectable
  // seam loadLiveSnapshot already uses, so an offline harness can drive this
  // with _setDeps({ Ad: fakeAd }) instead of monkeypatching module
  // resolution. Behaviourally identical in production (AdModel() falls
  // through to the same require when _Ad is unset).
  const Ad = AdModel();
  const { deriveAdPhase, describeAdFailure } = require('./adPhase');
  const rows = await Ad.find({ campaignRunIds: runId, status: 'failed' })
    .select('renderError.message renderError.chargeState renderError.stage renderUrl visionQc')
    .limit(50)
    .lean();
  const counts = new Map();
  for (const r of rows) {
    const raw = String(r?.renderError?.message || 'unknown failure')
      .replace(/^direct-image render failed:\s*/i, '')
      .replace(/^master rendered;\s*/i, '');
    // Keep the label plus its immediate cause, drop ids/JSON/policy prose.
    const m = raw.match(/^([^([]{0,80}?)(?:\s*[([]|$)/);
    let detail = (m ? m[1] : raw).trim();
    if (detail.length > 90) detail = `${detail.slice(0, 87)}…`;
    // Fields selected above are exactly what deriveAdPhase/describeAdFailure
    // need for a status:'failed' ad (see adPhase.js's own doc comment) — the
    // phase is always 'failed-terminal' or 'qc-failed-kept' here since the
    // query itself filters on status:'failed'.
    const ad = { status: 'failed', renderUrl: r.renderUrl, visionQc: r.visionQc, renderError: r.renderError };
    const phase = deriveAdPhase(ad);
    const failure = describeAdFailure(ad, phase);
    const reason = (failure && failure.isQc && !/qc/i.test(detail))
      ? `QC Fail — ${detail}`
      : detail;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);   // a run with 5+ distinct causes is a story for the board
}

/**
 * Record a stage transition for an ad. Called from adStage (choke point).
 * Fire-and-forget. Poll ticks update the parent "now:" view only — they do
 * NOT enter the thread ring buffer.
 */
function onStage(adId, stage) {
  try {
    if (_forceThrow) throw new Error('runFeed forced throw');
    if (adId == null || stage == null || stage === '') return;
    if (!isConfigured()) return; // silent when unconfigured (startRun already warned)

    const id = String(adId);
    const text = String(stage);
    const rid = adToRun.get(id);
    if (!rid) return; // not part of a tracked run in this process

    const st = runs.get(rid);
    if (!st) return;

    // Parent "now:" always wants the latest stage, including poll progress.
    st.lastStageByAd.set(id, text);
    st.parentDirty = true;

    // Thread log: exclude poll ticks structurally.
    if (isPollTick(text)) return;

    const meta = adMeta.get(id) || {};
    st.ring.push({
      t: _now(),
      stage: text,
      adId: id,
      meta
    });
    ensureTimer();
  } catch (err) {
    try { console.warn(`📡 runFeed.onStage: ${err && err.message}`); } catch { /* ignore */ }
  }
}

/**
 * Optional direct event (run-level, not from adStage). Fire-and-forget.
 */
function noteEvent(runId, stage, meta = {}) {
  try {
    if (_forceThrow) throw new Error('runFeed forced throw');
    if (!runId || stage == null || stage === '') return;
    if (!isConfigured()) return;
    if (isPollTick(stage)) return;
    const rid = String(runId);
    const st = runs.get(rid);
    if (!st) return;
    st.ring.push({
      t: _now(),
      stage: String(stage),
      adId: meta.adId ? String(meta.adId) : null,
      meta: meta || {}
    });
    st.parentDirty = true;
    ensureTimer();
  } catch (err) {
    try { console.warn(`📡 runFeed.noteEvent: ${err && err.message}`); } catch { /* ignore */ }
  }
}

// ── detached flush ────────────────────────────────────────────────────────

async function ensureParent(st) {
  if (st.parentTs) return st.parentTs;
  if (st.claimInFlight || st.parentCreateInFlight) return null;
  if (!isConfigured()) return null;

  st.claimInFlight = true;
  try {
    // 1. Already claimed by another instance?
    const existing = await readParentTs(st.runId);
    if (existing && existing.ts) {
      st.parentTs = existing.ts;
      st.channel = existing.channel || st.channel;
      st.needsParent = false;
      return st.parentTs;
    }

    // 2. Create parent message, then claim its ts.
    st.parentCreateInFlight = true;
    const channel = CHANNEL();
    const text = buildParentText(st, { now: _now() });
    const posted = await slackApi('chat.postMessage', {
      channel,
      text,
      // mrkdwn default
    });
    st.parentCreateInFlight = false;

    if (!posted.ok || !posted.body || !posted.body.ts) {
      // Failed to create — try again next tick. Do NOT claim a fake ts.
      return null;
    }
    const newTs = String(posted.body.ts);
    const ch = posted.body.channel ? String(posted.body.channel) : channel;

    // 3. Atomic claim — only one instance wins.
    const claim = await claimParentTs(st.runId, ch, newTs);
    if (claim.won) {
      st.parentTs = claim.ts;
      st.channel = claim.channel || ch;
      st.needsParent = false;
      st.lastParentAt = _now();
      st.parentDirty = false;
      return st.parentTs;
    }

    // 4. Lost the race — use the winner's ts. Best-effort delete our orphan
    // parent so the channel does not accumulate duplicates.
    if (claim.ts) {
      st.parentTs = claim.ts;
      st.channel = claim.channel || ch;
      st.needsParent = false;
      // Delete the message we just posted (orphan). Never throw, never await
      // from a caller — we are already on the detached flush path.
      slackApi('chat.delete', { channel: ch, ts: newTs }).catch(() => {});
      return st.parentTs;
    }

    // Claim lost and no winner visible — leave needsParent for next tick.
    // Delete orphan to avoid spam.
    slackApi('chat.delete', { channel: ch, ts: newTs }).catch(() => {});
    return null;
  } catch (err) {
    try { console.warn(`📡 runFeed.ensureParent: ${err && err.message}`); } catch { /* ignore */ }
    return null;
  } finally {
    st.claimInFlight = false;
    st.parentCreateInFlight = false;
  }
}

async function loadLiveSnapshot(st) {
  const out = {
    now: _now(),
    total: st.total,
    counts: {},
    stages: new Map(),
    runCounters: null,
    // Video ads sitting on a delivered-LOOKING raw status (draft/live/
    // archived) whose titling has not genuinely settled — see the parity
    // note on the count-line loop in buildParentText for why this exists.
    // Populated from the SAME classifyRunAdOutcome the run-finalization
    // path uses (services/campaignRunGuards.js), never re-derived here.
    titlingIncomplete: 0
  };
  try {
    const Ad = AdModel();
    const CampaignRun = CampaignRunModel();
    const rid = st.runId;
    // Lazy require (matches this file's existing lazy-model convention) —
    // avoids a hard dependency at module-load time on campaignRunGuards.js.
    // eslint-disable-next-line global-require
    const { classifyRunAdOutcome } = require('./campaignRunGuards');

    // RETROFITTED 2026-08-31 (services/adPhase.js parity pass — that
    // file's own header names this aggregate as one of three independent
    // "what state is this ad in" derivations it exists to unify). This used
    // to be a `$group by $status` aggregate PLUS a separate `status:
    // 'rendering'` find for stage breadcrumbs — two round trips computing
    // two views of the same run. One `.find()` over the whole run, with the
    // fields classifyRunAdOutcome needs (the same list worker.js's own
    // reconciliation call site selects — see verifyTitlingDeliveryTruth.js
    // W1), now serves the raw per-status tally, the rendering-stage map,
    // AND the titling-debt count in a single query.
    const [adRows, runDoc] = await Promise.all([
      Ad.find({ campaignRunIds: rid })
        .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
        .lean()
        .catch(() => []),
      CampaignRun.findOne({ runId: rid })
        .select('total succeeded failed skipped status brandId requestedBy')
        .lean()
        .catch(() => null)
    ]);

    for (const a of adRows || []) {
      if (!a) continue;
      if (a.status) out.counts[String(a.status)] = (out.counts[String(a.status)] || 0) + 1;
      if (a.status === 'rendering' && a.renderStage) out.stages.set(String(a._id), String(a.renderStage));
    }
    out.titlingIncomplete = classifyRunAdOutcome(adRows || []).titlingIncomplete;
    // Fall back to local lastStageByAd for ads this instance knows about
    // that may not have flushed renderStage yet.
    for (const [adId, stage] of st.lastStageByAd) {
      if (!out.stages.has(adId)) out.stages.set(adId, stage);
    }
    if (runDoc) {
      // Queued-drain / other instance / worker never passed opts.requestedBy.
      if (!st.requestedBy && runDoc.requestedBy) st.requestedBy = String(runDoc.requestedBy);
      out.runCounters = {
        total: runDoc.total,
        succeeded: runDoc.succeeded,
        failed: runDoc.failed,
        skipped: runDoc.skipped,
        status: runDoc.status
      };
      if (runDoc.total != null) out.total = runDoc.total;
    }

    // Enrich brand name once (best-effort, non-blocking for future ticks).
    if (!st.brandName && st.brandId) {
      try {
        // eslint-disable-next-line global-require
        const Brand = require('../models/Brand');
        const b = await Brand.findById(st.brandId).select('name').lean();
        if (b && b.name) st.brandName = b.name;
      } catch { /* ignore */ }
    }

    // Enrich requester label once (best-effort, non-blocking for future ticks).
    // Latched on ATTEMPT, not on success: a requestedBy pointing at a deleted
    // user would otherwise re-query on every parent tick for the life of the
    // run and never resolve. One miss is enough — the parent already degrades
    // to the short id.
    if (!st.requesterLabel && st.requestedBy && !st.requesterLookupDone) {
      st.requesterLookupDone = true;
      try {
        const User = UserModel();
        const u = await User.findById(st.requestedBy).select('displayName email').lean();
        if (u) st.requesterLabel = u.displayName || u.email || null;
      } catch { /* ignore */ }
    }
  } catch {
    // Snapshot failure: parent update still uses local state.
  }
  return out;
}

async function flushRun(st) {
  if (!isConfigured()) return;

  // Ensure parent exists before threading.
  const parentTs = await ensureParent(st);
  if (!parentTs) {
    // Cannot post thread without parent; keep events in the ring (bounded).
    return;
  }

  const channel = st.channel || CHANNEL();

  // ── thread batch ────────────────────────────────────────────────────
  const { items, dropped } = st.ring.drain();
  if (items.length || dropped > 0) {
    const lines = [];
    if (dropped > 0) {
      lines.push(`_(${dropped} event${dropped === 1 ? '' : 's'} dropped)_`);
    }
    for (const ev of items) {
      lines.push(formatThreadLine(ev));
    }
    // Slack text limit — split if needed.
    let buf = [];
    let len = 0;
    const flushBuf = async () => {
      if (!buf.length) return;
      const text = buf.join('\n');
      buf = [];
      len = 0;
      await slackApi('chat.postMessage', {
        channel,
        text: clip(text, SLACK_MAX),
        thread_ts: parentTs
      });
    };
    for (const line of lines) {
      const add = line.length + (buf.length ? 1 : 0);
      if (len + add > SLACK_MAX - 32 && buf.length) {
        await flushBuf();
      }
      buf.push(line);
      len += add;
    }
    await flushBuf();
  }

  // ── parent update (throttled) ───────────────────────────────────────
  const now = _now();
  const due = st.parentDirty && (now - st.lastParentAt >= PARENT_THROTTLE_MS());
  const forceFinal = st.finished && st.parentDirty;
  if (due || forceFinal) {
    const live = await loadLiveSnapshot(st);
    const text = buildParentText(st, live);
    const upd = await slackApi('chat.update', {
      channel,
      ts: parentTs,
      text
    });
    if (upd.ok) {
      st.lastParentAt = now;
      st.parentDirty = false;
    }
    // On failure leave parentDirty so the next tick retries.
  }
}

async function flushAll() {
  if (flushInFlight) return;
  if (!isConfigured()) {
    // Inert: cancel timer so we do not spin forever when misconfigured mid-flight.
    stopTimerIfIdle();
    return;
  }
  flushInFlight = true;
  try {
    const list = [...runs.values()];
    for (const st of list) {
      try {
        await flushRun(st);
      } catch (err) {
        try { console.warn(`📡 runFeed.flushRun(${st.runId}): ${err && err.message}`); } catch { /* ignore */ }
      }
    }
    // Prune finished runs whose ring is empty and parent is clean
    // (keep briefly so a late onStage can still land — 2 flush cycles).
    for (const [rid, st] of runs) {
      if (st.finished && st.ring.size === 0 && !st.parentDirty && !st.needsParent) {
        // Mark for delayed prune via startedAt reorder — drop ads map entries.
        if (!st._pruneAfter) st._pruneAfter = _now() + PARENT_THROTTLE_MS();
        if (_now() >= st._pruneAfter) {
          for (const [adId, r] of adToRun) {
            if (r === rid) {
              adToRun.delete(adId);
              adMeta.delete(adId);
            }
          }
          runs.delete(rid);
        }
      }
    }
    pruneRuns();
    stopTimerIfIdle();
  } finally {
    flushInFlight = false;
  }
}

// ── test seams ────────────────────────────────────────────────────────────
function _resetState() {
  runs.clear();
  adToRun.clear();
  adMeta.clear();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  timerIntervalMs = 0;
  warnedUnconfigured = false;
  flushInFlight = false;
  _forceThrow = false;
  _CampaignRun = null;
  _Ad = null;
  _User = null;
  _fetch = null;
  _now = () => Date.now();
}

function _setDeps(deps = {}) {
  if ('CampaignRun' in deps) _CampaignRun = deps.CampaignRun;
  if ('Ad' in deps) _Ad = deps.Ad;
  if ('User' in deps) _User = deps.User;
  if ('fetch' in deps) _fetch = deps.fetch;
  if ('now' in deps) _now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  if ('forceThrow' in deps) _forceThrow = !!deps.forceThrow;
}

function _getRunState(runId) {
  return runs.get(String(runId)) || null;
}

function _trackedRunCount() {
  return runs.size;
}

function _adMapSize() {
  return adToRun.size;
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
  // public API
  startRun,
  finishRun,
  onStage,
  noteEvent,
  isConfigured,
  isPollTick,
  // pure helpers (tests + formatting reuse)
  summariseFailures,
  formatThreadLine,
  buildParentText,
  claimParentTs,
  RingBuffer,
  // test seams
  _resetState,
  _setDeps,
  _getRunState,
  _trackedRunCount,
  _adMapSize,
  _flushOnce,
  _ensureTimer: ensureTimer,
  // exported for structural asserts
  _POLL_TICK_RE: POLL_TICK_RE,
  _MAX_TRACKED_RUNS: MAX_TRACKED_RUNS
};
