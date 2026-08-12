#!/usr/bin/env node
/**
 * verifyTextMotionIntent.mjs — PMax 10s text motion must be purposeful.
 * Offline: no DB, no network. ESM (remotion/ is "type":"module");
 * titleSpecValidator is pulled via createRequire.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Muted autoplay (PMax landscape especially) makes the TEXT the message.
 * A viewer gets ~2–3s per beat. The failure mode this guards against:
 *
 *   1. Uniform long fades (0.6–0.8s) on every slot — the first third of a
 *      beat is spent squinting, not reading. Motion decorated instead of
 *      supporting comprehension.
 *   2. Every slot animated the same way — a persistent brand pill and a
 *      transient quote have different jobs; treating them identically
 *      wastes motion budget and flattens hierarchy.
 *   3. Landscape as a single 0–10s "main" phase with every line holding
 *      forever — competing primary lines on screen at once, no beat
 *      choreography tracking the Omni camera cuts (t1=dur/3, t2=0.64*dur).
 *   4. Horizontal slides that enter FROM the product/midline on a left
 *      copy column (direction:'left') — drags the eye across the product
 *      instead of settling into the reserved column.
 *   5. Exits that leave two primary reading lines fully solid at once.
 *
 * WHAT IS IN SCOPE
 * ----------------
 * The three funnel PMax 10s presets (canonical-{awareness,consideration,
 * conversion}-pmax10.json), all four formats. Beat GRID and specTimeScale
 * are intentionally NOT mutated here — only motion within the beats.
 *
 * CEILINGS (authoritative — change here AND the presets together)
 *   MAX_ENTER_SEC = 0.35   // few hundred ms; hold is the beat
 *   MAX_EXIT_SEC  = 0.30
 *
 * SLIDE DIRECTION RULE (landscape left-authored / west-default column)
 *   Prefer direction:'up' (vertical settle; side-agnostic for runtime
 *   panelSide east|west). Horizontal slides, if used, must enter from
 *   the OUTER edge: direction:'right' (travel rightward from further-left
 *   into place). direction:'left' is forbidden on left-aligned landscape
 *   slots — that is the product-side enter.
 *
 * REVERT-PROOF: restore one slot to enterDurationSec:0.8 (or uniform fade
 * on a primary that must slide/pop) → bounded-enter / role-motion checks
 * go red. Restore → green.
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  validateTitleSpec,
  TRANSITIONS,
} = require('../services/titleSpecValidator');

// DIRECTIONS is validated by titleSpecValidator but not exported — keep in
// lockstep with services/titleSpecValidator.js DIRECTIONS.
const DIRECTIONS = ['up', 'down', 'left', 'right'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const MAX_ENTER_SEC = 0.35;
const MAX_EXIT_SEC = 0.30;
// Hold must dominate the visible window: enter is a few hundred ms, not half the beat.
const MIN_HOLD_FRAC = 0.55;

const FUNNELS = ['awareness', 'consideration', 'conversion'];
const FORMATS = ['vertical', 'feed', 'square', 'landscape'];
// Primary reading lines that replace each other across beats (not support chrome).
const PRIMARY_KEYS = new Set(['headline', 'quote']);
// CTA may coexist with productName / deliveryLine by design (conversion).

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

function loadPreset(funnel) {
  const p = path.join(ROOT, 'remotion/presets', `canonical-${funnel}-pmax10.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function solidWindow(slot, clipEnd = 10) {
  const t = slot.timing || {};
  const enter = Number(t.enterAtSec) || 0;
  const enterDur = Number(t.enterDurationSec) || 0;
  const exit = t.exitAtSec == null ? clipEnd : Number(t.exitAtSec);
  return { solidStart: enter + enterDur, solidEnd: exit, enter, enterDur, exit };
}

function clipExtent(spec) {
  return Math.max(0, ...(spec.phases || []).map((p) => p.endSec || 0));
}

/** Phase cut points that should track the camera grid on 10s plates. */
function phaseCuts(spec) {
  const phases = spec.phases || [];
  // Internal cuts = every phase start except 0, plus we care about the
  // first two internal boundaries approximating t1/t2 when multi-phase.
  return phases.slice(1).map((p) => p.startSec);
}

