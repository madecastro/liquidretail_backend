# 2026-09-03 — A/B/C score: C alone is enough

Full pixel report: scratchpad `gemini-direct/REPORT-ABC.md`.
C videos: `gemini-direct/native-generic/<short>/<short>-native-generic-r2v.mp4`.
C crops: `gemini-direct/native-generic/crops/`.

## Decision that was mine

`69b4` C first POST was HTTP 200 then Gemini `api_error` / Internal error,
`cost: null`, no video. Not a content 422. Unbilled. I treated it as a first
real attempt (unlike Atlas-outage retries, which would have hit a
deterministically dead channel). One retry, `POST-retry.lock`, never a
second. Retry completed `$1.035`.

## Verdict (my read)

**C alone is enough.** Pristine catalog originals + generic CORE, no per-SKU
marks. All four headline SERIOUS defects from A are gone, including the
stacked sleeve that B could not kill.

Marks are a fallback for a dirty Mongo stack, not a production requirement
if you seed from catalog. On 69b4, B’s marks (authored from product-only)
even *suppressed* a real catalog second line (`BUILT FOR FISHING`) that C
copied from the detail still.

Staging `<IMAGE_REF_N>` is production-viable: `shotType` already on 1,063/1,066
Pelagic catalog Media; `text[]` already answers which still has readable
marks. $0 extra spend. Caveat: `detail` ≠ logo — inspect `text[]`.

Tagged Leaderman ($1.037) vs Imagine untagged ($1.43): staging measurably
produced role-mapped CUs (waist from REF_2 at t=2.5, hem from REF_0 at t=5).
Letter correctness is provider-confounded (Imagine also spelled PELAGIC /
FISHING). No untagged-fidelity Gemini r2v exists on Leaderman.

Running Gemini this window ~$11.38. Imagine remaining ~$48.57. No Atlas
Omni 10s 9:16 POST.
