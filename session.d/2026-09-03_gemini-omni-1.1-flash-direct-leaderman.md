# 2026-09-03 — direct Gemini Omni 1.1 Flash video on Leaderman (ONE POST)

Master thread. Full artifact: the Claude/Grok scratchpad
`scratchpad/gemini-direct/REPORT.md` plus the mp4, lock, usage JSON, and
looked-at pairs.

## What happened

One `POST https://generativelanguage.googleapis.com/v1beta/interactions`
with backend-web `GEMINI_API_KEY`. Model **`gemini-omni-1.1-flash`**.
Leaderman `6a986320eea5b7d839449c89` control_r1 prompt (4162 UTF-8 bytes,
Scene 2 `"on the product as already shown"`) and the three Atlas-submitted
Cloudinary URLs (pad 2000×3556 + two 3072×5504 outpaints).
`response_format`: video, `9:16`, `720p`, `duration: "10s"`, `delivery: uri`.
`generation_config.video_config.task: reference_to_video`. Background+store.
Lock written before the POST. Never retried.

HTTP 200. Interaction
`v1_ChdLaHVaYW9mVUhLTHJqTWNQMC1lMnVRcxIXS2h1WmFvZlVIS0xyak1jUDAtZTJ1UXM`
completed. File `gauc5tbwnxma` ACTIVE. Output 10.01s 720×1280 24fps
3,034,526 B, sha256 `50f1078c973e7a5812d6b1dba32ed51aa9c796eb8cdbc29bbdd47f71cb1ff8c0`.
Google echoed `duration: "10s"` on the completed object — Developer REST
field now POSTed-confirmed. Video tokens 57,920 = 10 × 5,792. Estimated
**$1.036** on Google's account (not Atlas $50). Atlas Leaderman master
was $0.90.

## Comparison (looked at pairs, not assumed %)

Direct Google is a **working 10s 9:16 3-ref path** and proves the Atlas
422 is Atlas-side. It is **not** a drop-in of the Atlas Ken Burns master:
Gemini invented a side-profile at t=2.5s that is not in the stack
(prompt forbids orbit / new angles — SERIOUS vs that contract).
Waistband at t=7.5s still reads `PELAGIC` / `BUILT FOR FISHING` / boxed
P+billfish (MINOR vs Atlas's tighter CLEAN CU; not an invented-wordmark
defect).

Do not POST another Atlas 10s 9:16 Omni. Do not POST Grok Imagine without
an explicit go-ahead. Production routing to direct Gemini needs a
task/prompt retune (`image_to_video` vs `reference_to_video`) before it
replaces Atlas.
