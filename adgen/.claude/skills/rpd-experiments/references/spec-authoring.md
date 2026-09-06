# Authoring RPD experiment specs

A spec is one JSON file. Cells = `models × variants`. Start from `scripts/rpd/specs/*.json`.

## Top-level fields

| field | required | notes |
|---|---|---|
| `name` | yes | `[a-z0-9-_]`, becomes the run directory + gallery title |
| `notes` | no | why this experiment exists — renders in the gallery header |
| `seed.url` | yes (or `seed.productId`) | the product image. **Cloudinary URLs get the exact production crop** (`c_fill,g_auto`, 720-short-edge, brandHex pad). Anything else is sent to the model UNRESIZED with a warning |
| `seed.productId` | yes (or `seed.url`) | Mongo `CatalogProduct._id`. Needs `MONGODB_URI` (read-only). Resolves the real merchant-feed primary + 2 refs by the live production rule — no manual URLs. If `titling` is also set, also wires the product's real Brand + title into it (see Titling section) unless you set those yourself |
| `seed.productTitle` | no | becomes `product.title` in the prompt fixture (`Product: …` line); auto-filled from `seed.productId` if not set |
| `seed.refs[]` | no | extra reference stills, same crop rule; ≥1 ref flips the prompt to multi-view PRODUCT FIDELITY wording (same as production `hasProductReference`) |
| `seed.brandHex` | no | crop pad color + gallery accent |
| `aspectRatio` | no (9:16) | must be in the model's `supportedAspectRatios` or the cell is skipped honestly (no silent rerouting — Omni supports only 16:9/9:16) |
| `durationSec` | no (8) | snaps to the model enum at expand time (Omni: 4/6/8/10) — the prompt Timeline is built from the SNAPPED value, and both requested/effective are recorded |
| `resolution` | no | must be in the model's `resolutions` enum or the cell is skipped (a typo like `"4K"` would otherwise be priced at the 720p fallback and submitted verbatim). Omni 720p and 1080p are the same price |
| `seedHasText` | no | set `true` when the seed carries burned-in text/graphics (adds the production locked-photo paragraph) |
| `models[]` | yes | Atlas slugs from `MODEL_CAPS`, **or** any `gemini-*` id (e.g. `gemini-omni-1.1-flash`) — the latter routes to the direct Gemini Developer API automatically, no separate flag. Run `rpd models` for the live registry of both. r2v (video-seed) Atlas models are skipped: image seeds only today |
| `variants[]` | yes | see levers below; ids must be unique |
| `titling` | no | see titling section |
| `rngSeed` | no | **Atlas only** (schema-confirmed `seed` field on the `gemini-omni` paramShape). Per-variant `variant.rngSeed` overrides it. Pins the model's own randomness so a prompt A/B isn't confounded with seed variance. No equivalent exists for direct Gemini — see `references/operations.md` |

Per-variant overrides: `aspectRatio`, `durationSec`, `seedHasText`, `hasProductReference`,
`platformFormat`, `promptProfile`, `variantKind` — so one spec can sweep durations or
platform treatments as variants.

## The four levers (one per variant; two at once is a hard error)

**Read `references/prompt-elements.md` first** — as of 2026-09-03 the video
prompt is one frozen CORE paragraph (`corePromptText`), the same for every
model/provider, and the `directives` lever no longer changes it. Kept for
backward compatibility and because its singleton-restore guarantee is still
worth pinning, not because it is a useful lever any more.

| lever | still changes output? | production mechanism it exercises |
|---|---|---|
| *(none — baseline)* | — | `buildVeoPrompt` for the same fixture (byte-identical, pinned by verify D1) |
| `guidance: "…"` | **Yes.** | Operator-refinement prepend (wizard/regenerate cascade). Fenced ahead of CORE; a `CONSTRAINT SUPREMACY` line is appended last so it can steer within CORE's fidelity/no-text constraints but never override them |
| `raw: "…"` | **Yes.** | FULL replacement via `enforceRawByteCap` — bypasses CORE and the builder entirely |
| `patch: [{find, replace}]` | **Yes — the tool for testing a CORE wording change.** | Surgical edit of CORE's own assembled text. Each `find` must occur EXACTLY once or the cell hard-errors — zero matches means you're not testing what you claim, two means you're changing more than you claim |
| `directives: {key: "text"}` | **No.** | Patches the legacy `OMNI/GROK/HOOK_FIRST/LIFESTYLE_DIRECTIVES` singleton (build, restore byte-identically, unknown key = hard error) but the assembled prompt is byte-identical to baseline regardless — CORE never reads these objects. The harness's own verify suite asserts this inertness rather than pretending it still works |

CORE is owner-frozen (see `references/prompt-elements.md` for the "why," and
`services/veoPromptBuilder.js`'s `corePromptText` header for the full
history, including the precedent this repeats: PR #61 hardened the OLD video
prompt and was rolled back in full when the owner said the previous output
was better). Proposing a `patch`/`raw` change to CORE is a legitimate,
measured experiment; "cleaning it up" without a measured A/B is not.

## Titling (`titling` block)

```json
{ "enabled": true, "preset": "canonical", "platformFormat": "meta_stories_9_16",
  "brandName": "Brand", "copy": { "headline": "…", "ctaText": "SHOP NOW" } }
```

- Presets are `remotion/presets/*.json` (`canonical`, `canonical-awareness|consideration|conversion`, `*-pmax10`, curated brand presets).
- `platformFormat` picks the SAFE ZONE (Stories ≠ Reels ≠ PMax YouTube) independent of the composition; composition comes from the aspect (vertical/square/landscape/feed — square supported).
- `brand` (object, no need to author it by hand) — when `seed.productId` is used, `runner.js` fills this in automatically with the real Brand doc (`logoUrl`, `primaryColor`/`secondaryColor`/`accentColor`, `fontFamily`, `tagline`, `titleStylePreset`) so the burned-in chrome matches the real brand instead of the fixture "Pelagic Test Fixture" look. Set it yourself only to force-test a *different* brand's look than the seeded product's own. `brandName` (the plain string field, above) still only feeds the fixture and is ignored once a real `brand` object is present.
- **Proof-class copy renders ONLY when you supply it** (`quote`, `quoteSnippet`, `reviewer`, `rating`, `reviewCount`, `reviewsText`, `badgeText`, `deliveryLine`, `price`). A defaulted quote is a fabricated testimonial — pinned by verify E8. Only put real, provenance-checked proof in a gallery someone might share.
- Titling failure keeps the master and records `titlingError` — untitled is visible, never counted as titled.

## Matrix patterns that work

- **Model shootout**: N models × `[{id:"baseline"}]` — same canonical prompt everywhere; compare fidelity/motion/cost/latency.
- **Prompt ladder**: 1 model × [baseline, guidance-A, guidance-B, directives-C] — cheapest way to iterate prose.
- **Directive pre-flight**: 1 model × [baseline, directives-with-proposed-change] before a `veoPromptBuilder.js` PR.
- **Duration/cost sweep**: 1 model × variants overriding `durationSec` (4/6/8/10) — settled prices land in the manifest for real per-second economics.
