'use strict';
// Pins the Phase 3 titler + renderer handoff.
//
// STATE MACHINE (guaranteed by the checks below):
//   renderer's video path, when isTitlerEnabled() is true, atomically:
//     - stamps veoVideoUrl (money receipt) + titlingNeeded=true
//     - clears the claim (claimedByWorker/claimedAt)
//     - clears titlingResumeState (this is not resume, primary path)
//     - increments renderAttempts
//     - returns early WITHOUT bumpRunCounter (ad hasn't settled)
//   ONE $set — a two-write shape opens a window where a titler sees
//   titlingNeeded=true without veoVideoUrl, or vice versa. Same money-safety
//   argument as the veoVideoUrl+veoReferenceImages co-persist rule.
//
//   The titler role:
//     - polls for {status:'rendering', veoVideoUrl:{$ne:null},
//                  titlingNeeded:true, claimedByWorker:null}
//     - claims atomically with owner-scoped CAS
//     - does Remotion titling (renderBrandScriptAndSave), with the same
//       no-brand qcAndStampVideoAd fallback the renderer has
//     - stamps terminal draft OR preserves QC-failed via settleNonDraftTerminal
//     - clears titlingNeeded on terminal write
//     - bumps run counter + finalizes when settled
//
// Revert-prove: mutating any load-bearing bit breaks a check. Verified on
// commit: gate removal, veoVideoUrl guard drop, claim ownership drop,
// bumpRunCounter injected on handoff (money bug — double counter).

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function check(name, cond, detail) {
  if (cond) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// A. Role enum + config export + defaults.env.
const config = fs.readFileSync(path.join(REPO, 'src', 'config.js'), 'utf8');
check('A1 config enum accepts titler',
  /\['api',\s*'orchestrator',\s*'renderer',\s*'titler'\]/.test(config));
check('A2 isTitlerEnabled reads ADGEN_TITLER_ENABLED with strict "true"',
  /ADGEN_TITLER_ENABLED[^)]*\)\.toLowerCase\(\)\s*===\s*['"]true['"]/.test(config),
  'gate must fail closed on any non-literal-true');
check('A3 config exports isTitlerEnabled',
  /module\.exports\s*=\s*Object\.freeze\(\{[^}]*isTitlerEnabled[^}]*\}\)/s.test(config));
const defaultsEnv = fs.readFileSync(path.join(REPO, 'config', 'defaults.env'), 'utf8');
check('A4 defaults.env commits ADGEN_TITLER_ENABLED=false (local / api / orchestrator fallback; production is render.yaml)',
  /(^|\r?\n)ADGEN_TITLER_ENABLED=false(\r?\n|$)/.test(defaultsEnv));

