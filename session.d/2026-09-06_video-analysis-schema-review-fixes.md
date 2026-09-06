# 2026-09-06 — videoAnalysis schema comment (adversarial-review fix)

Paired with adgen `.wt-video-analysis-swap` / `feat/video-analysis-swap`.

The `Ad.videoAnalysis` Mixed declaration is unchanged. The comment that
justified it claimed a backend `save()` would strip an existing value.
A hydrate-then-save of a doc that already carries `videoAnalysis` does
**not** strip it (reviewer-measured, both pre- and post-diff schema).

The real hazard: a backend-authored **write** (`new Ad(...)`,
`Model.castObject(...)`, an `updateOne` `$set`) omits undeclared paths
under Mongoose strict mode. Comment at `models/Ad.js` now says that.

No chain / rate / schema-shape change in this commit.
