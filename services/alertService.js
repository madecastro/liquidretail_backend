// Operational alerting → Telegram.
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
//   • a missing token, a network failure, or a Telegram 4xx degrades to a
//     console line, never to a rejected promise;
//   • notify() returns a promise only so callers who want to await
//     delivery (the crash handlers, before exit) can.
//
// Secrets live in Render env only. TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
// are read from process.env and never logged: the token appears solely in
// the request URL, and everything printed on a failure path runs through
// redact() first (a malformed-URL TypeError quotes the URL verbatim).

const os = require('os');

// ── config ───────────────────────────────────────────────────────────────────
// Read lazily on every call so a Render env change takes effect on the next
// process boot without any code branch caring about load order.
const BOT_TOKEN = () => (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID   = () => (process.env.TELEGRAM_CHAT_ID   || '').trim();

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
// the channel (and Telegram's own 20 msg/min limit) if something goes wrong
// in a tight loop with varying keys.
const RATE_LIMIT_MAX     = () => Math.max(1, parseInt(process.env.ALERT_RATE_LIMIT_MAX || '20', 10));
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Shown in every message so staging and prod are distinguishable, and so
// you can tell WHICH Render service/instance spoke. RENDER_* are injected
// by Render itself.
const ENV_LABEL = () => process.env.ALERT_ENV_LABEL || process.env.NODE_ENV || 'prod';
const ROLE      = () => process.env.ALERT_ROLE || (process.env.RENDER_SERVICE_TYPE === 'background_worker' ? 'worker' : 'web');
const INSTANCE  = () => (process.env.RENDER_INSTANCE_ID || os.hostname() || '?').slice(-8);

const SEND_TIMEOUT_MS = () => Math.max(1000, parseInt(process.env.ALERT_SEND_TIMEOUT_MS || '8000', 10));

// Telegram hard-caps a message at 4096 chars AND requires balanced HTML
// tags under parse_mode=HTML. Both constraints are enforced by budgeting
// the ESCAPED text (escaping can inflate 1 char into 5, so a pre-escape
// budget guarantees nothing) and by never clipping the assembled string —
// only the pieces that go inside a tag. A blind clip of the final message
// would cut inside <pre>…</pre> and Telegram would 400 the whole thing.
const TELEGRAM_MAX = 4096;
const SAFETY_MARGIN = 64;   // room for the joins and the <pre> wrapper
const MAX_FIELDS    = 12;   // caller-supplied; bound it so the head can't blow the budget
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

function withinRateLimit() {
  const now = Date.now();
  if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
    rateLimitedNoted = false;
  }
  if (windowCount >= RATE_LIMIT_MAX()) {
    if (!rateLimitedNoted) {
      rateLimitedNoted = true;
      console.warn(`🔔 alert: rate limit hit (${RATE_LIMIT_MAX()}/min) — suppressing further alerts this minute`);
    }
    return false;
  }
  windowCount++;
  return true;
}

// Telegram parse_mode=HTML accepts a small tag subset; everything else must
// be escaped or the API rejects the whole message with a 400. Only these
// three characters are special.
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

