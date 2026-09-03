# 2026-09-03 — Grok Imagine v1.5 r2v, one POST, Leaderman prompt over 4096

One Atlas `POST /model/generateVideo` of
`xai/grok-imagine-video-v1.5/reference-to-video` on Leaderman
`6a986320eea5b7d839449c89` (same 4162-byte prompt + 3 refs as both Gemini
directs). Live schema mapped 10s / 9:16 / 3 `image_urls` / 720p. Atlas
OpenAPI omitted prompt maxLength; xAI rejected **4096**.

Prediction `96f0fcd79fbf4b2189e81834c4c0afd6`: HTTP 200 then `failed` in
46ms, `outputs: null`, `executionTime: 0`, **no `price` field**. Same
unbilled class as tonight's Omni 422s. Did not retry. $0.08 vs $0.50/sec
still unresolved. No video, no comparison. Full writeup:
`scratchpad/gemini-direct/REPORT-imagine.md`.
