# Reach Social — Social Proof Renderer Instructions v1

This document defines renderer behavior for the canonical social proof template system.
It is downstream of:
1. canonical template catalog       (`rsSocialProof.templates.catalog.json`)
2. normalized template objects      (`rsSocialProof.templates.normalized.json`)
3. canvas schema and ratio variants (`rsSocialProof.canvas.v1.json`)

It covers only renderer instructions:
- slot fill order
- zone collapse behavior
- text truncation behavior
- media fit decision tree
- video autoplay and poster behavior
- scrim application rules
- mobile obstruction handling
- empty state and fallback rendering

============================================================
## 1) GLOBAL RENDERER PRINCIPLES
============================================================

1. The renderer must be deterministic.
   Given the same normalized template object and canvas spec, output must be materially identical.

2. The renderer is mobile-first.
   If a tradeoff exists between desktop flourish and mobile clarity, preserve mobile clarity.

3. One primary proof idea per frame.
   Even if multiple proof signals exist, the renderer should maintain a dominant proof hierarchy.

4. One primary motion zone at most.
   If multiple video-capable slots are present, only one may autoplay as the dominant motion zone.

5. Product or offer anchoring is required unless the template explicitly permits proof-only fallback.

6. Every template must render in all of these states:
   - image-only
   - hybrid image + video
   - video-primary
   - sparse-data fallback mode

7. Renderer decisions must respect:
   - canvas safe areas
   - zone visibility rules
   - zone max lines / max items / radius / padding
   - motion policy
   - collapse rules

============================================================
## 2) SHARED RENDER PIPELINE
============================================================

Render pipeline order:
1. Resolve template and ratio canvas
2. Resolve slot values from normalized object
3. Validate required slots
4. Apply slot fill order
5. Apply collapse rules for missing content
6. Resolve media fit and crop strategy
7. Resolve text fitting / truncation
8. Resolve motion policy
9. Resolve scrims / overlays
10. Resolve obstruction-safe shifts for mobile surfaces
11. Render layers in canvas order
12. Run final fallback pass if a zone remains invalid

If any step invalidates a later zone, the renderer must re-run collapse and fitting for dependent zones.

============================================================
## 3) SLOT FILL ORDER
============================================================

### 3.1 Global slot fill priority

Always fill in this order:
1. hero proof slot
2. hero media slot
3. headline slot
4. supporting proof slots
5. identity / badges / trust row
6. CTA
7. logo / chrome
8. optional decorative or support media

Reason:
The renderer should preserve the highest-value proof and conversion elements first.

### 3.2 Slot source resolution

For every zone, resolve slot content in this order:
1. use zone-specific source_priority from normalized template object
2. if source_priority yields no valid content, apply zone-specific fallback policy
3. if still empty, apply template-level fallback policy
4. if still empty, apply global fallback policy
5. if still empty and zone is optional, collapse it
6. if still empty and zone is required, mark template invalid and switch to emergency fallback layout

### 3.3 Content validity rules

A slot is valid only if:
- text: non-empty after trimming
- quote: non-empty text string
- metrics: minimum required count present
- media image: URL exists and is loadable
- media video: URL exists and poster exists or can be derived
- rating: numeric or display-ready string exists
- CTA: visible label exists

### 3.4 Template-specific slot priority

A. testimonial_spotlight
- primary_quote
- support_media
- headline
- proof_bar
- product_meta
- CTA

B. ugc_split_screen
- ugc_panel
- product_panel
- quote_bubble
- identity_row
- engagement_row
- CTA

C. review_collage
- center_hero
- review_stack_primary
- review_stack_secondary
- summary_badge
- headline
- CTA

D. results_proof
- headline
- metrics_row
- proof_quote
- support_media
- trust_footer
- CTA

E. creator_endorsement
- creator_zone
- endorsement_quote
- product_zone
- trust_ribbon
- CTA

============================================================
## 4) ZONE COLLAPSE BEHAVIOR
============================================================

### 4.1 General collapse rules

If an optional zone has no valid content:
- remove the zone from layout
- reclaim its space only if the template permits reflow
- otherwise leave negative space only when negative space is part of the design intent

