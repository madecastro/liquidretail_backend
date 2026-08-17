#!/usr/bin/env node
'use strict';
//
// mintTestToken — offline JWT mint for headless UI tests.
//
// ## SECURITY
// This script mints a REAL session credential that the production backend
// will accept. It is intentionally a standalone CLI with no HTTP surface:
// adding a token-minting route would be an auth bypass on a repo that
// auto-deploys `main` to production. The signing secret (JWT_SECRET) is
// read only from the environment, is never defaulted or printed, and never
// leaves the process. Tokens are short-lived by default (2h) and capped at
// the real login TTL (24h). Always target an EXPLICITLY named user via
// --email — there is no "first user in the DB" convenience default.
//
// ## Why this exists
// The SPA authenticates via Google OAuth ONLY (routes/auth.js —
// /auth/google, /auth/google/callback). There is no email/password login,
// so a headless UI test cannot complete the OAuth bounce. The callback
// signs a JWT and hands it to the frontend via a URL fragment; the SPA
// stores it in localStorage.token. This script mints an equivalent token
// offline so a test can inject it.
//
// A token alone is NOT enough for the SPA. apiFetch also sends
// X-Brand-Id / X-Advertiser-Id from localStorage.brand_id /
// localStorage.advertiser_id. This script resolves those IDs for the
// named user and prints them to stderr (or includes them under --json).
//
// ## Usage (repo root = cwd; secrets from env / local .env)
//
//   # Mint a 2h token for a known user; capture token only on stdout
//   export JWT_SECRET=… MONGODB_URI=…
//   TOKEN=$(node scripts/mintTestToken.js --email you@example.com)
//
//   # Programmatic capture for a Playwright / Cypress harness
//   node scripts/mintTestToken.js --email you@example.com --json > /tmp/auth.json
//
//   # List brands for the user (stderr) then mint (still needs --email)
//   node scripts/mintTestToken.js --email you@example.com --list-brands
//
//   # Pin advertiser + brand when the user has several
//   node scripts/mintTestToken.js --email you@example.com \
//     --advertiser-id 64a… --brand-id 64b… --ttl 1h
//
//   # Inject into a browser context (example):
//   #   localStorage.setItem('token', TOKEN)
//   #   localStorage.setItem('advertiser_id', ADVERTISER_ID)
//   #   localStorage.setItem('brand_id', BRAND_ID)
//
// Exit codes: 0 success · 1 usage / missing secret / user not found /
//             bad args · 2 unexpected runtime error
//

// ── JWT claim shape (must match routes/auth.js callback exactly) ─────────
//
// routes/auth.js:25-35 signs:
//   {
//     id:     req.user.id,         // Google profile id (legacy, kept for compat)
//     userId: req.user.userId,     // persisted User._id
//     email:  req.user.email,
//     name:   req.user.name,
//     photo:  req.user.photo
//   }
// with process.env.JWT_SECRET and { expiresIn: '24h' }.
//
// Passport (index.js GoogleStrategy) populates that session user as:
//   id ← profile.id (Google subject)
//   userId ← userDoc._id
//   name ← profile.displayName
//   email ← profile.emails[0]
//   photo ← profile.photos[0]
// which maps onto User fields googleId / _id / displayName / email / photoUrl.
//
// middleware/requireAuth.js (and requireUserOnly.js) after jwt.verify:
//   REQUIRED for identity: payload.userId (preferred) OR payload.id (googleId
//   fallback). The user is RE-FETCHED from the DB — email/name/photo in the
//   token are display/compat only; req.user.email/name/photo come from the
//   User doc (with payload.name/photo as fallbacks).
//   advertiserId is NEVER taken from the JWT. It is resolved from
//   AdvertiserMembership (status:'active') plus optional X-Advertiser-Id
//   header. Brand scope is entirely separate (X-Brand-Id header → Brand
//   rows with Brand.advertiserId matching the active advertiser).

require('dotenv').config({ quiet: true });

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../models/User');
const Brand = require('../models/Brand');
const Advertiser = require('../models/Advertiser');
const AdvertiserMembership = require('../models/AdvertiserMembership');

const DEFAULT_TTL = '2h';
const MAX_TTL_SEC = 24 * 60 * 60; // matches real login expiresIn: '24h'

