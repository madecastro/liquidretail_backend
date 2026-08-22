// U Beauty — canvas overlay script.
//
// Reference template for the four MANDATORY overlay elements:
//   1. PRODUCT NAME  — meta.productName (falls back to meta.headline)
//   2. REVIEW BAR    — 5-star rating + reviewCount
//   3. QUOTE/DESC    — meta.quote if present, else meta.productDescription,
//                       else meta.headline
//   4. CTA           — meta.cta on a salient pill
//
// Rules demonstrated:
//   - SAFE margins (6% of min(W,H)) — no text bleeds to the edges
//   - CONTRAST — every text zone sits on a scrim or solid card so
//     legibility is independent of the base plate
//   - TEXT WRAP — long strings wrap to 2-3 lines via ctx.measureText
//   - SALIENCE — every mandatory element is visible for most of the
//     frame range, not just briefly
//
// Paste into Brand.styleScript via the Style card's Canvas Script tab.

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const SAFE = Math.round(Math.min(W, H) * 0.06);

    // 1. Base plate.
    ctx.drawImage(plate, 0, 0, W, H);

    // Timing (frames):
    //   0-10   plate + scrims settle
    //   10-30  product name + reviews fade in
    //   30-55  quote/description slides in
    //   55-80  CTA scales in with overshoot
    //   80+    hold with subtle CTA pulse
    const topT   = h.eoc(h.t01(frameIndex, 10, 20));
    const midT   = h.eoc(h.t01(frameIndex, 30, 25));
    const ctaT   = h.eob(h.t01(frameIndex, 55, 25));
    const pulseT = Math.sin(((frameIndex - 80) / 24) * Math.PI * 1.1);

    // 2. Top scrim — dark gradient behind the product name + review bar
    //    zone. Ensures contrast regardless of what the plate shows.
    const topZoneH = Math.round(H * 0.28);
    const topGrad = ctx.createLinearGradient(0, 0, 0, topZoneH);
    topGrad.addColorStop(0, 'rgba(10,10,10,0.78)');
    topGrad.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, topZoneH);

    // 3. Bottom card — solid dark card that holds the quote + CTA. Full
    //    contrast guarantee for the two most conversion-critical zones.
    const bottomCardTop = Math.round(H * 0.56);
    const bottomGrad = ctx.createLinearGradient(0, bottomCardTop, 0, H);
    bottomGrad.addColorStop(0, 'rgba(10,10,10,0)');
    bottomGrad.addColorStop(0.35, 'rgba(10,10,10,0.85)');
    bottomGrad.addColorStop(1, 'rgba(10,10,10,0.96)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(0, bottomCardTop, W, H - bottomCardTop);

    // ── MANDATORY #1 — Product name (upper zone) ───────────────────
    const productName = String(meta.productName || meta.headline || 'Signature Product').trim();
    ctx.save();
    ctx.globalAlpha = topT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 46px "Inter"';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 12;
    const pnLines = wrapLines(ctx, productName, W - SAFE * 2, 2);
    const pnLineH = 52;
    const pnYCenter = SAFE + 30 + ((pnLines.length - 1) * pnLineH) / 2;
    for (let i = 0; i < pnLines.length; i++) {
      ctx.fillText(pnLines[i], W / 2, pnYCenter + (i - (pnLines.length - 1) / 2) * pnLineH);
    }
    ctx.restore();

    // ── MANDATORY #2 — Review bar (5 stars + count) ────────────────
    const rating = clampNumber(meta.rating, 0, 5);
    const reviewCount = Number.isFinite(meta.reviewCount) ? meta.reviewCount : null;
    const reviewRowY = SAFE + 30 + pnLines.length * pnLineH + 10;
    ctx.save();
    ctx.globalAlpha = topT;
    drawReviewBar(ctx, W / 2, reviewRowY, rating, reviewCount, meta.reviewsText);
    ctx.restore();

    // ── MANDATORY #3 — Quote OR description (priority) ─────────────
    // Priority: quote > productDescription > headline.
    const midText = pickMidText(meta);
    ctx.save();
    ctx.globalAlpha = midT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const isQuote = !!(meta.quote && String(meta.quote).trim());
    ctx.font = isQuote ? 'italic 500 32px "Inter"' : '500 30px "Inter"';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10;
    const midLines = wrapLines(ctx, isQuote ? `\u201C${midText}\u201D` : midText, W - SAFE * 2, 3);
    const midLineH = 42;
    const midCenterY = Math.round(H * 0.66);
    const midYOffset = (1 - midT) * 20;
    for (let i = 0; i < midLines.length; i++) {
      const y = midCenterY + (i - (midLines.length - 1) / 2) * midLineH + midYOffset;
      ctx.fillText(midLines[i], W / 2, y);
    }
    ctx.restore();

    // ── MANDATORY #4 — CTA pill (bottom, hero scale) ───────────────
    const ctaText = String(meta.cta || 'SHOP NOW').toUpperCase();
    const pillMaxW = W - SAFE * 2;
    const pillPad = 42;
    ctx.font = '700 30px "Montserrat"';
    const ctaMeasuredW = ctx.measureText(ctaText).width;
    const pillW = Math.min(pillMaxW, Math.max(280, Math.round(ctaMeasuredW + pillPad * 2)));
    const pillH = 82;
    const pillX = (W - pillW) / 2;
    const pillY = H - SAFE - pillH;
    const holdPulse = frameIndex > 80 ? (1 + 0.02 * pulseT) : 1;
    const s = ctaT * holdPulse;

    ctx.save();
    ctx.translate(pillX + pillW / 2, pillY + pillH / 2);
    ctx.scale(s, s);
    ctx.translate(-(pillX + pillW / 2), -(pillY + pillH / 2));

    // Pill background — soft warm white for maximum contrast against
    // the dark card + dark text.
    ctx.fillStyle = 'rgba(252,250,246,0.98)';
    roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fill();

    // CTA text — deep black on cream.
    ctx.fillStyle = 'rgba(10,10,10,1)';
    ctx.font = '700 30px "Montserrat"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ctaText, pillX + pillW / 2, pillY + pillH / 2 + 1);

    ctx.restore();
  }
};

