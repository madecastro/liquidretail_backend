# 2026-08-24 — static social_proof_led was printing a rating CLAIM, not furniture

Three delivered ads, two brands, three surfaces. All `ai_social_proof_led`. All
rendered a rating as a headline with no stars, no numeral, no review count:

1. Soludos, `meta_feed_4_5`: "Rated 5 Stars By Everyone Who's Tried Them"
2. Soludos, `meta_stories_9_16`: same string
3. Pelagic, `pmax_landscape_1_91_1`: "5-star brand-wide rating"

(1)/(2) is the advertising-claim exposure: an unqualified universal endorsement,
almost certainly false, unsubstantiated, printed with nothing on frame to
support it. (3) is the honesty mechanism working and then being misused: the
Director's brand-tier scope disclosure (`"brand-wide rating"` /
`BRAND_SCOPE_LABEL` `"brand reviews"`) arrived, and gpt-image-2 paraphrased it
into a headline instead of drawing a widget.

Video is the contrast: Remotion composites literal furniture (`★★★★★ 5.0/5`
plus a count and a byline). Only the static path (gpt-image-2 draws all text
in-model) produces the paraphrase.

## Cause

`INTENTS.social_proof_led.text()` already emits a RATING string
(`5.0 ★ (41000 brand reviews)`). `core` is `['RATING']`, so density cannot
drop it. The model was being told to set that string *and* — in `absences()`
when a rating IS shown — **"no star row … the single rating string above is
the ONLY rating mark permitted anywhere in the frame"**.

That fence was written after 2/5 test renders drew a five-star row at 4.5
stars for a 4.8 rating. On `social_proof_led` it is the wrong fence: the
intent exists to show the rating, a sentence is the only remaining legal
mark, and gpt-image-2 "improves" `5.0 ★ (brand reviews)` into a claim
headline. The goal sentence ("many real people already bought this and rate
it highly") invited "everyone".

`social_proof_led` does not include the Director headline in SET EXACTLY
THESE STRINGS, so the measured lines were invented at image-gen time from
the rating string. The Director was *also* being told to put "brand-wide"
into copy (`PROOF MENU` example) and `copyDerivationService`'s dead-ish
canvas path still says "Headlines often paraphrase the strongest review or
numeric proof" — so the same class of claim was one `brand_led` cascade
away from printing as a BRAND LINE.

`FALLBACK_ORDER` already handles "no rating": `social_proof_led` is
ineligible and walks down. RATING is core, so "rating exists but furniture
cannot fit" is not reachable. The documented `brand_led`-with-no-headline
descent onto `social_proof_led` now demands the widget rather than a claim.

`resolveCoherentSocialProof` / `allowLabeledBrandNumbers` were not touched.

## Where the constraint went, and why

**Both layers.** The measured defect is the static image model paraphrasing
the RATING role. A Director-only ban would not have stopped gpt-image-2
from inventing "by everyone" from the rating string. A static-only ban would
leave `brand_led` (and any intent that *does* print `copy.headline`) free to
set the same unsubstantiated line as a BRAND LINE. `validateDirectorPayload`
already had the pricing-scan shape to hang a copy-family ban on; a silent
validator without a prompt line is the 2026-08-12 promotional-round lesson
(a paid re-ask learning a rule nobody stated).

Placement, to not bloat the already-doubled fidelity prompt:

- Furniture **note** sits AFTER `SET EXACTLY THESE STRINGS`, never above it.
  A prose headline cannot satisfy "star glyphs + numeral + count".
- Furniture **absence** replaces the star-row BAN on `social_proof_led`
  only. `brand_led` / `product_first_lifestyle` TRUST MARK keep the old
  fence (quiet secondary mark; their prompts are byte-identical across the
  flag).
- Goal rewrite (flag-on) drops "many real people … rate it highly".
- Director: additive `RATING IS FURNITURE, NOT A HEADLINE` line + the
  proof-menu example no longer instructs "brand-wide" as copy. Validator
  calls `copyFailsCompliance` (shared, `services/adCopyGuards.js`).

"brand-wide" / `"brand reviews"` stay as the qualifier on the number. They
are forbidden as a headline adjective, not deleted.

## Kill switch

`STATIC_RATING_FURNITURE` (default ON, `!== 'false'`). Flag-off restores:

- the previous `social_proof_led` prompt byte-for-byte (star-row ban,
  original goal, no furniture note)
- the previous Director proof-menu string and no furniture rule
- the previous validator (measured headlines are not rejected)

Unaffected intents' static prompts are byte-identical flag-on vs flag-off.

The fidelity catch-all ("if a word, numeral or mark is not in the text
above, it does not belong") would have forbidden the glyph row. Furniture
path carves that out; SET EXACTLY's "NOTHING ELSE" is overridden in the
note ("the glyph row is how that rating line is drawn"). Same
self-contradictory-prompt class as PR #61.

## Fixture matrix (`scripts/verifyRatingFurniture.js`, 130 checks)

MUST-BLOCK (measured):

- "Rated 5 Stars By Everyone Who's Tried Them"
- "5-star brand-wide rating"

MUST-KEEP (not a blanket ban on "rated"):

- "Rated 4.8 by 2,341 verified buyers"
- "Highly rated by the runners who log 50-mile weeks"

Revert-proven: flag-off IS the revert (every ON check is paired with the
OFF prompt/validator failing it). Mechanical: dropping the furniture-note
emission failed A2 (16 red); dropping the validator scan failed C1 (38 red).
Both restored.

## Files

- `services/adCopyGuards.js` (new) — detector + flag helper
- `services/staticAdIntents.js` — furniture note / absence / goal
- `services/aiCreativeDirectorService.js` — prompt line + validator
- `config/defaults.env` — `STATIC_RATING_FURNITURE=true`
- `scripts/verifyRatingFurniture.js` (new)
- `scripts/verifyStaticIntents.js` / `scripts/verifyQcInsights.js` — pin the
  new social_proof_led shape / fifth prompt flag
