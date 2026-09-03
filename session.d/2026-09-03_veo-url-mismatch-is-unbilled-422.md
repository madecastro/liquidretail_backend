# 2026-09-03 — tonight's "identical veoVideoUrl" is unbilled Atlas 422, not a persist bug

Urgent verification. Do not post another 10s 9:16 Omni regenerate until the
`omni_flash-10s-portrait` channel is confirmed live.

## Verdict (certainty, not inference)

Claude's observation was real: for `7e75`, `8ea0`, `69b4`, and `cbc`, current
`veoVideoUrl` is byte-identical to the pre-run `scratchpad/masters.json`
snapshot. That is **not** Cloudinary content-dedup and **not** the model
reproducing the same defects on a new clip.

**What happened:** `mode:"full"` did reach Atlas (new prediction ids, charge-
point `renderStages.videoSubmission`, CostLog rows). Atlas then failed every
channel with HTTP 422 `The model 【omni_flash-10s-portrait】 does not exist`,
`price: null`, `outputs: []`, `executionTime: 0`. `generateForAd` never
downloaded or Cloudinary-mirrored anything, so `Ad.updateOne` of `veoVideoUrl`
never ran. QC findings are yesterday's `visionQc` — QC did not re-run.

Persist **does** overwrite on a real success. Counter-example: Leaderman
`6a986320eea5b7d839449c89` (`9c89`) — attempt 1 422'd, attempt 2 completed,
billed **$0.90**, wrote a **new** unique public_id
(`product-1788414814485-2-jvnwfa5g`), and the new Cloudinary file sha256-
matches Atlas `outputs[0]` and **differs** from the snapshot
(`574be88f…` 2,574,692 B → `886fdeb3…` 2,978,772 B).

So of the three hypothesized scenarios:

| # | claim | result |
|---|---|---|
| 1 | Model reproduced identical defects on a real new clip | **False** for the three flagged ads. No new clip. |
| 2 | `veoVideoUrl` never overwritten; paid output discarded | **Half.** URL not overwritten, yes. Paid output discarded, **no** — Atlas produced none (`outputs: []`, `price: null`) except `9c89`, which **was** persisted. |
| 3 | HTTP 202 short-circuit, decorative prediction id | **False.** Atlas has real prediction records for every id. They failed. |

Closest label: **(2) with no output to persist**, caused by Atlas routing
`duration:10 + aspect_ratio:9:16` on
`google/gemini-omni-flash/image-to-video-developer` to an internal channel
that currently does not exist. Public schema still lists duration `[4,6,8,10]`
and aspect `9:16`. Last confirmed 10s 9:16 success before the break:
`69b4` original `f04c14a029ad4ccb8acf559235d3c553` at 2026-09-02T23:37Z
($0.90). First 422: `cbc` 2026-09-03T05:28Z. The channel is **flaky, not
dead** — `9c89` attempt 2 succeeded ~05:52Z.

## Byte proof (current Cloudinary === yesterday's Atlas output)

| ad | current `veoVideoUrl` public_id | sha256 | matches yesterday Atlas `outputs[0]` |
|---|---|---|---|
| `7e75` | `product-1788370573735-60-74cuk21r` | `e4410bc6…` 3,301,071 B | yes (`da313333…`, $0.90) |
| `8ea0` | `product-1788371357555-65-1ph2h80v` | `eab91c6e…` 2,294,516 B | yes (`f29bafcc…`, $0.90) |
| `69b4` | `product-1788392354200-404-vcef4urc` | `7b02328a…` 2,687,306 B | yes (`f04c14a0…`, $0.90) |
| `cbc`  | `product-1788369678344-18-3faho7xo` | `2bb44e96…` 4,186,894 B | yes (`c1cb50ad…`, $0.90) |

`renderedAt` on all four is 2026-09-02. `updatedAt` is tonight (regenerate
settled). `renderError.at` on the three QC-fails is yesterday. QC findings
(`JANA AARS`, thumbholes, `BCILT FGR PISHING`, `LG`→`∞`) are the pre-run
`visionQc.attempts[0]` documents, word for word.

