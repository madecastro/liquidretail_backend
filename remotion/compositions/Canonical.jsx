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
import { stackContainerStyle, SAFE_ZONES } from '../lib/safeZones.js';
import { contrastToken } from '../lib/tokens.js';
import { resolveSlotContent } from '../lib/slotContent.js';
import { decideInkOnLight } from '../lib/plateHints.js';
// Re-export pure resolver for offline harnesses (same decision as render).
export { resolveSlotContent, resolveSlotContentCore, truncateWordSafe } from '../lib/slotContent.js';
export { decideInkOnLight } from '../lib/plateHints.js';

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
  if (!plateHints?.samples?.length) return { isLight: false, avoid: false, busy: 0 };
  let best = plateHints.samples[0];
  for (const s of plateHints.samples) {
    if (Math.abs(s.atSec - atSec) < Math.abs(best.atSec - atSec)) best = s;
  }
  const band = best.bands?.[BAND_FOR_ANCHOR[anchor] || 'middle'];
  if (!band) return { isLight: false, avoid: false, busy: 0 };
  // `busy` (local luma variance, plateIntelService) was computed for every band
  // from the first version of the plate scan and never read by ANY consumer.
  // It is the signal that tells detail-heavy footage from flat footage, which is
  // exactly what decides whether type survives on top of it.
  return {
    isLight: band.lum > 0.62,
    avoid: !!band.avoid,
    busy: Number.isFinite(band.busy) ? band.busy : 0,
  };
}

/**
 * How much better a rival band must measure before the group leaves the band the
 * template authored. Without hysteresis the stack would hop between bands on
 * noise, and the authored anchor carries real design intent.
 */
const BAND_SWITCH_MARGIN = 0.03;

/** A face costs more than any amount of texture — never trade a clear band for a face. */
const FACE_PENALTY = 1;

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
  let best = null;
  for (const cand of candidates) {
    const { avoid, busy } = bandStateFor(plateHints, cand, atSec);
    // Lower is better. The authored band gets the margin as a head start so a
    // negligible texture win never overrides the template's composition.
    const score = (avoid ? FACE_PENALTY : 0) + busy - (cand === authoredAnchor ? BAND_SWITCH_MARGIN : 0);
    if (!best || score < best.score) best = { cand, score, avoid, busy };
  }
  if (!best) return authoredAnchor;
  if (logShift && best.cand !== authoredAnchor) {
    const why = best.avoid === false && (KEEP_OUT_CANDIDATES[authoredAnchor] || [])[0] === authoredAnchor
      ? 'busier band' : 'face band';
    // Render console — sweeps grep `keepOut:`.
    // eslint-disable-next-line no-console
    console.log(
      `keepOut: ${authoredAnchor}->${best.cand} (${why}; busy ${best.busy.toFixed(3)})`
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

export const Canonical = ({ format = 'feed', plate, meta = {}, tokens = {}, spec, plateHints = null, debugLayout = false }) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  useBrandFonts(tokens?.fonts);

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

  // Global ink color — every group flips together or not at all. Votes the
  // post keep-out band so ink matches pixels under the shifted stack.
  const inkOnLight = useMemo(
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
        const container = stackContainerStyle({
          format,
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
                const slot = inkOnLight
                  ? {
                      ...rawSlot,
                      treatment: {
                        ...rawSlot.treatment,
                        colorToken: contrastToken(mergedTokens, rawSlot.treatment.colorToken, true),
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
      {debugLayout ? <SafeZoneOverlay format={format} width={width} height={height} /> : null}
    </AbsoluteFill>
  );
};

const SafeZoneOverlay = ({ format, width, height }) => {
  const safe = SAFE_ZONES[format] || SAFE_ZONES.feed;
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
