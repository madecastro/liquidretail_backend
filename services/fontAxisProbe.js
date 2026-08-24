// Read a font file's REAL variable-weight axis out of its `fvar` table.
//
// WHY THIS EXISTS
// ---------------
// brandFontIngestService derives weight metadata from the CSS `@font-face`
// descriptor. That is the only source it had, and for a variable font the CSS
// is frequently silent. Pelagic Gear's own site is the measured case:
//
//   @font-face { font-family: "ArchivoV";
//     src: url(.../Archivo-Variable.woff2) format('woff2'); font-display: swap; }
//
// No `font-weight` descriptor at all — so parseWeight() returned the 400
// default and parseWeightRange() returned {null, null}. The face was persisted
// as a STATIC weight-400 cut. The file is genuinely variable (wght 100..900,
// default 600), but nothing downstream could know that.
//
// The consequence is not cosmetic. fontResolverService.resolveCustomFont gates
// on exactly those fields:
//
//   const variableWeight = Number.isFinite(custom.weightMin) &&
//     Number.isFinite(custom.weightMax) && requested >= min && requested <= max;
//   const effectiveWeight = variableWeight ? requestedWeight : (custom.weight || 400);
//
// Number.isFinite(null) is false, so every request collapsed to 400. Headings
// ask for 700 (fontResolverService DEFAULT_ROLE_FONTS), so every headline in
// every render was registered at 400 and drawn with SYNTHETIC bold instead of
// the brand's real bold cut.
//
// HOW
// ---
// No new dependency. woff2 is a Brotli-compressed sfnt and Node ships Brotli
// in `zlib`. The table DIRECTORY is plaintext ahead of the compressed block,
// so `fvar` presence is detectable without decompressing at all; we only
// decompress when the directory says there is an `fvar` worth reading.
//
// Deliberately total: every failure path returns null. A font probe must never
// be able to break ingest — a null here simply leaves the CSS-derived metadata
// exactly as it was before this file existed.

'use strict';

const zlib = require('zlib');

// woff2 KNOWN_TAGS, in spec order. A table-directory entry stores an index
// into this list; 63 means "an explicit 4-byte tag follows instead".
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post',
  'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];

// Refuse to Brotli-expand a hostile file into memory. Real variable fonts
// decompress to a few hundred KB; Archivo-Variable measures 235KB.
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

/** UIntBase128 as used by the woff2 table directory. */
function readBase128(buf, state) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (state.p >= buf.length) return null;
    const b = buf[state.p++];
    // Leading zero byte, or overflow past 2^32, is a malformed stream.
    if (i === 0 && b === 0x80) return null;
    if (result & 0xfe000000) return null;
    result = (result << 7) | (b & 0x7f);
    if (!(b & 0x80)) return result >>> 0;
  }
  return null;
}

/**
 * Parse a woff2 table directory.
 * → { entries: [{ tag, length }], compressedStart, totalCompressedSize } | null
 * `length` is the length this table occupies in the DECOMPRESSED stream,
 * which is transformLength when a transform is applied and origLength when not.
 */
function parseWoff2Directory(buf) {
  if (buf.length < 48) return null;
  if (buf.toString('ascii', 0, 4) !== 'wOF2') return null;

  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  if (!numTables || numTables > 512) return null;

  const state = { p: 48 };
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    if (state.p >= buf.length) return null;
    const flags = buf[state.p++];
    const idx = flags & 0x3f;

    let tag;
    if (idx === 63) {
      if (state.p + 4 > buf.length) return null;
      tag = buf.toString('ascii', state.p, state.p + 4);
      state.p += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[idx];
      if (!tag) return null;
    }

    const origLength = readBase128(buf, state);
    if (origLength === null) return null;

    // transformVersion occupies the top two bits. glyf/loca use the inverted
    // convention: 3 means "no transform"; everything else means "transformed".
    // Every other table: 0 means "no transform".
    const transformVersion = (flags >> 6) & 0x3;
    const isGlyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfOrLoca ? transformVersion !== 3 : transformVersion !== 0;

    let length = origLength;
    if (transformed) {
      const transformLength = readBase128(buf, state);
      if (transformLength === null) return null;
      length = transformLength;
    }
    entries.push({ tag, length });
  }
  return { entries, compressedStart: state.p, totalCompressedSize };
}

