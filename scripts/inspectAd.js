'use strict';
// READ-ONLY production inspector for a single Ad (or a few) by _id.
//
// WHY THIS EXISTS. Diagnosing a delivered-creative defect ("this ad has
// overlapping titles", "this one shipped white-on-white") almost always starts
// with the same two questions: what does the Ad row actually say, and where is
// the delivered asset? Answering that ad-hoc meant hand-rolling a
// `node -e "mongoose.connect(...)"` one-liner every time — an unreviewable
// blob of code carrying a production credential, written fresh under time
// pressure, with nothing structurally preventing a typo'd `updateOne` or a
// full-collection scan. That is the wrong shape of tool to point at production,
// and it is correctly treated as high-risk by tooling that gates such commands.
//
// This script is the narrow, reviewable alternative: ONE committed file, doing
// ONE thing, incapable of writing (see the invariants below), which can be
// audited once and then trusted. It is a DEBUG tool for humans and agents
// investigating a specific ad — not part of any pipeline and not imported by
// any service.
//
// ── WRITE-SAFETY INVARIANTS (do not weaken these) ─────────────────────────
//   1. The ONLY driver calls used are `findOne` / `find` — both read-only.
//      There is no updateOne/insertOne/deleteOne/bulkWrite/aggregate-with-$out
//      anywhere in this file, and none may be added.
//   2. It never takes a filter from the caller. The caller supplies ObjectId
//      STRINGS only; the query is always `{_id: {$in: [...ObjectIds]}}`, built
//      here. There is no path to an arbitrary query, so no accidental
//      full-collection scan and no injected operator.
//   3. Field output is an explicit allow-list (DEFAULT_FIELDS / --fields).
//      A whole raw document is never dumped, so a stray PII-bearing field
//      cannot leak into a transcript by default.
//   4. It connects, reads, prints, disconnects. No lingering handles, no
//      lease, no claim, no side effect on any collection.
//
// ── CREDENTIAL ─────────────────────────────────────────────────────────────
// Never committed and never passed on the command line (a CLI arg would land
// in shell history and in this repo's own logs). Resolution order:
//   1. process.env.MONGODB_URI
//   2. process.env.ADGEN_MONGODB_URI_FILE  (path to a file holding the URI)
//   3. ~/Documents/API Keys/mongodb-URI-RS.txt   (this machine's convention)
// The URI is scrubbed from all output — see redactUri, which is applied to
// error messages too, since a driver connection error embeds the full URI
// (credentials included) in its own `.message`.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//   node scripts/inspectAd.js 6a93ade2e4f1d02784398630
//   node scripts/inspectAd.js <id> --fields renderUrl,status,visionQc
//   node scripts/inspectAd.js <id> <id2> --json
//   node scripts/inspectAd.js --list-fields
//
// Prints a compact human-readable summary by default; `--json` emits the same
// allow-listed projection as JSON for programmatic use.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Ad fields worth seeing for a typical creative-defect investigation. Chosen
// to answer "what is this ad, what route produced it, where did it land, and
// how did QC judge it" without dumping copy blobs or vendor payloads.
const DEFAULT_FIELDS = [
  'status',
  'kind',
  'renderRoute',
  'platformFormat',
  'aspectRatio',
  'deriveFromMaster',
  'funnelStage',
  'renderUrl',
  'veoVideoUrl',
  'posterUrl',
  'renderStage',
  'renderError',
  'visionQc',
  'titlingNeeded',
  'titlingAttempts',
  'titlingResumeState',
  'claimedByWorker',
  'claimedAt',
  'campaignId',
  'productId',
  'brandId',
  'mediaId',
  'campaignRunIds',
  'generatedAt',
  'createdAt',
  'updatedAt',
];

const HEX24 = /^[0-9a-fA-F]{24}$/;

function resolveUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  const fromFileEnv = process.env.ADGEN_MONGODB_URI_FILE;
  const candidates = [
    fromFileEnv,
    path.join(os.homedir(), 'Documents', 'API Keys', 'mongodb-URI-RS.txt'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (raw) return raw.split(/\r?\n/)[0].trim();
      }
    } catch (_) { /* unreadable candidate — fall through to the next */ }
  }
  return null;
}

/**
 * Strip credentials from anything about to be printed. Applied to error
 * messages as well: a driver connect/auth failure puts the ENTIRE URI,
 * password included, into its own message string.
 */
function redactUri(s) {
  return String(s == null ? '' : s).replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://<redacted>');
}

function parseArgs(argv) {
  const ids = [];
  let fields = null;
  let json = false;
  let listFields = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--list-fields') { listFields = true; continue; }
    if (a === '--fields') { fields = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (a.startsWith('--fields=')) { fields = a.slice(9).split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (a === '-h' || a === '--help') { listFields = true; continue; }
    if (a.startsWith('-')) throw new Error(`unknown flag '${a}'`);
    ids.push(a);
  }
  return { ids, fields, json, listFields };
}

function fmtValue(v) {
  if (v == null) return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.length ? JSON.stringify(v.map(String)) : '[]';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

(async () => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  if (args.listFields) {
    console.log('Usage: node scripts/inspectAd.js <adId> [<adId>...] [--fields a,b,c] [--json]');
    console.log('\nDefault fields:');
    for (const f of DEFAULT_FIELDS) console.log(`  ${f}`);
    process.exit(0);
  }

  if (!args.ids.length) {
    console.error('no ad id given. Usage: node scripts/inspectAd.js <adId> [--fields a,b] [--json]');
    process.exit(2);
  }
  const bad = args.ids.filter((id) => !HEX24.test(id));
  if (bad.length) {
    console.error(`not valid 24-hex ObjectId(s): ${bad.join(', ')}`);
    process.exit(2);
  }

  const uri = resolveUri();
  if (!uri) {
    console.error('No MongoDB URI found. Set MONGODB_URI, or ADGEN_MONGODB_URI_FILE=<path>,');
    console.error('or place the URI in "~/Documents/API Keys/mongodb-URI-RS.txt".');
    process.exit(2);
  }

  const fields = args.fields && args.fields.length ? args.fields : DEFAULT_FIELDS;
  const mongoose = require('mongoose');

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  } catch (e) {
    console.error(`mongo connect failed: ${redactUri(e.message)}`);
    process.exit(1);
  }

  try {
    const projection = { _id: 1 };
    for (const f of fields) projection[f] = 1;
    // Read-only by construction: findOne/find only, filter always built here
    // from validated ObjectIds — never taken from the caller. See invariants.
    const docs = await mongoose.connection.db.collection('ads')
      .find(
        { _id: { $in: args.ids.map((id) => new mongoose.Types.ObjectId(id)) } },
        { projection }
      )
      .toArray();

    const byId = new Map(docs.map((d) => [String(d._id), d]));

    if (args.json) {
      const out = args.ids.map((id) => {
        const d = byId.get(id);
        if (!d) return { _id: id, __found: false };
        const o = { _id: id, __found: true };
        for (const f of fields) o[f] = d[f] === undefined ? null : d[f];
        return o;
      });
      console.log(redactUri(JSON.stringify(out, null, 2)));
    } else {
      for (const id of args.ids) {
        const d = byId.get(id);
        console.log(`\n── ad ${id} ${'─'.repeat(Math.max(0, 46 - id.length))}`);
        if (!d) { console.log('  NOT FOUND'); continue; }
        const width = Math.max(...fields.map((f) => f.length));
        for (const f of fields) {
          if (d[f] === undefined) continue;
          console.log(`  ${f.padEnd(width)}  ${redactUri(fmtValue(d[f]))}`);
        }
      }
      console.log('');
    }
  } catch (e) {
    console.error(`query failed: ${redactUri(e.message)}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
})();
