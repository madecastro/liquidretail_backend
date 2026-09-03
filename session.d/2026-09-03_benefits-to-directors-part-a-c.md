# 2026-09-03 — benefits-to-directors Part A + Part C

Worktree `/Volumes/Sayulita/Projects/RS/.wt-benefits-directors`, branch
`feat/benefits-to-directors`. **Not committed.** Builds on Part B (always-honour
cascade) + Part D (stackFit multi-slot) already in this tree.

## Measured corrections applied (not the original design)

- **C1** item char cap is **56**, not 40. Longest live `short_benefits` string
  is 42 chars; slotContent's 40 is a render-time display cap, a different
  concern. Harness asserts a 42-char string survives intact.
- **C2** cap at **5**, never truncate below **3** when ≥3 exist. Prod
  distribution (166 benefits-bearing artifacts): 3×12, 4×153, 5×1 — 100%
  already ≥3. Both directors see at least 3 lines whenever at least 3 exist.
- **C3** coverage is **~1%** (21 of 2192 live products). The artifact is
  written at RENDER (`buildLayoutInput`); the Director runs at EXPANSION.
  Empty is the COMMON case: cheap, silent, labelled, never an error, never a
  derivation trigger. Owner accepted; a catalog backfill is being costed
  separately.
- **C4** do **not** add a benefits slot to any funnel preset JSON. Owner:
  "Benefits should only be shown when the director thinks they are
  appropriate." `remotion/presets/canonical-*.json` untouched.

## Part A — titling director sample

`services/titleSpecContentSample.js`, imported once from
`runModifyTitleSpec`. Benefits via `resolveField(DEFAULT_META_CASCADES.benefits)`
(same cascade titling uses). Specs via exported `normalizeProductSpecs`.
Two-step query on indexed fields: `CatalogProduct.find({brandId,deletedAt:null})
.sort({detailsRefreshedAt:-1,_id:-1}).limit(20)` then
`LayoutInputArtifact.find({productId:{$in}}).sort({createdAt:-1}).limit(12)`.
`createdAt` is NOT indexed — limit stays tight. No `schemaVersion` filter
(buildMetaForAd :944-957). Does not call `buildMetaForAd`.

Empty sample still emits the labelled section. Live-content labelling is
load-bearing (`NOT copy` / `bind:["benefits"]` / no `{literal:[...]}` / no
`meta.specs` slot). `benefits_stats` includes `{n_products_sampled,
item_count:{min,median,max}, max_item_chars}`; when min≥3 the floor sentence
is explicit.

Addition 1: BENEFITS FORMATTING block (proof/close not hook-hero because
`planGroupFit` never drops the first contentful row; maxItems 3 on
vertical/reels; `scrim:"none"`; `itemDelaySec` is a fraction, 0.12 not 1.5s;
bullet+stack default).

## Part C — static Director optional benefits

`assembleSignals` attaches `product_signal.benefits` next to specs when
`DIRECTOR_PRODUCT_BENEFITS === 'true'`. Source: newest
`LayoutInputArtifact.findOne({productId})` — **plain read of an already-
existing artifact**. Never `buildLayoutInput`, never `fetchAndCache`, never
LLM, never write. Miss → `[]`. Flag-off omits the key entirely (same trick as
`category_signal`) so `buildPromptRound` is byte-identical to pre-change.

Prompt: benefits MAY colour a GROUNDING editorial line (labelled DERIVED,
Gemini-authored, not verified facts; specs remain the fact source) and sit
beside specs on COPY allowed-sources as derived/optional. NULLED HEADLINE
escape hatch unchanged (specs+description, not benefits). HONESTY RULE /
PROOF-LED / social_proof_led eligibility **untouched** — benefits are not
proof. `DIRECTOR_SIGNALS_VERSION` 3.4.0 → **3.5.0**.

## Addition 2 — `LAYOUT_DERIVATION_MODEL`

`layoutInputService` used `GEMINI_SEARCH_MODEL || 'gemini-2.5-pro'`;
`geminiSearchProvider` uses the same var with default `'gemini-2.5-flash'`.
Var was unset, so each got its own default (CostLog: layout_derivation on
pro). Setting the search var would have silently retargeted every layout
derivation. Now `LAYOUT_DERIVATION_MODEL` default `gemini-2.5-pro`. Zero
behaviour change today. `geminiSearchProvider` / `productDetailsService`
untouched (`productDetailsService.js:347` still comments about pointing
`GEMINI_SEARCH_MODEL` at Pro later).

## Harnesses

- `scripts/verifyTitleSpecContentSample.js` (new) — cascade, caps, empty
  labelled section, formatting strings, userMsg placement. Revert-prove:
  drop `sampleBlock` from compose → fail.
- `scripts/verifyDirectorPrompt.js` (extended) — both arms of
  `buildPromptRound`; HONESTY RULE + PROOF-LED byte-identical; E6 = 3.5.0;
  E5 still forbids `product?.shortBenefits`.
- `scripts/verifyDirectorBenefits.js` (new) — stubbed `assembleSignals`
  attach / omit / `[]`; structural money guard (zero `buildLayoutInput` /
  derivation writers); LAYOUT_DERIVATION_MODEL split. Revert-prove: inject
  `buildLayoutInput` → fail; restore `GEMINI_SEARCH_MODEL` read → fail.
