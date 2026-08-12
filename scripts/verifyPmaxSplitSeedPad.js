'use strict';
/**
 * verifyPmaxSplitSeedPad — the PMax 16:9 split-stage seed must never ship a band,
 * and must never be confused with a plain reframe of the same media.
 *
 * WHY THIS EXISTS. The split unit deliberately pre-composes the product hard
 * against one edge of a 16:9 canvas so a maskless outfill model has an obviously
 * empty half to fill. That creates two brand-new ways to ship a defect into a
 * BILLABLE video master, neither of which the existing guards catch:
 *
 *   1. PADDING A SPLIT SEED. If the outfill fails, the generic fallback would
 *      pad the frame — but on a split, "pad the rest" means half the frame is
 *      flat fill. Worse, detectBorderFill would often call that fill *uniform*
 *      (it is — it's our own fill), so seedPadDecision would happily approve it.
 *      That is PR #155's letterbox defect at 50% scale. Split seeds must CROP,
 *      always, and let the caller fall back to the designed brand_panel.
 *
 *   2. CACHE COLLISION. Media.metadata.reframes was keyed on aspect alone. A
 *      subject-hard-right seed and a plain centred 16:9 reframe are both "16_9";
 *      without a split dimension the cache would hand a video run the wrong
 *      seed silently — costing a master and looking like a model failure.
 *
 * It also pins the prompt contract: direction is steered by prompt + a
 * pre-composed canvas because the Atlas image API has NO mask/region parameter,
 * and the extended region is described in purely visual terms — never as "room
 * for text" — because the same submit carries a hard no-text directive and any
 * mention of copy invites rendered letterforms that fail review.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  seedPadDecision,
  reframeOutpaintPrompt,
  reframePromptForSplitAspect
} = require('../services/atlasVideoService');

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; void label; };

console.log('verifyPmaxSplitSeedPad\n');

// ── A. the directional prompt ─────────────────────────────────────────────────

const ctx = { productTitle: 'Gymshark Training Oversized 1/4 Zip' };

ok('east anchors the subject right and extends left', () => {
  const p = reframePromptForSplitAspect('16:9', 'east', ctx);
  assert.ok(/subject is already positioned on the right side/i.test(p), p.slice(0, 200));
  assert.ok(/ONLY the left side/i.test(p));
  assert.ok(!/ONLY the right side/i.test(p), 'must not tell the model to extend the subject side');
});

ok('west is the exact mirror', () => {
  const p = reframePromptForSplitAspect('16:9', 'west', ctx);
  assert.ok(/subject is already positioned on the left side/i.test(p));
  assert.ok(/ONLY the right side/i.test(p));
  assert.ok(!/ONLY the left side/i.test(p));
});

ok('the extension is described visually, NEVER as room for copy', () => {
  // The same billable submit carries a hard no-text directive. Any wording that
  // makes the model think about copy is a way to get letterforms into pixels,
  // which fails review and wastes the master.
  //
  // Two-part check. First: no invitation phrasing, ever — these are the exact
  // constructions that would brief the model to leave a lettering area.
  const INVITATIONS = [
    /room for/i, /space for (the )?(text|copy|headline|caption)/i,
    /area for/i, /place for/i, /reserved for/i, /will carry/i, /overlay/i
  ];
  // Second: any bare mention of copy vocabulary must sit inside a prohibition.
  // The window is generous (90 chars) because the legitimate use is a list —
  // "no new objects, props, people, patterns or text of any kind" — where the
  // negating "no" is far from the final item. A narrow window flagged our own
  // correct prompt on first run, which is why this is written out rather than
  // tightened into a false failure.
  //
  // SCOPE: the vocabulary sweep runs on the DIRECTIONAL clause only — the
  // sentence this feature actually authored. The hardening clauses after it are
  // inherited verbatim from reframePromptForAspect and already carry a
  // legitimate mention ("preserve ... label text" = keep the lettering that is
  // physically printed on the product). Re-flagging those would either produce
  // a permanent false failure or pressure someone into editing a shared,
  // byte-identity-protected string. The invitation sweep still covers the whole
  // prompt, since no clause may ever brief the model to leave a copy area.
  const VOCAB = ['text', 'copy', 'caption', 'headline', 'lettering', 'wording', 'typography'];
  for (const side of ['east', 'west']) {
    const full = reframePromptForSplitAspect('16:9', side, ctx).toLowerCase();
    for (const bad of INVITATIONS) {
      assert.ok(!bad.test(full), `split prompt invites copy placement via ${bad}`);
    }
    const cut = full.search(/subject identity:|physical accuracy:/);
    const p = cut === -1 ? full : full.slice(0, cut);
    assert.ok(p.length > 200, 'directional clause unexpectedly short — check the split');
    for (const word of VOCAB) {
      let idx = p.indexOf(word);
      while (idx !== -1) {
        const window = p.slice(Math.max(0, idx - 90), idx + word.length);
        assert.ok(
          /\bno\b|\bnot\b|never|without/.test(window),
          `"${word}" appears outside a prohibition: ...${window}`
        );
        idx = p.indexOf(word, idx + 1);
      }
    }
  }
});

ok('subject preservation + person guards ride on every split prompt', () => {
  for (const side of ['east', 'west']) {
    const p = reframePromptForSplitAspect('16:9', side, ctx);
    assert.ok(/SUBJECT IDENTITY/.test(p), 'lost product-identity protection');
    assert.ok(/PHYSICAL ACCURACY/.test(p), 'lost the anatomy guard');
    // Unconditional on a split: the subject is edge-adjacent BY CONSTRUCTION,
    // which is exactly when a model invents unseen anatomy sideways.
    assert.ok(/SOURCE-EDGE PROTECTION/.test(p), 'lost edge protection on a split');
    assert.ok(/no visible seam|no visible seam, border, band/i.test(p), 'lost the seam guard');
  }
});

ok('a split prompt never tells the model to move or rescale the subject', () => {
  const p = reframePromptForSplitAspect('16:9', 'east', ctx);
  assert.ok(/Do NOT move, re-centre, rescale or duplicate it/i.test(p));
});

// ── B. byte-identity for every existing (non-split) caller ────────────────────

ok('no subjectSide → the plain prompt, unchanged', () => {
  const plain   = reframeOutpaintPrompt('16:9', ctx);
  const nulled  = reframeOutpaintPrompt('16:9', { ...ctx, subjectSide: null });
  const garbage = reframeOutpaintPrompt('16:9', { ...ctx, subjectSide: 'sideways' });
  assert.strictEqual(plain, nulled, 'explicit null changed the plain prompt');
  assert.strictEqual(plain, garbage, 'an unrecognised side must fall back to plain');
  assert.ok(!/already positioned on the/i.test(plain), 'split language leaked into the plain prompt');
});

ok('split routing only fires on a real side', () => {
  const split = reframeOutpaintPrompt('16:9', { ...ctx, subjectSide: 'east' });
  assert.ok(/already positioned on the right/i.test(split));
  assert.notStrictEqual(split, reframeOutpaintPrompt('16:9', ctx));
});

// ── C. split seeds must never pad ─────────────────────────────────────────────

ok('seedPadDecision would APPROVE our own fill — which is why split must bypass it', () => {
  // This is the trap the guard exists for: the half-frame we composed is
  // genuinely uniform, so the generic decision says "pad-solid".
  assert.strictEqual(seedPadDecision({ uniform: true, hex: 'ffffff' }).action, 'pad-solid');
});

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'atlasVideoService.js'), 'utf8'
);

ok('the post-outfill fallback bypasses seedPadDecision when splitSide is set', () => {
  // Wiring check (labelled as such): the decision sits behind Mongo + network
  // I/O that an offline harness cannot drive, so source shape is the honest
  // tool. Behavioural coverage of the rule itself is section A/B above.
  assert.ok(
    /splitSide\s*\?\s*\{\s*action:\s*'crop',\s*reason:\s*'split-seed-never-pads'\s*\}/.test(SRC),
    'split seeds can reach seedPadDecision again — they must always crop'
  );
});

ok('the reframe cache key carries the split side', () => {
  assert.ok(
    /_split_\$\{splitSide\}/.test(SRC),
    'split seeds share the plain aspect cache key — wrong-direction seeds will be served'
  );
});

ok('padSolidBuffer still defaults to centre for every existing caller', () => {
  assert.ok(
    /padSolidBuffer\(srcBuffer, W, H, hex, gravity = 'center'\)/.test(SRC),
    'the gravity default changed — existing pads would silently move'
  );
});

console.log(`\n✅ verifyPmaxSplitSeedPad: ${checks}/${checks} checks passed`);