function usage(code = 1) {
  const text = `
Usage: node scripts/mintTestToken.js --email <addr> [options]

  Offline JWT mint for headless UI tests. NO HTTP route exists for this on
  purpose — see the SECURITY block at the top of this file.

Required:
  --email <addr>           User to mint for (User.email). No silent defaults.

Options:
  --ttl <duration>         Token lifetime. Default ${DEFAULT_TTL}. Max 24h
                           (real login TTL). Accepts Ns/Nm/Nh or bare seconds.
  --advertiser-id <id>     Prefer this advertiser (must be an active membership).
  --brand-id <id>          Prefer this brand (must belong to the chosen advertiser).
  --list-brands            Print brands for the resolved advertiser to stderr.
  --json                   Emit one JSON object on stdout:
                           {token, brandId, advertiserId, expiresAt, email}
  -h, --help               This text.

Env (required):
  JWT_SECRET               Same secret the web service uses to verify tokens.
  MONGODB_URI              DB holding User / AdvertiserMembership / Brand rows.

Stdout: token only (or --json object). Everything else → stderr.
A token alone is not enough for the SPA — also set localStorage.brand_id
and localStorage.advertiser_id from the stderr (or --json) fields.
`.trim();
  process.stderr.write(text + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    email: null,
    ttl: DEFAULT_TTL,
    advertiserId: null,
    brandId: null,
    listBrands: false,
    json: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) {
        throw new Error(`Missing value after ${a}`);
      }
      return v;
    };
    if (a === '--email') out.email = next();
    else if (a === '--ttl') out.ttl = next();
    else if (a === '--advertiser-id') out.advertiserId = next();
    else if (a === '--brand-id') out.brandId = next();
    else if (a === '--list-brands') out.listBrands = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

/**
 * Parse a TTL into seconds. Cap at 24h so a fat-fingered harness cannot
 * mint a longer-lived session credential than Google OAuth itself issues.
 * jsonwebtoken accepts both string forms ('2h') and second counts; we
 * normalise to seconds so the cap is a pure number comparison.
 */