console.log('verifyTextMotionIntent\n');

// ── 0. Ceilings are the ones this file documents ───────────────────────────
check('0a MAX_ENTER_SEC is 0.35 (few hundred ms)', MAX_ENTER_SEC === 0.35);
check('0b MAX_EXIT_SEC is 0.30', MAX_EXIT_SEC === 0.30);

// ── 1–6 per funnel × format ────────────────────────────────────────────────
for (const funnel of FUNNELS) {
  const doc = loadPreset(funnel);
  check(`${funnel} preset loads with byFormat`, !!doc?.byFormat);

  for (const fmt of FORMATS) {
    const spec = doc.byFormat?.[fmt];
    check(`${funnel}/${fmt} exists`, !!spec);
    if (!spec) continue;

    // 6. Validator vocabulary + schema
    const res = validateTitleSpec(spec, { format: fmt });
    check(`${funnel}/${fmt} validates (titleSpecValidator)`, res.ok,
      (res.errors || []).join('; '));

    const extent = clipExtent(spec);
    check(`${funnel}/${fmt} extent is 10s (PMax plate)`, Math.abs(extent - 10) < 0.01,
      `extent=${extent}`);

    const slots = spec.slots || [];
    for (const [i, slot] of slots.entries()) {
      const where = `${funnel}/${fmt} slots[${i}](${slot.key})`;
      const t = slot.timing || {};
      const tr = slot.transition || {};
      const enterDur = Number(t.enterDurationSec);
      const exitDur = t.exitDurationSec == null ? null : Number(t.exitDurationSec);

      // 1. Bounded enter — no slow reveals eating the beat
      check(`${where} enterDurationSec ≤ ${MAX_ENTER_SEC}`,
        Number.isFinite(enterDur) && enterDur <= MAX_ENTER_SEC + 1e-9,
        `enterDurationSec=${enterDur}`);

      if (exitDur != null) {
        check(`${where} exitDurationSec ≤ ${MAX_EXIT_SEC}`,
          Number.isFinite(exitDur) && exitDur <= MAX_EXIT_SEC + 1e-9,
          `exitDurationSec=${exitDur}`);
      }

      // 4. Transition type / direction in validator vocabulary
      const trType = tr.type ?? 'fade';
      const trDir = tr.direction ?? 'up';
      check(`${where} transition.type in vocabulary`,
        TRANSITIONS.includes(trType), `type=${trType}`);
      check(`${where} transition.direction in vocabulary`,
        DIRECTIONS.includes(trDir), `direction=${trDir}`);

      // 2. Movement ends before the hold — enter is a minority of the window
      const { solidStart, solidEnd, enter, enterDur: ed } = solidWindow(slot, extent);
      const visibleLen = Math.max(0, solidEnd - enter);
      const holdLen = Math.max(0, solidEnd - solidStart);
      if (visibleLen >= 0.8) {
        // Only assert hold-dominance on windows long enough to be a real beat
        check(`${where} hold dominates visible window (enter settles, then still)`,
          holdLen >= MIN_HOLD_FRAC * visibleLen - 1e-9,
          `hold=${holdLen.toFixed(3)} visible=${visibleLen.toFixed(3)} frac=${(holdLen / visibleLen).toFixed(2)}`);
      }
      // Movement end is enter+enterDur; solid window must be non-empty for
      // slots that actually show (visible !== false).
      if (slot.visible !== false && t.exitAtSec !== 0) {
        check(`${where} solid window non-empty after enter settles`,
          solidEnd > solidStart + 1e-9,
          `solidStart=${solidStart} solidEnd=${solidEnd}`);
      }

      // 5. Landscape slide direction rule (left-authored column)
      if (fmt === 'landscape' && trType === 'slide') {
        const align = slot.position?.align || 'left';
        if (align === 'left') {
          check(`${where} left-column slide is not direction:'left' (product-side enter forbidden)`,
            trDir !== 'left',
            `direction=${trDir} — use 'up' (preferred) or 'right' (outer edge)`);
          check(`${where} left-column slide direction is up|down|right`,
            trDir === 'up' || trDir === 'down' || trDir === 'right',
            `direction=${trDir}`);
        }
      }
    }

    // Role diversity: not every slot is the same transition type when
    // there are ≥3 visible slots (guards uniform-fade regression).
    const visibleSlots = slots.filter((s) => s.visible !== false);
    if (visibleSlots.length >= 3) {
      const types = new Set(visibleSlots.map((s) => (s.transition?.type || 'fade')));
      check(`${funnel}/${fmt} uses >1 transition type across visible slots (not uniform)`,
        types.size >= 2,
        `types=${[...types].join(',')}`);
    }

    // 3. Competing primary lines: fully-solid windows must not overlap.
    // Only compare slots that are actually on-screen candidates
    // (visible !== false, not gated visibleWhenEmpty).
    const primaries = slots.filter((s) =>
      PRIMARY_KEYS.has(s.key)
      && s.visible !== false
      && !s.visibleWhenEmpty
    );
    for (let i = 0; i < primaries.length; i++) {
      for (let j = i + 1; j < primaries.length; j++) {
        const a = primaries[i];
        const b = primaries[j];
        // Same key in different phases is the sequential case we care about
        // (hook headline vs proof quote). Same-phase duplicates shouldn't exist
        // for primaries without visibleWhenEmpty.
        const wa = solidWindow(a, extent);
        const wb = solidWindow(b, extent);
        const overlap = Math.min(wa.solidEnd, wb.solidEnd) - Math.max(wa.solidStart, wb.solidStart);
        check(
          `${funnel}/${fmt} primary '${a.key}'@${a.phase} vs '${b.key}'@${b.phase}: no fully-solid overlap`,
          overlap <= 1e-9,
          `overlap=${overlap.toFixed(3)}s  A=[${wa.solidStart.toFixed(2)},${wa.solidEnd.toFixed(2)}] B=[${wb.solidStart.toFixed(2)},${wb.solidEnd.toFixed(2)}]`
        );
      }
    }
  }

  // Landscape must be multi-phase sequential (the defect was single "main" 0–10).
  const land = doc.byFormat.landscape;
  check(`${funnel}/landscape has ≥2 phases (timed beats, not one forever-stack)`,
    (land.phases || []).length >= 2,
    `phases=${(land.phases || []).map((p) => p.key).join(',')}`);
}

