// Landscape (16:9) canonical — local-scrim editorial testimonial.
//
// Content anchored to the LEFT column (default 43% of width) with the
// product footage occupying the right two-thirds. Each text block sits
// on its own rounded rectangular scrim rather than a single large
// gradient scrim, so the video reads cleanly through the remaining
// area without one big dark wash.
//
// Tuned for 1920×1080 (Google Performance Max, YouTube pre-roll,
// Meta feed 16:9). Proportions scale — but on 9:16 or 4:5 the 43%
// content column and 20% top offset will feel off; use the vertical /
// feed canonicals for those aspects.
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

    // 1. Draw the underlying 16:9 product video.
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Utility fallbacks ──────────────────────────────────────────
    const clamp = (value, min = 0, max = 1) =>
      h?.clamp
        ? h.clamp(value, min, max)
        : Math.max(min, Math.min(max, value));

    const t01 = (frame, start, duration) =>
      h?.t01
        ? h.t01(frame, start, duration)
        : clamp((frame - start) / duration);

    const eoc = (value) =>
      h?.eoc
        ? h.eoc(value)
        : 1 - Math.pow(1 - clamp(value), 3);

    const rgba = (rgb, alpha = 1) =>
      h?.rgba
        ? h.rgba(rgb, alpha)
        : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;

    // ── Endcard-mode dispatch ──────────────────────────────────────
    // Brand campaigns (no productId) suppress the product-specific
    // chrome — badge pill + star rating — and substitute Brand.tagline
    // into the primary-text slot. Quote / reviewer / brand mark are
    // shared across modes. Same treatment canonical.script.js (feed)
    // applies at 1:1 / 4:5.
    const endcardMode = meta.endcardMode === 'brand' ? 'brand' : 'product';
    const isBrandMode = endcardMode === 'brand';

    // ── Dynamic content ────────────────────────────────────────────
    const badgeText = String(
      meta.badgeText ||
      meta.callout ||
      'Customer Favorite'
    ).toUpperCase();

    const productName = String(
      isBrandMode
        ? (meta.brandTagline || meta.headline || 'A brand you can trust')
        : (meta.productName || meta.product || meta.name || 'Desert Rose Arrangement')
    );

    const hasRating = Number.isFinite(Number(meta.rating)) && Number(meta.rating) > 0;
    const rating = clamp(
      Number(meta.rating ?? 4.9),
      0,
      5
    );

    const reviewCount = String(
      meta.reviewCount ||
      meta.reviews ||
      '327 reviews'
    );

    const quote = normalizeQuote(
      meta.quote ||
      meta.reviewQuote ||
      'Stunning and lasted all week.'
    );

    // No fabricated purchase persona. Empty → showReviewer block below skips.
    const reviewer = String(
      meta.reviewer ||
      meta.customerName ||
      ''
    ).toUpperCase();

    // ── Brand-driven theme ─────────────────────────────────────────
    const theme = meta.theme || {};
    const layout = meta.layout || {};

    const colors = {
      textPrimary:
        theme.textPrimary ||
        [255, 249, 241],

      textSecondary:
        theme.textSecondary ||
        [231, 217, 199],

      reviewerText:
        theme.reviewerTextColor ||
        theme.accentColor ||
        theme.accentGold ||
        [186, 199, 121],

      stars:
        theme.starColor ||
        theme.accentColor ||
        theme.accentGold ||
        [238, 166, 19],

      badgeBg:
        theme.badgeBgColor ||
        theme.calloutBgColor ||
        [190, 202, 130],

      badgeText:
        theme.badgeTextColor ||
        theme.calloutTextColor ||
        [31, 34, 25],

      quoteMark:
        theme.quoteMarkColor ||
        theme.badgeBgColor ||
        [190, 202, 130],

      separator:
        theme.separatorColor ||
        theme.dividerColor ||
        [224, 205, 180],

      scrim:
        theme.scrimColor ||
        [12, 9, 6],
    };

    const fonts = {
      sans:
        theme.sansFontFamily ||
        theme.bodyFontFamily ||
        'Inter',

      product:
        theme.productFontFamily ||
        theme.headingFontFamily ||
        theme.serifFontFamily ||
        'Cormorant',

      productWeight:
        theme.productFontWeight ||
        theme.headingFontWeight ||
        600,

      quote:
        theme.quoteFontFamily ||
        theme.serifFontFamily ||
        'Lora',

      quoteWeight:
        theme.quoteFontWeight ||
        400,
    };

    // ── Layout ─────────────────────────────────────────────────────
    // Tuned for 1920×1080, but scales proportionally.
    const leftPad = Math.round(
      W * (layout.leftPosition ?? 0.075)
    );

    const contentTop = Math.round(
      H * (layout.topPosition ?? 0.205)
    );

    const contentMaxW = Math.round(
      W * (layout.maxWidth ?? 0.43)
    );

    const rowGap = Math.round(
      H * (layout.rowGap ?? 0.025)
    );

    const scrimRadius = Math.round(
      H * (layout.scrimRadius ?? 0.018)
    );

    const scrimPadX = Math.round(
      W * (layout.scrimPadX ?? 0.012)
    );

    const scrimPadY = Math.round(
      H * (layout.scrimPadY ?? 0.009)
    );

    const scrimShadowBlur = Math.round(
      H * (layout.scrimShadowBlur ?? 0.018)
    );

    const productScrimOpacity =
      theme.productScrimOpacity ?? 0.67;

    const ratingScrimOpacity =
      theme.ratingScrimOpacity ?? 0.72;

    const quoteScrimOpacity =
      theme.quoteScrimOpacity ?? 0.70;

    const reviewerScrimOpacity =
      theme.reviewerScrimOpacity ?? 0.62;

    // ── Animation timing ───────────────────────────────────────────
    const badgeT = eoc(t01(frameIndex, 8, 14));
    const productT = eoc(t01(frameIndex, 14, 18));
    const ratingT = eoc(t01(frameIndex, 22, 18));
    const quoteT = eoc(t01(frameIndex, 32, 20));

    let cursorY = contentTop;

    // ── 2. Callout badge ───────────────────────────────────────────
    // Product-specific — skip in brand mode.
    if (!isBrandMode && meta.showBadge !== false && badgeText) {
      ctx.save();
      ctx.globalAlpha = badgeT;

      const badgeFontSize = clamp(
        Math.round(H * 0.027),
        20,
        30
      );

      const badgeH = clamp(
        Math.round(H * 0.052),
        42,
        60
      );

      const badgePadX = Math.round(
        badgeH * 0.42
      );

      const xOffset =
        (1 - badgeT) * -18;

      ctx.font =
        `700 ${badgeFontSize}px "${fonts.sans}"`;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      // Include letter-spacing (tracking) in the width so the pill's
      // padding stays symmetric across the tracked text.
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

      ctx.fillStyle = rgba(
        colors.badgeBg,
        0.97
      );

      roundedRect(
        ctx,
        leftPad + xOffset,
        cursorY,
        badgeW,
        badgeH,
        badgeH / 2
      );

      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      ctx.fillStyle = rgba(
        colors.badgeText,
        1
      );

      drawTrackedText(
        ctx,
        badgeText,
        leftPad + badgePadX + xOffset,
        cursorY + badgeH / 2 + 1,
        badgeTracking,
        'left'
      );

      ctx.restore();

      cursorY += badgeH + rowGap;
    }

    // ── 3. Product name with local scrim ───────────────────────────
    ctx.save();
    ctx.globalAlpha = productT;

    const preferredProductSize = clamp(
      Math.round(H * 0.066),
      48,
      74
    );

    const minimumProductSize = clamp(
      Math.round(H * 0.043),
      32,
      48
    );

    const productFontSize = fitFontSize(
      ctx,
      productName,
      contentMaxW - scrimPadX * 2,
      preferredProductSize,
      minimumProductSize,
      fonts.product,
      fonts.productWeight
    );

    ctx.font =
      `${fonts.productWeight} ` +
      `${productFontSize}px "${fonts.product}"`;

    const fittedProductName = fitText(
      ctx,
      productName,
      contentMaxW - scrimPadX * 2
    );

    const productTextW =
      ctx.measureText(fittedProductName).width;

    const productBoxW =
      productTextW + scrimPadX * 2;

    const productBoxH =
      productFontSize * 1.14 +
      scrimPadY * 2;

    const productXOffset =
      (1 - productT) * -20;

    const productBoxX =
      leftPad + productXOffset;

    const productBoxY =
      cursorY;

    drawLocalScrim(
      ctx,
      productBoxX,
      productBoxY,
      productBoxW,
      productBoxH,
      scrimRadius,
      rgba(colors.scrim, productScrimOpacity),
      scrimShadowBlur
    );

    ctx.fillStyle =
      rgba(colors.textPrimary, 1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.shadowColor =
      'rgba(0,0,0,0.28)';

    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    ctx.fillText(
      fittedProductName,
      productBoxX + scrimPadX,
      productBoxY +
        productBoxH -
        scrimPadY -
        productFontSize * 0.18
    );

    ctx.restore();

    cursorY += productBoxH + rowGap;

    // ── 4. Ratings row with local scrim ────────────────────────────
    // Product-specific — skip in brand mode OR when no rating data
    // was resolved (buildMetaForAd leaves meta.rating null for brand
    // ads and unrated products; the old 4.9 fabricated fallback
    // misrepresents inventory that has no actual score).
    if (!isBrandMode && hasRating) {
    ctx.save();
    ctx.globalAlpha = ratingT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const starFontSize = clamp(
      Math.round(H * 0.042),
      29,
      46
    );

    const scoreFontSize = clamp(
      Math.round(H * 0.032),
      22,
      35
    );

    const reviewFontSize = clamp(
      Math.round(H * 0.028),
      19,
      30
    );

    const scoreText = `${rating.toFixed(1)}/5`;

    // Stars — path-drawn to bypass font glyph-coverage issues.
    // See drawStarRow helper at the bottom of the file.
    const starGap = Math.round(starFontSize * 0.15);
    const starsW  = starFontSize * 5 + starGap * 4;

    ctx.font =
      `700 ${scoreFontSize}px "${fonts.sans}"`;

    const scoreW =
      ctx.measureText(scoreText).width;

    ctx.font =
      `500 ${reviewFontSize}px "${fonts.sans}"`;

    const reviewsW =
      ctx.measureText(reviewCount).width;

    const gapAfterStars = Math.round(
      W * 0.017
    );

    const gapAroundSeparator = Math.round(
      W * 0.014
    );

    const ratingContentW =
      starsW +
      gapAfterStars +
      scoreW +
      gapAroundSeparator * 2 +
      2 +
      reviewsW;

    const ratingBoxW =
      ratingContentW + scrimPadX * 2;

    const ratingBoxH =
      Math.max(
        starFontSize,
        scoreFontSize,
        reviewFontSize
      ) *
        1.18 +
      scrimPadY * 2;

    const ratingXOffset =
      (1 - ratingT) * -20;

    const ratingBoxX =
      leftPad + ratingXOffset;

    const ratingBoxY =
      cursorY;

    drawLocalScrim(
      ctx,
      ratingBoxX,
      ratingBoxY,
      ratingBoxW,
      ratingBoxH,
      scrimRadius,
      rgba(colors.scrim, ratingScrimOpacity),
      scrimShadowBlur
    );

    const centerY =
      ratingBoxY + ratingBoxH / 2 + 1;

    let currentX =
      ratingBoxX + scrimPadX;

    // Stars — path-drawn.
    drawStarRow(
      ctx,
      currentX,
      centerY,
      starFontSize,
      starGap,
      rgba(colors.stars, 1)
    );

    currentX +=
      starsW + gapAfterStars;

    // Rating score
    ctx.font =
      `700 ${scoreFontSize}px "${fonts.sans}"`;

    ctx.fillStyle =
      rgba(colors.textPrimary, 1);

    ctx.fillText(
      scoreText,
      currentX,
      centerY + 1
    );

    currentX +=
      scoreW + gapAroundSeparator;

    // Separator
    const separatorH =
      ratingBoxH * 0.46;

    ctx.strokeStyle =
      rgba(colors.separator, 0.85);

    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.moveTo(
      currentX,
      centerY - separatorH / 2
    );
    ctx.lineTo(
      currentX,
      centerY + separatorH / 2
    );
    ctx.stroke();

    currentX +=
      gapAroundSeparator;

    // Review count
    ctx.font =
      `500 ${reviewFontSize}px "${fonts.sans}"`;

    ctx.fillStyle =
      rgba(colors.textSecondary, 0.98);

    ctx.fillText(
      reviewCount,
      currentX,
      centerY + 1
    );

    ctx.restore();

    cursorY += ratingBoxH + rowGap;
    } // end !isBrandMode && hasRating (ratings row)

    // ── 5. Quote with local scrim ──────────────────────────────────
    if (meta.showQuote !== false && quote) {
      ctx.save();
      ctx.globalAlpha = quoteT;

      const quoteMarkSize = clamp(
        Math.round(H * 0.061),
        44,
        68
      );

      const preferredQuoteSize = clamp(
        Math.round(H * 0.036),
        25,
        40
      );

      const minimumQuoteSize = clamp(
        Math.round(H * 0.026),
        18,
        28
      );

      const quoteMarkGap = Math.round(
        W * 0.010
      );

      const quoteMarkW =
        quoteMarkSize * 0.58;

      const maxQuoteTextW =
        contentMaxW -
        quoteMarkW -
        quoteMarkGap -
        scrimPadX * 2;

      const quoteFontSize = fitFontSize(
        ctx,
        quote,
        maxQuoteTextW,
        preferredQuoteSize,
        minimumQuoteSize,
        fonts.quote,
        `italic ${fonts.quoteWeight}`
      );

      ctx.font =
        `italic ${fonts.quoteWeight} ` +
        `${quoteFontSize}px "${fonts.quote}"`;

      const fittedQuote = fitText(
        ctx,
        quote,
        maxQuoteTextW
      );

      const quoteTextW =
        ctx.measureText(fittedQuote).width;

      const quoteBoxW =
        quoteMarkW +
        quoteMarkGap +
        quoteTextW +
        scrimPadX * 2;

      const quoteBoxH =
        Math.max(
          quoteMarkSize * 0.88,
          quoteFontSize * 1.22
        ) +
        scrimPadY * 2;

      const quoteXOffset =
        (1 - quoteT) * -20;

      const quoteBoxX =
        leftPad + quoteXOffset;

      const quoteBoxY =
        cursorY;

      drawLocalScrim(
        ctx,
        quoteBoxX,
        quoteBoxY,
        quoteBoxW,
        quoteBoxH,
        scrimRadius,
        rgba(colors.scrim, quoteScrimOpacity),
        scrimShadowBlur
      );

      // Decorative quote mark
      ctx.font =
        `700 ${quoteMarkSize}px "${fonts.quote}"`;

      ctx.fillStyle =
        rgba(colors.quoteMark, 0.98);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      ctx.fillText(
        '\u201C',
        quoteBoxX + scrimPadX,
        quoteBoxY +
          quoteBoxH / 2 +
          quoteMarkSize * 0.08
      );

      // Quote text
      const quoteTextX =
        quoteBoxX +
        scrimPadX +
        quoteMarkW +
        quoteMarkGap;

      ctx.font =
        `italic ${fonts.quoteWeight} ` +
        `${quoteFontSize}px "${fonts.quote}"`;

      ctx.fillStyle =
        rgba(colors.textPrimary, 1);

      ctx.shadowColor =
        'rgba(0,0,0,0.24)';

      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 1;

      ctx.fillText(
        fittedQuote,
        quoteTextX,
        quoteBoxY + quoteBoxH / 2 + 1
      );

      ctx.restore();

      cursorY +=
        quoteBoxH +
        Math.round(H * 0.012);

      // ── Reviewer attribution with its own smaller scrim ──────────
      if (
        meta.showReviewer !== false &&
        reviewer
      ) {
        ctx.save();
        ctx.globalAlpha = quoteT;

        const reviewerFontSize = clamp(
          Math.round(H * 0.020),
          14,
          22
        );

        ctx.font =
          `700 ${reviewerFontSize}px "${fonts.sans}"`;

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const reviewerTextW =
          ctx.measureText(reviewer).width;

        const reviewerPadX = Math.round(
          scrimPadX * 0.78
        );

        const reviewerPadY = Math.round(
          scrimPadY * 0.65
        );

        const reviewerBoxW =
          reviewerTextW + reviewerPadX * 2;

        const reviewerBoxH =
          reviewerFontSize * 1.3 +
          reviewerPadY * 2;

        const reviewerBoxX =
          leftPad +
          quoteMarkW +
          quoteMarkGap +
          quoteXOffset;

        const reviewerBoxY =
          cursorY;

        drawLocalScrim(
          ctx,
          reviewerBoxX,
          reviewerBoxY,
          reviewerBoxW,
          reviewerBoxH,
          scrimRadius * 0.75,
          rgba(
            colors.scrim,
            reviewerScrimOpacity
          ),
          scrimShadowBlur * 0.75
        );

        ctx.fillStyle =
          rgba(colors.reviewerText, 1);

        ctx.fillText(
          reviewer,
          reviewerBoxX + reviewerPadX,
          reviewerBoxY +
            reviewerBoxH / 2 +
            1
        );

        ctx.restore();
      }
    }

    // Optional layout debugging.
    if (meta.debugLayout === true) {
      ctx.save();

      ctx.strokeStyle =
        'rgba(255,0,0,0.65)';

      ctx.lineWidth = 2;

      ctx.strokeRect(
        leftPad,
        contentTop,
        contentMaxW,
        H * 0.55
      );

      ctx.restore();
    }
  },
};

