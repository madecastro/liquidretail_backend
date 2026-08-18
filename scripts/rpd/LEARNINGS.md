# RPD experiment log

One row per meaningful run. Newest first. Add: date, spec, settled spend, gallery URL, takeaway.
(The gallery holds the full notes; this file is the index everyone can skim.)

| date | spec | spend (settled) | gallery | takeaway |
|---|---|---|---|---|
| 2026-08-18 | static-fidelity-block-ab | $0.2168 (4 cells: gpt-image-2/edit $0.072272 x2, -developer/edit $0.036136 + $0.04) | _local; publish pending Access gate_ | **Null result, recorded as such:** replacing the whole PRODUCT_FIDELITY block with a short product-specific version did NOT measurably beat the canonical block at n=1/arm — both arms preserved the printed logo lockup and its text and invented nothing. **Price points now measured** (the harness refuses to price unmeasured quality/size): standard $0.0723, developer $0.0361 — the developer variant really is ~half, and both matched the estimate table within $0.0005. Submit+poll 58-62s per plate. |
| 2026-08-18 | rpd-validation-crossfade-ab | $0.90 (2 × $0.45, Omni dev 4s 1080p) | https://94a4fbb8.rs-rpd.pages.dev (project: rs-rpd.pages.dev) | The transitions directive is live-effective: baseline shows mid-crossfade ghosting at ~1.2s/~2.5s; a one-line "hard cuts only" patch removed it in every sampled frame. Both arms hallucinated a neck-tag view absent from the seed (fidelity class, model-side). Titling chrome validated via the free resume pass (canonical preset, Stories safe zone); fixture proof-copy defaults removed the same day — proof fields render only when supplied. 4s settled price $0.45 vs $0.60 formula (~25% over, same direction as 10s). Cold Cloudinary transform 1044ms; queue→terminal 91–122s; Atlas publishes executionTime=0 on this model — use queueToTerminalMs. |
