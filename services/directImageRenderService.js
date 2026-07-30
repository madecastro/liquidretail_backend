// Production static-ad path without GPT-authored HTML.
//
// Director-approved concept + source media -> Atlas visual plate -> Sharp/SVG
// overlay. The image model is deliberately never asked to render copy, prices,
// CTAs, or logos; those remain deterministic and auditable here.

'use strict';

const axios = require('axios');
const sharp = require('sharp');

const atlasImage = require('./atlasImageService');
const LayoutInputArtifact = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const Media = require('../models/Media');
const { resolveBrandFonts, normalizeFontFamily } = require('./fontResolverService');

const DIRECT_OVERLAY_PIPELINE = 'direct_overlay';
const PLATE_EDIT_MODEL = process.env.AI_DIRECT_IMAGE_EDIT_MODEL || 'openai/gpt-image-2/edit';
const PLATE_T2I_MODEL = process.env.AI_DIRECT_IMAGE_MODEL || 'openai/gpt-image-2/text-to-image';
// Atlas's live GPT Image 2 schema defaults to medium. High materially extends
// latency and is unnecessary for the plate because Sharp performs the final
// crop, typography, logo, and export.
const PLATE_QUALITY = process.env.AI_DIRECT_IMAGE_QUALITY || 'medium';
const PLATE_TIMEOUT_MS = Number(process.env.AI_DIRECT_IMAGE_TIMEOUT_MS || 60_000);
const REFERENCE_TIMEOUT_MS = Number(process.env.AI_DIRECT_REFERENCE_TIMEOUT_MS || 15_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.AI_DIRECT_UPLOAD_TIMEOUT_MS || 20_000);

function isDirectOverlayPipeline(value) {
  return String(value || DIRECT_OVERLAY_PIPELINE).toLowerCase() === DIRECT_OVERLAY_PIPELINE;
}

function dimsFor(aspectRatio) {
  switch (aspectRatio) {
    case '4:5': return { width: 1000, height: 1250, atlasSize: '1024x1536', overlayStart: 0.58 };
    // GPT Image's currently documented portrait preset is 2:3. Sharp crops
    // it to the product's 9:16 canvas after generation; the prompt reserves
    // wider side-safe space so the crop does not cut the subject.
    case '9:16': return { width: 1000, height: 1778, atlasSize: '1024x1536', overlayStart: 0.60 };
    case '1:1': return { width: 1000, height: 1000, atlasSize: '1024x1024', overlayStart: 0.42 };
    default: return { width: 1000, height: 1000, atlasSize: '1024x1024', overlayStart: 0.48 };
  }
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeColor(value, fallback) {
  const candidate = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) || /^#[0-9a-f]{3}$/i.test(candidate) ? candidate : fallback;
}

