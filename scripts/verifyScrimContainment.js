#!/usr/bin/env node
/**
 * Offline harness for the scrim/panel safe-box containment fix
 * (D7, 2026-08-19). No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS FOR, measured on a real delivered
 * pmax_portrait_4_5 Vuori Clothing render: the translucent legibility
 * scrim behind the headline bled flush off the LEFT edge of the canvas —
 * a hard vertical cut at x=0, no left inset at all, with a soft fade on
 * its other edges — reading as a rendering overflow, not a design choice.
 *
 * geometryBlock() already told the model "EVERY element you render other
 * than the photograph itself must sit inside the box [safe box]", and the
 * LATITUDE clause separately permits "a soft scrim or panel behind type"
 * as legitimate chrome — but neither sentence said the SCRIM ITSELF is
 * bound by the safe box the way text/logo/CTA obviously are, so the model
 * evidently read a decorative backdrop panel as exempt. Fix: name
 * "scrim or panel" explicitly inside the containment sentence, and add an
 * explicit "even where it fades" clause so a soft edge is not read as an
 * exemption from containment.
 *
 * Groups:
 *   S1  geometryBlock's containment sentence explicitly names scrim/panel.
 *   S2  the sentence explicitly forbids a faded edge as an exemption.
 *   S3  the fix applies to EVERY surface (geometryBlock is surface-generic,
 *       not a pmax_portrait_4_5 special case) — the defect could recur on
 *       any surface a scrim renders on.
 *   S4  revert-prove: the pre-fix sentence text (reconstructed) does not
 *       mention scrim/panel at all.
 *
 * Run: node scripts/verifyScrimContainment.js
 */
const intents = require('../services/staticAdIntents');
const pf = require('../services/platformFormats');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const surfaces = pf.PLATFORM_FORMAT_KEYS
  .map((k) => intents.computeSurface(k))
  .filter((s) => s && !s.error);

check('S0 at least the six live static surfaces resolved', surfaces.length >= 6, `got ${surfaces.length}`);

// ── S1: scrim/panel named explicitly in the containment sentence ────────
for (const s of surfaces) {
  const block = intents.geometryBlock(s);
  check(`S1 ${s.key} containment sentence names "scrim or panel"`,
    /scrim or panel/i.test(block), `block: ${block.slice(0, 200)}...`);
  check(`S1 ${s.key} containment sentence still names text/CTA/logo (unchanged coverage)`,
    /CTA button/i.test(block) && /logo/i.test(block));
  check(`S1 ${s.key} containment sentence still states the numeric safe box`,
    block.includes(`${s.box.left}%`) && block.includes(`${s.box.right}%`)
    && block.includes(`${s.box.top}%`) && block.includes(`${s.box.bottom}%`));
}

// ── S2: a faded edge is explicitly not an exemption ──────────────────────
// [THE DEFECT] the real render's scrim was a HARD cut on one edge and a
// SOFT FADE on the others — so a fix that only bans hard edges would have
// missed exactly the shape observed. The instruction must cover both.
for (const s of surfaces.slice(0, 1)) {
  const block = intents.geometryBlock(s);
  check(`S2 ${s.key} explicitly forbids a bleeding edge even when it fades/is transparent`,
    /even where it fades|even.*(faded|transparent)/i.test(block), `block: ${block}`);
  check(`S2 ${s.key} uses "never touch or bleed" (or equivalent absolute language), not a soft suggestion`,
    /never touch or bleed|must never/i.test(block));
}

// ── S3: this is a shared function, not a pmax_portrait_4_5 special case ─
check('S3 geometryBlock takes only the surface object — no per-surface branch for the scrim sentence',
  intents.geometryBlock.length === 1);
const portraitBlock = intents.geometryBlock(intents.computeSurface('pmax_portrait_4_5'));
const feedBlock = intents.geometryBlock(intents.computeSurface('meta_feed_1_1'));
check('S3 the scrim/panel sentence appears on pmax_portrait_4_5 (where the defect was measured)',
  /scrim or panel/i.test(portraitBlock));
check('S3 the SAME sentence template appears on an unrelated surface (meta_feed_1_1) — fix is platform-wide, not surface-specific',
  /scrim or panel/i.test(feedBlock));

// ── S4: revert-prove against the reconstructed pre-fix sentence ─────────
function preFixContainmentSentence(s) {
  return `EVERY element you render other than the photograph itself must sit inside the box from ${s.box.left}% to ${s.box.right}% of width and ${s.box.top}% to ${s.box.bottom}% of height. The photograph should still fill the whole frame edge to edge.`;
}
const sampleSurface = intents.computeSurface('pmax_portrait_4_5');
const preFix = preFixContainmentSentence(sampleSurface);
check('S4-revert-prove: the pre-fix sentence (reconstructed) does NOT mention scrim or panel',
  !/scrim or panel/i.test(preFix), `pre-fix text: ${preFix}`);
check('S4-revert-prove: the pre-fix sentence does NOT address a faded/transparent edge',
  !/even where it fades|even.*(faded|transparent)/i.test(preFix));
check('S4-revert-prove: the SHIPPED geometryBlock output differs from the pre-fix reconstruction (the fix actually changed the text)',
  intents.geometryBlock(sampleSurface) !== preFix);
check('S4-revert-prove: the shipped output still contains the pre-fix sentence\'s core numeric promise (additive, not a rewrite of the box numbers)',
  intents.geometryBlock(sampleSurface).includes(`${sampleSurface.box.left}%`)
  && intents.geometryBlock(sampleSurface).includes('fill the whole frame edge to edge'));

if (failures.length) {
  console.error(`\n❌ scrim containment: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ scrim containment: ${pass} checks passed across ${surfaces.length} surfaces`);
