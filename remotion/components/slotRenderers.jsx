// Visual renderers for every spec slot. Each receives the normalized slot,
// its resolved content, the merged brand tokens, format + canvas dims, the
// current frame/fps (for micro-animations like the CTA pulse), and the
// slot's visible-window progress (drives accent reveals).

import React from 'react';
import { Img, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  tokenColor,
  tokenFont,
  fontFamilyCss,
  hexToRgba,
  applyCasing,
  clampPx,
  TEXT_SHADOWS,
  TEXT_SHADOWS_ON_LIGHT,
  BOX_SHADOWS,
  textShadowFor,
} from '../lib/tokens.js';
import {
  STAR_COUNT,
  STAR_POP_SEC,
  COUNT_DUR_SEC,
  SUFFIX_FADE_SEC,
  ratingLocalFrame,
  starStartSec,
  starFillAt,
  lastStarLandSec,
  parseReviewsLeadingNumber,
  countUpValue,
  formatReviewsCount,
  suffixOpacityAt,
  lineFadeOpacityAt,
} from '../lib/ratingMotion.js';

// Base text size (px at native canvas) per slot per format — derived from
// the canvas canonicals' clamp() outputs at 1080×1920 / 1080×1350 / 1920×1080.
const BASE_SIZE = {
  headline: { vertical: 68, feed: 44, landscape: 60 },
  quote: { vertical: 56, feed: 30, landscape: 36 },
  reviewer: { vertical: 22, feed: 18, landscape: 22 },
  rating: { vertical: 28, feed: 22, landscape: 30 },
  badge: { vertical: 24, feed: 18, landscape: 22 },
  brandPill: { vertical: 26, feed: 22, landscape: 24 },
  productName: { vertical: 56, feed: 36, landscape: 54 },
  price: { vertical: 36, feed: 28, landscape: 36 },
  deliveryLine: { vertical: 22, feed: 16, landscape: 22 },
  cta: { vertical: 26, feed: 20, landscape: 24 },
  promo: { vertical: 26, feed: 20, landscape: 24 },
  // Added text slots
  productDescription: { vertical: 30, feed: 22, landscape: 26 },
  tagline: { vertical: 40, feed: 28, landscape: 34 },
  website: { vertical: 22, feed: 16, landscape: 22 },
  likes: { vertical: 24, feed: 18, landscape: 22 },
  reviewCount: { vertical: 24, feed: 18, landscape: 22 },
  // Multi-value slots — per-item text size
  badges: { vertical: 22, feed: 16, landscape: 20 },
  benefits: { vertical: 24, feed: 18, landscape: 22 },
  // Image slots — sizePct drives the actual pixel size; BASE_SIZE unused
  productImage: { vertical: 0, feed: 0, landscape: 0 },
  brandLogo:    { vertical: 0, feed: 0, landscape: 0 },
};

// 'square' (1080x1080) reuses feed's sizes: identical 1080 width means an identical
// horizontal text budget, and these are text SIZES, not vertical positions. Aliasing
// here rather than adding a 20th `square:` key to every row above keeps the two from
// drifting apart.
//
// The alias is load-bearing, not tidiness: the `?? 24` fallback below does not throw
// on an unknown format, it silently renders EVERY slot at 24px. A 1:1 ad would have
// looked subtly broken rather than failed loudly.
const SIZE_FORMAT_ALIAS = { square: 'feed' };

export function baseSize(slotKey, format, sizeScale) {
  const f = SIZE_FORMAT_ALIAS[format] || format;
  const base = BASE_SIZE[slotKey]?.[f] ?? 24;
  return clampPx(base * (sizeScale || 1), 10, 200);
}