function wrap(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function linesSvg(lines, { x, y, size, lineHeight, weight, color, family }) {
  return lines.map((line, i) => `<text x="${x}" y="${y + (i * lineHeight)}" font-family="${escapeXml(family)}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`).join('');
}

function themeFor(brand, layoutBrand) {
  const styleThemeIsCurated = Array.isArray(brand?.curatedFields) && brand.curatedFields.includes('styleTheme');
  const fontFamilyIsCurated = Array.isArray(brand?.curatedFields) && brand.curatedFields.includes('fontFamily');
  const tailwind = brand?.tailwindTheme || {};
  // A human-curated style theme remains authoritative. Otherwise the
  // confidence-gated Tailwind kit wins over older automatic style data.
  const theme = styleThemeIsCurated ? (brand?.styleTheme || {}) : {};
  const colors = theme?.colors || theme || {};
  const headingFont = normalizeFontFamily(
    theme?.fonts?.heading?.family || theme?.headingFont ||
    (fontFamilyIsCurated ? brand?.fontFamily : null) ||
    tailwind?.fonts?.heading || brand?.websiteFontUsage?.heading ||
    brand?.fontFamily || layoutBrand?.font_family
  ) || 'Arial';
  const bodyFont = normalizeFontFamily(
    theme?.fonts?.body?.family || theme?.bodyFont ||
    (fontFamilyIsCurated ? brand?.fontFamily : null) ||
    tailwind?.fonts?.body || brand?.websiteFontUsage?.body ||
    brand?.fontFamily || layoutBrand?.font_family || headingFont
  ) || headingFont;
  return {
    accent: safeColor(colors.ctaBgColor || colors.accentColor || tailwind?.colors?.accent || brand?.accentColor || layoutBrand?.accent_color, '#D8FF64'),
    text: safeColor(colors.textPrimary || tailwind?.colors?.font || brand?.fontColor, '#FFFFFF'),
    secondaryText: safeColor(colors.textSecondary, '#E6EEF7'),
    ctaText: safeColor(colors.ctaTextColor, '#07111D'),
    headingFont,
    bodyFont,
    // Backward-compatible alias for callers/tests that inspect theme.font.
    font: headingFont
  };
}

function buildOverlay({ copy, brand, layoutBrand, dims }) {
  const theme = themeFor(brand, layoutBrand);
  const margin = 64;
  const ruleY = Math.round(dims.height * dims.overlayStart);
  const eyebrowY = ruleY + 72;
  const headline = wrap(copy.headline || brand?.tagline || brand?.name || 'Discover more', dims.width < 1000 ? 20 : 23);
  const headlineY = eyebrowY + 66;
  const subheadline = wrap(copy.subheadline || '', 42);
  const subheadlineY = headlineY + (headline.length * 70) + 42;
  const ctaY = dims.height - 166;
  const eyebrow = copy.eyebrow || (brand?.name ? String(brand.name).toUpperCase() : '');
  const cta = copy.cta || 'SHOP NOW';
  const wordmark = !brand?.logoUrl ? (brand?.name || layoutBrand?.name || '') : '';

  return `
  <svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="direct-scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#07111D" stop-opacity="0"/><stop offset="38%" stop-color="#07111D" stop-opacity="0.12"/><stop offset="100%" stop-color="#07111D" stop-opacity="0.94"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#direct-scrim)"/>
    <rect x="${margin}" y="${ruleY}" width="${dims.width - margin * 2}" height="12" rx="6" fill="${theme.accent}"/>
    ${eyebrow ? `<text x="${margin}" y="${eyebrowY}" font-family="${escapeXml(theme.font)}" font-size="26" font-weight="700" letter-spacing="3" fill="${theme.accent}">${escapeXml(eyebrow)}</text>` : ''}
    ${linesSvg(headline, { x: margin, y: headlineY, size: 68, lineHeight: 72, weight: 700, color: theme.text, family: theme.font })}
    ${linesSvg(subheadline, { x: margin, y: subheadlineY, size: 31, lineHeight: 40, weight: 400, color: theme.secondaryText, family: theme.font })}
    <rect x="${margin}" y="${ctaY}" width="334" height="94" rx="47" fill="${theme.accent}"/>
    <text x="${margin + 167}" y="${ctaY + 59}" text-anchor="middle" font-family="${escapeXml(theme.font)}" font-size="28" font-weight="700" letter-spacing="1" fill="${theme.ctaText}">${escapeXml(cta)}</text>
    ${wordmark ? `<text x="${dims.width - margin}" y="${dims.height - 76}" text-anchor="end" font-family="${escapeXml(theme.font)}" font-size="22" font-weight="700" letter-spacing="2" fill="${theme.text}">${escapeXml(wordmark)}</text>` : ''}
  </svg>`;
}

function buildGraphicOverlay({ brand, layoutBrand, dims }) {
  const theme = themeFor(brand, layoutBrand);
  const margin = 64;
  const ruleY = Math.round(dims.height * dims.overlayStart);
  const ctaY = dims.height - 166;
  return `
  <svg width="${dims.width}" height="${dims.height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="direct-scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#07111D" stop-opacity="0"/><stop offset="38%" stop-color="#07111D" stop-opacity="0.12"/><stop offset="100%" stop-color="#07111D" stop-opacity="0.94"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#direct-scrim)"/>
    <rect x="${margin}" y="${ruleY}" width="${dims.width - margin * 2}" height="12" rx="6" fill="${theme.accent}"/>
    <rect x="${margin}" y="${ctaY}" width="334" height="94" rx="47" fill="${theme.accent}"/>
  </svg>`;
}

function pangoMarkup(text, { color, size, weight, letterSpacing = 0 }) {
  const spacing = Math.round(letterSpacing * 1024);
  return `<span foreground="${escapeXml(color)}" size="${size}pt" weight="${weight}"${spacing ? ` letter_spacing="${spacing}"` : ''}>${escapeXml(text)}</span>`;
}

function textComposite({ text, font, left, top, width, color, size, weight, align = 'left', spacing = 0, letterSpacing = 0 }) {
  if (!text) return null;
  const descriptor = {
    text: pangoMarkup(text, { color, size, weight, letterSpacing }),
    font: `${font.family} ${weight}`,
    width,
    align,
    spacing,
    rgba: true
  };
  // This is the load-bearing difference from the old SVG text: Sharp
  // receives the exact resolved website/Google/library font file.
  if (font.url) descriptor.fontfile = font.url;
  return { input: { text: descriptor }, left: Math.round(left), top: Math.max(0, Math.round(top)) };
}

async function resolveDirectFonts(brand, layoutBrand) {
  const theme = themeFor(brand, layoutBrand);
  return resolveBrandFonts(brand, {
    overrides: {
      heading: { family: theme.headingFont, weight: 700 },
      body:    { family: theme.bodyFont,    weight: 400 },
      quote:   { family: theme.bodyFont,    weight: 400 }
    },
    layoutInputBrand: layoutBrand
  });
}

function buildTextLayers({ copy, brand, layoutBrand, dims, fonts }) {
  const theme = themeFor(brand, layoutBrand);
  const margin = 64;
  const ruleY = Math.round(dims.height * dims.overlayStart);
  const eyebrowY = ruleY + 72;
  const headline = wrap(copy.headline || brand?.tagline || brand?.name || 'Discover more', dims.width < 1000 ? 20 : 23);
  const headlineY = eyebrowY + 66;
  const subheadline = wrap(copy.subheadline || '', 42);
  const subheadlineY = headlineY + (headline.length * 70) + 42;
  const ctaY = dims.height - 166;
  const eyebrow = copy.eyebrow || (brand?.name ? String(brand.name).toUpperCase() : '');
  const cta = copy.cta || 'SHOP NOW';
  const wordmark = !brand?.logoUrl ? (brand?.name || layoutBrand?.name || '') : '';
  const textWidth = dims.width - (margin * 2);

  return [
    textComposite({
      text: eyebrow, font: fonts.heading, left: margin, top: eyebrowY - 31,
      width: textWidth, color: theme.accent, size: 26, weight: 700, letterSpacing: 3
    }),
    textComposite({
      text: headline.join('\n'), font: fonts.heading, left: margin, top: headlineY - 63,
      width: textWidth, color: theme.text, size: 68, weight: 700, spacing: 72
    }),
    textComposite({
      text: subheadline.join('\n'), font: fonts.body, left: margin, top: subheadlineY - 31,
      width: textWidth, color: theme.secondaryText, size: 31, weight: 400, spacing: 40
    }),
    textComposite({
      text: cta, font: fonts.heading, left: margin, top: ctaY + 25,
      width: 334, color: theme.ctaText, size: 28, weight: 700, align: 'center', letterSpacing: 1
    }),
    textComposite({
      text: wordmark, font: fonts.heading, left: dims.width - margin - 420, top: dims.height - 101,
      width: 420, color: theme.text, size: 22, weight: 700, align: 'right', letterSpacing: 2
    })
  ].filter(Boolean);
}

async function fetchBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: REFERENCE_TIMEOUT_MS });
  return Buffer.from(response.data);
}

