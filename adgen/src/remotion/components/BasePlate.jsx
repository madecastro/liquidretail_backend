// The base video plate under the titles. Three modes:
//  - videoUrl: the ad's rendered video (OffthreadVideo — frame-exact SSR
//    decode, audio passes through to the final mux)
//  - imageUrl: a static plate (preview flow renders motion over one still)
//  - color: last-resort solid background
// URLs are localhost asset-server URLs supplied by remotionRenderService,
// so the render browser never needs external egress.

import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo } from 'remotion';

export const BasePlate = ({ plate }) => {
  if (plate?.videoUrl) {
    return (
      <AbsoluteFill>
        <OffthreadVideo
          src={plate.videoUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
    );
  }
  if (plate?.imageUrl) {
    return (
      <AbsoluteFill>
        <Img
          src={plate.imageUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ backgroundColor: plate?.color || '#3D3D3D' }} />;
};