### 4.2 Reflow strategy

There are three allowed collapse modes:
- hide_only: zone disappears, surrounding geometry unchanged
- collapse_up: lower zones move upward to occupy the removed zone's vertical band
- expand_neighbor: adjacent sibling zone expands into the removed zone's footprint

### 4.3 Template-specific collapse rules

A. testimonial_spotlight
- If proof_bar missing: hide_only; CTA may shift upward by up to 24 units
- If product_meta missing: hide_only
- If support_media missing: expand quote_card width only on tall formats; otherwise show branded gradient panel
- If headline missing: quote_card becomes visual anchor and may shift upward by 16 units

B. ugc_split_screen
- If engagement_row missing: collapse_up; CTA moves up into engagement band
- If identity_row missing: hide_only; no panel resize
- If product_panel missing: ugc_panel expands toward dominant full-bleed layout only in 9:16 and 4:5; in wide ratios keep empty branded panel
- If ugc_panel missing but product exists: convert to simplified product-led split variant with product on dominant panel and quote card preserved

C. review_collage
- If one review stack missing: remaining stack may expand modestly, but center_hero must remain dominant
- If summary_badge missing: CTA moves into badge band
- If headline missing: no reflow required
- If center_hero missing: use branded product placeholder tile; do not fully collapse collage structure

D. results_proof
- If proof_quote missing: collapse_up into support_media/trust_footer band
- If trust_footer missing: CTA moves upward
- If support_media missing: metrics_row and proof_quote remain; switch to metrics-only layout
- If metrics count below minimum: template invalid unless emergency fallback mode is invoked

E. creator_endorsement
- If trust_ribbon missing: collapse_up; CTA moves upward
- If product_zone missing: keep creator as hero and use product name badge only if present
- If creator_zone missing but product exists: switch to simplified endorsement fallback with product hero and quote preserved
- If endorsement_quote missing: use headline text in quote style

### 4.4 Emergency fallback layout

If required zones fail validation and no template-specific fallback resolves the issue:
- render background / brand gradient
- render headline if available
- render any valid proof snippet
- render product name if available
- render CTA if available
- suppress decorative modules

This ensures the renderer still produces a usable frame.

============================================================
## 5) TEXT TRUNCATION BEHAVIOR
============================================================

### 5.1 Order of operations

For each text zone:
1. apply copy source selection
2. normalize whitespace
3. preserve manual line breaks only if template allows authored formatting
4. fit text to zone using zone max_lines and text style
5. if overflow persists, truncate according to zone policy

### 5.2 Truncation policy

Allowed truncation methods:
- clamp_lines_with_ellipsis
- hard_char_limit_with_ellipsis
- preserve_whole_words_then_ellipsis

Default method: preserve_whole_words_then_ellipsis.

### 5.3 Text hierarchy preservation

When multiple text zones compete, preserve in this order:
1. CTA label
2. primary quote / headline
3. product name
4. proof row labels
5. secondary copy
6. badges / chips

Never truncate CTA below a usable action word.

### 5.4 Zone-specific truncation behavior

A. headline zones
- max lines from canvas spec
- prefer shrinking tracking minimally before truncation
- do not reduce below minimum readable size
- final fallback: clamp with ellipsis

B. quote_card zones
- preserve quote meaning over author line
- if quote + author overflow: keep quote, drop author first
- if quote still overflows: clamp quote with ellipsis

C. metrics_row
- metric values never truncate mid-number if avoidable
- metric label may truncate before metric value
- if too many metrics, reduce count before reducing value legibility

D. badge rows / engagement rows
- drop lowest-priority badge first before truncating visible badges
- chips can collapse from text+icon to icon+short label to icon-only only if template allows

E. product_meta
- preserve product name over price if conflict exists
- price may hide before product name collapses below 1 line

### 5.5 Minimum readable constraints

Renderer minimums:
- headline: 2.5% of short canvas edge
- body/quote: 2.0% of short canvas edge
- chip/label: 1.5% of short canvas edge
- CTA: 1.8% of short canvas edge