async function optionalImage(url) {
  if (!url) return null;
  try { return await fetchBuffer(url); } catch (err) { console.warn(`   ⚠️  direct-image: reference fetch failed (${err.message})`); return null; }
}

function buildPlatePrompt({ concept, brand, product, aspectRatio }) {
  const refs = [
    product?.title ? `Product: ${product.title}.` : null,
    brand?.name ? `Brand: ${brand.name}.` : null,
    concept?.archetype ? `Creative archetype: ${String(concept.archetype).replace(/_/g, ' ')}.` : null,
    concept?.rationale ? `Art direction: ${String(concept.rationale).slice(0, 900)}` : null,
    concept?.emotional_hook ? `Emotional hook: ${String(concept.emotional_hook).slice(0, 300)}.` : null,
    `Create a premium social-ad visual plate for ${aspectRatio}. Use the supplied product/lifestyle references for accurate product identity.`,
    'Reserve the lower third as uncluttered negative space for a deterministic overlay added later.',
    'Do not include readable text, letters, logos, labels, prices, CTA buttons, badges, watermarks, UI, or typography. Product labels must be blank or illegible.',
    'Do not recreate any logo from the references. The renderer adds all brand identity and copy after image generation.'
  ].filter(Boolean);
  return refs.join('\n');
}

