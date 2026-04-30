#!/usr/bin/env node
//
// dumpLayoutInputCoverage.js — smoke test for canonical template input coverage.
//
// Loads every LayoutInputArtifact for a brand, walks each artifact's `input`
// object against the canonical field map, and prints a coverage matrix:
//   - per field: how many artifacts populated it (out of N total)
//   - per field: example value (truncated) from the first hit
//   - per field: provenance hint (Gemini / catalog / metadata / constant / etc.)
//   - per field: wiring status from the audit (P+T+V / P+T / P-only / C-only)
//
// Usage:
//   node scripts/dumpLayoutInputCoverage.js --brand "Pelagic Gear"
//   node scripts/dumpLayoutInputCoverage.js --brandId 69f140347add58165604d6d6
//   node scripts/dumpLayoutInputCoverage.js --brand "Pelagic Gear" --csv coverage.csv
//
// Provenance + wiring tags come from the gap audit, not from runtime tracing —
// if a value is null in the artifact you can see WHERE in the producer the
// branch is supposed to come from, but not which sub-branch fell through.
// Step 2 (provenance trace) would plumb actual source-of-record per path.

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const Brand               = require('../models/Brand');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');

// ── Canonical field map ──────────────────────────────────────────────
//
// Every leaf path the producer writes (or claims to write). source = where
// the value comes from (one-line provenance hint). wired = audit verdict on
// downstream consumption. Sorted in the same top-down order as the producer's
// docstring so the matrix reads naturally.
const FIELD_MAP = {
  'template':                              { source: 'service',                wired: 'P+T+V' },
  'aspect_ratio':                          { source: 'service',                wired: 'P+T+V' },

  'theme.style':                           { source: 'gemini',                 wired: 'P (orphan)' },
  'theme.background_style':                { source: 'gemini',                 wired: 'P (orphan)' },
  'theme.emphasis':                        { source: 'gemini',                 wired: 'P (orphan)' },

  'brand.name':                            { source: 'match/metadata',         wired: 'P+T+V' },
  'brand.tagline':                         { source: 'catalog',                wired: 'P+T' },
  'brand.logo':                            { source: 'catalog',                wired: 'P+T+V' },
  'brand.primary_color':                   { source: 'catalog/palette',        wired: 'P+T+V' },
  'brand.secondary_color':                 { source: 'catalog/palette',        wired: 'P+T' },
  'brand.accent_color':                    { source: 'catalog/palette',        wired: 'P+T' },
  'brand.font_family':                     { source: 'catalog',                wired: 'P+T' },
  'brand.palette':                         { source: 'catalog',                wired: 'P+T' },
  'brand.tone':                            { source: 'catalog/gemini',         wired: 'P+T' },

  'product.id':                            { source: 'match.details',          wired: 'P (orphan)' },
  'product.name':                          { source: 'match.identification',   wired: 'P+T+V' },
  'product.category':                      { source: 'metadata/yolo',          wired: 'P (orphan)' },
  'product.price':                         { source: 'match.details',          wired: 'P+T+V' },
  'product.currency':                      { source: 'match.details',          wired: 'P (orphan)' },
  'product.description':                   { source: 'match/detection',        wired: 'P (orphan)' },
  'product.short_benefits':                { source: 'gemini',                 wired: 'P (orphan)' },
  'product.badges':                        { source: 'gemini/outcome',         wired: 'P+T' },
  'product.hero_media.image':              { source: 'pickHeroMedia',          wired: 'P+T' },
  'product.hero_media.video':              { source: 'pickHeroMedia',          wired: 'P+T' },
  'product.secondary_media.image':         { source: 'pickSecondaryMedia',     wired: 'P+T' },
  'product.secondary_media.video':         { source: 'pickSecondaryMedia',     wired: 'P+T' },

  'creator.name':                          { source: 'metadata.creatorHandle', wired: 'P+T' },
  'creator.handle':                        { source: 'metadata.creatorHandle', wired: 'P+T' },
  'creator.platform':                      { source: 'constant (instagram)',   wired: 'C+T' },
  'creator.avatar':                        { source: '<undefined>',            wired: 'C (gap)' },
  'creator.portrait_media.image':          { source: 'pickCreatorMedia',       wired: 'P+T' },
  'creator.portrait_media.video':          { source: 'pickCreatorMedia',       wired: 'P+T' },

  'ugc.post_id':                           { source: 'media.externalId',       wired: 'P (orphan)' },
  'ugc.platform':                          { source: 'constant (instagram)',   wired: 'C+T' },
  'ugc.post_type':                         { source: 'constant (ugc)',         wired: 'C (orphan)' },
  'ugc.caption':                           { source: 'metadata.caption',       wired: 'P+T' },
  'ugc.media.image':                       { source: 'pickUgcMedia',           wired: 'P+T' },
  'ugc.media.video':                       { source: 'pickUgcMedia',           wired: 'P+T' },
  'ugc.likes':                             { source: 'platformStats',          wired: 'P+T' },
  'ugc.comments':                          { source: 'platformStats',          wired: 'P+T' },
  'ugc.shares':                            { source: 'platformStats',          wired: 'P (orphan, dup)' },
  'ugc.saves':                             { source: 'platformStats',          wired: 'P (orphan, dup)' },
  'ugc.rights_approved':                   { source: 'media.rights',           wired: 'P (orphan)' },

  'social_proof.rating_value':             { source: 'match/brand',            wired: 'P+T+V' },
  'social_proof.review_count':             { source: 'match/brand',            wired: 'P+T+V' },
  'social_proof.trusted_by_text':          { source: 'gemini',                 wired: 'P+T' },
  'social_proof.proof_badges':             { source: 'derived',                wired: 'P+T' },
  'social_proof.primary_quote.text':       { source: 'gemini',                 wired: 'P+T+V' },
  'social_proof.primary_quote.attribution':{ source: 'gemini',                 wired: 'P+T' },
  'social_proof.primary_quote.source':     { source: 'gemini',                 wired: 'P+T' },
  'social_proof.secondary_quotes':         { source: 'gemini',                 wired: 'P+T' },

  'performance.engagement.likes':          { source: 'platformStats',          wired: 'P+T' },
  'performance.engagement.comments':       { source: 'platformStats',          wired: 'P+T' },
  'performance.engagement.shares':         { source: 'platformStats',          wired: 'P (orphan)' },
  'performance.engagement.saves':          { source: 'platformStats',          wired: 'P (orphan)' },
  'performance.engagement.views':          { source: 'platformStats',          wired: 'P (orphan)' },
  'performance.metrics':                   { source: 'gemini',                 wired: 'P+T' },

  'cta.text':                              { source: 'gemini/outcome',         wired: 'P+T+V' },
  'cta.url':                               { source: 'productUrl/outcome',     wired: 'P+T' },
  'cta.subtext':                           { source: 'outcome breadcrumb',     wired: 'P (orphan)' },
  'cta.offer_text':                        { source: 'gemini',                 wired: 'P (orphan)' },

  'trust.retailer_logos':                  { source: 'sellers',                wired: 'P (orphan)' },
  'trust.trusted_by_text':                 { source: 'gemini',                 wired: 'P+T' },
  'trust.certifications':                  { source: '<undefined>',            wired: 'C (gap)' },
  'trust.press_mentions':                  { source: '<undefined>',            wired: 'C (gap)' },

  'copy.headline':                         { source: 'gemini',                 wired: 'P+T+V' },
  'copy.subheadline':                      { source: 'gemini',                 wired: 'P+T' },
  'copy.eyebrow':                          { source: 'gemini',                 wired: 'P (orphan, easy win)' },
  'copy.highlight_text':                   { source: 'gemini',                 wired: 'P (orphan)' },
  'copy.disclaimer':                       { source: 'options',                wired: 'P (orphan)' },

  'layout_options.show_logo':              { source: 'derived',                wired: 'P (orphan)' },
  'layout_options.show_price':             { source: 'derived',                wired: 'P (orphan)' },
  'layout_options.show_rating':            { source: 'derived',                wired: 'P (orphan)' },
  'layout_options.show_engagement':        { source: 'derived',                wired: 'P (orphan)' },
  'layout_options.show_badges':            { source: 'derived',                wired: 'P (orphan)' },
  'layout_options.show_cta':               { source: 'derived',                wired: 'P (orphan)' },

  'defaults.fallback_quote':               { source: 'constant/outcome',       wired: 'P+T+V' },
  'defaults.fallback_headline':            { source: 'constant/outcome',       wired: 'P+T+V' },
  'defaults.cta_text':                     { source: 'constant/outcome',       wired: 'P+T+V' },
  'defaults.product_name':                 { source: 'constant',               wired: 'P+T' },

  // Overlay-mode templates (testimonial_overlay) only.
  'placement.decisions':                   { source: 'overlayPlacement',       wired: 'P (overlay-only)' },
  'placement.analysis.restrictions':       { source: 'overlayPlacement',       wired: 'P (overlay-only)' },
  'placement.analysis.grids':              { source: 'overlayPlacement',       wired: 'P (overlay-only)' },
  'placement.analysis.primarySubjectRectPct': { source: 'overlayPlacement',    wired: 'P (overlay-only)' },
  'placement.usingFallbackImage':          { source: 'overlayPlacement',       wired: 'P (overlay-only)' },
  'placement.backgroundMedia.image':       { source: 'overlayPlacement',       wired: 'P (overlay-only)' },
  'placement.backgroundMedia.video':       { source: 'overlayPlacement',       wired: 'P (overlay-only)' }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.brand && !args.brandId) usage();

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, useUnifiedTopology: true
  });

  let brandId  = args.brandId;
  let brandName = args.brand;
  if (!brandId) {
    // Case-insensitive exact match — avoids surprises on "Pelagic Gear" vs "pelagic gear".
    const brand = await Brand.findOne({ name: new RegExp(`^${escapeRegex(brandName)}$`, 'i') }).lean();
    if (!brand) {
      console.error(`Brand "${brandName}" not found`);
      process.exit(1);
    }
    brandId   = brand._id;
    brandName = brand.name;
  } else if (!brandName) {
    const brand = await Brand.findById(brandId).select('name').lean();
    brandName = brand?.name || '(unknown)';
  }

  const artifacts = await LayoutInputArtifact.find({ brandId }).lean();
  if (!artifacts.length) {
    console.error(`No LayoutInputArtifact docs for brand "${brandName}" (${brandId})`);
    console.error('Visit the ad-generation preview for one of this brand\'s media to populate the cache.');
    process.exit(1);
  }

  const templates = [...new Set(artifacts.map(a => a.template))].sort();
  const ratios    = [...new Set(artifacts.map(a => a.aspectRatio))].sort();
  console.log(`\n=== Coverage matrix for "${brandName}" — ${artifacts.length} artifact(s) ===`);
  console.log(`templates: ${templates.join(', ')}`);
  console.log(`ratios:    ${ratios.join(', ')}\n`);

  // Per-field rollup
  const rows = [];
  for (const [path, meta] of Object.entries(FIELD_MAP)) {
    let populated = 0;
    let firstExample = null;
    for (const art of artifacts) {
      const val = getPath(art.input || {}, path);
      if (isPresent(val)) {
        populated++;
        if (firstExample == null) firstExample = val;
      }
    }
    rows.push({
      path,
      populated,
      total:   artifacts.length,
      pct:     Math.round((populated / artifacts.length) * 100),
      example: truncate(firstExample),
      source:  meta.source,
      wired:   meta.wired
    });
  }

  printTable(rows);

  if (args.csv) {
    const lines = ['path,populated,total,pct,example,source,wired'];
    for (const r of rows) {
      lines.push([r.path, r.populated, r.total, r.pct, csvEscape(r.example), csvEscape(r.source), csvEscape(r.wired)].join(','));
    }
    fs.writeFileSync(args.csv, lines.join('\n'));
    console.log(`\nCSV written: ${args.csv}`);
  }

  // Summary
  const totalFields    = rows.length;
  const everPopulated  = rows.filter(r => r.populated > 0).length;
  const alwaysPopulated = rows.filter(r => r.populated === artifacts.length).length;
  const neverPopulated = rows.filter(r => r.populated === 0).length;
  const orphanNever    = rows.filter(r => r.wired.includes('orphan') && r.populated === 0).length;
  const orphanProduced = rows.filter(r => r.wired.includes('orphan') && r.populated > 0).length;
  console.log(
    `\nSummary: ${everPopulated}/${totalFields} fields populated in ≥1 artifact, ` +
    `${alwaysPopulated} populated in all ${artifacts.length}, ${neverPopulated} never populated. ` +
    `Of orphans: ${orphanProduced} confirmed produced (wasted derivation), ${orphanNever} never produced (the audit's "produced" mark is theoretical here).`
  );

  await mongoose.disconnect();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--brand')   out.brand   = argv[++i];
    else if (a === '--brandId') out.brandId = argv[++i];
    else if (a === '--csv')     out.csv     = argv[++i];
  }
  return out;
}