**Owner's "much much better" on `cbc` was the OLD video.** `cbc`'s tonight
prediction `da664df284134ca7b09d552335ce70b0` failed 422, no output.

## Tonight's Atlas video ledger (funded prod key)

Six ads submitted. Three attempts each is the `predictionFailed` retry
ladder (`maxAttempts: 3`) treating 422 as retryable-unbilled — deterministic
"model does not exist" should give up, and does not.

| ad | tonight preds | Atlas | billed |
|---|---|---|---|
| `6cbc` | 3 | all 422, `outputs: []` | $0 (3rd CostLog was `$1.2 estimated submitted`; reconciled to `$0 none failed` after Atlas GET `price: null`) |
| `7e75` | 3 | all 422 | $0 |
| `8ea0` | 3 | all 422 | $0 |
| `69b4` | 3 | all 422 | $0 |
| `8af4` | 3 | all 422 | $0 |
| `9c89` | 2 | 1×422 then 1×completed | **$0.90** persisted |

No discarded paid output on the three flagged ads. The only paid tonight
master is `9c89` / `93e8735c3cec441bbd7391084e335f7f`, and it is on the Ad.

## Code path (why the old URL stays)

`atlasVideoService.generateForAd` stamps `veoPredictionId` at submit
(charge-point), **before** poll. On 422, `pollPrediction` classifies
`predictionFailed`, `mayRetryAfterFailure` resubmits because
`chargeConfirmed === false`. After attempt 3 it throws. `runVideoFull`'s
`$set { veoVideoUrl: veoResult.videoUrl }` only runs after
`generateForAd` returns, which requires `uploadBufferToCloudinary` of a
downloaded buffer (`_uniqueId()` public_id — a new upload cannot reuse
`74cuk21r`). Cloudinary overwrite is off. There is no QC-fail revert of
`veoVideoUrl`.

`cbc` was left `regenerating: true`, claimed by `renderer-398b17d6` since
05:28Z, CostLog still `submitted` — worker died after the 3rd submit.
Reclaim of an unbilled failed peek **falls through to a fresh submit**
(`adRegenerateService.js` ~1237). `478f` (`6a987a081549f7076bce478f`) was
`regenerating: true`, unclaimed, about to be consumed.

**Protective halt applied 2026-09-03 ~06:04Z** (Mongo only, no Atlas POST):
`markComplete`-shaped `$set` on `cbc` and `478f` — `regenerating: false`,
claim/request cleared, pending history → `failed` with halt reason.
`veoVideoUrl` untouched. No rows still `regenerating` after that write.

## Do not

- Do not treat tonight's QC on `7e75`/`8ea0`/`69b4` as evidence about
  passthrough, Scene 2, or pad. Those ads were not regenerated as videos.
- Do not treat the owner's `cbc` verdict as a verdict on this session's
  output.
- Do not POST another 10s 9:16 Omni job until a **non-ad** catalog/schema
  check, or a single deliberately-bounded canary, confirms
  `omni_flash-10s-portrait` (or 8s 9:16) actually completes.
- Do not fold a Grok Imagine comparison into the $50 Atlas Omni budget.

## Grok Imagine comparison (researched, not spent)

Reachable. Live Atlas catalog 2026-09-03:

- `xai/grok-imagine-video-v1.5/reference-to-video` — 1–7 `image_urls`,
  duration 1–15s, 9:16, resolution cap **720p**. This is the like-for-like
  against Omni's 3-ref stack.
- `xai/grok-imagine-video-v1.5/image-to-video` — single `image_url` only.
- Native xAI Imagine (`image_to_video` / `reference_to_video` in this
  environment) is a **separate** spend path, not Atlas.

Pricing in `MODEL_CAPS` for the single-image v1.5 slug is an **unverified**
$0.50/sec upper bound (readme has no Pricing section). Do not submit until
the owner accepts a separate budget line.
