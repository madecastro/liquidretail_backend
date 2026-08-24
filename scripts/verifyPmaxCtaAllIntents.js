#!/usr/bin/env node
/**
 * Offline behavioural harness for PMAX_STATIC_CTA_ALL_INTENTS
 * (owner decision 2026-08-24). No DB, no network, no API key.
 *
 * THE DEFECT THIS EXISTS FOR. Until this flag, resolveDrawCta burned a CTA
 * into a PMax static for exactly ONE intent — `objection_resolved` — and
 * suppressed it for social_proof_led / product_first_lifestyle / brand_led.
 * That allowlist was never an owner decision about proof-led creative. It
 * arrived whole in the PMax activation commit as a class rule ("Google draws
 * its own button, so suppress ours except on the conversion intent") and its
 * body was never revisited, while three things in the live repo disagreed:
 * INTENTS.social_proof_led.ownerBrief asks for a "Clear Shop Now CTA", and
 * the PMax VIDEO path burns one in on EVERY intent precisely because
 * YouTube/Display supply none (that evidence lives in the sibling repo,
 * liquidretail_backend scripts/verifyProofBeat.js M1 — not here).
 * NOT cited as support: platformFormats.js's "prominent CTA" brief line. It
 * exists only on pmax_16_9, which is coming_soon; the three LIVE pmax statics
 * say nothing about a CTA. Recorded so nobody re-uses it as evidence.
 *
 * MEASURED on the live corpus before anything was changed — 69 PMax statics
 * carrying an intentResolution stamp, 2026-08-20 → 2026-08-24:
 *
 *     product_first_lifestyle   28   no CTA
 *     brand_led                 18   no CTA
 *     social_proof_led          11   no CTA
 *     objection_resolved         7   CTA    <- ALL of them fellBackFrom social_proof_led
 *     product_first_lifestyle    5   no CTA (also fellBackFrom social_proof_led)
 *
 * Only 7 of 69 drew a button, and every one of those seven was a
 * social_proof_led render whose proof was too thin to hold the intent and
 * descended to objection_resolved. The rule therefore REWARDED FAILED PROOF
 * with a CTA and denied it to proof that held — an inversion nobody chose.
 * PR #34's STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE closed that descent (a
 * quote-only render now stays on social_proof_led), which under the original
 * allowlist would have taken burned-in CTAs on PMax statics from 7/69 to
 * 0/69. PR #42 then restored the button for exactly that quote-only shape,
 * deliberately leaving the 11 RATED social_proof_led statics still
 * button-less and calling that an owner decision. This harness pins the
 * owner's answer: every intent draws.
 *
 * WHAT IS PINNED. Flag ON (the default): every pmax_* static draws the CTA on
 * every intent — pmax keeps its own SURFACE_POLICY.drawCta boolean exactly the
 * way Meta always has. Flag OFF: the pre-change allowlist byte-identically,
 * INCLUDING PR #42's quote-only branch — this switch must not silently revert
 * a separate decision, and group C proves it does not.
 * Meta is untouched in BOTH arms — including meta_stories_9_16, whose
 * drawCta:false is a surface fact about Instagram's link sticker (owner
 * reaffirmed 2026-08-13) and must never be collateral damage here.
 *
 * BEHAVIOURAL ONLY — every assertion below comes from calling the real
 * buildPrompt() and reading the prompt it returns. Nothing scans source text,
 * so a reimplementation that merely keeps the function name cannot pass.
 * `staticAdIntents` reads process.env at require time, so the flag-OFF arm is
 * collected from a genuine child process (see collectArm).
 *
 * Run: node scripts/verifyPmaxCtaAllIntents.js
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// The absence sentence buildPrompt emits when a surface draws NO button.
// Matching its opening clause is enough and survives ctaNote changes.
const ABSENCE_MARK = 'no CTA button, no "shop now"';
const SENTINEL = '__PMAXCTA_JSON__';
// Anti-CTA phrasings swept by E1. Kept as a list, not one string, so a newly
// added PLATFORM_NOTES sentence telling the model to skip the button is caught
// rather than slipping past a single hardcoded phrase.
const ANTI_CTA_PHRASES = [
  'the platform supplies', 'no CTA button', 'do not draw', 'do not burn',
  'overlay their own', 'supplies its own', 'supplies the link',
  'without a button', 'no button'
];

// ── fixtures ────────────────────────────────────────────────────────────
// Four data shapes so every intent in INTENTS is reachable. `cta` is always
// present because the live path guarantees one — directImageRenderService's
// buildIntentData ends `cta: normalizeCtaCasing(cta) || 'Shop now'` — so a
// fixture without one would test a state production cannot reach.
const CTA_TEXT = 'Shop the Tee';
const FIXTURES = {
  quoteOnly:   { quote: 'Held up through three washes with zero fading.', attribution: 'Dana R.', badge: 'Best Seller', headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  ratingQuote: { quote: 'Held up through three washes with zero fading.', attribution: 'Dana R.', badge: 'Best Seller', rating: '4.8', reviewCount: 523, headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  ratingOnly:  { rating: '4.8', reviewCount: 523, badge: 'Best Seller', headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  bare:        { headline: 'Built to last', cta: CTA_TEXT }
};
const PRODUCT = { title: 'Cruiser Tee', desc: 'a mens cruiser tee', logoCorner: 'bottom-right', look: 'sun-bleached coastal' };

/**
 * Body run inside BOTH arms. Enumerates surfaces from the real SURFACE_POLICY
 * and intents from the real INTENTS — never a hardcoded list — so a newly
 * added surface or intent is covered the day it lands rather than silently
 * escaping the pin.
 */