function scrimStyle(treatment, tokens, dims) {
  const { scrim, scrimOpacity, scrimColorToken, shadow } = treatment;
  const color = tokenColor(tokens, scrimColorToken);
  const padY = Math.round(dims.height * 0.011);
  const padX = Math.round(dims.width * 0.02);
  const radius = Math.round(dims.height * 0.014);
  const common = {
    padding: `${padY}px ${padX}px`,
    borderRadius: radius,
    boxShadow: BOX_SHADOWS[shadow === 'none' ? 'none' : 'soft'],
  };
  switch (scrim) {
    case 'frosted':
      return {
        ...common,
        backgroundColor: hexToRgba(color, Math.min(1, scrimOpacity * 0.62)),
        backdropFilter: 'blur(18px) saturate(1.25)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.25)',
        border: '1px solid rgba(255,255,255,0.14)',
      };
    case 'solid':
      return { ...common, backgroundColor: hexToRgba(color, scrimOpacity) };
    case 'card':
      return {
        ...common,
        backgroundColor: color,
        borderRadius: Math.round(radius * 1.4),
        boxShadow: BOX_SHADOWS.layered,
        padding: `${Math.round(padY * 1.5)}px ${Math.round(padX * 1.3)}px`,
      };
    case 'none':
    default:
      return { padding: 0 };
  }
}

function textCoreStyle(slot, tokens, dims, format) {
  const t = slot.treatment;
  const font = tokenFont(tokens, t.fontRole);
  const ink = tokenColor(tokens, t.colorToken);
  return {
    fontFamily: fontFamilyCss(font),
    fontWeight: t.weight,
    fontSize: baseSize(slot.key, format, t.sizeScale),
    letterSpacing: t.trackingPx ? `${t.trackingPx}px` : 'normal',
    color: ink,
    // Shadow polarity follows the INK, not the token table — see textShadowFor.
    // A black shadow behind dark type (the on-light contrast flip) separated
    // nothing, which is how titles became unreadable over skin.
    textShadow: textShadowFor(t.scrim === 'none' ? t.shadow : (t.shadow === 'layered' ? 'soft' : t.shadow), ink),
    lineHeight: 1.16,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: t.maxLines,
    overflow: 'hidden',
  };
}

const Accent = ({ accent, tokens, progress, dims }) => {
  if (!accent || accent.type === 'none') return null;
  const color = tokenColor(tokens, accent.colorToken);
  const reveal = accent.animate ? Math.min(1, progress * 2.5) : 1;
  if (accent.type === 'underline') {
    return (
      <div
        style={{
          height: Math.max(3, Math.round(dims.height * 0.004)),
          width: `${reveal * 38}%`,
          backgroundColor: color,
          borderRadius: 999,
          marginTop: Math.round(dims.height * 0.008),
        }}
      />
    );
  }
  // bar — vertical accent on the leading edge
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: '12%',
        bottom: '12%',
        width: Math.max(4, Math.round(dims.width * 0.005)),
        transform: `scaleY(${reveal})`,
        transformOrigin: 'top',
        backgroundColor: color,
        borderRadius: 999,
      }}
    />
  );
};

// StarRow — inline SVG so the star row never depends on the caller's
// font having U+2605. Brand fonts (Bebas Neue, Antonio, Great Vibes,
// etc.) frequently lack the glyph and the previous text-based rendering
// showed tofu boxes on shipped ads. `size` is the outer diameter of
// each star (matches the previous font-px value); `gap` is horizontal
// spacing between stars.
//
// Partial fill (e.g. 4.6 → 5th star 60%): a dim full-star polygon under a
// solid polygon clipped by a left-anchored rect whose width = size * fill.
// (Same clip approach the canvas scripts use for half-stars — no font glyph,
// no mask image.) When `localFrame`/`fps` are provided, each star spring-pops
// L→R and its fill fraction ramps 0→target during its own pop window.
function StarRow({
  color,
  size,
  gap,
  rating = STAR_COUNT,
  count = STAR_COUNT,
  localFrame = null,
  fps = 30,
}) {
  const points = starPoints(size / 2, (size / 2) * 0.4);
  const animate = localFrame != null && Number.isFinite(localFrame) && fps > 0;
  const labelFill = Math.min(count, Math.max(0, Number(rating) || 0));
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap,
        lineHeight: 1,
        // Non-breaking so a 5-star row never wraps mid-row on tight rating scrims.
        whiteSpace: 'nowrap',
      }}
      aria-label={`${labelFill} out of ${count} stars`}
    >
      {Array.from({ length: count }, (_, i) => {
        let scale = 1;
        let fill;
        if (animate) {
          const startF = Math.round(starStartSec(i) * fps);
          const rel = localFrame - startF;
          scale = rel < 0
            ? 0
            : spring({
                frame: rel,
                fps,
                config: { damping: 12, stiffness: 200, mass: 0.65 },
                // Cap the impulse so low-fps clips still settle inside STAR_POP_SEC.
                durationInFrames: Math.max(4, Math.round(STAR_POP_SEC * fps * 1.35)),
              });
          fill = starFillAt(localFrame, fps, rating, i);
        } else {
          // Static path (no frame): show the settled fill immediately.
          fill = starFillAt(1e9, 30, rating, i);
        }
        return (
          <span
            key={i}
            style={{
              display: 'inline-flex',
              transform: `scale(${scale})`,
              transformOrigin: 'center center',
              // Keep layout width even while scaled to 0 so the row doesn't reflow.
              width: size,
              height: size,
            }}
          >
            <svg
              width={size}
              height={size}
              viewBox={`0 0 ${size} ${size}`}
              style={{ display: 'block', overflow: 'visible' }}
            >
              {/* Dim full outline so empty / partial stars still read as a 5-star row. */}
              <polygon points={points} fill={color} opacity={0.22} />
              {fill > 0.001 ? (
                fill >= 0.999 ? (
                  <polygon points={points} fill={color} />
                ) : (
                  <>
                    <defs>
                      <clipPath id={`rating-star-fill-${i}`}>
                        <rect x={0} y={0} width={size * fill} height={size} />
                      </clipPath>
                    </defs>
                    <polygon
                      points={points}
                      fill={color}
                      clipPath={`url(#rating-star-fill-${i})`}
                    />
                  </>
                )
              ) : null}
            </svg>
          </span>
        );
      })}
    </span>
  );
}