// The token appears only in the request URL, never in a body or a field —
// but a malformed-URL TypeError from fetch quotes the whole URL, which
// would put the token in the log. Scrub it from anything we print.
function redact(text) {
  const token = BOT_TOKEN();
  let s = String(text ?? '');
  if (token && token.length > 4) s = s.split(token).join('<token>');
  // Belt-and-braces: any bot<digits>:<secret> shape, in case of a variant.
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
async function sendTelegram(text) {
  const token = BOT_TOKEN();
  const chat  = CHAT_ID();
  if (!token || !chat) return false;

  // Node 20+ (package.json engines: >=20 <23) — global fetch, matching the
  // convention in httpScrapeClient / shopifyPublicIngestService.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS());
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        // buildMessage() already guarantees <= TELEGRAM_MAX with balanced
        // tags; clipping here would be the thing that breaks them.
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      // Read the body for the reason (Telegram explains 400s clearly),
      // redacted in case any variant echoes the token back.
      const why = await res.text().catch(() => '');
      console.warn(`🔔 alert: Telegram ${res.status} — ${redact(clip(why, 300))}`);
      return false;
    }
    return true;
  } catch (err) {
    // A malformed-URL TypeError quotes the whole URL — which contains the
    // token. redact() before this ever reaches a log.
    const why = err.name === 'AbortError' ? `timeout after ${SEND_TIMEOUT_MS()}ms` : err.message;
    console.warn(`🔔 alert: Telegram send failed — ${redact(why)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Assemble the outgoing HTML, budgeting the ESCAPED length so the result is
// always <= TELEGRAM_MAX with every tag closed. The detail block gets
// whatever room the header and fields leave over.
function buildMessage({ lvl, title, fields, detail, held }) {
  const lines = [
    `${ICON[lvl]} <b>${safeEsc(title || '(no title)', MAX_TITLE)}</b>`,
    `<code>${safeEsc(`${ENV_LABEL()}·${ROLE()}·${INSTANCE()}`, 120)}</code>`
  ];

  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    let n = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      if (++n > MAX_FIELDS) break;
      lines.push(`${safeEsc(k, 60)}: <b>${safeEsc(v, MAX_FIELD_VAL)}</b>`);
    }
  }

  if (held && held.count > 0) {
    let since = '';
    try { since = new Date(held.since).toISOString().slice(11, 19); } catch { /* ignore */ }
    lines.push('', `<i>+${Number(held.count) || 0} more${since ? ` since ${since}Z` : ''} (suppressed)</i>`);
  }

  const head = lines.join('\n');
  if (!detail) return head.slice(0, TELEGRAM_MAX);

  // '\n\n<pre>' + '</pre>' is 19 chars of wrapper.
  const room = TELEGRAM_MAX - head.length - 19 - SAFETY_MARGIN;
  if (room < 80) return head.slice(0, TELEGRAM_MAX);   // no useful space left
  return `${head}\n\n<pre>${safeEsc(detail, room)}</pre>`;
}

// ── public API ───────────────────────────────────────────────────────────────
/**
 * Fire an operational alert. Never throws.
 *
 * @param {object}  o
 * @param {'info'|'warn'|'error'|'fatal'} o.level
 * @param {string}  o.title   one-line summary
 * @param {string} [o.detail] free text (stack, message, counts) — escaped
 * @param {object} [o.fields] key→value lines rendered under the title
 * @param {string} [o.key]    dedupe key; defaults to level+title
 * @returns {Promise<boolean>} true if a message was actually delivered
 */
async function notify({ level = 'warn', title, detail, fields, key } = {}) {
  try {
    if (!ENABLED()) return false;

    const lvl = LEVELS[level] ? level : 'warn';
    if (LEVELS[lvl] < MIN_LEVEL()) return false;

    const token = BOT_TOKEN();
    const chat  = CHAT_ID();
    if (!token || !chat) {
      // One console line so a misconfigured deploy is diagnosable without
      // being noisy on every single call.
      if (!notify._warnedUnconfigured) {
        notify._warnedUnconfigured = true;
        console.warn('🔔 alert: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts disabled');
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

    if (!withinRateLimit()) {
      // Rate-limited, not delivered — release the slot so the key isn't
      // silenced for the whole dedupe window by a burst it never joined.
      lastSentAt.delete(dedupeKey);
      return false;
    }

    // Fold in anything suppressed since the last delivery of this key.
    const held = suppressed.get(dedupeKey);
    suppressed.delete(dedupeKey);

    const ok = await sendTelegram(buildMessage({ lvl, title, fields, detail, held }));
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

// Convenience wrappers. Deliberately un-awaited at most call sites.
const info  = (title, o = {}) => notify({ ...o, level: 'info',  title });
const warn  = (title, o = {}) => notify({ ...o, level: 'warn',  title });
const error = (title, o = {}) => notify({ ...o, level: 'error', title });
const fatal = (title, o = {}) => notify({ ...o, level: 'fatal', title });

/**
 * Fire-and-forget: for use in hot paths and catch blocks where even the
 * microtask cost of an awaited promise is unwanted. Swallows everything.
 */
function notifyAsync(opts) {
  Promise.resolve().then(() => notify(opts)).catch(() => {});
}

/** True when the two secrets are present — lets callers skip building payloads. */
const isConfigured = () => Boolean(BOT_TOKEN() && CHAT_ID() && ENABLED());

/** Test seam: clears dedupe + rate-limit state. Not used in production code. */
function _resetState() {
  lastSentAt.clear();
  suppressed.clear();
  windowStart = 0;
  windowCount = 0;
  rateLimitedNoted = false;
  delete notify._warnedUnconfigured;
}

module.exports = {
  notify, notifyAsync, info, warn, error, fatal,
  isConfigured,
  // exported for unit tests
  _esc: esc, _clip: clip, _safeEsc: safeEsc, _redact: redact,
  _buildMessage: buildMessage, _resetState, _LEVELS: LEVELS,
  _stateSize: () => ({ lastSentAt: lastSentAt.size, suppressed: suppressed.size }),
  _resetRateWindow: () => { windowStart = 0; windowCount = 0; rateLimitedNoted = false; }
};
