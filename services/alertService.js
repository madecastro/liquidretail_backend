// Operational alerting → Slack (bot token + chat.postMessage).
//
// Why this exists: ad rendering (including every video generation) runs
// in-process on the web service as a fire-and-forget loop after the HTTP
// 202 has flushed (routes/ads.js runRenderLoop). That process is replaced
// on every deploy AND by Render autoscaling (min 1 / max 3, CPU+memory at
// 60%), and each replacement silently kills whatever was in flight. The
// orphan reaper in worker.js eventually flips those Ads back to 'queued'
// — but nothing drains 'queued' automatically, so work just stops with no
// error surfaced anywhere. Before this module the only way to notice was
// to read Render logs by hand.
//
// Contract — this module NEVER throws and NEVER blocks the caller:
//   • every export is safe to call un-awaited from inside a render loop,
//     a catch block, or a process-exit handler;
//   • a missing token, a network failure, a Slack HTTP error, or
//     Slack's {ok:false} on HTTP 200 degrades to a console line, never
//     to a rejected promise;
//   • notify() returns a promise only so callers who want to await
//     delivery (the crash handlers, before exit) can.
//
// Secrets live in Render env only. SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL
// are read from process.env and never logged: the token appears solely in
// the Authorization header, and everything printed on a failure path runs
// through redact() first.
//
// Failure payload contract (lockstep with GET /api/ads/render-activity):
// services/renderDiagnostic.js is the single builder (buildAdRow /
// buildAdDiagnostic / diagnosticForAd) shared by the route and by
// crashReporter. Callers that already have that diagnostic string
// SHOULD pass it as `detail` — buildMessage() drops it into the fenced
// block with only size-clipping applied (no re-formatting, no second
// schema). Do not invent a parallel field layout here; the activity
// board builder is the source of truth for what an operator needs.

const os = require('os');

// ── config ───────────────────────────────────────────────────────────────────
// Read lazily on every call so a Render env change takes effect on the next
// process boot without any code branch caring about load order.
const BOT_TOKEN = () => (process.env.SLACK_BOT_TOKEN || '').trim();
const CHANNEL   = () => (process.env.SLACK_ALERT_CHANNEL || '').trim();
// Optional override for fatal; falls back to the main channel.
const CHANNEL_FOR = (lvl) => {
  if (lvl === 'fatal') {
    const fatal = (process.env.SLACK_ALERT_CHANNEL_FATAL || '').trim();
    if (fatal) return fatal;
  }
  return CHANNEL();
};