// Build a "cx,cy cx,cy …" polygon points string for a 5-point star of
// the given outer + inner radii, centered at (r, r) so the SVG viewBox
// can be a square of side 2r.
function starPoints(outerR, innerR) {
  const cx = outerR;
  const cy = outerR;
  const verts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = -Math.PI / 2 + i * (Math.PI / 5);
    verts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return verts.join(' ');
}

export const TextSlot = ({ slot, content, tokens, dims, format, progress }) => {
  const t = slot.treatment;
  const text = applyCasing(content, t.casing);
  const quoteWrap = slot.key === 'quote' ? `“${String(text).replace(/^["'“”]+|["'“”]+$/g, '')}”` : text;
  const reviewerWrap = slot.key === 'reviewer' ? `— ${quoteWrap}` : quoteWrap;
  const accent = t.accent || { type: 'none' };
  return (
    <div style={{ position: 'relative', ...scrimStyle(t, tokens, dims), maxWidth: '100%' }}>
      {accent.type === 'bar' ? <Accent accent={accent} tokens={tokens} progress={progress} dims={dims} /> : null}
      <div
        style={{
          ...textCoreStyle(slot, tokens, dims, format),
          fontStyle: slot.key === 'quote' ? 'italic' : 'normal',
          paddingLeft: accent.type === 'bar' ? Math.round(dims.width * 0.015) : 0,
        }}
      >
        {reviewerWrap}
      </div>
      {accent.type === 'underline' ? <Accent accent={accent} tokens={tokens} progress={progress} dims={dims} /> : null}
    </div>
  );
};

