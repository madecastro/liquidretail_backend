// Phase A-0 — image-quality metrics for the Media Library Technical Insights
// panel. All metrics are computed locally via `sharp` from the same image
// buffer the YOLO + subject-text stages already use, so no extra Cloudinary
// fetches and no extra LLM calls.
//
// Today this module exposes one metric:
//   focus — Laplacian-variance sharpness, returned as both a raw score and
//           a Soft / Acceptable / Sharp bucket.
//
// The complementary brightnessAvg + densityAvg metrics for the Technical
// Insights row are derived directly from OverlayZoneArtifact's existing
// brightness/density grids; see adSuitabilityService for that wiring.

const sharp = require('sharp');

// Laplacian 3×3 kernel — second derivative; high variance = sharp edges,
// low variance = blurred / out-of-focus.
const LAPLACIAN_KERNEL = {
  width:  3,
  height: 3,
  kernel: [
    0, -1,  0,
   -1,  4, -1,
    0, -1,  0
  ]
};

// Bucket thresholds tuned on a small sample of marketing/UGC stills.
// Adjust if production images skew systematically (e.g. heavy compression
// pulls scores down).
const FOCUS_BUCKETS = [
  { max: 100,    bucket: 'Soft' },
  { max: 300,    bucket: 'Acceptable' },
  { max: Infinity, bucket: 'Sharp' }
];

// Compute focus score (Laplacian variance) on the supplied image buffer.
// Returns { focusScore: number, focusBucket: 'Soft'|'Acceptable'|'Sharp' }.
// Failure mode: returns null so the caller can omit the metric without
// breaking the run.
async function computeFocus(buffer) {
  if (!buffer || !buffer.length) return null;
  try {
    // Greyscale + downsample to a 512-pixel-wide working copy. Downsampling
    // matters: full-res variance is dominated by sensor noise on phone
    // photos; 512px gives stable focus signal across input resolutions.
    const work = await sharp(buffer)
      .greyscale()
      .resize({ width: 512, withoutEnlargement: true })
      .convolve(LAPLACIAN_KERNEL)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = work;
    const n = info.width * info.height;
    if (!n) return null;

    // Welford's mean+variance. data is Uint8 (0..255); kernel can produce
    // negative values which sharp clips to 0, so variance here is on the
    // positive-edge response only — still a strong sharpness proxy.
    let mean = 0;
    let m2   = 0;
    for (let i = 0; i < n; i++) {
      const x = data[i];
      const delta = x - mean;
      mean += delta / (i + 1);
      m2   += delta * (x - mean);
    }
    const focusScore = Math.round(m2 / n);
    const focusBucket = bucketFor(focusScore);
    return { focusScore, focusBucket };
  } catch (err) {
    console.warn(`   ⚠️  imageQuality.computeFocus failed: ${err.message}`);
    return null;
  }
}

function bucketFor(score) {
  for (const b of FOCUS_BUCKETS) {
    if (score < b.max) return b.bucket;
  }
  return 'Sharp';
}

module.exports = { computeFocus, FOCUS_BUCKETS };