// Master switch. Default ON so that configuring the two secrets is the
// only step needed; set ALERTS_ENABLED=false to mute without unsetting them.
const ENABLED = () => String(process.env.ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false';

// Which levels actually get delivered. info < warn < error < fatal.
const LEVELS = { info: 10, warn: 20, error: 30, fatal: 40 };
const MIN_LEVEL = () => LEVELS[String(process.env.ALERT_MIN_LEVEL || 'warn').toLowerCase()] ?? LEVELS.warn;

// Repeat suppression. A given `key` is delivered at most once per window;
// further hits inside the window are counted and folded into the next
// delivery ("×7 since 14:02") rather than spamming the channel.
const DEDUPE_WINDOW_MS = () =>
  Math.max(0, parseInt(process.env.ALERT_DEDUPE_WINDOW_MIN || '15', 10)) * 60 * 1000;

// Absolute ceiling on outbound messages, independent of dedupe — protects
// the channel (and Slack's own rate limits) if something goes wrong
// in a tight loop with varying keys. Default 60 (was 20) — with no
// folding of crash alerts, this is the only silent drop point, so the
// ceiling is higher and spill is itself reported to Slack (below).
const RATE_LIMIT_MAX     = () => Math.max(1, parseInt(process.env.ALERT_RATE_LIMIT_MAX || '60', 10));
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Shown in every message so staging and prod are distinguishable, and so
// you can tell WHICH Render service/instance spoke. RENDER_* are injected
// by Render itself.
const ENV_LABEL = () => process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'prod';
const ROLE      = () => process.env.ALERT_ROLE || (process.env.RENDER_SERVICE_TYPE === 'background_worker' ? 'worker' : 'web');
const INSTANCE  = () => (process.env.RENDER_INSTANCE_ID || os.hostname() || '?').slice(-8);

const SEND_TIMEOUT_MS = () => Math.max(1000, parseInt(process.env.ALERT_SEND_TIMEOUT_MS || '8000', 10));

// Slack's text field allows far more, but alerts stay scannable. Budget the
// ESCAPED text (escaping can inflate 1 char into 5) and never clip the
// assembled string — only the pieces that go inside a wrapper. A blind clip
// of the final message would cut inside a fenced code block and emit a
// broken payload.
const SLACK_MAX     = 4000;
const SAFETY_MARGIN = 64;   // room for the joins and the ``` wrapper
// caller-supplied; bound it so the head can't blow the budget. Raised 12 → 20
// for crash/shutdown reports, which legitimately carry ~18 (identity + money +
// in-flight counts + requeue results + likely cause). The detail block takes
// whatever room the head leaves, so a larger head just shortens the stack —
// it cannot overflow SLACK_MAX. Overflow past this cap is still DROPPED
// silently, which is why crashReporter inserts identity fields first.
const MAX_FIELDS    = 20;
const MAX_TITLE     = 200;
const MAX_FIELD_VAL = 200;

const ICON = { info: 'ℹ️', warn: '⚠️', error: '❌', fatal: '🔥' };

// ── in-process state ─────────────────────────────────────────────────────────
// Deliberately per-process, not Mongo-backed. Each instance suppressing its
// own repeats is the behaviour we want: if two instances are both failing
// that is worth two messages, and an alerting path must never depend on the
// database being reachable — a Mongo outage is exactly when alerts matter.
const lastSentAt   = new Map(); // key → epoch ms of last delivery
const suppressed   = new Map(); // key → { count, since }
let   windowStart  = 0;
let   windowCount  = 0;
let   rateLimitedNoted = false;
// Drops this window. With no crash-alert folding, the rate limit is the
// only silent drop point — count them and emit ONE spill summary on
// rollover so the channel still learns something was lost. IncidentLog
// is the system of record (written before Slack); the spill just points
// operators at that collection.
let   rateLimitDrops = 0;
let   spillTimer   = null;

// A rollover-only flush would be a lie: withinRateLimit() is only called when
// something tries to send, so a burst that drops 40 alerts and then goes quiet
// would roll over with nobody there to notice. That is exactly the case the
// spill exists for. So the FIRST drop of a window arms a detached timer that
// reports regardless of any later traffic. unref'd — same pattern as
// runFeedService's drain interval — so it can never hold the process open on a
// shutdown path.
function armSpillTimer() {
  if (spillTimer) return;
  const due = Math.max(0, RATE_LIMIT_WINDOW_MS - (Date.now() - windowStart)) + 50;
  spillTimer = setTimeout(() => {
    spillTimer = null;
    flushRateLimitSpill();
  }, due);
  if (typeof spillTimer.unref === 'function') spillTimer.unref();
}

function flushRateLimitSpill() {
  const dropped = rateLimitDrops;
  rateLimitDrops = 0;
  // Via a bypass path so it never consumes a slot / re-enters the counter
  // (a recursive notify → withinRateLimit would be fatal for the one
  // message that exists to report drops).
  if (dropped > 0) scheduleRateLimitSpill(dropped);
}

function withinRateLimit() {
  const now = Date.now();
  if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
    rateLimitedNoted = false;
    // The armed timer may not have fired yet (its 50ms margin, or an idle
    // event loop). Report now rather than carrying the count into a window
    // it did not belong to.
    flushRateLimitSpill();
  }
  if (windowCount >= RATE_LIMIT_MAX()) {
    rateLimitDrops++;
    armSpillTimer();
    if (!rateLimitedNoted) {
      rateLimitedNoted = true;
      console.warn(`🔔 alert: rate limit hit (${RATE_LIMIT_MAX()}/min) — suppressing further alerts this minute`);
    }
    return false;
  }
  windowCount++;
  return true;
}

// Fire-and-forget: never await on a render path, never throw.
function scheduleRateLimitSpill(n) {
  Promise.resolve()
    .then(() => emitRateLimitSpill(n))
    .catch(() => {});
}