export const RatingSlot = ({ slot, content, tokens, dims, format, timeScale = 1 }) => {
  // Motion is frame-derived (Remotion contract) — never Date/random/setTimeout.
  // Parent also passes frame/fps; hooks are the authoritative source so a
  // standalone preview composition still animates without prop plumbing.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = slot.treatment;
  // Stars + score share the same sizeScale-driven base (SVG star diameter
  // tracks font size so a rating sizeScale bump enlarges the whole lockup).
  const size = baseSize('rating', format, t.sizeScale);
  const { rating, reviewsText } = content;
  const font = tokenFont(tokens, 'body');
  // Secondary color follows the slot's (possibly contrast-flipped) token:
  // when the group flips to on-light colors, the count line flips too.
  // PRIMARY ink for the reviews line, not the dim secondary token.
  //
  // MEASURED on a delivered Vuori 1:1 (owner: "the number of reviews and
  // everything on that line is simply not legible"): against the same backdrop,
  // the headline rendered at 6.87:1 contrast and the reviews line at 3.35:1 —
  // its glyphs peaked at 0.715 luminance because textSecondary is a deliberately
  // dimmed grey. 3.35:1 is below the 4.5:1 floor for text this size, so the line
  // was failing on any mid-tone plate, not just that one.
  //
  // Same mistake, same fix as DeliverySlot ("Inherit primary ink — do NOT demote
  // to textSecondary"). Dimming is a valid choice on a flat studio backdrop and a
  // bug on footage; the whole point of the plate-intel ink flip is that we do not
  // know which we have until we look.
  const secondaryToken = t.colorToken === 'textOnLight' ? 'textOnLight' : 'textPrimary';

  // Internal choreography is relative to the slot's own enterAtSec (group
  // enter transition is already applied by Canonical around this renderer).
  const localFrame = ratingLocalFrame(frame, fps, slot.timing?.enterAtSec ?? 0, timeScale);
  // Reviews line normally waits for the 5th star to land (~0.58s) so the
  // count-up doesn't roll while stars are still popping in. When rating is
  // null (owner's ">4.5 stars only" rule suppressed a real-but-low rating,
  // e.g. GymShark 3.3★/41k reviews) there are no stars rendered at all, so
  // there is nothing to wait for — start right at the slot's own enter.
  const countStartSec = rating != null ? lastStarLandSec() : 0;
  const parsed = reviewsText ? parseReviewsLeadingNumber(reviewsText) : null;

  let reviewsNode = null;
  if (reviewsText) {
    if (parsed) {
      const n = countUpValue(localFrame, fps, parsed.target, {
        startSec: countStartSec,
        durationSec: COUNT_DUR_SEC,
      });
      const suffixOp = suffixOpacityAt(localFrame, fps, {
        startSec: countStartSec,
        durationSec: COUNT_DUR_SEC,
        fadeSec: SUFFIX_FADE_SEC,
      });
      reviewsNode = (
        <span
          style={{
            color: tokenColor(tokens, secondaryToken),
            fontSize: Math.round(size * 0.82),
            fontWeight: 500,
            fontFamily: fontFamilyCss(font),
            textShadow: textShadowFor(t.shadow, tokenColor(tokens, secondaryToken)),
            maxWidth: '100%',
            // Tabular figures keep the rolling digits from jittering row width.
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: '"tnum" 1',
          }}
        >
          <span>{formatReviewsCount(n)}</span>
          <span style={{ opacity: suffixOp }}>{parsed.suffix}</span>
        </span>
      );
    } else {
      // No leading integer → skip count-up; fade the whole line in after stars.
      const op = lineFadeOpacityAt(localFrame, fps, {
        startSec: countStartSec,
        durationSec: SUFFIX_FADE_SEC,
      });
      reviewsNode = (
        <span
          style={{
            color: tokenColor(tokens, secondaryToken),
            fontSize: Math.round(size * 0.82),
            fontWeight: 500,
            fontFamily: fontFamilyCss(font),
            textShadow: textShadowFor(t.shadow, tokenColor(tokens, secondaryToken)),
            maxWidth: '100%',
            opacity: op,
          }}
        >
          {reviewsText}
        </span>
      );
    }
  }

  // Lockup: stars+score on line 1; reviewsText UNDER as line 2 (same max
  // width). No reviewsText → stars+score only (unchanged empty behaviour).
  // rating === null → no stars / no score row at all: StarRow's labelFill
  // is Math.min(count, Math.max(0, Number(rating) || 0)), so feeding it a
  // null rating would silently draw FIVE EMPTY STARS — worse than nothing
  // for a brand the owner's rule deliberately suppressed. Skip the whole
  // row instead (not just hide it) so there's no leftover flex gap above
  // the reviews line.
  return (
    <div
      style={{
        ...scrimStyle(t, tokens, dims),
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: Math.round(size * 0.28),
        maxWidth: '100%',
      }}
    >
      {rating != null ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: Math.round(dims.width * 0.016),
          }}
        >
          <StarRow
            color={tokenColor(tokens, 'stars')}
            size={Math.round(size * 1.15)}
            gap={Math.round(size * 0.15)}
            rating={rating}
            count={STAR_COUNT}
            localFrame={localFrame}
            fps={fps}
          />
          <span style={{ color: tokenColor(tokens, t.colorToken), fontSize: size, fontWeight: 700, fontFamily: fontFamilyCss(font), textShadow: textShadowFor(t.shadow, tokenColor(tokens, t.colorToken)) }}>
            {rating.toFixed(1)}/5
          </span>
        </div>
      ) : null}
      {reviewsNode}
    </div>
  );
};

