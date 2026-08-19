'use strict';
// Repair stale Ad.copy.productPrice snapshots for one brand.
//
// WHY: Brand.apifyDemo.shopifyUrl pointed at za.pelagicgear.com (ZAR), so
// source:'apify-shopify' CatalogProduct.price rows were ~19.99x too high. Ads
// rendered while that was true cached the wrong price into Ad.copy.productPrice
// via renderService.extractCopySnapshot() (renderService.js:1441-1451):
//     price is Number -> `$${price.toFixed(2)}`     (currency is IGNORED)
// The bad catalog rows are now soft-deleted and a correct source:'shopify-direct'
// catalog is ingested. This re-derives the snapshot string from the fresh rows.
//
// Renders are NOT reissued: the already-rendered PNG/MP4 still carries the old
// pixels. Same caveat as adPatch.js and PATCH /api/ads/:id.
//
// NOT fixed here (reported only) — other stale price snapshots per ad:
//   LayoutInputArtifact.input.product.price   (cached Number; re-ingest does not
//                                              invalidate it, layoutInputService.js:324-335)
//   Ad.titlingSnapshot.meta.price             (video chrome)
//   CreativeDirectionArtifact.inputSummary.product_signal.price
//
// RESOLUTION LADDER (most deterministic first). A row is only written when a
// tier yields ONE distinct price:
//   T1 id-exact       Ad.productId            -> live shopify-direct row
//   T2 lia-id-exact   LIA.productId           -> live shopify-direct row
//   T3 title-exact    normalizedTitle         -> live rows, one price
//   T4 handle-contain every token of the name is in the row's Shopify handle
//                     (handles carry the colorway: "Squall Jacket - Solid" ->
//                      squall-jacket-solid-petrol). One price.
//   T4b handle-compact the name with ALL separators removed is a substring of the
//                     handle with all separators removed. Catches the handles that
//                     glue words together: "Vaportek Hooded - Brush Camo (Fade)"
//                     -> vaportek-hooded-brushcamo-fade-graphite. Also tries the
//                     abbreviations this store's handles actually use (see ALIASES).
//   T5 fuzzy+ratio    titleSimilarity candidates, disambiguated by the FX ratio
//                     (needed because two live rows are BOTH titled "Squall
//                      Jacket" at $72 and $140 — title alone cannot choose)
//   T6 handle-sim+ratio titleSimilarity against the HANDLE text rather than the
//                     title, again disambiguated by the ratio.
// Anything else is left untouched and reported.
//
// A tier that finds several candidate prices is not abandoned: the FX ratio is
// used to choose between them, and the tier is then labelled "+ratio".
//
// WHAT THE RATIO IS AND IS NOT. old/new is computed for every row as an
// INDEPENDENT corroborator, and it is what makes T5/T6 and every "+ratio"
// disambiguation safe. It is a MATCH-QUALITY signal, not a price-correctness one:
// where the join is deterministic and unique (T1-T4b), the live catalog price IS
// "the current correct price" by definition, and an out-of-band ratio there most
// likely means the US store has since discounted that colorway. Those rows are
// still withheld by default and only written under ALLOW_OOB_DETERMINISTIC=1, so
// the decision is explicit and auditable rather than silent.
//
// Dry-run by default. APPLY=1 to write.

const mongoose = require('mongoose');

const BRAND_ID   = process.env.BRAND_ID || '6a4d27f47b13860ec3a2f56b';
const APPLY      = process.env.APPLY === '1';
const MAX_WRITES = Number(process.env.MAX_WRITES || 250);
// Write a row whose join was only corroborated by the ratio even when the ratio
// is out of band? Never — that combination has no evidence behind it at all.
const ALLOW_OOB_DETERMINISTIC = process.env.ALLOW_OOB_DETERMINISTIC === '1';
const FRESH_SRC  = 'shopify-direct';
const RATIO_LO   = Number(process.env.RATIO_LO || 19.5);
const RATIO_HI   = Number(process.env.RATIO_HI || 20.5);
const FUZZY_MIN_SCORE = Number(process.env.FUZZY_MIN_SCORE || 0.6);
const FUZZY_MIN_SHARED = Number(process.env.FUZZY_MIN_SHARED || 2);

