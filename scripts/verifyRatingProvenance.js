#!/usr/bin/env node
'use strict';

/**
 * verifyRatingProvenance — offline pins for the rating provenance gate.
 *
 * Flag RATING_REQUIRE_PROVENANCE (env, default FALSE). Flag-off is today's
 * exact ranking, including an unsourced 5.0 beating a sourced 4.5. Flag-on
 * prefers a sourced candidate when one exists; when NOTHING is sourced the
 * unsourced number still wins (fail-safe — a brand cannot lose its rating).
 *
 * The two-tier owner ranking is unchanged. This gate sits ABOVE it.
 *
 * Also pins both pass-2 responseSchemas (`source` required AND nullable)
 * and both structure prompts (never invent a source).
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyRatingProvenance.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { pickBestRating } = require('../services/providers/geminiSearchProvider');

const SRC_PATH = path.join(__dirname, '..', 'services', 'providers', 'geminiSearchProvider.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

const ORIGINAL_FLAG = process.env.RATING_REQUIRE_PROVENANCE;

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message.split('\n')[0].slice(0, 240)}`);
  }
}

function withFlag(val, fn) {
  if (val === undefined || val === null) delete process.env.RATING_REQUIRE_PROVENANCE;
  else process.env.RATING_REQUIRE_PROVENANCE = val;
  try { return fn(); }
  finally {
    if (ORIGINAL_FLAG === undefined) delete process.env.RATING_REQUIRE_PROVENANCE;
    else process.env.RATING_REQUIRE_PROVENANCE = ORIGINAL_FLAG;
  }
}

function quiet(fn) {
  const log = console.log;
  const warn = console.warn;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = () => {};
  try {
    return { result: fn(), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// Same pair for OFF vs ON: unsourced 5.0/100 is tier-1 with the bigger
// sample, so TODAY it wins. 4.5/60 is also tier-1. The flag is what
// flips the winner — without a count on the 5.0, 4.5/60 already wins
// as the only credible sample and the pin would not prove the gate.
const MIXED = [
  { rating: 5.0, reviewCount: 100, source: null },
  { rating: 4.5, reviewCount: 60, source: 'trustpilot.com' }
];

// ═══════════════ A. flag OFF — today's ranking ═══════════════
console.log('\nA. flag OFF — unsourced 5.0 still wins (today preserved)');

check('A1 default / unset: unsourced 5.0/100 beats sourced 4.5/60', () => {
  withFlag(undefined, () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.rating, 5.0, `got ${r.rating}`);
    assert.strictEqual(r.reviewCount, 100);
    assert.strictEqual(r.ratingSource, null);
  });
});

check('A2 explicit false: same winner as unset', () => {
  withFlag('false', () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.rating, 5.0);
    assert.strictEqual(r.ratingSource, null);
  });
});

// ═══════════════ B. flag ON — the fix ═══════════════
console.log('\nB. flag ON — sourced beats unsourced');

check('B1 sourced 4.5/60 beats unsourced 5.0/100', () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.rating, 4.5, `got ${r.rating} — provenance gate did not fire`);
    assert.strictEqual(r.reviewCount, 60);
    assert.strictEqual(r.ratingSource, 'trustpilot.com');
  });
});

check('B2 TRUE (case-insensitive) also enables', () => {
  withFlag('TRUE', () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.rating, 4.5);
  });
});

check('B3 set-aside log names the count and the winner', () => {
  withFlag('true', () => {
    const { lines } = quiet(() => pickBestRating(MIXED));
    const line = lines.find((l) => /set aside/.test(l));
    assert.ok(line, 'expected a set-aside log line');
    assert.ok(/set aside 1 unsourced/.test(line), line);
    assert.ok(/4\.5/.test(line) && /60/.test(line), line);
  });
});

// ═══════════════ C. fail-safe — no rating lost ═══════════════
console.log('\nC. flag ON, nothing sourced — unsourced still wins');

check('C1 unsourced 5.0 still wins when every candidate is unsourced', () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { rating: 5.0, reviewCount: 10, source: null },
      { rating: 4.5, reviewCount: 40, source: null }
    ])).result;
    assert.strictEqual(r.rating, 5.0, `fail-safe lost the rating, got ${r.rating}`);
    assert.strictEqual(r.reviewCount, 10);
    assert.strictEqual(r.ratingSource, null);
  });
});

check('C2 fail-safe does not emit a set-aside log', () => {
  withFlag('true', () => {
    const { lines } = quiet(() => pickBestRating([
      { rating: 5.0, source: null }
    ]));
    assert.ok(!lines.some((l) => /set aside/.test(l)), 'nothing was excluded');
  });
});

// ═══════════════ D. two-tier owner rule, among sourced ═══════════════
console.log('\nD. flag ON — existing two-tier rule among sourced is unchanged');

check('D1 tier 1: biggest credible sample wins (4.58/15626 beats 4.7/60)', () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { source: 'vuoriclothing.com', rating: 4.58, reviewCount: 15626 },
      { source: 'thin.com', rating: 4.7, reviewCount: 60 }
    ])).result;
    assert.strictEqual(r.rating, 4.58, `got ${r.rating}`);
    assert.strictEqual(r.reviewCount, 15626);
    assert.strictEqual(r.ratingSource, 'vuoriclothing.com');
  });
});

check('D2 tier 2: more stars wins (4.5/11 beats 3.2/22)', () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { source: 'WorthEPenny', rating: 3.2, reviewCount: 22 },
      { source: 'Tenere', rating: 4.5, reviewCount: 11 }
    ])).result;
    assert.strictEqual(r.rating, 4.5, `got ${r.rating}`);
    assert.strictEqual(r.reviewCount, 11);
    assert.strictEqual(r.ratingSource, 'Tenere');
  });
});

check('D3 anyTier1 is computed on the CHOSEN POOL, not on excluded rows', () => {
  // Unsourced 4.8/10000 would be tier 1 if it stayed in the pool, which
  // would rank the sourced pair by sample size (4.5/11 over 4.9/10).
  // Over the sourced pool nothing is credible, so more-stars wins: 4.9.
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { rating: 4.8, reviewCount: 10000, source: null },
      { source: 'a.com', rating: 4.5, reviewCount: 11 },
      { source: 'b.com', rating: 4.9, reviewCount: 10 }
    ])).result;
    assert.strictEqual(r.rating, 4.9, `pool anyTier1 leaked from the unsourced row, got ${r.rating}`);
    assert.strictEqual(r.ratingSource, 'b.com');
  });
});

// ═══════════════ E. ratingCandidates is the full audit trail ═══════════════
console.log('\nE. ratingCandidates always contains every input candidate');

check('E1 flag OFF: every row present, winner first', () => {
  withFlag('false', () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.ratingCandidates.length, 2);
    assert.strictEqual(r.ratingCandidates[0].rating, 5.0);
    const ratings = r.ratingCandidates.map((c) => c.rating).sort();
    assert.deepStrictEqual(ratings, [4.5, 5.0]);
  });
});

check('E2 flag ON: excluded unsourced still present, after the ranked pool', () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating(MIXED)).result;
    assert.strictEqual(r.ratingCandidates.length, 2, 'unsourced must not be dropped');
    assert.strictEqual(r.ratingCandidates[0].rating, 4.5);
    assert.strictEqual(r.ratingCandidates[0].source, 'trustpilot.com');
    assert.strictEqual(r.ratingCandidates[1].rating, 5.0);
    assert.strictEqual(r.ratingCandidates[1].source, null);
  });
});

check('E3 flag ON, nothing sourced: every row still present', () => {
  withFlag('true', () => {
    const input = [
      { rating: 5.0, reviewCount: 10, source: null },
      { rating: 4.5, reviewCount: 40, source: null }
    ];
    const r = quiet(() => pickBestRating(input)).result;
    assert.strictEqual(r.ratingCandidates.length, 2);
  });
});

// ═══════════════ F. both schemas + both prompts ═══════════════
console.log('\nF. both pass-2 schemas require source; both prompts forbid inventing one');

check('F1 both responseSchemas list source in required', () => {
  const code = stripComments(src);
  const required = code.match(/required: \['rating', 'source'\]/g) || [];
  assert.strictEqual(required.length, 2,
    `expected source in required on both ratings items, got ${required.length}`);
});

check('F2 source stays nullable on both ratings items (do not force a name)', () => {
  const blocks = src.match(/ratings: \{[\s\S]*?\n              \},/g) || [];
  assert.strictEqual(blocks.length, 2, `expected 2 ratings schema blocks, got ${blocks.length}`);
  for (const b of blocks) {
    assert.ok(/source:\s*\{ type: 'string', nullable: true \}/.test(b),
      'source must stay nullable — a forced string makes the model invent a site');
    assert.ok(!/source:\s*\{ type: 'string' \}/.test(b),
      'a non-nullable source slipped in');
  }
});

check('F3 both prompts say never invent a source', () => {
  const hits = src.match(/NEVER guess or invent a source/g) || [];
  assert.strictEqual(hits.length, 2,
    `expected the invent-ban in both structurePrompts, got ${hits.length}`);
  const must = src.match(/MUST carry the source site\/domain/g) || [];
  assert.strictEqual(must.length, 2, 'both prompts must demand a source on every entry');
  const keep = src.match(/EVERY aggregate found, one entry each; do NOT pick or average/g) || [];
  assert.strictEqual(keep.length, 2, 'the existing do-not-pick guidance must stay');
});

check('F4 helper defaults OFF and is read at call time', () => {
  assert.ok(/RATING_REQUIRE_PROVENANCE \|\| 'false'/.test(src),
    'flag must default false so today is preserved');
  assert.ok(/function ratingRequireProvenanceEnabled\(/.test(src),
    'expected the env helper next to the other rating knobs');
});

// ── report ────────────────────────────────────────────────────────────
if (ORIGINAL_FLAG === undefined) delete process.env.RATING_REQUIRE_PROVENANCE;
else process.env.RATING_REQUIRE_PROVENANCE = ORIGINAL_FLAG;

const total = pass + failures.length;
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`\n❌ verifyRatingProvenance: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`   • ${f}`);
  process.exit(1);
}
console.log(`\n✅ verifyRatingProvenance: ${total}/${total} checks passed`);
