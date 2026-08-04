#!/usr/bin/env node
//
// setVerifiedBrandFonts.js — record a brand's REAL typeface, verified by hand
// against the live site, for brands whose scrape left Brand.fontFamily empty.
//
// Owner, 2026-08-04: "make sure that the brands you choose have actual fonts in
// their records, if needed check on their websites or meta ads."
//
// This is DATA CURATION, not ingestion — it touches no scraper and no pipeline.
// It writes one field, Brand.fontFamily, and only when that field is currently
// empty (never overwrites an existing value, never touches curatedFields, so a
// future scrape can still correct it).
//
//   node scripts/setVerifiedBrandFonts.js            # dry run, prints the plan
//   node scripts/setVerifiedBrandFonts.js --apply
//
// EVIDENCE: each entry below was read from the live site's COMPUTED styles
// (getComputedStyle on h1/h2/h3/body plus document.fonts), not from a brand
// guideline PDF or memory. `family` is the heading face, because that is what
// Brand.fontFamily feeds (heading + body roles in fontResolverService).
//
// Only families that resolve EXACTLY are worth recording for this purpose — a
// proprietary name we hold no file for resolves to a tone-matched lookalike,
// which is not the brand's face. Two brands were checked and deliberately NOT
// written for that reason:
//   Vuori Clothing  — aktiv-grotesk (Adobe Fonts, proprietary). The stored
//                     "Aktiv Grotesk" is already CORRECT; it simply cannot be
//                     served, so Vuori can only ever be a substitution.
//   Fellow Products — Fellow Solar (headings) + Sohne (body), both proprietary.
//                     The sibling "Fellow" row already records Fellow Solar.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env') });
const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const { resolveFamily, normalizeFontFamily } = require('../services/fontResolverService');

const APPLY = process.argv.includes('--apply');

const VERIFIED = [
  {
    brand: 'GymShark',
    family: 'Montserrat',
    site: 'gymshark.com',
    evidence: 'h1/h2/h3 computed "Montserrat" weight 700; body Roboto. document.fonts also ' +
      'carries Anton, Bebas Neue and Druk Condensed Super (campaign display faces).',
  },
  {
    brand: 'Peloton',
    family: 'Inter',
    site: 'onepeloton.com',
    evidence: 'h1 computed "Inter" weight 600, h2 500, body 300; brandon-grotesque also loaded.',
  },
  {
    brand: 'Soludos 2',
    family: 'Newsreader',
    site: 'soludos.com',
    evidence: 'h1/h2 computed "Newsreader" weight 500; body/buttons DM Sans. NOTE the sibling ' +
      '"Soludos" row stores "Poppins", which the live site no longer uses anywhere.',
  },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (pass --apply to write) ===');

  for (const v of VERIFIED) {
    const brand = await Brand.findOne({ name: v.brand }).lean();
    if (!brand) { console.log(`⏭  ${v.brand}: no such brand`); continue; }
    if (brand.fontFamily) {
      console.log(`⏭  ${v.brand}: already has fontFamily='${brand.fontFamily}' — never overwritten`);
      continue;
    }
    // Prove it is servable before recording it; an unservable name is worse than
    // an empty field because it looks like real data.
    const fam = normalizeFontFamily(v.family);
    const entry = fam ? await resolveFamily(fam, { brand, weight: 700, role: 'heading', quiet: true }) : null;
    if (!entry || entry.exact === false) {
      console.log(`✖  ${v.brand}: '${v.family}' does not resolve exactly — refusing to record a lookalike`);
      continue;
    }
    console.log(`✅ ${v.brand}: fontFamily → '${v.family}' (${entry.source})`);
    console.log(`     ${v.site} — ${v.evidence}`);
    if (APPLY) {
      await Brand.updateOne({ _id: brand._id }, { $set: { fontFamily: v.family } });
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('💥', err); process.exit(1); });
