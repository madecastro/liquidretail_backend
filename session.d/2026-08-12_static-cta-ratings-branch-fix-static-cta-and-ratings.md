## 2026-08-12 — static CTA + ratings (branch `fix/static-cta-and-ratings`)

Two creative-quality defects on the delivered AllBirds Cruiser statics
(`run_1786555875841_2ddf9739`). Diagnosed against live Render logs, then
fixed only what was actually a code bug.

**DEFECT 1 — 9:16 had no CTA.** Not a safe-box squeeze. Live:
`meta_stories_9_16 … intent=objection_resolved … text=1` vs 1:1 / 4:5 /
1.91:1 `text=2`. `SURFACE_POLICY.meta_stories_9_16.drawCta` was `false`, so
`buildPrompt` stripped `CTA BUTTON` and absences forbade a button. Usable
Stories height is ~1334px vs 1:1's ~901px. Fix: `drawCta: true` on Stories.
PMax CTA policy is unchanged. Stories budget 3 now sacrifices SUBHEAD and
keeps the button (CTA is not in `SACRIFICE_ORDER`).

**DEFECT 2 — no rating on any of the four.** Not a code bug. Live:
`proof: source=product-count rating=none count=11 quoteTier=product` then
`intent=objection_resolved(fell back from social_proof_led)`. Eligible did
**not** pass hollow. Product 3.2 / 11 reviews failed the star floor, the
count produced `product-count` (accepted residual C7e — brand stars cannot
displace a product-tier number), and descent walked to `objection_resolved`.
`Ad.template` staying `ai_social_proof_led` is the *requested* template;
delivered intent is `Ad.intentResolution.delivered`. Do not invent a rating.

Harness: `scripts/verifyStaticCtaAndProof.js` (43 checks, revert-proven:
`drawCta:false` fails A1/A2; always-eligible `social_proof_led` fails B1).
The three `allowLabeledBrandNumbers` constraints are pinned by calling
`resolveCoherentSocialProof`.
