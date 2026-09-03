// Composition registry. All four canonical formats render the same spec
// interpreter; fps/duration come from inputProps at render time (probed
// from the actual plate video by remotionRenderService — never assumed).
//
// 'square' (1080x1080, Meta Feed 1:1) was added 2026-07-29. Before that a 1:1 ad
// fell through classifyFormat's three-way branch to 'feed' and was titled in
// CanonicalFeed at 1080x1350 — i.e. a 1:1 ad was delivered at 4:5 while its Ad row
// said aspectRatio '1:1'. Adding a composition here is only half the fix; see
// brandScriptExecutor.classifyFormat for the other half.
//
// Square deliberately reuses feed's STYLE (safe zones, base text sizes, title
// specs) because both are 1080 wide, so the horizontal text budget is identical
// and only the height differs. Only the geometry is new. See SIZE_FORMAT_ALIAS in
// src/remotion/components/slotRenderers.jsx.

import React from 'react';
import { Composition } from 'remotion';
import { Canonical } from './compositions/Canonical.jsx';

const FALLBACK = { fps: 24, durationInFrames: 192 }; // 8s nominal

const calculateMetadata = ({ props }) => ({
  fps: props.fps || FALLBACK.fps,
  durationInFrames: props.durationInFrames || FALLBACK.durationInFrames,
  props,
});

const DEFAULTS = {
  plate: { color: '#3D3D3D' },
  meta: {},
  tokens: {},
  spec: null,
  fps: FALLBACK.fps,
  durationInFrames: FALLBACK.durationInFrames,
  debugLayout: false,
  // Safe-zone variant (null → canvas format zones). PMax video sets
  // verticalYt / landscapeYt / squareYt via remotionRenderService; Meta and
  // non-video ads leave this null so stackContainerStyle keeps today's zones.
  safeZoneKey: null,
  platformFormat: null,
};

export const RemotionRoot = () => (
  <>
    <Composition
      id="CanonicalVertical"
      component={Canonical}
      width={1080}
      height={1920}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'vertical' }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="CanonicalFeed"
      component={Canonical}
      width={1080}
      height={1350}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'feed' }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="CanonicalSquare"
      component={Canonical}
      width={1080}
      height={1080}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'square' }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="CanonicalLandscape"
      component={Canonical}
      width={1920}
      height={1080}
      fps={FALLBACK.fps}
      durationInFrames={FALLBACK.durationInFrames}
      defaultProps={{ ...DEFAULTS, format: 'landscape' }}
      calculateMetadata={calculateMetadata}
    />
  </>
);
