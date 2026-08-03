// Feed (4:5 / 1:1) canonical — bottom-anchored conversion composition.
//
// Content pinned to the bottom half of the frame. Each text block sits
// on its own rounded local scrim rather than a single large gradient
// scrim across the bottom — the top half breathes through cleanly.
// Element inventory preserved from the previous gradient-scrim design:
// top brand pill, badge, product title, rating row + bar, quote,
// reviewer, delivery line, CTA button. Divider dropped (local scrims
// separate elements visually).
//
// This script is DB-editable via SystemConfig.canonicalScript. When
// the DB copy is empty, brandScriptExecutor loads THIS file as the
// fallback. All three canonicals (feed / vertical / landscape) share
// the same drawLocalScrim helper + per-element opacity theme keys.
//
// Theme keys used (all optional — sane defaults for each):
//   brandName, textPrimary, textSecondary, textMuted, accentGold /
//   starColor, badgeBgColor, badgeTextColor, ctaBgColor, ctaTextColor,
//   ctaStrokeColor, ratingBarStart/Mid/End, dividerColor /
//   separatorColor, brandPillStroke, brandPillText, quoteMarkColor,
//   scrimColor, sansFontFamily, serifFontFamily, productFontFamily,
//   productFontWeight, quoteFontFamily,
//   productScrimOpacity, ratingScrimOpacity, quoteScrimOpacity,
//   reviewerScrimOpacity, deliveryScrimOpacity

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const FPS = 24;

    // ── Base frame ────────────────────────────────────────────────
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Helpers / fallback easing ────────────────────────────────
    const clamp = (v, min = 0, max = 1) =>
      h && h.clamp ? h.clamp(v, min, max) : Math.max(min, Math.min(max, v));

    const t01 = (f, start, dur) =>
      h && h.t01 ? h.t01(f, start, dur) : clamp((f - start) / dur);

    const eoc = (t) =>
      h && h.eoc ? h.eoc(t) : 1 - Math.pow(1 - clamp(t), 3);

    const eob = (t) => {
      if (h && h.eob) return h.eob(t);
      t = clamp(t);
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };

    const rgba = (rgb, a = 1) =>
      h && h.rgba ? h.rgba(rgb, a) : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

    // ── Theme / brand-driven styling ─────────────────────────────
    const theme = meta.theme || {};
    const layout = meta.layout || {};

    const colors = {
      textPrimary:   theme.textPrimary   || [250, 244, 236],
      textSecondary: theme.textSecondary || [224, 214, 202],
      textMuted:     theme.textMuted     || [201, 189, 175],
      accentGold:
        theme.accentGold || theme.starColor || theme.accentColor ||
        [214, 171, 83],
      badgeBg:   theme.badgeBgColor   || [194, 209, 173],
      badgeText: theme.badgeTextColor || [66, 94, 54],
      ctaBg:     theme.ctaBgColor     || [70, 120, 62],
      ctaText:   theme.ctaTextColor   || [255, 248, 239],
      ctaStroke: theme.ctaStrokeColor || [225, 222, 209],
      ratingBarStart: theme.ratingBarStart || [201, 128, 130],
      ratingBarMid:   theme.ratingBarMid   || [216, 169, 81],
      ratingBarEnd:   theme.ratingBarEnd   || [120, 144, 95],
      separator:
        theme.separatorColor || theme.dividerColor || [213, 199, 183],
      brandPillStroke: theme.brandPillStroke || [255, 247, 239],
      brandPillText:   theme.brandPillText   || [255, 247, 239],
      quoteMark:
        theme.quoteMarkColor || theme.badgeBgColor || [194, 209, 173],
      scrim: theme.scrimColor || [12, 9, 6]
    };

    const fonts = {
      sans:  theme.sansFontFamily || 'Inter',
      serif: theme.serifFontFamily || 'Lora',
      productFamily: theme.productFontFamily || 'Cormorant',
      productWeight: theme.productFontWeight || 600,
      quoteFamily:   theme.quoteFontFamily || theme.serifFontFamily || 'Lora'
    };

    const productScrimOpacity  = theme.productScrimOpacity  ?? 0.68;
    const ratingScrimOpacity   = theme.ratingScrimOpacity   ?? 0.72;
    const quoteScrimOpacity    = theme.quoteScrimOpacity    ?? 0.70;
    const reviewerScrimOpacity = theme.reviewerScrimOpacity ?? 0.62;
    const deliveryScrimOpacity = theme.deliveryScrimOpacity ?? 0.66;

    // ── Dynamic content ───────────────────────────────────────────
    const brandName    = meta.brandName || 'Brand';
    // Brand vs product endcard dispatch. Brand campaigns (no
    // productId) suppress the product-specific chrome — badge pill,
    // star rating + review bar, ships-free delivery line — and
    // substitute Brand.tagline into the primary-text slot so the
    // composition reads as identity rather than a product sale.
    // Quote / reviewer / CTA / top brand pill are shared across modes.
    const endcardMode = meta.endcardMode === 'brand' ? 'brand' : 'product';
    const isBrandMode = endcardMode === 'brand';

    const badgeText    = (meta.badgeText || 'Customer Favorite').toUpperCase();
    const primaryLine  = isBrandMode
      ? (meta.brandTagline || meta.headline || 'A brand you can trust')
      : (meta.productName || 'Signature Product');
    const productName  = primaryLine;
    const hasRating    = Number.isFinite(Number(meta.rating)) && Number(meta.rating) > 0;
    const rating       = Number(meta.rating ?? 4.9);
    const reviewCount  = meta.reviewCount || '327 reviews';
    const quote        = normalizeQuote(meta.quote || 'Highly rated for comfort, durability, and standout style.');
    // No fabricated purchase persona. Absent reviewer → no byline rendered.
    const reviewer     = meta.reviewer || '';
    const deliveryLine = isBrandMode
      ? (meta.brandWebsiteUrl
          ? String(meta.brandWebsiteUrl).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
          : null)
      : (meta.deliveryLine || 'Ships free — arrives 2-3 days');
    const ctaText      = (meta.ctaText || meta.cta || (isBrandMode ? 'Learn More' : 'Shop Now')).toUpperCase();

    const isVertical = H > W;

    // ── Safe areas + layout knobs ─────────────────────────────────
    const topSafe    = isVertical ? Math.round(H * 0.10) : Math.round(H * 0.06);
    const bottomSafe = isVertical ? Math.round(H * 0.10) : Math.round(H * 0.06);
    const rightSafe  = isVertical ? Math.round(W * 0.10) : Math.round(W * 0.06);
    const leftPad    = Math.round(W * (layout.leftPosition ?? 0.065));
    const contentW   = W - leftPad * 2 - rightSafe;

    const rowGap        = Math.round(H * (layout.rowGap        ?? 0.020));
    const scrimRadius   = Math.round(H * (layout.scrimRadius   ?? 0.014));
    const scrimPadX     = Math.round(W * (layout.scrimPadX     ?? 0.020));
    const scrimPadY     = Math.round(H * (layout.scrimPadY     ?? 0.010));
    const scrimShadowBlur = Math.round(H * (layout.scrimShadowBlur ?? 0.014));

    // ── Timing ────────────────────────────────────────────────────
    const brandT  = eoc(t01(frameIndex, 8, 16));
    const badgeT  = eoc(t01(frameIndex, 16, 16));
    const titleT  = eoc(t01(frameIndex, 22, 20));
    const ratingT = eoc(t01(frameIndex, 30, 18));
    const quoteT  = eoc(t01(frameIndex, 38, 20));
    const ctaT    = eob(t01(frameIndex, 48, 20));
    const pulseT  = frameIndex > 72
      ? 1 + 0.018 * Math.sin(((frameIndex - 72) / FPS) * Math.PI * 1.1)
      : 1;

    // ── 1. Top brand pill (outlined) ──────────────────────────────
    ctx.save();
    ctx.globalAlpha = brandT;

    const brandFontSize = isVertical ? 30 : 22;
    ctx.font = `700 ${brandFontSize}px "${fonts.sans}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const brandText = brandName.toUpperCase();
    const brandTextW = ctx.measureText(brandText).width;
    const brandPillW = brandTextW + 70;
    const brandPillH = isVertical ? 62 : 48;
    const brandPillX = (W - brandPillW) / 2;
    const brandPillY = topSafe;
    const brandYOffset = (1 - brandT) * 14;

    ctx.strokeStyle = rgba(colors.brandPillStroke, 0.94);
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 12;
    roundedRect(ctx, brandPillX, brandPillY + brandYOffset, brandPillW, brandPillH, brandPillH / 2);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba(colors.brandPillText, 1);
    drawTrackedText(ctx, brandText, W / 2, brandPillY + brandPillH / 2 + brandYOffset + 1, 2.2);
    ctx.restore();

    // ── Bottom flow — cursor starts inside the (former) bottom-scrim zone
    const blockX = leftPad;
    let cursor = Math.round(H * 0.54);

    // ── 2. Badge pill ────────────────────────────────────────────
    // Product-specific — "Customer Favorite" / "Bestseller" reads wrong
    // on a brand identity ad. Skip entirely in brand mode; cursor stays
    // put so the product-title slot moves up to fill the freed space.
    if (!isBrandMode) {
    ctx.save();
    ctx.globalAlpha = badgeT;
    ctx.font = `700 ${isVertical ? 21 : 17}px "${fonts.sans}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Include letter-spacing in the width so the pill's padding stays
    // symmetric across the tracked text (drawTrackedText spreads chars
    // by `tracking` px beyond the measureText result).
    const badgeTracking = 0.8;
    const badgeCharCount = Array.from(badgeText).length;
    const badgeTrackedW =
      ctx.measureText(badgeText).width +
      Math.max(0, badgeCharCount - 1) * badgeTracking;
    const badgeW = badgeTrackedW + 34;
    const badgeH = 40;
    const badgeYOffset = (1 - badgeT) * 10;

    ctx.shadowColor = 'rgba(0,0,0,0.20)';
    ctx.shadowBlur = scrimShadowBlur;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = rgba(colors.badgeBg, 0.96);
    roundedRect(ctx, blockX, cursor + badgeYOffset, badgeW, badgeH, badgeH / 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = rgba(colors.badgeText, 1);
    drawTrackedText(ctx, badgeText, blockX + 18, cursor + badgeH / 2 + badgeYOffset + 1, badgeTracking, 'left');
    ctx.restore();

    cursor += badgeH + rowGap;
    } // end !isBrandMode (badge)

    // ── 3. Product title (2-line wrap) with local scrim ──────────
    ctx.save();
    ctx.globalAlpha = titleT;

    const productSize = isVertical ? 44 : 32;
    ctx.font = `${fonts.productWeight} ${productSize}px "${fonts.productFamily}"`;
    const titleWrapW = contentW - scrimPadX * 2;
    const titleLines = wrapLines(ctx, productName, titleWrapW, 2);
    const titleLineH = Math.round(productSize * 1.1);
    const titleYOffset = (1 - titleT) * 12;

    let widestTitleLine = 0;
    for (const line of titleLines) {
      const w = ctx.measureText(line).width;
      if (w > widestTitleLine) widestTitleLine = w;
    }

    const titleBoxW = widestTitleLine + scrimPadX * 2;
    const titleBoxH = titleLines.length * titleLineH + scrimPadY * 2;
    const titleBoxX = blockX;
    const titleBoxY = cursor + titleYOffset;

    drawLocalScrim(
      ctx, titleBoxX, titleBoxY, titleBoxW, titleBoxH,
      scrimRadius, rgba(colors.scrim, productScrimOpacity), scrimShadowBlur
    );

    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.24)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    for (let i = 0; i < titleLines.length; i++) {
      ctx.fillText(
        titleLines[i],
        titleBoxX + scrimPadX,
        titleBoxY + scrimPadY + i * titleLineH
      );
    }
    ctx.restore();
    cursor += titleBoxH + rowGap;

    // ── 4. Rating (stars + score + count + bar) — one scrim ──────
    // Product-specific proof anchor. Skip when brand mode (no product
    // to rate) or when no rating data was resolved by buildMetaForAd —
    // the old 4.9 fabricated fallback misrepresents unrated inventory.
    if (!isBrandMode && hasRating) {
    ctx.save();
    ctx.globalAlpha = ratingT;

    const starFontSize   = isVertical ? 28 : 22;
    const scoreFontSize  = isVertical ? 22 : 18;
    const reviewFontSize = isVertical ? 19 : 16;

    // Stars are drawn as canvas paths (not text) so brand fonts that
    // lack the U+2605 glyph don't render tofu boxes. See drawStarRow
    // helper at file bottom. `starsW` is precomputed the same way the
    // helper renders so downstream layout math is consistent.
    const starGap  = Math.round(starFontSize * 0.35);
    const starsW   = starFontSize * 5 + starGap * 4;

    ctx.font = `700 ${scoreFontSize}px "${fonts.sans}"`;
    const scoreText = `${rating.toFixed(1)}/5`;
    const scoreW = ctx.measureText(scoreText).width;
    ctx.font = `500 ${reviewFontSize}px "${fonts.sans}"`;
    const countText = `\u2022  ${reviewCount}`;
    const countW = ctx.measureText(countText).width;

    // Rating scrim height = stars row + gap + bar height
    const gapScoreX  = 16;
    const gapCountX  = 16;
    const barHeight  = 10;
    const gapToBar   = Math.round(H * 0.010);
    const ratingContentW =
      starsW + gapScoreX + scoreW + gapCountX + countW;

    // Bar width — 62% of contentW clamped to fit under the row
    const barMinW = Math.min(contentW, Math.round(W * 0.62));
    const ratingRowInnerW = Math.max(ratingContentW, barMinW - scrimPadX * 2);

    const ratingBoxW = ratingRowInnerW + scrimPadX * 2;
    const ratingBoxH =
      Math.max(starFontSize, scoreFontSize, reviewFontSize) * 1.15 +
      gapToBar + barHeight + scrimPadY * 2;

    const ratingYOffset = (1 - ratingT) * 10;
    const ratingBoxX = blockX;
    const ratingBoxY = cursor + ratingYOffset;

    drawLocalScrim(
      ctx, ratingBoxX, ratingBoxY, ratingBoxW, ratingBoxH,
      scrimRadius, rgba(colors.scrim, ratingScrimOpacity), scrimShadowBlur
    );

    const rowMidY = ratingBoxY + scrimPadY + starFontSize * 0.6;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // Stars — path-drawn to bypass font glyph-coverage issues.
    drawStarRow(
      ctx,
      ratingBoxX + scrimPadX,
      rowMidY,
      starFontSize,
      starGap,
      rgba(colors.accentGold, 1)
    );
    // Score
    ctx.font = `700 ${scoreFontSize}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textPrimary, 1);
    ctx.fillText(scoreText, ratingBoxX + scrimPadX + starsW + gapScoreX, rowMidY + 1);
    // Review count
    ctx.font = `500 ${reviewFontSize}px "${fonts.sans}"`;
    ctx.fillStyle = rgba(colors.textSecondary, 0.96);
    ctx.fillText(
      countText,
      ratingBoxX + scrimPadX + starsW + gapScoreX + scoreW + gapCountX,
      rowMidY + 1
    );

    // Rating bar underneath
    const barY = ratingBoxY + scrimPadY + starFontSize * 1.15 + gapToBar;
    const barX = ratingBoxX + scrimPadX;
    const barW = ratingBoxW - scrimPadX * 2;

    ctx.fillStyle   = 'rgba(255,255,255,0.18)';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    roundedRect(ctx, barX, barY, barW, barHeight, barHeight / 2);
    ctx.fill();
    ctx.stroke();

    const fillW = Math.max(0, Math.min(barW, barW * (rating / 5) * ratingT));
    const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    barGrad.addColorStop(0,    rgba(colors.ratingBarStart, 1));
    barGrad.addColorStop(0.55, rgba(colors.ratingBarMid, 1));
    barGrad.addColorStop(1,    rgba(colors.ratingBarEnd, 1));
    ctx.fillStyle = barGrad;
    roundedRect(ctx, barX, barY, fillW, barHeight, barHeight / 2);
    ctx.fill();

    ctx.restore();
    cursor += ratingBoxH + rowGap;
    } // end !isBrandMode && hasRating (rating bar)

    // ── 5. Quote (2-line fixed) with local scrim ─────────────────
    const QUOTE_LINES_FIXED = 2;
    const quoteFontSize = isVertical ? 26 : 20;
    const quoteLineH = Math.round(quoteFontSize * 1.22);

    ctx.save();
    ctx.globalAlpha = quoteT;
    ctx.font = `italic 400 ${quoteFontSize}px "${fonts.quoteFamily}"`;
    const quoteWrapW = contentW - scrimPadX * 2;
    const quoteLines = wrapLines(ctx, `\u201C${quote}\u201D`, quoteWrapW, QUOTE_LINES_FIXED);

    // Reserve fixed block height so downstream layout doesn't shift
    const quoteBoxW = quoteWrapW + scrimPadX * 2;
    const quoteBoxH = QUOTE_LINES_FIXED * quoteLineH + scrimPadY * 2;
    const quoteYOffset = (1 - quoteT) * 10;
    const quoteBoxX = blockX;
    const quoteBoxY = cursor + quoteYOffset;

    drawLocalScrim(
      ctx, quoteBoxX, quoteBoxY, quoteBoxW, quoteBoxH,
      scrimRadius, rgba(colors.scrim, quoteScrimOpacity), scrimShadowBlur
    );

    ctx.fillStyle = rgba(colors.textPrimary, 0.98);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 10;

    for (let i = 0; i < quoteLines.length; i++) {
      ctx.fillText(
        quoteLines[i],
        quoteBoxX + scrimPadX,
        quoteBoxY + scrimPadY + i * quoteLineH
      );
    }
    ctx.restore();
    cursor += quoteBoxH + Math.round(H * 0.008);

    // ── 6. Reviewer attribution — smaller nested scrim ──────────
    // Skip entirely when no real byline was provided (no 'Verified customer').
    if (reviewer) {
    ctx.save();
    ctx.globalAlpha = quoteT;
    const reviewerFontSize = isVertical ? 18 : 15;
    ctx.font = `500 ${reviewerFontSize}px "${fonts.sans}"`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const reviewerLabel = `\u2014 ${reviewer}`;
    const reviewerTextW = ctx.measureText(reviewerLabel).width;
    const reviewerPadX = Math.round(scrimPadX * 0.78);
    const reviewerPadY = Math.round(scrimPadY * 0.65);
    const reviewerBoxW = reviewerTextW + reviewerPadX * 2;
    const reviewerBoxH = reviewerFontSize * 1.4 + reviewerPadY * 2;
    const reviewerBoxX = blockX;
    const reviewerBoxY = cursor;

    drawLocalScrim(
      ctx, reviewerBoxX, reviewerBoxY, reviewerBoxW, reviewerBoxH,
      scrimRadius * 0.75, rgba(colors.scrim, reviewerScrimOpacity), scrimShadowBlur * 0.75
    );

    ctx.fillStyle = rgba(colors.textSecondary, 0.94);
    ctx.fillText(reviewerLabel, reviewerBoxX + reviewerPadX, reviewerBoxY + reviewerBoxH / 2 + 1);
    ctx.restore();
    cursor += reviewerBoxH + rowGap;
    }

    // ── 7. Delivery / brand-website line ─────────────────────────
    // Product mode: "Ships free — arrives 2-3 days" with a truck icon.
    // Brand mode: compact brand website URL (protocol/www stripped) as
    // a subtle footer, no truck icon. When the brand has no website
    // configured deliveryLine is null and the row is skipped.
    // CTA sizing is computed regardless so the button always ships.
    const ctaW = Math.min(Math.round(W * 0.42), 340);
    const ctaH = isVertical ? 76 : 56;
    const ctaX = W - rightSafe - ctaW;

    const showDeliveryRow = !!deliveryLine;
    let deliveryRowH = ctaH;
    if (showDeliveryRow) {
      ctx.save();
      ctx.font = `500 ${isVertical ? 18 : 15}px "${fonts.sans}"`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const deliveryFontSize = isVertical ? 18 : 15;
      const iconSize = isBrandMode ? 0 : (isVertical ? 18 : 14);
      const iconGap  = isBrandMode ? 0 : 8;
      const deliveryFit = fitText(ctx, deliveryLine, contentW - scrimPadX * 2 - iconSize * 2 - iconGap);
      const deliveryTextW = ctx.measureText(deliveryFit).width;

      const deliveryBoxW = iconSize * 2 + iconGap + deliveryTextW + scrimPadX * 2;
      const deliveryBoxH = Math.max(iconSize, deliveryFontSize) * 1.3 + scrimPadY * 2;
      deliveryRowH = Math.max(deliveryBoxH, ctaH);

      const deliveryBoxY = cursor + Math.max(0, (deliveryBoxH < ctaH ? (ctaH - deliveryBoxH) / 2 : 0));
      const deliveryBoxX = blockX;
      const deliveryMidY = deliveryBoxY + deliveryBoxH / 2;

      const cappedDeliveryW = Math.min(deliveryBoxW, ctaX - deliveryBoxX - 20);

      drawLocalScrim(
        ctx, deliveryBoxX, deliveryBoxY, cappedDeliveryW, deliveryBoxH,
        scrimRadius * 0.85, rgba(colors.scrim, deliveryScrimOpacity), scrimShadowBlur * 0.85
      );

      if (!isBrandMode) {
        drawTruckIcon(
          ctx,
          deliveryBoxX + scrimPadX,
          deliveryMidY - iconSize / 2,
          iconSize,
          rgba(colors.textSecondary, 0.92)
        );
      }
      ctx.fillStyle = rgba(colors.textSecondary, 0.96);
      ctx.fillText(
        deliveryFit,
        deliveryBoxX + scrimPadX + iconSize * 2 + iconGap,
        deliveryMidY
      );
      ctx.restore();
    }
    const ctaY = cursor + Math.max(0, (ctaH - deliveryRowH) / 2);

    // ── 8. CTA button (right-aligned, solid pill) ─────────────────
    const ctaScale = ctaT * pulseT;
    ctx.save();
    ctx.translate(ctaX + ctaW / 2, ctaY + ctaH / 2);
    ctx.scale(ctaScale, ctaScale);
    ctx.translate(-(ctaX + ctaW / 2), -(ctaY + ctaH / 2));

    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 6;

    ctx.fillStyle = rgba(colors.ctaBg, 0.96);
    ctx.strokeStyle = rgba(colors.ctaStroke, 0.72);
    ctx.lineWidth = 1.4;
    roundedRect(ctx, ctaX, ctaY, ctaW, ctaH, ctaH / 2);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = rgba(colors.ctaText, 1);
    ctx.font = `800 ${isVertical ? 22 : 18}px "${fonts.sans}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawTrackedText(ctx, ctaText, ctaX + ctaW / 2, ctaY + ctaH / 2 + 1, 1.2);
    ctx.restore();

    if (meta.debugLayout === true) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,0,0.65)';
      ctx.lineWidth = 2;
      ctx.strokeRect(blockX, Math.round(H * 0.54), contentW, H - Math.round(H * 0.54) - bottomSafe);
      ctx.restore();
    }
  }
};

