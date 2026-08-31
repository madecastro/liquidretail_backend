#!/usr/bin/env node
'use strict';
/**
 * clearConfigAbsentMetaFontStamps — one-off remediation for brands stamped
 * `metaFontsIngestedAt` by the pre-fix bug in metaAdsFontService /
 * brandFontPersistenceService.applyMetaFontsResult.
 *
 * THE BUG THIS UNDOES (fixed in this same PR, see services/metaAdsFontService.js
 * `billableAttempted` and brandFontPersistenceService.applyMetaFontsResult):
 * `metaFontsIngestedAt` used to be stamped unconditionally on every
 * identifyBrandAdFonts outcome, including a run where NO source was even
 * configured to attempt — no Meta Ads credential connected, no
 * APIFY_ADLIB_ACTOR set, so no vision call and no Apify run ever happened,
 * nothing was billed. Because `wantMetaFonts` in brandEnrichmentService.js
 * gates purely on `!brand.metaFontsIngestedAt`, a brand stamped this way is
 * PERMANENTLY skipped by every future enrichment run, even after an operator
 * connects Meta Ads or sets APIFY_ADLIB_ACTOR — the stamp itself never goes
 * away on its own. Measured 2026-08-31: all 9 brands in production were
 * stamped from exactly this branch.
 *
 * The code fix in this PR stops the bug going forward. It does nothing for
 * the 9 (or however many by the time this runs) already-stamped rows — this
 * script is the one-off that unsticks them, so the NEXT enrichment run can
 * try again once config is actually fixed. It fixes NOTHING about the config
 * itself (connecting Meta Ads, setting APIFY_ADLIB_ACTOR/APIFY_TOKEN) — those
 * remain ops/owner actions. Clearing the stamp on a brand whose config is
 * still missing is harmless and correct: the next run will simply reach the
 * exact same config-absence outcome and (under the fixed code) will NOT
 * re-stamp it, so it stays retryable for free until config is actually
 * fixed.
 *
 * WHAT COUNTS AS "config-absence, nothing spent" HERE.
 * These rows predate the `billableAttempted` field (it did not exist when
 * they were stamped), so there is no structured signal to read back — only
 * the free-text `metaFontsIngestError` string that was recorded at the time.
 * This script is therefore, unavoidably, a STRING match against that
 * historical text — unlike the code fix, which uses a typed field precisely
 * to avoid this fragility going forward. To keep the string match honest:
 *   · every ';'-separated segment of metaFontsIngestError must match a known
 *     ZERO-SPEND pattern (see ZERO_SPEND_PATTERNS below) — enumerated
 *     directly from every `errors.push(...)` call site in
 *     services/metaAdsFontService.js that runs BEFORE any billable action.
 *   · a single unrecognised segment (including any `vision:` / `vision
 *     parse:` / `vision notes:` segment, or an `adlibrary:` segment that is
 *     NOT one of the two pre-submit messages) disqualifies the row —
 *     conservative by construction: money-adjacent, so default to leaving a
 *     ambiguous row stamped rather than guessing it clear.
 *
 * REPORT MODE IS THE DEFAULT and touches nothing. --apply writes.
 *
 * Must be run from the repo root (node scripts/clearConfigAbsentMetaFontStamps.js).
 *
 *   node scripts/clearConfigAbsentMetaFontStamps.js                # dry run, all brands
 *   node scripts/clearConfigAbsentMetaFontStamps.js --brand Foo    # dry run, one brand
 *   node scripts/clearConfigAbsentMetaFontStamps.js --apply        # actually clear
 *
 * COST: zero. This script only reads Brand docs and, with --apply, clears two
 * fields on the ones it identifies. It never calls identifyBrandAdFonts, Meta,
 * Apify, or any vision model.
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', 'defaults.env') });

const mongoose = require('mongoose');
const Brand = require('../models/Brand');

// Every prefix here is a verbatim (or near-verbatim, prefix-matched) copy of
// an `errors.push(...)` call site in services/metaAdsFontService.js that
// executes strictly BEFORE any billable action (vision chatCompletion call,
// or an Apify actor run submit). If that file's error text ever changes,
// this list needs a matching update — it is intentionally NOT derived
// programmatically from the source, because a legacy stamp's stored string
// is frozen at whatever the code said the day it was written.
const ZERO_SPEND_PATTERNS = [
  /^campaign-docs: /,                                    // tier 1 exception (DB read, no network)
  /^connected: /,                                        // ALL of tier 2 is free Graph API — every
                                                          // failure branch (no-meta-ads-cred,
                                                          // no-ad-account, decrypt, creative id walk
                                                          // failed, creative batch failed, account has
                                                          // no ad creatives) happens before or during an
                                                          // unbilled call.
  /^adlibrary: skipped \(APIFY_ADLIB_ACTOR not set\)$/,  // tier 3 never invoked — actor unconfigured
  /^adlibrary: brand has neither name nor website to search by$/, // tier 3 never invoked — no search key
  /^disabled: META_ADS_FONTS_ENABLED=false$/,            // kill switch, before any tier ran
  /^brand has no id$/,                                   // guard clause, before any tier ran
  /^no ad creatives found$/,                              // catch-all used only when every tier came
                                                          // back with literally nothing AND pushed no
                                                          // error of its own
];

// Deliberately NOT included, so a segment matching one of these disqualifies
// the row: `vision:` / `vision parse:` / `vision notes:` (the vision call was
// invoked — billable, regardless of outcome), a bare `adlibrary: <message>`
// that isn't one of the two pre-submit strings above (the actor run was
// submitted and either threw after starting or returned unusable items —
// Apify bills on submit, not on a useful result).

/**
 * @param {string|null} errorText  the row's frozen `metaFontsIngestError`
 * @param {object|null} usage      the row's `metaAdsFontUsage` — REQUIRED to
 *   close the gap documented immediately below. Omitting it falls back to the
 *   string-only judgement, which is NOT safe on its own.
 */
