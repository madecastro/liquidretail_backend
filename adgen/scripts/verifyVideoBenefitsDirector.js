#!/usr/bin/env node
'use strict';
/**
 * PORTED from liquidretail_backend/scripts/verifyVideoBenefitsDirector.js
 * (backend PR #386) into liquidretail_adgen.
 *
 * PORTING NOTE — require-path adaptation only. Groups K/C/E/S/A/F/P test
 * PURE exported functions of src/services/videoBenefitsDirector.js and
 * src/services/campaignAdsGenerationService.js (planDeterministicVideoAds).
 * No routes/ads.js, no renderer.js. The LLM call is stubbed via deps;
 * applyBenefitsPlacement is the live titling consumer this repo actually
 * runs (brandScriptExecutor.renderWithRemotionAndSave).
 *
 * ── ORIGINAL HEADER (backend) ──────────────────────────────────────────────
 * verifyVideoBenefitsDirector — LLM video-title Director scoped to
 * (content profile × master size), plus apply-to-spec.
 *
 *   K. mixed 21-ad plan has exactly 6 unique (size × profile) keys
 *   C. 21 ads × 1 product ⇒ 6 chatCompletion calls, not 21
 *   C3. 21 ads × 3 products ⇒ 18 calls, not 63
 *   E. empty benefits short-circuit ⇒ 0 LLM calls
 *   S. 1:1 / 4:5 / Reels / PMax 9:16 inherit 9:16 size; only 16:9 is other
 *   A. applyBenefitsPlacement honours director include / skip / existing slot
 *   F. flag-off is identity (no LLM)
 *
 * Execution-based: stubs chatCompletion and assembleSignals, then drives
 * the real getVideoTitleDirection / planDeterministicVideoAds. Not a
 * source-regex count of "chatCompletion".
 *
 * Run: node scripts/verifyVideoBenefitsDirector.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIG_PLACEMENT = process.env.VIDEO_BENEFITS_PLACEMENT;
const ORIG_FUNNEL = process.env.PMAX_FUNNEL_VARIANTS;
const ORIG_UNIFIED = process.env.UNIFIED_VIDEO_9_16_MASTER;

process.env.VIDEO_BENEFITS_PLACEMENT = 'true';
process.env.PMAX_FUNNEL_VARIANTS = 'true';
process.env.UNIFIED_VIDEO_9_16_MASTER = 'true';
process.env.META_VIDEO_DERIVATIVES = 'true';

const svc = require(path.join(ROOT, 'src/services/campaignAdsGenerationService'));
const { validateTitleSpec } = require('../src/services/titleSpecValidator');
const {
  videoTitleSize,
  videoTitleProfile,
  videoTitleDirectionKey,
  uniqueVideoTitleDirectionKeys,
  getVideoTitleDirection,
  resetVideoTitleDirectionMemo,
  applyBenefitsPlacement,
  parseDirectorDecision,
  isBenefitsPlacementEnabled,
} = require('../src/services/videoBenefitsDirector');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function restoreEnv() {
  if (ORIG_PLACEMENT === undefined) delete process.env.VIDEO_BENEFITS_PLACEMENT;
  else process.env.VIDEO_BENEFITS_PLACEMENT = ORIG_PLACEMENT;
  if (ORIG_FUNNEL === undefined) delete process.env.PMAX_FUNNEL_VARIANTS;
  else process.env.PMAX_FUNNEL_VARIANTS = ORIG_FUNNEL;
  if (ORIG_UNIFIED === undefined) delete process.env.UNIFIED_VIDEO_9_16_MASTER;
  else process.env.UNIFIED_VIDEO_9_16_MASTER = ORIG_UNIFIED;
}

function minimalSpec() {
  const res = validateTitleSpec({
    version: 1,
    phases: [
      { key: 'hook', startSec: 0, endSec: 2.5 },
      { key: 'proof', startSec: 2.5, endSec: 6.5 },
      { key: 'close', startSec: 6.5, endSec: 8 },
    ],
    slots: [{
      key: 'headline',
      phase: 'hook',
      position: { anchor: 'upperThird', align: 'left', maxWidthPct: 0.9 },
      treatment: { scrim: 'none', fontRole: 'heading', maxLines: 2 },
    }],
  }, { format: 'vertical' });
  assert.ok(res.ok, (res.errors || []).join('; '));
  return res.normalized;
}

const MIXED = ['meta_stories_9_16', 'pmax_video_9_16', 'pmax_video_16_9'];
const plan = svc.planDeterministicVideoAds(MIXED);

check('K0 mixed plan is 21 ads', plan.length === 21, `got ${plan.length}`);

const keys = uniqueVideoTitleDirectionKeys(plan);
check('K1 unique (size × profile) keys === 6, not 21',
  keys.length === 6,
  JSON.stringify(keys));
check('K2 both master sizes are present',
  keys.some((k) => k.size === '9:16') && keys.some((k) => k.size === '16:9'));
check('K3 all three content profiles are present',
  ['awareness', 'consideration', 'conversion'].every((p) => keys.some((k) => k.profile === p)));

check('S1 meta 1:1 inherits 9:16 size (crop of portrait master)',
  videoTitleSize('meta_feed_1_1') === '9:16');
check('S2 meta 4:5 inherits 9:16 size',
  videoTitleSize('meta_feed_4_5') === '9:16');
check('S3 meta reels inherits 9:16 size',
  videoTitleSize('meta_reels_9_16') === '9:16');
check('S4 pmax 9:16 is 9:16 (shared plate)',
  videoTitleSize('pmax_video_9_16') === '9:16');
check('S5 pmax 1:1 inherits 9:16 size (crop of portrait)',
  videoTitleSize('pmax_video_1_1') === '9:16');
check('S6 pmax 16:9 is the other master size',
  videoTitleSize('pmax_video_16_9') === '16:9');
check('S7 unstaged funnelStage → awareness profile',
  videoTitleProfile(null) === 'awareness' && videoTitleProfile(undefined) === 'awareness');
check('S8 consideration/conversion stay themselves',
  videoTitleProfile('consideration') === 'consideration'
    && videoTitleProfile('conversion') === 'conversion');

{
  const portraitAwareness = plan.filter((r) =>
    videoTitleDirectionKey(r).size === '9:16'
    && videoTitleDirectionKey(r).profile === 'awareness');
  check('S9 several delivered surfaces share 9:16 × awareness (inherit)',
    portraitAwareness.length >= 4,
    `got ${portraitAwareness.length} — Stories/Reels/1:1/4:5/PMax 9:16/1:1 unstaged`);
}

{
  // ADGEN-ONLY: both live titling paths (renderer in-process + titler
  // out-of-process) call renderBrandScriptAndSave → renderWithRemotionAndSave.
  // Apply lives there so neither renderer.js nor titler.js needs its own copy.
  const executorSrc = fs.readFileSync(
    path.join(ROOT, 'src/services/brandScriptExecutor.js'), 'utf8');
  const rendererSrc = fs.readFileSync(
    path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  const titlerSrc = fs.readFileSync(
    path.join(ROOT, 'src/services/titler.js'), 'utf8');
  const retitleSrc = fs.readFileSync(
    path.join(ROOT, 'src/services/retitleConsumer.js'), 'utf8');
  check('W1 applyBenefitsPlacement is wired in renderWithRemotionAndSave',
    /applyBenefitsPlacement/.test(executorSrc)
      && /direction:\s*ad\.videoTitleDirection/.test(executorSrc));
  check('W2 renderer.js does not duplicate apply (shared executor covers it)',
    !/applyBenefitsPlacement/.test(rendererSrc)
      && /renderBrandScriptAndSave/.test(rendererSrc));
  check('W3 titler.js does not duplicate apply (shared executor covers it)',
    !/applyBenefitsPlacement/.test(titlerSrc)
      && /renderBrandScriptAndSave/.test(titlerSrc));
  check('W4 retitleConsumer also goes through renderBrandScriptAndSave',
    /renderBrandScriptAndSave/.test(retitleSrc)
      && !/applyBenefitsPlacement/.test(retitleSrc));
  check('W5 regenerate chrome overlay goes through renderBrandScriptAndSave',
    /renderBrandScriptAndSave/.test(
      fs.readFileSync(path.join(ROOT, 'src/services/adRegenerateService.js'), 'utf8')));
}

function stubDeps({ benefits = ['Keeps you dry', 'Packs flat', 'Taped seams'], onChat } = {}) {
  return {
    assembleSignals: async () => ({
      brand_signal: { name: 'Acme' },
      product_signal: { name: 'Rain Shell', benefits },
    }),
    chatCompletion: async () => {
      if (onChat) onChat();
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              include_benefits: true,
              max_items: 3,
              phase: 'proof',
              reason: 'test',
            }),
          },
        }],
      };
    },
  };
}

async function driveKit(productIds, deps) {
  const out = [];
  for (const productId of productIds) {
    for (const item of plan) {
      out.push(await getVideoTitleDirection({
        brandId: '000000000000000000000001',
        productId,
        campaignKind: 'product',
        platformFormat: item.platformFormat,
        funnelStage: item.funnelStage,
      }, deps));
    }
  }
  return out;
}

async function runAsync() {
  check('F0 flag on', isBenefitsPlacementEnabled() === true);

  resetVideoTitleDirectionMemo();
  let chats = 0;
  const one = await driveKit(['p1'], stubDeps({ onChat: () => { chats += 1; } }));
  check('C1 21 ads × 1 product ⇒ 6 LLM calls (not 21)',
    chats === 6,
    `got ${chats}`);
  check('C1a every ad received a direction object',
    one.length === 21 && one.every((d) => d && typeof d.include === 'boolean'));
  check('C1b 9:16 awareness ads inherited the SAME include decision',
    (() => {
      const subset = plan.map((item, i) => ({ item, d: one[i] }))
        .filter(({ item }) => videoTitleDirectionKey(item).size === '9:16'
          && videoTitleDirectionKey(item).profile === 'awareness')
        .map(({ d }) => d.include);
      return subset.length >= 2 && subset.every((v) => v === subset[0]);
    })());

  resetVideoTitleDirectionMemo();
  chats = 0;
  await driveKit(['p1', 'p2', 'p3'], stubDeps({ onChat: () => { chats += 1; } }));
  check('C3 21 ads × 3 products ⇒ 18 LLM calls (6×3), not 63',
    chats === 18,
    `got ${chats}`);

  resetVideoTitleDirectionMemo();
  chats = 0;
  const empty = await driveKit(['p1'], stubDeps({
    benefits: [],
    onChat: () => { chats += 1; },
  }));
  check('E1 empty benefits ⇒ 0 LLM calls (short-circuit)',
    chats === 0,
    `got ${chats}`);
  check('E2 empty benefits ⇒ include=false reason=no-content',
    empty.every((d) => d.include === false && d.reason === 'no-content'));

  {
    const d = parseDirectorDecision(
      '{"include_benefits":true,"max_items":3,"phase":"proof","reason":"why-buy"}',
      { size: '9:16', profile: 'consideration', occupancy: { phase: 'proof' }, benefits: ['a', 'b', 'c'] }
    );
    check('P1 parse include=true maxItems=3 phase=proof',
      d.include === true && d.maxItems === 3 && d.phase === 'proof' && d.source === 'director');
  }
  {
    const d = parseDirectorDecision(
      '{"include_benefits":true,"max_items":3,"phase":"hook","reason":"nope"}',
      { size: '9:16', profile: 'awareness', occupancy: { phase: 'proof' }, benefits: ['a', 'b', 'c'] }
    );
    check('P2 hook phase is remapped off the opening (never hook)',
      d.include === true && d.phase === 'proof');
  }
  {
    const d = parseDirectorDecision(
      '{"include_benefits":true,"max_items":3,"phase":"proof","reason":"x"}',
      { size: '9:16', profile: 'consideration', occupancy: { phase: 'proof' }, benefits: [] }
    );
    check('P3 director cannot invent benefits when the list is empty',
      d.include === false && d.reason === 'no-content');
  }

  {
    const spec = minimalSpec();
    const applied = applyBenefitsPlacement({
      spec,
      meta: { benefits: ['Keeps you dry', 'Packs flat', 'Taped seams'] },
      format: 'vertical',
      direction: { include: true, maxItems: 3, phase: 'proof', source: 'director' },
    });
    const slot = (applied.spec.slots || []).find((s) => s.key === 'benefits');
    check('A1 director include=true splices a visible benefits slot',
      !!slot && slot.visible !== false && slot.phase === 'proof'
        && Array.isArray(slot.bind) && slot.bind.includes('benefits'));
    check('A2 original spec is not mutated',
      !(spec.slots || []).some((s) => s.key === 'benefits'));
  }
  {
    const spec = minimalSpec();
    const applied = applyBenefitsPlacement({
      spec,
      meta: { benefits: ['Keeps you dry', 'Packs flat', 'Taped seams'] },
      format: 'vertical',
      direction: { include: false, reason: 'director-declined', source: 'director' },
    });
    check('A3 director include=false does not splice',
      !(applied.spec.slots || []).some((s) => s.key === 'benefits')
        && applied.decision.include === false);
  }
  {
    const spec = minimalSpec();
    spec.slots.push({
      key: 'benefits',
      visible: true,
      bind: ['benefits'],
      phase: 'proof',
      position: { anchor: 'lowerThird', align: 'left', maxWidthPct: 0.85 },
      treatment: { scrim: 'none', itemLayout: 'stack', itemStyle: 'bullet', maxItems: 4 },
    });
    const validated = validateTitleSpec(spec, { format: 'vertical' });
    assert.ok(validated.ok);
    const applied = applyBenefitsPlacement({
      spec: validated.normalized,
      meta: { benefits: ['a', 'b', 'c'] },
      format: 'vertical',
      direction: { include: false, source: 'director' },
    });
    const n = (applied.spec.slots || []).filter((s) => s.key === 'benefits').length;
    check('A4 existing visible benefits slot is honoured even if director says no',
      applied.decision.alreadyPresent === true && n === 1);
  }

  {
    process.env.VIDEO_BENEFITS_PLACEMENT = 'false';
    resetVideoTitleDirectionMemo();
    let chats = 0;
    const d = await getVideoTitleDirection({
      productId: 'p1', platformFormat: 'meta_stories_9_16', funnelStage: null,
    }, stubDeps({ onChat: () => { chats += 1; } }));
    check('F1 flag=false → no LLM, include=false',
      chats === 0 && d.include === false && d.reason === 'flag-off');
    process.env.VIDEO_BENEFITS_PLACEMENT = 'true';
  }
}

runAsync()
  .then(() => {
    restoreEnv();
    console.log(`\nverifyVideoBenefitsDirector: ${pass} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log('  FAIL ' + f);
      process.exit(1);
    }
  })
  .catch((err) => {
    restoreEnv();
    console.error(err);
    process.exit(1);
  });
