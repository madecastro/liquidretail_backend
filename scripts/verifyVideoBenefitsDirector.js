#!/usr/bin/env node
'use strict';
/**
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
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIG_PLACEMENT = process.env.VIDEO_BENEFITS_PLACEMENT;
const ORIG_FUNNEL = process.env.PMAX_FUNNEL_VARIANTS;
const ORIG_UNIFIED = process.env.UNIFIED_VIDEO_9_16_MASTER;

process.env.VIDEO_BENEFITS_PLACEMENT = 'true';
process.env.PMAX_FUNNEL_VARIANTS = 'true';
process.env.UNIFIED_VIDEO_9_16_MASTER = 'true';
process.env.META_VIDEO_DERIVATIVES = 'true';

const svc = require(path.join(ROOT, 'services/campaignAdsGenerationService'));
const { validateTitleSpec } = require('../services/titleSpecValidator');
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
  occupancyBrief,
  buildDirectorMessages,
} = require('../services/videoBenefitsDirector');
const { makeAssembleSignalsOnce } = require('../services/aiCreativeDirectorService');

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

function stubDeps({
  benefits = ['Keeps you dry', 'Packs flat', 'Taped seams'],
  onChat,
  onAssemble,
  extraSignals = {},
} = {}) {
  return {
    assembleSignals: async () => {
      if (onAssemble) onAssemble();
      return {
        brand_signal: { name: 'Acme', tagline: 'Stay out longer', tone: ['rugged', 'calm'] },
        product_signal: {
          name: 'Rain Shell',
          benefits,
          description: extraSignals.description || 'A packable shell for wet weather.',
          specs: extraSignals.specs || [{ label: 'Material', value: '3L nylon' }],
        },
        social_proof_signal: extraSignals.social_proof_signal || {
          primary_quote: { text: 'Kept me dry on a 12-mile ridge walk.', author: null },
          rating: { value: 4.8, count: 120 },
        },
      };
    },
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

  // ── Item 1: rest of assembleSignals lands in the video-title prompt ──
  {
    const occupancy = occupancyBrief({ size: '9:16', profile: 'consideration' });
    const rich = buildDirectorMessages({
      size: '9:16',
      profile: 'consideration',
      occupancy,
      benefits: ['Keeps you dry', 'Packs flat'],
      productSignal: {
        name: 'Rain Shell',
        description: 'A packable shell for wet weather.',
        specs: [{ label: 'Material', value: '3L nylon' }],
      },
      brandSignal: { name: 'Acme', tagline: 'Stay out longer', tone: ['rugged'] },
      socialProofSignal: {
        primary_quote: { text: 'Kept me dry on a 12-mile ridge walk.', author: null },
        rating: { value: 4.8, count: 120 },
      },
    });
    const user = rich[1].content;
    check('I1 prompt contains PRODUCT DESCRIPTION when present',
      user.includes('PRODUCT DESCRIPTION:') && user.includes('A packable shell for wet weather.'));
    check('I1b prompt contains PRODUCT SPECS when present',
      user.includes('PRODUCT SPECS:') && user.includes('3L nylon'));
    check('I1c prompt contains printable SOCIAL PROOF quote when present',
      user.includes('SOCIAL PROOF:') && user.includes('Kept me dry on a 12-mile ridge walk.'));
    check('I1d prompt contains BRAND TONE + TAGLINE when present',
      user.includes('BRAND TONE:') && user.includes('rugged')
        && user.includes('BRAND TAGLINE:') && user.includes('Stay out longer'));
    check('I1e occupancy / slots / keep-out still present',
      user.includes('SLOTS ALREADY IN TARGET PHASE:')
        && user.includes('SURFACE KEEP-OUT KEY:'));
    check('I1f printable quote has no invented byline',
      !user.includes('vertexaisearch') && !user.includes('Verified buyer'));

    const thin = buildDirectorMessages({
      size: '9:16',
      profile: 'consideration',
      occupancy,
      benefits: ['Keeps you dry'],
      productSignal: { name: 'Rain Shell' },
      brandSignal: { name: 'Acme' },
    });
    const thinUser = thin[1].content;
    check('I1g absent fields omit their lines (not empty keys)',
      !thinUser.includes('PRODUCT DESCRIPTION:')
        && !thinUser.includes('PRODUCT SPECS:')
        && !thinUser.includes('SOCIAL PROOF:')
        && !thinUser.includes('BRAND TONE:')
        && !thinUser.includes('BRAND TAGLINE:'));
  }

  // ── Item 9: assembleSignals once per product ──
  resetVideoTitleDirectionMemo();
  let assembles = 0;
  await driveKit(['p1'], stubDeps({ onAssemble: () => { assembles += 1; } }));
  check('N1 21 ads × 1 product ⇒ 1 assembleSignals (not 6)',
    assembles === 1,
    `got ${assembles}`);

  resetVideoTitleDirectionMemo();
  assembles = 0;
  const once = makeAssembleSignalsOnce(async () => {
    assembles += 1;
    return {
      brand_signal: { name: 'Acme' },
      product_signal: { name: 'Rain Shell', benefits: ['Keeps you dry'] },
      social_proof_signal: null,
    };
  });
  await driveKit(['p1'], {
    assembleSignals: once,
    chatCompletion: stubDeps().chatCompletion,
  });
  await once({ brandId: '000000000000000000000001', productId: 'p1', campaignKind: 'product' });
  check('N2 static + video-title still 1 assembleSignals per product',
    assembles === 1,
    `got ${assembles}`);

  resetVideoTitleDirectionMemo();
  assembles = 0;
  await driveKit(['p1', 'p2'], stubDeps({ onAssemble: () => { assembles += 1; } }));
  check('N3 2 products ⇒ 2 assembleSignals (one each)',
    assembles === 2,
    `got ${assembles}`);

  // ── wiring + mutation proofs ──
  const vbdSrc = fs.readFileSync(path.join(ROOT, 'services/videoBenefitsDirector.js'), 'utf8');
  const genSrc = fs.readFileSync(path.join(ROOT, 'services/campaignAdsGenerationService.js'), 'utf8');
  check('N4 expandDeterministicVideo passes deps.assembleSignals',
    /assembleSignalsDep \? \{ assembleSignals: assembleSignalsDep \}/.test(genSrc));
  check('N5 expandWizardJob creates makeAssembleSignalsOnce and shares it',
    /makeAssembleSignalsOnce\(assembleSignals\)/.test(genSrc)
      && /assembleSignals: assembleSignalsOnce/.test(genSrc));
  check('N6 runVideoTitleDirector memoizes assembleSignals per product',
    /signalsMemo\.set\(sKey, signalsP\)/.test(vbdSrc));
  check('I1s source emits PRODUCT DESCRIPTION / SPECS / SOCIAL PROOF lines',
    /PRODUCT DESCRIPTION:/.test(vbdSrc)
      && /PRODUCT SPECS:/.test(vbdSrc)
      && /SOCIAL PROOF:/.test(vbdSrc));

  function withTempMutation(filePath, find, replace, runCheck) {
    const original = fs.readFileSync(filePath, 'utf8');
    assert.ok(original.includes(find), `mutate target not found: ${find.slice(0, 80)}`);
    const mutated = original.replace(find, replace);
    const tmp = path.join(os.tmpdir(), `verifyVBD-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(tmp, mutated);
    try { runCheck(fs.readFileSync(tmp, 'utf8')); }
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* tmp */ } }
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), original, 'real file was modified');
  }

  {
    let failedAsExpected = false;
    withTempMutation(
      path.join(ROOT, 'services/videoBenefitsDirector.js'),
      'PRODUCT DESCRIPTION:',
      'PRODUCT_DESC_REMOVED:',
      (mutSrc) => {
        failedAsExpected = !/PRODUCT DESCRIPTION:/.test(mutSrc)
          && /PRODUCT SPECS:/.test(mutSrc);
      }
    );
    check('RP-I1 [REVERT-PROOF] dropping PRODUCT DESCRIPTION fails I1s',
      failedAsExpected);
  }
  {
    let failedAsExpected = false;
    withTempMutation(
      path.join(ROOT, 'services/videoBenefitsDirector.js'),
      'signalsMemo.set(sKey, signalsP);',
      '/* signals-memo-set-removed */',
      (mutSrc) => {
        failedAsExpected = !/signalsMemo\.set\(sKey, signalsP\)/.test(mutSrc);
      }
    );
    check('RP-N6 [REVERT-PROOF] dropping product signals memo fails N6',
      failedAsExpected);
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
