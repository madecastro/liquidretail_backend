#!/usr/bin/env node
'use strict';
//
// verifyTitlingResume — pins the recovered-master → titled-ad path.
//
//   A paid master rescued from its spend receipt must become a finished, TITLED ad.
//   It must NEVER be requeued (that re-submits to Omni). Titling runs on web only
//   (Remotion). State lives on a DECLARED field, not on renderStage.
//
// Offline only: no DB, no network, no API key.
//   node scripts/verifyTitlingResume.js
//
// WHY SO MANY CHECKS ARE ABOUT WHERE THE STATE LIVES: the first version of this
// feature parked its sentinel in `Ad.renderStage`, which is OWNED by
// services/adStage.js — it `$set`s renderStage unconditionally (adStage.js:82-85)
// and runs all through titling (brandScriptExecutor.js:1200/:1306/:1332). The
// sentinel was clobbered seconds into the render, so an ad whose render crashed
// could never be re-swept: the exact leak this module exists to close. G1-G3 exist
// to stop that design being reintroduced.
//
// Revert-prove (each mutation must fail this harness):
//   drop renderUrl from bootRecovery's $set        → T4
//   change a state constant                        → T2
//   add status:'queued' anywhere                    → T6  (MONEY)
//   query renderStage instead of titlingResumeState → G1/G2
//   remove the declaration from models/Ad.js        → G3  (silent-drop trap)
//   drop the migration arm                          → T16
//   drop the updatedAt bound from the claim filter   → T14
//   move the claim after the render                  → T8

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const RESUME = fs.readFileSync(path.join(ROOT, 'services', 'titlingResumeService.js'), 'utf8');
const BOOT   = fs.readFileSync(path.join(ROOT, 'services', 'bootRecoveryService.js'), 'utf8');
const INDEX  = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const ADS    = fs.readFileSync(path.join(ROOT, 'routes', 'ads.js'), 'utf8');
const ADMODEL = fs.readFileSync(path.join(ROOT, 'models', 'Ad.js'), 'utf8');

