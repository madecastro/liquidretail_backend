// The spec interpreter: renders a normalized title style spec (validated
// server-side by services/titleSpecValidator.js) over the base plate.
// Canonical looks and brand looks are both just specs — this component is
// the only rendering path.
//
// Layout model: slots are grouped by (phase, anchor). Each group is a
// flex column pinned inside the format's safe zones; slots occupy their
// stack position for the whole clip and animate opacity/transform only,
// so staggered entrances never reflow neighbors (same behavior as the
// canvas canonicals). Slots sharing position.row within a group render
// side by side (space-between).

import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { BasePlate } from '../components/BasePlate.jsx';
import { useBrandFonts } from '../components/FontLoader.jsx';
import { SLOT_RENDERERS } from '../components/slotRenderers.jsx';
import { slotEnvelope, slotProgress, specTimeScale } from '../lib/timing.js';
import { stackContainerStyle, resolveSafeZone, resolveSafeZoneKey } from '../lib/safeZones.js';
import { contrastToken } from '../lib/tokens.js';
import { resolveSlotContent } from '../lib/slotContent.js';
import { decideInkOnLight, worstCaseInkForBand, usesWorstCaseInk } from '../lib/plateHints.js';
// Re-export pure resolver for offline harnesses (same decision as render).
export { resolveSlotContent, resolveSlotContentCore, truncateWordSafe } from '../lib/slotContent.js';
export { decideInkOnLight, worstCaseInkForBand, usesWorstCaseInk } from '../lib/plateHints.js';

const BAND_FOR_ANCHOR = { top: 'top', upperThird: 'top', center: 'middle', lowerThird: 'bottom', bottom: 'bottom' };

// Keep-out candidate order: prefer the authored band, then step toward the
// frame center / opposite third. First non-avoid wins; all-flagged → keep
// authored (never crash, never leave safe area — stackContainerStyle clamps).
const KEEP_OUT_CANDIDATES = {
  top: ['top', 'upperThird', 'center', 'lowerThird'],
  upperThird: ['upperThird', 'center', 'lowerThird'],
  center: ['center', 'upperThird', 'lowerThird'],
  lowerThird: ['lowerThird', 'center', 'upperThird'],
  bottom: ['bottom', 'lowerThird', 'center', 'upperThird'],
};

// Look up the plate-intelligence band under a slot group at the time its
// content is on screen: bright band → dark type; avoid band → shift group
// to a clear band (see resolveGroupAnchor).
function bandStateFor(plateHints, anchor, atSec) {
  if (!plateHints?.samples?.length) return { isLight: false, avoid: false, busy: 0, lum: null };
  let best = plateHints.samples[0];
  for (const s of plateHints.samples) {
    if (Math.abs(s.atSec - atSec) < Math.abs(best.atSec - atSec)) best = s;
  }
  const bandKey = BAND_FOR_ANCHOR[anchor] || 'middle';
  const band = best.bands?.[bandKey];
  if (!band) return { isLight: false, avoid: false, busy: 0, lum: null };

  // ACROSS TIME, not at one instant — for `avoid` and `busy`.
  //
  // Face flags are time-localised: applyFaceKeepOut assigns each detected face
  // box to the NEAREST plate sample, and there are typically 3 face samples
  // against 5 plate samples, so some samples carry no face flag at all. The group
  // anchor is ONE decision for the WHOLE clip, but it read a single sample — so
  // whether it saw the face was luck. Measured on two delivered ads with
  // identical geometry: Pelagic 9:16 read a flagged sample and correctly moved
  // off the face, while Vuori 1:1 read an unflagged one and walked onto it. The
  // probe confirms the flags themselves are right (top=true for both).
  //
  // A face that occupies a band at ANY point in the clip disqualifies that band
  // for text that is on screen across that clip, and the worst-case texture is
  // what legibility depends on — so take the union of avoid and the max of busy.
  let avoidAny = !!band.avoid;
  let busyMax = Number.isFinite(band.busy) ? band.busy : 0;
  for (const s of plateHints.samples) {
    const b = s.bands?.[bandKey];
    if (!b) continue;
    if (b.avoid) avoidAny = true;
    if (Number.isFinite(b.busy) && b.busy > busyMax) busyMax = b.busy;
  }
  // `busy` (local luma variance, plateIntelService) was computed for every band
  // from the first version of the plate scan and never read by ANY consumer.
  // It is the signal that tells detail-heavy footage from flat footage, which is
  // exactly what decides whether type survives on top of it.
  return {
    // isLight stays NEAREST-sample: ink is decided by a separate weighted vote
    // across all groups and samples (plateIsLightGlobal), and widening it here
    // would double-count.
    isLight: band.lum > 0.62,
    avoid: avoidAny,
    busy: busyMax,
    // The raw band luminance, so ink can be chosen for the band the type
    // ACTUALLY lands on rather than from a whole-clip vote. See inkForBand.
    lum: Number.isFinite(band.lum) ? band.lum : null,
  };
}