// ── Drawing helpers ────────────────────────────────────────────────

function drawLocalScrim(
  ctx,
  x,
  y,
  w,
  h,
  radius,
  fillStyle,
  shadowBlur = 16
) {
  ctx.save();

  ctx.shadowColor =
    'rgba(0,0,0,0.20)';

  ctx.shadowBlur =
    shadowBlur;

  ctx.shadowOffsetY = 4;

  ctx.fillStyle =
    fillStyle;

  roundedRect(
    ctx,
    x,
    y,
    w,
    h,
    radius
  );

  ctx.fill();
  ctx.restore();
}

function roundedRect(
  ctx,
  x,
  y,
  w,
  h,
  radius
) {
  if (w <= 0 || h <= 0) return;

  const r = Math.max(
    0,
    Math.min(radius, w / 2, h / 2)
  );

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);

  ctx.quadraticCurveTo(
    x + w,
    y,
    x + w,
    y + r
  );

  ctx.lineTo(
    x + w,
    y + h - r
  );

  ctx.quadraticCurveTo(
    x + w,
    y + h,
    x + w - r,
    y + h
  );

  ctx.lineTo(x + r, y + h);

  ctx.quadraticCurveTo(
    x,
    y + h,
    x,
    y + h - r
  );

  ctx.lineTo(x, y + r);

  ctx.quadraticCurveTo(
    x,
    y,
    x + r,
    y
  );

  ctx.closePath();
}