const ARM_SOURCE = `
const mod = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'staticAdIntents.js'))});
const crypto = require('crypto');
const FIXTURES = ${JSON.stringify(FIXTURES)};
const PRODUCT = ${JSON.stringify(PRODUCT)};
const ABSENCE_MARK = ${JSON.stringify(ABSENCE_MARK)};
const ANTI_CTA = ${JSON.stringify(ANTI_CTA_PHRASES)};
const out = {};
for (const [dk, data] of Object.entries(FIXTURES)) {
  for (const surface of Object.keys(mod.SURFACE_POLICY).filter((k) => mod.SURFACE_POLICY[k].static)) {
    for (const intentKey of Object.keys(mod.INTENTS)) {
      const r = mod.buildPrompt({ intentKey, data, product: PRODUCT, surface });
      if (r.error || r.skipped) { out[dk + '|' + surface + '|' + intentKey] = { skipped: String(r.error || r.skipped) }; continue; }
      const ctaRow = (r.text || []).find(([role]) => role === 'CTA BUTTON') || null;
      out[dk + '|' + surface + '|' + intentKey] = {
        resolved:      r.resolved.key,
        drawCta:       r.policy.drawCta,
        roles:         (r.text || []).map(([role]) => role),
        ctaText:       ctaRow ? String(ctaRow[1]) : null,
        ctaInPrompt:   ctaRow ? r.prompt.includes(String(ctaRow[1])) : false,
        hasAbsence:    r.prompt.includes(ABSENCE_MARK),
        antiCta: ANTI_CTA.filter((phrase) => r.prompt.includes(phrase)),
        sha:           crypto.createHash('sha256').update(r.prompt).digest('hex')
      };
    }
  }
}
process.stdout.write('\\n' + ${JSON.stringify(SENTINEL)} + JSON.stringify(out) + '\\n');
`;

/**
 * buildPrompt console.log()s SCENE_PRESERVE trace lines on some inputs, so the
 * payload is emitted behind a sentinel and only that line is parsed. Parsing
 * whole stdout would break the day another trace line is added.
 */
function collectArm(env, unset = false) {
  const childEnv = { ...process.env, ...env };
  // `{ VAR: undefined }` still yields the string 'undefined' in a child env on
  // some platforms, so genuinely delete it rather than trusting the spread.
  if (unset) delete childEnv.PMAX_STATIC_CTA_ALL_INTENTS;
  const stdout = execFileSync(process.execPath, ['-e', ARM_SOURCE], {
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
  if (!line) throw new Error('arm produced no sentinel payload');
  return JSON.parse(line.slice(SENTINEL.length));
}

const ON  = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: 'true' });
const OFF = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: 'false' });
// Third arm with the variable genuinely ABSENT. Without this, changing the
// declaration from `!== 'false'` to `=== 'true'` would flip the committed
// default to OFF and every explicit-value check above would still pass.
const UNSET = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: undefined }, true);

