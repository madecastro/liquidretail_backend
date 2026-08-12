// scripts/verifyShopifyLadderBlocks.js
//
// The Shopify access ladder used to ignore the `block` field that
// httpScrapeClient already computes. It branched only on
// `rateLimited || cfChallenged` and otherwise did a bare `if (!res.ok) break`.
//
// Consequence: an Akamai / PerimeterX / DataDome / Incapsula block on
// products.json was INDISTINGUISHABLE from "this store has zero products".
// The ladder reported "all access rungs empty", the caller degraded to the
// sitemap+JSON-LD walk, and the catalog silently went from the full
// products.json gallery (~7.9 images/product) to ~1 featured thumbnail —
// which is how thumbnails end up as ad seeds.
//
// These checks pin the DISTINCTION. Fully offline: httpScrapeClient is
// stubbed through the require cache before the resolver is loaded, so no
// network, DB or API keys are touched.

const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`✓ ${label}`);
    return;
  }
  fail += 1;
  const msg = detail != null ? `${label}: ${detail}` : label;
  failures.push(msg);
  console.log(`❌ ${msg}`);
}

// ── stub httpScrapeClient BEFORE the resolver requires it ──────────
const HTTP_PATH = require.resolve('../services/httpScrapeClient');

// `responder(url, opts)` returns the fake response object.
function installHttp(responder) {
  require.cache[HTTP_PATH] = {
    id: HTTP_PATH,
    filename: HTTP_PATH,
    loaded: true,
    exports: {
      fetchJson: async (url, opts) => responder(url, opts),
      fetchText: async (url, opts) => responder(url, opts),
      fetchHead: async (url, opts) => responder(url, opts)
    }
  };
  // Drop the resolver so it re-requires the stub.
  delete require.cache[require.resolve('../services/shopifyAccessResolver')];
  return require('../services/shopifyAccessResolver');
}

const AKAMAI_BLOCK = {
  vendor: 'akamai',
  confidence: 'high',
  remedy: 'needs-unblocker',
  signals: ['header:akamai-grn', 'status:403']
};

const BRAND = { shopifyUrl: 'https://blocked.example' };

// Captured so E4 can compare the two outcomes for real instead of
// asserting a literal true.
const observed = { blockedReason: null, emptyReason: null };

// Every response shape the ladder can see, with no products anywhere.
const emptyOk = { ok: true, status: 200, json: { products: [] }, text: '', block: null };
const blocked403 = { ok: false, status: 403, json: null, text: '', block: AKAMAI_BLOCK };

