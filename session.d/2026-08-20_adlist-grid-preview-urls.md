# 2026-08-20 — ad.list capability executor: emit the grid preview URLs the other two ad surfaces already do

Third-surface follow-up to PR #268 (`feat/image-grid-preview-url`), which added
`services/imagePreviewUrl.js` and wired it into `routes/ads.js` `projectAd()` and
`routes/catalog.js` `GET /:id/ads-detail`, and explicitly scoped this file out.

## The gap

Three backend surfaces return Ad rows to the frontend. Two of them hand over a
downscaled Cloudinary tile variant; the third did not:

| surface | previewVideoUrl | previewImageUrl |
|---|---|---|
| `routes/ads.js` `projectAd()` | yes (video work) | yes (PR #268) |
| `routes/catalog.js` `/:id/ads-detail` | yes | yes (PR #268) |
| `services/capabilityExecutors/adList.js` | **no** | **no** |

`adList.js` backs the AI agent's chat resource-card grid (frontend
`agent/ResourceCard.tsx` → `AdThumbnail`). Every tile there rendered from the
full-resolution master — measured 1.5-4.3MB per static PNG in PR #268, against a
default page size of 10 ads and a `maxH="480px"` scrolling 4-column grid.

## The fix

Both fields wired into the per-ad projection with the derivation `projectAd()` uses
verbatim: `previewVideoUrl` for `kind === 'video'`, `previewImageUrl` otherwise,
the static one sourced from the photoreal polish when the join map has one and the
raw `renderUrl` otherwise.

**No `.select()` change was required**, contrary to the initial read of the task.
There is no stored downscaled variant to project — the builders are pure string
transforms over `renderUrl`, and `renderUrl` + `kind` were already in the
projection. The `photorealUrl` join this executor needed was *also already there*
(`loadPhotorealUrlMap`, added when the projection was widened for `AdThumbnail`),
so the change is the two fields and the two requires, nothing more.

## Verification

`scripts/verifyAdListGridPreviewUrls.js` — 11 behavioural checks driving the REAL
exported `run()` with the Mongoose query layer stubbed (no Mongo, no network).

Two things worth keeping in mind about that harness:

- **Stub order is load-bearing.** `adList.js` destructures
  `{ loadPhotorealUrlMap, loadUseImageRefMap }` from `adDisplayUrlService` at
  *require* time, capturing the function references. Overwriting those exports
  after requiring `adList` is a silent no-op, and the photoreal-preference check
  would then pass while testing a path the stubs never reached. The service must
  be patched before the first `require` of `adList`. The models are different —
  `adList` holds the `Ad`/`Brand` *objects*, so `Ad.find = …` works at any time.
- **S1 pins `renderUrl` + `kind` in the `.select()`.** Drop either and the preview
  URLs compute off `undefined`, every row looks like the legitimate
  null-`renderUrl` case, and every other check stays green.

Revert-proven with 10 hand-applied mutations — remove either or both fields, swap
the two builders, drop the `kind` gate, drop the photoreal preference, null out the
non-Cloudinary fallback, drop `renderUrl`/`kind` from `.select()`, hand-roll the
transform inline — each turns the expected check red. All 10 caught.

Suite: 179/180 in the worktree. The one failure, `verifyTitleBeatScale.mjs`, is the
known worktree artefact — the tracked `node_modules` copy is incomplete and
`NODE_PATH` only rescues CommonJS, not ESM `import`. It passes 42/42 in the main
checkout. `eslint .` clean.

## Worth knowing next time

- **`npm test` does not exist in this repo.** `package.json` has `start`, `worker`,
  `postinstall`, `video:dryrun`, `titles:test`, `lint` — nothing else. The test gate
  is the 180 `scripts/verify*.{js,mjs}` harnesses, best run via
  `node scripts/runVerifySuite.js` (parallel, ~36s).
- **`eslint` is not in the tracked `node_modules`,** so `npm run lint` fails outright
  in a worktree. Run the main checkout's binary with the worktree as cwd — the config
  is plugin-free (one rule, `no-undef`), so it resolves fine.

## Frontend

No change needed, and none made. `agent/ResourceCard.tsx`'s
`adListEntryToExpansionAd()` already passes both fields through to `ExpansionAd`,
and `AdThumbnail` already prefers them via `gridDisplayUrlFor()`. Both were added
defensively on the frontend `feat/image-grid-preview-url` branch and were null until
now because no backend surface sent them. **That frontend branch is pushed but has
no open PR** — the agent grid gets no benefit from this backend change until it
lands, so it needs one.
