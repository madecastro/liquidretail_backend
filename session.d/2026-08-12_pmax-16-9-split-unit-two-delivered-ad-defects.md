## 2026-08-12 overnight (last) — PMax 16:9 SPLIT UNIT + TWO DELIVERED-AD DEFECTS

Ten PRs merged and deployed (#162–#174). Two of them fix ads that were already
shipping broken; the rest build a new creative unit that is **inert until
`PMAX_SPLIT_VIDEO=true`**.

### The double-title defect (#174) — was corrupting delivered 9:16 ads

A parallel session pulled real files off Cloudinary and found a shipped Marine
Layer 9:16 ad printing **two different copy strings interleaved glyph-over-glyph**
— hook headline and proof quote on one line, illegible. 1 of 4 sampled.

**It is not a re-titled video.** That was the natural first guess and it is wrong:
a double composite repeats the SAME text; these were different strings.

`Canonical.jsx` groups slots by `${phase}|${anchor}` and positions each group's
container by **anchor alone**. Items inside a group stack; two groups sharing an
anchor do not — they overlay. canonical.json vertical had `hook` exiting at 2.4
with a **0.6s ramp** (visible to 3.0) while `proof` entered at **2.7**.

Reads as "intermittent" only because whether you SEE it depends where the frame
lands in that handoff, and `specTimeScale` widens the window on longer clips.

Fixed across **11 presets** (canonical.json, 3 canonical-*, 6 brand presets) by
`verifyNoDoubleTitledBand`, which asserts the invariant everywhere. **The
detector measures RAMP-INCLUSIVE visibility** — comparing bare enter/exit points
is exactly what let a 0.6s ramp hide from every prior check. One instance was a
**3.10s** overlap where `productName`/`rating` carried `exitAtSec:null` and held
under the proof quote.

### Copy truncation — the cap is not the cutter

Owner: "PMax titling is a mess and truncates differentially to Meta." Root cause
is NOT that Meta trims more thoughtfully — `TEXT_CHAR_CAP` is a single global
table (`headline:72`) applied with no knowledge of format, width, lines or font.
Meta's layout simply happened to fit 72.

**But the delivered Meta vertical defect is subtler and worth remembering:**
`"The ridiculously soft sweatshirt you'll live in all…"` is ~51 chars — UNDER the
72 cap, so the cap never fired. **CSS `-webkit-line-clamp: 3` did the cutting.**
If the cap is too generous to protect the layout, the browser truncates instead,
and a clamp cut is not word-safe in any way we control.

The model that predicts BOTH real observations:
```
chars ≈ (usable width px × maxLines) / (0.70em × font px)
  landscape 883×2/(0.70×72)   = 35  → matches the observed 35-char cut
  vertical  972×3/(0.70×81.6) = 51  → matches the measured ~51-char cut
  × 0.91 safety → 32 / 46 = videoHeadlineService's OWN documented budgets
```
Width-fraction alone cannot express this (vertical scales to 1.0 and keeps 72).
In flight at time of writing — see the open branch.

### Funnel variants were cosmetic re-skins

The three PMax retitles printed **identical headlines**.
`candidatesFromConcepts` flattened every concept into one pool and ignored
`routing.funnel_stage`; `selectVideoHeadline` picks the best-FITTING candidate,
a deterministic function of that pool. The Director prompt forbids exactly this
("not cosmetic variations of one ad") — the distinct copy existed, nothing asked
for it by stage. Now stage-aware **ordering, not filtering**, so a stage with
thin copy still falls back rather than rendering empty.

**Known remaining half (owned by the "Product ads UI fixes" session):** the
Director can legally return three NULL headlines that all cascade to
`brand.tagline`, in which case per-stage selection still picks three identical
strings. Selection can only choose among what generation produced.

### The 16:9 split-stage unit (#162–#171), all behind `PMAX_SPLIT_VIDEO`

Subject anchored one side, scene generatively extended to the other, copy beats
in that negative space. Notes worth keeping:
- **#162 is a live fix, not part of the unit:** `landscapeYt` bottom clamp was
  0.20 against a **measured 0.36** blocked band (Google's published safe-zone PNG,
  pixel-measured: clear rows are y=39..692 of 1080). Every PMax landscape ad was
  putting copy under the player chrome.
- Omni supports 16:9 natively; the master is billable (~$0.90–1.20 at the 10s
  PMax floor) and nothing derives from it.
- The old landscape camera script assumed a CENTERED subject in three places
  (pan left→right, "central band" Frame line, and a lifestyle centre-safe clause)
  — all three would fight an anchored subject.
- A pre-spend density gate (~$0.01–0.02) judges the copy half BEFORE the ~$1
  master; it checks a peak as well as a mean, because a panel averaging calm with
  one dense corner still wrecks a line of type.
- Remotion had **no horizontal placement axis** before this; `panelColumnStyle`
  is the new primitive.

### Cross-session boundaries (agreed in writing)

- **Mine:** selection + render — `videoHeadlineService`, `brandScriptExecutor`,
  `slotContent.js`, the presets, `safeZones.js` (`landscapeYt`, `panelColumnStyle`).
- **Theirs:** generation — `aiCreativeDirectorService`, `directImageRenderService`;
  plus Meta video derivations (`campaignAdsGenerationService`, `platformFormats`)
  and an additive `stories` safe zone.
- **Theirs to fix, flagged as MONEY-critical:** `Campaign.adKinds` schema-defaults
  to `'both'` and no route writes it, so a static-only request queues a billable
  Omni video nobody asked for — and `selectAdsForRun` is kind-blind and drains
  `renderRoute:'veo'` FIRST, so the unasked render goes first.