function classify(errorText, usage = null) {
  // ── EVIDENCE GATE (added on review, before this script was ever run) ──
  //
  // The string match alone is NOT sufficient, because `connected: …` is
  // whitelisted wholesale as free (true — the Graph API does not bill) while
  // a `connected:` segment does NOT imply the run stopped there:
  //   metaAdsFontService gates tier 2 on `images.length < MIN_USABLE_IMAGES`
  //   (2), not on `images.length === 0`. So tier 1 can supply exactly ONE
  //   image, tier 2 then runs and pushes e.g. `connected: no-ad-account`,
  //   tier 3 is skipped (it needs images.length === 0), and the BILLABLE
  //   vision call runs anyway on that single image. On success the row is
  //   persisted with metaFontsIngestError = "connected: no-ad-account" and
  //   nothing else — a string that every pattern above happily accepts.
  //   Clearing that stamp makes the next enrichment run re-pay the vision
  //   call. Small money, but this whole PR exists to stop exactly that.
  //
  // A persisted identification result is positive proof the vision call ran,
  // independent of how innocuous the error text looks. `evidence` is the
  // strongest signal (it is only ever built from a parsed vision response),
  // and heading/body cover a result shape that carried a family without
  // per-image evidence rows.
  //
  // Residual, stated honestly: a vision call that ran and identified NOTHING
  // leaves usage empty AND may leave only `connected:` text, so it is still
  // indistinguishable from a true non-run using persisted fields alone —
  // `imagesUsed` and `billableAttempted` are not stored on the Brand. That
  // case over-clears by one free retry of a brand that has ~no readable ads.
  // Bounded and much rarer than the success case this now catches; closing it
  // properly would need a schema field, which is out of scope for a one-off.
  if (usage && (usage.heading || usage.body
    || (Array.isArray(usage.evidence) && usage.evidence.length > 0))) {
    return {
      zeroSpend: false,
      reason: 'metaAdsFontUsage holds an identification result — the vision call ran (billable), '
        + 'regardless of the error text',
    };
  }

  if (!errorText || !String(errorText).trim()) {
    // No error text recorded at all. We cannot positively prove this was a
    // config-absence non-run (it could equally be a genuine success that
    // simply had nothing to say, or a hand-written stamp). Leave it alone.
    return { zeroSpend: false, reason: 'no metaFontsIngestError recorded — cannot classify, leaving as-is' };
  }
  const segments = String(errorText).split('; ').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { zeroSpend: false, reason: 'empty after split — leaving as-is' };
  const unmatched = segments.filter((seg) => !ZERO_SPEND_PATTERNS.some((rx) => rx.test(seg)));
  if (unmatched.length) {
    return { zeroSpend: false, reason: `unrecognised/billable segment(s): ${JSON.stringify(unmatched)}` };
  }
  return { zeroSpend: true, reason: 'every segment matches a known zero-spend, pre-billing pattern' };
}

function parseArgs(argv) {
  const out = { apply: false, brand: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (a.startsWith('--') && eq > 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else if (a.startsWith('--')) {
      key = a.slice(2); val = argv[i + 1];
      if (val === undefined || String(val).startsWith('--')) {
        console.error(`--${key} needs a value`); process.exit(1);
      }
      i++;
    } else { console.error(`Unexpected argument: ${a}`); process.exit(1); }

    if (key === 'brand') { out.brand = val; continue; }
    if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || n < 1) { console.error('--limit must be >= 1'); process.exit(1); }
      out.limit = n; continue;
    }
    console.error(`Unknown flag: --${key}`); process.exit(1);
  }
  return out;
}
const opts = parseArgs(process.argv.slice(2));

const looksLikeObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(String(v || '').trim());
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findBrandByNameOrId(val) {
  const trimmed = String(val || '').trim();
  if (!trimmed) return null;
  if (looksLikeObjectId(trimmed)) {
    const byId = await Brand.findById(trimmed);
    if (byId) return byId;
  }
  const exact = await Brand.findOne({ nameNormalized: trimmed.toLowerCase() });
  if (exact) return exact;
  const rx = new RegExp(`^${escapeRegex(trimmed)}$`, 'i');
  const candidates = await Brand.find({ name: rx });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    console.error(`"${trimmed}" is ambiguous — matches ${candidates.length} brands. Use an _id.`);
    return null;
  }
  return null;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — cannot run.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`🔌 connected to ${mongoose.connection.host}`);
  console.log('─'.repeat(70));
  console.log(`  clearConfigAbsentMetaFontStamps — ${opts.apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

  let brands;
  if (opts.brand) {
    const one = await findBrandByNameOrId(opts.brand);
    if (!one) { console.error(`brand not found: ${opts.brand}`); await mongoose.disconnect(); process.exit(1); }
    brands = one.metaFontsIngestedAt ? [one] : [];
    if (!brands.length) console.log(`  "${one.name}" has no metaFontsIngestedAt stamp — nothing to do.`);
  } else {
    brands = await Brand.find({ metaFontsIngestedAt: { $ne: null } })
      .select('name metaFontsIngestedAt metaFontsIngestError metaAdsFontUsage')
      .sort({ name: 1 });
  }
  if (opts.limit) brands = brands.slice(0, opts.limit);
  console.log(`  ${brands.length} stamped brand(s) to inspect\n`);

  const toClear = [];
  const leaveAlone = [];
  for (const b of brands) {
    const { zeroSpend, reason } = classify(b.metaFontsIngestError, b.metaAdsFontUsage);
    const row = {
      id: String(b._id),
      name: b.name || String(b._id),
      stampedAt: b.metaFontsIngestedAt ? new Date(b.metaFontsIngestedAt).toISOString() : null,
      error: b.metaFontsIngestError || null,
      reason,
    };
    if (zeroSpend) toClear.push(row); else leaveAlone.push(row);
  }

  console.log(`  WOULD CLEAR (config-absence, nothing spent): ${toClear.length}`);
  for (const r of toClear) {
    console.log(`    · ${r.name}  [${r.id}]`);
    console.log(`        stamped     : ${r.stampedAt}`);
    console.log(`        error       : ${r.error}`);
  }
  console.log(`\n  LEAVING ALONE (not provably a config-absence non-run): ${leaveAlone.length}`);
  for (const r of leaveAlone) {
    console.log(`    · ${r.name}  [${r.id}] — ${r.reason}`);
  }

  if (!opts.apply) {
    console.log(`\n  Dry run only — nothing was written. Re-run with --apply to clear the ${toClear.length} row(s) above.`);
    await mongoose.disconnect();
    console.log('🔌 disconnected');
    return;
  }

  if (!toClear.length) {
    console.log('\n  Nothing to clear.');
    await mongoose.disconnect();
    console.log('🔌 disconnected');
    return;
  }

  console.log(`\n  Clearing ${toClear.length} row(s)...`);
  let cleared = 0;
  for (const r of toClear) {
    await Brand.updateOne(
      { _id: r.id },
      { $set: { metaFontsIngestedAt: null, metaFontsIngestError: null } }
    );
    cleared++;
    console.log(`    ✓ cleared ${r.name}  [${r.id}]`);
  }
  console.log(`\n  done: ${cleared} brand(s) unstuck. The next enrichment run (or`);
  console.log(`  scripts/backfillBrandFonts.js --apply) will retry them for free —`);
  console.log(`  it will only spend money once Meta Ads is connected and/or`);
  console.log(`  APIFY_ADLIB_ACTOR is configured for that brand.`);
  await mongoose.disconnect();
  console.log('🔌 disconnected');
}

module.exports = { classify, ZERO_SPEND_PATTERNS };

// Guarded so scripts/verifyClearConfigAbsentMetaFontStamps.js can require()
// this file for its pure `classify` export (offline, no DB) without
// triggering a live Mongo connection attempt as a side effect of the import.
if (require.main === module) {
  main().catch((err) => {
    console.error('clearConfigAbsentMetaFontStamps failed:', err);
    process.exit(1);
  });
}
