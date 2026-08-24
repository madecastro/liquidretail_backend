'use strict';
//
// Child-process diagnostic tails for Ad.renderError.
//
// remotionChildSupervisor (adgen) attaches stderrTail / stdoutTail onto the
// thrown Error. Those keys were being assembled onto renderError and then
// SILENTLY DROPPED: renderError is a strict mongoose subdocument and the
// fields were not declared. Tonight's production failures persisted only
// `remotion child exited code=1 signal=none` — the child's real error was
// captured and thrown away.
//
// THIS MODULE is the write-side half. models/Ad.js declaring the fields is
// the other half. Either one alone is a no-op.
//
// SIZE. Supervisor already line-slices (last 40 stderr / last 10 stdout),
// but a single line can be a dumped prompt. Cap at persist time.
//
// DIRECTION is not the same for both streams:
//   stderr — child's `err.stack` is written FIRST (throw, then frames).
//            Keep the START so `Error: …` survives an 8 KiB clip.
//   stdout — last line is the JSON report. Keep the END.
// Strip U+0000: Mongo BSON rejects NUL in strings, and these tails ride
// the same $set as status:'failed' / claim-release. A dirty child byte
// must not veto the merited-failure stamp.
// Do NOT put maxlength on the schema — mongoose validates rather than
// clips, and updateOne $set does not run validators by default.

const STDERR_TAIL_MAX_CHARS = 8 * 1024;
const STDOUT_TAIL_MAX_CHARS = 2 * 1024;

function clipTail(value, maxChars, keep) {
  if (value == null) return null;
  const s = String(value).replace(/\u0000/g, '');
  if (!s) return null;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
  if (s.length <= maxChars) return s;
  if (maxChars <= 3) {
    return keep === 'end' ? s.slice(-maxChars) : s.slice(0, maxChars);
  }
  if (keep === 'end') return '...' + s.slice(-(maxChars - 3));
  return s.slice(0, maxChars - 3) + '...';
}

function pickTail(err, key, maxChars, keep) {
  if (!err || typeof err !== 'object') return null;
  const direct = clipTail(err[key], maxChars, keep);
  if (direct) return direct;
  const cause = err.cause;
  if (cause && typeof cause === 'object') return clipTail(cause[key], maxChars, keep);
  return null;
}

// Returns {} when the error has no tails, so spreading is a no-op on every
// non-child failure path.
function childTailsFrom(err) {
  const out = {};
  const stderrTail = pickTail(err, 'stderrTail', STDERR_TAIL_MAX_CHARS, 'start');
  const stdoutTail = pickTail(err, 'stdoutTail', STDOUT_TAIL_MAX_CHARS, 'end');
  if (stderrTail) out.stderrTail = stderrTail;
  if (stdoutTail) out.stdoutTail = stdoutTail;
  return out;
}

module.exports = {
  STDERR_TAIL_MAX_CHARS,
  STDOUT_TAIL_MAX_CHARS,
  clipTail,
  childTailsFrom
};