async function main() {
  // ── 1. BLOCKED store ───────────────────────────────────────────
  {
    const { resolveShopifyAccess } = installHttp(() => blocked403);
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });

    observed.blockedReason = out.reason;
    check('B1 blocked store does not report ok', out.ok === false, `ok=${out.ok}`);
    check(
      'B2 blocked store surfaces out.blocked with the vendor',
      out.blocked && out.blocked.vendor === 'akamai',
      `blocked=${JSON.stringify(out.blocked)}`
    );
    check(
      'B3 reason NAMES the block instead of claiming the store is empty',
      typeof out.reason === 'string' &&
        /akamai/i.test(out.reason) &&
        !/all access rungs empty \(products\.json/i.test(out.reason),
      `reason=${out.reason}`
    );
    check(
      'B4 reason explicitly denies "empty store" (the misdiagnosis this fixes)',
      /not an empty store/i.test(out.reason || ''),
      `reason=${out.reason}`
    );
    check(
      'B5 remedy is carried through so an operator knows what to do',
      out.blocked && out.blocked.remedy === 'needs-unblocker',
      `remedy=${out.blocked && out.blocked.remedy}`
    );
  }

  // ── 2. GENUINELY empty store — must NOT look blocked ───────────
  {
    const { resolveShopifyAccess } = installHttp(() => emptyOk);
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });

    observed.emptyReason = out.reason;
    check('E1 empty store does not report ok', out.ok === false, `ok=${out.ok}`);
    check(
      'E2 empty store has NO blocked field (no false positives)',
      out.blocked == null,
      `blocked=${JSON.stringify(out.blocked)}`
    );
    check(
      'E3 empty store keeps the original "all access rungs empty" reason',
      /all access rungs empty/i.test(out.reason || ''),
      `reason=${out.reason}`
    );
    // The entire premise of this change: a blocked store and an empty store
    // must not produce the same operator-facing answer. Asserting a literal
    // `true` here would have passed against the ORIGINAL bug, where both
    // produced "all access rungs empty" — so compare the real strings.
    check(
      'E4 blocked and empty produce DIFFERENT reasons — the whole point',
      typeof observed.blockedReason === 'string' &&
        typeof observed.emptyReason === 'string' &&
        observed.blockedReason !== observed.emptyReason,
      `blocked="${observed.blockedReason}" empty="${observed.emptyReason}"`
    );
  }

  // ── 2b. PER-RUNG isolation. The blocked-everywhere fixture above cannot
  // catch a single rung dropping its `blocked` value, because a later rung
  // sets anyBlocked anyway. Block exactly ONE rung and leave the rest
  // cleanly empty, so each rung's propagation is pinned on its own.
  {
    const { resolveShopifyAccess } = installHttp((url) =>
      /products\.json/i.test(url) ? blocked403 : emptyOk
    );
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'P1 products.json alone blocked → still surfaced (pins THAT rung)',
      out.blocked && out.blocked.vendor === 'akamai',
      `blocked=${JSON.stringify(out.blocked)} reason=${out.reason}`
    );
  }
  {
    const { resolveShopifyAccess } = installHttp((url) =>
      /graphql/i.test(url) ? blocked403 : emptyOk
    );
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'P2 storefront graphql alone blocked → still surfaced (pins THAT rung)',
      out.blocked && out.blocked.vendor === 'akamai',
      `blocked=${JSON.stringify(out.blocked)} reason=${out.reason}`
    );
  }
  {
    const { resolveShopifyAccess } = installHttp((url) =>
      /sitemap/i.test(url) ? blocked403 : emptyOk
    );
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'P3 sitemap alone blocked → still surfaced (pins THAT rung)',
      out.blocked && out.blocked.vendor === 'akamai',
      `blocked=${JSON.stringify(out.blocked)} reason=${out.reason}`
    );
  }

  // ── 2c. FALSE-POSITIVE guards. classifyBlock is not "bot walls only":
  // a bare 401/403 is generic-403/low, which is exactly what a
  // PASSWORD-PROTECTED Shopify store returns, and a 429 is vendor
  // 'rate-limited'. Neither may be asserted as "the catalog was never
  // readable, get an unblocker".
  {
    const denied403 = {
      ok: false, status: 403, json: null, text: '',
      block: { vendor: 'generic-403', confidence: 'low', remedy: 'needs-unblocker', signals: ['status:403'] }
    };
    const { resolveShopifyAccess } = installHttp(() => denied403);
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'F1 a bare 403 (password-protected store) does NOT claim a named bot vendor',
      !/blocked by generic-403/i.test(out.reason || ''),
      `reason=${out.reason}`
    );
    check(
      'F2 a bare 403 hedges instead of asserting "never readable"',
      /access denied/i.test(out.reason || '') &&
        /password-protected/i.test(out.reason || ''),
      `reason=${out.reason}`
    );
  }
  {
    const tooMany = {
      ok: false, status: 429, json: null, text: '', rateLimited: true,
      block: { vendor: 'rate-limited', confidence: 'high', remedy: 'backoff-retry', signals: ['status:429'] }
    };
    const { resolveShopifyAccess } = installHttp(() => tooMany);
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'F3 a 429 keeps the rate-limited reason (block must not override it)',
      /rate-limited this server/i.test(out.reason || ''),
      `reason=${out.reason}`
    );
    check(
      'F4 a 429 is not recorded as a ladder block',
      out.blocked == null,
      `blocked=${JSON.stringify(out.blocked)}`
    );
  }

  // ── 3. A block on a LATER rung is still reported ───────────────
  {
    // products.json answers 200-but-empty; the sitemap rung is blocked.
    const { resolveShopifyAccess } = installHttp((url) => {
      if (/products\.json/i.test(url)) return emptyOk;
      return blocked403;
    });
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check(
      'L1 a block on a non-first rung is still surfaced',
      out.blocked && out.blocked.vendor === 'akamai',
      `blocked=${JSON.stringify(out.blocked)}`
    );
  }

  // ── 4. A store that WORKS must be unaffected ───────────────────
  {
    const { resolveShopifyAccess } = installHttp((url) => {
      if (/products\.json/i.test(url)) {
        return {
          ok: true,
          status: 200,
          block: null,
          json: {
            products: [
              {
                id: 1,
                handle: 'tee',
                title: 'Tee',
                variants: [{ id: 9, price: '19.99' }],
                images: [{ id: 3, src: 'https://cdn.shopify.com/s/files/1/a.jpg' }]
              }
            ]
          }
        };
      }
      return emptyOk;
    });
    const out = await resolveShopifyAccess(BRAND, { cap: 10 });
    check('W1 a healthy store still resolves ok', out.ok === true, `ok=${out.ok}`);
    check('W2 a healthy store reports products-json mode', out.mode === 'products-json', `mode=${out.mode}`);
    check('W3 a healthy store carries no blocked field', out.blocked == null, `blocked=${JSON.stringify(out.blocked)}`);
    check('W4 a healthy store returns its products', (out.products || []).length === 1, `n=${(out.products || []).length}`);
  }

  console.log('');
  console.log(`${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log('');
    failures.forEach(f => console.log(`  ❌ ${f}`));
  }
  console.log(`
Revert-prove (each should turn the named checks red):
  M1 drop \`blocked\` from fetchProductsJson's return      → B2, B3, B4, B5
  M2 drop \`if (anyBlocked) out.blocked = anyBlocked\`      → B2, B5
  M3 restore the old two-branch \`reason\` ternary          → B3, B4
  M4 set anyBlocked unconditionally (ignore res.block)     → E2 (false positive)
`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
