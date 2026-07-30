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

const DIRECT_OVERLAY_PIPELINE = 'direct_overlay';
const PLATE_EDIT_MODEL = 'openai/gpt-image-2/edit';
const PLATE_T2I_MODEL = 'openai/gpt-image-2/text-to-image';
const PLATE_QUALITY = process.env.AI_DIRECT_IMAGE_QUALITY || 'high';

function enabled() {
  return String(process.env.AI_STATIC_PIPELINE || 'html').toLowerCase() === DIRECT_OVERLAY_PIPELINE;
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
  const theme = brand?.styleTheme || {};
  const colors = theme?.colors || theme || {};
  return {
    accent: safeColor(colors.ctaBgColor || colors.accentColor || brand?.accentColor || layoutBrand?.accent_color, '#D8FF64'),
    text: safeColor(colors.textPrimary || brand?.fontColor, '#FFFFFF'),
    secondaryText: safeColor(colors.textSecondary, '#E6EEF7'),
    ctaText: safeColor(colors.ctaTextColor, '#07111D'),
    font: String(theme?.fonts?.heading?.family || theme?.headingFont || brand?.fontFamily || 'Arial, Helvetica, sans-serif').slice(0, 120)
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

async function fetchBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
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

async function renderDirectImage({ layoutInputArtifactId, aspectRatio, mediaId, productId, brandId, adConceptArtifactId, adConceptId, template }) {
  if (!enabled()) return { skipped: true, reason: 'AI_STATIC_PIPELINE is not direct_overlay' };
  if (!atlasImage.isConfigured() && !process.env.OPENAI_API_KEY) return { skipped: true, reason: 'no Atlas or OpenAI image credentials configured' };

  const [layout, concept, brand, product, media] = await Promise.all([
    LayoutInputArtifact.findById(layoutInputArtifactId).select('input brandId productId').lean(),
    resolveConcept({ adConceptArtifactId, adConceptId }),
    brandId ? Brand.findById(brandId).lean() : null,
    productId ? CatalogProduct.findById(productId).select('title imageUrl').lean() : null,
    mediaId ? Media.findById(mediaId).select('fileUrl').lean() : null
  ]);
  if (!layout) return { skipped: true, reason: 'layout input missing' };
  if (!concept) return { skipped: true, reason: 'direct overlay requires a named Director concept' };

  const resolvedBrand = brand || (layout.brandId ? await Brand.findById(layout.brandId).lean() : null);
  const resolvedProduct = product || (layout.productId ? await CatalogProduct.findById(layout.productId).select('title imageUrl').lean() : null);
  const dims = dimsFor(aspectRatio);
  const refs = (await Promise.all([optionalImage(resolvedProduct?.imageUrl), optionalImage(media?.fileUrl)])).filter(Boolean).slice(0, 2);
  const prompt = buildPlatePrompt({ concept, brand: resolvedBrand, product: resolvedProduct, aspectRatio });
  const meta = { stage: 'direct_image_overlay', service: 'directImageRenderService', purposeTag: template || 'untagged', brandId: resolvedBrand?._id || brandId || null, productId: resolvedProduct?._id || productId || null, mediaId: mediaId || null };
  const result = refs.length
    ? await atlasImage.editImage({ model: PLATE_EDIT_MODEL, images: refs, prompt, size: dims.atlasSize, quality: PLATE_QUALITY, meta })
    : await atlasImage.generateImage({ model: PLATE_T2I_MODEL, prompt, size: dims.atlasSize, quality: PLATE_QUALITY, meta });
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('direct-image generation returned no image data');

  const plate = await sharp(Buffer.from(b64, 'base64')).resize(dims.width, dims.height, { fit: 'cover', position: 'attention' }).png().toBuffer();
  const copy = concept.copy_picks || {};
  const layers = [{ input: Buffer.from(buildOverlay({ copy, brand: resolvedBrand, layoutBrand: layout.input?.brand || {}, dims })), top: 0, left: 0 }];
  const logo = await optionalImage(resolvedBrand?.logoUrl || layout.input?.brand?.logo);
  if (logo) {
    try {
      const logoPng = await sharp(logo).resize({ width: 160, height: 56, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      layers.push({ input: logoPng, top: dims.height - 100, left: dims.width - 224 });
    } catch (err) { console.warn(`   ⚠️  direct-image: logo compose failed (${err.message})`); }
  }
  const buffer = await sharp(plate).composite(layers).png().toBuffer();
  console.log(`   🖼️  direct-image ready — ${template}/${aspectRatio} concept=${adConceptId} refs=${refs.length} model=${refs.length ? PLATE_EDIT_MODEL : PLATE_T2I_MODEL}`);
  return { buffer, contentType: 'image/png', width: dims.width, height: dims.height, bytes: buffer.length, kind: 'image', directImage: true };
}

module.exports = { DIRECT_OVERLAY_PIPELINE, enabled, dimsFor, buildOverlay, buildPlatePrompt, renderDirectImage };
