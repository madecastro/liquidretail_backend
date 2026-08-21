// services/reviewSiteProfileService.js
//
// Persistent memory of how each retailer exposes its reviews.
//
// WHY THIS EXISTS: review-app identifiers are not standardised, and the id a
// store files its reviews under is frequently NOT an id printed on the page.
// gap.com is the proof — its PDP shows pid=130046042 and sku=1300460420010,
// while PowerReviews holds all 2741 reviews under `130046` (the pid minus its
// colour suffix). Discovering that costs a handful of probe requests. Doing it
// once per STORE instead of once per PRODUCT is the difference between ~9k and
// ~45k extra requests on Gap's 9143-product catalog — and a worker restart must
// not throw the knowledge away, which is why this is not just a Map.
//
// THREE LAYERS, same pattern as systemConfigService's canonical scripts:
//   1. process memory — hot path, no I/O
//   2. ReviewSiteProfile collection — survives restarts, shared across workers
//   3. services/reviewSiteProfiles.json — checked-in seed for hosts we have
//      already verified, so a fresh deploy (or a DB reset) starts smart and the
//      known site structures are reviewable in a PR
//
// Everything degrades: with no database, layers 1+3 still work, so adapters and
// their unit tests behave identically without Mongo. A learn() failure is
// logged and swallowed — losing a cache write must never fail a catalog sync.

'use strict';

const path = require('path');
const fs = require('fs');

const LOG = '⭐';
const SEED_FILE = path.join(__dirname, 'reviewSiteProfiles.json');

// host → profile. Also caches negative lookups (null) so a host with no
// profile doesn't hit the DB on every product.
const MEM = new Map();

let SEED = null;

function loadSeed() {
  if (SEED) return SEED;
  SEED = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    for (const [host, profile] of Object.entries(raw)) {
      if (host.startsWith('_')) continue;          // _readme and friends
      SEED.set(host.toLowerCase(), Object.assign({ host, origin: 'seed' }, profile));
    }
  } catch (err) {
    console.warn(`${LOG}  review site profiles: seed unreadable (${err.message})`);
  }
  return SEED;
}

/** hostOf('https://www.gap.com/x') → 'www.gap.com' */
function hostOf(pageUrl) {
  try {
    return new URL(String(pageUrl)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * getProfile(hostOrUrl) → profile | null   (async)
 * Memory → DB → seed. Never throws.
 */
async function getProfile(hostOrUrl) {
  const host = hostOf(hostOrUrl) || String(hostOrUrl || '').toLowerCase();
  if (!host) return null;
  if (MEM.has(host)) return MEM.get(host);

  let profile = null;
  try {
    // Only worth a query when a connection actually exists — readyState 1 is
    // connected. Otherwise mongoose buffers the op and we would stall a sync.
    const mongoose = require('mongoose');
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const ReviewSiteProfile = require('../models/ReviewSiteProfile');
      profile = await ReviewSiteProfile.findOne({ host }).lean();
    }
  } catch {
    // No DB, no model, no problem — the seed still answers.
  }

  if (!profile) profile = loadSeed().get(host) || null;
  MEM.set(host, profile);
  return profile;
}

/** Synchronous seed/memory-only read, for code paths that cannot await. */
function getProfileSync(hostOrUrl) {
  const host = hostOf(hostOrUrl) || String(hostOrUrl || '').toLowerCase();
  if (!host) return null;
  if (MEM.has(host)) return MEM.get(host);
  return loadSeed().get(host) || null;
}

/**
 * learn(hostOrUrl, profile) → merged profile   (async, best-effort)
 * Records what a successful probe discovered. Memory is updated FIRST so the
 * benefit lands even when the DB write fails.
 */
async function learn(hostOrUrl, profile = {}) {
  const host = hostOf(hostOrUrl) || String(hostOrUrl || '').toLowerCase();
  if (!host) return null;

  const prev = MEM.get(host) || loadSeed().get(host) || null;
  const merged = Object.assign({}, prev, profile, {
    host,
    origin: 'learned',
    verifiedAt: new Date()
  });
  MEM.set(host, merged);

  try {
    const mongoose = require('mongoose');
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return merged;
    const ReviewSiteProfile = require('../models/ReviewSiteProfile');
    // $set only the fields actually observed — a probe that learned an id
    // transform must not blank out a hint another pass recorded.
    const $set = { host, origin: 'learned', verifiedAt: merged.verifiedAt };
    for (const k of ['platform', 'idSource', 'idTrim', 'ldSource', 'hints',
                     'learnedFrom', 'reviewsSeen']) {
      if (profile[k] !== undefined) $set[k] = profile[k];
    }
    await ReviewSiteProfile.updateOne({ host }, { $set }, { upsert: true });
    console.log(
      `${LOG}  learned review profile for ${host}: ` +
      `${merged.platform || '?'} · id=${merged.idSource || '?'}` +
      `${merged.idTrim ? ` −${merged.idTrim}` : ''}` +
      `${merged.reviewsSeen != null ? ` · ${merged.reviewsSeen} reviews` : ''}`
    );
  } catch (err) {
    console.warn(`${LOG}  review profile write failed for ${host}: ${err.message}`);
  }
  return merged;
}

/** Drop cached state — for tests and for an operator forcing a re-probe. */
function clearCache(host = null) {
  if (host) MEM.delete(String(host).toLowerCase());
  else MEM.clear();
}

/** Everything we know, seed + learned, for an operator dump. */
async function listProfiles() {
  const out = new Map();
  for (const [host, p] of loadSeed()) out.set(host, p);
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const ReviewSiteProfile = require('../models/ReviewSiteProfile');
      for (const row of await ReviewSiteProfile.find({}).lean()) {
        out.set(row.host, row);                    // learned wins over seed
      }
    }
  } catch { /* seed-only */ }
  return [...out.values()];
}

module.exports = {
  getProfile,
  getProfileSync,
  learn,
  clearCache,
  listProfiles,
  hostOf,
  SEED_FILE
};
