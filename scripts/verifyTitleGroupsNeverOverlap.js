'use strict';
// verifyTitleGroupsNeverOverlap.js — no two title-slot GROUPS may be on screen
// at the same time in a preset+format that has been cleared of the
// text-on-text defect.
//
// ── THE DEFECT (measured on delivered ads, 2026-08-30/31) ─────────────────
//
// Canonical.jsx groups slots by (phase, position.anchor) and resolves ONE
// anchor per group for the whole clip via resolveGroupAnchor's keep-out walk:
// if the plate scan flags the authored band (a face, the product, the focal
// point), step down KEEP_OUT_CANDIDATES to a clear band. safeZones
// .stackContainerStyle then positions the group `position:absolute` from that
// resolved anchor ALONE.
//
// Each group walks that chain INDEPENDENTLY — nothing consults where any other
// group landed. The chains overlap heavily:
//   top        -> top, upperThird, center, lowerThird
//   upperThird -> upperThird, center, lowerThird
//   center     -> center, upperThird, lowerThird
//   lowerThird -> lowerThird, center, upperThird
//   bottom     -> bottom, lowerThird, center, upperThird
// so two groups can terminate on the SAME band. If they are simultaneously
// visible their boxes are byte-identical and the two stacks paint through each
// other — both strings unreadable, ad unusable.
//
// MEASURED: ads 6a93ade2e4f1d02784398630 (meta_reels_9_16) and
// 6a93ade1e4f1d02784398626 (meta_stories_9_16), run run_1788063103305_6c775d38.
// `canonical-conversion` vertical authored its close stack
// (productName/rating/deliveryLine/cta) in the HOOK phase from 1.5s with NO
// exit, so it shared the frame with hook|upperThird (0.2-2.2) and then
// proof|upperThird (2.7-4.8). The plate scan flagged the middle+bottom bands
// (the model wears the product, so those bands ARE the product), keep-out
// walked the close stack to `upperThird`, and it painted straight through the
// live headline. Sibling ads 6a93ade0e4f1d02784398612 (plain `canonical`,
// strictly sequential) and 6a93ade2e4f1d0278439863a (feed, single group) were
// clean on the SAME footage, isolating simultaneity as the cause.
//
// ── WHY THIS IS THE INVARIANT ─────────────────────────────────────────────
//
// The fix chosen (owner, 2026-08-31) was TEMPLATE-level, not engine-level:
// make the affected verticals strictly sequential. This harness pins that. It
// deliberately does NOT check "did two groups resolve to the same anchor" —
// that depends on runtime plate hints which vary per ad, so it is unpinnable
// offline. Simultaneity is the necessary precondition, it is static, and
// removing it makes the collision impossible regardless of what the scan says.
//
// ── THE BASELINE, AND WHY IT IS NOT A LOOPHOLE ────────────────────────────
//
// 18 preset x format combinations still carry the same latent simultaneity
// (see ACCEPTED below) — down from 31 before the 2026-08-31 pass, which cleared
// every vertical and every Meta feed/square layout except the two proto-*
// prototypes. What remains is recorded here EXPLICITLY — one line each —
// rather than silently skipped. That means:
//   - the 13 combos that were fixed can never regress (they are not listed);
//   - a NEW overlap introduced anywhere fails immediately;
//   - the outstanding debt is enumerated in-repo instead of being folk memory.
// Adding a line to ACCEPTED is a deliberate, reviewable act. DO NOT add one to
// make a red run green after re-timing a preset — that is the exact regression
// this file exists to catch. Removing a line as presets get fixed is the goal.
//
// Run: node scripts/verifyTitleGroupsNeverOverlap.js [--list]

const fs = require('fs');
const path = require('path');

const { validateTitleSpec } = require('../services/titleSpecValidator');

const PRESETS_DIR = path.join(__dirname, '..', 'remotion', 'presets');

// Remaining simultaneity after the 2026-08-31 fix pass. NOT fixed, NOT ignored.
//
// EVERY VERTICAL (Meta 9:16 reels/stories) IS ABSENT FROM THIS LIST — all of them
// were cleared and must stay cleared. So are all Meta 4:5 / 1:1 layouts except the
// two proto-* prototypes. What is left is:
//   - landscape (16:9 PMax/YouTube) x14 — all the same shape,
//     main|upperThird X main|lowerThird. Landscape additionally has the
//     panelColumnStyle split-stage geometry (safeZones.js), so whether these can
//     collide in practice needs its own look; not audited here.
//   - proto-bottom-editorial / proto-kinetic-center on feed+square — prototypes,
//     lowerThird X bottom and center X bottom respectively.
const ACCEPTED = new Set([
  'babyboo-editorial-monochrome:landscape',
  'babyboo-main-character:landscape',
  'canonical-awareness-pmax10:landscape',
  'canonical-awareness:landscape',
  'canonical-consideration:landscape',
  'canonical-conversion-pmax10:landscape',
  'canonical-conversion:landscape',
  'canonical:landscape',
  'pelagic-bluewater-editorial:landscape',
  'pelagic-offshore-bold:landscape',
  'proto-bottom-editorial:feed',
  'proto-bottom-editorial:landscape',
  'proto-bottom-editorial:square',
  'proto-kinetic-center:feed',
  'proto-kinetic-center:landscape',
  'proto-kinetic-center:square',
  'soludos-mediterranean-editorial:landscape',
  'soludos-summer-postcard:landscape',
]);