const Pill = ({ children, bg, text, stroke, dims, size, tracking }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: bg,
      color: text,
      border: stroke ? `2px solid ${stroke}` : 'none',
      borderRadius: 999,
      padding: `${Math.round(size * 0.55)}px ${Math.round(size * 1.1)}px`,
      fontSize: size,
      fontWeight: 700,
      letterSpacing: `${tracking ?? 1.5}px`,
      boxShadow: BOX_SHADOWS.soft,
      whiteSpace: 'nowrap',
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}
  >
    {children}
  </div>
);

// PLAIN TEXT, NO PILL — owner direction 2026-08-03.
//
// This slot used to render a filled Pill using the brand's badgeBg/badgeText
// tokens. Because those tokens come from brand theme, the same slot shipped a
// CHARCOAL box on Vuori and a cream one on GymShark — and on a light plate the
// dark box read as exactly the scrim treatment the no-scrim standard exists to
// remove. Owner, seeing it in a delivered ad: *"there is a dark pill"*, and when
// asked how the badge should read: *"Plain text, no pill."*
//
// So the badge now renders as small-caps type in the SAME ink as the rest of the
// group (textPrimary, which the plate-intel contrast flip already drives), which
// also makes it consistent across brands instead of per-token. `Pill` is still
// used by CTA/promo, which are meant to read as buttons.
export const BadgeSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('badge', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), fontFamily: fontFamilyCss(font) }}>
      <span
        style={{
          fontFamily: fontFamilyCss(font),
          fontWeight: t.weight || 700,
          fontSize: size,
          letterSpacing: `${t.trackingPx ?? 1.5}px`,
          color: tokenColor(tokens, t.colorToken || 'textPrimary'),
          whiteSpace: 'nowrap',
        }}
      >
        {applyCasing(content, t.casing === 'none' ? 'upper' : t.casing)}
      </span>
    </div>
  );
};

export const BrandPillSlot = ({ slot, content, tokens, dims, format, meta }) => {
  const t = slot.treatment;
  const size = baseSize('brandPill', format, t.sizeScale);
  // The brand's real logo wins over the text pill whenever the ad meta
  // carries one (logoMode 'text' opts back into the pill). Drop-shadow
  // only — no box, matching the no-scrim standard.
  if (t.logoMode !== 'text' && meta?.brandLogoUrl) {
    // Remotion <Img> blocks the frame capture until the logo is decoded —
    // a native <img> can race the screenshot on the first frames.
    return (
      <Img
        src={meta.brandLogoUrl}
        alt={content || 'brand logo'}
        pauseWhenLoading
        style={{
          height: Math.round(size * 2.4),
          maxWidth: Math.round(dims.width * 0.4),
          objectFit: 'contain',
          filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5)) drop-shadow(0 4px 12px rgba(0,0,0,0.35))',
        }}
      />
    );
  }
  const font = tokenFont(tokens, 'body');
  const color = tokenColor(tokens, t.colorToken);
  return (
    <div style={{ fontFamily: fontFamilyCss(font) }}>
      <Pill bg="transparent" text={color} stroke={hexToRgba(color, 0.94)} dims={dims} size={size} tracking={t.trackingPx || 2.2}>
        {applyCasing(content, 'upper')}
      </Pill>
    </div>
  );
};

