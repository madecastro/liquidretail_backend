// scripts/rpd/lib/titling.js — standalone Remotion burn over a generated master.
// No Mongo, no Ad. Failure returns { ok:false, error } and leaves the master
// untouched (prod keep-the-master rule).
//
// Provenance:
//   runRemotion         scripts/testRemotionTitles.js:280-295
//   fixtureBrand        scripts/testRemotionTitles.js:54-66
//   fixtureMeta         scripts/testRemotionTitles.js:73-106
//   resolveSpecForBrand services/titleSpecService.js:253
//   buildBrandTokens    services/titleSpecService.js:284
//   renderTitles        services/remotionRenderService.js:434
//                       returns { finalPath, tempDir, timings } — caller
//                       copies finalPath then rm tempDir (:430-432)
//   platformFormat      production pass-through:
//                       services/brandScriptExecutor.js:1562-1576
//   classifyFormat      services/brandScriptExecutor.js:89-94
//                       (includes square; testRemotionTitles forgot it)

const fsp = require('fs').promises;
const path = require('path');

const { resolveSpecForBrand, buildBrandTokens } = require('../../../src/services/titleSpecService');
const { renderTitles } = require('../../../src/services/remotionRenderService');
const { classifyFormat } = require('../../../src/services/brandScriptExecutor');

function pickStr(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function fixtureBrand(preset, brandName) {
  return {
    _id: 'fixture-brand',
    name: brandName || 'Pelagic Test Fixture',
    primaryColor: '#0B2545',
    secondaryColor: '#8DA9C4',
    accentColor: '#F2C14E',
    fontFamily: 'Barlow Condensed',
    tagline: 'Built for blue water',
    websiteUrl: 'https://pelagic-fixture.example.com',
    logoUrl: null,
    titleStylePreset: preset || null
  };
}

function fixtureMeta(copy, brand) {
  const c = copy && typeof copy === 'object' ? copy : {};
  const cta = pickStr(c.ctaText, 'SHOP NOW');
  // PROOF-CLASS FIELDS DEFAULT TO ABSENT. testRemotionTitles' fixture ships a
  // placeholder quote/rating/review-count; on a harness whose output gets
  // handed around as "the finished creative", a defaulted quote IS a
  // fabricated testimonial — the exact thing quoteProvenance exists to block
  // in production. Render social proof and claims only when the operator
  // explicitly supplies them in spec.titling.copy.
  return {
    brandName: brand.name,
    headline: pickStr(c.headline, 'Gear that goes deeper'),
    subheadline: pickStr(c.subheadline, null),
    quote: pickStr(c.quote, null),
    quoteSnippet: pickStr(c.quoteSnippet, null),
    reviewer: pickStr(c.reviewer, null),
    badgeText: pickStr(c.badgeText, null),
    productName: pickStr(c.productName, null),
    price: pickStr(c.price, null),
    deliveryLine: pickStr(c.deliveryLine, null),
    ctaText: cta,
    cta,
    rating: c.rating != null ? c.rating : null,
    reviewCount: c.reviewCount != null ? c.reviewCount : null,
    reviewsText: pickStr(c.reviewsText, null),
    promoText: c.promoText != null ? c.promoText : null,
    endcardMode: pickStr(c.endcardMode, 'product'),
    brandTagline: brand.tagline,
    brandWebsiteUrl: brand.websiteUrl,
    brandLogoUrl: pickStr(c.brandLogoUrl, brand.logoUrl),
    theme: {
      textPrimary: [255, 255, 255],
      textSecondary: [141, 169, 196],
      scrimColor: [0, 0, 0],
      endcardBgColor: [11, 37, 69],
      accentColor: [242, 193, 78],
      promoBgColor: [242, 193, 78],
      starColor: [245, 183, 10],
      promoTextColor: [22, 22, 26],
      headingFontFamily: brand.fontFamily,
      bodyFontFamily: brand.fontFamily,
      quoteFontFamily: 'Lora'
    }
  };
}

// A real Brand doc (wired in by runner.js from dbSeed.js's resolveSeedFromDb
// when the spec used seed.productId) wins over the fixture — it carries the
// product's ACTUAL logo/colors/font/tagline/titleStylePreset, so the burned-in
// chrome matches what production would actually deliver. Its own
// titleStylePreset (or null) drives resolveSpecForBrand exactly as production
// does — `preset` is a fixture-only convenience and never overrides a real
// brand's stored preference. An operator who sets `specIn.brand` themselves
// (e.g. to force-test a different brand's look) is respected the same way.
// Exported so scripts/verifyRpdHarness.js can pin the selection directly,
// without spawning a real Remotion child via the full titleCell() pipeline.
function resolveTitleBrand(specIn, preset) {
  return (specIn.brand && typeof specIn.brand === 'object')
    ? specIn.brand
    : fixtureBrand(preset, specIn.brandName);
}

async function titleCell({ runDir, cell, titlingSpec }) {
  let tempDir = null;
  try {
    const specIn = titlingSpec && typeof titlingSpec === 'object' ? titlingSpec : {};
    if (specIn.enabled === false) {
      return { ok: false, error: 'titling disabled' };
    }

    const localPath = cell && cell.localPath;
    if (!localPath) return { ok: false, error: 'cell.localPath required' };
    if (!runDir) return { ok: false, error: 'runDir required' };

    const videoUrl = path.isAbsolute(localPath)
      ? localPath
      : path.join(runDir, localPath);

    try {
      await fsp.access(videoUrl);
    } catch {
      return { ok: false, error: `master not found: ${videoUrl}` };
    }

    const cellId = cell.id || cell.cellId;
    const destDir = cellId
      ? path.join(runDir, 'cells', String(cellId))
      : path.dirname(videoUrl);
    const titledPath = path.join(destDir, 'titled.mp4');

    const platformFormat = specIn.platformFormat || cell.platformFormat || null;
    const format = classifyFormat({
      aspectRatio: cell.aspectRatio,
      platformFormat
    });

    const preset = specIn.preset || 'canonical';
    const brand = resolveTitleBrand(specIn, preset);
    const meta = fixtureMeta(specIn.copy, brand);

    const { spec, source } = resolveSpecForBrand(brand, format);
    const tokens = await buildBrandTokens(brand, {
      specFontOverrides: spec.tokenOverrides?.fonts || {}
    });
    console.log(
      `🎬 rpd-title[cell=${cellId || '?'}]: spec=${source} format=${format}` +
      (platformFormat ? ` platformFormat=${platformFormat}` : '')
    );

    const result = await renderTitles({
      videoUrl,
      meta,
      spec,
      tokens,
      format,
      platformFormat,
      brandName: brand.name,
      adId: cellId ? `rpd-${cellId}` : 'rpd-title'
    });
    tempDir = result.tempDir || null;

    await fsp.mkdir(destDir, { recursive: true });
    await fsp.copyFile(result.finalPath, titledPath);
    return { ok: true, titledPath, timings: result.timings || null };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// fixtureBrand/fixtureMeta exported for scripts/verifyRpdHarness.js, which
// pins that proof-class fields never default into the chrome.
module.exports = { titleCell, fixtureBrand, fixtureMeta, resolveTitleBrand };
