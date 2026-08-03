# CHANGELOG — liquidretail_backend

Session-by-session history. **`session.md` is the live handoff and must stay trim** — anything
here is settled history and does not belong there. If you are looking for what is TRUE NOW,
read `session.md`; this file only answers "when did that change, and why".

Newest first.

## 2026-08-03

Prod moved `a80ae0b` → `f96e0a6` after 24 fixes had sat unpushed for a day, so every QC
observation before this date was made against a binary that was never deployed.

- **Zero-ads root cause fixed.** The Director's schema moved `media_picks` under `routing` (v3);
  the producer dual-read both shapes and logged `warnings=0` while **six** consumers still read
  the flat v2 location and discarded everything. Unified on `services/conceptProjection.js`.
  Verified live: `payloads=0` → `payloads=3`.
- **`/runs` double-charge closed.** It lacked the atomic `status:'queued'` claim `/generate` has;
  two clicks of "render next batch" billed Atlas twice for one ad.
- **Telegram → Slack**, delivery proven end-to-end by a real spend alert. The token had been
  sitting in a Render env GROUP with `serviceLinks: []`, reaching no process.
- **600-second status blind spot closed** on both render paths, piggybacked on existing poll
  ticks; verified live on video (`17s (1)` → `1m24s (5)`).
- **Untitled videos no longer reported as success** — and the fix caught a real failure on its
  first live run.
- **Grounded quotes printable again** (~82% of social proof) with attribution structurally
  stripped. `llm-web` is grounded Google Search, not fabrication; the defect was always the
  byline, including `vertexaisearch.cloud.google.com` printed as a customer 80 times.
- **Hero-image default** (`DIRECTOR_UNIVERSE_TOP_N` 10 → 1), per-product skip reasons,
  `GET /api/ads/formats`, 404 guard on unmatched ad paths, video quote gate, per-run Slack feed.
- **Docs corrected**, three false claims killed — including `CLAUDE.md` contradicting itself on
  video money in the section headed "violating these costs real cash".

## Earlier

- **2026-08-02** — Director reasoning quarantined; presets platform-grouped, Google frozen;
  `CLAUDE.md` §00 written; the video model corrected to **Omni, not Veo**; concurrency knobs to env.
- **2026-08-01** — measured 4 independent Omni submits for one campaign/product on the
  non-preset path.
- **2026-07-31** — static delivery geometry, fabricated proof and snippet inversion fixed;
  provenance found inert end to end; Render shell access set up.
- **2026-07-30** — static-ad diagnostics; the image-ref "photoreal polish" shadow stopped running.
- **2026-07-29** — Atlas facts verified: 720p and 1080p identically priced; Omni prompt cap
  20,000 chars; no image or video endpoint supports a system prompt.
- **2026-07-27** — video batch stalls diagnosed; Telegram alerting built (since replaced by
  Slack); reaper false-reap window closed.
- **2026-07-23** — pipeline cost/perf pass; `config/defaults.env` introduced.
- **2026-07-22** — generic sitemap + JSON-LD catalog scraper after the Living Spaces incident
  (livingspaces.com is not Shopify).
- **2026-07-21/22** — org repos stood up; SPA cutover to Netlify; Render backend live.