export const CtaSlot = ({ slot, content, tokens, dims, format, frame, fps, timeScale = 1 }) => {
  const t = slot.treatment;
  const size = baseSize('cta', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  // Gentle attention pulse anchored to the (time-scaled) moment the button
  // finishes entering — sin starts at 0 so there is no scale snap, and the
  // onset doesn't drift with plate length.
  const enterEnd = slot.timing.enterAtSec * timeScale + slot.timing.enterDurationSec + 0.4;
  const tSec = frame / fps;
  const pulse = tSec > enterEnd ? 1 + 0.018 * Math.sin((tSec - enterEnd) * Math.PI * 1.1) : 1;
  return (
    <div style={{ fontFamily: fontFamilyCss(font), transform: `scale(${pulse})` }}>
      <Pill
        bg={hexToRgba(tokenColor(tokens, 'ctaBg'), 0.97)}
        text={tokenColor(tokens, 'ctaText')}
        stroke={hexToRgba('#FFFFFF', 0.25)}
        dims={dims}
        size={size}
        tracking={t.trackingPx || 1.2}
      >
        {applyCasing(content, t.casing === 'none' ? 'upper' : t.casing)}
      </Pill>
    </div>
  );
};

export const PromoSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('promo', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  return (
    <div style={{ fontFamily: fontFamilyCss(font) }}>
      <Pill bg={hexToRgba(tokenColor(tokens, 'promoBg'), 0.97)} text={tokenColor(tokens, 'promoText')} dims={dims} size={size} tracking={t.trackingPx || 1}>
        {applyCasing(content, t.casing)}
      </Pill>
    </div>
  );
};

const TruckIcon = ({ size, color }) => (
  <svg width={size * 1.3} height={size} viewBox="0 0 24 18" fill="none" style={{ flexShrink: 0 }}>
    <path
      d="M1 3h12v10H1zM13 6h5l4 4v3h-9zM6 16.5a2 2 0 100-4 2 2 0 000 4zM17.5 16.5a2 2 0 100-4 2 2 0 000 4z"
      stroke={color}
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

// Does this line actually make a delivery/shipping claim? The truck icon is
// only honest when it does.
//
// WHY THIS IS NEEDED: the slot is named deliveryLine and labelled "Delivery /
// offer line", but its cascade binds `layoutInput.input.product.badges[1]`
// (metaCascadeConfig.js) — the SECOND BADGE. So the text is routinely
// "Premium Cotton", "Best Seller", "New Arrival"… and the old condition
// (`endcardMode !== 'brand'`, i.e. every product ad) stapled a shipping truck
// onto all of them. Owner, seeing it in a delivered ad: *"I am seeing the
// shipping car show back up."* A truck beside "Premium Cotton" is a claim the
// copy never made.
// Content-driven, so the icon returns automatically if a real delivery line is
// ever bound to the slot, without another code change.
const DELIVERY_CLAIM = /\b(ship(s|ped|ping)?|deliver(s|ed|y)?|free\s+(ship|deliver)|arrives?|arriving|next[- ]day|same[- ]day|overnight|\d+\s*[-–]?\s*\d*\s*(business\s+)?days?|returns?|exchange)\b/i;

export const DeliverySlot = ({ slot, content, tokens, dims, format, meta }) => {
  const t = slot.treatment;
  const size = baseSize('deliveryLine', format, t.sizeScale);
  const font = tokenFont(tokens, 'body');
  // Inherit primary ink (and plate-intel contrast flip) — do NOT demote to
  // textSecondary. Weight comes from treatment (presets set 600).
  const color = tokenColor(tokens, t.colorToken || 'textPrimary');
  const showTruck = meta?.endcardMode !== 'brand'
    && DELIVERY_CLAIM.test(String(content ?? ''));
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.5) }}>
      {showTruck ? <TruckIcon size={size} color={color} /> : null}
      <span
        style={{
          fontFamily: fontFamilyCss(font),
          fontWeight: t.weight || 600,
          fontSize: size,
          color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textShadow: textShadowFor(t.shadow, color),
        }}
      >
        {applyCasing(content, t.casing)}
      </span>
    </div>
  );
};

export const PriceSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('price', format, t.sizeScale);
  const font = tokenFont(tokens, t.fontRole === 'body' ? 'heading' : t.fontRole);
  const raw = String(content);
  // Only prefix a bare number — anything already carrying a currency
  // marker anywhere ('From $48', '£29', '48 USD') passes through.
  const text = /[$€£¥]|usd|eur|gbp/i.test(raw) ? raw : `$${raw}`;
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-block' }}>
      <span style={{ fontFamily: fontFamilyCss(font), fontWeight: Math.max(t.weight, 700), fontSize: size, color: tokenColor(tokens, t.colorToken), textShadow: textShadowFor(t.shadow, tokenColor(tokens, t.colorToken)) }}>
        {text}
      </span>
    </div>
  );
};

// ── Text slots added to the vocabulary — all reuse TextSlot but with
// their own BASE_SIZE entry so per-slot size defaults track semantic
// weight (tagline > website > likes).

export const ProductDescriptionSlot = TextSlot;
export const TaglineSlot = TextSlot;
export const WebsiteSlot = TextSlot;

