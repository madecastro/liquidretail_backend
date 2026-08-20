#!/usr/bin/env node
//
// backfillBrandFontGenerics.js — record the serif/sans classification each
// brand's OWN stylesheet already states for its own typefaces.
//
// WHY (2026-08-20, follow-up to PR #261 §5)
// -----------------------------------------
// brandFontIngestService now captures the CSS generic that sits beside the
// concrete family in a storefront's `font-family` declarations — e.g. Marine
// Layer ships `font-family: Seriously Nostalgic, serif`, so the brand itself
// tells us that face is a SERIF even though its NAME matches no serif keyword
// and its font file's OS/2 panose is all-zeros. The static ad prompt reads
// that generic (services/fontClassification.js) instead of guessing from the
// family name, which is what made a brand's static ads render sans-serif
// while its video ads correctly rendered the same brand as a serif.
//
// Brands ingested BEFORE that change have no *Generic fields, so nothing
// changes for them until this backfill runs — Brand.fontIngestedAt exists
// precisely to stop the pipeline re-crawling storefronts, so there is no
// natural refresh that would pick it up.
//
// WHAT THIS WRITES — and everything it refuses to touch
// ----------------------------------------------------
// ONLY the three new fields:
//     websiteFontUsage.headingGeneric
//     websiteFontUsage.bodyGeneric
//     websiteFontUsage.buttonGeneric
// It never rewrites heading/body/button themselves, never touches
// customFonts, fontFamily, curatedFields, fontIngestedAt or evidence, and
// never downloads or re-uploads a font file. A storefront that has been
// redesigned since ingest must not silently have its recorded typefaces
// rewritten by a classification backfill — if the families have changed, that
// is a re-ingest decision, not this script's.
//
// It also refuses to OVERWRITE a generic that is already recorded, so
// re-running is idempotent and a hand-corrected value stays put.
//
//   node scripts/backfillBrandFontGenerics.js                 # dry run (default)
//   node scripts/backfillBrandFontGenerics.js --apply
//   node scripts/backfillBrandFontGenerics.js --brand "Marine Layer 2"
//   node scripts/backfillBrandFontGenerics.js --limit 5 --apply
//
// Same dry-run-by-default convention as scripts/setVerifiedBrandFonts.js.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const axios = require('axios');
const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const {
  aggregateFontUsageAcrossSheets, collectStylesheets, UA,
} = require('../services/brandFontIngestService');

const APPLY = process.argv.includes('--apply');
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const ONLY_BRAND = argValue('--brand');
const LIMIT = Number(argValue('--limit')) || 0;
const GENERIC_FIELDS = ['headingGeneric', 'bodyGeneric', 'buttonGeneric'];

/**
 * Re-derive websiteFontUsage from the brand's live site using the SAME sheet
 * collection AND the same scorer ingest uses — `collectStylesheets` (which
 * follows bounded CSS @imports) and `aggregateFontUsageAcrossSheets`.
 *
 * Sharing both is load-bearing, not tidiness. This script's first version
 * hand-rolled its own fetch loop that did NOT follow @import. Themes routinely
 * keep typography in an imported partial, so it could score a strict subset of
 * the evidence, derive a generic that disagrees with what ingest would compute,
 * persist it, and then — because it refuses to overwrite an existing value —
 * freeze that wrong answer permanently. Any future divergence between what the
 * pipeline computes and what this backfill writes is the same bug class.
 */
async function deriveUsage(websiteUrl) {
  const res = await axios.get(websiteUrl, {
    timeout: 20_000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
  const html = typeof res.data === 'string' ? res.data : String(res.data || '');
  const pageUrl = res.request?.res?.responseUrl || websiteUrl;

  const { sheets, errors } = await collectStylesheets(html, pageUrl);
  errors.forEach((e) => console.log(`      · ${e}`));
  if (!sheets.length) return null;

  const usage = aggregateFontUsageAcrossSheets(sheets.map((sheet) => sheet.css));
  return usage.evidence.length ? usage : null;
}

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  const query = { websiteFontUsage: { $ne: null }, websiteUrl: { $nin: [null, ''] } };
  if (ONLY_BRAND) query.name = ONLY_BRAND;
  const brands = await Brand.find(query).select('name websiteUrl websiteFontUsage').lean();

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${brands.length} brand(s) with ingested font usage\n`);

  let planned = 0; let skipped = 0; let failed = 0; let applied = 0; let raced = 0;
  for (const brand of brands) {
    if (LIMIT && planned + skipped + failed >= LIMIT) break;
    const usage = brand.websiteFontUsage || {};

    if (GENERIC_FIELDS.every((f) => usage[f])) {
      skipped++;
      continue; // already recorded — never overwrite
    }

    let derived;
    try {
      derived = await deriveUsage(brand.websiteUrl);
    } catch (err) {
      console.log(`  ✗ ${brand.name}: ${err.message}`);
      failed++;
      continue;
    }
    if (!derived) {
      console.log(`  – ${brand.name}: no font-family evidence on the live site`);
      failed++;
      continue;
    }

    // Only fill fields that are missing, and only for roles whose family
    // STILL matches what we recorded — a role whose face has changed since
    // ingest is a re-ingest question, not a classification one.
    const set = {};
    const notes = [];
    for (const role of ['heading', 'body', 'button']) {
      const field = `${role}Generic`;
      if (usage[field]) continue;
      const generic = derived[field];
      if (!generic) continue;
      const recorded = String(usage[role] || '').trim().toLowerCase();
      const live = String(derived[role] || '').trim().toLowerCase();
      if (!recorded || recorded !== live) {
        notes.push(`${role}: SKIP (recorded "${usage[role]}" != live "${derived[role]}")`);
        continue;
      }
      set[`websiteFontUsage.${field}`] = generic;
      notes.push(`${role}: "${usage[role]}" -> ${generic}`);
    }

    if (!Object.keys(set).length) {
      console.log(`  – ${brand.name}: nothing to write${notes.length ? ` (${notes.join('; ')})` : ''}`);
      skipped++;
      continue;
    }

    console.log(`  ✓ ${brand.name}`);
    notes.forEach((n) => console.log(`      ${n}`));
    planned++;
    if (APPLY) {
      // Write each field under a CONDITION that it is still unset, rather than
      // trusting the snapshot read at the top of this run. The gap between that
      // read and this write is a long network loop (one homepage plus up to
      // MAX_STYLESHEETS sheets per brand), and a re-ingest landing inside it
      // writes the pipeline's own value from the full sheet set. An
      // unconditional $set would silently replace that with this run's older
      // derivation, and the never-overwrite rule would then freeze it.
      // matchedCount 0 means someone else got there first — correct, so it is
      // reported rather than retried.
      for (const [dotted, value] of Object.entries(set)) {
        const field = dotted.split('.').pop();
        const result = await Brand.updateOne(
          { _id: brand._id, [`websiteFontUsage.${field}`]: { $in: [null, ''] } },
          { $set: { [dotted]: value } }
        );
        if (result.matchedCount === 0) {
          console.log(`      ! ${field}: skipped — written by another process since this run started`);
          raced++;
        } else {
          applied++;
        }
      }
    }
  }

  console.log(
    `\n${APPLY ? `applied ${applied} field(s)` : `would write ${planned} brand(s)`}; ` +
    `${skipped} skipped, ${failed} with no usable evidence` +
    (raced ? `, ${raced} lost a race to a concurrent write` : '')
  );
  if (!APPLY && planned) console.log('re-run with --apply to write.');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(`backfillBrandFontGenerics failed: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
