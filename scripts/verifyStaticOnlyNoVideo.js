#!/usr/bin/env node
'use strict';
/**
 * verifyStaticOnlyNoVideo — a static-only request must queue and claim ZERO video.
 *
 * MONEY-CRITICAL. Owner report: "despite choosing just static ads for meta i got
 * a video." A Meta video is a billable Omni submit (~$0.90–1.20 per product), so
 * this is unrequested spend, not a cosmetic routing slip.
 *
 * TWO INDEPENDENT DEFECTS produced it, and either alone is sufficient — which is
 * why both are pinned here:
 *
 *   1. EXPANSION. `campaign.adKinds` is declared `default: 'both'` in
 *      models/Campaign.js and NO route ever writes it (Campaign.create omits it,
 *      so Mongoose bakes 'both' into every document; PATCH does not accept it).
 *      `requestedKinds = kinds || campaign.adKinds || 'image'` therefore never
 *      reached its 'image' arm, and since all three live Meta STATIC surfaces are
 *      dual-kind, resolveKinds returned ['image','video'] and queued a video.
 *      Fix: stop consulting a field nothing ever sets.
 *
 *   2. SELECTION. selectAdsForRun is kind-blind and its tier 0 drains
 *      renderRoute:'veo' FIRST. Even a perfectly-scoped static-only expansion
 *      claimed leftover queued video for the same product from an earlier
 *      session, ahead of the statics, and billed for it. Kind scoping existed at
 *      expansion time and nowhere at selection time.
 *      Fix: an opt-in `kinds` filter, passed the expansion's own resolvedKinds.
 *
 * No DB, no network, no API keys.
 *   node scripts/verifyStaticOnlyNoVideo.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pf = require(path.join(ROOT, 'services', 'platformFormats.js'));

let pass = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const META_STATIC = ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16'];

// ── A. The premise: every Meta static surface is dual-kind ───────────────
// If this stops being true the defect changes shape, so state it rather than
// assume it — it is the reason an unset kinds value could produce video at all.
console.log('\nA. why an unset kinds value could ever yield video');
for (const k of META_STATIC) {
  check(`A1 ${k} declares BOTH image and video (so 'both' resolves to video too)`,
    pf.kindsForPlatformFormat(k).includes('image') && pf.kindsForPlatformFormat(k).includes('video'));
}
check("A2 resolveKinds(meta_feed_1_1,'both') includes video",
  pf.resolveKinds('meta_feed_1_1', 'both').includes('video'));
check("A3 resolveKinds(meta_feed_1_1,'image') does NOT include video",
  !pf.resolveKinds('meta_feed_1_1', 'image').includes('video'),
  'the request-level guard the fix relies on');

// ── B. EXPANSION — campaign.adKinds must not reach the decision ──────────
console.log('\nB. expansion no longer consults campaign.adKinds');
{
  const src = fs.readFileSync(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'), 'utf8');
  // Strip comments: this file documents the removed field at length, and a
  // source scan that counted prose would pass while the code still read it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const m = code.match(/const requestedKinds\s*=\s*([^;]+);/);
  check('B1 requestedKinds is still assigned', !!m, 'the line was renamed or removed');
  if (m) {
    const expr = m[1];
    check('B2 [MONEY] requestedKinds does NOT read campaign.adKinds',
      !/campaign\s*\.\s*adKinds/.test(expr),
      `expression is: ${expr.trim()} — a field no route writes cannot express intent, and its schema default is 'both'`);
    check("B3 requestedKinds still falls back to 'image' when the caller says nothing",
      /'image'/.test(expr),
      `expression is: ${expr.trim()}`);
  }
  // The field must not creep back in via another read on the kinds path.
  const adKindsReads = (code.match(/campaign\s*\.\s*adKinds/g) || []).length;
  check('B4 [MONEY] campaign.adKinds is read NOWHERE in the generation service',
    adKindsReads === 0,
    `${adKindsReads} read(s) remain`);
}

// ── C. The schema default is still 'both' — so B is load-bearing ─────────
// If someone "fixes" this by flipping the default instead, B4 would still pass
// while every EXISTING document keeps 'both'. Pin the default so the reason B
// exists stays visible.
console.log('\nC. the schema default that made this unreachable');
{
  const camp = fs.readFileSync(path.join(ROOT, 'models', 'Campaign.js'), 'utf8');
  const block = camp.slice(camp.indexOf('adKinds'), camp.indexOf('adKinds') + 200);
  check("C1 Campaign.adKinds still defaults to 'both' (documents already store it)",
    /default:\s*'both'/.test(block),
    'if this changed, existing documents STILL hold both — the expansion fix is what protects them');
}

// ── D. SELECTION — the opt-in kind filter ───────────────────────────────
console.log('\nD. selection can be scoped to the run\'s kinds');
{
  const src = fs.readFileSync(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'), 'utf8');
  const start = src.indexOf('async function selectAdsForRun(');
  const end = src.indexOf('\n// ── Seed builders', start);
  const fn = start > 0 ? src.slice(start, end > start ? end : start + 8000) : '';
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('D0 selectAdsForRun was located', fn.length > 1000);
  check('D1 it accepts a kinds parameter', /kinds\s*=\s*null/.test(code));
  check('D2 kinds maps to renderRoute (veo / html_gen)',
    /'veo'/.test(code) && /'html_gen'/.test(code));
  check('D3 [MONEY] the video tier is GATED, not filtered',
    /wantsVideoClaim/.test(code) && /wantsVideoClaim\s*\n?\s*\?\s*await Ad\.find/.test(code),
    'tier 0 hardcodes renderRoute:veo — spreading a filter would OVERWRITE it and select statics there');
  check('D4 both non-video tiers carry routeScope',
    (code.match(/\.\.\.routeScope/g) || []).length >= 2,
    'v2 (judged) and v1 (legacy) must both be restricted');
  check('D5 omitting kinds restricts nothing (render-more must still drain all)',
    /if \(!wantKinds \|\| !wantKinds\.length\) return \{\};/.test(code),
    'POST /api/ads/runs deliberately claims every queued ad regardless of kind');
  check('D6 asking for BOTH kinds restricts nothing (no redundant $in)',
    /routes\.length === 2\) return \{\};/.test(code));
}

// ── E. The route wires the expansion's OWN resolved kinds ───────────────
// Re-deriving them in the route would drift from the derivation that decided
// what got queued — the same trap generationGate.js documents for fingerprints.
console.log('\nE. route passes resolvedKinds through, does not re-derive');
{
  const ads = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8');
  const gen = fs.readFileSync(path.join(ROOT, 'services', 'campaignAdsGenerationService.js'), 'utf8');

  check('E1 expansion reports resolvedKinds', /resolvedKinds\s*=\s*\[\.\.\.resolvedKinds\]/.test(gen),
    'taken from the authoritative variable, not recomputed');
  check('E2 [MONEY] the /generate claim passes kinds into selectAdsForRun',
    /adIds = await selectAdsForRun\(\{[\s\S]{0,400}kinds:\s*Array\.isArray\(job\?\.resolvedKinds\)/.test(ads),
    'without this the claim stays kind-blind and drains leftover video first');
  check('E3 it reads the RIGHT variable (job, the expandWizardJob result)',
    !/expansion\?\.resolvedKinds/.test(ads),
    'a wrong name silently no-ops via the fail-open path — the filter would look present and do nothing');
  check('E4 the render-more endpoint is NOT narrowed',
    /selectAdsForRun\(\{ campaignId, limit: MAX_CREATIVES_PER_RUN \}\)/.test(ads),
    'POST /api/ads/runs must keep draining every queued ad or rows strand');
}

const total = pass + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyStaticOnlyNoVideo: ${pass}/${total} passed, ${failures.length} FAILED`);
  failures.forEach((f) => console.log(`   FAILED: ${f}`));
  process.exit(1);
}
console.log(`✅ verifyStaticOnlyNoVideo: ${pass}/${total} checks passed`);
