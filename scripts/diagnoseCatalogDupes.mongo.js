// Diagnose catalog duplication. Paste into Compass mongosh.
// Set BRAND_ID below to the brand you're auditing.

const BRAND_ID = ObjectId("<PASTE_BRAND_ID_HERE>");

print("\n══════════════ CatalogProduct totals ══════════════");
const total = db.catalogproducts.countDocuments({ brandId: BRAND_ID });
print(`total rows: ${total}`);

const bySource = db.catalogproducts.aggregate([
  { $match: { brandId: BRAND_ID } },
  { $group: { _id: "$source", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]).toArray();
print("\nby source:");
bySource.forEach(r => print(`  ${r._id.padEnd(20)} ${r.count}`));

print("\n══════════════ Duplicates by title ══════════════");
const dupes = db.catalogproducts.aggregate([
  { $match: { brandId: BRAND_ID } },
  { $group: {
      _id: "$title",
      count: { $sum: 1 },
      sources: { $addToSet: "$source" },
      externalIds: { $push: "$externalId" },
      ids: { $push: "$_id" }
  }},
  { $match: { count: { $gt: 1 } } },
  { $sort: { count: -1 } }
]).toArray();
print(`titles with >1 row: ${dupes.length}`);
print(`extra rows from dupes: ${dupes.reduce((a, d) => a + d.count - 1, 0)}`);
dupes.slice(0, 20).forEach(d => {
  print(`\n  "${d._id}"  (${d.count} rows, sources=${JSON.stringify(d.sources)})`);
  d.externalIds.forEach(eid => print(`    ${eid}`));
});

print("\n══════════════ Duplicates by imageUrl ══════════════");
const imgDupes = db.catalogproducts.aggregate([
  { $match: { brandId: BRAND_ID, imageUrl: { $ne: null } } },
  { $group: { _id: "$imageUrl", count: { $sum: 1 }, titles: { $addToSet: "$title" } } },
  { $match: { count: { $gt: 1 } } },
  { $sort: { count: -1 } }
]).toArray();
print(`imageUrls used by >1 product: ${imgDupes.length}`);
imgDupes.slice(0, 10).forEach(d => {
  print(`  ${d.count}× → ${JSON.stringify(d.titles)}`);
});

print("\n══════════════ Image inventory ══════════════");
const imgStats = db.catalogproducts.aggregate([
  { $match: { brandId: BRAND_ID } },
  { $project: {
      heroCount: { $cond: [{ $ifNull: ["$imageUrl", false] }, 1, 0] },
      altCount:  { $size: { $ifNull: ["$additionalImages", []] } }
  }},
  { $group: {
      _id: null,
      rows: { $sum: 1 },
      heroes: { $sum: "$heroCount" },
      alts:   { $sum: "$altCount" }
  }}
]).toArray()[0] || { rows: 0, heroes: 0, alts: 0 };
print(`rows=${imgStats.rows} heroes=${imgStats.heroes} alts(declared)=${imgStats.alts}`);
print(`expected detect runs (1 hero + min(alts,4) per product) ≈ ${imgStats.heroes + Math.min(imgStats.alts, imgStats.rows * 4)}`);

print("\n══════════════ Wrapper Media docs (source=catalog-product) ══════════════");
const wrapperCount = db.media.countDocuments({ brandId: BRAND_ID, source: "catalog-product" });
print(`Media rows: ${wrapperCount}`);
const wrapperByRole = db.media.aggregate([
  { $match: { brandId: BRAND_ID, source: "catalog-product" } },
  { $group: { _id: "$metadata.imageRole", count: { $sum: 1 } } }
]).toArray();
wrapperByRole.forEach(r => print(`  role=${r._id || "(null)"} ${r.count}`));

print("\n══════════════ DetectRuns from catalog-sync ══════════════");
const drByStatus = db.detectruns.aggregate([
  { $match: { brandId: BRAND_ID, trigger: "catalog-sync" } },
  { $group: { _id: "$status", count: { $sum: 1 } } }
]).toArray();
const drTotal = drByStatus.reduce((a, r) => a + r.count, 0);
print(`total: ${drTotal}`);
drByStatus.forEach(r => print(`  ${r._id.padEnd(12)} ${r.count}`));

// Per-Media run count — should be 1.0 if dedup is working.
const perMedia = db.detectruns.aggregate([
  { $match: { brandId: BRAND_ID, trigger: "catalog-sync" } },
  { $group: { _id: "$mediaId", n: { $sum: 1 } } },
  { $group: { _id: "$n", mediaCount: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).toArray();
print("\nDetectRuns per Media (should all be 1):");
perMedia.forEach(r => print(`  ${r._id} run(s) → ${r.mediaCount} media`));

print("\n══════════════ Verify partial unique index on DetectRun ══════════════");
db.detectruns.getIndexes().filter(i => i.partialFilterExpression).forEach(i => {
  printjson({ name: i.name, key: i.key, unique: i.unique, partial: i.partialFilterExpression });
});

print("\n══════════════ Done ══════════════\n");
