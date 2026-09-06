#!/usr/bin/env node
'use strict';
/**
 * verifyFontFallback — offline guard for library-match face selection.
 *
 * WHY THIS EXISTS
 * Library fallback was a binary default (serif→Lora, else→Inter). Proprietary
 * DTC names (e.g. Allbirds "Self Modern") matched no foundry pattern and
 * always landed on Inter. 8 of the 16 curated faces were unreachable by any
 * fallback path. Classification vocabulary + brand-signal chooser fix that.
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) Binary Lora/Inter default restored, classification rows removed
 *       → R* reachability fails for unreachable faces; S1 Self Modern→Inter
 *   (2) Body legibility remap removed
 *       → B1 body+Impact/script lands on display/script face
 *   (3) Foundry patterns reordered / broken
 *       → F* non-regression fails (helvetica/futura/bodoni/garamond/script)
 *   (4) Non-deterministic chooser (Math.random / Date / mutable stamps)
 *       → D1 determinism fails across 100 calls
 *   (5) Serif/sans intent guard dropped on brand/default path
 *       → I1/I2 intent cross-contamination fails
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyFontFallback.js
 */

const assert = require('assert');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const {
  pickLibraryFamily,
  fallbackFor,
  matchCustomFont,
  brandFontAssumeLicensed,
  BODY_UNSAFE_FACES,
  LIBRARY_SERIF_FACES,
  LIBRARY_SUBSTITUTIONS,
} = require('../services/fontResolverService');
const { FONTS } = require('../services/fontLoader');

// The curated faces fontLoader ships — every one must be reachable.
const CURATED = FONTS.map((f) => f.family);

console.log('\nverifyFontFallback — library-match classification + brand signals\n');
console.log(`  curated faces = ${CURATED.length}\n`);

