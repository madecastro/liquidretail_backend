// Cross-origin redirect allowlist for OAuth flows + integration
// callbacks. Cohabitation use-case: the new Chakra app on rsvite.
// netlify.app and the legacy app on liquidretail.netlify.app both
// authenticate against the same backend. Without per-request redirect
// allowlisting, every OAuth callback would bounce to a single
// hardcoded FRONTEND_URL, stranding whichever app didn't match.
//
// Used by:
//   routes/auth.js              — /auth/google + /auth/google/callback
//   routes/integrations.js      — /integrations/instagram/{connect,callback}
//                                 /integrations/meta-ads/{connect,callback}
//                                 (and future per-provider OAuth flows)

const FRONTEND_URL  = process.env.FRONTEND_URL  || 'https://liquidretail.netlify.app';
const FRONTEND_URLS = (process.env.FRONTEND_URLS || FRONTEND_URL)
  .split(',').map(s => s.trim()).filter(Boolean);

// Validate a candidate redirect URL against the allowlist by ORIGIN
// (scheme + host + port). Returns the bare origin when valid, null
// otherwise. Path/query are stripped — callers append their own.
function validateFrontendOrigin(candidate) {
  if (!candidate) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  for (const allowed of FRONTEND_URLS) {
    try {
      if (new URL(allowed).origin === url.origin) return url.origin;
    } catch {}
  }
  return null;
}

module.exports = {
  FRONTEND_URL,
  FRONTEND_URLS,
  validateFrontendOrigin
};
