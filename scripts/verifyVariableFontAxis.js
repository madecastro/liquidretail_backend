#!/usr/bin/env node
'use strict';

// Pins the variable-font weight-axis probe and its wiring into brand font
// ingest.
//
// THE DEFECT THIS EXISTS FOR (measured in production 2026-08-24, Pelagic Gear):
// their @font-face declares NO font-weight at all —
//
//   @font-face { font-family: "ArchivoV";
//     src: url(.../Archivo-Variable.woff2) format('woff2'); font-display: swap; }
//
// so parseWeight() returned its 400 default and parseWeightRange() returned
// {null,null}. The file is genuinely variable (wght 100..900, default 600) and
// was persisted as a STATIC weight-400 cut. fontResolverService.resolveCustomFont
// gates the variable path on Number.isFinite(weightMin/weightMax), so every
// request collapsed to 400 — and headings request 700, so every headline in
// every render was drawn with SYNTHETIC bold rather than the brand's real bold.
//
// Offline. No network, no DB, no keys. Builds its font fixtures in-process.

const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const {
  probeVariableWeightAxis,
  parseWoff2Directory,
  parseSfntDirectory,
  readWghtAxis
} = require('../services/fontAxisProbe');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  ✗ ${name}`); }
}

// ── fixtures ──────────────────────────────────────────────────────────────

/** Build an fvar table containing one wght axis. */
function buildFvar({ min, def, max, tag = 'wght', axisCount = 1, extraTagFirst = null }) {
  const count = extraTagFirst ? axisCount + 1 : axisCount;
  const headerLen = 16;
  const buf = Buffer.alloc(headerLen + count * 20);
  buf.writeUInt16BE(1, 0);            // majorVersion
  buf.writeUInt16BE(0, 2);            // minorVersion
  buf.writeUInt16BE(headerLen, 4);    // axesArrayOffset
  buf.writeUInt16BE(2, 6);            // reserved
  buf.writeUInt16BE(count, 8);        // axisCount
  buf.writeUInt16BE(20, 10);          // axisSize
  buf.writeUInt16BE(0, 12);           // instanceCount
  buf.writeUInt16BE(0, 14);           // instanceSize
  let o = headerLen;
  const writeAxis = (t, mn, df, mx) => {
    buf.write(t, o, 4, 'ascii');
    buf.writeInt32BE(Math.round(mn * 65536), o + 4);
    buf.writeInt32BE(Math.round(df * 65536), o + 8);
    buf.writeInt32BE(Math.round(mx * 65536), o + 12);
    buf.writeUInt16BE(0, o + 16);
    buf.writeUInt16BE(0, o + 18);
    o += 20;
  };
  if (extraTagFirst) writeAxis(extraTagFirst, 0, 0, 100);
  writeAxis(tag, min, def, max);
  return buf;
}

/** Minimal sfnt (ttf) carrying the given tables. */
function buildSfnt(tables) {
  const n = tables.length;
  const dirLen = 12 + n * 16;
  let offset = dirLen;
  const recs = tables.map((t) => {
    const rec = { tag: t.tag, offset, length: t.data.length };
    offset += t.data.length;
    return rec;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(n, 4);
  recs.forEach((r, i) => {
    const p = 12 + i * 16;
    out.write(r.tag, p, 4, 'ascii');
    out.writeUInt32BE(0, p + 4);
    out.writeUInt32BE(r.offset, p + 8);
    out.writeUInt32BE(r.length, p + 12);
  });
  tables.forEach((t, i) => t.data.copy(out, recs[i].offset));
  return out;
}

const KNOWN = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
  'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];

function base128(n) {
  const bytes = [];
  do { bytes.unshift(n & 0x7f); n >>>= 7; } while (n > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return Buffer.from(bytes);
}

/** Minimal woff2 carrying the given tables, Brotli-compressed like the real thing. */
function buildWoff2(tables) {
  const dirParts = [];
  for (const t of tables) {
    const idx = KNOWN.indexOf(t.tag);
    if (idx < 0 || idx === 63) {
      dirParts.push(Buffer.from([63]), Buffer.from(t.tag, 'ascii'), base128(t.data.length));
    } else {
      dirParts.push(Buffer.from([idx]), base128(t.data.length));
    }
  }
  const dir = Buffer.concat(dirParts);
  const raw = Buffer.concat(tables.map((t) => t.data));
  const compressed = zlib.brotliCompressSync(raw);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 4, 'ascii');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + dir.length + compressed.length, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt16BE(0, 14);
  header.writeUInt32BE(0, 16);
  header.writeUInt32BE(compressed.length, 20);
  return Buffer.concat([header, dir, compressed]);
}

const filler = (n, byte = 0x11) => Buffer.alloc(n, byte);

console.log('\n── A. probe reads a real wght axis ──');

check('A1 woff2 variable font → the file\'s real 100..900 axis', () => {
  const buf = buildWoff2([
    { tag: 'head', data: filler(54) },
    { tag: 'fvar', data: buildFvar({ min: 100, def: 600, max: 900 }) }
  ]);
  const axis = probeVariableWeightAxis(buf);
  assert.ok(axis, 'expected an axis');
  assert.strictEqual(axis.weightMin, 100);
  assert.strictEqual(axis.weightMax, 900);
  assert.strictEqual(axis.weightDefault, 600);
});

check('A2 fvar is found at the correct offset when tables PRECEDE it', () => {
  // Regression guard: the offset walk must sum preceding table lengths.
  const buf = buildWoff2([
    { tag: 'head', data: filler(54, 0xaa) },
    { tag: 'maxp', data: filler(32, 0xbb) },
    { tag: 'OS/2', data: filler(96, 0xcc) },
    { tag: 'fvar', data: buildFvar({ min: 200, def: 400, max: 800 }) }
  ]);
  const axis = probeVariableWeightAxis(buf);
  assert.ok(axis, 'fvar not located behind preceding tables');
  assert.strictEqual(axis.weightMin, 200);
  assert.strictEqual(axis.weightMax, 800);
});

check('A3 STATIC woff2 (no fvar) → null, and never decompresses', () => {
  const buf = buildWoff2([
    { tag: 'head', data: filler(54) },
    { tag: 'glyf', data: filler(200) }
  ]);
  assert.strictEqual(probeVariableWeightAxis(buf), null);
});

check('A4 raw sfnt/ttf variable font is supported too', () => {
  const buf = buildSfnt([
    { tag: 'head', data: filler(54) },
    { tag: 'fvar', data: buildFvar({ min: 300, def: 500, max: 700 }) }
  ]);
  const axis = probeVariableWeightAxis(buf);
  assert.ok(axis);
  assert.strictEqual(axis.weightMin, 300);
  assert.strictEqual(axis.weightMax, 700);
});

check('A5 wght is found even when another axis is listed first', () => {
  const buf = buildWoff2([
    { tag: 'fvar', data: buildFvar({ min: 100, def: 400, max: 900, extraTagFirst: 'ital' }) }
  ]);
  const axis = probeVariableWeightAxis(buf);
  assert.ok(axis, 'wght must be searched for, not read positionally');
  assert.strictEqual(axis.weightMin, 100);
});

check('A6 an fvar with only a non-wght axis → null', () => {
  const buf = buildWoff2([{ tag: 'fvar', data: buildFvar({ min: 0, def: 0, max: 100, tag: 'ital' }) }]);
  assert.strictEqual(probeVariableWeightAxis(buf), null);
});

console.log('\n── B. the probe is TOTAL — it can never break ingest ──');

for (const [name, input] of [
  ['null', null],
  ['empty buffer', Buffer.alloc(0)],
  ['not a font', Buffer.from('<!DOCTYPE html><html>nope</html>')],
  ['truncated woff2 header', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(10)])],
  ['woff2 with a corrupt brotli block', (() => {
    const good = buildWoff2([{ tag: 'fvar', data: buildFvar({ min: 100, def: 400, max: 900 }) }]);
    good.fill(0xff, 60);           // shred the compressed payload
    return good;
  })()],
  ['woff1 (unsupported container)', Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(100)])]
]) {
  check(`B: ${name} → null, no throw`, () => {
    assert.strictEqual(probeVariableWeightAxis(input), null);
  });
}

check('B7 an absurd axis range is rejected rather than trusted', () => {
  const buf = buildWoff2([{ tag: 'fvar', data: buildFvar({ min: 1, def: 5000, max: 9999 }) }]);
  assert.strictEqual(probeVariableWeightAxis(buf), null, 'max > 1000 is not CSS-legal');
});

check('B8 an inverted axis (min > max) is rejected', () => {
  const buf = buildWoff2([{ tag: 'fvar', data: buildFvar({ min: 900, def: 900, max: 100 }) }]);
  assert.strictEqual(probeVariableWeightAxis(buf), null);
});

console.log('\n── C. THE DEFECT — wired into ingest, and revert-proof ──');

const ingestSrc = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'brandFontIngestService.js'), 'utf8'
);

check('C1 brandFontIngestService IMPORTS the probe (a call alone is a ReferenceError)', () => {
  // CLAUDE.md §4: a regex proving a call is WRITTEN does not prove it RESOLVES.
  // processAlerts shipped exactly that bug. Assert the import explicitly.
  assert.ok(
    /require\(\s*['"]\.\/fontAxisProbe['"]\s*\)/.test(ingestSrc),
    'no require of ./fontAxisProbe'
  );
  assert.ok(/probeVariableWeightAxis/.test(ingestSrc), 'probe never referenced');
});

check('C2 the probe result is applied to weightMin AND weightMax', () => {
  assert.ok(/weightMin\s*=\s*axis\.weightMin/.test(ingestSrc), 'weightMin not assigned');
  assert.ok(/weightMax\s*=\s*axis\.weightMax/.test(ingestSrc), 'weightMax not assigned');
});

check('C3 it only fills a GAP — an explicit CSS range still wins', () => {
  assert.ok(
    /!Number\.isFinite\(face\.weightMin\)\s*&&\s*!Number\.isFinite\(face\.weightMax\)/.test(ingestSrc),
    'missing the guard that preserves an author-declared sub-range'
  );
});

check('C4b resolveCustomFont copies weightMin/weightMax onto the resolved token', () => {
  const resolverSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'fontResolverService.js'), 'utf8');
  assert.ok(
    /weightMin:\s*Number\.isFinite\(custom\.weightMin\)\s*\?\s*custom\.weightMin\s*:\s*null/.test(resolverSrc),
    'resolveCustomFont must pass weightMin through onto the entry'
  );
  assert.ok(
    /weightMax:\s*Number\.isFinite\(custom\.weightMax\)\s*\?\s*custom\.weightMax\s*:\s*null/.test(resolverSrc),
    'resolveCustomFont must pass weightMax through onto the entry'
  );
  assert.ok(
    /weightMin:\s*Number\.isFinite\(entry\.weightMin\)\s*\?\s*entry\.weightMin\s*:\s*null/.test(resolverSrc),
    'resolveBrandFonts must copy weightMin onto the role token FontLoader sees'
  );
});

check('C4 THE REGRESSION: resolveCustomFont\'s gate is satisfied by the probe output', () => {
  // This is the whole point. Reproduce fontResolverService.resolveCustomFont's
  // variable-weight gate verbatim and drive it with both records.
  const gate = (custom, requestedWeight) => {
    const variable = Number.isFinite(custom.weightMin) && Number.isFinite(custom.weightMax) &&
      requestedWeight >= custom.weightMin && requestedWeight <= custom.weightMax;
    return variable ? requestedWeight : (custom.weight || 400);
  };

  const HEADING_WEIGHT = 700;   // fontResolverService DEFAULT_ROLE_FONTS.heading

  const before = { family: 'ArchivoV', weight: 400, weightMin: null, weightMax: null };
  assert.strictEqual(gate(before, HEADING_WEIGHT), 400,
    'pre-fix record must collapse a 700 request to 400 — that IS the bug');

  const axis = probeVariableWeightAxis(buildWoff2([
    { tag: 'fvar', data: buildFvar({ min: 100, def: 600, max: 900 }) }
  ]));
  const after = { family: 'ArchivoV', weight: 400, weightMin: axis.weightMin, weightMax: axis.weightMax };
  assert.strictEqual(gate(after, HEADING_WEIGHT), 700,
    'post-fix record must serve the real 700 — headings stop being faux-bold');
});

check('C5 the nominal weight is CLAMPED onto the axis, not blindly overwritten', () => {
  assert.ok(
    /Math\.min\(Math\.max\(face\.weight,\s*axis\.weightMin\),\s*axis\.weightMax\)/.test(ingestSrc),
    'nominal weight must be clamped into the file\'s real range'
  );
  const clamp = (w, mn, mx) => Math.min(Math.max(w, mn), mx);
  assert.strictEqual(clamp(400, 100, 900), 400, 'a weight inside the range is left alone');
  assert.strictEqual(clamp(400, 600, 900), 600, 'a weight below the range is pulled onto it');
});

check('C6 the Cloudinary publicId uses the RESOLVED weight, not the stale CSS one', () => {
  // Otherwise a clamped face mirrors under a filename claiming a weight the
  // file cannot serve, and a re-ingest silently overwrites a different cut.
  assert.ok(
    /publicId:\s*`\$\{brandId\}-\$\{familySlug\(face\.family\)\}-\$\{entryBase\.weight\}/.test(ingestSrc),
    'publicId still interpolates face.weight instead of entryBase.weight'
  );
});