/** Parse an uncompressed sfnt (ttf/otf) directory → [{ tag, offset, length }]. */
function parseSfntDirectory(buf) {
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  const isSfnt = tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */;
  if (!isSfnt) return null;
  const numTables = buf.readUInt16BE(4);
  if (!numTables || numTables > 512) return null;
  if (12 + numTables * 16 > buf.length) return null;
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    entries.push({
      tag: buf.toString('ascii', rec, rec + 4),
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12)
    });
  }
  return entries;
}

/**
 * Read the `wght` axis out of an fvar table.
 * `data` is the buffer holding the table, `fvarOffset` where it starts.
 * → { weightMin, weightMax, weightDefault } | null
 */
function readWghtAxis(data, fvarOffset) {
  // fvar header: majorVersion(2) minorVersion(2) axesArrayOffset(2)
  //              reserved(2) axisCount(2) axisSize(2) ...
  if (fvarOffset + 16 > data.length) return null;
  if (data.readUInt16BE(fvarOffset) !== 1) return null; // majorVersion must be 1

  const axesArrayOffset = data.readUInt16BE(fvarOffset + 4);
  const axisCount = data.readUInt16BE(fvarOffset + 8);
  const axisSize = data.readUInt16BE(fvarOffset + 10);
  // VariationAxisRecord is 20 bytes; the spec allows a LARGER axisSize for
  // forward compatibility but never a smaller one.
  if (!axisCount || axisCount > 64 || axisSize < 20) return null;

  for (let i = 0; i < axisCount; i++) {
    const a = fvarOffset + axesArrayOffset + i * axisSize;
    if (a + 20 > data.length) return null;
    if (data.toString('ascii', a, a + 4) !== 'wght') continue;

    // Fixed 16.16 → Number.
    const min = data.readInt32BE(a + 4) / 65536;
    const def = data.readInt32BE(a + 8) / 65536;
    const max = data.readInt32BE(a + 12) / 65536;

    // A wght axis outside the CSS-legal 1..1000 band, or inverted, is not
    // something we should feed the resolver.
    if (!(min >= 1 && max <= 1000 && min < max)) return null;
    if (!(def >= min && def <= max)) return null;

    return {
      weightMin: Math.round(min),
      weightMax: Math.round(max),
      weightDefault: Math.round(def)
    };
  }
  return null;
}

/**
 * Probe a font buffer for its variable weight axis.
 *
 * @param {Buffer} buf raw font file (woff2, ttf or otf)
 * @returns {{weightMin:number, weightMax:number, weightDefault:number}|null}
 *          null when the file is static, unparseable, or not a font at all.
 */
function probeVariableWeightAxis(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

    // woff (v1) is Zlib-per-table rather than one Brotli stream. Vanishingly
    // rare for variable fonts and not worth a second code path — treat as
    // static rather than guessing.
    if (buf.toString('ascii', 0, 4) === 'wOFF') return null;

    if (buf.toString('ascii', 0, 4) === 'wOF2') {
      const dir = parseWoff2Directory(buf);
      if (!dir) return null;
      // Cheap exit: no fvar in the plaintext directory means static. This is
      // the common case and costs no decompression.
      if (!dir.entries.some((e) => e.tag === 'fvar')) return null;

      const end = dir.compressedStart + dir.totalCompressedSize;
      if (end > buf.length) return null;
      const compressed = buf.subarray(dir.compressedStart, end);

      const data = zlib.brotliDecompressSync(compressed, {
        maxOutputLength: MAX_DECOMPRESSED_BYTES
      });

      // Tables sit back-to-back in directory order in the decompressed stream.
      let offset = 0;
      for (const entry of dir.entries) {
        if (entry.tag === 'fvar') return readWghtAxis(data, offset);
        offset += entry.length;
        // woff2 pads each table to a 4-byte boundary in the reconstructed font,
        // but the compressed stream is unpadded — do NOT align here.
        if (offset > data.length) return null;
      }
      return null;
    }

    const sfnt = parseSfntDirectory(buf);
    if (!sfnt) return null;
    const fvar = sfnt.find((e) => e.tag === 'fvar');
    if (!fvar) return null;
    if (fvar.offset + 16 > buf.length) return null;
    return readWghtAxis(buf, fvar.offset);
  } catch {
    // Total by design — see the header note.
    return null;
  }
}

module.exports = {
  probeVariableWeightAxis,
  // exported for the verify harness
  parseWoff2Directory,
  parseSfntDirectory,
  readWghtAxis
};