function usage() {
  console.error('Usage: node scripts/dumpLayoutInputCoverage.js (--brand <name> | --brandId <id>) [--csv <file>]');
  process.exit(2);
}

function getPath(obj, pathStr) {
  if (!obj || !pathStr) return undefined;
  const parts = pathStr.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function isPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string')  return v.trim().length > 0;
  if (Array.isArray(v))       return v.length > 0;
  if (typeof v === 'object')  return Object.keys(v).length > 0;
  return true;
}

function truncate(v, max = 56) {
  if (v == null) return '';
  let s;
  if      (typeof v === 'string')   s = v;
  else if (Array.isArray(v))        s = `[len=${v.length}] ${JSON.stringify(v)}`;
  else if (typeof v === 'object')   s = JSON.stringify(v);
  else                              s = String(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function csvEscape(s) {
  if (s == null) return '';
  s = String(s);
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printTable(rows) {
  const W = { path: 42, cov: 12, source: 24, wired: 22 };
  const header = pad('PATH', W.path) + '  ' + pad('COVERAGE', W.cov) + '  '
               + pad('SOURCE', W.source) + '  ' + pad('WIRED', W.wired) + '  EXAMPLE';
  console.log(header);
  console.log('-'.repeat(header.length + 50));

  // Group by top-level module for readability
  const grouped = new Map();
  for (const r of rows) {
    const top = r.path.split('.')[0];
    if (!grouped.has(top)) grouped.set(top, []);
    grouped.get(top).push(r);
  }

  for (const [module, modRows] of grouped) {
    console.log(`\n[${module}]`);
    for (const r of modRows) {
      const cov = `${r.populated}/${r.total} (${r.pct}%)`;
      console.log(
        pad('  ' + r.path, W.path) + '  ' +
        pad(cov,           W.cov)  + '  ' +
        pad(r.source,      W.source) + '  ' +
        pad(r.wired,       W.wired)  + '  ' +
        (r.example || '')
      );
    }
  }
}

function pad(s, w) {
  s = String(s == null ? '' : s);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

main().catch(err => {
  console.error('Error:', err);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