function drawTrackedText(
  ctx,
  text,
  x,
  y,
  tracking = 0,
  align = 'center'
) {
  const characters =
    Array.from(String(text || ''));

  let totalWidth = 0;

  for (
    let i = 0;
    i < characters.length;
    i++
  ) {
    totalWidth +=
      ctx.measureText(characters[i]).width;

    if (i < characters.length - 1) {
      totalWidth += tracking;
    }
  }

  let cursorX =
    align === 'left'
      ? x
      : x - totalWidth / 2;

  for (const character of characters) {
    ctx.fillText(
      character,
      cursorX,
      y
    );

    cursorX +=
      ctx.measureText(character).width +
      tracking;
  }
}

function fitFontSize(
  ctx,
  text,
  maxWidth,
  preferredSize,
  minimumSize,
  fontFamily,
  fontWeight = 400
) {
  const value =
    String(text || '');

  let size = preferredSize;

  while (size > minimumSize) {
    ctx.font =
      `${fontWeight} ${size}px "${fontFamily}"`;

    if (
      ctx.measureText(value).width <=
      maxWidth
    ) {
      return size;
    }

    size -= 1;
  }

  return minimumSize;
}

function fitText(
  ctx,
  text,
  maxWidth
) {
  const value =
    String(text || '').trim();

  if (
    ctx.measureText(value).width <=
    maxWidth
  ) {
    return value;
  }

  let output = value;

  while (
    output.length > 3 &&
    ctx.measureText(`${output}\u2026`).width >
      maxWidth
  ) {
    output =
      output.slice(0, -1);
  }

  return `${output.trim()}\u2026`;
}

function normalizeQuote(value) {
  return String(value || '')
    .trim()
    .replace(/^[\u201C\u201D"'\u2018\u2019]+/, '')
    .replace(/[\u201C\u201D"'\u2018\u2019]+$/, '')
    .trim();
}

// Path-drawn 5-point star row — bypasses font glyph-coverage issues
// that produce tofu boxes when brand fonts lack U+2605. Matches the
// helper in canonical.script.js / top_scrim_editorial.script.js.
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
