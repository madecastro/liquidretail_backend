## 2026-08-10 — `ai_social_proof_led` had all but vanished. TWO causes, both fixed. MERGED + DEPLOYED + VERIFIED LIVE (PR #110, main `00c991d4`)

Owner: *"I am not seeing AI social proof led static ads being generated, why is that? I was
seeing them before."* Correct, and **measured** rather than inferred — Render logs
2026-07-30..08-06, successful `direct-image ready` events by template:

| template | renders |
|---|---|
| `ai_brand_led` | 200+ (hit the query cap) |
| `ai_editorial` | 111 |
| `ai_promotional` | 38 |
| **`ai_social_proof_led`** | **18** |
| `ai_ugc_led` | 2 |

…and **7 of those 18** logged `intent=objection_resolved(fell back from social_proof_led)`,
so even the ones that minted often didn't *look* like social proof.

**TWO INDEPENDENT CAUSES. Neither is the one I first reported — read the correction.**

**Cause 1 — the Director had no criteria for picking the style.** `Ad.template` comes from
`routing.creative_style` via `CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'`, and the
live round prompt's entire guidance was one bare enum line. The string `social_proof_led`
appeared **exactly once** in `aiCreativeDirectorService.js` — in the enum — and in **zero**
guidance. Unrecognised/absent → silently `ai_brand_led`. That default plus no criteria is
the 11:1 skew.
**CORRECTION, do not re-chase:** I first blamed the HONESTY RULE for suppressing the style.
**Wrong.** That rule constrains `social_proof_type` and two *archetypes*
(`stat_led_social_proof`, `hero_quote_overlay`) and **never mentions `creative_style`**. The
2026-07-30 `isProductScoped` brand-proof withholding still contributes, but only
*indirectly* — it empties `social_proof_signal` so nothing suggests the style.

**Cause 2 — tier coherence hard-nulled usable brand stars.** No product rating + a
comment-tier quote on frame → `resolveCoherentSocialProof` withheld brand numbers
(invariant #4) → `d.rating` undefined → `INTENTS.social_proof_led.eligible` fails (its
`core` **is** `RATING`) → `FALLBACK_ORDER` → `objection_resolved`. Quote precedence is
product → category → comment → brand, so comment-tier quotes are the *common* case. **The
4.39 star floor was NOT the blocker** — a 4.6/15,000 brand rating clears it easily; it was
withheld by tier, not by the gate.

### What shipped (3 changes, 1 new harness)

- **A. `buildPromptRound`** — real per-style selection criteria (with `brand_led` named the
  *default of last resort*), `creative_style` added to the diversity axes, and a **reserved
  slot**: when proof exists, ≥1 of 3 concepts must be `social_proof_led`. Gated on
  `hasUsableProof`, computed in JS as the **exact inverse** of the honesty rule's condition
  — they must never both fire, else the prompt demands proof and forbids it in the same
  breath (the PR #61 self-contradiction class).
- **B. `DIRECTOR_PROOF_MENU_ENABLED=true`** + **`DIRECTOR_SIGNALS_VERSION` 3.1.0 → 3.2.0**.
  The bump is mandatory, not cosmetic (cache-hit key; without it every cached artifact keeps
  the narrower brief and the flip is a silent no-op). Honesty rule amended **under the same
  flag** so it can't forbid proof the menu offers. **Flag-off restores the prompt
  byte-for-byte, original honesty string included — verified by structured diff across 5
  proof shapes × 4 formats.**
  ⚠️ **ONE-TIME SPEND, accepted:** the constant gates the *shadow* `directConcepts` path,
  which is `await`ed on live expansion → one paid re-derive per unique
  (brand,product,campaignKind,creativeIntent,platformFormat) on next request. Bounded,
  self-healing. **NOT yet sized against prod — do that before deploy.**
- **C. Owner override of invariant #4** (opt-in `allowLabeledBrandNumbers`, **default
  false**): a labelled brand rating may now sit beside a product/comment-tier quote on
  **static only**. Owner: *"We can have both and clearly demarcate brand level stars… The
  positive comment is different and better social proof than brand level stars"* / *"include
  a 'Brand Reviews' next to the stars."* Video is unchanged **by construction** — the
  default is false and only `directImageRenderService` passes true. The exception sits
  **after** both product attempts (product numbers always win; it can only ADD proof), and
  returns `source:'brand'` so `packCoherentProof` always attaches `BRAND_SCOPE_LABEL` —
  the count cannot reach a surface unscoped. Kill switch
  **`STATIC_BRAND_STARS_WITH_QUOTE=false`**, no deploy.
- **NEW `scripts/verifySocialProofRestoration.js` — 35 checks, revert-proven on 13
  mutations.** Runs standalone (no `NODE_PATH` crutch needed — verified, not assumed).

### THE ADVERSARIAL PASSES EARNED THEIR KEEP — read this before touching the exception

Two independent high-effort Grok passes on the finished diff. **28 green checks, a full
suite, and my own line-by-line read had all missed three real defects**, two HIGH. Every
finding below was reproduced by direct probe before being fixed, and each fix is
revert-proven:

