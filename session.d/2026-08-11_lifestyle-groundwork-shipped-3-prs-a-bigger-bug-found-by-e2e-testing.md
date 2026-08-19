## 2026-08-11 — LIFESTYLE GROUNDWORK SHIPPED (3 PRs) + a bigger bug found by E2E testing

Live on `937c5b2a` (both services, verified: 120 log lines scanned across WEB+WORKER, zero
errors).

| PR | what | notes |
|---|---|---|
| #118 | Meta Graph API version centralized, `v19.0` → **`v26.0`** | 12 inlined copies; env var was set NOWHERE |
| #119 | sharp packshot/lifestyle classifier, image caps → 12, QC gate runtime-flippable | QC default OFF |
| #127 | classification moved to INGEST, off the paid DetectRun | four review rounds |

### ⚠️ THE BIGGEST FINDING IS NOT IN THESE PRs — read this before doing more image work

**The generic (`sitemap-jsonld`) path stores 84×100 pixel THUMBNAILS as ad-generation seeds.**
Measured live, not inferred:

- Marine Layer: **100/100** sampled products store a Shopify `_small` variant as `imageUrl`,
  and **100/100** store **zero** `additionalImages`.
- The stored seed measures **84×100**. The same file with the `_small` suffix removed is
  **2000×2372** — **565× more pixels**.
- That PDP's `/products/<handle>.js` returns **6 full-resolution images**.
- Cause: `genericCatalogResolver.imagesFromNode()` reads JSON-LD `node.image`, and
  Shopify-generated JSON-LD exposes a **1-element array pointing at the `_small` render**. So
  `additionalImages = uniq.slice(1, …)` is **empty regardless of the cap**.

**Consequence: the 4→12 cap raise in #119 is a NO-OP on that path.** The bottleneck is image
*extraction*, not capping. Do not "tune the cap" — fix extraction.

**Candidate cause of a long-standing known-open defect.** `CLAUDE.md` records "~1-in-3 static
ads render a competitor-shaped brand mark on the product", with the fix listed as
measure-and-reject rather than prompt tuning. An 84×100 reference cannot convey a logo,
stitching or construction, so the model must invent them. **Not proven causal** — but it is
cheap to test now: fix the resolution and re-measure the defect rate.

Fix shape: (1) strip Shopify CDN size suffixes (`_pico|_icon|_thumb|_small|_compact|_medium|
_large|_grande`, and `_{W}x{H}`) — anchor to the suffix immediately before the extension so
`small-batch-tee.jpg` is not mangled, and PRESERVE the `?v=` query; (2) for Shopify-backed
PDPs reached via the generic path, upgrade to the product `.js`/`.json` gallery —
`shopifyPublicIngestService` already does exactly this, Marine Layer simply was not routed to it.

### #127 took FOUR adversarial rounds. Each caught something real.

1. Classification was awaited **inside** the sequential upsert loop with **unbounded DNS** — one
   hung resolver meant the rest of a brand's catalog was never persisted. Silent data loss,
   worst on a NEW merchant's first sync.
2. The fix for (1) introduced a **silent no-op**: the budget clock still started at
   `createSession()`, so a multi-page sync burned it on Graph I/O and classified **nothing**
   while reporting nothing needed doing.
3. **Tests that could not fail** — incl. a spy built, never wired (`void spyClassify`), then
   asserting `sharpCalls === 0`: true by construction.
4. An **exploitable SSRF bypass** that ONE OF THE TWO passes missed entirely. We blocked
   IPv4-**mapped** IPv6 (`::ffff:a.b.c.d`) but not IPv4-**compatible** (`::a.b.c.d`, which Node
   normalises to `::7f00:1`). Verified by calling the predicate directly: `::169.254.169.254`
   reached **cloud metadata**; `::127.0.0.1` and `::0a00:1` also passed. Now `::/96` re-checks
   its embedded IPv4 (`::` and `::1` short-circuited ahead of it), plus NAT64 `64:ff9b::/96`
   and 6to4 `2002::/16`. Re-tested across 13 blocked forms + 4 public controls
   (Cloudflare/Google DNS v4+v6) — no over-blocking.

