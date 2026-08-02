#!/usr/bin/env node
/**
 * Offline harness for regeneration identity and preset routing.
 * No DB, no network, no API key.
 *
 * Two production failures on 2026-08-01, both silent:
 *
 *   R1  A second Generate on a campaign produced NOTHING. The static
 *       identityDigest did not include the run, so every candidate collided
 *       with the first run's ads on the per-campaign unique index. Owner rule:
 *       "there should be no limitation on creating new ads that may be
 *       duplicates since generative ads always have new seeds."
 *   R2  Static runs also queued Veo videos. `kinds` defaulted to 'both', and
 *       resolveKinds returned BOTH kinds when asked for one the surface did
 *       not support. The product has two separate presets.
 *
 * The money invariant these must not break (CLAUDE.md §2): a generation POST
 * is billable, so the digest still has to be STABLE WITHIN ONE RUN. Scoping to
 * the run id — not a random nonce — is what keeps a replayed handler, retried
 * batch or reaper requeue deduping exactly as before.
 *
 * Run: node scripts/verifyRegeneration.js
 */
const gen = require('../services/campaignAdsGenerationService');
const pf = require('../services/platformFormats');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const BASE = {
  campaignId: '6a6a52cdcb097b4db3f8084d',
  productId: '6a6a4d58054561c15f3ff8a2',
  mediaId: '6a6a4d58054561c15f3ff8ff',
  template: 'ai_promotional',
  aspectRatio: '1:1',
  variantKind: 'product_image',
  paletteSource: 'media',
  ctaText: 'Shop Now',
  ctaUrl: 'https://example.com',
  ctaUrlParams: '',
  rafflePrizeMediaId: null
};
const d = (over) => gen.computeIdentityDigest({ ...BASE, ...over });

// ── R1: a new run must produce new ads ──────────────────────────────────
const runA = 'run_1785617697150_4002661b';
const runB = 'run_1785617812345_9f3ca771';

check('R1 same run + same inputs -> SAME digest (idempotent within a run)',
  d({ kind: 'image', generationRunId: runA }) === d({ kind: 'image', generationRunId: runA }));

check('R1 different run -> DIFFERENT digest (regeneration is allowed)',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runB }));

// The whole money argument: the run id is not a random nonce. Two calls inside
// one run — a replayed handler, a retried batch — must still collide.
const replay = [];
for (let i = 0; i < 5; i++) replay.push(d({ kind: 'image', generationRunId: runA }));
check('R1 five replays within one run all collide (no double-billing)',
  new Set(replay).size === 1, `got ${new Set(replay).size} distinct digests`);

// Backwards compatibility: a caller that passes nothing must hash EXACTLY as
// before, or every pre-existing ad's digest silently changes meaning.
check('R1 omitting the run id is byte-identical to passing undefined',
  d({ kind: 'image' }) === d({ kind: 'image', generationRunId: null }));
check('R1 omitting the run id differs from any run-scoped digest',
  d({ kind: 'image' }) !== d({ kind: 'image', generationRunId: runA }));

// ── R1b: video stays deterministic ──────────────────────────────────────
// Owner: "veo should only generate a video once for each product unless it is
// revised or another custom video is selected." The run id must NOT reach the
// video digest, or every Generate re-bills a Veo master.
check('R1b video digest ignores the run id (Veo once per product)',
  d({ kind: 'video', generationRunId: runA }) === d({ kind: 'video', generationRunId: runB }),
  'a new run would re-bill a Veo generation');
check('R1b image and video digests still differ from each other',
  d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'video', generationRunId: runA }));

// Every other identity field must still separate ads within one run.
for (const [field, value] of [
  ['aspectRatio', '4:5'], ['template', 'ai_social_proof_led'], ['mediaId', 'ffffffffffffffffffffffff'],
  ['productId', 'ffffffffffffffffffffffff'], ['ctaText', 'Buy Now'], ['variantKind', 'lifestyle']
]) {
  check(`R1 ${field} still separates ads inside one run`,
    d({ kind: 'image', generationRunId: runA }) !== d({ kind: 'image', generationRunId: runA, [field]: value }));
}

// ── R2: presets do not bleed into each other ────────────────────────────
const KINDS = [
  ['meta_feed_1_1', 'image', ['image']],
  ['meta_feed_1_1', 'video', ['video']],
  ['meta_feed_4_5', 'image', ['image']],
  ['meta_stories_9_16', 'image', ['image']],
  ['pmax_16_9', 'image', ['image']],
  // The inversion that billed a video to someone who picked static.
  ['meta_reels_9_16', 'image', []],
  ['meta_reels_9_16', 'video', ['video']],
  // Explicit 'both' is still honoured — it is a real caller (deterministic video expansion).
  ['meta_feed_1_1', 'both', ['image', 'video']]
];
for (const [fmt, requested, expected] of KINDS) {
  const got = pf.resolveKinds(fmt, requested);
  check(`R2 ${fmt} + ${requested} -> ${JSON.stringify(expected)}`,
    JSON.stringify(got) === JSON.stringify(expected), `got ${JSON.stringify(got)}`);
}
check('R2 a static request never yields a billable video kind',
  ['meta_feed_1_1', 'meta_feed_4_5', 'meta_stories_9_16', 'pmax_16_9', 'meta_reels_9_16']
    .every((f) => !pf.resolveKinds(f, 'image').includes('video')));

if (failures.length) {
  console.error(`\n❌ regeneration: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ regeneration: ${pass} checks passed`);