async function emitRateLimitSpill(n) {
  // Bypass the rate-limit counter entirely. Do NOT call withinRateLimit
  // and do not increment windowCount — this summary must never be the
  // dropped message. Still go through notify() for min-level / config /
  // transport / never-throws, with an explicit bypass flag.
  const count = Number(n) || 0;
  if (count <= 0) return;
  try {
    await notify({
      level: 'warn',
      title: `${count} crash alert(s) suppressed by the rate limit`,
      fields: {
        dropped: String(count),
        // IncidentLog is written BEFORE every Slack send (crashReporter
        // ordering rule); the dropped messages still have rows.
        'incident log': 'IncidentLog — query by kind + at for the missing window',
      },
      key: `alert-rate-limit-spill:${windowStart}`,
      _bypassRateLimit: true,
    });
  } catch {
    /* absolute backstop — notify itself never throws, but be sure */
  }
}

// Slack mrkdwn treats &, <, > as control characters (links, mentions). They
// must be entity-encoded when used as literal text. Do NOT carry over
// Telegram HTML tags; Slack does not use parse_mode=HTML.
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

// Escape FIRST, then clip, so `max` is a real character budget for the
// outgoing message. Clipping escaped text can land mid-entity ("&am"), so
// a trailing partial entity is trimmed off.
function safeEsc(v, max) {
  const s = esc(v);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).replace(/&[a-zA-Z]*$/, '')}…`;
}

// The token appears only in the Authorization header — but a failed
// request or a misconfigured logger can still echo it. Scrub every
// known token shape from anything we print.
function redact(text) {
  const token = BOT_TOKEN();
  let s = String(text ?? '');
  if (token && token.length > 4) s = s.split(token).join('<token>');
  // Slack bot / user / app tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-).
  s = s.replace(/xox[baprs]-[A-Za-z0-9-]+/g, 'xox<redacted>');
  // Legacy Telegram bot<digits>:<secret> shape, if it ever appears.
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
}

// Bound the dedupe bookkeeping. Keys embed error-message fragments, so
// their cardinality is unbounded over a long-lived process — without this
// the Maps grow forever.
const MAX_TRACKED_KEYS = 500;
function pruneDedupeState(now) {
  const win = DEDUPE_WINDOW_MS();
  // A key can never suppress again once its window has elapsed.
  for (const [k, t] of lastSentAt) {
    if (now - t > win + RATE_LIMIT_WINDOW_MS) {
      lastSentAt.delete(k);
      suppressed.delete(k);
    }
  }
  // Hard cap regardless of window (Map preserves insertion order, so the
  // head is the oldest).
  while (lastSentAt.size > MAX_TRACKED_KEYS) {
    const oldest = lastSentAt.keys().next().value;
    lastSentAt.delete(oldest);
    suppressed.delete(oldest);
  }
  while (suppressed.size > MAX_TRACKED_KEYS) {
    suppressed.delete(suppressed.keys().next().value);
  }
}

// ── transport ────────────────────────────────────────────────────────────────
async function sendSlack(text, lvl) {
  const token   = BOT_TOKEN();
  const channel = CHANNEL_FOR(lvl);
  if (!token || !channel) return false;

  // Node 20+ (package.json engines: >=20 <23) — global fetch, matching the
  // convention in httpScrapeClient / shopifyPublicIngestService.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS());
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        // buildMessage() already guarantees <= SLACK_MAX with balanced
        // fences; clipping here would be the thing that breaks them.
        channel,
        text
        // mrkdwn is the default for text; we escape & < > in user content.
      }),
      signal: ctl.signal
    });

    // Rate limit: honour Retry-After by logging it, but NEVER sleep on a
    // render path. Drop this delivery; notify() will release the dedupe
    // slot and restore the held tally so the count is not lost.
    if (res.status === 429) {
      const ra = res.headers.get('retry-after') || res.headers.get('Retry-After') || '?';
      console.warn(`🔔 alert: Slack 429 (Retry-After: ${ra}s) — dropping this delivery`);
      return false;
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
      const why = body && (body.error || body) ? JSON.stringify(body) : `HTTP ${res.status}`;
      console.warn(`🔔 alert: Slack ${res.status} — ${redact(clip(why, 300))}`);
      return false;
    }

    if (!body || body.ok !== true) {
      const errName = (body && body.error) ? String(body.error) : 'unknown (no ok field)';
      console.warn(`🔔 alert: Slack ok=false — ${redact(clip(errName, 300))}`);
      return false;
    }
    return true;
  } catch (err) {
    const why = err.name === 'AbortError' ? `timeout after ${SEND_TIMEOUT_MS()}ms` : err.message;
    console.warn(`🔔 alert: Slack send failed — ${redact(why)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Coerce a non-string title into something readable for Slack. The dual-
// shape wrappers (§4a) close the known `[object Object]` call sites, but
// if a future caller still passes an object as `title` we want a console
// warning naming the offender and a scannable message — not silent
// `[object Object]` in the channel.
function coerceTitle(title) {
  if (title == null || typeof title === 'string') return title;
  try {
    const preview = typeof title === 'object'
      ? (title.title != null ? String(title.title)
        : (typeof title.message === 'string' ? title.message
          : clip(JSON.stringify(title), MAX_TITLE)))
      : String(title);
    console.warn(
      `🔔 alert: non-string title (typeof=${typeof title}` +
      `${title && title.constructor && title.constructor.name ? `, ${title.constructor.name}` : ''})` +
      ` — coercing; offender preview: ${clip(preview, 120)}`
    );
    if (typeof title === 'object' && title.title != null) return String(title.title);
    try { return clip(JSON.stringify(title), MAX_TITLE); }
    catch { return String(title); }
  } catch {
    return String(title);
  }
}

// Assemble the outgoing mrkdwn, budgeting the ESCAPED length so the result
// is always <= SLACK_MAX with every fence closed. The detail block gets
// whatever room the header and fields leave over. When `detail` is a
// pre-built diagnostic from render-activity, it is used as-is (after
// safeEsc size-clipping only) — never re-parsed into a second schema.
function buildMessage({ lvl, title, fields, detail, held }) {
  // Redact BEFORE escaping and budgeting, so the size budget is computed on
  // the text that actually ships and a token can never survive by hiding in a
  // clipped tail. Until crashReporter existed, redact() only guarded
  // console.warn — but alerts now routinely carry error messages and full
  // stacks, and a stack from a failed authenticated request can contain the
  // bot token verbatim. A Slack channel is readable by the whole workspace and
  // its history is exportable, so that is a real credential disclosure.
  const titleStr = redact(coerceTitle(title));
  const lines = [
    `${ICON[lvl]} *${safeEsc(titleStr || '(no title)', MAX_TITLE)}*`,
    `\`${safeEsc(`${ENV_LABEL()}·${ROLE()}·${INSTANCE()}`, 120)}\``
  ];

  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    let n = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      if (++n > MAX_FIELDS) break;
      lines.push(`${safeEsc(redact(k), 60)}: *${safeEsc(redact(v), MAX_FIELD_VAL)}*`);
    }
  }

  if (held && held.count > 0) {
    let since = '';
    try { since = new Date(held.since).toISOString().slice(11, 19); } catch { /* ignore */ }
    lines.push('', `_+${Number(held.count) || 0} more${since ? ` since ${since}Z` : ''} (suppressed)_`);
  }

  const head = lines.join('\n');
  if (!detail) return head.slice(0, SLACK_MAX);
  detail = redact(detail);

  // '\n\n```\n' + '\n```' is 10 chars of wrapper.
  const FENCE_OVERHEAD = 10;
  const room = SLACK_MAX - head.length - FENCE_OVERHEAD - SAFETY_MARGIN;
  if (room < 80) return head.slice(0, SLACK_MAX);   // no useful space left
  return `${head}\n\n\`\`\`\n${safeEsc(detail, room)}\n\`\`\``;
}