const keys      = Object.keys(ON).filter((k) => !ON[k].skipped);
const isPmax    = (k) => k.split('|')[1].startsWith('pmax');
const surfaceOf = (k) => k.split('|')[1];
const pmaxKeys  = keys.filter(isPmax);
const metaKeys  = keys.filter((k) => !isPmax(k));

check('A0 the enumeration actually produced pmax and meta combinations',
  pmaxKeys.length > 0 && metaKeys.length > 0,
  `pmax=${pmaxKeys.length} meta=${metaKeys.length}`);

// ── A. FLAG ON — every pmax static x every intent draws the button ──────
{
  const noDraw = pmaxKeys.filter((k) => ON[k].drawCta !== true);
  check('A1 flag ON: drawCta === true for every pmax static x intent',
    noDraw.length === 0, noDraw.slice(0, 6).join(', '));

  const noRole = pmaxKeys.filter((k) => ON[k].ctaText === null);
  check('A2a flag ON: a CTA BUTTON role is emitted for every pmax static x intent',
    noRole.length === 0, noRole.slice(0, 6).join(', '));

  // Every intent emits ['CTA BUTTON', d.cta] UNGATED, so a caller that omitted
  // the string would ship the literal word "undefined" into the prompt. On
  // pmax that row used to be stripped for 3 of 4 intents and now survives, so
  // the ungated shape is newly load-bearing here.
  const badText = pmaxKeys.filter((k) => !ON[k].ctaText || ON[k].ctaText === 'undefined');
  check('A2b flag ON: the CTA string is non-empty and never the literal "undefined"',
    badText.length === 0, badText.slice(0, 6).join(', '));

  // A2b alone is a FIXTURE TAUTOLOGY — every fixture above sets `cta`. What
  // actually protects production is the chokepoint: the single live
  // buildPrompt caller (directImageRenderService.js) always routes data
  // through buildIntentData, which ends `cta: normalizeCtaCasing(cta) ||
  // 'Shop now'`. Pin THAT, so the guarantee is asserted where it really lives.
  //
  // directImageRenderService pulls third-party deps (axios), so in a BARE
  // worktree with no node_modules this cannot load. runVerifySuite.js points
  // NODE_PATH at the sibling backend, so it DOES run under `npm test` — the
  // real gate. Standalone, it SKIPS LOUDLY rather than passing vacuously, and
  // only a genuine MODULE_NOT_FOUND on a third-party dep counts as skippable:
  // any other error is a real failure and is reported as one.
  {
    let direct = null;
    let loadErr = null;
    try {
      direct = require('../src/services/directImageRenderService');
    } catch (err) {
      loadErr = err;
    }
    const envSkip = loadErr && loadErr.code === 'MODULE_NOT_FOUND'
      && !/directImageRenderService/.test(String(loadErr.message).split('\n')[0]);

    if (envSkip) {
      console.warn('   ⚠️  A2c/A2d SKIPPED — directImageRenderService could not load '
        + `(${String(loadErr.message).split('\n')[0]}). This is a bare-worktree `
        + 'environment limit, NOT a pass. Run via `npm test`, which sets NODE_PATH.');
    } else if (loadErr) {
      check('A2c live chokepoint module loads', false, `unexpected load error: ${loadErr.message}`);
    } else {
      let missing = null;
      let blank = null;
      let threw = null;
      try {
        missing = direct.buildIntentData({ concept: {}, layoutInput: {}, brand: {} });
        blank   = direct.buildIntentData({ concept: {}, layoutInput: {}, brand: {}, cta: '   ' });
      } catch (err) { threw = err.message; }
      const usable = (d) => d && typeof d.cta === 'string' && d.cta.trim().length > 0;
      check('A2c the live chokepoint defaults a MISSING cta rather than passing undefined through',
        usable(missing), threw ? `threw: ${threw}` : `got ${JSON.stringify(missing && missing.cta)}`);
      check('A2d the same chokepoint defaults a whitespace-only cta too (blank-pill guard)',
        usable(blank), threw ? `threw: ${threw}` : `got ${JSON.stringify(blank && blank.cta)}`);
    }
  }
}

