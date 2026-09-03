# scripts/wip/

Work-in-progress scripts deliberately kept OFF the `scripts/verify*.{js,mjs}`
glob `npm test` runs, so an unfinished check can't silently fail the suite
or get "fixed" by loosening it under time pressure.

## docCitations.needsWork.js

Attempt at a harness that fails when a comment/doc cites a code artifact
that no longer exists (motivated 2026-09-03: a stale comment describing a
deleted `titlingResumeService.js` as live, carrying a "do not remove"
instruction, survived 10 days across two repos). Runs; found real issues
in an earlier pass. NOT ready to wire in: on the current tree it reports
62 findings and every one manually spot-checked is a false positive —
third-repo (frontend SPA) function names it has no visibility into,
local `const` thresholds misread as external env-var citations, an
English formula placeholder (`TARGET_PER_PRODUCT`) parsed as a citation,
and the harness matching its own example literals inside its own source.

Needs: env-var detection narrowed to require explicit `process.env`
proximity (not any bare SCREAMING_SNAKE_CASE token), a check that the
token isn't already a local identifier in the same file, and either
knowledge of the frontend repo's existence or a rule to skip its
"pages/X's function()" prose citations. Do not add to the verify glob
until the false-positive rate is near zero — see CLAUDE.md §5: a check
that cannot fail is not a check, but a check that always fails on the
same reasons isn't one either.
