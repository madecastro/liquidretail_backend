// Canonical DR v1 — vertical (9:16) overlay for Reels / Shorts / Stories.
//
// Two timed phases over the 8-second base video plate:
//
//   0:00–0:03  HOOK      hook headline over scrim, fade in @ 0-0.4s,
//                        fade out @ 2.6-3s
//   0:03–0:06  PROOF     punchy quote snippet + attribution, fade in
//                        @ 3-3.4s, fade out @ 5.6-6s
//   0:06–0:08  (open)    no overlay — the base video's closing beat
//                        (the Ken Burns zoom-out product reveal) runs
//                        clean. The full-frame END CARD phase that
//                        used to occupy this window was removed
//                        deliberately; when an endcard is desired,
//                        prompt it in a custom titling script —
//                        brandScriptExecutor still supplies
//                        meta.productOnlyImagePath / meta.brandLogoPath
//                        for scripts that want to draw one.
//
// meta fields consumed:
//   headline               (hook copy)
//   quoteSnippet | quote   (proof copy — snippet preferred, ≤50 chars)
//   reviewer               (attribution below the quote)
//   theme                  (brand colors + font families)
//
// Assumes 24 fps plates from the video pipeline (frames 0-191 = 8s).
// Timing calculations use `frameIndex / 24` for time-in-seconds so
// higher/lower fps sources still hit the intended second marks.

const FPS = 24;