// Likes — text prefixed with a heart glyph (SVG, not text char, so no
// font-glyph-coverage risk). Content is either a raw number or the
// prewrapped "Loved by N" text; the renderer formats numeric values.
export const LikesSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('likes', format, t.sizeScale);
  const font = tokenFont(tokens, t.fontRole);
  const raw = String(content);
  const asNum = Number(raw.replace(/[,_\s]/g, ''));
  const label = Number.isFinite(asNum) && asNum > 0
    ? `${formatCount(asNum)} likes`
    : raw;
  const color = tokenColor(tokens, t.colorToken);
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.4) }}>
      <svg width={Math.round(size * 1.05)} height={Math.round(size * 1.05)} viewBox="0 0 24 24" style={{ display: 'block' }}>
        <path d="M12 21s-7.5-4.6-9.6-9.5C.9 7.6 3.5 4 7 4c2 0 3.5 1 5 2.7C13.5 5 15 4 17 4c3.5 0 6.1 3.6 4.6 7.5C19.5 16.4 12 21 12 21z" fill={color} />
      </svg>
      <span style={{ fontFamily: fontFamilyCss(font), fontWeight: t.weight, fontSize: size, color, textShadow: textShadowFor(t.shadow, color) }}>
        {applyCasing(label, t.casing)}
      </span>
    </div>
  );
};

// Review count — formats a raw number as "N reviews". Passes through
// prewrapped strings ("128 reviews" already fine).
export const ReviewCountSlot = ({ slot, content, tokens, dims, format }) => {
  const t = slot.treatment;
  const size = baseSize('reviewCount', format, t.sizeScale);
  const font = tokenFont(tokens, t.fontRole);
  const raw = String(content);
  const asNum = Number(raw.replace(/[,_\s]/g, ''));
  const label = Number.isFinite(asNum) && asNum > 0
    ? `${asNum.toLocaleString('en-US')} review${asNum === 1 ? '' : 's'}`
    : raw;
  return (
    <div style={{ ...scrimStyle(t, tokens, dims), display: 'inline-block' }}>
      <span style={{ fontFamily: fontFamilyCss(font), fontWeight: t.weight, fontSize: size, color: tokenColor(tokens, t.colorToken), textShadow: textShadowFor(t.shadow, tokenColor(tokens, t.colorToken)) }}>
        {applyCasing(label, t.casing)}
      </span>
    </div>
  );
};

// Multi-value badges — array of short strings rendered as pills, bullet
// list, or plain text. `itemLayout` controls stack/row/grid; `itemDelaySec`
// staggers per-item entrance (progress-aware; each item appears at its
// own offset). Reuses the badge Pill style for `itemStyle: 'pill'`.
export const BadgesSlot = ({ slot, content, tokens, dims, format, progress }) => {
  return renderMultiValue({ slot, content, tokens, dims, format, progress, sizeKey: 'badges' });
};

// Multi-value benefits — same renderer as badges, but the treatment
// defaults to `itemLayout: 'stack'` and `itemStyle: 'bullet'` (validator
// sets these per slot key). Splits into its own export for future
// divergence (e.g., check-mark bullets, custom benefit icons).
export const BenefitsSlot = ({ slot, content, tokens, dims, format, progress }) => {
  return renderMultiValue({ slot, content, tokens, dims, format, progress, sizeKey: 'benefits' });
};

