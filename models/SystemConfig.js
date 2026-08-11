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

  // Post-render vision QC master switch (adVisionQcService).
  // Tri-state on purpose:
  //   true  → force QC on  (wins over process.env.AD_VISION_QC_ENABLED)
  //   false → force QC off (wins over env — explicit kill-switch)
  //   null  → not set; fall through to env, then default false
  // Lives here so an operator can flip it live without a Render restart
  // (dashboard env changes restart both services). Access only via
  // systemConfigService.getAdVisionQcEnabled / setAdVisionQcEnabled.
  adVisionQcEnabled: { type: Boolean, default: null },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }  // email of the last editor
});

systemConfigSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