// ── Local drawing helpers ──────────────────────────────────────────

function roundedRect(ctx, x, y, w, h, r) {
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

// Wrap `text` into up to `maxLines` lines whose rendered width stays
// under `maxWidth`. Uses the caller's current ctx.font — call this
// AFTER setting the font that will render the text.
function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    const width = ctx.measureText(candidate).width;
    if (width > maxWidth && current) {
      lines.push(current);
      current = w;
      if (lines.length === maxLines - 1) {
        // Last available line — pack the rest, truncate with ellipsis
        // if it still overflows.
        const rest = words.slice(words.indexOf(w)).join(' ');
        let packed = rest;
        while (ctx.measureText(packed + '\u2026').width > maxWidth && packed.length > 3) {
          packed = packed.slice(0, -1);
        }
        lines.push(ctx.measureText(rest).width > maxWidth ? packed.trimEnd() + '\u2026' : rest);
        return lines;
      }
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function pickMidText(meta) {
  if (meta.quote && String(meta.quote).trim())              return String(meta.quote).trim();
  if (meta.productDescription && String(meta.productDescription).trim())
                                                             return String(meta.productDescription).trim();
  if (meta.headline && String(meta.headline).trim())         return String(meta.headline).trim();
  return 'Made better. Every detail intentional.';
}

// Draw a 5-star bar centered at (cx, cy) with `rating` filled stars,
// followed by "(N reviews)". When rating is null, falls back to just
// rendering the pre-formatted reviewsText.
function drawReviewBar(ctx, cx, cy, rating, reviewCount, reviewsText) {
  const GOLD = 'rgba(255,196,64,1)';
  const DIM  = 'rgba(255,255,255,0.35)';
  const starSize = 18;
  const gap = 6;

  if (rating == null) {
    // No structured rating — render a simple text row.
    ctx.font = '600 22px "Inter"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.fillText(String(reviewsText || ''), cx, cy);
    return;
  }

  // 5 stars centered, followed by "(N reviews)".
  const starsTotalW = starSize * 5 + gap * 4;
  const label = reviewCount != null ? `  (${reviewCount})` : '';
  ctx.font = '600 22px "Inter"';
  const labelW = label ? ctx.measureText(label).width : 0;
  const rowW = starsTotalW + labelW;
  const startX = cx - rowW / 2;

  for (let i = 0; i < 5; i++) {
    const x = startX + i * (starSize + gap) + starSize / 2;
    const filled = rating >= i + 1;
    const half   = !filled && rating >= i + 0.5;
    drawStar(ctx, x, cy, starSize / 2, filled ? GOLD : (half ? GOLD : DIM), half ? 0.5 : 1);
  }

  if (label) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.fillText(label, startX + starsTotalW, cy);
  }
}

function drawStar(ctx, cx, cy, r, fill, halfFillFraction = 1) {
  ctx.save();
  ctx.beginPath();
  const spikes = 5;
  const step = Math.PI / spikes;
  const inner = r * 0.45;
  let rot = -Math.PI / 2;
  ctx.moveTo(cx + Math.cos(rot) * r, cy + Math.sin(rot) * r);
  for (let i = 0; i < spikes; i++) {
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * r, cy + Math.sin(rot) * r);
  }
  ctx.closePath();
  if (halfFillFraction === 1) {
    ctx.fillStyle = fill;
    ctx.fill();
  } else {
    // Half-star: clip to left half, fill, then stroke the whole outline.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = fill;
    ctx.fillRect(cx - r, cy - r, r * 2 * halfFillFraction, r * 2);
    ctx.restore();
    ctx.strokeStyle = fill;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}