function renderMultiValue({ slot, content, tokens, dims, format, progress, sizeKey }) {
  const t = slot.treatment;
  const size = baseSize(sizeKey, format, t.sizeScale);
  const items = Array.isArray(content) ? content : [content];
  const layout = t.itemLayout || 'row';
  const style  = t.itemStyle  || 'plain';
  const delay  = t.itemDelaySec || 0;
  const gap    = Math.round(Math.min(dims.width, dims.height) * (t.itemGap || 0.012));
  const font   = tokenFont(tokens, t.fontRole);
  const fg     = tokenColor(tokens, t.colorToken);

  // Container layout — grid uses a 2-column auto-fit; row is inline-flex; stack is column.
  const containerStyle = layout === 'grid'
    ? { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap }
    : layout === 'row'
      ? { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap }
      : { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap };

  return (
    <div style={{ ...scrimStyle(t, tokens, dims), ...containerStyle }}>
      {items.map((raw, i) => {
        // Per-item envelope — items appear in sequence when `delay` > 0.
        // `progress` is the slot's 0..1 visible window; scaling it by
        // (items × delay + entrance) gives each item its own reveal.
        const itemOnset = Math.min(0.999, i * delay / Math.max(0.001, (items.length * delay + 0.4)));
        const itemP = Math.max(0, Math.min(1, (progress - itemOnset) / (1 - itemOnset)));
        const opacity = itemP > 0 ? Math.min(1, itemP * 3) : 0;
        const translate = (1 - Math.min(1, itemP * 2.5)) * 8;
        const label = applyCasing(String(raw), t.casing === 'none' ? (style === 'pill' ? 'upper' : 'none') : t.casing);

        const commonSpan = { opacity, transform: `translateY(${translate}px)` };
        if (style === 'pill' || style === 'chip') {
          return (
            <div key={i} style={{ ...commonSpan, fontFamily: fontFamilyCss(font) }}>
              <Pill
                bg={style === 'chip' ? 'transparent' : hexToRgba(tokenColor(tokens, 'badgeBg'), 0.96)}
                text={style === 'chip' ? fg : tokenColor(tokens, 'badgeText')}
                stroke={style === 'chip' ? hexToRgba(fg, 0.9) : null}
                dims={dims}
                size={size}
                tracking={t.trackingPx || 1}
              >
                {label}
              </Pill>
            </div>
          );
        }
        if (style === 'bullet') {
          return (
            <div key={i} style={{ ...commonSpan, display: 'inline-flex', alignItems: 'baseline', gap: Math.round(size * 0.4), fontFamily: fontFamilyCss(font) }}>
              <span style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4), borderRadius: '50%', backgroundColor: fg, display: 'inline-block', alignSelf: 'center' }} />
              <span style={{ fontSize: size, fontWeight: t.weight, color: fg, textShadow: textShadowFor(t.shadow, fg) }}>{label}</span>
            </div>
          );
        }
        // plain
        return (
          <span key={i} style={{ ...commonSpan, fontSize: size, fontWeight: t.weight, color: fg, fontFamily: fontFamilyCss(font), textShadow: textShadowFor(t.shadow, fg) }}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

// Image slots — <Img> with fit + size + radius. Content is a URL string
// (asset-server URL — the render browser has no external egress, so URLs
// must resolve inside the local network).
export const ProductImageSlot = ({ slot, content, tokens, dims }) => {
  return renderImage({ slot, content, tokens, dims });
};
export const BrandLogoSlot = ({ slot, content, tokens, dims }) => {
  return renderImage({ slot, content, tokens, dims });
};

function renderImage({ slot, content, tokens, dims }) {
  const t = slot.treatment;
  const short = Math.min(dims.width, dims.height);
  const size  = Math.round(short * (t.sizePct || 0.35));
  const radius = Math.round(size * (t.radiusPct || 0));
  const border = Math.round(short * (t.borderWidthPct || 0));
  return (
    <Img
      src={content}
      alt=""
      pauseWhenLoading
      style={{
        width: size,
        height: size,
        objectFit: t.fit || 'contain',
        borderRadius: radius,
        boxShadow: BOX_SHADOWS[t.shadow === 'none' ? 'none' : 'soft'],
        border: border > 0 ? `${border}px solid ${tokenColor(tokens, t.borderColorToken || 'accent')}` : 'none',
      }}
    />
  );
}

// Helper — compact number formatter (1200 → "1.2k") for likes/similar.
function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000)      return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export const SLOT_RENDERERS = {
  headline: TextSlot,
  quote: TextSlot,
  reviewer: TextSlot,
  productName: TextSlot,
  rating: RatingSlot,
  badge: BadgeSlot,
  brandPill: BrandPillSlot,
  cta: CtaSlot,
  promo: PromoSlot,
  deliveryLine: DeliverySlot,
  price: PriceSlot,
  // Added text slots — same TextSlot renderer, different BASE_SIZE keys.
  productDescription: ProductDescriptionSlot,
  tagline: TaglineSlot,
  website: WebsiteSlot,
  likes: LikesSlot,
  reviewCount: ReviewCountSlot,
  // Multi-value + image slots.
  badges: BadgesSlot,
  benefits: BenefitsSlot,
  productImage: ProductImageSlot,
  brandLogo: BrandLogoSlot,
};
