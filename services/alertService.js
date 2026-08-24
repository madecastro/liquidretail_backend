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
// that endpoint builds a pre-formatted `diagnostic` block
// (routes/ads.js ~1662-1676). Callers that already have that string
// SHOULD pass it as `detail` — buildMessage() drops it into the fenced
// block with only size-clipping applied (no re-formatting, no second
// schema). Do not invent a parallel field layout here; the activity
// board is the source of truth for what an operator needs.

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

// Occurrence THRESHOLD — the inverse end of the same problem dedupe solves.
//
// Dedupe answers "this already fired, do not spam". A threshold answers the
// owner's other question: "if it happens MORE THAN ONCE, alert me" — i.e.
// hold the FIRST occurrence and page from the second. Opt-in per call via
// `minCount`; omitted or 1 means today's behaviour, so every existing caller
// is unchanged by construction.
//
// This is NOT a second dedupe. It reuses the SAME `key` and folds its held
// occurrences into the SAME `suppressed` tally, so a threshold-held hit shows
// up in the eventual "+N more (suppressed)" line instead of vanishing. One key
// namespace, one tally, two gates in series: threshold, then dedupe.
//
// WINDOW — 30 minutes, and the choice is a trade between two failure modes:
//   • too short: an outage that produces one failure per run (a small
//     single-product run every ~20 min) never pairs two hits and never pages,
//     which is exactly the 20-hour silence this exists to end.
//   • too long: two genuinely unrelated blips days apart get welded into a
//     "recurring" page and the channel loses credibility.
// 30 min pairs anything inside the same working sitting — including the batch
// case, where a multi-product run trips the second occurrence within seconds —
// without reaching across a day.
const THRESHOLD_WINDOW_MS = () =>
  Math.max(0, parseInt(process.env.ALERT_THRESHOLD_WINDOW_MIN || '30', 10)) * 60 * 1000;

// Absolute ceiling on outbound messages, independent of dedupe — protects
// the channel (and Slack's own rate limits) if something goes wrong
// in a tight loop with varying keys.
//
// Severity-aware: info/warn share RATE_LIMIT_MAX (default 20/min). error/fatal
// use a SEPARATE, higher allowance so a burst of low-severity traffic (e.g.
// residual warn-level accepts, status noise) can never starve a crash or a
// money alert. Bound still exists — a genuine error storm must not infinitely
// spam Slack. Default high cap = max(60, 3× low cap): enough headroom for a
// multi-surface QC-failure wave without letting a tight loop run unbounded.
const RATE_LIMIT_MAX     = () => Math.max(1, parseInt(process.env.ALERT_RATE_LIMIT_MAX || '20', 10));
const RATE_LIMIT_ERROR_MAX = () => {
  const explicit = parseInt(process.env.ALERT_RATE_LIMIT_ERROR_MAX || '', 10);
  if (Number.isFinite(explicit) && explicit >= 1) return explicit;
  return Math.max(60, RATE_LIMIT_MAX() * 3);
};
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
const occurrences  = new Map(); // key → { count, since } — threshold gate only
let   windowStart  = 0;
let   windowCount  = 0;       // low-severity (info/warn) deliveries this window
let   highWindowCount = 0;    // high-severity (error/fatal) deliveries this window
let   rateLimitedNoted = false;
let   highRateLimitedNoted = false;

/**
 * Severity-aware rate limit. `level` is the alert level string.
 *
 * Low (info/warn) and high (error/fatal) buckets are independent: exhausting
 * the low bucket must NOT suppress error/fatal. Each bucket still has a hard
 * ceiling (see RATE_LIMIT_MAX / RATE_LIMIT_ERROR_MAX comments above).
 */
