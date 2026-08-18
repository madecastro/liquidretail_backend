# Authoring RPD experiment specs

A spec is one JSON file. Cells = `models × variants`. Start from `scripts/rpd/specs/*.json`.

## Top-level fields

| field | required | notes |
|---|---|---|
| `name` | yes | `[a-z0-9-_]`, becomes the run directory + gallery title |
| `notes` | no | why this experiment exists — renders in the gallery header |
| `seed.url` | yes | the product image. **Cloudinary URLs get the exact production crop** (`c_fill,g_auto`, 720-short-edge, brandHex pad). Anything else is sent to the model UNRESIZED with a warning |
| `seed.productTitle` | no | becomes `product.title` in the prompt fixture (`Product: …` line) |
| `seed.refs[]` | no | extra reference stills, same crop rule; ≥1 ref flips the prompt to multi-view PRODUCT FIDELITY wording (same as production `hasProductReference`) |
| `seed.brandHex` | no | crop pad color + gallery accent |
| `aspectRatio` | no (9:16) | must be in the model's `supportedAspectRatios` or the cell is skipped honestly (no silent rerouting — Omni supports only 16:9/9:16) |
| `durationSec` | no (8) | snaps to the model enum at expand time (Omni: 4/6/8/10) — the prompt Timeline is built from the SNAPPED value, and both requested/effective are recorded |
| `resolution` | no | must be in the model's `resolutions` enum or the cell is skipped (a typo like `"4K"` would otherwise be priced at the 720p fallback and submitted verbatim). Omni 720p and 1080p are the same price |
| `seedHasText` | no | set `true` when the seed carries burned-in text/graphics (adds the production locked-photo paragraph) |
| `models[]` | yes | Atlas slugs that exist in `MODEL_CAPS` — run `rpd models` for the registry. r2v (video-seed) models are skipped: image seeds only today |
| `variants[]` | yes | see levers below; ids must be unique |
| `titling` | no | see titling section |

Per-variant overrides: `aspectRatio`, `durationSec`, `seedHasText`, `hasProductReference`,
`platformFormat`, `promptProfile`, `variantKind` — so one spec can sweep durations or
platform treatments as variants.

## The four levers (one per variant; two at once is a hard error)

| lever | production mechanism it exercises | behaviour |
|---|---|---|
| *(none — baseline)* | the canonical camera prompt | byte-identical to `buildVeoPrompt` for the same fixture (pinned by verify D1) |
| `guidance: "…"` | `videoPromptGuidance` prepend (wizard/brand/product cascade, prod lever 3) | prepends `OPERATOR REFINEMENT (HIGHEST PRIORITY…)`; canonical directives still apply |
| `raw: "…"` | `Ad.videoPromptRaw` (prod lever 2) | FULL replacement via `enforceRawByteCap` — canonical directives bypassed entirely |
| `directives: {key: "text"}` | a code change to `OMNI/GROK/PMAX/LIFESTYLE_DIRECTIVES` | patches the exact directive set the builder will read for this fixture (lifestyle-aware), builds, restores byte-identically. Unknown key = hard error listing valid keys. **This is how you measure a canonical-directive change BEFORE anyone commits it to `veoPromptBuilder.js`** |
| `patch: [{find, replace}]` | surgical edit of the final string | each `find` must occur EXACTLY once in the built prompt or the cell hard-errors — zero matches means you're not testing what you claim, two means you're changing more than you claim |

Directive keys (packshot sets): `role`, `objective`, `sourceImages`, `productPreservation`,
`transitions`, `cameraStyle`, `background`, `visualStyle`, `audio`, `noText`,
`physicalAccuracy`, `doNot`. Lifestyle adds `ambientLife`. Profile selection mirrors
production: `pmax_video_*` platformFormat → PMax, `gemini-omni` paramShape → Omni, else Grok;
`variantKind: "ugc"` + `VIDEO_LIFESTYLE_PROMPT=true` → lifestyle set.

**Do not "fix" the crossfade/dissolve contradiction as a cleanup.** `transitions` allows
~0.25s crossfades while `doNot` bans dissolves — that exact text is the owner-confirmed
better-output version (PR #61 rollback). Changing it is a legitimate *experiment* (measured
2026-08-18: a hard-cuts patch removed baseline ghosting), never a silent tidy-up.

## Titling (`titling` block)

```json
{ "enabled": true, "preset": "canonical", "platformFormat": "meta_stories_9_16",
  "brandName": "Brand", "copy": { "headline": "…", "ctaText": "SHOP NOW" } }
```

- Presets are `remotion/presets/*.json` (`canonical`, `canonical-awareness|consideration|conversion`, `*-pmax10`, curated brand presets).
- `platformFormat` picks the SAFE ZONE (Stories ≠ Reels ≠ PMax YouTube) independent of the composition; composition comes from the aspect (vertical/square/landscape/feed — square supported).
- **Proof-class copy renders ONLY when you supply it** (`quote`, `quoteSnippet`, `reviewer`, `rating`, `reviewCount`, `reviewsText`, `badgeText`, `deliveryLine`, `price`). A defaulted quote is a fabricated testimonial — pinned by verify E8. Only put real, provenance-checked proof in a gallery someone might share.
- Titling failure keeps the master and records `titlingError` — untitled is visible, never counted as titled.

## Matrix patterns that work

- **Model shootout**: N models × `[{id:"baseline"}]` — same canonical prompt everywhere; compare fidelity/motion/cost/latency.
- **Prompt ladder**: 1 model × [baseline, guidance-A, guidance-B, directives-C] — cheapest way to iterate prose.
- **Directive pre-flight**: 1 model × [baseline, directives-with-proposed-change] before a `veoPromptBuilder.js` PR.
- **Duration/cost sweep**: 1 model × variants overriding `durationSec` (4/6/8/10) — settled prices land in the manifest for real per-second economics.
