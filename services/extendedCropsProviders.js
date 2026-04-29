// Registry of AI image-extension providers for the extended-crops stage.
//
// Each entry describes one (provider, variant) pair. The orchestrator
// (extendedCropsService) iterates this list, filters by isEnabled(), and
// for each enabled entry calls generate(...) to produce an image Buffer
// that gets uploaded to Cloudinary + AR-fit transformed into a candidate.
//
// Plug-and-play:
//   - Add a provider: drop a service module that returns an image Buffer
//     (see geminiImageService.extendImage / generateFresh for the
//     signature), then push entries here — one per variant the provider
//     supports.
//   - Disable a provider: comment out or remove its entries (or set
//     isEnabled() to return false based on an env flag).
//   - idSlug must stay stable per (provider, variant): it's embedded in
//     candidate ids and historical OverlayZoneArtifact / CropArtifact
//     records reference these slugs in their candidateId fields.
//
// Provider contract:
//   {
//     provider:  string,                   // e.g. 'gemini'
//     variant:   'extension' | 'generation', // semantic slot
//     idSlug:    string,                   // short tag for candidate ids ('ext' | 'gen' historically)
//     isEnabled: () => boolean,            // env-gate / feature-flag
//     generate:  ({ sourceImageUrl, baseCrop, newRatio, primarySubject, background })
//                  => Promise<Buffer>      // returned buffer is uploaded by the orchestrator
//   }

const geminiImg = require('./geminiImageService');

module.exports = [
  {
    provider:  'gemini',
    variant:   'extension',
    idSlug:    'ext',
    isEnabled: () => geminiImg.isEnabled(),
    generate:  ({ sourceImageUrl, baseCrop, newRatio, primarySubject, background }) =>
      geminiImg.extendImage(sourceImageUrl, baseCrop, newRatio, primarySubject, background)
  },
  {
    provider:  'gemini',
    variant:   'generation',
    idSlug:    'gen',
    isEnabled: () => geminiImg.isEnabled(),
    generate:  ({ sourceImageUrl, baseCrop, newRatio, primarySubject, background }) =>
      geminiImg.generateFresh(sourceImageUrl, baseCrop, newRatio, primarySubject, background)
  }
];