// ── B. META IS UNTOUCHED ────────────────────────────────────────────────
{
  const feed = metaKeys.filter((k) => surfaceOf(k).startsWith('meta_feed'));
  check('B1a meta_feed_* combinations exist', feed.length > 0);
  check('B1b flag ON: meta_feed_* keeps drawCta true for every intent',
    feed.every((k) => ON[k].drawCta === true),
    feed.filter((k) => ON[k].drawCta !== true).slice(0, 6).join(', '));

  // Instagram supplies its own link sticker — owner-reaffirmed 2026-08-13.
  // Widening PMax must never spill onto Stories.
  const stories = metaKeys.filter((k) => surfaceOf(k) === 'meta_stories_9_16');
  check('B2a meta_stories_9_16 combinations exist', stories.length > 0);
  check('B2b flag ON: meta_stories_9_16 still suppresses the CTA on every intent',
    stories.every((k) => ON[k].drawCta === false && ON[k].ctaText === null),
    stories.filter((k) => ON[k].drawCta !== false || ON[k].ctaText !== null).slice(0, 6).join(', '));
  check('B2c flag ON: meta_stories_9_16 still carries the "no CTA button" absence line',
    stories.every((k) => ON[k].hasAbsence),
    stories.filter((k) => !ON[k].hasAbsence).slice(0, 6).join(', '));

  const metaDrift = metaKeys.filter((k) => ON[k].sha !== OFF[k].sha);
  check('B3 every Meta prompt is sha256-identical between the ON and OFF arms',
    metaDrift.length === 0, metaDrift.slice(0, 6).join(', '));
}

// ── C. FLAG OFF restores the pre-change allowlist ───────────────────────
{
  // NOTE — resolveDrawCta is handed the RESOLVED intent, never the requested
  // one, and (since PR #42) also the `data`. Keying these on the requested key
  // reads as a failure on exactly the fallbacks this work is about, so assert
  // against `resolved` — what actually ran.
  //
  // The flag-OFF arm must restore the allowlist as it stood immediately before
  // this change, which INCLUDES PR #42's quote-only social_proof_led branch.
  // Reverting further would silently undo a separate decision, so that branch
  // is pinned here as part of the OFF contract, not merely tolerated.
  const hasRating = (k) => k.startsWith('ratingQuote|') || k.startsWith('ratingOnly|');
  const hasQuote  = (k) => k.startsWith('ratingQuote|') || k.startsWith('quoteOnly|');
  const expectedOff = (k) =>
    OFF[k].resolved === 'objection_resolved' ||
    (OFF[k].resolved === 'social_proof_led' && !hasRating(k) && hasQuote(k));

  const wrong = pmaxKeys.filter((k) => OFF[k].drawCta !== expectedOff(k));
  check('C1 flag OFF: pmax drawCta === conversion intent OR PR #42 quote-only social_proof_led',
    wrong.length === 0, wrong.slice(0, 6).join(', '));

  // C2 splits social_proof_led by data shape, because the two halves have
  // DIFFERENT pre-change behaviour and conflating them is what would let a
  // silent #42 revert slip through.
  const splRated = pmaxKeys.filter((k) => OFF[k].resolved === 'social_proof_led' && hasRating(k));
  check('C2a the RATED social_proof_led population exists in these fixtures',
    splRated.length > 0, `${splRated.length} combinations`);
  check('C2b flag OFF: RATED pmax social_proof_led draws NO CTA (the population this PR changes)',
    splRated.every((k) => OFF[k].drawCta === false && OFF[k].ctaText === null),
    splRated.filter((k) => OFF[k].drawCta !== false || OFF[k].ctaText !== null).slice(0, 6).join(', '));
  check('C2c flag OFF: RATED pmax social_proof_led carries the "no CTA button" absence line',
    splRated.every((k) => OFF[k].hasAbsence),
    splRated.filter((k) => !OFF[k].hasAbsence).slice(0, 6).join(', '));

  // PR #42 preserved by the OFF arm — the anti-silent-revert pin.
  const splQuoteOnly = pmaxKeys.filter((k) => OFF[k].resolved === 'social_proof_led' && !hasRating(k) && hasQuote(k));
  check('C2d the quote-only social_proof_led population exists (PR #34 made it reachable)',
    splQuoteOnly.length > 0, `${splQuoteOnly.length} combinations`);
  check('C2e flag OFF: quote-only pmax social_proof_led STILL draws — PR #42 is not reverted',
    splQuoteOnly.every((k) => OFF[k].drawCta === true && OFF[k].ctaText !== null),
    splQuoteOnly.filter((k) => OFF[k].drawCta !== true).slice(0, 6).join(', '));

  // Without this, a flag that silently did nothing would pass every other
  // check in the file.
  const changed = pmaxKeys.filter((k) => ON[k].sha !== OFF[k].sha);
  check('C3 the flag genuinely changes pmax prompt bytes (not a no-op switch)',
    changed.length > 0, `${changed.length} of ${pmaxKeys.length} pmax combinations differ`);
}

