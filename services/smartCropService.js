// Pure algorithm: generate 3 smart crop candidates per aspect ratio
// Ratios: 5:4, 1:1, 4:5
//
// safeRect (optional, pixel coords) represents the union bounding box of the
// subject-of-interest across all sampled frames. When provided:
//   - One candidate is positioned to maximally contain it ("Safe envelope")
//   - All candidates get a score bonus proportional to how much of it they contain
//   - This makes video crops stable: the subject stays framed throughout the clip,
//     not just in the hero frame.

const RATIOS = {
  '5:4': 5 / 4,
  '1:1': 1,
  '4:5': 4 / 5
};

function generateSmartCrops(imgWidth, imgHeight, subjects, textRegions, safeRect = null) {
  const crops = {};
  for (const [ratioKey, ratio] of Object.entries(RATIOS)) {
    crops[ratioKey] = buildCandidates(ratioKey, ratio, imgWidth, imgHeight, subjects, textRegions, safeRect);
  }
  return crops;
}

function buildCandidates(ratioKey, ratio, imgW, imgH, subjects, textRegions, safeRect) {
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

  const primary = subjects.find(s => s.role === 'primary');
  const allRegions = [
    ...subjects.map(s => ({ ...s, weight: s.role === 'primary' ? 3 : 1 })),
    ...textRegions.map(t => ({ ...t, weight: 1.5 }))
  ];

  const centers = computeCenters(imgW, imgH, primary, allRegions, safeRect);
  const candidates = [];

  centers.forEach((center, i) => {
    const x1 = clampInt(center.cx - cropW / 2, 0, imgW - cropW);
    const y1 = clampInt(center.cy - cropH / 2, 0, imgH - cropH);
    const x2 = x1 + cropW;
    const y2 = y1 + cropH;
    const score = scoreCrop(x1, y1, x2, y2, imgW, imgH, allRegions, safeRect);

    candidates.push({
      id: `${ratioKey}-${i + 1}`,
      label: center.label,
      x1, y1, x2, y2,
      score: Math.round(score * 1000) / 1000
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function computeCenters(imgW, imgH, primary, allRegions, safeRect) {
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

  // Center 3: safe-envelope (video-aware) OR primary subject OR rule-of-thirds
  let c3;
  if (safeRect) {
    c3 = {
      cx: (safeRect.x1 + safeRect.x2) / 2,
      cy: (safeRect.y1 + safeRect.y2) / 2,
      label: 'Safe envelope'
    };
  } else if (primary) {
    c3 = {
      cx: ((primary.x1 + primary.x2) / 2) * imgW,
      cy: ((primary.y1 + primary.y2) / 2) * imgH,
      label: 'Subject-led'
    };
  } else {
    const leftWeight = allRegions.filter(r => (r.x1 + r.x2) / 2 < 0.5).reduce((a, r) => a + r.weight, 0);
    const topWeight  = allRegions.filter(r => (r.y1 + r.y2) / 2 < 0.5).reduce((a, r) => a + r.weight, 0);
    const cx = leftWeight > (wt - leftWeight) ? imgW * 0.33 : imgW * 0.67;
    const cy = topWeight  > (wt - topWeight)  ? imgH * 0.33 : imgH * 0.67;
    c3 = { cx, cy, label: 'Rule-of-thirds' };
  }

  return [c1, c2, c3];
}

function scoreCrop(x1, y1, x2, y2, imgW, imgH, regions, safeRect) {
  let score = 0;
  for (const r of regions) {
    const rx1 = r.x1 * imgW, ry1 = r.y1 * imgH;
    const rx2 = r.x2 * imgW, ry2 = r.y2 * imgH;
    const overlap = rectOverlap(x1, y1, x2, y2, rx1, ry1, rx2, ry2);
    const regionArea = Math.max(1, (rx2 - rx1) * (ry2 - ry1));
    score += (overlap / regionArea) * r.weight;
  }

  // Safe-envelope bonus: heavily reward crops that fully contain the envelope,
  // lightly penalize crops that cut it off.
  if (safeRect) {
    const envelopeArea = Math.max(1, (safeRect.x2 - safeRect.x1) * (safeRect.y2 - safeRect.y1));
    const envelopeOverlap = rectOverlap(x1, y1, x2, y2, safeRect.x1, safeRect.y1, safeRect.x2, safeRect.y2);
    const envelopeCoverage = envelopeOverlap / envelopeArea;  // 0..1
    // Weight of 5 makes envelope coverage dominate over individual region scores
    score += envelopeCoverage * 5;
    // Hard penalty if envelope is clipped
    if (envelopeCoverage < 0.999) score -= (1 - envelopeCoverage) * 3;
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

// Compute the union bounding box of YOLO detections + primary-role GPT subjects.
// Returns pixel coords in the hero-frame coordinate system, or null if no signal.
function computeSafeRect(products, subjects, imgW, imgH) {
  const boxes = [];
  for (const p of products || []) {
    boxes.push({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 });
  }
  for (const s of subjects || []) {
    if (s.role === 'primary') {
      boxes.push({
        x1: s.x1 * imgW, y1: s.y1 * imgH,
        x2: s.x2 * imgW, y2: s.y2 * imgH
      });
    }
  }
  if (!boxes.length) return null;
  return {
    x1: Math.min(...boxes.map(b => b.x1)),
    y1: Math.min(...boxes.map(b => b.y1)),
    x2: Math.max(...boxes.map(b => b.x2)),
    y2: Math.max(...boxes.map(b => b.y2))
  };
}

module.exports = { generateSmartCrops, computeSafeRect };