// ── public API ───────────────────────────────────────────────────────────────
/**
 * Fire an operational alert. Never throws.
 *
 * @param {object}  o
 * @param {'info'|'warn'|'error'|'fatal'} o.level
 * @param {string}  o.title   one-line summary
 * @param {string} [o.detail] free text (stack, message, diagnostic) — escaped for mrkdwn
 * @param {object} [o.fields] key→value lines rendered under the title
 * @param {string} [o.key]    dedupe key; defaults to level+title
 * @returns {Promise<boolean>} true if a message was actually delivered
 */
async function notify({ level = 'warn', title, detail, fields, key, _bypassRateLimit = false } = {}) {
  try {
    if (!ENABLED()) return false;

    const lvl = LEVELS[level] ? level : 'warn';
    if (LEVELS[lvl] < MIN_LEVEL()) return false;

    const token = BOT_TOKEN();
    const chat  = CHANNEL();
    if (!token || !chat) {
      // One console line so a misconfigured deploy is diagnosable without
      // being noisy on every single call.
      if (!notify._warnedUnconfigured) {
        notify._warnedUnconfigured = true;
        console.warn('🔔 alert: SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL not set — alerts disabled');
      }
      return false;
    }

    const dedupeKey = String(key || `${lvl}:${title}`);
    const now  = Date.now();
    const win  = DEDUPE_WINDOW_MS();
    const last = lastSentAt.get(dedupeKey);

    pruneDedupeState(now);

    if (win > 0 && last && now - last < win) {
      const prev = suppressed.get(dedupeKey) || { count: 0, since: now };
      suppressed.set(dedupeKey, { count: prev.count + 1, since: prev.since });
      return false;
    }

    // Claim the dedupe slot BEFORE anything else, and definitely before the
    // first await. Two callers racing on the same key must not both send.
    lastSentAt.set(dedupeKey, now);

    // Rate-limit spill summaries bypass the counter so they can never
    // themselves be the dropped message (and so emitRateLimitSpill cannot
    // recurse into withinRateLimit).
    if (!_bypassRateLimit && !withinRateLimit()) {
      // Rate-limited, not delivered — release the slot so the key isn't
      // silenced for the whole dedupe window by a burst it never joined.
      lastSentAt.delete(dedupeKey);
      return false;
    }

    // Fold in anything suppressed since the last delivery of this key.
    const held = suppressed.get(dedupeKey);
    suppressed.delete(dedupeKey);

    const ok = await sendSlack(buildMessage({ lvl, title, fields, detail, held }), lvl);
    if (!ok) {
      // A failed send shouldn't hold the dedupe slot — a transient network
      // blip would otherwise silence this key for the whole window. Put the
      // suppressed tally back too, so its count isn't lost with the message.
      lastSentAt.delete(dedupeKey);
      if (held) suppressed.set(dedupeKey, held);
    }
    return ok;
  } catch (err) {
    // Absolute backstop: nothing in an alerting path may propagate.
    try { console.warn(`🔔 alert: notify failed — ${err.message}`); } catch { /* ignore */ }
    return false;
  }
}