async function resolveConcept({ adConceptArtifactId, adConceptId }) {
  if (!adConceptArtifactId || !adConceptId) return null;
  const artifact = await CreativeDirectionArtifact.findById(adConceptArtifactId).select('concepts').lean();
  return artifact?.concepts?.find((c) => c.concept_id === adConceptId) || null;
}

// Tag an error with how loudly it should be reported. renderService raises
// exactly one alert per failed render using these, so the classification lives
// with the code that knows what went wrong, not with the caller.
function taggedError(message, { alertLevel = 'error', alertKey }) {
  const err = new Error(message);
  err.alertLevel = alertLevel;
  err.alertKey = alertKey;
  return err;
}

async function renderDirectImage({ layoutInputArtifactId, aspectRatio, mediaId, productId, brandId, adConceptArtifactId, adConceptId, template, referenceMediaIds = [] }) {
  // Credentials are checked further down, AFTER brand routing: a brand
  // deliberately on the HTML pipeline renders through gpt-4.1 + Puppeteer and
  // needs no image-model key, so failing it here for a missing Atlas key would
  // break a path that does not use Atlas.

  const [layout, concept, brand, product, media] = await Promise.all([
    LayoutInputArtifact.findById(layoutInputArtifactId).select('input brandId productId').lean(),
    resolveConcept({ adConceptArtifactId, adConceptId }),
    brandId ? Brand.findById(brandId).lean() : null,
    productId ? CatalogProduct.findById(productId).select('title imageUrl').lean() : null,
    mediaId ? Media.findById(mediaId).select('fileUrl').lean() : null
  ]);
  // A missing layout artifact is recoverable: everything it supplies has a
  // source of its own. brand/product come from the explicit args, and themeFor
  // already falls back to the Brand document when there is no layoutInput
  // brand block. Render a generic layout rather than losing the ad.
  if (!layout) {
    console.warn(`   ⚠️  direct-image: layout input ${layoutInputArtifactId} missing — rendering with a generic layout`);
  }
  const effectiveLayout = layout || { input: {}, brandId: brandId || null, productId: productId || null };

  // A concept is not recoverable — it carries the copy the ad is built from.
  // Its absence means the Director round did not produce (or did not attach)
  // the concept this Ad row points at, which is a pipeline fault worth
  // surfacing, not a creative to improvise.
  if (!concept) {
    throw taggedError(
      `no Director concept resolved for ad (conceptArtifact=${adConceptArtifactId || 'none'} conceptId=${adConceptId || 'none'}) — the concept is missing from the artifact or the artifact is gone`,
      { alertLevel: 'error', alertKey: 'direct-image:no-concept' }
    );
  }

  const resolvedBrand = brand || (effectiveLayout.brandId ? await Brand.findById(effectiveLayout.brandId).lean() : null);
  if (!isDirectOverlayPipeline(resolvedBrand?.staticImagePipeline)) {
    // The ONLY legitimate reason to leave this pipeline: an operator put this
    // brand on the HTML path deliberately. `routedToHtml` marks it as a
    // routing decision so the caller can honour it, while every other exit
    // above is breakage and must not be quietly rerouted into a different
    // renderer.
    return { skipped: true, routedToHtml: true, reason: `brand staticImagePipeline is ${resolvedBrand?.staticImagePipeline || 'html'}` };
  }

  // Only reached for brands actually on this pipeline. No image provider at
  // all means nothing here can succeed and every ad in every run fails the
  // same way, so it gets the loudest level we have — it is an outage, not a
  // bad ad. Deliberately after the concept check, which is universal, and
  // after brand routing, which does not need an image key.
  if (!atlasImage.isConfigured() && !process.env.OPENAI_API_KEY) {
    throw taggedError(
      'no image credentials: neither ATLAS_API_KEY nor OPENAI_API_KEY is configured — no static ad can render until one is set',
      { alertLevel: 'fatal', alertKey: 'direct-image:no-credentials' }
    );
  }
  const resolvedProduct = product || (effectiveLayout.productId ? await CatalogProduct.findById(effectiveLayout.productId).select('title imageUrl').lean() : null);
  const dims = dimsFor(aspectRatio);
  // ONE reference by default: the media this ad was actually built from.
  //
  // This used to send the selected media AND the product's hero image on every
  // render. The model faithfully composed both, so an operator who picked a
  // single shot got a second view of the product they never asked for — and
  // when the two happen to be the same photo (merchant original vs Cloudinary
  // mirror), URL dedup can't see it and the same image is paid for twice.
  //
  // Extra references are opt-in: `referenceMediaIds` carries the operator's
  // explicit ordered picks, the same field the video path reads.
  const refCandidates = [];
  const orderedIds = (Array.isArray(referenceMediaIds) ? referenceMediaIds : []).map(String);
  if (orderedIds.length) {
    const picked = await Media.find({ _id: { $in: orderedIds } }).select('fileUrl').lean();
    const byId = new Map(picked.map((m) => [String(m._id), m]));
    orderedIds.forEach((id, i) => {
      const doc = byId.get(id);
      if (doc?.fileUrl) refCandidates.push({ sourceUrl: doc.fileUrl, role: i === 0 ? 'operator-pick' : `operator-pick-${i}` });
    });
    if (refCandidates.length < orderedIds.length) {
      console.warn(`   ⚠️  direct-image: ${orderedIds.length - refCandidates.length} operator-picked media missing — sending the ${refCandidates.length} that resolved`);
    }
  }
  if (!refCandidates.length) {
    const fallback = media?.fileUrl
      ? { sourceUrl: media.fileUrl, role: 'seed-media' }
      : (resolvedProduct?.imageUrl ? { sourceUrl: resolvedProduct.imageUrl, role: 'product-hero' } : null);
    if (fallback) refCandidates.push(fallback);
  }
  // Carry each buffer's origin alongside it: the uploaded Atlas handles are
  // ephemeral, so only this makes the submission legible in the inspector.
  const fetchedRefs = await Promise.all(refCandidates.map((c) => optionalImage(c.sourceUrl)));
  const refs = [];
  const imageMeta = [];
  refCandidates.forEach((candidate, i) => {
    if (fetchedRefs[i]) { refs.push(fetchedRefs[i]); imageMeta.push(candidate); }
  });
  const prompt = buildPlatePrompt({ concept, brand: resolvedBrand, product: resolvedProduct, aspectRatio });
  const meta = { stage: 'direct_image_overlay', service: 'directImageRenderService', purposeTag: template || 'untagged', brandId: resolvedBrand?._id || brandId || null, productId: resolvedProduct?._id || productId || null, mediaId: mediaId || null };
  // When Atlas is configured, the established renderer is the recovery path.
  // Starting a second provider request after a submitted Atlas prediction both
  // extends the user's wait and can double-charge the same ad.
  const allowProviderFallback = !atlasImage.isConfigured();
  const result = refs.length
    ? await atlasImage.editImage({
      model: PLATE_EDIT_MODEL, images: refs, imageMeta, prompt, size: dims.atlasSize,
      quality: PLATE_QUALITY, meta, timeoutMs: PLATE_TIMEOUT_MS,
      uploadTimeoutMs: UPLOAD_TIMEOUT_MS, allowFallback: allowProviderFallback
    })
    : await atlasImage.generateImage({
      model: PLATE_T2I_MODEL, prompt, size: dims.atlasSize,
      quality: PLATE_QUALITY, meta, timeoutMs: PLATE_TIMEOUT_MS,
      allowFallback: allowProviderFallback
    });
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('direct-image generation returned no image data');

  const plate = await sharp(Buffer.from(b64, 'base64')).resize(dims.width, dims.height, { fit: 'cover', position: 'attention' }).png().toBuffer();
  const copy = concept.copy_picks || {};
  const layoutBrand = effectiveLayout.input?.brand || {};
  const fonts = await resolveDirectFonts(resolvedBrand, layoutBrand);
  const layers = [
    { input: Buffer.from(buildGraphicOverlay({ brand: resolvedBrand, layoutBrand, dims })), top: 0, left: 0 },
    ...buildTextLayers({ copy, brand: resolvedBrand, layoutBrand, dims, fonts })
  ];
  const logo = await optionalImage(resolvedBrand?.logoUrl || effectiveLayout.input?.brand?.logo);
  if (logo) {
    try {
      const logoPng = await sharp(logo).resize({ width: 160, height: 56, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      layers.push({ input: logoPng, top: dims.height - 100, left: dims.width - 224 });
    } catch (err) { console.warn(`   ⚠️  direct-image: logo compose failed (${err.message})`); }
  }
  const buffer = await sharp(plate).composite(layers).png().toBuffer();
  console.log(
    `   🖼️  direct-image ready — ${template}/${aspectRatio} concept=${adConceptId} refs=${refs.length} ` +
    `model=${refs.length ? PLATE_EDIT_MODEL : PLATE_T2I_MODEL} ` +
    `font=${fonts.heading.requestedFamily}→${fonts.heading.resolvedFamily}[${fonts.heading.source}]`
  );
  return {
    buffer, contentType: 'image/png', width: dims.width, height: dims.height,
    bytes: buffer.length, kind: 'image', directImage: true,
    // Verbatim audit of the image-model request, built at submit time inside
    // atlasImageService. Persisted onto the Ad so the inspector never has to
    // re-derive what "should" have been sent.
    imageGeneration: result?.submission
      ? { ...result.submission, pipeline: DIRECT_OVERLAY_PIPELINE, stage: 'plate' }
      : null,
    fontResolution: {
      heading: {
        requestedFamily: fonts.heading.requestedFamily,
        resolvedFamily: fonts.heading.resolvedFamily,
        source: fonts.heading.source,
        exact: fonts.heading.exact
      },
      body: {
        requestedFamily: fonts.body.requestedFamily,
        resolvedFamily: fonts.body.resolvedFamily,
        source: fonts.body.source,
        exact: fonts.body.exact
      }
    }
  };
}

module.exports = {
  DIRECT_OVERLAY_PIPELINE, isDirectOverlayPipeline, dimsFor, themeFor,
  buildOverlay, buildGraphicOverlay, buildTextLayers, resolveDirectFonts,
  buildPlatePrompt, renderDirectImage
};
