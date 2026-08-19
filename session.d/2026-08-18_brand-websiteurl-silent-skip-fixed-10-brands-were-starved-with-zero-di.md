## 2026-08-18 — Brand.websiteUrl silent-skip FIXED. 10 brands were starved with zero diagnostic trail.

Branch `fix/brand-websiteurl-backfill`. Root cause: `shopify-direct` / `sitemap-jsonld` /
legacy `apify-shopify` catalog ingest all resolve a storefront origin (usually
`Brand.apifyDemo.shopifyUrl`) to scrape from, but **never copied it onto `Brand.websiteUrl`** —
the field every enrichment tier (GPT tagline/summary/tone, website logo discovery, website font
ingest) actually gates on. A brand could hold a fully-synced catalog (Marine Layer: 2400+
products) and sit forever with a completely empty brand identity, because
`brandEnrichmentService.enrichBrandFromUrl`'s `if (!brand.websiteUrl) return {ok:false,
reason:'no websiteUrl'}` was reached only by fire-and-forget callers that `.catch()` and discard
the return value — nothing was ever persisted anywhere.

**Live sweep found 10 victims** (all demo brands, all with `apifyDemo.shopifyUrl` already set):
Marine Layer (2446 products), Marine Layer 2 (2295), Peloton (216), GymShark (207), PB5Star (108),
Soludos 2 (57), Fanatics (10), Fellow Products (9), livingspaces (5), Ubeauty (1).

**Fix, two parts:**

1. **New shared helper `services/brandWebsiteBackfill.js`** — `backfillBrandWebsiteUrl(brand,
   candidateUrl, opts)` writes `Brand.websiteUrl` the first time a catalog-ingest path proves a
   domain (`products.length > 0`, not merely a configured string), then fires `enrichBrandFromUrl`
   in the background. `safeWebsiteOrigin()` is the one place that decides a URL is safe to
   promote — it REJECTS `*.myshopify.com` (the headless-store EFFECTIVE BACKEND origin
   `shopifyPublicIngestService` substitutes when minting `productUrl` — GymShark's own products
   carry `gymsharkusa.myshopify.com` URLs even though the brand's real site is
   `www.gymshark.com`), plus `cdn.shopify.com` / `*.gstatic.com` / `*.cloudinary.com` /
   `*.googleusercontent.com`. Wired into `shopifyPublicIngestService.syncBrandShopifyDirect`
   (reads `origin` **before** the myshopify-backend override — critical ordering, see the file's
   own comment), `genericCatalogIngestService.syncBrandGenericCatalog`, and
   `apifyIngestService.syncBrandShopify`. Guards mirror the existing curated-brand guard at
   `brandCatalogService.js:57` (never overwrite an existing `websiteUrl`, never touch
   `source:'curated'` or a brand with `'websiteUrl'` in `curatedFields`).
2. **No more silent skip.** `Brand.websiteUrl` gained two fields:
   `enrichmentSkipReason` / `enrichmentSkippedAt`. `enrichBrandFromUrl`'s early return now
   persists WHY it declined (`markEnrichmentSkipped`) instead of discarding the reason; the
   record is cleared (`clearEnrichmentSkipped`) the moment enrichment actually proceeds. The
   Apify Instagram sync's enrichment trigger (`apifyIngestService.js`, previously
   `if (brand.websiteUrl) { ... }` around the whole call) and `routes/brand.js`'s
   `triggerEnrichment` helper now call `enrichBrandFromUrl` **unconditionally** — the function
   itself is the single place that decides and records "cannot run yet", so a caller-side guard
   can no longer swallow the reason before it's ever recorded.

**One-time historical back-fill:** `scripts/backfillBrandWebsiteUrl.js` (report mode is the
default — dry-run showed the exact diff before anything was written). Ran `--apply` against
production 2026-08-18: all 10 brands backfilled (all resolved via `apifyDemo.shopifyUrl`, none
needed the `productUrl`-majority-vote fallback), confirmed idempotent (0 candidates on re-run).

**Re-enrichment proof — all 10, live, with real Cloudinary/OpenAI/Atlas/Brandfetch/Gemini
credentials fetched from the Render WEB service via the repo's secret harness (never persisted to
disk).** Every brand went from empty (`tagline:null summary:null logoUrl:null customFonts:[]`) to
fully enriched: real tagline/summary/tone/hashtags/tags from GPT, a real mirrored logo (not the
favicon fallback), Brandfetch colors, and — for 7 of the 10 — real self-hosted web fonts (12
faces for GymShark, 8 for Soludos 2, 7 for PB5Star, 6 each for both Marine Layer brands, 5 for
Peloton, 2 for Fellow Products; Fanatics/livingspaces/Ubeauty found none, not an error — those
sites don't expose self-hosted `@font-face` faces to scrape). **No bot-blocking encountered on
either Marine Layer brand** — the task brief's speculation that Marine Layer "may be
bot-protected" did not materialize; both fully enriched in ~15-30s each. `styleTheme` /
`titleStyleSpec` remain unset on all 10 — confirmed via `models/Brand.js`'s own schema comment
that those are populated by a **separate, deliberate operator style-authoring flow**, not by
catalog ingest or `enrichBrandFromUrl` — not a gap this fix is expected to close.

**Harness:** `scripts/verifyBrandWebsiteBackfill.js` (26 checks, offline, revert-proven against
three mutations: removing `myshopify.com` from the host denylist → 3 checks fail; deleting the
`markEnrichmentSkipped` call → 1 fails; dropping the curated-source guard clause from the write
filter → 1 fails).

**Adjacent bug report investigated and NOT reproduced.** A concurrent session flagged Vuori
Clothing's `customFonts[]` as dead Typekit links silently recorded as successful ingests. Traced
with Grok + independently verified by reading the same code and by actually CALLING
`fontResolverService.resolveBrandFonts()` against the live brand doc: `downloadFontFile` sets a
`Referer`/`Origin` header from the brand's own homepage (`brandFontIngestService.js:521-549`),
which is why a bare `curl` of the raw Typekit URL 400s while the ingest's own fetch succeeded;
every download is magic-byte-validated before mirroring (`isFontMagic`, woff/woff2/otf/ttf/ttc
signatures) so a blocked/HTML response is flagged `{url:null, needsLicense:true}`, never a false
success; and `fontResolverService.familyKey()` normalizes both `"Aktiv Grotesk"` and
`"aktiv-grotesk"` to `"aktivgrotesk"`, so they already match. Live-swept all 43 `customFonts`
entries across the 7 brands that have any (Pelagic Gear, AllBirds, Vuori, GymShark, Hello, Marine
Layer ×2) — every single mirrored `url` is a real, fetchable, correctly-signed font file. Live
call to `resolveBrandFonts(vuoriBrand)` returns the real `aktiv-grotesk` custom face for
heading/body/quote, `fallback:'sans-serif'`, `exact:true` — not a serif default. **One real, if
minor, defect fixed**: `models/Brand.js`'s `customFonts` schema comment claimed commercial-foundry
faces are "recorded but never downloaded" — that only describes `BRAND_FONT_ASSUME_LICENSED=false`;
the shipped default (`true`, `config/defaults.env:387`) downloads and mirrors them like any other
face, which is the intended success path, not drift. Comment corrected in place. **Flagged, not
changed** — a real open question for the owner, not mine to decide: `BRAND_FONT_ASSUME_LICENSED`
defaulting to `true` means the app redistributes Typekit/Adobe-Fonts-licensed binaries from its
own public Cloudinary CDN, bypassing Typekit's own domain-restriction enforcement — a licensing
posture question, not a code bug, and flipping the default would immediately un-mirror Vuori's
(and any future commercial-font brand's) currently-working custom fonts.

**Not verified / known gaps, stated explicitly:** `styleTheme`/`titleStyleSpec` (separate
subsystem, see above). The 7-of-10 zero-custom-font brands were not individually root-caused
(likely just no self-hosted `@font-face` on those sites — Fanatics/livingspaces/Ubeauty read as
themed off third-party platforms). Ingest paths that mint `CatalogProduct` rows WITHOUT ever
resolving a storefront origin at all (`ig-catalog`/Meta, `detect-identified`, `manual-upload`)
were deliberately left untouched — they don't "learn a domain" in the sense this bug is about,
and the live sweep found zero non-demo, non-`apifyDemo`-configured brands in the starved set to
begin with, so there was nothing else in production to backfill from `CatalogProduct.productUrl`
majority-vote (the script's fallback path exists for a case that turned out not to be populated
yet, not one this session confirmed empirically).

**2026-08-19 addendum — SSRF hardening, coordinator review of PR #221 before merge.**
`safeWebsiteOrigin()`'s CDN/backend denylist blocked the WRONG-host case but not the
DANGEROUS-host case: `Brand.websiteUrl` can originate from scraped `CatalogProduct.productUrl`
data (content this app does not control) and is then `axios.get`-ed verbatim, repeatedly, by
three services — a real, if low-likelihood, SSRF path into cloud metadata / internal
infrastructure. Added to `services/brandWebsiteBackfill.js`:

- `isPrivateOrLoopbackHost()` — rejects loopback (127.0.0.0/8, `::1`), RFC1918 private ranges
  (10/8, 172.16/12 — boundary-exact, 172.32.0.0 is correctly NOT collateral damage, 192.168/16),
  link-local (169.254.0.0/16, which is also where cloud-metadata endpoints live; `fe80::/10`),
  IPv6 unique-local (`fc00::/7`), `0.0.0.0`, and `localhost`/`*.internal`/`*.local`. Numeric/hex/
  octal IPv4 obfuscation (`2130706433`, `0x7f000001`, `017700000001`, `127.1`) needed no special
  handling — Node's `URL` parser canonicalizes all of those to dotted-quad form before this code
  ever inspects `hostname`. IPv4-mapped IPv6 needed TWO forms handled: the rare dotted
  (`::ffff:127.0.0.1`) and the form Node actually produces for a literal typed that way,
  canonical hex-groups (`::ffff:7f00:1`) — decoding the two hex groups back to a dotted quad
  before recursing was required, or this exact case (caught by testing, not assumed) slipped
  through as `[::ffff:7f00:1]`, unblocked.
- `safeWebsiteOrigin()` also now rejects an explicit non-http(s) scheme (`file:`, `javascript:`,
  `data:`, `gopher:`, `ftp:`) BEFORE the `https://` prepend coercion — without this,
  `"file:///etc/passwd"` silently became hostname `"file"` (protocol `https:` after the prepend,
  so it passed every check) rather than failing loud.
