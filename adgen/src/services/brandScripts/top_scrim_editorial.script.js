// Vertical (9:16) canonical — top-anchored editorial testimonial.
//
// Content pinned near the top of the frame (below Reels/Shorts chrome
// safe zone). Each text block sits on its own rounded rectangular
// scrim rather than a single large gradient scrim, so the bottom of
// the video breathes through the remaining ~55% of the frame.
//
// This file was originally a top-gradient design ("top_scrim_editorial");
// the filename stays for SystemConfig continuity, but the composition
// is now local-scrim throughout — matching the aesthetic used by the
// landscape and feed canonicals. All three canonicals share the same
// drawLocalScrim helper + per-element opacity theme keys.
//
// Theme keys used (all optional — sane defaults for each):
//   textPrimary, textSecondary, reviewerTextColor, starColor,
//   badgeBgColor, badgeTextColor, quoteMarkColor, separatorColor,
//   scrimColor, sansFontFamily, productFontFamily, productFontWeight,
//   quoteFontFamily, quoteFontWeight,
//   productScrimOpacity, ratingScrimOpacity, quoteScrimOpacity,
//   reviewerScrimOpacity
//
// meta.layout keys (all optional — position/size tuning knobs):
//   leftPosition, topPosition, maxWidth, rowGap,
//   scrimRadius, scrimPadX, scrimPadY, scrimShadowBlur

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;

    // 1. Draw the underlying vertical product video.
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Utility fallbacks ──────────────────────────────────────────
    const clamp = (value, min = 0, max = 1) =>
      h?.clamp ? h.clamp(value, min, max) : Math.max(min, Math.min(max, value));

    const t01 = (frame, start, duration) =>
      h?.t01 ? h.t01(frame, start, duration) : clamp((frame - start) / duration);

    const eoc = (value) =>
      h?.eoc ? h.eoc(value) : 1 - Math.pow(1 - clamp(value), 3);

    const rgba = (rgb, alpha = 1) =>
      h?.rgba ? h.rgba(rgb, alpha) : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

    // ── Dynamic content ────────────────────────────────────────────
    const badgeText = String(
      meta.badgeText || meta.callout || 'Customer Favorite'
    ).toUpperCase();

    const productName = String(
      meta.productName || meta.product || meta.name || 'Signature Product'
    );

    const rating = clamp(Number(meta.rating ?? 4.9), 0, 5);

    const reviewCount = String(
      meta.reviewCount || meta.reviews || '327 reviews'
    );

    const quote = normalizeQuote(
      meta.quote || meta.reviewQuote || 'Genuinely worth every penny.'
    );

    // No fabricated purchase persona. Empty → showReviewer block below skips.
    const reviewer = String(
      meta.reviewer || meta.customerName || ''
    ).toUpperCase();

    // ── Brand-driven theme ─────────────────────────────────────────
    const theme  = meta.theme  || {};
    const layout = meta.layout || {};

    const colors = {
      textPrimary:   theme.textPrimary   || [255, 249, 241],
      textSecondary: theme.textSecondary || [231, 217, 199],
      reviewerText:
        theme.reviewerTextColor || theme.accentColor || theme.accentGold ||
        [186, 199, 121],
      stars:
        theme.starColor || theme.accentColor || theme.accentGold ||
        [238, 166, 19],
      badgeBg:
        theme.badgeBgColor || theme.calloutBgColor || [190, 202, 130],
      badgeText:
        theme.badgeTextColor || theme.calloutTextColor || [31, 34, 25],
      quoteMark:
        theme.quoteMarkColor || theme.badgeBgColor || [190, 202, 130],
      separator:
        theme.separatorColor || theme.dividerColor || [224, 205, 180],
      scrim: theme.scrimColor || [12, 9, 6]
    };

    const fonts = {
      sans:
        theme.sansFontFamily || theme.bodyFontFamily || 'Inter',
      product:
        theme.productFontFamily || theme.headingFontFamily ||
        theme.serifFontFamily || 'Cormorant',
      productWeight:
        theme.productFontWeight || theme.headingFontWeight || 600,
      quote:
        theme.quoteFontFamily || theme.serifFontFamily || 'Lora',
      quoteWeight: theme.quoteFontWeight || 400
    };

    // ── Layout (9:16 top-anchored) ─────────────────────────────────
    // Wider content column than landscape — vertical needs the text
    // to fill most of the frame width to feel intentional.
    const leftPad = Math.round(W * (layout.leftPosition ?? 0.065));
    const rightPad = Math.round(W * 0.065);
    const contentTop = Math.round(H * (layout.topPosition ?? 0.135));
    const contentMaxW = Math.round(W * (layout.maxWidth ?? 0.87));

    const rowGap        = Math.round(H * (layout.rowGap        ?? 0.018));
    const scrimRadius   = Math.round(H * (layout.scrimRadius   ?? 0.014));
    const scrimPadX     = Math.round(W * (layout.scrimPadX     ?? 0.028));
    const scrimPadY     = Math.round(H * (layout.scrimPadY     ?? 0.010));
    const scrimShadowBlur = Math.round(H * (layout.scrimShadowBlur ?? 0.014));

    const productScrimOpacity  = theme.productScrimOpacity  ?? 0.67;
    const ratingScrimOpacity   = theme.ratingScrimOpacity   ?? 0.72;
    const quoteScrimOpacity    = theme.quoteScrimOpacity    ?? 0.70;
    const reviewerScrimOpacity = theme.reviewerScrimOpacity ?? 0.62;

    // ── Animation timing ───────────────────────────────────────────
    const badgeT   = eoc(t01(frameIndex, 8,  14));
    const productT = eoc(t01(frameIndex, 14, 18));
    const ratingT  = eoc(t01(frameIndex, 22, 18));
    const quoteT   = eoc(t01(frameIndex, 32, 20));

    let cursorY = contentTop;

    // ── 1. Badge pill ──────────────────────────────────────────────
    if (meta.showBadge !== false && badgeText) {
      ctx.save();
      ctx.globalAlpha = badgeT;

      const badgeFontSize = clamp(Math.round(H * 0.022), 20, 30);
      const badgeH = clamp(Math.round(H * 0.042), 42, 60);
      const badgePadX = Math.round(badgeH * 0.42);
      const xOffset = (1 - badgeT) * -18;

      ctx.font = `700 ${badgeFontSize}px "${fonts.sans}"`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Include letter-spacing (tracking) in the width calc so the pill
      // has symmetric padding — without this, drawTrackedText's added
      // gaps push the trailing char past the intended right-side pad.
      const badgeTracking = 1;
      const badgeCharCount = Array.from(badgeText).length;
      const trackedTextW =
        ctx.measureText(badgeText).width +
        Math.max(0, badgeCharCount - 1) * badgeTracking;
      const badgeW = Math.min(
        contentMaxW,
        trackedTextW + badgePadX * 2
      );

      ctx.shadowColor = 'rgba(0,0,0,0.20)';
      ctx.shadowBlur = scrimShadowBlur;
      ctx.shadowOffsetY = 4;

      ctx.fillStyle = rgba(colors.badgeBg, 0.97);
      roundedRect(ctx, leftPad + xOffset, cursorY, badgeW, badgeH, badgeH / 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = rgba(colors.badgeText, 1);
      drawTrackedText(
        ctx, badgeText,
        leftPad + badgePadX + xOffset,
        cursorY + badgeH / 2 + 1,
        badgeTracking, 'left'
      );

      ctx.restore();
      cursorY += badgeH + rowGap;
    }

    // ── 2. Product name with local scrim (2-line wrap) ─────────────
    // Wraps to two lines at a fixed larger size rather than shrinking
    // to fit one line — long product names ("Mako Deep Sea 19\" -
    // Pacific Rim") stay readable and don't collapse to the min font
    // size when the font fallback measures wider than intended.
    ctx.save();
    ctx.globalAlpha = productT;

    const productFontSize = clamp(Math.round(H * 0.038), 40, 60);
    ctx.font = `${fonts.productWeight} ${productFontSize}px "${fonts.product}"`;
    const productWrapW = contentMaxW - scrimPadX * 2;
    const productLines = wrapLines(ctx, productName, productWrapW, 2);
    const productLineH = Math.round(productFontSize * 1.14);

    let widestProductLine = 0;
    for (const line of productLines) {
      const w = ctx.measureText(line).width;
      if (w > widestProductLine) widestProductLine = w;
    }

    const productBoxW = widestProductLine + scrimPadX * 2;
    const productBoxH = productLines.length * productLineH + scrimPadY * 2;
    const productXOffset = (1 - productT) * -20;
    const productBoxX = leftPad + productXOffset;
    const productBoxY = cursorY;

    drawLocalScrim(
      ctx, productBoxX, productBoxY, productBoxW, productBoxH,
      scrimRadius, rgba(colors.scrim, productScrimOpacity), scrimShadowBlur
    );

    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    for (let i = 0; i < productLines.length; i++) {
      ctx.fillText(
        productLines[i],
        productBoxX + scrimPadX,
        productBoxY + scrimPadY + i * productLineH
      );
    }
    ctx.restore();

    cursorY += productBoxH + rowGap;

    // ── 3. Rating row with local scrim ─────────────────────────────
    ctx.save();
    ctx.globalAlpha = ratingT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const starFontSize   = clamp(Math.round(H * 0.024), 25, 40);
    const scoreFontSize  = clamp(Math.round(H * 0.020), 20, 32);
    const reviewFontSize = clamp(Math.round(H * 0.017), 18, 28);
    const scoreText = `${rating.toFixed(1)}/5`;

    // Stars — path-drawn (see drawStarRow at file bottom) to bypass
    // brand fonts that lack the U+2605 glyph and render tofu.
    const starGap = Math.round(starFontSize * 0.15);
    const starsW  = starFontSize * 5 + starGap * 4;

    ctx.font = `700 ${scoreFontSize}px "${fonts.sans}"`;
    const scoreW = ctx.measureText(scoreText).width;
    ctx.font = `500 ${reviewFontSize}px "${fonts.sans}"`;
    const reviewsW = ctx.measureText(reviewCount).width;

    const gapAfterStars     = Math.round(W * 0.020);
    const gapAroundSeparator = Math.round(W * 0.016);

    const ratingContentW =
      starsW + gapAfterStars + scoreW +
      gapAroundSeparator * 2 + 2 + reviewsW;

    const ratingBoxW = ratingContentW + scrimPadX * 2;
    const ratingBoxH = Math.max(starFontSize, scoreFontSize, reviewFontSize) * 1.18 + scrimPadY * 2;
    const ratingXOffset = (1 - ratingT) * -20;
    const ratingBoxX = leftPad + ratingXOffset;
    const ratingBoxY = cursorY;

    drawLocalScrim(
      ctx, ratingBoxX, ratingBoxY, ratingBoxW, ratingBoxH,
      scrimRadius, rgba(colors.scrim, ratingScrimOpacity), scrimShadowBlur
    );

    const centerY = ratingBoxY + ratingBoxH / 2 + 1;
    let currentX = ratingBoxX + scrimPadX;

    drawStarRow(ctx, currentX, centerY, starFontSize, starGap, rgba(colors.stars, 1));
    currentX += starsW + gapAfterStars;

    ctx.font = `700 ${scoreFontSize}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.fillText(scoreText, currentX, centerY + 1);
    currentX += scoreW + gapAroundSeparator;

    const separatorH = ratingBoxH * 0.46;
    ctx.strokeStyle = rgba(colors.separator, 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(currentX, centerY - separatorH / 2);
    ctx.lineTo(currentX, centerY + separatorH / 2);
    ctx.stroke();
    currentX += gapAroundSeparator;

    ctx.font = `500 ${reviewFontSize}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textSecondary, 0.98);
    ctx.fillText(reviewCount, currentX, centerY + 1);
    ctx.restore();

    cursorY += ratingBoxH + rowGap;

    // ── 4. Quote with local scrim (2-line wrap) ────────────────────
    // Reserve a fixed 2-line block so the reviewer scrim below doesn't
    // shift when the quote is short. Word-boundary wrap; ellipsis if
    // still overflowing on the second line.
    const QUOTE_LINES_FIXED = 2;
    if (meta.showQuote !== false && quote) {
      ctx.save();
      ctx.globalAlpha = quoteT;

      const quoteMarkSize = clamp(Math.round(H * 0.036), 40, 64);
      const quoteFontSize = clamp(Math.round(H * 0.022), 22, 36);
      const quoteLineH   = Math.round(quoteFontSize * 1.22);

      const quoteMarkGap = Math.round(W * 0.014);
      const quoteMarkW   = quoteMarkSize * 0.58;
      const maxQuoteTextW = contentMaxW - quoteMarkW - quoteMarkGap - scrimPadX * 2;

      ctx.font = `italic ${fonts.quoteWeight} ${quoteFontSize}px "${fonts.quote}"`;
      const quoteLines = wrapLines(ctx, quote, maxQuoteTextW, QUOTE_LINES_FIXED);
      let widestQuoteLine = 0;
      for (const line of quoteLines) {
        const w = ctx.measureText(line).width;
        if (w > widestQuoteLine) widestQuoteLine = w;
      }

      const quoteBoxW = quoteMarkW + quoteMarkGap + Math.max(widestQuoteLine, maxQuoteTextW * 0.5) + scrimPadX * 2;
      const quoteBoxH = Math.max(quoteMarkSize * 0.88, QUOTE_LINES_FIXED * quoteLineH) + scrimPadY * 2;
      const quoteXOffset = (1 - quoteT) * -20;
      const quoteBoxX = leftPad + quoteXOffset;
      const quoteBoxY = cursorY;

      drawLocalScrim(
        ctx, quoteBoxX, quoteBoxY, quoteBoxW, quoteBoxH,
        scrimRadius, rgba(colors.scrim, quoteScrimOpacity), scrimShadowBlur
      );

      // Decorative opening quote mark, vertically centered in the box.
      ctx.font = `700 ${quoteMarkSize}px "${fonts.quote}"`;
      ctx.fillStyle = rgba(colors.quoteMark, 0.98);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        '\u201C',
        quoteBoxX + scrimPadX,
        quoteBoxY + quoteBoxH / 2 + quoteMarkSize * 0.08
      );

      // Quote lines, top-anchored inside the box.
      const quoteTextX = quoteBoxX + scrimPadX + quoteMarkW + quoteMarkGap;
      const quoteTextY0 = quoteBoxY + scrimPadY;
      ctx.font = `italic ${fonts.quoteWeight} ${quoteFontSize}px "${fonts.quote}"`;
      ctx.fillStyle = rgba(colors.textPrimary, 1);
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,0.24)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 1;
      for (let i = 0; i < quoteLines.length; i++) {
        ctx.fillText(quoteLines[i], quoteTextX, quoteTextY0 + i * quoteLineH);
      }

      ctx.restore();
      cursorY += quoteBoxH + Math.round(H * 0.008);

      // ── 5. Reviewer attribution — nested smaller scrim ───────────
      if (meta.showReviewer !== false && reviewer) {
        ctx.save();
        ctx.globalAlpha = quoteT;

        const reviewerFontSize = clamp(Math.round(H * 0.013), 13, 20);
        ctx.font = `700 ${reviewerFontSize}px "${fonts.sans}"`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const reviewerTextW = ctx.measureText(reviewer).width;
        const reviewerPadX = Math.round(scrimPadX * 0.78);
        const reviewerPadY = Math.round(scrimPadY * 0.65);
        const reviewerBoxW = reviewerTextW + reviewerPadX * 2;
        const reviewerBoxH = reviewerFontSize * 1.3 + reviewerPadY * 2;
        const reviewerBoxX = leftPad + quoteMarkW + quoteMarkGap + quoteXOffset;
        const reviewerBoxY = cursorY;

        drawLocalScrim(
          ctx, reviewerBoxX, reviewerBoxY, reviewerBoxW, reviewerBoxH,
          scrimRadius * 0.75,
          rgba(colors.scrim, reviewerScrimOpacity),
          scrimShadowBlur * 0.75
        );

        ctx.fillStyle = rgba(colors.reviewerText, 1);
        ctx.fillText(
          reviewer,
          reviewerBoxX + reviewerPadX,
          reviewerBoxY + reviewerBoxH / 2 + 1
        );
        ctx.restore();
      }
    }

    if (meta.debugLayout === true) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,0,0.65)';
      ctx.lineWidth = 2;
      ctx.strokeRect(leftPad, contentTop, contentMaxW, H * 0.55);
      ctx.restore();
    }
  }
};

