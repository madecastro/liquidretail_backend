// Super-admin allowlist. Cross-tenant admins bypass the requireAuth
// NO_ADVERTISER gate and receive synthetic 'owner' membership for
// every Advertiser (so the workspace switcher shows all of them).
//
// Bootstrap: comma-separated emails in SUPER_ADMIN_EMAILS. Case-
// insensitive. Applied on every Google login via the passport upsert
// in index.js — if the allowlist changes, users re-promote / de-
// promote on next sign-in, no manual data patch required.
//
// Money-path safety: super-admin does not unscope Brand / Ad / spend
// queries. They still act inside ONE Advertiser at a time via the
// X-Advertiser-Id header; they just have implicit access to every
// workspace instead of needing explicit membership rows.

function isSuperAdminEmail(email) {
  if (!email) return false;
  const raw = process.env.SUPER_ADMIN_EMAILS || '';
  const allow = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(String(email).trim().toLowerCase());
}

module.exports = { isSuperAdminEmail };