// ── PER-BAND INK, because a global vote loses on mid-tone footage ───────
//
// THE DEFECT THIS FIXES, seen on a delivered AllBirds 4:5: the plate is mostly
// light (cream shoe, pale ground) so the global vote flipped ink DARK, but the
// band the type landed on was a mid-grey wool insole at ~0.45 luminance. Near
// black on mid grey is barely readable, and since the owner ruled out scrims and
// the shadow was deliberately tightened after "the halo is way too much", nothing
// rescued it. The plate average was never the surface the words sat on.
//
// Chooses by CONTRAST RATIO rather than a threshold — the same lesson the pill
// ink already learned: a single luminance cut-off picks the wrong ink on mid-tones
// (a 0.55 threshold puts white on #5B8C5A at 1.93:1 when dark gives 9.3:1).
// `marginal` means even the better choice is under WCAG AA, which is the real
// signal that placement alone will not carry it and the shadow must do more.
const INK_DARK_LUM = 0.0091;   // #16181D, sRGB-linearised
const INK_LIGHT_LUM = 1.0;     // #FFFFFF
function inkForBand(lum) {
  if (!Number.isFinite(lum)) return null;
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const bg = lin(lum);
  const onDarkInk = ratio(INK_DARK_LUM, bg);
  const onLightInk = ratio(INK_LIGHT_LUM, bg);
  return {
    onLight: onDarkInk > onLightInk,           // true → dark ink, i.e. on-light tokens
    marginal: Math.max(onDarkInk, onLightInk) < 4.5,
    best: Math.round(Math.max(onDarkInk, onLightInk) * 100) / 100,
  };
}

/**
 * How much better a rival band must measure before the group leaves the band the
 * template authored. Without hysteresis the stack would hop between bands on
 * noise, and the authored anchor carries real design intent.
 */
const BAND_SWITCH_MARGIN = 0.03;

/**
 * A face is DISQUALIFYING, not expensive.
 *
 * This started as a numeric penalty of 1 and adversarial review broke it with
 * arithmetic: `busy` is capped at 1.0, so a smooth face on the authored band
 * scored 1 + 0.0 - 0.03 = 0.97 while a clear-but-detailed band scored 0.99 — the
 * face won. That is not a corner case, it is precisely the footage this change
 * exists to fix (a smooth face with the product filling the busy region: the
 * Pelagic 9:16 ads). Any penalty value is a guess about the busy distribution,
 * so faces are hard-excluded instead: texture only ever breaks ties BETWEEN
 * clear bands.
 */
const FACE_DISQUALIFIES = true;