// ── Helpers ───────────────────────────────────────────────────────

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

function roundedRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
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
  const chars = Array.from(String(text || ''));
  let total = 0;
  for (let i = 0; i < chars.length; i++) {
    total += ctx.measureText(chars[i]).width;
    if (i < chars.length - 1) total += tracking;
  }
  let cursor = align === 'left' ? x : x - total / 2;
  for (const ch of chars) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + tracking;
  }
}

function fitText(ctx, text, maxWidth) {
  const str = String(text || '').trim();
  if (ctx.measureText(str).width <= maxWidth) return str;
  const words = str.split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ') + '\u2026';
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  let out = words[0] || str;
  while (out.length > 3 && ctx.measureText(out + '\u2026').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '\u2026';
}

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

function drawTruckIcon(ctx, x, y, s, stroke) {
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  ctx.beginPath();
  ctx.rect(x, y + s * 0.25, s * 1.15, s * 0.55);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + s * 1.15, y + s * 0.80);
  ctx.lineTo(x + s * 1.15, y + s * 0.42);
  ctx.lineTo(x + s * 1.55, y + s * 0.42);
  ctx.lineTo(x + s * 1.82, y + s * 0.62);
  ctx.lineTo(x + s * 1.82, y + s * 0.80);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s * 0.38, y + s * 0.95, s * 0.14, 0, Math.PI * 2);
  ctx.arc(x + s * 1.45, y + s * 0.95, s * 0.14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function normalizeQuote(value) {
  return String(value || '')
    .trim()
    .replace(/^[\u201C\u201D"'\u2018\u2019]+/, '')
    .replace(/[\u201C\u201D"'\u2018\u2019]+$/, '')
    .trim();
}

// Draw a row of 5 filled 5-point stars using canvas paths instead of
// the U+2605 glyph. Brand fonts (Bebas Neue, Antonio, Great Vibes,
// etc.) frequently lack the star glyph and produce tofu boxes — this
// bypasses font glyph-coverage entirely.
//   x, yCenter — top-left of the row, vertically centered around yCenter
//   size       — outer diameter of each star (matches previous font-px size)
//   gap        — horizontal gap between adjacent stars
//   fillStyle  — canvas fill string
function drawStarRow(ctx, x, yCenter, size, gap, fillStyle) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  const outerR = size / 2;
  const innerR = outerR * 0.4;                  // 5-point-star ratio ~0.38
  for (let s = 0; s < 5; s++) {
    const cx = x + s * (size + gap) + outerR;
    const cy = yCenter;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = -Math.PI / 2 + i * (Math.PI / 5); // start at top, 36° steps
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