1. **HIGH — an UNSCOPED rating could print.** `packCoherentProof` derives `reviewsText` from
   the review COUNT, so a stars-only brand pair (`{rating:4.7, reviewCount:null}`) returned
   `source:'brand'` with `reviewsText:null`, and `staticAdIntents`' RATING line fell through
   to a bare **`4.7 ★`** sitting beside a product/comment testimonial — no "brand reviews"
   qualifier at all. That is precisely the misattribution the owner's instruction exists to
   prevent, **and the code's own comment asserted it was structurally impossible.** Fix: a
   normalized brand count is now REQUIRED (no count → no label vehicle → refuse).
2. **HIGH — the harness could never have caught #1.** The original C3 only ever fixtured a
   brand pair WITH a count. A check that cannot fail is not a check (CLAUDE.md §5).
3. **MED — the reserved slot would have AMPLIFIED the bug.** It counted a quote or comment
   alone as "usable proof" and forced `creative_style="social_proof_led"`, but render
   eligibility is **rating-only** — so quote-only products would mint `ai_social_proof_led`
   and then fall straight back to `objection_resolved`. Fix: the slot is gated on a RATING
   being reachable.

Also fixed from the same passes: the opt-in gate was truthy so the literal string `"false"`
opted **in**; `allowBrandCountWithoutStars:true` printed a brand volume claim beside a
product testimonial while still leaving the intent ineligible (all risk, no benefit);
`hasUsableProof` counted `proof_options` ungated by the menu flag, so a stale summary could
fire the reserved slot while the unamended honesty rule demanded `"none"`; the kill switch
was documented but **not committed** to `defaults.env`; and two stale absolutes
(`"No brand fallback (R1)"`, and a JSDoc claiming product/comment quotes can never reach
brand numbers) sat directly above the branch that now contradicts them.

**A FACTUAL ERROR I WROTE, corrected here so nobody re-derives it:** I claimed that without
the `DIRECTOR_SIGNALS_VERSION` bump the proof-menu flip would be "a silent no-op". **Wrong.**
The LIVE path `directConceptsRound` has **no** `signalsVersion` cache gate and re-assembles
every round — the menu goes live the moment the flag flips. The only gate is
`aiCreativeDirectorService.js:262`, in the **shadow** `directConcepts` path. The bump buys
shadow correctness and costs one re-derive per shadow key; it is not what makes the flip work.

**Known accepted residual (pinned by C7e, not a bug):** a product pair with a sub-floor
rating but a non-zero count returns `product-count`, short-circuiting the exception, so that
shape still falls back. Fixing it means brand numbers displacing a product-tier number — a
second override nobody has approved. Most products have no product rating at all, so the
dominant case IS fixed.

**Suite: 73 scripts, 1 failing — `verifyBrandFieldNames.js`, and it is PRE-EXISTING on
main, not mine.** It correctly flags
`services/capabilityExecutors/catalogSyncFromGenericSitemap.js:28`
`.select('_id name websiteUrl shopifyUrl')` — `shopifyUrl` is not a top-level `brandSchema`
field, so that read is permanently `undefined` (the silent-`.select()` trap, CLAUDE.md §4).
Verbatim on `origin/main`; spun out as its own task.

### DEPLOYED AND VERIFIED LIVE — 2026-08-10 (PR #110, main `00c991d4`)

Merged and deployed; web + worker both `live` on `00c991d4` (`dep-d9t1k63l550s73eocn4g`, 18:37:37Z).
End-to-end run driven through the real wizard on staging (Vuori Clothing → *Tech Waffle Shirt
Jacket | Dark Salt*, `productId=6a6625155f5af85a46562ec5`, 1:1 image-only, 3 submits ≈ $0.22).
Run `run_1786388743942_0938c664`.

**RESULT — the headline defect is fixed:**

```
19:12:04  ai_promotional/1:1       intent=objection_resolved        concept=performance_knit_claim
19:12:11  ai_editorial/1:1         intent=product_first_lifestyle   concept=versatile_layer_editorial
19:12:12  ai_social_proof_led/1:1  intent=social_proof_led          concept=brandwide_rating_trust
FELL BACK count: 0 / 3
```

Three **distinct** creative styles, **no `ai_brand_led` at all** (it was 200+ vs 18 before), and the
social-proof ad resolved to `intent=social_proof_led` with **no `fell back from`**. Delivered image
reads **`4.6 ★ · (15545 BRAND REVIEWS) · "feel like second skin"`** — the scope label rendered
on-frame by gpt-image-2, verified by eye at full res.

**The MECHANISM is confirmed, not just the outcome.** The product has no rating of its own, and
`🔒 director scope — 6 brand review(s) withheld from a product concept` fired, so
`social_proof_signal.rating` was null. `hasUsableProof` therefore could only have been satisfied by
`optionHasRating` — i.e. **the proof-menu flip is what supplied the proof**, and the reserved slot is
what consumed it. The Director even named the concept `brandwide_rating_trust`, using the
brand-scoped framing the menu instructs rather than claiming the number as the SKU's own.