// Stable per-group keep-out decision: one anchor for the whole group for the
// whole clip (no per-slot divergence, no mid-phase jumping). Evaluated at the
// group's first slot enter time (+0.5s into the visible window).
// logShift: only the once-per-render groupAnchors path should log (ink vote reuses).
// SCORED, not first-acceptable. The previous version returned the first candidate
// whose band was not face-flagged, which had two failure modes seen in delivered
// ads:
//   - It never looked at TEXTURE. On a Gymshark 4:5 the authored lower third was
//     un-flagged, so the stack stayed there — directly on top of a giant GYMSHARK
//     wordmark printed across the garment. Measured: bottom busy 0.199, top 0.144.
//   - Because it accepted the authored band whenever that band merely lacked a
//     face, it could not move at all for busy-but-faceless footage, and on 9:16
//     the reverse case (authored upper third sitting ON the face while the bottom
//     was the clean band) only resolved if the face flag happened to be set.
// Scoring every candidate on face + texture handles both directions with one rule.
function resolveGroupAnchor(plateHints, authoredAnchor, atSec, { logShift = false } = {}) {
  const candidates = KEEP_OUT_CANDIDATES[authoredAnchor] || [authoredAnchor];
  const scored = candidates.map((cand) => ({ cand, ...bandStateFor(plateHints, cand, atSec) }));

  // Faces are excluded outright while ANY face-free band is available, so no
  // amount of texture can ever buy a face.
  const clear = scored.filter((s) => !s.avoid);

  // EVERY band is a face (extreme close-up — the crop is all head). There is no
  // safe placement, texture is not a meaningful tiebreak between two faces, and
  // the template's composition is the best remaining signal. Keep the authored
  // band, which is also exactly what the previous implementation did, so this
  // degenerate case gains no new behaviour. An earlier draft ranked the faces by
  // busy here while the comment claimed otherwise — caught by replaying the case.
  if (FACE_DISQUALIFIES && !clear.length) return authoredAnchor;

  let best = null;
  for (const s of clear) {
    // Lower is better. The authored band gets the margin as a head start so a
    // negligible texture win never overrides the template's composition.
    const score = s.busy - (s.cand === authoredAnchor ? BAND_SWITCH_MARGIN : 0);
    if (!best || score < best.score) best = { ...s, score };
  }
  if (!best) return authoredAnchor;

  if (logShift && best.cand !== authoredAnchor) {
    // Reason must reflect why we LEFT the authored band, not the state of the
    // band we landed on — an earlier version read `best.avoid` and so reported
    // "busier band" on every face escape.
    const authored = scored.find((s) => s.cand === authoredAnchor);
    const why = authored?.avoid ? 'face band' : 'busier band';
    // Render console — sweeps grep `keepOut:`.
    // eslint-disable-next-line no-console
    console.log(
      `keepOut: ${authoredAnchor}->${best.cand} (${why}; ` +
      `authored busy ${(authored?.busy ?? 0).toFixed(3)} -> ${best.busy.toFixed(3)})`
    );
  }
  return best.cand;
}

// ONE contrast decision per render, not per band: copy must never mix ink
// colors within a video (dark headline on a light band + light CTA on a
// dark band reads as a bug, not adaptivity). Weigh each group's band
// verdict by how many slots actually render copy there — the scheme
// follows the bulk of the visible copy, and the layered shadows carry
// the minority band. Votes the EFFECTIVE (post keep-out) anchor so ink
// matches the pixels actually under the shifted stack.
//
// Tie-break (only on light==dark): median luma across ALL sampled text-band
// readings vs 0.55 — near-white studio walls that split 3/3 no longer fall
// through to brand-default white type. See remotion/lib/plateHints.js.
function plateIsLightGlobal(plateHints, groups, timeScale, meta, groupAnchors, allSlots) {
  // Render console — sweeps grep `inkVote:`. Always emit so every render
  // is auditable even when plate scan is off / empty.
  const logVote = (lightWeight, darkWeight, decision) => {
    // eslint-disable-next-line no-console
    if (decision.tied && decision.globalLum != null) {
      console.log(
        `inkVote: light=${lightWeight} dark=${darkWeight} tie -> globalLum ${decision.globalLum.toFixed(2)} -> ${decision.onLight ? 'on-light' : 'brand-default'}`
      );
    } else {
      console.log(
        `inkVote: light=${lightWeight} dark=${darkWeight} -> ${decision.onLight ? 'on-light' : 'brand-default'} tokens`
      );
    }
  };
  if (!plateHints?.samples?.length) {
    const d = decideInkOnLight(0, 0, null);
    logVote(0, 0, d);
    return d.onLight;
  }
  let lightWeight = 0;
  let darkWeight = 0;
  for (const group of groups) {
    const first = group.items[0];
    const rendered = group.items.filter((s) => resolveSlotContent(s, meta, allSlots) != null).length;
    if (!rendered) continue;
    const atSec = first.timing.enterAtSec * timeScale + 0.5;
    const key = `${group.phase}|${group.anchor}`;
    const effectiveAnchor = (groupAnchors && groupAnchors.get(key)) || group.anchor;
    const { isLight } = bandStateFor(plateHints, effectiveAnchor, atSec);
    if (isLight) lightWeight += rendered;
    else darkWeight += rendered;
  }
  const decision = decideInkOnLight(lightWeight, darkWeight, plateHints);
  logVote(lightWeight, darkWeight, decision);
  return decision.onLight;
}