// Convenience wrappers. Accept either positional (title, opts) or a single
// options object ({ title, detail, fields, key }). Three production call
// sites pass the object form; without this branch the object becomes the
// title and Slack renders `[object Object]` with detail/fields/key dropped.
const wrap = (level) => (a, b = {}) =>
  (a && typeof a === 'object' && !Array.isArray(a))
    ? notify({ ...a, level })            // object form: title lives inside
    : notify({ ...b, level, title: a }); // positional form (unchanged)
const info  = wrap('info');
const warn  = wrap('warn');
const error = wrap('error');
const fatal = wrap('fatal');

/**
 * Fire-and-forget: for use in hot paths and catch blocks where even the
 * microtask cost of an awaited promise is unwanted. Swallows everything.
 */
function notifyAsync(opts) {
  Promise.resolve().then(() => notify(opts)).catch(() => {});
}

/** True when the Slack pair is present — lets callers skip building payloads. */
const isConfigured = () => Boolean(BOT_TOKEN() && CHANNEL() && ENABLED());

/** Test seam: clears dedupe + rate-limit state. Not used in production code. */
function _resetState() {
  lastSentAt.clear();
  suppressed.clear();
  windowStart = 0;
  windowCount = 0;
  rateLimitedNoted = false;
  rateLimitDrops = 0;
  if (spillTimer) { clearTimeout(spillTimer); spillTimer = null; }
  delete notify._warnedUnconfigured;
}

module.exports = {
  notify, notifyAsync, info, warn, error, fatal,
  isConfigured,
  // exported for unit tests
  // redact is a PRODUCTION export, not just a test seam: crashReporter must
  // scrub the same token shapes before it persists a stack to Mongo, and
  // duplicating the regex would let the two drift.
  redact,
  _esc: esc, _clip: clip, _safeEsc: safeEsc, _redact: redact,
  _buildMessage: buildMessage, _resetState, _LEVELS: LEVELS,
  _stateSize: () => ({ lastSentAt: lastSentAt.size, suppressed: suppressed.size }),
  _resetRateWindow: () => {
    windowStart = 0; windowCount = 0; rateLimitedNoted = false; rateLimitDrops = 0;
    if (spillTimer) { clearTimeout(spillTimer); spillTimer = null; }
  },
  _spillPending: () => ({ drops: rateLimitDrops, armed: Boolean(spillTimer) }),
  _SLACK_MAX: SLACK_MAX
};
