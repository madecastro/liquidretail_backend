## 2026-08-11 — PMAX PHASE A/B LIVE + 3 DEFECTS FOUND BY END-TO-END RENDERING

All merged and deployed. **The offline suite was green for every one of these** — each was found
by looking at a delivered file, which is the transferable lesson.

| PR | what | how it was found |
|----|------|------------------|
| #128 | AI templates can build **1.91:1** | 3 of 4 concepts failed live: *"Template ai_editorial does not support aspect ratio 1.91:1"* |
| #130 | **Per-axis** safe-box margin for PMax statics | measured ink at 5.0% of width on a delivered 1200×628 |
| #131 | Title ink chosen for the **whole clip**, not the enter instant | dark text on a black t-shirt in a delivered 10s video |

### PMax is verified working end to end
- Statics deliver at **exactly 1200×628** (and 1200×1200 / 960×1200).
- Video delivers **1920×1080 @ 10.048s** — the wizard still posts `videoDurationSec: 8` and the
  PMax floor clamps it. **Do not "fix" the wizard's 8 for PMax**; the clamp is the guard.
- Clean run: `run_1786443391708_874c5eea` — 4 of 4, zero errors.

### The three defects, and why the suite missed them
1. **1.91:1 was dead on arrival.** Phase A turned the surface live but every AI template still
   declared `['1:1','4:5','9:16','16:9']`, and `layoutInputService` hard-throws outside that list.
   Nothing asked whether templates could build the size we had just shipped.
2. **Safe box used a short-side margin.** Correct typography, wrong rule for Google, whose safe
   area is per axis. On 1200×628 a 10% short-side margin is 5.2% of the width, so copy sat in the
   crop band. `pmax_portrait_4_5` had it mirrored on the vertical axis. **Meta deliberately keeps
   the short-side rule** — its geometry was diffed against main and is byte-identical.
3. **Title ink read one instant.** `inkBand … lum=0.75 … best=9.77:1` was accurate at
   `enter+0.5s`; the shot then cut to a black shirt while the text was still up. `bandStateFor`
   already took `avoid`/`busy` across time for this exact reason — luminance never got the same
   treatment. Now scored worst-case across all samples, **gated to `pmax_*` so Meta is unchanged**.

### Gotchas worth keeping
- `SHIPPING_RATIOS` derives from **live** formats, so flipping a surface live silently widens the
  legacy cartesian's ratio set. The only thing keeping it at one ratio per template is that
  `platformFormat` bottoms out at `meta_feed_1_1` — that fallback is now pinned by a harness.
- `verifyProofBeat` K6 asserted on a **literal source line**, so a correct refactor broke it. It
  now pins the intent. Watch for this pattern in other harnesses.
- The Atlas key in `~/Documents/API Keys/atlascloudapikey.txt` returns **402 insufficient
  balance**. The backend uses a *different* key (both services share it) whose balance I could not
  read — worth confirming the account is funded.

### Still open
- **Video titling truncates** headline and quote ("…Breathe Te…"). Not addressed.
- Meta 8s→10s needs a **frontend** change (`Emami-RS-Project/liquidretail`); backend honours it.
- Video cost ledger over-reports ~33%; backfill script written, dry-run-safe, **blocked on DB access**.