// ── 7. Beat grid untouched ─────────────────────────────────────────────────
// Camera beats live in veoPromptBuilder: t1=dur/3, t2=dur*0.64. Preset phase
// cuts on conversion (the funnel that documents camera alignment) must stay
// near those marks at 10s. We do NOT require every funnel's first cut == t1
// (awareness deliberately has a longer hook) — we require the source still
// defines t1/t2 that way and conversion's cuts still track.
{
  const veoSrc = readFileSync(path.join(ROOT, 'services/veoPromptBuilder.js'), 'utf8');
  check('7a veoPromptBuilder still defines t1 = dur/3',
    /const\s+t1\s*=\s*\(\s*dur\s*\/\s*3\s*\)/.test(veoSrc)
    || /t1\s*=\s*\(dur\s*\/\s*3\)/.test(veoSrc)
    || /const t1\s*=\s*\(dur \/ 3\)/.test(veoSrc));
  // Broader match — the live source uses (dur / 3).toFixed(2)
  check('7a′ t1 from dur/3 present in veoPromptBuilder',
    /dur\s*\/\s*3/.test(veoSrc));
  check('7b veoPromptBuilder still defines t2 = dur*0.64',
    /dur\s*\*\s*0\.64/.test(veoSrc));

  const conv = loadPreset('conversion').byFormat.vertical;
  const cuts = phaseCuts(conv);
  // vertical conversion: hook→proof at 3.125 (≈10/3), proof→close at 6.375 (≈6.4)
  check('7c conversion vertical first cut ≈ t1 (10/3 ≈ 3.333)',
    cuts.length >= 1 && Math.abs(cuts[0] - 10 / 3) < 0.25,
    `cuts[0]=${cuts[0]}`);
  check('7d conversion vertical second cut ≈ t2 (0.64*10 = 6.4)',
    cuts.length >= 2 && Math.abs(cuts[1] - 6.4) < 0.25,
    `cuts[1]=${cuts[1]}`);

  const convLand = loadPreset('conversion').byFormat.landscape;
  const landCuts = phaseCuts(convLand);
  check('7e conversion landscape first cut ≈ t1',
    landCuts.length >= 1 && Math.abs(landCuts[0] - 10 / 3) < 0.25,
    `cuts[0]=${landCuts[0]}`);
  check('7f conversion landscape second cut ≈ t2',
    landCuts.length >= 2 && Math.abs(landCuts[1] - 6.4) < 0.25,
    `cuts[1]=${landCuts[1]}`);

  // specTimeScale contract: symmetric scale, exact-match → 1. Read source
  // rather than importing remotion (may be absent in this worktree).
  const timingSrc = readFileSync(path.join(ROOT, 'remotion/lib/timing.js'), 'utf8');
  check('7g specTimeScale still returns clipSec/extent (symmetric stretch)',
    /return\s+clipSec\s*\/\s*extent/.test(timingSrc));
  check('7h specTimeScale still short-circuits clipSec===extent to 1',
    /clipSec\s*===\s*extent/.test(timingSrc));
}