// ── F. Foundry non-regression (role null = no body remap) ─────────────────
// Fails if (3) is reverted.
const FOUNDRY_CASES = [
  ['Helvetica Neue', 'Inter'],
  ['Arial', 'Inter'],
  ['Futura', 'Montserrat'],
  ['Bodoni', 'Playfair Display'],
  ['Garamond', 'Cormorant Garamond'],
  ['Script Handwriting', 'Great Vibes'],
];
for (const [req, expect] of FOUNDRY_CASES) {
  check(`F foundry '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}

// ── S. Self Modern is Didone, not Inter ───────────────────────────────────
// Fails if (1) is reverted.
check('S1 Self Modern → Playfair Display (not Inter)', () => {
  const pick = pickLibraryFamily('Self Modern', { role: 'heading' });
  assert.ok(pick, 'expected a pick');
  assert.notStrictEqual(pick.family, 'Inter', 'Self Modern must not fall through to Inter');
  assert.strictEqual(pick.family, 'Playfair Display', `got ${pick.family}`);
  assert.ok(/modern|didone/i.test(pick.matchReason), `reason should cite modern/didone: ${pick.matchReason}`);
});
check('S2 Self Modern is stable across roles for the face class (heading)', () => {
  const h = pickLibraryFamily('Self Modern', { role: 'heading' });
  const b = pickLibraryFamily('Self Modern', { role: 'body' });
  // Playfair is body-safe; both roles keep the Didone.
  assert.strictEqual(h.family, 'Playfair Display');
  assert.strictEqual(b.family, 'Playfair Display');
});

// ── R. Every curated face is reachable ────────────────────────────────────
// Fails if (1) drops classification or brand rules that unlock a face.
// Each entry: [requestedFamily, brand, role] → expected family.
const REACH_CASES = [
  ['Helvetica', null, 'heading', 'Inter'],
  ['Self Modern', null, 'heading', 'Playfair Display'],
  ['Elegant Luxe', null, 'heading', 'Cormorant'],
  ['Garamond', null, 'heading', 'Cormorant Garamond'],
  ['BrandX Proprietary', { brandSafety: { category: 'Athletic' }, tone: ['sport'] }, 'heading', 'Antonio'],
  ['Futura', null, 'heading', 'Montserrat'],
  ['Brush Script', null, 'heading', 'Great Vibes'],
  ['Avenir', null, 'heading', 'DM Sans'],
  ['Display Poster Headline', null, 'heading', 'Bebas Neue'],
  ['Impact', null, 'heading', 'Anton'],
  ['DIN Condensed', null, 'heading', 'Oswald'],
  ['BrandY Face', { tone: ['playful', 'friendly'] }, 'body', 'Poppins'],
  ['BrandZ Face', { brandSafety: { category: 'Food & CPG' }, tags: ['coffee'] }, 'body', 'Nunito'],
  ['Rounded Soft Sans', null, 'body', 'Quicksand'],
  // Lora and IBM Plex Sans lost their ONLY name-table reach path in the 16 → 48
  // expansion: 'Slab Serif' now resolves to a real slab and 'Technical Mono' to
  // a real mono. Both faces are still very much in use — Lora is the serif
  // body/quote face for most brand-signal categories, IBM Plex Sans owns
  // plex/technical — so they are re-anchored to the paths that actually reach
  // them now. Losing a reach case is how a face goes quietly dead.
  ['House Serif Voice', { tone: ['minimal', 'clean'] }, 'body', 'Lora'],
  ['Plex Technical UI', null, 'body', 'IBM Plex Sans'],

  // ── The 32 faces added by the library expansion (2026-08-04) ────────────
  // Every expectation below was resolved against the live table before being
  // written here, not predicted from the patterns.
  // Slab
  ['Rockwell Bold', null, 'heading', 'Zilla Slab'],
  ['Egyptian Slab', null, 'heading', 'Arvo'],
  ['Josefin Slab', null, 'heading', 'Josefin Slab'],
  // Mono
  ['Space Mono', null, 'heading', 'Space Mono'],
  ['Technical Mono', null, 'body', 'IBM Plex Mono'],
  ['JetBrains Mono', null, 'heading', 'JetBrains Mono'],
  // Editorial / text serif
  ['Tiempos Text', null, 'body', 'Source Serif 4'],
  ['Georgia', null, 'body', 'Merriweather'],
  ['GT Sectra', null, 'heading', 'Spectral'],
  // Geometric / grotesk sans
  ['Gilroy', null, 'heading', 'Outfit'],
  ['Satoshi', null, 'heading', 'Manrope'],
  ['Clash Grotesk', null, 'heading', 'Space Grotesk'],
  ['Aktiv Grotesk', null, 'heading', 'Work Sans'],
  ['Archivo', null, 'heading', 'Archivo'],
  ['Public Sans', null, 'heading', 'Public Sans'],
  // Condensed / wide
  ['Barlow Condensed', null, 'heading', 'Barlow Condensed'],
  ['Knockout', null, 'heading', 'Archivo Narrow'],
  ['Archivo Black', null, 'heading', 'Archivo Black'],
  ['Extended Wide Face', null, 'heading', 'Syne'],
  // Rounded
  ['VAG Rounded', null, 'heading', 'Baloo 2'],
  ['Comfortaa', null, 'heading', 'Comfortaa'],
  // Script / hand
  ['Snell Roundhand', null, 'heading', 'Dancing Script'],
  ['Lobster', null, 'heading', 'Pacifico'],
  ['Comic Sans', null, 'heading', 'Caveat'],
  // Didone / fashion / old-style / luxury
  ['Domaine Display', null, 'heading', 'Prata'],
  ['Reckless', null, 'heading', 'Italiana'],
  ['Noe Display', null, 'heading', 'DM Serif Display'],
  ['Marcellus', null, 'heading', 'Marcellus'],
  ['EB Garamond', null, 'heading', 'EB Garamond'],
  ['Recoleta', null, 'heading', 'Fraunces'],
  ['Trajan Pro', null, 'heading', 'Cinzel'],
  ['Optima', null, 'heading', 'Tenor Sans'],
];

const reached = new Map(); // family → first input label
for (const [req, brand, role, expect] of REACH_CASES) {
  check(`R reach '${expect}' via '${req}' role=${role}`, () => {
    const pick = pickLibraryFamily(req, { brand, role });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(
      pick.family,
      expect,
      `expected ${expect}, got ${pick.family} (${pick.matchReason})`
    );
    if (!reached.has(expect)) {
      reached.set(expect, { req, role, reason: pick.matchReason });
    }
  });
}

check('R all curated faces reachable', () => {
  const missing = CURATED.filter((f) => !reached.has(f));
  assert.strictEqual(
    missing.length,
    0,
    `unreachable curated faces: ${missing.join(', ')}`
  );
});

// FONTS length pin: adding a face without a REACH case makes it dead weight —
// the substitution table can name it but no input ever selects it.
check('R curated list is exactly the fontLoader FONTS set', () => {
  assert.strictEqual(CURATED.length, 48, `expected 48 faces, got ${CURATED.length}`);
  for (const f of CURATED) {
    assert.ok(reached.has(f), `face ${f} not produced by REACH_CASES`);
  }
});

// ── D. Determinism ────────────────────────────────────────────────────────
// Fails if (4) is reverted.
check('D1 same input → identical family+reason across 100 calls', () => {
  const brand = {
    brandSafety: { category: 'Apparel' },
    tone: ['minimal', 'clean'],
    tags: ['footwear'],
  };
  const first = pickLibraryFamily('House Sans XYZ', { brand, role: 'heading' });
  assert.ok(first);
  for (let i = 0; i < 100; i++) {
    const next = pickLibraryFamily('House Sans XYZ', { brand, role: 'heading' });
    assert.strictEqual(next.family, first.family, `call ${i} family drift`);
    assert.strictEqual(next.matchReason, first.matchReason, `call ${i} reason drift`);
  }
});

// ── I. Serif / sans intent ────────────────────────────────────────────────
// Fails if (5) is reverted. Uses brand/default path (no name-table hit) so
// the intent guard is the path under test. Classification hits may cross
// the naive fallbackFor heuristic by design (Self Modern → Didone).
check('I1 serif-hinted proprietary name never resolves to a sans face', () => {
  const brand = { tone: ['playful'] }; // would prefer Poppins (sans) if intent ignored
  const pick = pickLibraryFamily('Custom Serif House', { brand, role: 'body' });
  assert.ok(pick);
  assert.ok(
    LIBRARY_SERIF_FACES.has(pick.family),
    `serif request got sans '${pick.family}' (${pick.matchReason})`
  );
  assert.strictEqual(fallbackFor(pick.family), 'serif');
});
check('I2 non-serif proprietary name never resolves to a serif face (brand path)', () => {
  const brand = { brandSafety: { category: 'Luxury Fashion' }, tone: ['luxury', 'premium'] };
  // Luxury heading serif preference must not fire for a sans-intent name.
  const pick = pickLibraryFamily('House Groteskless XYZ', { brand, role: 'heading' });
  assert.ok(pick);
  // Name has no serif hint → sans intent → Montserrat (luxury sans heading).
  assert.ok(
    !LIBRARY_SERIF_FACES.has(pick.family),
    `sans request got serif '${pick.family}' (${pick.matchReason})`
  );
});
check('I3 classification modern→Playfair is allowed even when name lacks serif hint', () => {
  // Documents the intentional exception: name-table classification wins.
  const pick = pickLibraryFamily('Self Modern', { role: 'heading' });
  assert.strictEqual(pick.family, 'Playfair Display');
  assert.strictEqual(fallbackFor('Self Modern'), 'sans-serif'); // naive heuristic
  assert.strictEqual(fallbackFor(pick.family), 'serif'); // chosen face is serif
});

// ── B. Body never gets display/script ─────────────────────────────────────
// Fails if (2) is reverted.
const DISPLAY_REQUESTS = [
  ['Impact', 'heading'], // Anton on heading — allowed
  ['Impact', 'body'],    // must remap
  ['Brush Script', 'body'],
  ['Display Poster', 'body'],
  ['Extended Wide Face', 'body'],
];
check('B1 body role never lands on a BODY_UNSAFE face', () => {
  for (const [req, role] of DISPLAY_REQUESTS) {
    if (role !== 'body') continue;
    const pick = pickLibraryFamily(req, { role: 'body' });
    assert.ok(pick, req);
    assert.ok(
      !BODY_UNSAFE_FACES.has(pick.family),
      `body+'${req}' resolved to unsafe '${pick.family}'`
    );
  }
});
check('B2 heading may still receive display faces (Impact→Anton)', () => {
  const pick = pickLibraryFamily('Impact', { role: 'heading' });
  assert.strictEqual(pick.family, 'Anton');
});
check('B3 body+Impact remaps away from Anton', () => {
  const pick = pickLibraryFamily('Impact', { role: 'body' });
  assert.notStrictEqual(pick.family, 'Anton');
  assert.ok(/body-safe/i.test(pick.matchReason), pick.matchReason);
});
// B1 asserts against BODY_UNSAFE_FACES itself, so DELETING a face from that set
// makes B1 pass trivially — the face is then no longer "unsafe" by definition
// and ships on paragraph copy. This list is the independent statement of which
// faces must never be body copy, whatever the set happens to contain.
const MUST_BE_BODY_UNSAFE = [
  'Anton', 'Bebas Neue', 'Great Vibes', 'Antonio',
  'Archivo Black', 'Syne',
  'Prata', 'Italiana', 'DM Serif Display', 'Marcellus', 'Cinzel',
  'Dancing Script', 'Pacifico', 'Caveat',
];
check('B4 the body-unsafe set contains every display/script face', () => {
  const missing = MUST_BE_BODY_UNSAFE.filter((f) => !BODY_UNSAFE_FACES.has(f));
  assert.strictEqual(missing.length, 0, `faces missing from BODY_UNSAFE_FACES: ${missing.join(', ')}`);
});
// A body-unsafe SERIF must be replaced by a serif. The remap used to key only on
// fallbackFor(requestedName): "Domaine Display" carries no serif token, so a
// deliberate didone pick became a grotesk on body copy.
const BODY_REMAP_CASES = [
  ['Domaine Display', 'Lora'],   // didone → serif body face
  ['Reckless', 'Lora'],          // fashion display serif → serif
  ['Trajan Pro', 'Lora'],        // inscriptional → serif
  ['Lobster', 'Lora'],           // script (serif-intent by convention) → serif
  ['Archivo Black', 'Inter'],    // heavy SANS display → grotesk
  ['Impact', 'Inter'],           // heavy sans display → grotesk
];
for (const [req, expect] of BODY_REMAP_CASES) {
  check(`B5 body '${req}' remaps to ${expect} (class preserved)`, () => {
    const pick = pickLibraryFamily(req, { role: 'body' });
    assert.ok(pick, req);
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
    assert.ok(/body-safe/i.test(pick.matchReason), `remap must be logged: ${pick.matchReason}`);
  });
}

// ── C. Classification vocabulary smoke ────────────────────────────────────
// These exercise the CLASSIFICATION rows specifically. The REACH cases above
// mostly enter through named commercial rows, so a classification row can be
// retargeted to a face from the wrong type class and every REACH case still
// passes — that gap let a `slab → Lora` regression through unnoticed once.
const CLASS_CASES = [
  ['Geometric Sans', 'Montserrat'],
  ['Humanist Sans', 'DM Sans'],
  ['Condensed Narrow', 'Oswald'],
  ['Old-Style Serif', 'EB Garamond'],   // retargeted: we now ship the real EB Garamond
  ['Didone', 'Playfair Display'],
  // A name saying "slab" must resolve to an actual slab serif, never to a
  // transitional serif standing in for one.
  ['House Slab Text', 'Zilla Slab'],
  // "mono" must resolve to a MONOSPACE face. The single pre-split row sent
  // every one of these to the proportional IBM Plex Sans.
  ['Akkurat Mono', 'IBM Plex Mono'],
  ['Courier Next', 'IBM Plex Mono'],
  // …while plex/technical without "mono" stays on the proportional sans.
  ['Technical Grade UI', 'IBM Plex Sans'],
  ['Extended Wide Face', 'Syne'],
];
for (const [req, expect] of CLASS_CASES) {
  check(`C class '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}

// ── P. Structure pins ─────────────────────────────────────────────────────
check('P1 LIBRARY_SUBSTITUTIONS keeps foundry rows before classification', () => {
  const reasons = LIBRARY_SUBSTITUTIONS.map((s) => s.reason);
  const helveticaIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /helvetica/i.test(s.pattern.source));
  const modernIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /didone|\\bmodern\\b/.test(s.pattern.source));
  assert.ok(helveticaIdx >= 0, 'helvetica foundry row missing');
  assert.ok(modernIdx >= 0, 'modern/didone classification row missing');
  assert.ok(helveticaIdx < modernIdx, 'foundry rows must precede classification rows');
  assert.ok(reasons.some((r) => /slab/i.test(r)), 'slab substitution missing');
});
check('P2 pickLibraryFamily is exported and pure (no Promise)', () => {
  const out = pickLibraryFamily('Inter-ish', { role: 'body' });
  assert.ok(out && typeof out.family === 'string');
  assert.ok(typeof out.matchReason === 'string');
  assert.strictEqual(typeof out.then, 'undefined', 'pick must be sync, not a Promise');
});
check('P3 foundry → commercial → classification block order', () => {
  // Named commercial faces must sit before classification so "Domaine Display"
  // does not get stolen by the generic display/poster row.
  const helveticaIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /helvetica/i.test(s.pattern.source));
  const sohneIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /sohne|s\[oö\]hne/i.test(s.pattern.source));
  const modernIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /didone|\\bmodern\\b/.test(s.pattern.source));
  assert.ok(sohneIdx >= 0, 'commercial Söhne row missing');
  assert.ok(helveticaIdx < sohneIdx, 'foundry before commercial');
  assert.ok(sohneIdx < modernIdx, 'commercial before classification');
});

