# HANDOFF 2026-08-19/20 — PROD DB IS OUT OF STORAGE, WRITES BLOCKED

**Read this first. Then read "What you CAN do" before starting anything.**

## 🔴 THE BLOCKER — production MongoDB Atlas is full

```
error 8000: you are over your space quota, using 512 MB of 512 MB.
            Writes are blocked on your cluster.
```

Verified by a direct write probe against prod (insert rejected). **Zero CostLog rows in the last
hour; newest is 2026-08-19 22:42 UTC.**

Reported stats: `dataSize 368.3 MB`, `storageSize 121.7 MB`, `indexSize 28.4 MB` — the quota counts
total disk (indexes, oplog, unreclaimed space), so compaction *may* recover some, but treat the
cluster as full.

**Consequences, all live right now:**
- Generation can still CALL Atlas Cloud and spend real money, but **cannot persist anything** — no
  `renderUrl`, no CostLog, no status transition.
- Every dollar spent since ~22:42 UTC is billed by the provider and **unrecorded on our side**.
- This is how it was found: a $0.90 UI-chrome-guard test's CostLog insert failed. The settled price
  was confirmed straight from Atlas Cloud's `GET /model/prediction/{id}` (`status:"completed",
  price:"0.9"`, predictionId `3e579bc492bd4da785d77316c8011c3c`) rather than from our own ledger.
- It probably explains other oddities tonight, e.g. stale `CampaignRun.status` that never updated.

**Owner decision required — do not decide this yourself:** upgrade the Atlas tier, or delete data.
Deleting is destructive and nobody should pick what's expendable without Nick saying so.

**DO NOT run any ad generation until this is resolved.** It spends money and persists nothing.

---

## ✅ What you CAN do while blocked (git works, DB does not)

Everything below needs only the repo and the local verify suite:

1. **Review and merge the queued PRs** (see table). This is the highest-value work available.
2. **Run the full gate**: `npm test` (parallel runner, ~35s) or the serial loop. No DB needed.
   A fresh worktree needs `npm install --no-save https-proxy-agent@5.0.1 jsonwebtoken` first or
   several scripts false-fail on a missing module — environmental, not real. macOS has **no
   `timeout`** binary.
3. **Frontend work** — `npx tsc --noEmit` and `npm run build` from `frontend/app`.
4. **Read-only prod queries still work** (reads aren't blocked, only writes) via Render one-off
   jobs: `render jobs create srv-d1vuktqli9vc73ft07ng --start-command "..." --confirm`
   (`MONGODB_URI` already in env). **Base64-encode the script and
   `eval(Buffer.from(B64,'base64').toString())`** — raw shell quoting gets mangled and has burned
   several jobs.

## ❌ What you CANNOT do
- Any ad generation / the end-to-end test.
- **Enabling the vision-QC gate** — it needs a `SystemConfig` write. Blocked.
- Any data repair, backfill, or migration.

---

## Open PRs — all reviewed-and-held or awaiting review

| PR | what | state |
|---|---|---|
| BE #261 | five video-titling fixes (badge dedup, headline truncation, quotes, legibility) | frames reviewed and good — **needs rebase onto #266** |
| BE #262 | UI-chrome hallucination guard, **default now ON, live-verified** | CLEAN, ready |
| BE #263 | `funnelStage` + brand-scoped retailer link | ready |
| BE #264 | verify-infra hardening — **review this first** | ready |
| BE #265 | brand typeface classification | ready |
| FE #63 | intent profile / media type / retailer link | needs rebase (was stacked on merged #61) |
| BE #210 / #212 | RPD harness | **deferred by owner — leave alone** |

**#264 first.** It replaces `--affected`'s text-substring matching with real static dependency
resolution. Claim to verify: `models/Ad.js` now selects `verifyRenderFailureRecord.js`, and
`routes/ads.js` selects exactly its 4 real dependents out of 175 (narrow, not a full-suite
fallback). Everything else tonight was verified *through* that gate, so its trustworthiness matters
more than its convenience.

---

## Merged tonight
#239 Reels quote · #241 undispatched tail · #242 Pelagic price script · #243/#60 video grid preview
· #244 static moderation seed fallback · #245/#247/#248 cross-brand tenancy · #249/#251 decision docs
· #250 Reels rating row · #252 eslint .mjs · #253 Gemini ledger · #254 productName truncation ·
#257 detect-prep brand scoping (fail-closed) · #259 verify scripts stop mutating real repo files ·
#260 vision-QC three states · #266 claim substantiation gate · FE #61 12-ad cap + hover-to-play ·
FE #62 QC surfacing

---

## Open decisions for the owner (not for you to make)

1. **Atlas storage** — upgrade or delete. Blocks everything.
2. **595 delivered ads across 17 brands carry unsubstantiated advertising claims.** "Best seller"
   (368), "Top rated" (415), plus "Sustainably made", "B Corp Certified", "Carbon Neutral". **496
   have `rating: null`** — no supporting data at all. #266 stops NEW ones; the delivered set is
   untouched. The standing "forward-only" rule was decided about stranded ads, not about live
   advertising claims — do not assume it transfers.
3. **Enabling the vision-QC gate.** It has never run in production (no `SystemConfig` doc, no env
   keys) — by Nick's own earlier call. ~$0.05/ad, no untracked spend (`judgeRender` routes through
   `atlasLlmService.chatCompletion`, centrally cost-logged). Blocked on the DB anyway.
4. **Credential rotation.** An agent pulled `MONGODB_URI` and `JWT_SECRET` from prod to a local
   `.env` to verify against real data, minted a JWT for Nick's account, then deleted the file.
   **Not rotated.** Disclosed by the agent itself.

---

## Traps that cost real time tonight — don't rediscover these

- **`tsc --noEmit` and `npm run build` prove almost nothing here.** `apiJson<T>`
  (`frontend/app/src/auth/apiFetch.ts:114-126`) is an unchecked cast after `JSON.parse`, so the API
  surface is untyped at runtime. Several PRs offered a green typecheck as evidence for defects it
  structurally cannot catch. **Verify in the browser.**
- **`draft` is the DELIVERED state.** Measuring on `status:'done'` shows zero and reads as total
  failure. Delivered = has a non-empty `renderUrl`.
- **Poster frames and fixed timestamps hide real defects.** The hallucinated storefront chrome lived
  only in the first ~1s (gone by t=2.5s), so QC's quartile sampling could never see it. Two other
  defects were missed the same way. Use dense ffmpeg extraction.
- **`scratchpad/render2/out/` holds VUORI clips**, not Marine Layer 2. Two separate agents (and I)
  analysed the wrong videos from there. Check the on-screen copy matches the brand you think you're
  looking at.
- **Never strip conflict markers mechanically from a `.js` file.** That silently destroyed a commit.
  Resolve by hand and `node --check`.
- **Push early, even WIP.** Three agents died leaving finished work uncommitted and unpushed; one
  sat nine hours before rescue, another lost 369 lines that had to be recovered by hand.
- **`--effort xhigh` Grok review earns its keep on money/security code.** It caught a P0 in an
  agent's own draft, six extra missing-`brandId` sites, and five confirmed defects in already-merged
  test tooling. Invocation: `~/.grok/bin/grok -m grok-4.6 --effort xhigh --sandbox read-only
  --always-approve --cwd <repo> --prompt-file <file>` (`--prompt-file` WITHOUT `-p`).
- **Sessions open PRs; one place merges them.** #246 was self-merged without independent review and
  shipped five confirmed defects into the test tooling.

## Known-open, written up but not fixed
- `services/mediaAssignmentService.js` `attachProduct` scopes ownership by `advertiserId` only,
  never `brandId`, despite its header claiming cross-tenant attach is impossible. Real and reachable
  (an advertiser can own multiple brands). See `session.d/KNOWN-OPEN.md`.
- The wrong-colorway jacket in `pmax_video_16_9` traces to a **wrong-colour photo in Marine Layer's
  own Shopify feed** (a file named `..._Navy_...png` whose pixels are charcoal/red-chevron),
  ingested faithfully. Not a model hallucination. No colour-fidelity check exists.
- Mismatched quote marks were fixed by switching to ASCII, but **the underlying render mechanism was
  never explained** — codepoints, the font file, the shadow config, the real chrome-headless-shell
  binary and a cold rebuild were all ruled out. The `reviewer` slot's em-dash and
  `truncateWordSafe`'s ellipsis are still exposed to whatever it is.
