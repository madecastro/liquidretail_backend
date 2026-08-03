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

const BAND_FOR_ANCHOR = { top: 'top', upperThird: 'top', center: 'middle', lowerThird: 'bottom', bottom: 'bottom' };

// Look up the plate-intelligence band under a slot group at the time its
// content is on screen: bright band → dark type; avoid band → gentle nudge
// toward the frame edge (clamped by the safe zones like any offset).
function bandStateFor(plateHints, anchor, atSec) {
  if (!plateHints?.samples?.length) return { isLight: false, avoid: false };
  let best = plateHints.samples[0];
  for (const s of plateHints.samples) {
    if (Math.abs(s.atSec - atSec) < Math.abs(best.atSec - atSec)) best = s;
  }
  const band = best.bands?.[BAND_FOR_ANCHOR[anchor] || 'middle'];
  if (!band) return { isLight: false, avoid: false };
  return { isLight: band.lum > 0.62, avoid: !!band.avoid };
}

// ONE contrast decision per render, not per band: copy must never mix ink
// colors within a video (dark headline on a light band + light CTA on a
// dark band reads as a bug, not adaptivity). Weigh each group's band
// verdict by how many slots actually render copy there — the scheme
// follows the bulk of the visible copy, and the layered shadows carry
// the minority band.
function plateIsLightGlobal(plateHints, groups, timeScale, meta) {
  if (!plateHints?.samples?.length) return false;
  let lightWeight = 0;
  let darkWeight = 0;
  for (const group of groups) {
    const first = group.items[0];
    const rendered = group.items.filter((s) => resolveSlotContent(s, meta) != null).length;
    if (!rendered) continue;
    const { isLight } = bandStateFor(plateHints, group.anchor, first.timing.enterAtSec * timeScale + 0.5);
    if (isLight) lightWeight += rendered;
    else darkWeight += rendered;
  }
  // Tie or no copy → keep the brand's default (light-type) tokens.
  return lightWeight > darkWeight;
}

// Extract the value a bind-chain entry contributes at this render.
// Entries are either meta field names (strings) OR literal fallback
// objects ({ literal: <value> }). Literals always "win" if reached —
// they're the operator's "if nothing else, show this" floor.
function extractBindEntry(entry, meta) {
  if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'literal')) {
    return entry.literal;
  }
  return meta?.[entry];
}

// Word-safe display cap: never cut mid-word; ellipsis only BETWEEN words.
// Used for productName (close-phase / endcard lead) and multi-item strings
// that previously hard-sliced. If no space exists in the first half of the
// window, fall back to a hard cut so pathological one-word titles still fit.
export function truncateWordSafe(str, maxLen) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  if (!maxLen || maxLen < 1 || s.length <= maxLen) return s;
  const window = s.slice(0, maxLen);
  let cut = window.lastIndexOf(' ');
  if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
  const out = s.slice(0, cut).trimEnd();
  return out.length < s.length ? `${out}…` : out;
}

// Per-slot character caps for on-screen text. productName is the one that
// previously printed mid-word SKU titles on the close phase ("…(Dark…").
const TEXT_CHAR_CAP = {
  productName: 48,
  headline: 72,
  quote: 120,
  deliveryLine: 40,
  badge: 28,
  promo: 28,
  productDescription: 80,
  tagline: 56,
};

function resolveSlotContent(slot, meta) {
  const brandMode = meta?.endcardMode === 'brand';
  if (!slot.visible) return null;
  if (brandMode && slot.brandMode === 'hide') return null;

  if (slot.key === 'rating') {
    const rating = Number(meta?.rating);
    if (!Number.isFinite(rating) || rating <= 0) return null;
    return {
      rating: Math.min(5, Math.max(0, rating)),
      reviewsText: meta?.reviewsText || (meta?.reviewCount ? `${meta.reviewCount} reviews` : ''),
    };
  }

  const chain = brandMode && slot.brandModeBind ? slot.brandModeBind : slot.bind;

  // Multi-value slots return the source array (capped at maxItems, empty
  // slots skipped). Bind chain picks the first non-empty array; a
  // literal entry always short-circuits with its embedded array.
  // Item COUNT is still sliced at maxItems; each item string is
  // word-safe-truncated so CSS line-clamp is not the only mid-word risk.
  if (slot.slotType === 'multi') {
    for (const entry of chain) {
      const arr = extractBindEntry(entry, meta);
      if (Array.isArray(arr) && arr.length > 0) {
        const cap = slot.treatment?.maxItems ?? 4;
        const itemCharCap = 40;
        const items = arr
          .filter((v) => v != null && String(v).trim() !== '')
          .map((v) => truncateWordSafe(String(v).trim(), itemCharCap))
          .slice(0, cap);
        if (items.length > 0) return items;
      }
    }
    return null;
  }

  // Image slots return the URL string. Same first-non-empty semantics as
  // text, but the value stays as-is (no .trim() on URLs beyond whitespace).
  if (slot.slotType === 'image') {
    for (const entry of chain) {
      const v = extractBindEntry(entry, meta);
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return null;
  }

  // Text: first non-empty stringified value in the bind chain. Literal
  // entries always contribute (they can't be "empty" by construction —
  // the validator rejects null literals). productName (and a few other
  // long-copy slots) get word-safe char caps so the close phase never
  // prints a mid-word SKU clip.
  for (const entry of chain) {
    const v = extractBindEntry(entry, meta);
    if (v != null && String(v).trim() !== '') {
      const raw = String(v).trim();
      const charCap = TEXT_CHAR_CAP[slot.key];
      return charCap ? truncateWordSafe(raw, charCap) : raw;
    }
  }
  return null;
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
  // Global ink color — every group flips together or not at all.
  const inkOnLight = useMemo(() => plateIsLightGlobal(plateHints, groups, timeScale, meta), [plateHints, groups, timeScale, meta]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <BasePlate plate={plate} />
      {groups.map((group) => {
        const rows = foldRows(group.items);
        const first = group.items[0];
        const band = bandStateFor(plateHints, group.anchor, first.timing.enterAtSec * timeScale + 0.5);
        // Keep-out nudge: slide the group away from the flagged band —
        // downward for top-anchored groups, upward for bottom-anchored.
        const nudge = band.avoid ? (group.anchor === 'bottom' || group.anchor === 'lowerThird' ? -0.05 : 0.05) : 0;
        const container = stackContainerStyle({
          format,
          anchor: group.anchor,
          offsetX: first.position.offsetX,
          offsetY: first.position.offsetY + nudge,
          width,
          height,
        });
        return (
          <div key={`${group.phase}|${group.anchor}`} style={{ ...container, gap: Math.round((spec.stack?.rowGapPct ?? 0.018) * height) }}>
            {rows.map((row, ri) => {
              const rendered = row.slots.map((rawSlot) => {
                const content = resolveSlotContent(rawSlot, meta);
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
                    key={slot.key}
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