// ── T. Every substitution TARGET is one of the curated library faces ──────
// Catches a hallucinated / misspelled library face that would 404 at render.
check('T1 every LIBRARY_SUBSTITUTIONS.family is in the curated library', () => {
  const curated = new Set(CURATED);
  const bad = [];
  for (const row of LIBRARY_SUBSTITUTIONS) {
    if (!curated.has(row.family)) {
      bad.push(`${row.family} (reason=${row.reason})`);
    }
  }
  assert.strictEqual(bad.length, 0, `targets outside the curated library: ${bad.join('; ')}`);
});

// ── M. Commercial DTC name → sensible library face ───────────────────────
// Representative commercial webfonts (third block). Some names also hit
// earlier foundry/classification rows — family must still be the intended
// closest face; that is not a regression.
const COMMERCIAL_CASES = [
  ['Söhne', 'Inter'],
  ['Sohne', 'Inter'],
  ['GT America', 'Inter'],
  ['Untitled Sans', 'Inter'],
  ['Canela', 'Playfair Display'],
  ['Tiempos Text', 'Source Serif 4'],
  ['Graphik', 'Inter'],
  ['Suisse Int\'l', 'Inter'],
  ['Maison Neue', 'Montserrat'],
  ['Aeonik', 'Montserrat'],
  ['National 2', 'DM Sans'],
  ['Neue Montreal', 'Inter'],
  ['Recoleta', 'Fraunces'],
  ['Domaine Display', 'Prata'],
  ['Druk', 'Bebas Neue'],
  ['GT Walsheim', 'Montserrat'],
  ['Whyte', 'Inter'],
  ['Akkurat', 'Inter'],
  ['Ideal Sans', 'DM Sans'],
  ['Circular', 'DM Sans'], // foundry row also maps Circular → DM Sans
];
for (const [req, expect] of COMMERCIAL_CASES) {
  check(`M commercial '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}
check('M commercial picks are deterministic (Söhne × 50)', () => {
  const first = pickLibraryFamily('Söhne', { role: 'heading' });
  for (let i = 0; i < 50; i++) {
    const next = pickLibraryFamily('Söhne', { role: 'heading' });
    assert.strictEqual(next.family, first.family);
    assert.strictEqual(next.matchReason, first.matchReason);
  }
});

// ── L. BRAND_FONT_ASSUME_LICENSED gate on matchCustomFont ─────────────────
// Flag OFF: commercial rejected even with url.
// Flag ON: commercial accepted when url present; still rejected when url null
// or needsLicense:true (explicit human hold).
function withAssumeLicensed(value, fn) {
  const prev = process.env.BRAND_FONT_ASSUME_LICENSED;
  try {
    if (value === undefined) delete process.env.BRAND_FONT_ASSUME_LICENSED;
    else process.env.BRAND_FONT_ASSUME_LICENSED = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BRAND_FONT_ASSUME_LICENSED;
    else process.env.BRAND_FONT_ASSUME_LICENSED = prev;
  }
}
const brandWithCommercial = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/soehne.woff2',
      license: 'commercial',
      needsLicense: false,
    },
  ],
};
const brandCommercialNoUrl = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: null,
      license: 'commercial',
      needsLicense: true,
    },
  ],
};
const brandCommercialHumanHold = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/soehne.woff2',
      license: 'commercial',
      needsLicense: true, // explicit human hold
    },
  ],
};
const brandOpen = {
  customFonts: [
    {
      family: 'BrandSans',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/brand.woff2',
      license: 'unknown',
      needsLicense: false,
    },
  ],
};

check('L1 flag OFF rejects commercial even with url', () => {
  withAssumeLicensed('false', () => {
    assert.strictEqual(brandFontAssumeLicensed(), false);
    assert.strictEqual(matchCustomFont(brandWithCommercial, 'Söhne'), null);
  });
});
check('L2 flag ON accepts commercial with url', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(brandFontAssumeLicensed(), true);
    const hit = matchCustomFont(brandWithCommercial, 'Söhne');
    assert.ok(hit, 'expected commercial match');
    assert.strictEqual(hit.family, 'Söhne');
    assert.ok(hit.url);
  });
});
check('L3 flag ON still rejects commercial with url=null', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(matchCustomFont(brandCommercialNoUrl, 'Söhne'), null);
  });
});
check('L4 flag ON still rejects needsLicense:true human hold', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(matchCustomFont(brandCommercialHumanHold, 'Söhne'), null);
  });
});
check('L5 flag OFF still accepts non-commercial faces', () => {
  withAssumeLicensed('false', () => {
    const hit = matchCustomFont(brandOpen, 'BrandSans');
    assert.ok(hit);
    assert.strictEqual(hit.family, 'BrandSans');
  });
});
check('L6 default (unset) assume-licensed is true', () => {
  withAssumeLicensed(undefined, () => {
    assert.strictEqual(brandFontAssumeLicensed(), true);
    assert.ok(matchCustomFont(brandWithCommercial, 'Söhne'));
  });
});

// ── Q. Quote uses the ingested italic file when present ──────────────────
const brandWithItalic = {
  customFonts: [
    { family: 'DM Sans', weight: 400, style: 'normal', url: 'https://res.cloudinary.com/x/dm-sans-400.woff2' },
    { family: 'DM Sans', weight: 400, style: 'italic', url: 'https://res.cloudinary.com/x/dm-sans-400-italic.woff2' },
  ],
};
check('Q1 matchCustomFont({style:italic}) returns the italic file', () => {
  const hit = matchCustomFont(brandWithItalic, 'DM Sans', { weight: 400, style: 'italic' });
  assert.ok(hit, 'expected italic match');
  assert.strictEqual(hit.style, 'italic');
  assert.ok(/italic/.test(hit.url), hit.url);
});
check('Q2 default matchCustomFont (heading/body) still returns roman', () => {
  const hit = matchCustomFont(brandWithItalic, 'DM Sans', { weight: 400 });
  assert.ok(hit);
  assert.strictEqual(hit.style || 'normal', 'normal');
  assert.ok(!/italic/.test(hit.url), hit.url);
});
check('Q3 resolveFamily quote path requests italic first, heading/body do not', () => {
  const src = require('fs').readFileSync(require('path').join(ROOT, 'services', 'fontResolverService.js'), 'utf8');
  assert.ok(
    /roleKey\(role\) === 'quote'/.test(src),
    'italic lookup must be scoped to the quote role'
  );
  assert.ok(
    /style:\s*'italic'/.test(src),
    'quote lookup must request style italic'
  );
  const quoteBlock = src.slice(src.indexOf("roleKey(role) === 'quote'"));
  const headingLookup = src.match(/async function resolveFamily[\s\S]*?const custom = matchCustomFont\(brand, family, \{ weight \}\)/);
  assert.ok(headingLookup, 'roman matchCustomFont(brand, family, { weight }) must still exist for heading/body');
  assert.ok(
    /matchCustomFont\(brand, family, \{ weight, style: 'italic' \}\)/.test(quoteBlock),
    'quote must call matchCustomFont with style italic before the roman fallback'
  );
});

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

// Operator-facing resolution table for the response contract.
console.log('\nRepresentative resolutions:');
const DEMO = [
  ['Self Modern', null, 'heading'],
  ['Helvetica Neue', null, 'heading'],
  ['Futura', null, 'heading'],
  ['Bodoni', null, 'heading'],
  ['Garamond', null, 'heading'],
  ['Brush Script', null, 'heading'],
  ['House Sans', { brandSafety: { category: 'Apparel' }, tone: ['playful'] }, 'heading'],
  ['House Sans', { brandSafety: { category: 'Athletic' }, tone: ['sport'] }, 'heading'],
  ['Impact', null, 'body'],
];
for (const [req, brand, role] of DEMO) {
  const p = pickLibraryFamily(req, { brand, role });
  const brandLabel = brand
    ? (brand.brandSafety?.category || (brand.tone && brand.tone.join('+')) || 'brand')
    : '—';
  console.log(`  ${req.padEnd(18)} role=${role.padEnd(7)} brand=${String(brandLabel).padEnd(12)} → ${p.family}  [${p.matchReason}]`);
}
console.log('ok\n');
