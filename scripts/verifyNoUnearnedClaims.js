#!/usr/bin/env node
/**
 * verifyNoUnearnedClaims.js — no ad may print a factual superlative the data
 * does not support. Offline: no DB, no network, no API key.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * services/metaCascadeConfig.js drove badgeText through a literal fallback:
 *
 *   badgeText: [
 *     { type: 'doc', doc: 'layoutInput', path: 'input.product.badges[0]' },
 *     { type: 'literal', value: 'Bestseller' },          // <- removed
 *   ]
 *
 * A cascade literal is the LAST entry, so it fires exactly when every real
 * source is empty — i.e. "Bestseller" printed precisely on the products with
 * NO evidence of being one. That is not a stylistic problem like a templated
 * headline; it is a factual claim about commercial performance, and unearned
 * it is a false advertising claim. Owner, 2026-08-11: "The bestseller badge
 * should be removed."
 *
 * The distinction this file encodes: a literal is fine when it is STRUCTURAL
 * (a CTA label like "SHOP NOW", an empty-array default) and never fine when it
 * asserts an unverifiable FACT about the product's standing. Note the static
 * prompt path already bans this class outright (services/staticAdIntents.js:
 * "never Best Seller, Top Rated, Customer Favorite, #1 or As Seen On") — the
 * video cascade was the one place it survived.
 *
 * REVERT-PROOF RECIPE (must fail this harness — run after mutating):
 *   a) Re-add { type: 'literal', value: 'Bestseller' } to badgeText -> C1/C2 fail
 *   b) Add any other superlative literal to any cascade                -> C2 fails
 */

const path = require('path');
const { DEFAULT_META_CASCADES } = require(path.join(__dirname, '..', 'services', 'metaCascadeConfig'));

const failures = [];
let passed = 0;
const check = (label, cond, detail = '') => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

// Claims about standing/performance that only real data can justify.
const UNEARNED_CLAIM = /\b(?:best\s?seller|bestselling|best[- ]?selling|top\s?seller|top\s?rated|#\s?1|number one|customer favou?rite|as seen on|award[- ]winning|world'?s best|fastest[- ]selling)\b/i;

// ── C1. badgeText specifically ──────────────────────────────────────────
const badge = DEFAULT_META_CASCADES.badgeText || [];
check('C1 badgeText still reads real product badges', badge.length >= 1);
check('C1 badgeText has NO literal fallback',
  !badge.some((e) => e && e.type === 'literal'),
  `chain=${JSON.stringify(badge)} — a literal here fires only when there is no evidence`);

// ── C2. no cascade anywhere may assert an unearned claim ────────────────
for (const [field, chain] of Object.entries(DEFAULT_META_CASCADES)) {
  for (const entry of chain || []) {
    if (!entry || entry.type !== 'literal') continue;
    const v = entry.value;
    const text = typeof v === 'string' ? v : '';
    check(`C2 ${field} literal is not an unearned claim`,
      !UNEARNED_CLAIM.test(text),
      `literal ${JSON.stringify(v)} asserts a fact the data does not back`);
  }
}

// ── C3. structural literals are still ALLOWED (this is not a ban on all) ─
// Guards against "fixing" this by deleting every literal: a CTA label is a
// button, not a claim, and removing it would leave ads with no call to action.
const cta = DEFAULT_META_CASCADES.ctaText || [];
check('C3 ctaText keeps its structural literal fallback',
  cta.some((e) => e && e.type === 'literal' && typeof e.value === 'string' && e.value.trim()),
  'a CTA label is structural, not a claim — it should not have been removed');

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n❌ verifyNoUnearnedClaims: ${failures.length} FAILED, ${passed} passed (of ${total})\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`\n✅ verifyNoUnearnedClaims: ${passed} checks passed`);