If fitting requires going below minimum, truncate instead.

============================================================
## 6) MEDIA FIT DECISION TREE
============================================================

### 6.1 Media selection priority

For any media zone:
1. use slot_priority from normalized object
2. prefer exact media type requested by template role
3. prefer approved/eligible media over unapproved media
4. prefer aspect-compatible media
5. prefer subject-preserving option over aggressive crop

### 6.2 Fit modes

The renderer supports:
- cover
- contain
- subject_preserve
- smart_crop

Default priorities by zone kind:
- hero_media: subject_preserve -> smart_crop -> cover
- product_media: contain -> subject_preserve -> smart_crop
- creator_media: subject_preserve -> cover
- background_media: cover

### 6.3 Decision tree

If zone kind = product hero:
- use contain if full product integrity can be maintained and layout still feels intentional
- else use subject_preserve
- else use smart_crop
- never use destructive cover crop that cuts off essential product silhouette if subject_preserve is available

If zone kind = creator / UGC:
- use subject_preserve first
- if face/subject occupies less than required area, smart_crop around face/body
- if still weak, use cover with focal point locking

If zone kind = background:
- use cover
- add scrim if text overlays it

### 6.4 Multi-subject conflict rule

If media contains multiple competing focal subjects and the zone is narrow:
- prefer subject_preserve with detected primary subject
- if subject confidence is low, center crop with safe margins
- never allow crop that removes both product and person when either is required by template intent

### 6.5 Product integrity rule

For product-led zones:
- preserve recognizable silhouette
- do not crop through cap/nozzle/logo lockup unless explicitly allowed
- if exact fit is impossible, use contain and fill remainder with branded background

============================================================
## 7) VIDEO AUTOPLAY AND POSTER BEHAVIOR
============================================================

### 7.1 Global video rules

- only one primary motion zone may autoplay
- all autoplay video must be muted
- autoplay video must loop if duration is short-form creative background or ambient motion
- poster is required for every video slot
- if poster missing, derive from first usable frame
- if video fails load, fall back to poster image

### 7.2 Autoplay priority

Per rendered frame:
1. primary_motion_zone from canvas motion_policy
2. secondary_motion_zone only if explicitly allowed and primary absent
3. otherwise all other video zones render as poster stills

### 7.3 Template-specific autoplay guidance

A. testimonial_spotlight
- autoplay support_media only
- proof/text remains static

B. ugc_split_screen
- autoplay ugc_panel only
- if product_panel is video too, render poster unless user explicitly requested dual motion mode

C. review_collage
- autoplay center_hero only
- review cards always static

D. results_proof
- autoplay support_media only
- metrics may animate subtly as UI motion, not as media motion

E. creator_endorsement
- autoplay creator_zone only
- product_zone should default to poster or static product shot

### 7.4 Poster rendering rules

Poster must:
- represent the same crop/focal region as autoplay video
- include any required corner rounding or masking
- inherit scrim if the underlying video would require scrim
- be cached for performance and deterministic preview parity

### 7.5 Video downgrade behavior

If platform or output surface does not support video:
- render primary poster only
- preserve all overlays and scrims as if paused on poster
- do not collapse layout solely because video is disabled

============================================================
## 8) SCRIM APPLICATION RULES
============================================================

### 8.1 When scrim is required

Apply scrim whenever:
- text overlays video
- small text overlays high-contrast photography
- CTA overlays busy image area
- face/skin/lifestyle motion causes contrast instability beneath text

### 8.2 Scrim types

Allowed scrim types:
- full-zone dark gradient
- localized card-back blur
- bottom fade gradient
- side fade gradient
- solid translucent chip background

### 8.3 Selection logic

If text overlays lower portion of media:
- use bottom fade gradient

If text overlays center-floating media:
- use localized card-back blur or translucent card

If wide-format headline sits over busy media:
- use side fade or full-zone subtle dark overlay

### 8.4 Strength rules

Scrim strength should be:
- minimal when background is already low-contrast
- moderate when overlaying video
- stronger on 9:16 mobile placements where text must remain legible under fast motion