// ── Drawing helpers ────────────────────────────────────────────────

function drawLocalScrim(ctx, x, y, w, h, radius, fillStyle, shadowBlur = 16) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = fillStyle;
  roundedRect(ctx, x, y, w, h, radius);
  ctx.fill();
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, radius) {
  if (w <= 0 || h <= 0) return;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTrackedText(ctx, text, x, y, tracking = 0, align = 'center') {
  const characters = Array.from(String(text || ''));
  let totalWidth = 0;
  for (let i = 0; i < characters.length; i++) {
    totalWidth += ctx.measureText(characters[i]).width;
    if (i < characters.length - 1) totalWidth += tracking;
  }
  let cursorX = align === 'left' ? x : x - totalWidth / 2;
  for (const character of characters) {
    ctx.fillText(character, cursorX, y);
    cursorX += ctx.measureText(character).width + tracking;
  }
}

function fitFontSize(ctx, text, maxWidth, preferredSize, minimumSize, fontFamily, fontWeight = 400) {
  const value = String(text || '');
  let size = preferredSize;
  while (size > minimumSize) {
    ctx.font = `${fontWeight} ${size}px "${fontFamily}"`;
    if (ctx.measureText(value).width <= maxWidth) return size;
    size -= 1;
  }
  return minimumSize;
}

function fitText(ctx, text, maxWidth) {
  const value = String(text || '').trim();
  if (ctx.measureText(value).width <= maxWidth) return value;
  const words = value.split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ') + '\u2026';
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  let output = words[0] || value;
  while (output.length > 3 && ctx.measureText(`${output}\u2026`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output.trim()}\u2026`;
}

// Wrap text into up to `maxLines` lines at word boundaries. The last
// line is ellipsis-truncated (word-boundary) if the remaining words
// don't fit.
function wrapLines(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '')
    .replace(/\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) {
        const remaining = [line, ...words.slice(i + 1)].join(' ');
        lines.push(fitText(ctx, remaining, maxWidth));
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function normalizeQuote(value) {
  return String(value || '')
    .trim()
    .replace(/^[\u201C\u201D"'\u2018\u2019]+/, '')
    .replace(/[\u201C\u201D"'\u2018\u2019]+$/, '')
    .trim();
}

// Path-drawn 5-point star row — bypasses font glyph-coverage issues
// that produce tofu boxes when brand fonts (Bebas Neue, Antonio, etc.)
// lack U+2605. See canonical.script.js drawStarRow for the same helper.
function drawStarRow(ctx, x, yCenter, size, gap, fillStyle) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  const outerR = size / 2;
  const innerR = outerR * 0.4;
  for (let s = 0; s < 5; s++) {
    const cx = x + s * (size + gap) + outerR;
    const cy = yCenter;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = -Math.PI / 2 + i * (Math.PI / 5);
      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else         ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