module.exports = {
  renderFrame: async (frameIndex, ctx, plate, meta, h) => {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const t = frameIndex / FPS;

    const clamp = h?.clamp || ((v, a = 0, b = 1) => Math.max(a, Math.min(b, v)));
    const smooth = h?.smooth || ((x) => { const c = clamp(x); return c * c * (3 - 2 * c); });
    const rgba = h?.rgba || ((rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);

    // ── Draw the base lifestyle plate ──────────────────────────────
    ctx.drawImage(plate, 0, 0, W, H);

    // ── Theme + font resolution ────────────────────────────────────
    const theme = meta.theme || {};
    const colors = {
      hookScrim:     theme.scrimColor || [0, 0, 0],
      hookText:      theme.textPrimary || [255, 255, 255],
      quoteScrim:    theme.scrimColor || [0, 0, 0],
      quoteText:     theme.textPrimary || [255, 255, 255],
      reviewerText:  theme.textSecondary || theme.accentColor || [220, 220, 220]
    };
    const fonts = {
      headline: theme.headingFontFamily || theme.productFontFamily || 'PlayfairDisplay',
      body:     theme.bodyFontFamily    || theme.sansFontFamily    || 'Inter',
      quote:    theme.quoteFontFamily   || theme.serifFontFamily   || 'Lora'
    };

    // ── Copy resolution ────────────────────────────────────────────
    const headline     = String(meta.headline || meta.hookHeadline || '').trim();
    const quote        = String(meta.quoteSnippet || meta.quote || '').trim();
    // No fabricated purchase persona. Absent reviewer → drawProof skips byline.
    const reviewer     = String(meta.reviewer || '').trim().toUpperCase();

    // ── Phase gating ───────────────────────────────────────────────
    if (t < 3) {
      const alpha = fadeInOut(t, 0, 0.4, 2.6, 3.0, smooth);
      if (alpha > 0.01 && headline) drawHook(ctx, W, H, headline, alpha, colors, fonts, rgba);
    } else if (t < 6) {
      const alpha = fadeInOut(t, 3.0, 3.4, 5.6, 6.0, smooth);
      if (alpha > 0.01 && quote) drawProof(ctx, W, H, quote, reviewer, alpha, colors, fonts, rgba);
    }
    // 0:06–0:08 intentionally renders no overlay — see header note.
  }
};

// ── Timing ─────────────────────────────────────────────────────────

// Fade envelope over four time markers:
//   fadeIn: 0 → 1 between (tStart, tHoldStart)
//   hold:   1 between (tHoldStart, tHoldEnd)
//   fadeOut: 1 → 0 between (tHoldEnd, tEnd)
// Passing tHoldEnd === tEnd disables the fade-out (final-frame hold).
function fadeInOut(t, tStart, tHoldStart, tHoldEnd, tEnd, smooth) {
  if (t < tStart || t > tEnd) return 0;
  if (t < tHoldStart) return smooth((t - tStart) / Math.max(0.001, tHoldStart - tStart));
  if (t <= tHoldEnd)  return 1;
  if (tEnd === tHoldEnd) return 1;
  return 1 - smooth((t - tHoldEnd) / Math.max(0.001, tEnd - tHoldEnd));
}

// ── Phase renderers ────────────────────────────────────────────────

// HOOK: headline anchored in the upper-third, sitting on a local
// rounded-rectangle scrim that hugs the text block. Padding = 10% of
// text-block dimensions, clamped so the scrim never extends past the
// left frame edge (max horizontal padding = padX - 4). Composition
// matches the feed / landscape canonicals' local-scrim convention;
// the previous full-width top-down gradient is retired.
//
// Vertical Reels UI reserves ~204px top + ~204px bottom on 1080×1920
// (≈10.6% of H each). Upper-third at y ≈ 0.20–0.45 keeps the text
// (and its scrim) safely below the top safe zone.
function drawHook(ctx, W, H, headline, alpha, colors, fonts, rgba) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const padX = Math.round(W * 0.075);
  const wrapW = W - padX * 2;

  // Headline typography — measure first so we can size the scrim.
  // 75% of the previous hero scale (was H*0.055 clamped 60-96). Softer
  // presence over the plate; hook feels less shouty. Note: this now
  // reads smaller than the proof phase (H*0.048) — intentional
  // editorial inversion where the quote is the anchor.
  const fontSize = clampNum(Math.round(H * 0.041), 45, 72);
  ctx.font = `700 ${fontSize}px "${fonts.headline}"`;
  const lines = wrapLines(ctx, headline, wrapW, 3);
  const lineH = Math.round(fontSize * 1.12);
  const blockH = lines.length * lineH;

  let widest = 0;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > widest) widest = w;
  }

  // Y anchor targets H * 0.16 — about half the previous 0.32 distance
  // from the top. Clamped down when the block+scrim would intrude on
  // the Reels top safe zone (~10.6% of H = 204/1920). Short-headline
  // blocks (1-2 lines) sit at 0.16; longer 3-line blocks shift down
  // just enough to keep text out of the caption/handle band.
  const yStart = computeUpperThirdYStart(H, blockH);

  // Local scrim geometry — 10% margin around the text block, clamped
  // to fit within padX from the left frame edge.
  const scrimPadX = Math.min(Math.round(widest * 0.10), Math.max(0, padX - 4));
  const scrimPadY = Math.round(blockH * 0.10);
  const scrimX = padX - scrimPadX;
  const scrimY = yStart - scrimPadY;
  const scrimW = widest + scrimPadX * 2;
  const scrimH = blockH + scrimPadY * 2;
  const scrimR = Math.round(H * 0.014);

  drawLocalScrim(ctx, scrimX, scrimY, scrimW, scrimH, scrimR, rgba(colors.hookScrim, 0.72));

  // Headline fill on top of the scrim. Own shadow for edge legibility
  // (scrim gives base contrast; shadow softens serif strokes).
  ctx.fillStyle = rgba(colors.hookText, 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padX, yStart + i * lineH);
  }
  ctx.restore();
}

