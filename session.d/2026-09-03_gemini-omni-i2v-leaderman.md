# 2026-09-03 — Gemini `image_to_video` on Leaderman (ONE POST, ref0 only)

Full artifact: `scratchpad/gemini-direct/REPORT-i2v.md`,
`leaderman-omni-1.1-flash-i2v.mp4`, triples in `compare-i2v/`.

Verified first: `task: image_to_video` is documented as 1 first-frame or 2
first+last interpolation, not a 3-ref detail stack. Sent ref0 alone (pad
2000×3556). Same 4162-byte prompt as r2v (sha256 `5bb02b77…`). HTTP 200,
interaction `v1_ChdxeDJaYXItd0h1NnMxTWtQdzdmdWtRSRIXcXgyWmFyLXdIdTZzMU1rUHc3ZnVrUUk`,
10.01s 720×1280, ~$1.026 Google. Running Gemini total ~$2.06.

Looked-at: invented side-profile **FIXED** (stays product-only). Waistband
**WORSE** — `PELARIC` (G→R) on t=0/5/7.5 vs native/Atlas `PELAGIC` (SERIOUS).
Not a production substitute yet. Do not POST another Atlas 10s 9:16 Omni.
