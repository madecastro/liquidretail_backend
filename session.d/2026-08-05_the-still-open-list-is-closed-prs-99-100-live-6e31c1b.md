## 2026-08-05 (last) — the "still open" list is CLOSED. PRs #99, #100 (live `6e31c1b`).

**Final state, queried live: 0 unresolved charge states · 0 stranded ads · 70/70 harnesses.**

### The ledger can say "unknown" — and then resolves it (#99)

`atlasErrorPolicy`'s FALLBACK carries `charged: null` (UNKNOWN) for any shape it cannot classify;
`renderService` wrote `err.charged === true`, collapsing that to FALSE, and
`renderError.charged` was a two-state Boolean with nowhere to put the truth. **2 ads were on
record as costing nothing when Atlas may have billed them.**

`renderError.chargeState: 'charged'|'not-charged'|'unknown'|null` now carries the honest answer.
⚠️ **`charged` was NOT widened** — it still means strictly "we KNOW it was billed", so `adStage`,
`bootRecoveryService` and two harnesses keep their meaning. Don't "unify" them.

⚠️ **'unknown' IS A TO-DO, NOT A RESTING STATE.** `imageRecoveryService.settleChargeState()`
reads `price` back off the settled prediction (free GET, 30-day retention) and
`strandedRunSweeper` runs it as a second pass on the same interval — including when there is NO
stranded work, because "nothing to finish" ≠ "nothing unaccounted". **One-way by construction:**
it can only move a row from "we don't know" to a CONFIRMED figure, and an unconfirmable price
stays 'unknown' rather than being guessed to 'not-charged'.

### THE DIAGNOSIS THIS MORNING WAS WRONG — those 2 ads were MODERATION, not infrastructure (#100)

Running the new resolver against them exposed it. Atlas says, identically on every probe:
`{"code":500,"message":"Input Prompt violates policy","data":{"status":"failed","executionTime":0}}`.
The Cloudflare 502 was real but **incidental** — it masked a prompt Atlas had already rejected on
content policy. **Retrying it can never succeed.** Two bugs behind that:

1. **The moderation matcher missed the wording**, so a deterministic content rejection classified
   as `serverError`→`probe`. Added `violates? (the )?polic(y|ies)`. ⚠️ **The list stays
   ENUMERATED, never a broad `/polic/`** — a false positive marks a RETRYABLE failure permanently
   futile and discards a render that would have succeeded. Pinned BOTH directions: the live
   wording classifies as moderation, and a bare `"policy"` still classifies retryable.
2. **`peekImagePrediction` returned early on any non-200 and discarded a COMPLETE envelope.**
   Atlas serves the verdict, the error text and `executionTime:0` in a body we never parsed. It
   now bails only when there is genuinely no envelope.

Both ads settled to **`not-charged`** with the real reason. Moderation is refunded and
executionTime was 0, so that is confirmed, not assumed.

### Two measured tunings (evidence, not intuition)

- **`AI_DIRECT_IMAGE_TIMEOUT_MS` 600s → 900s.** 210 successful `gpt-image-2/edit` renders:
  p50 72.2s · p95 202.3s · p99 367.2s · **max 474.7s**. 600s was only **1.26×** the observed max
  on a model with a 5× p50→p99 spread. Billed AT SUBMIT, so patience only raises the odds of
  collecting what we paid for, and `RENDER_CONCURRENCY(24) > MAX_CREATIVES_PER_RUN(20)` means a
  straggler blocks nobody. 0 of 784 exceeded 600s — tail headroom, not a fix.
- **The `allowDiskUse` worry from #86 is RESOLVED and was UNFOUNDED.** Largest brand (458 ads):
  old indexed `.sort({generatedAt:-1})` **394ms** vs the new `$addFields`+`$sort` **164ms**. The
  new path is FASTER. Re-measure if a brand grows an order of magnitude.

### Genuinely still open (small)

- The 9 recovered ads may have `ai_brand_led`/`ai_editorial` labels swapped WITHIN a surface —
  nothing links a prediction to a template, so matching was by surface only. Same product, same
  surface, right creative; only the style tag may be off.
- `chargeState` is null on every row predating this — absence means "never assessed", not
  "not charged". A backfill would need the same log-derived prediction ids used today.

---