function ttlToSeconds(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('--ttl must be a non-empty duration');
  let sec;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/i.exec(s);
  if (!m) throw new Error(`Unrecognised --ttl "${raw}" (try 2h, 90m, 3600)`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--ttl must be positive, got ${raw}`);
  const unit = (m[2] || 's').toLowerCase();
  if (unit === 'h') sec = n * 3600;
  else if (unit === 'm') sec = n * 60;
  else sec = n;
  sec = Math.floor(sec);
  if (sec > MAX_TTL_SEC) {
    throw new Error(`--ttl exceeds max 24h (real login TTL); got ${raw}`);
  }
  if (sec < 1) throw new Error(`--ttl too short: ${raw}`);
  return sec;
}

function logErr(...parts) {
  process.stderr.write(parts.join(' ') + '\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    logErr(`error: ${err.message}`);
    usage(1);
  }
  if (args.help) usage(0);

  // Hard refuse without an explicit secret. Never embed, default, or guess.
  if (!process.env.JWT_SECRET) {
    logErr('error: JWT_SECRET is not set in the environment.');
    logErr('Refusing to mint — a missing secret would either crash at verify');
    logErr('time or (if we invented one) produce tokens the server cannot read.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    logErr('error: MONGODB_URI is not set in the environment.');
    process.exit(1);
  }
  if (!args.email || !String(args.email).trim()) {
    logErr('error: --email is required (no default user — silent admin mint is a footgun).');
    usage(1);
  }

  let expiresInSec;
  try {
    expiresInSec = ttlToSeconds(args.ttl);
  } catch (err) {
    logErr(`error: ${err.message}`);
    process.exit(1);
  }

  const email = String(args.email).trim().toLowerCase();

  await mongoose.connect(process.env.MONGODB_URI);
  try {
    // User.email is lowercased + trimmed in the schema; still query the
    // stored lowercase form so a mixed-case CLI arg never silently misses.
    const user = await User.findOne({ email }).lean();
    if (!user) {
      logErr(`error: no User found for email "${email}".`);
      logErr('This script never creates users — sign in once via Google OAuth,');
      logErr('or use an email that already exists in this database.');
      process.exit(1);
    }

    // Mirror requireAuth membership pick: active only, most-recent accepted first.
    const memberships = await AdvertiserMembership.find({
      userId: user._id,
      status: 'active'
    }).sort({ acceptedAt: -1 }).lean();

    // Legacy Phase-1 path: User.advertiserId set, membership row missing.
    // requireAuth self-heals this at request time; we surface it but do NOT
    // write — this CLI is read-only against identity state.
    if (memberships.length === 0 && user.advertiserId) {
      logErr('warn: user has User.advertiserId but no active AdvertiserMembership.');
      logErr('      requireAuth would self-heal on first request; this script does not write.');
      logErr(`      legacy advertiserId=${user.advertiserId}`);
    }

    let advertiserId = null;
    if (args.advertiserId) {
      const hit = memberships.find(m => String(m.advertiserId) === String(args.advertiserId));
      if (!hit) {
        // Also allow the legacy single-pointer so a pre-membership user can
        // still be targeted explicitly for onboarding-adjacent tests.
        if (user.advertiserId && String(user.advertiserId) === String(args.advertiserId)) {
          advertiserId = String(user.advertiserId);
        } else {
          logErr(`error: user is not an active member of advertiser ${args.advertiserId}.`);
          if (memberships.length) {
            logErr('active memberships:');
            for (const m of memberships) {
              logErr(`  ${m.advertiserId}  role=${m.role}`);
            }
          }
          process.exit(1);
        }
      } else {
        advertiserId = String(hit.advertiserId);
      }
    } else if (memberships.length > 0) {
      advertiserId = String(memberships[0].advertiserId);
    } else if (user.advertiserId) {
      advertiserId = String(user.advertiserId);
    }

    let brands = [];
    if (advertiserId) {
      brands = await Brand.find({ advertiserId })
        .select('_id name nameNormalized')
        .sort({ name: 1 })
        .lean();
    }

    if (args.listBrands) {
      if (!advertiserId) {
        logErr('brands: (none — user has no advertiser context)');
      } else if (brands.length === 0) {
        logErr(`brands for advertiser ${advertiserId}: (none)`);
      } else {
        logErr(`brands for advertiser ${advertiserId}:`);
        for (const b of brands) {
          logErr(`  ${b._id}  ${b.name}${b.nameNormalized ? `  (${b.nameNormalized})` : ''}`);
        }
      }
    }

    let brandId = null;
    if (args.brandId) {
      if (!advertiserId) {
        logErr('error: --brand-id requires a resolved advertiser (membership or --advertiser-id).');
        process.exit(1);
      }
      const hit = brands.find(b => String(b._id) === String(args.brandId));
      if (!hit) {
        logErr(`error: brand ${args.brandId} is not under advertiser ${advertiserId}.`);
        process.exit(1);
      }
      brandId = String(hit._id);
    } else if (brands.length > 0) {
      // Same sort /api/me uses (name asc) — first is a stable default for
      // single-brand tenants; multi-brand operators should pass --brand-id
      // after --list-brands.
      brandId = String(brands[0]._id);
    }

    // Exact claim keys as routes/auth.js:25-32. userId as string — real
    // tokens carry a stringified ObjectId after JSON serialisation of the
    // Mongoose doc id from the strategy callback.
    const claims = {
      id:     user.googleId,
      userId: String(user._id),
      email:  user.email,
      name:   user.displayName || '',
      photo:  user.photoUrl || null
    };

    const token = jwt.sign(claims, process.env.JWT_SECRET, {
      expiresIn: expiresInSec
    });

    // Decode exp from the signed token rather than inventing one — stays
    // consistent with whatever clock/rounding jsonwebtoken applied.
    const decoded = jwt.decode(token);
    const expiresAt = decoded && decoded.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + expiresInSec * 1000).toISOString();

    // Status → stderr only. Never print JWT_SECRET. Never print the token
    // here — stdout is reserved for capture.
    logErr(`minted for ${user.email}  userId=${user._id}  ttl=${expiresInSec}s  exp=${expiresAt}`);
    if (advertiserId) {
      const adv = await Advertiser.findById(advertiserId).select('name slug').lean();
      logErr(`advertiser_id=${advertiserId}${adv ? `  (${adv.name})` : ''}`);
    } else {
      logErr('advertiser_id=(none)  SPA will hit 403 NO_ADVERTISER / onboarding');
    }
    if (brandId) {
      const b = brands.find(x => String(x._id) === brandId);
      logErr(`brand_id=${brandId}${b ? `  (${b.name})` : ''}`);
    } else {
      logErr('brand_id=(none)  set after the user creates/selects a brand');
    }
    logErr('SPA localStorage keys: token, advertiser_id, brand_id');
    logErr('(A token alone is not enough — inject brand_id + advertiser_id too.)');

    if (args.json) {
      // Single JSON object on stdout for harness capture. No trailing chatter.
      process.stdout.write(JSON.stringify({
        token,
        brandId,
        advertiserId,
        expiresAt,
        email: user.email
      }) + '\n');
    } else {
      // Token only — one line so TOKEN=$(…) stays clean.
      process.stdout.write(token + '\n');
    }
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err && err.stack ? err.stack : err}\n`);
  mongoose.connection.close().catch(() => {}).finally(() => process.exit(2));
});