function withinRateLimit(level = 'warn') {
  const now = Date.now();
  if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
    highWindowCount = 0;
    rateLimitedNoted = false;
    highRateLimitedNoted = false;
  }
  const isHigh = level === 'error' || level === 'fatal';
  if (isHigh) {
    if (highWindowCount >= RATE_LIMIT_ERROR_MAX()) {
      if (!highRateLimitedNoted) {
        highRateLimitedNoted = true;
        console.warn(
          `🔔 alert: high-severity rate limit hit (${RATE_LIMIT_ERROR_MAX()}/min error+fatal) — ` +
          `suppressing further error/fatal this minute`
        );
      }
      return false;
    }
    highWindowCount++;
    return true;
  }
  if (windowCount >= RATE_LIMIT_MAX()) {
    if (!rateLimitedNoted) {
      rateLimitedNoted = true;
      console.warn(
        `🔔 alert: rate limit hit (${RATE_LIMIT_MAX()}/min info+warn) — ` +
        `suppressing further low-severity alerts this minute (error/fatal still delivered)`
      );
    }
    return false;
  }
  windowCount++;
  return true;
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
  // Threshold bookkeeping ages out on its OWN window, which is independent of
  // the dedupe window (an operator may widen one without the other).
  const twin = THRESHOLD_WINDOW_MS();
  for (const [k, rec] of occurrences) {
    if (twin > 0 && now - rec.since > twin) occurrences.delete(k);
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
  while (occurrences.size > MAX_TRACKED_KEYS) {
    occurrences.delete(occurrences.keys().next().value);
  }
}

// ── transport ────────────────────────────────────────────────────────────────
async function sendSlack(text, lvl, channelOverride) {
  const token   = BOT_TOKEN();
  const override = (channelOverride && String(channelOverride).trim()) || '';
  const channel = override || CHANNEL_FOR(lvl);
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

// Assemble the outgoing mrkdwn, budgeting the ESCAPED length so the result
// is always <= SLACK_MAX with every fence closed. The detail block gets
// whatever room the header and fields leave over. When `detail` is a
// pre-built diagnostic from render-activity, it is used as-is (after
// safeEsc size-clipping only) — never re-parsed into a second schema.
function buildMessage({ lvl, title, fields, detail, held }) {
  const lines = [
    `${ICON[lvl]} *${safeEsc(title || '(no title)', MAX_TITLE)}*`,
    `\`${safeEsc(`${ENV_LABEL()}·${ROLE()}·${INSTANCE()}`, 120)}\``
  ];

  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    let n = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      if (++n > MAX_FIELDS) break;
      lines.push(`${safeEsc(k, 60)}: *${safeEsc(v, MAX_FIELD_VAL)}*`);
    }
  }

  if (held && held.count > 0) {
    let since = '';
    try { since = new Date(held.since).toISOString().slice(11, 19); } catch { /* ignore */ }
    lines.push('', `_+${Number(held.count) || 0} more${since ? ` since ${since}Z` : ''} (suppressed)_`);
  }

  const head = lines.join('\n');
  if (!detail) return head.slice(0, SLACK_MAX);

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
 * @param {number} [o.minCount] deliver only from the Nth occurrence of `key`
 *                 inside ALERT_THRESHOLD_WINDOW_MIN. Omitted/1 = today's
 *                 behaviour. Use 2 for "alert me if it happens more than once".
 * @returns {Promise<boolean>} true if a message was actually delivered
 */