### 8.5 Never do

- never allow raw white text over uncontrolled bright video without scrim
- never let scrim cover the whole frame so heavily that product/creator loses vitality
- never add independent decorative scrims that compete with quote card surfaces

============================================================
## 9) MOBILE OBSTRUCTION HANDLING
============================================================

### 9.1 Obstruction sources

Renderer must assume possible obstructions on mobile surfaces such as:
- platform UI overlays
- captions / controls
- safe gesture areas
- CTA overlays from downstream placements

### 9.2 No-obstruction behavior

If canvas.safe_areas.no_obstruction exists:
- no critical content may render outside it

Critical content includes:
- CTA
- primary quote
- headline
- core metrics
- creator handle if it is the only identity marker

### 9.3 9:16 special handling

For vertical formats:
- keep CTA above bottom unsafe zone
- keep critical identity and proof chips away from extreme bottom edge
- do not place long quote cards where platform chrome commonly overlaps
- if bottom obstruction risk is high, move CTA upward before shrinking it

### 9.4 Reposition priority under obstruction

When content risks collision with unsafe areas, move in this order:
1. badges / chips
2. trust ribbon
3. product_meta
4. quote_card secondary lines
5. CTA only as last resort, but always keep visible

### 9.5 Minimum offset recommendations

Renderer default minimum offsets from live edges:
- left/right: 4% of canvas width
- top: 4% of canvas height
- bottom for mobile vertical: 8-12% of canvas height depending on surface

============================================================
## 10) EMPTY STATE AND FALLBACK RENDERING
============================================================

### 10.1 Empty state philosophy

The renderer should fail gracefully, not blankly.
A weak but valid frame is preferable to a broken or empty frame.

### 10.2 Fallback tiers

Tier 1: full intended render
Tier 2: simplified template render
Tier 3: emergency proof card render
Tier 4: branded fallback card

### 10.3 Simplified template render rules

A. testimonial_spotlight
- if no product media, render quote + proof bar + CTA on branded gradient

B. ugc_split_screen
- if no creator media, convert to product-led split using static social quote block

C. review_collage
- if review density too low, reduce to single review + hero product variant

D. results_proof
- if support media missing, render metrics-only version

E. creator_endorsement
- if creator media missing, convert to endorsement card with product hero and quote

### 10.4 Emergency proof card render

When only sparse content exists, render:
- background / gradient / brand fill
- brand logo if present
- one headline or quote
- one small proof signal if present
- CTA if present

### 10.5 Branded fallback card

If almost no content exists but render must still occur:
- use brand fill background
- use brand name or tagline
- use product name if present
- use CTA if present
- omit unsupported proof modules

### 10.6 Invalid render conditions

A template render is invalid if:
- no usable headline/quote and no product name and no CTA
- required metrics template has fewer than minimum metrics and no alternative proof exists
- canvas has no visible critical content after fallback attempts

In such cases, renderer should surface structured error metadata, not silent failure.

============================================================
## 11) RENDERER OUTPUT METADATA
============================================================

Each render should emit metadata including:
- template_id
- aspect_ratio
- resolved_slots
- collapsed_zones
- active_motion_zone
- poster_sources_used
- truncation_events
- fallback_tier_used
- obstruction_adjustments_applied
- warnings

Suggested shape:

```json
{
  "template_id": "ugc_split_screen",
  "aspect_ratio": "4:5",
  "active_motion_zone": "ugc_panel",
  "collapsed_zones": ["engagement_row"],
  "fallback_tier_used": 1,
  "truncation_events": [
    { "zone": "quote_bubble", "method": "clamp_lines_with_ellipsis" }
  ],
  "warnings": []
}
```

============================================================
## 12) QA CHECKLIST
============================================================

Every rendered frame should pass:
- CTA visible and inside safe zone
- primary proof visible and legible
- only one dominant motion zone
- no text on uncontrolled video without scrim
- no required zone left unresolved
- no overflow outside outer safe area
- no critical content in mobile obstruction zone
- fallback tier recorded if simplification occurred
