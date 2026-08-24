// Super-admin gate for platform-wide admin surfaces.
//
// Mount AFTER requireUserOnly — this reads isSuperAdmin off the User
// document that middleware already loaded into req.userDoc (a fresh
// Mongo read, not a JWT claim). A second round-trip is unnecessary
// and would not be more authoritative than the doc already in hand.
//
// Must NEVER:
//   - read req.user.role or any tenant/advertiser-shaped field
//   - accept an isSuperAdmin claim decoded from a token
//   - treat a truthy-but-not-true value (the string "true", 1, …) as
//     a grant — only the boolean true on the User doc is sufficient
//
// 403s if req.userDoc is missing or isSuperAdmin is not strictly true.

function requireSuperAdmin(req, res, next) {
  if (!req.userDoc || req.userDoc.isSuperAdmin !== true) {
    return res.status(403).json({
      error: 'super-admin only',
      code:  'NOT_SUPER_ADMIN'
    });
  }
  return next();
}

module.exports = requireSuperAdmin;