- **A protocol-relative (`//host/path`) special case was written, tested, and then DELETED** —
  revert-proving it (per the coordinator's ask) proved it dead: prepending `https:` in front of
  `//host/path` degrades to `https:////host/path`, which the WHATWG parser still resolves to the
  real `host`, so the private-IP and CDN checks already cover it with no special-casing. Kept as
  a positive/negative pair in the harness (A19) documenting the mechanism instead of asserting a
  branch that added test surface with no actual safety.
- Userinfo/fragment host-confusion (`evil.com@169.254.169.254`, `https://169.254.169.254#evil.com`)
  needed no special handling either — `new URL()` already separates those from `hostname` before
  this code ever looks at it.

Extended `scripts/verifyBrandWebsiteBackfill.js` to 37 checks (A11-A20 + one `isPrivateOrLoopbackHost`
regression guard — a real hostname that merely *starts* with private-range-looking digits, e.g.
`10.example.com`, must never be judged by a text-prefix match). Revert-proven against 4 mutations
(the coordinator asked for the denylist and scheme-rejection removals specifically; two more —
breaking the IPv4-mapped-IPv6 hex decode, and confirming the protocol-relative branch's absence
doesn't regress anything — were added during this pass). `cdn.shopify.com` blocked but bare
`shopify.com` not: left as is per the coordinator's own "your call, probably immaterial" —
it's not a CDN and not a private/loopback target, so it doesn't fit either denylist's actual
purpose, and blocking it risks false-positiving a legitimate (if unusual) case for no security
benefit.