// ── D. DENSITY — the button must not displace real copy ─────────────────
{
  // pmax_landscape_1_91_1 carries maxTextElements 3, the tightest static
  // budget, and `ratingQuote` saturates it. PR #200 made applyDensity count
  // PROSE only (CTA BUTTON excluded from the budget comparison); D1 is the
  // behavioural proof that still holds now that the button is actually drawn.
  const tight = keys.filter((k) => surfaceOf(k) === 'pmax_landscape_1_91_1' && k.startsWith('ratingQuote|'));
  check('D0 the tight-budget pmax_landscape_1_91_1 combinations exist', tight.length > 0);
  const displaced = tight.filter((k) => {
    const prose = (o) => o.roles.filter((r) => r !== 'CTA BUTTON').join(',');
    return prose(ON[k]) !== prose(OFF[k]);
  });
  check('D1 adding the CTA sacrifices no prose role on the tightest pmax budget',
    displaced.length === 0,
    displaced.map((k) => `${k}: ON[${ON[k].roles}] vs OFF[${OFF[k].roles}]`).slice(0, 4).join(' | '));
}

// ── E. NO SELF-CONTRADICTORY PROMPT ─────────────────────────────────────
{
  // The PR #61 class: a prompt that draws a button while also telling the
  // model not to, or that something else supplies one. A single-phrase search
  // is too narrow — it would miss a new sentence added to PLATFORM_NOTES — so
  // sweep a family of anti-CTA phrasings. Scoped to pmax-with-CTA: several of
  // these legitimately appear on meta_stories_9_16 via its ctaNote.
  const ANTI_CTA = [
    'the platform supplies',
    'no CTA button',
    'do not draw',
    'do not burn',
    'overlay their own',
    'supplies its own',
    'supplies the link',
    'without a button',
    'no button'
  ];
  const drawn = pmaxKeys.filter((k) => ON[k].drawCta === true);
  check('E0 there are pmax prompts drawing a CTA to check', drawn.length > 0);
  const contradictory = drawn.filter((k) => ON[k].antiCta && ON[k].antiCta.length);
  check('E1 no pmax prompt that draws a CTA also tells the model not to',
    contradictory.length === 0,
    contradictory.slice(0, 4).map((k) => `${k}: ${ON[k].antiCta.join('/')}`).join(' | '));
}

// ── F. THE COMMITTED DEFAULT ────────────────────────────────────────────
{
  // Every check above passes an EXPLICIT 'true'/'false'. That leaves the
  // committed default untested: flipping the declaration from `!== 'false'`
  // to `=== 'true'` would ship the feature OFF and everything above would
  // still be green. UNSET is collected with the variable genuinely absent.
  const drift = keys.filter((k) => UNSET[k].sha !== ON[k].sha);
  check('F1 with PMAX_STATIC_CTA_ALL_INTENTS UNSET, behaviour is identical to explicitly ON',
    drift.length === 0, `${drift.length} combinations differ; e.g. ${drift.slice(0, 3).join(', ')}`);
  const unsetPmaxOff = pmaxKeys.filter((k) => UNSET[k].drawCta !== true);
  check('F2 the shipped default really draws the CTA on every pmax static x intent',
    unsetPmaxOff.length === 0, unsetPmaxOff.slice(0, 6).join(', '));
}

console.log(`   (${keys.length} live buildPrompt combinations per arm; ${pmaxKeys.length} pmax, ${metaKeys.length} meta)`);
if (failures.length) {
  console.error(`\n❌ pmax CTA all intents: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ pmax CTA all intents: ${pass} checks passed`);
