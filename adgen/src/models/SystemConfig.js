// System-wide singleton config. One document, unique via a fixed
// `key` field. Currently holds the canonical brand-script renderer
// used by every brand that opts into the theme-driven overlay path
// (Brand.styleTheme). Any other future system-level knob (feature
// flags with no UI yet, per-tenant overrides, etc.) can grow here
// rather than proliferating single-purpose collections.
//
// Access via services/systemConfigService.js — never Mongo directly.
// That service ensures the singleton exists and provides get/set
// helpers that upsert cleanly.

const mongoose = require('mongoose');

const systemConfigSchema = new mongoose.Schema({
  // Enforces the singleton via unique index. Only 'default' is valid.
  key: { type: String, required: true, unique: true, default: 'default' },

  // Canonical brand-script for feed formats (4:5, 1:1). Sourced from
  // services/brandScripts/canonical.script.js when unset — file fallback
  // means a fresh deploy is usable before an admin edits this.
  canonicalScript: { type: String, default: null },

  // Canonical brand-script for vertical formats (9:16 — Reels, Shorts,
  // Stories). Sourced from services/brandScripts/top_scrim_editorial.script.js
  // when unset. Kept separate from canonicalScript because vertical and
  // feed have distinct design constraints (top-anchored editorial for
  // vertical vs. bottom-scrim CTA composition for feed).
  canonicalScriptVertical: { type: String, default: null },

  // Canonical brand-script for landscape formats (16:9 — Google
  // Performance Max, YouTube pre-roll). Sourced from
  // services/brandScripts/local_scrim_landscape.script.js when unset.
  // Uses a left-column editorial layout with per-element local scrims
  // so the video breathes through the remaining two-thirds of the frame.
  canonicalScriptLandscape: { type: String, default: null },

  // Post-render vision QC — LEGACY single gate, split 2026-08-21 into
  // staticVisionQcEnabled / videoVisionQcEnabled below. This field is a
  // backward-compat BRIDGE to the two split fields, not a separate lever:
  // getStatic/getVideoVisionQcEnabled still read it when their own field
  // is unset. Env fallback never existed after this point (the
  // AD_VISION_QC_ENABLED / STATIC_VISION_QC_ENABLED / VIDEO_VISION_QC_ENABLED
  // env vars are retired and must not be reintroduced).
  //   true  → force QC on
  //   false → force QC off (explicit kill-switch)
  //   null  → not set; split getters fall through to this field, then false
  adVisionQcEnabled: { type: Boolean, default: null },

  // Post-render vision QC — STATIC pipeline gate (directImageRenderService,
  // and imageRecoveryService since recovery is static-only). Same tri-state
  // contract as the legacy field above. Access only via
  // systemConfigService.getStaticVisionQcEnabled / setStaticVisionQcEnabled.
  // Precedence when reading (see systemConfigService for the full cascade):
  //   this field (if boolean) → legacy adVisionQcEnabled (if boolean,
  //   backward-compat bridge) → false. No env fallback.
  staticVisionQcEnabled: { type: Boolean, default: null },

  // Post-render vision QC — VIDEO pipeline gate (brandScriptExecutor). Same
  // tri-state contract and precedence shape as staticVisionQcEnabled above,
  // independent value. Access only via systemConfigService
  // .getVideoVisionQcEnabled / setVideoVisionQcEnabled. No env fallback.
  videoVisionQcEnabled: { type: Boolean, default: null },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }  // email of the last editor
});

systemConfigSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
