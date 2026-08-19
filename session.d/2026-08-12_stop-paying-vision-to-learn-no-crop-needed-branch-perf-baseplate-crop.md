## 2026-08-12 — stop paying vision to learn "no crop needed" (branch `perf/baseplate-crop-order`)

`resolveBasePlateVideoUrl` used to call `detectClipBoxes` unconditionally, then
`decideBasePlateCrop`. A 9:16 target on a 9:16 master paid ~3 serial vision
calls to be told `full-frame`. Measured: 48 calls / 153.6s / $0.169 on one run.

This is a **reorder**, not a redesign. `cropCouldBeNeeded` is the cheap
predicate (`decideBasePlateCrop` with `head=null`; true iff `no-face-quorum`).
The orchestrator evaluates it after dims, before vision. Crop-needed path is
unchanged. Fail-open: if the predicate and decide ever disagree, vision still
runs (cannot persist a `no-face-quorum` skip without detecting).

Keep-out is preserved: a full-frame skip writes **no** `facesComputed`, so
`ensureFaceDetectionForKeepOut` still pays once if faces aren't already on the
ad (inherited plate / prior crop pass). Not twice.

Harness: `scripts/verifyBasePlateCropOrder.js` (spy, not source-text;
revert-proven — short-circuit removed → C1/C2/C5/D1/D2/E2 red).

**Residual that could not be avoided:** TITLE_FACE_KEEPOUT on + no cached
faces. The 3 vision frames move from the crop path to keep-out. Same money,
different question ("where are the heads"). Real savings when keep-out is
off, or when a sibling/master already stamped `facesComputed`.