// Comment-stripped source for every assertion. A check a COMMENT can satisfy is
// worthless — the sibling harness verifyReceiptAwareRequeue.js shipped exactly that
// bug (a commented-out import satisfied its "is it imported" regex).
function stripComments(src) {
  let out = ''; let i = 0; let quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const RESUME_CODE = stripComments(RESUME);
const BOOT_CODE   = stripComments(BOOT);
const MODEL_CODE  = stripComments(ADMODEL);

let pass = 0;
const failures = [];
function checkTrue(label, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(label + (extra ? ` — ${extra}` : ''));
}

const svc = require('../services/titlingResumeService');

// ── T1: exports ──────────────────────────────────────────────────────
checkTrue('T1 exports resumeUntitledMasters, enabled, state constants, fallbackPosterUrl',
  typeof svc.resumeUntitledMasters === 'function'
  && typeof svc.enabled === 'function'
  && typeof svc.fallbackPosterUrl === 'function'
  && typeof svc.STATE_PENDING === 'string'
  && typeof svc.STATE_CLAIMED === 'string');

// ── T2: state constant values ────────────────────────────────────────
checkTrue('T2 STATE_PENDING/STATE_CLAIMED are exactly "pending"/"claimed"',
  svc.STATE_PENDING === 'pending' && svc.STATE_CLAIMED === 'claimed');

// ── T3: bootRecovery shares the constants, does not re-declare literals ─
checkTrue('T3 bootRecoveryService imports STATE_PENDING from titlingResumeService',
  /STATE_PENDING[\s\S]{0,120}require\s*\(\s*['"]\.\/titlingResumeService['"]\s*\)/.test(BOOT_CODE));
checkTrue('T3b bootRecoveryService writes titlingResumeState via the constant, not a literal',
  /titlingResumeState:\s*STATE_PENDING/.test(BOOT_CODE)
  && !/titlingResumeState:\s*['"]pending['"]/.test(BOOT_CODE));

// ── G: STATE MUST NOT LIVE IN renderStage (the clobbered design) ──────
// THE REGRESSION GUARD. adStage owns renderStage and overwrites it during titling.
{
  // Isolate the find() query object.
  const qAt  = RESUME_CODE.indexOf('Ad.find(');
  const qEnd = qAt >= 0 ? RESUME_CODE.indexOf('.sort(', qAt) : -1;
  const queryBlock = (qAt >= 0 && qEnd > qAt) ? RESUME_CODE.slice(qAt, qEnd) : '';
  checkTrue('G1 the sweep QUERY keys on titlingResumeState, never on renderStage',
    queryBlock.length > 0
    && /titlingResumeState:/.test(queryBlock)
    && !/renderStage/.test(queryBlock),
    queryBlock ? 'renderStage is clobbered by adStage — a crashed render would leak'
               : 'could not isolate the query block');

  // No CLAIM FILTER may key on renderStage either.
  //
  // SCOPED TO THE FILTER, NOT THE WHOLE CLAIM. The $set deliberately DOES write
  // renderStage as a human breadcrumb, so a window covering both false-FAILS —
  // it did while this check was being written. What must never happen is
  // renderStage appearing in the ternary that ARBITRATES the claim.
  const claimAt  = RESUME_CODE.indexOf('const claimFilter');
  const claimEnd = claimAt >= 0 ? RESUME_CODE.indexOf('const claimSet', claimAt) : -1;
  const filterBlock = (claimAt >= 0 && claimEnd > claimAt)
    ? RESUME_CODE.slice(claimAt, claimEnd) : '';
  checkTrue('G2 the CLAIM FILTER keys on titlingResumeState, never on renderStage',
    filterBlock.length > 0
    && /titlingResumeState:/.test(filterBlock)
    && !/renderStage/.test(filterBlock),
    filterBlock ? 'a renderStage-keyed claim cannot arbitrate once adStage overwrites it'
                : 'could not isolate the claim filter (expected const claimFilter … const claimSet)');
}

// G3: the field must be DECLARED on the schema. Mongoose strict mode SILENTLY
// DROPS writes to undeclared paths — this repo already lost
// renderError.predictionId that way. Using the field without declaring it would
// make the whole feature a no-op with every test still green.
checkTrue('G3 Ad.titlingResumeState is DECLARED in models/Ad.js (Mongoose strict silently drops otherwise)',
  /titlingResumeState:\s*\{[^}]*type:\s*String/.test(MODEL_CODE));
{
  const Ad = require('../models/Ad');
  checkTrue('G3b Ad schema resolves the titlingResumeState path at runtime',
    !!Ad.schema.path('titlingResumeState'));
}

// ── T4: recovered-branch $set writes the viewable fields + state ─────
function recoveredSetBlock(src) {
  const marker = "r.state === 'done' && r.videoUrl";
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const setAt = src.indexOf('$set', at);
  if (setAt < 0 || setAt - at > 2000) return '';
  // Stop at `continue;` so the window cannot bleed into the failed branch.
  const stop = src.indexOf('continue;', setAt);
  return src.slice(at, stop > setAt ? stop : at + 1500);
}
const recBlock = recoveredSetBlock(BOOT_CODE);
checkTrue('T4 bootRecovery recovered-branch $set writes renderUrl, posterUrl, kind, titlingResumeState',
  recBlock.length > 0
  && /renderUrl:\s*r\.videoUrl/.test(recBlock)
  && /posterUrl:\s*poster\s*\|\|\s*r\.videoUrl/.test(recBlock)
  && /kind:\s*'video'/.test(recBlock)
  && /titlingResumeState:\s*STATE_PENDING/.test(recBlock),
  recBlock ? 'a recovered ad without renderUrl is invisible (projectAd has no veoVideoUrl fallback)'
           : 'could not locate the recovered branch');

// ── T5: lease-free safety filter retained ────────────────────────────
checkTrue('T5 bootRecovery recovered update still filters on status: \'rendering\'',
  /\{\s*_id:\s*ad\._id,\s*status:\s*'rendering'\s*\}/.test(recBlock));

// ── T6: MONEY — never requeue a recovered ad ─────────────────────────
// THE SINGLE MOST IMPORTANT CHECK IN THIS FILE. routes/ads.js:1342 declares
// veoVideoUrl fresh and never reads ad.veoVideoUrl, so a requeue re-submits to
// Omni (~$0.75) for a master already paid for.
checkTrue('T6 MONEY: neither titlingResumeService nor bootRecoveryService contains status:\'queued\'',
  !/status:\s*['"]queued['"]/.test(RESUME_CODE) && !/status:\s*['"]queued['"]/.test(BOOT_CODE),
  'a recovered ad must never be requeued — that re-submits to Omni');

// ── T7: exact-match only, no regex matching on state ─────────────────
checkTrue('T7 no $regex/RegExp/$options used against titlingResumeState',
  !/titlingResumeState[\s\S]{0,80}\$regex/.test(RESUME_CODE)
  && !/titlingResumeState[\s\S]{0,80}new RegExp/.test(RESUME_CODE)
  && !/titlingResumeState[\s\S]{0,80}\$options/.test(RESUME_CODE));

// ── T8: claim issued AND checked before the render ───────────────────
{
  const claimIdx     = RESUME_CODE.indexOf('const claimFilter');
  const claimCallIdx = RESUME_CODE.search(/updateOne\s*\(\s*claimFilter/);
  const renderIdx    = RESUME_CODE.indexOf('renderBrandScriptAndSave');
  const modCountIdx  = RESUME_CODE.indexOf('modifiedCount');
  const claimBlock   = claimIdx >= 0 ? RESUME_CODE.slice(claimIdx, claimIdx + 700) : '';
  // Assert each arm explicitly — an occurrence COUNT false-passes because the
  // $set below also mentions the state.
  const pendingArm   = /titlingResumeState:\s*STATE_PENDING\s*\}/.test(claimBlock);
  const staleArm     = /titlingResumeState:\s*STATE_CLAIMED\s*,\s*updatedAt:/.test(claimBlock);
  const migrationArm = /renderUrl:\s*null\s*\}/.test(claimBlock);
  checkTrue('T8 all three claim arms are guarded, and the claim is checked BEFORE the render',
    claimIdx >= 0 && claimCallIdx >= 0 && renderIdx >= 0
    && pendingArm && staleArm && migrationArm
    && claimIdx < renderIdx && claimCallIdx < renderIdx
    && modCountIdx >= 0 && modCountIdx < renderIdx,
    `pending=${pendingArm} stale=${staleArm} migration=${migrationArm} ` +
    `claim@${claimIdx} call@${claimCallIdx} mod@${modCountIdx} render@${renderIdx}`);
}

// ── T9: terminal failure clears the state (bounded retry) ────────────
checkTrue('T9 failure branch sets status \'failed\' AND clears titlingResumeState',
  /status:\s*'failed'[\s\S]{0,200}titlingResumeState:\s*null/.test(RESUME_CODE));

// ── T10: structurally incapable of spending ──────────────────────────
checkTrue('T10 does not require atlasVideoService nor call veoGenerateForAd/submitGeneration',
  !/require\s*\(\s*['"][^'"]*atlasVideoService['"]\s*\)/.test(RESUME_CODE)
  && !/\bveoGenerateForAd\s*\(/.test(RESUME_CODE)
  && !/\bsubmitGeneration\s*\(/.test(RESUME_CODE));

// ── T11: web wires it, worker does not (Remotion is web-only) ────────
checkTrue('T11 index.js wires resumeUntitledMasters and worker.js does not',
  /resumeUntitledMasters/.test(INDEX) && !/resumeUntitledMasters/.test(WORKER));

// ── T11b: the web tick has a re-entrancy guard ───────────────────────
// A pass can outlast the interval (one render measured 76s, cap is 5 ads), and
// stacking Remotion renders on web is a memory hazard — this process died on a
// 24 MB buffer on 2026-08-04 (bab129a).
checkTrue('T11b index.js guards against overlapping sweeper passes',
  /inFlightPass/.test(INDEX) && /finally/.test(INDEX));

// ── T12: brand projection matches routes/ads.js field-for-field ──────
{
  function brandSelect(src) {
    const at = src.indexOf('Brand.findById');
    if (at < 0) return null;
    const m = src.slice(at, at + 2000).match(/\.select\(\s*['"]([^'"]+)['"]\s*\)/);
    return m ? new Set(m[1].trim().split(/\s+/).filter(Boolean)) : null;
  }
  const a = brandSelect(ADS);
  const b = brandSelect(RESUME_CODE);
  if (!a || !b) {
    checkTrue('T12 brand .select() matches routes/ads.js field-for-field', false,
      `ads=${!!a} resume=${!!b}`);
  } else {
    const missing = [...a].filter(f => !b.has(f));
    const extra   = [...b].filter(f => !a.has(f));
    checkTrue('T12 brand .select() matches routes/ads.js field-for-field',
      missing.length === 0 && extra.length === 0,
      `missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
  }
}

// ── T13: a STALE claim is re-swept (mid-render crash is recoverable) ──
{
  const qAt  = RESUME_CODE.indexOf('Ad.find(');
  const qEnd = qAt >= 0 ? RESUME_CODE.indexOf('.sort(', qAt) : -1;
  const queryBlock = (qAt >= 0 && qEnd > qAt) ? RESUME_CODE.slice(qAt, qEnd) : '';
  checkTrue('T13 QUERY re-sweeps a stale claim (crash mid-titling is recoverable)',
    /titlingResumeState:\s*STATE_CLAIMED\s*,\s*updatedAt:\s*\{\s*\$lt:\s*staleCutoff\s*\}/.test(queryBlock),
    'without this a render killed mid-flight leaks the ad permanently');
}

// ── T14: the stale-claim CLAIM keeps its staleness bound ─────────────
// THE SUBTLE ONE. For 'pending', the state arbitrates the race. For a stale claim
// the state is ALREADY 'claimed', so only `updatedAt: { $lt: cutoff }` stops two
// instances both winning. Dropping it would still pass T13.
{
  const at = RESUME_CODE.indexOf('const claimFilter');
  const block = at >= 0 ? RESUME_CODE.slice(at, at + 700) : '';
  checkTrue('T14 stale-claim CLAIM filter retains the updatedAt bound (race arbiter)',
    /titlingResumeState:\s*STATE_CLAIMED\s*,\s*updatedAt:\s*\{\s*\$lt:\s*staleCutoff\s*\}/.test(block),
    'two passes could both claim a stale ad and double-render');
}

// ── T15: success clears the state ────────────────────────────────────
checkTrue('T15 success branch clears titlingResumeState so the ad leaves the sweep',
  /renderStage:\s*'done'/.test(RESUME_CODE)
  && /titlingResumeState:\s*null[\s\S]{0,200}renderStage:\s*'done'/.test(RESUME_CODE));

// ── T16: MIGRATION arm for ads already stranded in production ────────
// The deployed code wrote veoVideoUrl + status:'draft' and nothing else, so those
// ads carry no state and no renderUrl. Without this arm the very ad that prompted
// the work stays broken after the deploy.
{
  const qAt  = RESUME_CODE.indexOf('Ad.find(');
  const qEnd = qAt >= 0 ? RESUME_CODE.indexOf('.sort(', qAt) : -1;
  const queryBlock = (qAt >= 0 && qEnd > qAt) ? RESUME_CODE.slice(qAt, qEnd) : '';
  checkTrue('T16 QUERY has the migration arm (veoVideoUrl set + renderUrl null)',
    /veoVideoUrl:\s*\{\s*\$ne:\s*null\s*\}\s*,\s*renderUrl:\s*null/.test(queryBlock),
    'ads already recovered by the deployed code would never be picked up');
  checkTrue('T16b the claim backfills renderUrl/posterUrl/kind for migration-arm ads',
    /claimSet\.renderUrl\s*=\s*ad\.veoVideoUrl/.test(RESUME_CODE)
    && /claimSet\.kind\s*=\s*'video'/.test(RESUME_CODE),
    'titling alone would not make the ad visible — projectAd reads renderUrl');
}

// ── T17: the brand-missing release is BOUNDED, and ends like the normal path ─
// Releasing straight back to 'pending' forever is a silent infinite retry. And the
// give-up outcome must MIRROR routes/ads.js:1469/:1512, which treats a null brand
// as intentional success (no brand → no chrome → the raw master IS the
// deliverable). Marking it 'failed' would write off a good paid ad for a condition
// the normal path ships happily.
checkTrue('T17 an unresolvable brand is bounded by BRAND_GIVEUP_MIN',
  /BRAND_GIVEUP_MIN/.test(RESUME_CODE) && /tooOld/.test(RESUME_CODE),
  'releasing straight back to pending forever is a silent infinite retry');
checkTrue('T17b give-up ships the untitled master (matches ads.js no-brand) rather than failing it',
  /no titling \(no brand\)/.test(RESUME_CODE)
  && !/brand not resolvable[\s\S]{0,200}status:\s*'failed'/.test(RESUME_CODE),
  'a null brand is intentional success on the normal path — do not condemn the ad');

// ── T18: a PRE-RENDER throw releases instead of condemning ───────────
// Everything before the render is DB reads. This sweeper runs ~90s after boot and
// on an interval — i.e. exactly while a deploy churns Mongo connections. A blip
// must not permanently flag a paid, recoverable ad 'failed'.
checkTrue('T18 pre-render errors release the claim instead of marking the ad failed',
  /renderAttempted\s*=\s*false/.test(RESUME_CODE)
  && /renderAttempted\s*=\s*true/.test(RESUME_CODE)
  && /if\s*\(\s*!renderAttempted\s*\)/.test(RESUME_CODE),
  'a Mongo blip during a deploy would write off a paid ad');

const total = pass + failures.length;
if (failures.length) {
  console.error(`verifyTitlingResume: ${pass}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error('  FAIL', f);
  process.exit(1);
}
console.log(`verifyTitlingResume: ${pass}/${total} passed`);
process.exit(0);