// ── Role intent pins (spot-check landscape consideration — the archetype) ──
{
  const land = loadPreset('consideration').byFormat.landscape;
  const byKey = Object.fromEntries(
    land.slots.filter((s) => !s.visibleWhenEmpty).map((s) => [s.key, s])
  );
  check('R1 consideration/landscape brandPill is fade (quiet chrome)',
    byKey.brandPill?.transition?.type === 'fade');
  check('R2 consideration/landscape headline is slide (primary reading)',
    byKey.headline?.transition?.type === 'slide');
  check('R3 consideration/landscape quote is slide (transient proof)',
    byKey.quote?.transition?.type === 'slide');
  check('R4 consideration/landscape cta is pop (the ask, emphasis)',
    byKey.cta?.transition?.type === 'pop');
  check('R5 consideration/landscape headline exits before quote is solid',
    (() => {
      const h = solidWindow(byKey.headline);
      const q = solidWindow(byKey.quote);
      return h.solidEnd <= q.solidStart + 1e-9;
    })(),
    'headline solidEnd must be ≤ quote solidStart');
  check('R6 consideration/landscape cta enter is late (close phase)',
    byKey.cta?.phase === 'close' && byKey.cta.timing.enterAtSec >= 8.0,
    `phase=${byKey.cta?.phase} enter=${byKey.cta?.timing?.enterAtSec}`);
}

// ── No scrim reintroduced on landscape slots ───────────────────────────────
for (const funnel of FUNNELS) {
  const land = loadPreset(funnel).byFormat.landscape;
  for (const [i, s] of land.slots.entries()) {
    const scrim = s.treatment?.scrim ?? 'none';
    check(`${funnel}/landscape slots[${i}](${s.key}) scrim is none (owner rule)`,
      scrim === 'none', `scrim=${scrim}`);
  }
}

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyTextMotionIntent: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyTextMotionIntent: ${passed}/${total} checks passed`);