// Reuse the repo's own normalizer/scorer so this cannot drift from the
// (brandId, normalizedTitle) index or from productMatchService's semantics.
let normalizeTitle, titleSimilarity;
for (const p of ['./utils/titleNormalize', process.cwd() + '/utils/titleNormalize',
                 '/opt/render/project/src/utils/titleNormalize']) {
  try { ({ normalizeTitle, titleSimilarity } = require(p)); break } catch (_) { /* next */ }
}
if (!normalizeTitle || !titleSimilarity) { console.error('FATAL: cannot require utils/titleNormalize'); process.exit(1) }

// Mirrors titleNormalize.tokens() (not exported): len>1, minus stopwords.
const STOP = new Set(['the','a','an','and','or','of','for','with','to','in','on','by','at','from',
  'is','are','be','this','that','it','as','if','so','do','not','no']);
const tokSet = (s) => new Set(String(normalizeTitle(s) || '').split(' ').filter(t => t.length > 1 && !STOP.has(t)));
const handleOf = (u) => { const m = /\/products\/([^/?#]+)/.exec(String(u || '')); return m ? m[1].toLowerCase() : null };

// Abbreviations THIS store's handles actually use, verified against live rows:
// "Womens VaporTek Hooded" -> ws-vaportek-hooded-*, "Youth Mako Deep Sea" ->
// mako-deep-sea-yth-*. Deliberately tiny and store-specific — utils/titleNormalize
// is explicitly not a synonym engine and must not become one.
const ALIASES = [['womens', 'ws'], ['mens', 'ms'], ['youth', 'yth'], ['hooded', 'hd']];
const compact = (s) => String(normalizeTitle(s) || '').replace(/\s+/g, '');
// Every compact spelling of a name worth trying against a handle.
const compactForms = (name) => {
  const base = normalizeTitle(name);
  if (!base) return [];
  const out = new Set([base.replace(/\s+/g, '')]);
  for (const [long, short] of ALIASES) {
    for (const [a, b] of [[long, short], [short, long]]) {
      if (base.includes(a)) out.add(base.split(' ').map(t => (t === a ? b : t)).join('').replace(/\s+/g, ''));
    }
  }
  return [...out];
};

// Exactly renderService.extractCopySnapshot's number branch.
const fmt = (n) => `$${Number(n).toFixed(2)}`;
const numeric = (s) => { const v = parseFloat(String(s == null ? '' : s).replace(/[^0-9.]/g, '')); return Number.isFinite(v) ? v : null };
const inBand = (r) => r != null && r >= RATIO_LO && r <= RATIO_HI;
const distinctPrices = (rows) => [...new Set(rows.map(r => r.price))];

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) { console.error('FATAL: no MONGODB_URI in env'); process.exit(1) }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const ads = db.collection('ads'), cps = db.collection('catalogproducts');
  const lias = db.collection('layoutinputartifacts');
  const bid = new mongoose.Types.ObjectId(BRAND_ID);
  const oid = (s) => new mongoose.Types.ObjectId(String(s));

  console.log(`\n=== fixPelagicAdPrices — brand=${BRAND_ID} APPLY=${APPLY} band=[${RATIO_LO},${RATIO_HI}] cwd=${process.cwd()} ===`);

  // ── 0. Prove the "nothing is synced to Meta" premise before touching a row.
  const metaMarked = await ads.countDocuments({ brandId: bid, $or: [
    { metaSyncStatus: { $ne: null } }, { metaAdId: { $ne: null } }, { metaAdsetId: { $ne: null } },
    { metaSyncedAt: { $ne: null } }, { metaAdCreativeId: { $ne: null } } ] });
  const byStatus = await ads.aggregate([
    { $match: { brandId: bid } },
    { $group: { _id: { status: '$status', variantKind: '$variantKind' }, n: { $sum: 1 },
      withPrice: { $sum: { $cond: [{ $and: [{ $ne: ['$copy.productPrice', null] }, { $ne: ['$copy.productPrice', ''] }] }, 1, 0] } } } },
    { $sort: { n: -1 } }]).toArray();
  console.log(`PREMISE totalAds=${await ads.countDocuments({ brandId: bid })} adsWithAnyMetaMarker=${metaMarked}`);
  for (const g of byStatus) console.log(`  status=${g._id.status} variantKind=${g._id.variantKind} n=${g.n} withPrice=${g.withPrice}`);
  if (metaMarked > 0) console.log(`NOTE ${metaMarked} ad(s) carry a Meta marker — EXCLUDED by the filter below.`);

  // ── 1. Candidates. metaSyncStatus is the documented flag (adPatch.js:66); the
  //      id/date fields additionally catch a partially-recorded push.
  const AD_FILTER = { brandId: bid, status: { $in: ['draft', 'failed'] },
    'copy.productPrice': { $nin: [null, ''] },
    metaSyncStatus: null, metaAdId: null, metaAdsetId: null, metaAdCreativeId: null, metaSyncedAt: null };
  const candidates = await ads.find(AD_FILTER)
    .project({ _id: 1, productId: 1, layoutInputArtifactId: 1, status: 1, variantKind: 1, copy: 1 }).toArray();
  console.log(`\nCANDIDATES ${candidates.length} ad(s) (brand + status draft|failed + productPrice set + no Meta marker)`);

  // ── 2. Lookups. Old rows are loaded INCLUDING soft-deleted — a soft-deleted
  //      row still carries the title we join on.
  const liaIds = [...new Set(candidates.map(a => a.layoutInputArtifactId).filter(Boolean).map(String))];
  const liaRows = liaIds.length ? await lias.find({ _id: { $in: liaIds.map(oid) } }).project({ _id: 1, productId: 1 }).toArray() : [];
  const liaById = new Map(liaRows.map(r => [String(r._id), r]));

  const wantIds = new Set();
  for (const a of candidates) {
    if (a.productId) wantIds.add(String(a.productId));
    const li = a.layoutInputArtifactId ? liaById.get(String(a.layoutInputArtifactId)) : null;
    if (li?.productId) wantIds.add(String(li.productId));
  }
  const anyRows = wantIds.size ? await cps.find({ _id: { $in: [...wantIds].map(oid) } })
    .project({ _id: 1, brandId: 1, title: 1, normalizedTitle: 1, price: 1, currency: 1, source: 1, deletedAt: 1, productUrl: 1 }).toArray() : [];
  const cpById = new Map(anyRows.map(r => [String(r._id), r]));

  const fresh = (await cps.find({ brandId: bid, source: FRESH_SRC, deletedAt: null })
    .project({ _id: 1, title: 1, normalizedTitle: 1, price: 1, currency: 1, productUrl: 1 }).toArray())
    .filter(r => typeof r.price === 'number' && r.price > 0);
  for (const r of fresh) {
    r._handle  = handleOf(r.productUrl);
    r._ht      = r._handle ? tokSet(r._handle.replace(/-/g, ' ')) : new Set();
    r._hcompact = r._handle ? compact(r._handle.replace(/-/g, ' ')) : '';
  }
  const freshByNorm = new Map();
  for (const r of fresh) { const k = r.normalizedTitle || normalizeTitle(r.title); if (!k) continue;
    if (!freshByNorm.has(k)) freshByNorm.set(k, []); freshByNorm.get(k).push(r) }
  const freshById = new Map(fresh.map(r => [String(r._id), r]));
  console.log(`CATALOG liaResolved=${liaRows.length}/${liaIds.length} joinRowsResolved=${anyRows.length}/${wantIds.size} freshRows(${FRESH_SRC},live,priced)=${fresh.length} distinctFreshTitles=${freshByNorm.size} withHandle=${fresh.filter(r => r._handle).length}`);

  const containMatches = (name) => {
    const t = tokSet(name);
    if (!t.size) return [];
    return fresh.filter(r => { for (const x of t) if (!r._ht.has(x)) return false; return true });
  };
  // T4b: the name, separators removed, appearing inside the handle, separators
  // removed. Anchored at the handle start when possible — a leading match is the
  // product, a mid-string one may be a colorway word colliding by accident.
  const compactMatches = (name) => {
    const forms = compactForms(name).filter(f => f.length >= 6);
    if (!forms.length) return [];
    const pre = [], mid = [];
    for (const r of fresh) {
      if (!r._hcompact) continue;
      for (const f of forms) {
        if (r._hcompact.startsWith(f)) { pre.push(r); break }
        if (r._hcompact.includes(f))   { mid.push(r); break }
      }
    }
    return pre.length ? pre : mid;
  };
  const handleSimMatches = (name) => fresh
    .filter(r => r._handle)
    .map(r => { const { score, shared } = titleSimilarity(r._handle.replace(/-/g, ' '), name); return { r, score, shared } })
    .filter(s => s.shared >= FUZZY_MIN_SHARED && s.score >= FUZZY_MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || (b.shared - a.shared));
  const fuzzyMatches = (name) => fresh
    .map(r => { const { score, shared } = titleSimilarity(r.normalizedTitle || r.title, name); return { r, score, shared } })
    .filter(s => s.shared >= FUZZY_MIN_SHARED && s.score >= FUZZY_MIN_SCORE)
    .sort((a, b) => (b.score - a.score) || (b.shared - a.shared));

  // ── 3. Resolve.
  const plan = [], skipped = [];
  for (const ad of candidates) {
    const before = ad.copy?.productPrice ?? null;
    const oldNum = numeric(before);
    const adRow  = ad.productId ? cpById.get(String(ad.productId)) : null;
    const li     = ad.layoutInputArtifactId ? liaById.get(String(ad.layoutInputArtifactId)) : null;
    const liaRow = li?.productId ? cpById.get(String(li.productId)) : null;

    // A productId pointing at ANOTHER brand's catalog row is a pre-existing data
    // fault, not a stale price. Its snapshot was never derived from this brand's
    // ZAR catalog, so re-deriving it here would invent a number. Never write.
    const foreign = [adRow, liaRow].filter(r => r && String(r.brandId) !== String(bid));
    if (foreign.length && !adRow?.brandId) { /* fallthrough — brandId not projected */ }
    if (foreign.length) {
      skipped.push({ adId: String(ad._id), status: ad.status, before,
        nameKey: (adRow || liaRow)?.title || ad.copy?.productName || '',
        productId: ad.productId ? String(ad.productId) : null,
        liaProductId: li?.productId ? String(li.productId) : null,
        reason: `cross-brand productId — row ${foreign.map(r => String(r._id)).join(',')} belongs to brand ${foreign.map(r => String(r.brandId)).join(',')}, not ${BRAND_ID}; price was never ZAR-derived, left alone` });
      continue;
    }

    // Best available product name: the joined catalog row's real title beats the
    // ad's display-normalized copy.productName.
    const nameKey = adRow?.title || liaRow?.title || ad.copy?.productName || '';

    let pick = null, via = null, note = null, score = null, shared = null, considered = [];
    // A tier that yields one price wins outright; a tier that yields several is
    // handed to the ratio, which is an independent signal from the name match.
    const tryTier = (rows, label) => {
      if (pick || !rows.length) return;
      considered = rows;
      const ps = distinctPrices(rows);
      if (ps.length === 1) { pick = rows[0]; via = label; if (rows.length > 1) note = `${rows.length} rows, same price`; return }
      const ok = rows.filter(r => inBand(oldNum / r.price));
      const okp = [...new Set(ok.map(r => r.price))];
      if (okp.length === 1) { pick = ok[0]; via = `${label}+ratio`; note = `chose ${okp[0]} from ${ps.length} prices ${ps.join('/')} by in-band ratio`; return }
      note = `${label}: ${ps.length} prices ${ps.join('/')}${okp.length > 1 ? ` — ${okp.length} of them in band, ambiguous` : ' — none in band'}`;
    };
    // Same shape for the scored tiers: a defensible name match AND an in-band ratio.
    const tryScored = (scored, label) => {
      if (pick || !scored.length) return;
      considered = scored.map(s => s.r);
      const ok = scored.filter(s => inBand(oldNum / s.r.price));
      const ps = [...new Set(ok.map(s => s.r.price))];
      if (ps.length === 1) { pick = ok[0].r; via = label; score = ok[0].score; shared = ok[0].shared;
        note = `chosen from ${scored.length} cand(s) by in-band ratio`; return }
      note = ps.length > 1
        ? `${label}: ${ps.length} in-band prices ${ps.join('/')} — ambiguous`
        : `${label}: ${scored.length} cand(s), none in band (${scored.slice(0, 4).map(s => (oldNum / s.r.price).toFixed(2)).join(',')})`;
    };

    // T1/T2 — hard id joins onto a live fresh row of THIS brand.
    if (ad.productId && freshById.has(String(ad.productId))) { pick = freshById.get(String(ad.productId)); via = 'T1 id-exact' }
    if (!pick && li?.productId && freshById.has(String(li.productId))) { pick = freshById.get(String(li.productId)); via = 'T2 lia-id-exact' }
    if (!pick && nameKey) tryTier(freshByNorm.get(normalizeTitle(nameKey)) || [], 'T3 title-exact');
    if (!pick && nameKey) tryTier(containMatches(nameKey), 'T4 handle-contain');
    if (!pick && nameKey) tryTier(compactMatches(nameKey), 'T4b handle-compact');
    if (!pick && nameKey && oldNum) tryScored(fuzzyMatches(nameKey), 'T5 fuzzy+ratio');
    if (!pick && nameKey && oldNum) tryScored(handleSimMatches(nameKey), 'T6 handle-sim+ratio');

    if (!pick) {
      skipped.push({ adId: String(ad._id), status: ad.status, before, nameKey,
        productId: ad.productId ? String(ad.productId) : null,
        liaProductId: li?.productId ? String(li.productId) : null,
        reason: note || (nameKey ? 'no candidate matched any tier' : 'no product name available') });
      continue;
    }
    const after = fmt(pick.price);
    const ratio = oldNum && pick.price ? Number((oldNum / pick.price).toFixed(3)) : null;
    // Deterministic = the name match alone identified the product; the ratio was
    // not needed to choose it.
    const deterministic = /^T[1234]b? [a-z]/.test(via) && !via.includes('+ratio');
    plan.push({ adId: String(ad._id), status: ad.status, variantKind: ad.variantKind, via, note, score, shared,
      nameKey, freshTitle: pick.title, freshHandle: pick._handle, freshId: String(pick._id),
      freshCurrency: pick.currency ?? null, before, after, changed: before !== after, ratio, deterministic,
      alternatives: considered.filter(r => String(r._id) !== String(pick._id))
        .slice(0, 4).map(r => `$${r.price} [${r._handle}]`),
      oldSource: (adRow || liaRow)?.source || null, oldDeleted: (adRow || liaRow) ? (adRow || liaRow).deletedAt != null : null,
      priorCopy: { headline: ad.copy?.headline ?? null, cta_text: ad.copy?.cta_text ?? null, quote: ad.copy?.quote ?? null,
        productName: ad.copy?.productName ?? null, productPrice: before } });
  }

  // ── 4. Report + partition.
  const changing = plan.filter(p => p.changed);
  const noChange = plan.filter(p => !p.changed);
  const oob      = changing.filter(p => !inBand(p.ratio));
  const writable = changing.filter(p => inBand(p.ratio) || (p.deterministic && ALLOW_OOB_DETERMINISTIC));
  const held     = changing.filter(p => !writable.includes(p));
  const ratios   = changing.map(p => p.ratio).filter(r => r != null).sort((a, b) => a - b);
  const nonUsd   = changing.filter(p => p.freshCurrency && p.freshCurrency !== 'USD');
  const byVia    = {}; for (const p of changing) byVia[p.via] = (byVia[p.via] || 0) + 1;

  console.log(`\n--- PLAN ---`);
  console.log(`resolved=${plan.length} changing=${changing.length} alreadyCorrect=${noChange.length} unresolved=${skipped.length}`);
  console.log(`byTier ${JSON.stringify(byVia)}`);
  if (ratios.length) console.log(`ratio(old/new) min=${ratios[0]} p50=${ratios[Math.floor(ratios.length / 2)]} max=${ratios[ratios.length - 1]}`);
  console.log(`writable=${writable.length} heldForReview=${held.length} outOfBand=${oob.length} nonUsdFreshRow=${nonUsd.length}`);
  if (nonUsd.length) console.log(`!! non-USD fresh row(s) — the hardcoded "$" would be wrong: ${nonUsd.map(p => `${p.adId}:${p.freshCurrency}`).join(', ')}`);

  console.log(`\n--- WILL WRITE (${writable.length}) ---`);
  for (const p of writable) console.log(`CHG ${p.adId} ${p.status}/${p.variantKind} ${p.before} -> ${p.after} x${p.ratio} ${p.via}${p.score != null ? ` score=${p.score.toFixed(2)}/sh=${p.shared}` : ''} | "${p.nameKey}" -> "${p.freshTitle}" [${p.freshHandle}]${p.note ? ` (${p.note})` : ''}`);
  if (held.length) { console.log(`\n--- HELD FOR REVIEW, NOT WRITTEN (${held.length}) — ratio outside [${RATIO_LO},${RATIO_HI}] ---`);
    for (const p of held) console.log(`HOLD ${p.adId} ${p.before} -> ${p.after}? x${p.ratio} ${p.via} | "${p.nameKey}" -> "${p.freshTitle}" [${p.freshHandle}]${p.note ? ` (${p.note})` : ''}${p.alternatives.length ? ` | other candidates: ${p.alternatives.join(', ')}` : ' | NO other candidate'}`) }
  if (noChange.length) { console.log(`\n--- ALREADY CORRECT (${noChange.length}) ---`);
    for (const p of noChange) console.log(`OK_ ${p.adId} ${p.before} ${p.via} | "${p.freshTitle}"`) }
  if (skipped.length) { console.log(`\n--- UNRESOLVED, NOT TOUCHED (${skipped.length}) ---`);
    for (const s of skipped) console.log(`SKIP ${s.adId} ${s.status} before=${s.before} reason=${s.reason} | "${s.nameKey}" pid=${s.productId} liaPid=${s.liaProductId}`) }

  if (!APPLY) { console.log(`\nDRY RUN — nothing written. APPLY=1 would write ${writable.length} row(s).`); await mongoose.disconnect(); return }
  if (nonUsd.length) { console.log(`\nREFUSING TO APPLY — non-USD fresh row(s) present.`); await mongoose.disconnect(); process.exit(2) }
  if (writable.length > MAX_WRITES) { console.log(`\nREFUSING TO APPLY — ${writable.length} > MAX_WRITES=${MAX_WRITES}.`); await mongoose.disconnect(); process.exit(2) }

  // ── 5. Write. The Meta guards are RE-ASSERTED in the update filter and the old
  //      value is pinned, so a row synced or re-rendered since the read is skipped
  //      rather than clobbered.
  console.log(`\n--- APPLYING ${writable.length} write(s) ---`);
  let ok = 0, missed = 0;
  for (const p of writable) {
    const res = await ads.updateOne(
      { _id: oid(p.adId), brandId: bid, status: { $in: ['draft', 'failed'] }, 'copy.productPrice': p.before,
        metaSyncStatus: null, metaAdId: null, metaAdsetId: null, metaAdCreativeId: null, metaSyncedAt: null },
      { $set: { 'copy.productPrice': p.after, updatedAt: new Date() } });
    if (res.modifiedCount === 1) { ok++; console.log(`WROTE ${p.adId} ${p.before} -> ${p.after}`) }
    else { missed++; console.log(`MISS_ ${p.adId} matched=${res.matchedCount} modified=${res.modifiedCount} — changed under us, left alone`) }
  }
  console.log(`\nwrote=${ok} missed=${missed}`);

  // ── 6. Verify: re-read and assert ONLY copy.productPrice moved.
  console.log(`\n--- VERIFY (re-read; asserting no other copy.* key moved) ---`);
  const after = await ads.find({ _id: { $in: writable.map(p => oid(p.adId)) } })
    .project({ _id: 1, copy: 1, status: 1, metaSyncStatus: 1 }).toArray();
  const afterById = new Map(after.map(a => [String(a._id), a]));
  let bad = 0, verified = 0;
  for (const p of writable) {
    const a = afterById.get(p.adId);
    if (!a) { console.log(`FAIL ${p.adId} vanished`); bad++; continue }
    const drift = [];
    for (const k of ['headline', 'cta_text', 'quote', 'productName']) {
      const now = a.copy?.[k] ?? null;
      if (now !== p.priorCopy[k]) drift.push(`${k}: ${JSON.stringify(p.priorCopy[k])} -> ${JSON.stringify(now)}`);
    }
    const nowPrice = a.copy?.productPrice ?? null;
    const keys = Object.keys(a.copy || {}).sort().join(',');
    if (drift.length) { console.log(`FAIL ${p.adId} COLLATERAL DRIFT: ${drift.join('; ')}`); bad++ }
    else if (nowPrice !== p.after) { console.log(`FAIL ${p.adId} price=${nowPrice}, expected ${p.after}`); bad++ }
    else { verified++; console.log(`VERIFY ${p.adId} productPrice ${p.before} -> ${nowPrice} | headline/cta_text/quote/productName unchanged | copyKeys=[${keys}]`) }
  }
  console.log(`\nRESULT applied=${ok} verifiedClean=${verified} failures=${bad}`);
  await mongoose.disconnect();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1) });