function groupSlots(slots) {
  const groups = new Map();
  for (const slot of slots) {
    const key = `${slot.phase}|${slot.position.anchor}`;
    if (!groups.has(key)) groups.set(key, { anchor: slot.position.anchor, phase: slot.phase, items: [] });
    groups.get(key).items.push(slot);
  }
  return [...groups.values()];
}

// Within a group, fold consecutive slots that share position.row into one
// side-by-side row.
function foldRows(items) {
  const out = [];
  for (const slot of items) {
    const prev = out[out.length - 1];
    if (slot.position.row && prev && prev.row === slot.position.row) {
      prev.slots.push(slot);
    } else {
      out.push({ row: slot.position.row, slots: [slot] });
    }
  }
  return out;
}

const ALIGN_TO_FLEX = { left: 'flex-start', center: 'center', right: 'flex-end' };

export const Canonical = ({ format = 'feed', safeZoneKey = null, platformFormat = null, plate, meta = {}, tokens = {}, spec, plateHints = null, debugLayout = false }) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  useBrandFonts(tokens?.fonts);
  // Canvas format stays the composition id; YT zones only via safeZoneKey /
  // platformFormat (PMax video). Resolved once so every group + overlay agree.
  const zoneKey = safeZoneKey || resolveSafeZoneKey({ format, platformFormat });
  // Worst-case ink applies to the Google video surfaces only. Meta keeps the
  // single-instant reading, so its rendered output is unchanged.
  const isPmaxSurface = usesWorstCaseInk(platformFormat);

  // Spec color overrides win over resolved brand tokens (font overrides are
  // resolved server-side because they may need new font files).
  const mergedTokens = useMemo(() => {
    const colors = { ...(tokens?.colors || {}), ...(spec?.tokenOverrides?.colors || {}) };
    return { ...tokens, colors };
  }, [tokens, spec]);

  const dims = { width, height };
  const groups = useMemo(() => (spec?.slots ? groupSlots(spec.slots) : []), [spec]);
  // Compress spec-authored times onto shorter real plates (see timing.js).
  const timeScale = useMemo(() => specTimeScale(spec, durationInFrames, fps), [spec, durationInFrames, fps]);
  // Keep-out anchors resolved once per group (stable for the whole clip).
  const groupAnchors = useMemo(() => {
    const map = new Map();
    for (const group of groups) {
      const first = group.items[0];
      const atSec = first.timing.enterAtSec * timeScale + 0.5;
      map.set(
        `${group.phase}|${group.anchor}`,
        resolveGroupAnchor(plateHints, group.anchor, atSec, { logShift: true })
      );
    }
    return map;
  }, [plateHints, groups, timeScale]);
  // Full slot list for visibleWhenEmpty sibling lookups (same array the
  // group map was built from — includes every phase/anchor).
  const allSlots = spec?.slots || [];

  // The whole-clip vote is now only the FALLBACK: it still decides when a group's
  // own band luminance is unavailable (plate scan off or empty), so behaviour is
  // unchanged in that case.
  const inkOnLightGlobal = useMemo(
    () => plateIsLightGlobal(plateHints, groups, timeScale, meta, groupAnchors, allSlots),
    [plateHints, groups, timeScale, meta, groupAnchors, allSlots]
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <BasePlate plate={plate} />
      {groups.map((group) => {
        const rows = foldRows(group.items);
        const first = group.items[0];
        // Keep-out: whole group shifts to the first clear band (deterministic,
        // stable for the clip). stackContainerStyle still clamps to safe zones.
        const effectiveAnchor = groupAnchors.get(`${group.phase}|${group.anchor}`) || group.anchor;
        // Ink for THIS group, from the band it actually occupies after keep-out.
        const groupAtSec = first.timing.enterAtSec * timeScale + 0.5;
        const bandLum = bandStateFor(plateHints, effectiveAnchor, groupAtSec).lum;
        // PMax: score the ink against every sample of this band, not just the
        // one nearest the group's enter time. A 10s clip whose shot changes
        // under a title otherwise picks ink for the instant the text arrives
        // and keeps it while the plate turns dark — measured as dark-on-black
        // on a delivered ad that had logged 9.77:1. Meta keeps the instant
        // reading, so its output is byte-identical.
        const bandInk =
          (isPmaxSurface
            ? worstCaseInkForBand(plateHints, BAND_FOR_ANCHOR[effectiveAnchor] || 'middle', INK_DARK_LUM, INK_LIGHT_LUM)
            : null) || inkForBand(bandLum);
        const inkOnLight = bandInk ? bandInk.onLight : inkOnLightGlobal;
        // Even the better ink is below AA on this band: placement cannot carry it,
        // so the strongest authored shadow does. 'layered' is an existing validated
        // treatment value, not a new one.
        const reinforceShadow = !!bandInk?.marginal;
        // eslint-disable-next-line no-console
        console.log(
          `inkBand: ${group.phase}|${effectiveAnchor} lum=${bandLum == null ? '?' : bandLum.toFixed(2)} ` +
          `-> ${inkOnLight ? 'dark ink (on-light tokens)' : 'light ink'}` +
          `${bandInk ? ` best=${bandInk.best}:1` : ' (no band data -> global vote)'}` +
          `${reinforceShadow ? ' MARGINAL -> layered shadow' : ''}`
        );
        const container = stackContainerStyle({
          format,
          safeZoneKey: zoneKey,
          anchor: effectiveAnchor,
          offsetX: first.position.offsetX,
          offsetY: first.position.offsetY,
          width,
          height,
        });
        return (
          <div key={`${group.phase}|${group.anchor}`} style={{ ...container, gap: Math.round((spec.stack?.rowGapPct ?? 0.018) * height) }}>
            {rows.map((row, ri) => {
              const rendered = row.slots.map((rawSlot, si) => {
                // Same-anchor same-phase slots stack as a flex column (container
                // gap). Empty siblings drop out — e.g. proof falls back to
                // claim+rating when quote is gated empty (visibleWhenEmpty).
                const content = resolveSlotContent(rawSlot, meta, allSlots);
                if (content == null) return null;
                const Renderer = SLOT_RENDERERS[rawSlot.key];
                if (!Renderer) return null;
                // Bright plate (globally decided) → flip text tokens to
                // their on-light variants (brand pills/CTA keep brand color).
                const slot = (inkOnLight || reinforceShadow)
                  ? {
                      ...rawSlot,
                      treatment: {
                        ...rawSlot.treatment,
                        colorToken: inkOnLight
                          ? contrastToken(mergedTokens, rawSlot.treatment.colorToken, true)
                          : rawSlot.treatment.colorToken,
                        shadow: reinforceShadow ? 'layered' : rawSlot.treatment.shadow,
                      },
                    }
                  : rawSlot;
                const env = slotEnvelope({ frame, fps, timing: slot.timing, transition: slot.transition, durationInFrames, timeScale });
                const progress = slotProgress({ frame, fps, timing: slot.timing, durationInFrames, timeScale });
                return (
                  <div
                    key={`${group.phase}|${slot.key}|${ri}-${si}`}
                    style={{
                      opacity: env.opacity,
                      transform: env.transform,
                      clipPath: env.clipPath === 'none' ? undefined : env.clipPath,
                      alignSelf: ALIGN_TO_FLEX[slot.position.align] || 'flex-start',
                      maxWidth: `${slot.position.maxWidthPct * 100}%`,
                    }}
                  >
                    <Renderer
                      slot={slot}
                      content={content}
                      tokens={mergedTokens}
                      dims={dims}
                      format={format}
                      meta={meta}
                      frame={frame}
                      fps={fps}
                      progress={progress}
                      timeScale={timeScale}
                    />
                  </div>
                );
              }).filter(Boolean);
              if (!rendered.length) return null;
              // Row wrapper only when 2+ slots actually rendered — a lone
              // survivor (e.g. deliveryLine empty, CTA present) falls back
              // to the column path so its own align still applies.
              if (rendered.length > 1) {
                return (
                  <div key={`row-${ri}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Math.round(width * 0.02) }}>
                    {rendered}
                  </div>
                );
              }
              return <React.Fragment key={`row-${ri}`}>{rendered}</React.Fragment>;
            })}
          </div>
        );
      })}
      {debugLayout ? <SafeZoneOverlay safeZoneKey={zoneKey} width={width} height={height} /> : null}
    </AbsoluteFill>
  );
};

const SafeZoneOverlay = ({ safeZoneKey, width, height }) => {
  const safe = resolveSafeZone({ safeZoneKey });
  return (
    <div
      style={{
        position: 'absolute',
        left: safe.left * width,
        right: safe.right * width,
        top: safe.top * height,
        bottom: safe.bottom * height,
        border: '2px dashed rgba(255,0,0,0.7)',
        pointerEvents: 'none',
      }}
    />
  );
};