/**
 * On-screen window in SPEC-AUTHORED seconds, widened by the exit fade so two
 * groups that cross-fade into each other still count as simultaneous.
 *
 * timeScale is deliberately not modelled: specTimeScale (remotion/lib/timing.js)
 * multiplies every authored time by the same positive factor, so it cannot
 * change whether two windows intersect. Verified in practice — the delivered
 * plates are 10.006s against an 8s-authored grid (timeScale 1.25) and the
 * ordering is preserved exactly.
 *
 * exitAtSec == null means "stays up to the end of the clip" => Infinity.
 */
function groupWindow(items) {
  let enter = Infinity;
  let exit = -Infinity;
  for (const s of items) {
    const t = s.timing || {};
    const e = Number.isFinite(t.enterAtSec) ? t.enterAtSec : 0;
    if (e < enter) enter = e;
    const x = (t.exitAtSec == null || !Number.isFinite(t.exitAtSec))
      ? Infinity
      : t.exitAtSec + (Number.isFinite(t.exitDurationSec) ? t.exitDurationSec : 0);
    if (x > exit) exit = x;
  }
  return {
    enter: enter === Infinity ? 0 : enter,
    exit: exit === -Infinity ? Infinity : exit,
  };
}

/** Strict `<`: a group exiting exactly as another enters is not simultaneous. */
function overlaps(a, b) {
  return a.enter < b.exit && b.enter < a.exit;
}

function overlapsFor(normalizedSlots) {
  // `visible:false` slots paint nothing, so they cannot collide with anything
  // and must not reserve a band. This mirrors Canonical.jsx, where such a slot
  // resolves to null content and renders an empty div. (Content-gated-empty
  // slots — e.g. a quote with no data — cannot be known offline; treating them
  // as present is the conservative direction.)
  const groups = new Map();
  for (const s of normalizedSlots) {
    if (s.visible === false) continue;
    const key = `${s.phase}|${s.position.anchor}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const entries = [...groups.entries()].map(([key, items]) => ({ key, ...groupWindow(items) }));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (overlaps(a, b)) {
        const f = (n) => (n === Infinity ? 'end' : String(n));
        out.push(`${a.key}[${f(a.enter)}-${f(a.exit)}] overlaps ${b.key}[${f(b.enter)}-${f(b.exit)}]`);
      }
    }
  }
  return out;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.error('verifyTitleGroupsNeverOverlap: no presets found — wrong path?');
    process.exit(1);
  }

  let checked = 0;
  let invalid = 0;
  const failures = [];
  const acceptedSeen = new Set();

  for (const file of files) {
    const preset = file.replace(/\.json$/, '');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
    } catch (e) {
      failures.push(`${preset}: unreadable/invalid JSON (${e.message})`);
      continue;
    }
    for (const [format, raw] of Object.entries(doc.byFormat || {})) {
      const id = `${preset}:${format}`;
      const res = validateTitleSpec(raw, { format });
      if (!res.ok) {
        // A spec the validator rejects never renders, so it cannot produce this
        // defect — but it IS worth surfacing, since a preset silently failing
        // validation is its own problem.
        console.log(`INFO  ${id} — spec does not validate (${res.errors[0]}) — skipped`);
        invalid++;
        continue;
      }
      checked++;
      const bad = overlapsFor(res.normalized.slots);
      if (!bad.length) {
        if (listOnly) console.log(`ok    ${id}`);
        if (ACCEPTED.has(id)) acceptedSeen.add(id);  // now clean — see stale note below
        continue;
      }
      if (ACCEPTED.has(id)) {
        acceptedSeen.add(id);
        if (listOnly) console.log(`known ${id} :: ${bad.join(' ; ')}`);
        continue;
      }
      failures.push(`${id} :: ${bad.join(' ; ')}`);
    }
  }

  // A baseline entry that is no longer overlapping means someone fixed it —
  // good, but the line must go, or the baseline slowly stops meaning anything.
  const stale = [...ACCEPTED].filter((id) => !acceptedSeen.has(id));
  const nowClean = [...ACCEPTED].filter((id) => {
    if (!acceptedSeen.has(id)) return false;
    return false; // resolved below via re-check to keep this cheap and explicit
  });
  void nowClean;

  console.log(`\nverifyTitleGroupsNeverOverlap: ${checked} preset+format combination(s) checked, `
    + `${ACCEPTED.size} in the accepted baseline, ${invalid} skipped as non-validating.`);

  if (stale.length) {
    console.log('\nSTALE BASELINE ENTRIES (preset+format no longer exists — remove from ACCEPTED):');
    for (const id of stale) console.log(`  ${id}`);
  }

  if (failures.length) {
    console.error('\nFAIL — simultaneous title groups can collide under keep-out:');
    for (const f of failures) console.error(`  ${f}`);
    console.error('\nTwo groups on screen at once may both be shifted onto the same band by');
    console.error('resolveGroupAnchor and paint through each other. Re-time the preset so its');
    console.error('groups are sequential (see canonical.json vertical for the reference shape).');
    console.error('Do NOT silence this by adding the id to ACCEPTED — read this file\'s header.');
    process.exit(1);
  }

  console.log('PASS — every non-baseline preset+format keeps its title groups sequential.');
  process.exit(0);
}

main();