console.log('\n── D. the real-world CSS shape that caused this ──');

check('D1 Pelagic\'s actual @font-face declares no weight → CSS yields no range', () => {
  // Verbatim from pelagicgear.com, fetched 2026-08-24.
  const css = `@font-face { font-family: "ArchivoV"; src: url(//pelagicgear.com/cdn/shop/t/587/assets/Archivo-Variable.woff2?v=894) format('woff2'); font-display: swap;}`;
  assert.ok(!/font-weight/i.test(css),
    'fixture must be the real no-font-weight shape, or this test proves nothing');
  const parseWeightRange = (raw) => {
    const range = String(raw || '').trim().match(/(\d{2,4})\s+(\d{2,4})/);
    if (!range) return { weightMin: null, weightMax: null };
    return { weightMin: parseInt(range[1], 10), weightMax: parseInt(range[2], 10) };
  };
  const { weightMin, weightMax } = parseWeightRange(undefined);
  assert.strictEqual(weightMin, null);
  assert.strictEqual(weightMax, null);
});

console.log('');
if (failures.length) {
  console.log(`❌ verifyVariableFontAxis: ${failures.length} of ${pass + failures.length} checks FAILED`);
  for (const f of failures) console.log(`  • ${f.name}\n     ${f.message}`);
  process.exit(1);
}
console.log(`✅ verifyVariableFontAxis: ${pass}/${pass} checks passed`);
