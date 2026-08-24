// Platform-wide admin surface. Mounted at /api/admin.
//
// Auth lives on THIS router (requireUserOnly then requireSuperAdmin),
// not on a per-route basis and not behind requireAuth — requireAuth
// would inject a tenant advertiser id onto every request, which is
// exactly the ambient value a future handler would read by habit.
//
// HARD RULE: no handler in this file may read the request's advertiser
// id field, or call tenantFilter / any other tenant-scoped filter
// helper. This is a PLATFORM-WIDE admin surface; every query here is
// global, not scoped to one Advertiser.

const express = require('express');
const router  = express.Router();

const requireUserOnly   = require('../middleware/requireUserOnly');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const systemConfig      = require('../services/systemConfigService');
const adVisionQc        = require('../services/adVisionQcService');

router.use(requireUserOnly);
router.use(requireSuperAdmin);

function isTriState(value) {
  return value === true || value === false || value === null;
}

function sourceFor(setting) {
  if (setting === true || setting === false) return 'db';
  // Env fallback is retired. Unset/unreadable is the default (false).
  return 'default';
}

async function readQcConfig() {
  const [staticSetting, videoSetting, staticEffective, videoEffective] = await Promise.all([
    systemConfig.getStaticVisionQcEnabled(),
    systemConfig.getVideoVisionQcEnabled(),
    adVisionQc.resolveStaticEnabled(),
    adVisionQc.resolveVideoEnabled()
  ]);
  const staticNorm = (staticSetting === true || staticSetting === false) ? staticSetting : null;
  const videoNorm  = (videoSetting === true || videoSetting === false) ? videoSetting : null;
  return {
    static: {
      setting:   staticNorm,
      effective: staticEffective === true,
      source:    sourceFor(staticNorm)
    },
    video: {
      setting:   videoNorm,
      effective: videoEffective === true,
      source:    sourceFor(videoNorm)
    }
  };
}

function fmtTri(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value);
}

// GET /api/admin/qc-config — current vision-QC gate state, platform-wide.
router.get('/qc-config', async (req, res) => {
  try {
    const state = await readQcConfig();
    return res.json(state);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'qc-config read failed' });
  }
});

// PATCH /api/admin/qc-config
// Body: { staticEnabled?: true|false|null, videoEnabled?: true|false|null }
// At least one key required. Values must be STRICTLY the boolean true /
// false or null — strings like "true"/"false" are 400, never coerced.
router.patch('/qc-config', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? req.body
      : {};
    const staticPresent = Object.prototype.hasOwnProperty.call(body, 'staticEnabled');
    const videoPresent  = Object.prototype.hasOwnProperty.call(body, 'videoEnabled');
    if (!staticPresent && !videoPresent) {
      return res.status(400).json({
        error: 'at least one of staticEnabled or videoEnabled is required'
      });
    }
    if (staticPresent && !isTriState(body.staticEnabled)) {
      return res.status(400).json({
        error: 'staticEnabled must be true, false, or null'
      });
    }
    if (videoPresent && !isTriState(body.videoEnabled)) {
      return res.status(400).json({
        error: 'videoEnabled must be true, false, or null'
      });
    }

    const email = (req.userDoc && req.userDoc.email) ? String(req.userDoc.email) : null;
    const changes = [];

    if (staticPresent) {
      const oldVal = await systemConfig.getStaticVisionQcEnabled();
      await systemConfig.setStaticVisionQcEnabled(body.staticEnabled, email);
      changes.push(`static ${fmtTri(oldVal)} → ${fmtTri(body.staticEnabled)}`);
    }
    if (videoPresent) {
      const oldVal = await systemConfig.getVideoVisionQcEnabled();
      await systemConfig.setVideoVisionQcEnabled(body.videoEnabled, email);
      changes.push(`video ${fmtTri(oldVal)} → ${fmtTri(body.videoEnabled)}`);
    }

    console.log(`✏️  admin qc-config PATCH by ${email || '?'}: ${changes.join('; ')}`);
    const state = await readQcConfig();
    return res.json(state);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || 'qc-config update failed' });
  }
});

module.exports = router;