**Why (4) survived three rounds: the SSRF harness CLAIMED range coverage while never testing
the compatible form.** Same disease as (3). The harness now **executes all four real ingest
writers** offline instead of regex-matching them, and carries internal revert-proves.

**Standing lesson: run TWO independent review passes and adjudicate against the code, not
between the opinions.** With only the "safe" pass, an exploitable hole would have merged.

### #127 safety properties (do not regress these)

- Products persist in the upsert loop; classification is a **post-loop** pass. A hung fetch can
  never cost a merchant their catalog.
- Budget is **per-sync** and anchors to the **classify phase**. `budgetOk()` auto-starts it, so
  forgetting the explicit `beginClassifyPhase()` cannot reintroduce the no-op.
- **ONE deadline per URL** across DNS + every redirect hop + body read — not re-armed per hop.
- Connection **pinned** post-DNS via a custom `lookup`; `servername` stays the hostname so TLS
  cert verification still works. Every redirect hop re-validated and re-pinned
  (`redirect: 'manual'`).
- Truncation is always counted and logged from a `finally`; abandoned work is booked separately
  from "nothing to do".
- Deliberately does **not** use `httpScrapeClient` — it follows redirects with no hop
  validation. **That broader gap is still open** and would touch every scrape path.

Accepted + documented in code: the CPU guard is a `Promise.race` (frees the worker slot,
does NOT cancel libvips); exact-string URL keys re-download on CDN query/size churn (fails
toward a re-download, never a mislabel).

### Money note

Raising the alt cap to 12 raises **detect** spend, because every stored alt is materialized and
gets an ungated `gpt-4.1` subjects-text + YOLO call: generic **5 → 13 images (2.60×)**, the
other three paths **9 → 13 (1.44×)** per product *actually used*.
`CATALOG_DETECT_PRECOMPUTE=false` limits this to products used in a campaign. The free
ingest-time classifier is the mitigation — it makes the paid vision pass a deliberate narrow
choice rather than something that scales with image count.

**Correction to a claim made mid-session:** failed VIDEO generations are **not** billed — this
file already measured `data.price` absent on 5/5 failures vs present on 5/5 successes. A
`generation_failed` is value lost, not money spent. (Independent sample this session: **11%**
video vs **1%** image failure across 200 Vuori ads, consistent with the ~26% measured on a
smaller same-day sample below.)

### Thresholds are UNTUNED

The classifier's thresholds are intuition, not measurement. `scripts/calibrateShotHeuristic.js`
(read-only) scores them against the existing LLM `shotType` labels **and** reports lifestyle
rate by gallery position — which is the measurement that should decide any future cap change.
#127 persists the numeric signals it needs. **Run it before anything depends on the labels.**

### New flags (all in `config/defaults.env`)

`CATALOG_MAX_ADDITIONAL_IMAGES=12`, `CATALOG_SHOT_HEURISTIC_ENABLED=true`,
`CATALOG_INGEST_SHOT_CLASSIFY_{ENABLED=true,CONCURRENCY=6,TIMEOUT_MS=5000,MAX_BYTES=5000000,BUDGET_MS=120000}`.
QC's live lever is **`SystemConfig.adVisionQcEnabled`** (tri-state; beats the env var; ~5s TTL
cache) — flip it with no redeploy and no restart. `META_API_VERSION=` is blank on purpose so
the code default owns the value; **verified no Render dashboard var shadows it**.

### Tooling trap discovered (cost a diagnosis cycle)

**`grok -r <sessionId>` SILENTLY IGNORES `--cwd`** and writes to the session's ORIGINAL working
directory. A resumed session wrote a full feature into the worktree of an **already-pushed
branch**; its report cited real `path:line` numbers for work that did not exist at the target.
The only signal was one stderr line: *"Session … found locally (originally in <dir>)"*. Recover
with `git diff > patch` + copy untracked files out, `git checkout --` to restore the pushed
state, then `git apply` in the right worktree. Native modules (`sharp`) will not load in a
fresh worktree — use `NODE_PATH=<other-worktree>/node_modules`, never symlink.

### Verification harness note

`scripts/verifyCatalogFeedOrderSeeding.js` prints `all checks passed` **without an emoji** — a
green-check sweep that greps for ✅ will silently skip it. Check exit codes.

---