// PROOF: quote + attribution on a single local scrim spanning both
// blocks. Same upper-third anchor and padding math as the hook so the
// scrim rhythm stays consistent phase-to-phase.
function drawProof(ctx, W, H, quote, reviewer, alpha, colors, fonts, rgba) {
  ctx.save();
  ctx.globalAlpha = alpha;

  const padX = Math.round(W * 0.075);
  const wrapW = W - padX * 2;

  // Quote typography — measure lines first.
  const quoteSize = clampNum(Math.round(H * 0.048), 52, 84);
  ctx.font = `italic 500 ${quoteSize}px "${fonts.quote}"`;
  const quoteWithQuotes = `“${quote}”`;
  const quoteLines = wrapLines(ctx, quoteWithQuotes, wrapW, 3);
  const quoteLineH = Math.round(quoteSize * 1.18);
  const quoteBlockH = quoteLines.length * quoteLineH;

  let widestQuote = 0;
  for (const line of quoteLines) {
    const w = ctx.measureText(line).width;
    if (w > widestQuote) widestQuote = w;
  }

  // Attribution only when a real byline exists — never "— " with a blank.
  const hasReviewer = !!String(reviewer || '').trim();
  const attribSize = clampNum(Math.round(H * 0.018), 18, 30);
  const attribGap  = hasReviewer ? Math.round(H * 0.020) : 0;
  const attribText = hasReviewer ? `— ${reviewer}` : '';
  let attribW = 0;
  if (hasReviewer) {
    ctx.font = `600 ${attribSize}px "${fonts.body}"`;
    attribW = ctx.measureText(attribText).width;
  }

  const widest = Math.max(widestQuote, attribW);
  const totalH = quoteBlockH + (hasReviewer ? attribGap + attribSize : 0);
  // Same upper-anchor + safe-zone clamp math as drawHook. Proof's
  // totalH is larger than the hook's blockH (quote + attribution
  // stack), so the clamp typically pushes proof down further than
  // the hook — the two phases can sit at slightly different y
  // positions when the proof is 3+ lines. Design tolerance: eye
  // relocates naturally at the phase transition anyway.
  const yStart = computeUpperThirdYStart(H, totalH);

  // Single local scrim spanning quote + attribution — 10% margin
  // around the combined block, same clamping as the hook.
  const scrimPadX = Math.min(Math.round(widest * 0.10), Math.max(0, padX - 4));
  const scrimPadY = Math.round(totalH * 0.10);
  const scrimX = padX - scrimPadX;
  const scrimY = yStart - scrimPadY;
  const scrimW = widest + scrimPadX * 2;
  const scrimH = totalH + scrimPadY * 2;
  const scrimR = Math.round(H * 0.014);

  drawLocalScrim(ctx, scrimX, scrimY, scrimW, scrimH, scrimR, rgba(colors.quoteScrim, 0.72));

  // Quote fill on top of the scrim.
  ctx.font = `italic 500 ${quoteSize}px "${fonts.quote}"`;
  ctx.fillStyle = rgba(colors.quoteText, 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  for (let i = 0; i < quoteLines.length; i++) {
    ctx.fillText(quoteLines[i], padX, yStart + i * quoteLineH);
  }

  // Attribution — small caps sans, dimmer color, inside the same scrim.
  if (hasReviewer) {
    ctx.font = `600 ${attribSize}px "${fonts.body}"`;
    ctx.fillStyle = rgba(colors.reviewerText, 1);
    ctx.shadowBlur = 8;
    ctx.fillText(attribText, padX, yStart + quoteBlockH + attribGap);
  }

  ctx.restore();
}

// Local scrim helper — rounded rectangle with a subtle drop shadow
// beneath. Matches the feed canonical's drawLocalScrim pattern (same
// shadowBlur / shadowOffsetY convention). Callers pass fillStyle as a
// pre-composed rgba string so opacity is embedded in the color.
function drawLocalScrim(ctx, x, y, w, h, r, fillStyle) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.20)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = fillStyle;
  roundedRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

// Upper-third y-anchor with safe-zone protection. Targets H * 0.16
// (half the previous 0.32 distance to the top of frame). When the
// block + scrim padding would intrude on the Reels top safe zone
// (~10.6% of H reserved by IG for caption/handle chrome), clamps the
// block down just enough to keep the TEXT above the safe zone. Scrim
// padding is baked in via blockH * 0.10 — the same 10% margin
// drawHook / drawProof use for their local scrims. Returns the yStart
// (top-of-block) for callers who then position each line at
// yStart + i * lineH.
function computeUpperThirdYStart(H, blockH) {
  const targetCenter = H * 0.16;
  const scrimPadY    = Math.round(blockH * 0.10);
  const safeAreaTop  = Math.round(H * 0.106);   // ≈204/1920 Reels top band
  const textMargin   = Math.round(H * 0.015);   // buffer below safe zone
  const minCenter    = safeAreaTop + textMargin + blockH / 2 + scrimPadY;
  const yCenter      = Math.max(targetCenter, minCenter);
  return yCenter - blockH / 2;
}

// ── Text utilities ─────────────────────────────────────────────────

function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Ellipsize the last line if text overflowed the maxLines cap.
  if (lines.length === maxLines) {
    const remaining = words.slice(lines.join(' ').split(/\s+/).length).join(' ');
    if (remaining) {
      let last = lines[lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = last + '…';
    }
  }
  return lines;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}

function clampNum(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
