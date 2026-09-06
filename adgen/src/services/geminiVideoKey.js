'use strict';
// Dedicated Gemini Developer API key for VIDEO, so video can run on its
// own Google Cloud project / quota. Grounded-search traffic
// (gemini-2.5-flash, ~1,526 generate_content_paid_tier_2_requests/24h)
// stays on GEMINI_API_KEY and cannot move to Atlas — see the
// ATLAS GROUNDING PROBE comment in providers/geminiSearchProvider.js.
//
// Resolution: GEMINI_VIDEO_API_KEY if set and non-empty after trim/quote-
// strip, else GEMINI_API_KEY. Unset or empty video key is a true no-op —
// same credential as today until a distinct key is supplied.
//
// Production adgen-renderer overrides VIDEO_PROVIDER=gemini (repo/file
// default remains atlas). This helper is the live key slot for
// geminiVideoService. Not required at renderer boot: a missing key fails
// at submit (GEMINI_AUTH_MISSING), not at start.
//
// NEVER log, throw, Slack, or write the key itself into an artifact.
// Fingerprint is the last 4 characters of the trimmed key (operators can
// match a Google-console suffix after a swap). Keys shorter than 4 log
// fp=<too short> with no key material.

const VIDEO_KEY_ENV = 'GEMINI_VIDEO_API_KEY';
const FALLBACK_KEY_ENV = 'GEMINI_API_KEY';

function trimKey(raw) {
  if (raw == null) return '';
  return String(raw).trim().replace(/^['"]|['"]$/g, '');
}

function fingerprintKey(key) {
  const k = trimKey(key);
  if (!k) return null;
  if (k.length < 4) return '<too short>';
  return k.slice(-4);
}

function resolveGeminiVideoApiKey({ log = true } = {}) {
  const videoKey = trimKey(process.env[VIDEO_KEY_ENV]);
  const fallbackKey = trimKey(process.env[FALLBACK_KEY_ENV]);

  let apiKey = '';
  let slot = null;
  let logLine;

  if (videoKey) {
    apiKey = videoKey;
    slot = VIDEO_KEY_ENV;
    logLine = `gemini video key: ${VIDEO_KEY_ENV} fp=${fingerprintKey(apiKey)} len=${apiKey.length}`;
  } else if (fallbackKey) {
    apiKey = fallbackKey;
    slot = FALLBACK_KEY_ENV;
    logLine = `gemini video key: falling back to ${FALLBACK_KEY_ENV} fp=${fingerprintKey(apiKey)} len=${apiKey.length}`;
  } else {
    logLine = `gemini video key: NOT SET (neither ${VIDEO_KEY_ENV} nor ${FALLBACK_KEY_ENV})`;
  }

  if (log) console.log(logLine);

  return {
    apiKey,
    slot,
    fingerprint: fingerprintKey(apiKey),
    length: apiKey.length
  };
}

module.exports = {
  VIDEO_KEY_ENV,
  FALLBACK_KEY_ENV,
  trimKey,
  fingerprintKey,
  resolveGeminiVideoApiKey
};