async function notify({ level = 'warn', title, detail, fields, key, minCount, channel } = {}) {
  try {
    if (!ENABLED()) return false;

    const lvl = LEVELS[level] ? level : 'warn';
    if (LEVELS[lvl] < MIN_LEVEL()) return false;

    const token = BOT_TOKEN();
    const override = (channel && String(channel).trim()) || '';
    const chat  = override || CHANNEL();
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

    // ── threshold gate (runs BEFORE dedupe) ──
    // Order matters: counting has to happen on every occurrence, including
    // ones dedupe would later drop, or a burst that opens with a delivery
    // would leave the counter permanently under the threshold.
    const min = Math.max(1, parseInt(minCount, 10) || 1);
    const twin = THRESHOLD_WINDOW_MS();
    // ALERT_THRESHOLD_WINDOW_MIN=0 DISABLES the threshold (every occurrence
    // pages), matching how ALERT_DEDUPE_WINDOW_MIN=0 disables dedupe. Chosen
    // over "0 = expire instantly" because that reading would make the knob a
    // silent mute switch for exactly the alerts someone set a threshold on —
    // the operator would believe they had loosened suppression and would in
    // fact have turned the page off.
    if (min > 1 && twin > 0) {
      const prevOcc = occurrences.get(dedupeKey);
      const stale = !prevOcc || (now - prevOcc.since >= twin);
      const rec = stale ? { count: 1, since: now } : { count: prevOcc.count + 1, since: prevOcc.since };
      occurrences.set(dedupeKey, rec);
      if (rec.count < min) {
        // Held, not lost: fold it into the same tally dedupe uses so the
        // eventual delivery says "+N more (suppressed)" and the operator can
        // see this was the second of several, not an isolated event.
        const p = suppressed.get(dedupeKey) || { count: 0, since: now };
        suppressed.set(dedupeKey, { count: p.count + 1, since: p.since });
        return false;
      }
    }

    if (win > 0 && last && now - last < win) {
      const prev = suppressed.get(dedupeKey) || { count: 0, since: now };
      suppressed.set(dedupeKey, { count: prev.count + 1, since: prev.since });
      return false;
    }

    // Claim the dedupe slot BEFORE anything else, and definitely before the
    // first await. Two callers racing on the same key must not both send.
    lastSentAt.set(dedupeKey, now);

    if (!withinRateLimit(lvl)) {
      // Rate-limited, not delivered — release the slot so the key isn't
      // silenced for the whole dedupe window by a burst it never joined.
      // Count the drop the same way dedupe does so "+N more (suppressed)"
      // reflects BOTH rate-limit and dedupe drops (both buckets share this
      // map; severity only affects which rate-limit bucket was consulted).
      lastSentAt.delete(dedupeKey);
      const prev = suppressed.get(dedupeKey) || { count: 0, since: now };
      suppressed.set(dedupeKey, { count: prev.count + 1, since: prev.since });
      return false;
    }

    // Fold in anything suppressed since the last delivery of this key.
    const held = suppressed.get(dedupeKey);
    suppressed.delete(dedupeKey);

    const ok = await sendSlack(buildMessage({ lvl, title, fields, detail, held }), lvl, override || undefined);
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

/** True when the Slack pair is present — lets callers skip building payloads. */
const isConfigured = () => Boolean(BOT_TOKEN() && CHANNEL() && ENABLED());

/** Test seam: clears dedupe + rate-limit state. Not used in production code. */
function _resetState() {
  lastSentAt.clear();
  suppressed.clear();
  occurrences.clear();
  windowStart = 0;
  windowCount = 0;
  highWindowCount = 0;
  rateLimitedNoted = false;
  highRateLimitedNoted = false;
  delete notify._warnedUnconfigured;
}

module.exports = {
  notify, notifyAsync, info, warn, error, fatal,
  isConfigured,
  // exported for unit tests
  _esc: esc, _clip: clip, _safeEsc: safeEsc, _redact: redact,
  _buildMessage: buildMessage, _resetState, _LEVELS: LEVELS,
  _stateSize: () => ({ lastSentAt: lastSentAt.size, suppressed: suppressed.size, occurrences: occurrences.size }),
  _THRESHOLD_WINDOW_MS: THRESHOLD_WINDOW_MS,
  _resetRateWindow: () => {
    windowStart = 0;
    windowCount = 0;
    highWindowCount = 0;
    rateLimitedNoted = false;
    highRateLimitedNoted = false;
  },
  _withinRateLimit: withinRateLimit,
  _RATE_LIMIT_MAX: RATE_LIMIT_MAX,
  _RATE_LIMIT_ERROR_MAX: RATE_LIMIT_ERROR_MAX,
  _SLACK_MAX: SLACK_MAX
};