// B. Ad schema declaration.
const adModel = fs.readFileSync(path.join(REPO, 'src', 'models', 'Ad.js'), 'utf8');
check('B1 Ad schema declares titlingNeeded as Boolean',
  /titlingNeeded:\s*\{\s*type:\s*Boolean/.test(adModel),
  'undeclared field would silently vanish under strict mode');
check('B2 titlingNeeded defaults to false',
  /titlingNeeded:[\s\S]{0,80}default:\s*false/.test(adModel));

// C. Entrypoint dispatch.
const entrypoint = fs.readFileSync(path.join(REPO, 'src', 'entrypoint.js'), 'utf8');
check('C1 entrypoint requires services/titler',
  /require\(['"]\.\/services\/titler['"]\)/.test(entrypoint));
check('C2 entrypoint awaits titler.run + titler.shutdown',
  /await\s+titler\.run\(\)/.test(entrypoint) && /await\s+titler\.shutdown\(\)/.test(entrypoint));

// D. Renderer handoff — master + derive paths.
const renderer = fs.readFileSync(path.join(REPO, 'src', 'services', 'renderer.js'), 'utf8');
check('D1 renderer imports isTitlerEnabled',
  /isTitlerEnabled[\s\S]{0,120}require\(['"]\.\.\/config['"]\)/.test(renderer));
check('D2 renderer video paths read isTitlerEnabled() at least twice',
  (renderer.match(/isTitlerEnabled\(\)/g) || []).length >= 2,
  'one call each for master + derive branches');

// Master path — extract the persist-write block and check its handoff arm.
const masterBlock = renderer.match(/const \$setMaster[\s\S]{0,4000}?await Ad\.updateOne\(\s*\{[\s\S]{0,300}?\}\s*\);/);
check('D3 master path builds handoff-mode $set',
  !!masterBlock && /handoffMode/.test(masterBlock[0]),
  'must branch based on isTitlerEnabled() before the persist write');
check('D4 master path persist-write is owner-scoped',
  !!masterBlock && /\{\s*_id:\s*ad\._id,\s*claimedByWorker:\s*WORKER_ID\s*\}/.test(masterBlock[0]),
  'without this a stale claim could still land the write');
check('D5 master handoff arm stamps veoVideoUrl + titlingNeeded together',
  /veoVideoUrl:\s*veoResult\.videoUrl[\s\S]{0,1200}?handoffMode[\s\S]{0,400}?titlingNeeded:\s*true/.test(renderer),
  'MONEY: co-persist so a titler cannot observe titlingNeeded without the URL');
check('D6 master handoff arm clears claim in the same $set',
  /const \$setMaster[\s\S]{0,1200}?handoffMode[\s\S]{0,600}?titlingNeeded:\s*true[\s\S]{0,300}?claimedByWorker:\s*null[\s\S]{0,80}claimedAt:\s*null/.test(renderer),
  'must anchor on $setMaster so a missing claim-clear in master path isn\'t masked by derive\'s');
check('D7 master handoff returns without bumpRunCounter',
  /VIDEO MASTER handoff[\s\S]{0,400}?return;/.test(renderer),
  'ad has not settled — the titler owns the counter bump');

// Derive path — same shape.
const deriveBlock = renderer.match(/const \$setDerive[\s\S]{0,3000}?await Ad\.updateOne\(\s*\{[\s\S]{0,300}?\}\s*\);/);
check('D8 derive path builds handoff-mode $set',
  !!deriveBlock && /handoffMode/.test(deriveBlock[0]));
check('D9 derive path persist-write is owner-scoped',
  !!deriveBlock && /\{\s*_id:\s*ad\._id,\s*claimedByWorker:\s*WORKER_ID\s*\}/.test(deriveBlock[0]));
check('D10 derive handoff arm stamps titlingNeeded=true',
  /const \$setDerive[\s\S]{0,1000}?handoffMode[\s\S]{0,400}?titlingNeeded:\s*true/.test(renderer));
check('D11 derive handoff arm clears claim in the same $set',
  /const \$setDerive[\s\S]{0,1200}?handoffMode[\s\S]{0,600}?titlingNeeded:\s*true[\s\S]{0,300}?claimedByWorker:\s*null[\s\S]{0,80}claimedAt:\s*null/.test(renderer));
check('D12 derive handoff returns without bumpRunCounter',
  /VIDEO DERIVE handoff[\s\S]{0,400}?return;/.test(renderer));

// E. Titler role.
const titlerPath = path.join(REPO, 'src', 'services', 'titler.js');
const titler = fs.readFileSync(titlerPath, 'utf8');
check('E0 titler.js exists', titler.length > 0);

// Claim filter.
const claimFilter = titler.match(/findOneAndUpdate\(\s*\{([\s\S]*?)\},\s*\{\s*\$set:\s*\{\s*claimedByWorker:\s*WORKER_ID/);
check('E1 titler claim parses', !!claimFilter);
const claimBody = claimFilter ? claimFilter[1] : '';
check('E2 claim accepts both rendering + draft statuses',
  /status:\s*\{\s*\$in:\s*\[['"]rendering['"],\s*['"]draft['"]\]\s*\}/.test(claimBody),
  'masters come out of atlasVideoService with status=draft (money safety); derives stay rendering');
check('E3 claim requires veoVideoUrl set (receipt guard)',
  /veoVideoUrl:\s*\{\s*\$ne:\s*null\s*\}/.test(claimBody),
  'MONEY: never claim without a settled master receipt');
check('E4 claim requires titlingNeeded true', /titlingNeeded:\s*true/.test(claimBody));
check('E5 claim requires idle', /claimedByWorker:\s*null/.test(claimBody));
check('E6 claim sorts FIFO', /sort:\s*\{\s*createdAt:\s*1\s*\}/.test(titler));

// Titling actually happens.
check('E7 titler imports renderBrandScriptAndSave', /renderBrandScriptAndSave/.test(titler));
check('E8 titler imports qcAndStampVideoAd (no-brand fallback)', /qcAndStampVideoAd/.test(titler));
// WAS isRemotionChildOomError(...) — the titling-recoverability PR widened
// this to any resumable titling failure (OOM, timeout, or a generic child
// failure/exception, bounded by TITLING_ATTEMPTS_MAX), signalled by
// scriptErr.titlingResumable (stamped by
// brandScriptExecutor.stampTitlingFailureAndThrow) rather than
// re-classifying OOM only.
check('E9 titler catches a resumable Remotion child titling failure (OOM/timeout/generic)',
  /scriptErr\s*&&\s*scriptErr\.titlingResumable/.test(titler));

// Terminal + counter.
check('E10 titler terminal draft-write clears titlingNeeded',
  /status:\s+['"]draft['"],\s+titlingResumeState:\s*null,\s+titlingNeeded:\s+false/.test(titler),
  'success terminal write must clear titlingNeeded — the field the titler owns');
check('E10b settleNonDraftTerminal also clears titlingNeeded (QC-failed path)',
  /async function settleNonDraftTerminal[\s\S]{0,600}?titlingNeeded:\s*false/.test(titler),
  'QC-failed guard path must also clear so the ad is not re-picked');
check('E11 titler terminal write is status-guarded',
  /status:\s*\{\s*\$in:\s*\[['"]rendering['"],\s*['"]draft['"]\]\s*\}/.test(titler),
  'protects vision-QC-failed verdict from being resurrected to draft');
check('E12 titler bumps run counter on terminal',
  /bumpRunCounter\(ad\.campaignRunIds/.test(titler));
check('E13 titler duplicates settleNonDraftTerminal (Phase 4 dedup target)',
  /async function settleNonDraftTerminal/.test(titler),
  'expected duplicate — see file header');
check('E14 titler duplicates startAdHeartbeat',
  /function startAdHeartbeat/.test(titler));
check('E15 titler duplicates acquireRunHeartbeat',
  /async function acquireRunHeartbeat/.test(titler));
check('E16 releaseClaim filter is owner-scoped',
  /Ad\.updateOne\(\s*\{\s*_id:\s*adId,\s*claimedByWorker:\s*WORKER_ID/.test(titler));

// F. Poll gate + shutdown.
check('F1 pollTick returns early when gate off',
  /if\s*\(!isTitlerEnabled\(\)\)\s*return;/.test(titler));
check('F2 shutdown drains up to 25s then force-releases',
  /SHUTDOWN_DRAIN_MS\s*=\s*25_?000/.test(titler) &&
  /force-releasing[\s\S]{0,80}Promise\.all\(remaining\.map/.test(titler));

// G. render.yaml.
const renderYaml = fs.readFileSync(path.join(REPO, 'render.yaml'), 'utf8');
check('G1 render.yaml declares adgen-titler service',
  /name:\s*adgen-titler/.test(renderYaml));
check('G2 render.yaml titler runs on an 8GB plan (pro_plus)',
  /name:\s*adgen-titler[\s\S]{0,900}?plan:\s*pro_plus/.test(renderYaml),
  'Chrome needs the RAM — Standard OOMs. Renamed from standard_plus 2026-08-24 (blueprint sync rejected the old name).');
check('G3 render.yaml titler sets ADGEN_ROLE=titler',
  /name:\s*adgen-titler[\s\S]{0,1600}?ADGEN_ROLE[\s\S]{0,40}?titler/.test(renderYaml));
check('G4 render.yaml titler ships ADGEN_TITLER_ENABLED=true (production; live since 2026-08-26)',
  /name:\s*adgen-titler[\s\S]{0,2500}?ADGEN_TITLER_ENABLED[\s\S]{0,80}?["']true["']/.test(renderYaml));
check('G5 render.yaml renderer also ships ADGEN_TITLER_ENABLED=true (dashboard had it on both; renderer must stamp titlingNeeded)',
  /name:\s*adgen-renderer[\s\S]{0,2500}?ADGEN_TITLER_ENABLED[\s\S]{0,80}?["']true["']/.test(renderYaml));
check('G6 render.yaml renderer + titler ship ADGEN_RENDERER_ENABLED=true',
  /name:\s*adgen-renderer[\s\S]{0,2500}?ADGEN_RENDERER_ENABLED[\s\S]{0,80}?["']true["']/.test(renderYaml) &&
  /name:\s*adgen-titler[\s\S]{0,2500}?ADGEN_RENDERER_ENABLED[\s\S]{0,80}?["']true["']/.test(renderYaml));

// ── report
console.log(`\nverifyTitlerHandoff: ${passes.length} pass, ${failures.length} fail`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ Phase 3 handoff wired end-to-end — titler live in production');
