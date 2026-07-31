I'll do a hard adversarial review of the three production files — reading the full sources and the offloaded prompt, then hunting the specific failure modes you listed.Reading the remaining critical call sites, platform formats, and any leftover references to deleted symbols.Checking one more coupling issue: whether `aspectRatio` and `platformFormat` can diverge on the live render path.## Retrospective adversarial findings

### 1. Variables after early return / before assignment
**no findings** — `surface`, `dims`, `refs`, `intentKey`, `built`, `genSize`, `layers` are only read on reachable paths after assignment. `genSize` / `built.resolved` only after non-skip, non-error checks.

---

### 2. No-reference → billable edit
**no findings** — `refs.length === 0` throws at `directImageRenderService.js:421–426` before `editImage` (`:475`). Failed fetch/normalise can empty `refs`; that still hits the same throw, not a paid submit. No path throws “no reference” *after* submit.

---

### 3. `buildIntentData` fabricated / non-verbatim proof

**HIGH | `services/directImageRenderService.js:251` | nameless quotes ship synthetic attribution |**  
When a quote exists, `attribution` is taken from `quote.author_name`. Upstream `normalizeQuote` **always** fills that field with a real name **or** `"Verified buyer"` / `"Anonymous Customer"` (or even `q.source`). `buildIntentData` never treats those as absent, so `absences()` does **not** emit “no name…”, and the text block gets e.g. `attribution -> — Verified buyer`. That is not a verbatim reviewer byline; it is a constructed claim. Owner rule (absent → `undefined` so the prompt states absence) is violated for attribution.

**LOW | `services/directImageRenderService.js:243` | `rating_value: 0` becomes `"0"` |**  
`typeof … === 'number'` accepts `0`, so social-proof can become eligible with `0 ★`. Not invention of a good rating, but a nonsense proof mark. Real layout path usually omits non-numeric ratings; `0` is rare.

**no findings** on quote body: `snippet || text` is extractive; empty/whitespace snippet trims to no quote.  
**no findings** on inventing rating numbers from non-numbers (string ratings become `undefined`, not a fake value).  
**no findings** on badge (`always undefined`) or `fallback_quote` / `trusted_by_text` (not passed).

---

### 4. `staticPipeline` resolution
**no findings** — `resolveStaticPipeline` always returns `'html'` or `'direct_image'`. Only exact `'html'` (trim/lower) selects legacy. `null` / `''` / `'direct_overlay'` / typos → direct. No third value; no accidental HTML from garbage.

---

### 5. `normalizeReference`
**no findings** for the asked cases:  
- success path is always `.png().toBuffer()` (PNG signature verified on a 1×1).  
- empty/undecodable input throws inside sharp → `null`, not a zero-byte buffer.  
- dropping every ref does not silently bill; it hits the no-reference throw.

---

### 6. Deleted symbols still referenced
**no findings** at runtime. `themeFor` / overlay helpers / `PLATE_T2I_MODEL` / `fontResolverService` are not required by these three modules. Stale *comment* at `directImageRenderService.js:318` still mentions `themeFor`; that is not a load-time break.

---

### 7. Prompt: price / product name / empty-slot class

**HIGH | `services/directImageRenderService.js:141–146` + `staticAdIntents.js:425` | product name (and possible price) injected into the prompt |**  
`describeProductForPrompt` falls back to `product.title` / `layoutInput.product.name`. That string is emitted as `PRODUCT: …` while absences say “no product name” and “no price…”. A catalog title like `… $29.99` puts a **literal price** into the prompt (confirmed). Same class as handing the model a forbidden string and hoping the ban holds—especially under “reproduce this exact item” / product briefing pressure.

**no findings** on the classic v1 empty-slot defect for the text block: zero kept roles use `THIS AD CARRIES NO TEXT AT ALL`; emphasis/goal are gated on `kept_`; geometry is element-agnostic; Stories CTA is stripped and forbidden in absences.

---

### Cross-cutting geometry / delivery (rewritten path)

**BLOCKER | `services/directImageRenderService.js:98–104` | `dimsFor('16:9')` → `{1000,1000}` |**  
`renderService.CANVAS_DIMS['16:9']` is `{1000,563}`; intent surface `pmax_16_9` generates **`1536x1024`** and the geometry block describes a **landscape** least-crop. Delivery resize then uses **square** 1000×1000 (`fit: 'cover'`). Confirmed: `dimsFor('16:9')` is 1000×1000; a landscape plate is cover-cropped to a square, so PMax static ads are the wrong aspect and the geometry promises are false for the actual crop.

**HIGH | `services/directImageRenderService.js:486–488` vs `staticAdIntents.js:102–103,148–153` | delivery crop ≠ geometry crop |**  
Geometry assumes **center** crop (`cropW/2`, `cropH/2`) and tells the model those exact bands “WILL BE CUT AWAY”. Final resize uses `position: 'attention'`, which is **not** center. Empirically on 4:5, centre crop removes the declared cut-away band; attention **keeps** that band at the top edge. Copy placed in the promised safe box can be destroyed; cut-away chrome can survive. Billable image, wrong crop, text risk.

**HIGH | `services/directImageRenderService.js:304–305` + `:364` + `:448–465` | `platformFormat` and `aspectRatio` not coupled |**  
Generation size + geometry come only from `platformFormat` (default `meta_feed_1_1`); delivery size comes only from `aspectRatio` via `dimsFor`. Any desync (missing `platformFormat`, wrong default, aspect without matching surface) yields e.g. gen `1024x1024` / “no crop loss” while Sharp cover-crops to 9:16 (or the reverse). No assert that `computeSurface(surface).aspect === aspectRatio`. Production usually sets both together; the service still allows a silent wrong-gen / wrong-promise pair.

---

### Summary table

| Sev | Location | Break |
|-----|----------|--------|
| **blocker** | `directImageRenderService.js:98–104` | 16:9 / PMax delivered as 1:1 |
| **high** | `directImageRenderService.js:486–488` + geometry in `staticAdIntents.js` | attention crop contradicts center “CUT AWAY” contract |
| **high** | `directImageRenderService.js:304–305,364,448–465` | surface vs aspectRatio desync → wrong gen + wrong geometry |
| **high** | `directImageRenderService.js:251` | synthetic attribution (`Verified buyer` / `Anonymous Customer`) treated as real byline |
| **high** | `directImageRenderService.js:141–146` + `staticAdIntents.js:425` | product title / `$` can enter prompt as `PRODUCT:` |
| **low** | `directImageRenderService.js:243` | rating `0` can typeset as `0 ★` |

Surviving hunt targets: (1) UAFs, (2) zero-ref bill, (4) pipeline ternary, (5) normalizeReference PNG/empty/all-drop, (6) deleted symbol refs, (7) empty text-block / positional layout prescription class.
