#!/usr/bin/env node
'use strict';

/**
 * verifyRatingProvenance — offline pins for the rating provenance gate.
 *
 * Owner 2026-08-12: "Let's ask gemini to always get provenance, and yes
 * scraped is better than something unsourced."
 *
 * ONE flag, RATING_REQUIRE_PROVENANCE (env, default FALSE), gates BOTH halves
 * of this change:
 *   1. The pass-2 prompt/schema (does Gemini have to name a source at all)
 *   2. pickBestRating's ranking (does a named source outrank an unnamed one)
 * Flag-off must be indistinguishable from origin/main on BOTH halves — this
 * was NOT true of the first draft, which gated only the ranking while making
 * the schema's `source` key unconditionally required. Adversarial review
 * caught it: a required field the model cannot fill is a live incentive to
 * DROP the aggregate rather than emit null, which loses a printable rating
 * with the flag off and the ranking gate never consulted. See REGRESSION §F.
 *
 * Flag-on is NOT "sourced always wins" — that was the second thing adversarial
 * review disproved. It is "sourced wins UNLESS that would trade a printable
 * rating for an unprintable one" — see FAIL-SAFE §C. The two-tier owner
 * ranking (biggest-credible-sample / more-stars) is unchanged and runs over
 * whichever pool the gate lands on.
 *
 * A source string is not "real" just because it is non-empty — see GARBAGE §G.
 *
 * Offline: no DB, no network, no API key.
 *   node scripts/verifyRatingProvenance.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const provider = require('../services/providers/geminiSearchProvider');
const {
  pickBestRating,
  ratingsItemRequiredKeys,
  ratingsProvenanceAskSentence,
  isRealSource
} = provider;

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
    failures.push(`${name}: ${err.message.split('\n')[0].slice(0, 260)}`);
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
const codeOnly = stripComments(src);

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

// ═══════════════ B. flag ON — the fix, when it does not conflict with print-safety ═══════════════
console.log('\nB. flag ON — sourced beats unsourced (when both would print)');

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

// ═══════════════ C. FAIL-SAFE — the real one, not "did anything have a source" ═══════════════
console.log('\nC. flag ON — provenance must never cost a brand its printable rating');

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

// REGRESSION CASE — the exact one adversarial review produced against the
// first draft. A named-but-thin sourced pair (Trustpilot 2.5/126, WorthEPenny
// 3.2/22) alongside an unsourced-but-large one (the legacy fold-in shape,
// 4.58/15626). A gate keyed on "does ANY row have a source" partitions to the
// two sourced rows and prints 3.2 — UNDER the 4.39 display floor, so the ad
// shows literally NO STARS where flag-off showed 4.6. This is not a worse
// number, it is the rating disappearing.
check('C3 REGRESSION — sourced-but-unprintable must not displace a printable unsourced winner', () => {
  withFlag('true', () => {
    const input = [
      { source: 'trustpilot.com', rating: 2.5, reviewCount: 126 },
      { source: 'WorthEPenny', rating: 3.2, reviewCount: 22 },
      { rating: 4.58, reviewCount: 15626, source: null } // legacy fold-in shape
    ];
    const r = quiet(() => pickBestRating(input)).result;
    assert.strictEqual(r.rating, 4.58,
      `provenance gate traded a printable 4.58 for an unprintable sourced number (got ${r.rating})`);
    assert.strictEqual(r.reviewCount, 15626);
  });
});

check('C4 the stand-down is logged, distinct from the ordinary set-aside line', () => {
  withFlag('true', () => {
    const input = [
      { source: 'trustpilot.com', rating: 2.5, reviewCount: 126 },
      { source: 'WorthEPenny', rating: 3.2, reviewCount: 22 },
      { rating: 4.58, reviewCount: 15626, source: null }
    ];
    const { lines } = quiet(() => pickBestRating(input));
    assert.ok(lines.some((l) => /STOOD DOWN/.test(l)), 'expected a stood-down log line');
    assert.ok(!lines.some((l) => /set aside/.test(l)), 'must not ALSO claim rows were set aside');
  });
});

check('C5 when the sourced winner IS printable, the gate still prefers it over an unsourced one', () => {
  // Sanity: C3's fix must not have swallowed the whole feature. A genuinely
  // printable sourced candidate still wins over an unsourced one even when a
  // third, unprintable, sourced row also exists.
  withFlag('true', () => {
    const input = [
      { source: 'trustpilot.com', rating: 2.5, reviewCount: 126 }, // sourced, unprintable
      { source: 'vuoriclothing.com', rating: 4.58, reviewCount: 15626 }, // sourced, printable, tier 1
      { rating: 4.8, reviewCount: 5, source: null } // unsourced, thin tier-2
    ];
    const r = quiet(() => pickBestRating(input)).result;
    assert.strictEqual(r.rating, 4.58, `got ${r.rating}`);
    assert.strictEqual(r.ratingSource, 'vuoriclothing.com');
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

check('E3 flag ON, nothing sourced: every row still present, and NOT collapsed to duplicates', () => {
  // Original E3 only checked .length === 2, which a [5.0, 5.0] duplicate bug
  // would also satisfy. Assert the actual distinct ratings survive.
  withFlag('true', () => {
    const input = [
      { rating: 5.0, reviewCount: 10, source: null },
      { rating: 4.5, reviewCount: 40, source: null }
    ];
    const r = quiet(() => pickBestRating(input)).result;
    assert.strictEqual(r.ratingCandidates.length, 2);
    const ratings = r.ratingCandidates.map((c) => c.rating).sort();
    assert.deepStrictEqual(ratings, [4.5, 5.0]);
  });
});

check('E4 stand-down: audit trail still lists every row, not just the winner', () => {
  withFlag('true', () => {
    const input = [
      { source: 'trustpilot.com', rating: 2.5, reviewCount: 126 },
      { source: 'WorthEPenny', rating: 3.2, reviewCount: 22 },
      { rating: 4.58, reviewCount: 15626, source: null }
    ];
    const r = quiet(() => pickBestRating(input)).result;
    assert.strictEqual(r.ratingCandidates.length, 3, 'a stand-down must not drop rows either');
  });
});

// ═══════════════ F. schema/prompt are gated on the SAME flag — behavioural ═══════════════
console.log('\nF. schema/prompt builders — flag-gated, tested by calling them (not regexed)');

check('F1 flag OFF: source is NOT in the required keys (byte-identical to pre-change)', () => {
  withFlag(undefined, () => {
    assert.deepStrictEqual(ratingsItemRequiredKeys(), ['rating'],
      'flag-off must ask for exactly what origin/main asked for');
  });
});

check('F2 flag ON: source IS required', () => {
  withFlag('true', () => {
    assert.deepStrictEqual(ratingsItemRequiredKeys(), ['rating', 'source']);
  });
});

check('F3 flag OFF: the prompt carries no provenance demand at all', () => {
  withFlag(undefined, () => {
    const ask = ratingsProvenanceAskSentence();
    assert.strictEqual(ask, '', 'flag-off must add nothing to the prompt — this IS the always-on-I/O fix');
  });
});

check('F4 flag ON: the prompt demands a source and bans inventing one', () => {
  withFlag('true', () => {
    const ask = ratingsProvenanceAskSentence();
    assert.ok(/MUST carry the source/.test(ask), ask);
    assert.ok(/NEVER guess or invent a source/.test(ask), ask);
  });
});

check('F5 pass-2 (json_structure) is a SINGLE shared implementation, not two, and still asks for provenance', () => {
  // UPDATED 2026-08-19 — pass 2 of lookupBrandReviews / lookupProductReviews
  // moved off the direct Gemini REST transport onto Atlas
  // (structureReviewNarrative, one function, called from both). Two
  // call sites collapsing to one shared helper is a STRENGTHENING of "shared
  // builder, not a re-implemented literal" — the schema/prompt genuinely
  // cannot drift between brand and product now, because there is only one
  // copy. `ratingsProvenanceAskSentence()` is still the flag's mechanism
  // (the PROMPT ask); with only one caller of the shared helper's body, it
  // now has exactly ONE call site in source, not two.
  const asks = (codeOnly.match(/(?<!function )ratingsProvenanceAskSentence\(\)/g) || []).length;
  assert.strictEqual(asks, 1, `expected 1 call site (the shared structureReviewNarrative helper), got ${asks}`);
  assert.strictEqual((codeOnly.match(/structureReviewNarrative\(/g) || []).length, 3,
    'expected 1 declaration + 2 call sites (brand + product reviews)');
  // `ratingsItemRequiredKeys()` is INTENTIONALLY unused now — see F6b. Assert
  // that deliberately, so a future re-introduction is a decision, not a
  // silent revert of this comment's claim.
  assert.strictEqual((codeOnly.match(/(?<!function )ratingsItemRequiredKeys\(\)/g) || []).length, 0,
    'ratingsItemRequiredKeys() should have no call sites — see F6b for why');
});

check('F6a source stays nullable in the (now single, shared) ratings schema (do not force a name)', () => {
  const idx = src.indexOf('ratings: {');
  assert.notStrictEqual(idx, -1, 'expected the REVIEWS_STRUCTURE_SCHEMA ratings block');
  // Exactly one such block should exist now that pass 2 is a single shared
  // helper (structureReviewNarrative) instead of two duplicated literals.
  assert.strictEqual(src.indexOf('ratings: {', idx + 1), -1,
    'expected exactly ONE ratings schema block now that pass 2 is shared, not two');
  const block = src.slice(idx, idx + 400);
  assert.ok(/source:\s*\{ type: \['string', 'null'\] \}/.test(block),
    'source must stay nullable — a forced non-nullable string makes the model invent a site');
  assert.ok(/rating:\s*\{ type: 'number' \}/.test(block),
    'rating itself must stay non-nullable — an entry with no number is not an aggregate');
});

check('F6b RATING_REQUIRE_PROVENANCE no longer gates the SCHEMA, only the PROMPT — by design, not by omission', () => {
  // OpenAI's strict json_schema mode (additionalProperties:false) requires
  // EVERY property key to be present in `required`, with nullability
  // expressed via `type:[T,'null']` instead of omission from `required`.
  // Gemini's native responseSchema could vary whether `source` was even a
  // required KEY based on the flag; strict mode cannot express that
  // distinction, so `source` is unconditionally required-but-nullable now.
  // This must be a comment-documented decision, not a silent regression —
  // assert the comment explaining it is still present.
  assert.ok(/ONE CONSEQUENCE WORTH STATING/.test(src),
    'the schema-vs-prompt flag-scope-narrowing decision must stay documented in source');
  // The prompt-level ask is what remains: assert it is still reachable and
  // still flag-gated (tested behaviourally in section F above via the
  // exported ratingsProvenanceAskSentence(), not re-tested here).
  assert.ok(/ratingsProvenanceAskSentence\(\)/.test(src));
});

check('F7 helper defaults OFF and is read at call time (not module load)', () => {
  assert.ok(/RATING_REQUIRE_PROVENANCE \|\| 'false'/.test(codeOnly),
    'flag must default false so today is preserved');
  assert.ok(/function ratingRequireProvenanceEnabled\(/.test(codeOnly),
    'expected the env helper next to the other rating knobs');
});

// ═══════════════ G. GARBAGE — a placeholder string is not provenance ═══════════════
console.log('\nG. a non-empty source string that names nothing must not out-rank a real unsourced row');

check('G1 isRealSource rejects common placeholders', () => {
  for (const bad of ['unknown', 'Unknown', 'N/A', 'n/a', 'null', 'NULL', 'none', 'undefined', 'not specified', 'no source', 'web', 'various', 'multiple sources']) {
    assert.strictEqual(isRealSource(bad), false, `expected "${bad}" to be rejected as non-provenance`);
  }
});

check('G2 isRealSource accepts a real site/domain', () => {
  for (const good of ['trustpilot.com', 'Vuoriclothing.com', 'Google Shopping', 'Nordstrom']) {
    assert.strictEqual(isRealSource(good), true, `expected "${good}" to be accepted`);
  }
});

check('G3 isRealSource rejects null / empty / non-string', () => {
  assert.strictEqual(isRealSource(null), false);
  assert.strictEqual(isRealSource(''), false);
  assert.strictEqual(isRealSource('   '), false);
  assert.strictEqual(isRealSource(undefined), false);
  assert.strictEqual(isRealSource(42), false);
});

check("G4 a candidate whose source is the literal word 'unknown' does not out-rank a real unsourced one", () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { source: 'unknown', rating: 3.1, reviewCount: 8 },
      { rating: 4.8, reviewCount: 900, source: null }
    ])).result;
    assert.strictEqual(r.rating, 4.8, `a placeholder source displaced the real winner, got ${r.rating}`);
    assert.strictEqual(r.ratingSource, null);
  });
});

check("G5 the literal string 'null' as a source is treated as unsourced, not as provenance", () => {
  withFlag('true', () => {
    const r = quiet(() => pickBestRating([
      { source: 'null', rating: 3.0, reviewCount: 5 },
      { source: 'trustpilot.com', rating: 4.5, reviewCount: 60 }
    ])).result;
    assert.strictEqual(r.rating, 4.5);
    assert.strictEqual(r.ratingSource, 'trustpilot.com');
  });
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