**⚠️ CHANGE C WAS NOT EXERCISED — do not record it as live-proven.** The quote resolved to BRAND
tier (`quote pool: product=0 category=0 brand=6 comment=0 → winner=brand`,
`quoteTier=brand`), which pairs with brand numbers through the **pre-existing** coherent path, not
through the new exception. The exception needs a **comment/product-tier** quote. It remains covered
by `verifySocialProofRestoration.js` (35 checks) and direct probes only.

**And no brand in this workspace can currently exercise it:** the exception needs a brand rating over
the 4.39 floor AND a comment-tier quote. GymShark 3.3, Pelagic 3.2, BabyBoo 4.3 are all under the
floor; Vuori clears it (4.58/15,545) but has only **2** UGC-matched products and both carry their own
product ratings, so product numbers win. Ubeauty (4.8) has zero catalog products. That is an argument
for the `brandReviews` backfill already queued elsewhere in this file.

### Still to do

1. **Size the re-derive** — still not measured (counting `CreativeDirectionArtifact` rows needs prod
   DB access). Lower risk than first written: the shadow re-derive is **lazy**, one extra call the
   first time each product is generated after deploy, not a deploy-time bulk charge.
2. **Exercise Change C for real** once a brand has both a >4.39 brand rating and comment-tier quotes.
3. **Re-run the template-mix log query** over a few days to confirm the ratio moves in aggregate —
   one run with 3 distinct styles is consistent with the fix but is not statistics.

### "Nothing running in Slack" — INVESTIGATED, and the first two diagnoses were WRONG

Owner, during the live run: *"I am not seeing anything running in slack?"* Unrelated to this change
either way. **Two hypotheses were raised and both are refuted — recorded so nobody re-chases them:**

- ❌ *"WEB boot never logs `🔔 alerts: Slack configured`, so the token is missing."* **Invalid
  evidence.** That line is emitted **only** by `worker.js:138`. `index.js` never logs it at all, so
  its absence on WEB says nothing about `SLACK_BOT_TOKEN`. The apparent web/worker asymmetry is an
  artifact of which file logs, not of configuration.
- ❌ *"runFeedService fails silently, so a missing token leaves no trace."* **False.**
  `runFeedService.slackApi` (`:286-335`) logs **every** failure mode with a `📡 runFeed:` prefix —
  429 + Retry-After, non-2xx, exception/timeout, and the HTTP-200-plus-`{ok:false}` trap CLAUDE.md
  warns about. `warnUnconfiguredOnce` (`:145`) additionally logs once per process when unconfigured.

**What is actually established.** Both non-secret gates are committed and correct:
`RUN_FEED_ENABLED=true` (`config/defaults.env:325`) and
`SLACK_ALERT_CHANNEL_STATUS=C0BMMD5AN84` (`:316`). `isConfigured()` is
`ENABLED && BOT_TOKEN && CHANNEL`, so the only unverified term is the dashboard secret
`SLACK_BOT_TOKEN` — **not read** (that env read is blocked; never print it).

**RESOLVED — THERE WAS NO DEFECT. The feed is working; the owner confirmed receiving the status feed.**
The decisive observation was **zero `📡 runFeed:` lines of any kind on WEB since the 18:37:30
restart** — no "feed disabled", no 429, no `ok=false`, no `not_in_channel`. A **successful** post logs
nothing (only failures do), so that silence was evidence *for* the feed working, not against it.
`SLACK_BOT_TOKEN` on WEB is fine and needs no change.

**METHOD NOTE worth keeping, because this cost real time.** Absence-of-a-log is only evidence if you
have first confirmed that the code emits that log on the path you are testing. Both wrong hypotheses
came from skipping that step: one assumed `index.js` logs a line only `worker.js` contains, the other
assumed silence meant swallowed errors when the code logs every failure and stays quiet on success.
Grep the emitter before drawing a conclusion from a missing line.

Still fair as a small hardening idea, independent of all the above: have the WEB process log its Slack
configuration state at boot the way `worker.js:138` does, so this is answerable from a boot log
instead of by inference.

Also re-observed in the same WEB boot log, both already known-open above and neither addressed here:
`RENDER_AUTH_TOKEN` is **EXPIRED** (`exp=2026-05-07`), and `FRONTEND_URL` still points at
`https://liquidretail.netlify.app`, the **stale** pre-transfer Netlify site.

### Also corrected here — the `wantGpt` hypothesis (carried over from `fix/brand-led-static-copy`)

That branch's only unmerged commit (`de4a31ae`) was a session.md-only correction; its code
(`7c7acf86`, `4c5bda87`) has been on main since `fc42bbcd` (2026-08-04). Folding the
correction in so it isn't lost with the branch: **the `wantGpt`/`OPENAI_API_KEY` gate fix is
a correct latent-bug fix but was NOT the cause of the empty `ai_brand_led` ads.** Measured
against prod: `enrichmentSources` contains `'gpt'` for **21/31 brands** and `summary` is
populated for the same 21 — the tier *ran*. `OPENAI_API_KEY` is set on both web and worker,
so the gate passed. The real story was the Director reading `brand.description` (a
non-existent field) instead of `brand.summary`. Do not describe the gate as the cause.

---

