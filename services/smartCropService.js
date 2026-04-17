// Pure algorithm: generate 3 smart crop candidates per aspect ratio
// Ratios: 5:4, 1:1, 4:5

const RATIOS = {
  '5:4': 5 / 4,
  '1:1': 1,
  '4:5': 4 / 5
};

function generateSmartCrops(imgWidth, imgHeight, subjects, textRegions) {
  const crops = {};

  for (const [ratioKey, ratio] of Object.entries(RATIOS)) {
    crops[ratioKey] = buildCandidates(ratioKey, ratio, imgWidth, imgHeight, subjects, textRegions);
  }

  return crops;
}

function buildCandidates(ratioKey, ratio, imgW, imgH, subjects, textRegions) {
  // Crop dimensions: fit within image bounds
  let cropW, cropH;
  if (imgW / imgH > ratio) {
    cropH = imgH;
    cropW = Math.round(imgH * ratio);
  } else {
    cropW = imgW;
    cropH = Math.round(imgW / ratio);
  }
  cropW = Math.min(cropW, imgW);
  cropH = Math.min(cropH, imgH);

  // Build interest map from subjects (primary weighted higher) + text
  const candidates = [];
  const primary = subjects.find(s => s.role === 'primary');
  const allRegions = [
    ...subjects.map(s => ({ ...s, weight: s.role === 'primary' ? 3 : 1 })),
    ...textRegions.map(t => ({ ...t, weight: 1.5 }))
  ];

  // Three candidate center strategies
  const centers = computeCenters(imgW, imgH, primary, allRegions);

  centers.forEach((center, i) => {
    const x1 = clampInt(center.cx - cropW / 2, 0, imgW - cropW);
    const y1 = clampInt(center.cy - cropH / 2, 0, imgH - cropH);
    const x2 = x1 + cropW;
    const y2 = y1 + cropH;
    const score = scoreCrop(x1, y1, x2, y2, imgW, imgH, allRegions);

    candidates.push({
      id: `${ratioKey}-${i + 1}`,
      label: center.label,
      x1, y1, x2, y2,
      score: Math.round(score * 1000) / 1000
    });
  });

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function computeCenters(imgW, imgH, primary, allRegions) {
  const imgCx = imgW / 2;
  const imgCy = imgH / 2;

  // Center 1: geometric center of image
  const c1 = { cx: imgCx, cy: imgCy, label: 'Centered' };

  // Center 2: weighted centroid of all interest regions
  let wx = 0, wy = 0, wt = 0;
  for (const r of allRegions) {
    const cx = ((r.x1 + r.x2) / 2) * imgW;
    const cy = ((r.y1 + r.y2) / 2) * imgH;
    wx += cx * r.weight;
    wy += cy * r.weight;
    wt += r.weight;
  }
  const c2 = wt > 0
    ? { cx: wx / wt, cy: wy / wt, label: 'Content-focused' }
    : { cx: imgCx, cy: imgCy, label: 'Content-focused' };

  // Center 3: primary subject center, or rule-of-thirds offset
  let c3;
  if (primary) {
    const px = ((primary.x1 + primary.x2) / 2) * imgW;
    const py = ((primary.y1 + primary.y2) / 2) * imgH;
    c3 = { cx: px, cy: py, label: 'Subject-led' };
  } else {
    // Rule-of-thirds: shift toward whichever third has most content weight
    const leftWeight = allRegions.filter(r => (r.x1 + r.x2) / 2 < 0.5).reduce((a, r) => a + r.weight, 0);
    const topWeight  = allRegions.filter(r => (r.y1 + r.y2) / 2 < 0.5).reduce((a, r) => a + r.weight, 0);
    const cx = leftWeight > (wt - leftWeight) ? imgW * 0.33 : imgW * 0.67;
    const cy = topWeight  > (wt - topWeight)  ? imgH * 0.33 : imgH * 0.67;
    c3 = { cx, cy, label: 'Rule-of-thirds' };
  }

  return [c1, c2, c3];
}

function scoreCrop(x1, y1, x2, y2, imgW, imgH, regions) {
  let score = 0;
  for (const r of regions) {
    // Convert normalized coords to pixels
    const rx1 = r.x1 * imgW, ry1 = r.y1 * imgH;
    const rx2 = r.x2 * imgW, ry2 = r.y2 * imgH;
    const overlap = rectOverlap(x1, y1, x2, y2, rx1, ry1, rx2, ry2);
    const regionArea = Math.max(1, (rx2 - rx1) * (ry2 - ry1));
    score += (overlap / regionArea) * r.weight;
  }
  return score;
}

function rectOverlap(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  return Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
}

function clampInt(v, min, max) {
  return Math.round(Math.min(max, Math.max(min, v)));
}

module.exports = { generateSmartCrops };
