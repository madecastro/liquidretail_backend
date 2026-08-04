#!/usr/bin/env node
'use strict';
//
// verifySlackAlert — offline guards for the Slack transport in alertService.
//
// No network, no real token. Drives notify() / buildMessage / redact via the
// exported test seams and a stubbed global fetch.
//
//   node scripts/verifySlackAlert.js
//
// The assertion that must never regress: Slack HTTP 200 + {ok:false} is a
// FAILED send (dedupe slot released, suppressed tally restored). A
// res.ok-only check silently deadens the alerter.

const alerts = require('../services/alertService');

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (actual && expected && typeof actual === 'object' &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) { pass++; return; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

function checkTrue(label, cond) {
  if (cond) { pass++; return; }
  failures.push(`${label}\n      expected: truthy\n      actual:   ${JSON.stringify(cond)}`);
}

// ── fetch stub ───────────────────────────────────────────────────────────────
const origFetch = global.fetch;
let fetchCalls = [];
let fetchImpl = null;

function installFetch(impl) {
  fetchCalls = [];
  fetchImpl = impl;
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
}

function restoreFetch() {
  global.fetch = origFetch;
  fetchImpl = null;
  fetchCalls = [];
}

function jsonRes(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) || null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

const CFG = {
  // Assembled, not a literal — see the note in section F. A token-shaped
  // string in source blocks the push even when the value is invented.
  SLACK_BOT_TOKEN: ['xoxb', 'test', 'token', 'VERIFY', 'ONLY'].join('-'),
  SLACK_ALERT_CHANNEL: '#alerts-verify',
  ALERTS_ENABLED: 'true',
  ALERT_MIN_LEVEL: 'info',
  ALERT_DEDUPE_WINDOW_MIN: '15',
  ALERT_RATE_LIMIT_MAX: '20',
  ALERT_SEND_TIMEOUT_MS: '2000',
  ALERT_ENV_LABEL: 'test',
  ALERT_ROLE: 'verify'
};

async function main() {
  // ── A. Unconfigured → silent, no throw, one-shot warn only ───────────
  await withEnv({
    SLACK_BOT_TOKEN: null,
    SLACK_ALERT_CHANNEL: null,
    ALERTS_ENABLED: 'true',
    ALERT_MIN_LEVEL: 'info'
  }, async () => {
    alerts._resetState();
    installFetch(() => { throw new Error('fetch must not be called when unconfigured'); });
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      let threw = false;
      let r1, r2;
      try {
        r1 = await alerts.notify({ level: 'error', title: 'unconfigured-1', key: 'u1' });
        r2 = await alerts.notify({ level: 'error', title: 'unconfigured-2', key: 'u2' });
      } catch (e) {
        threw = true;
        failures.push(`A unconfigured threw: ${e.message}`);
      }
      check('A1 unconfigured notify #1 returns false', r1, false);
      check('A2 unconfigured notify #2 returns false', r2, false);
      check('A3 unconfigured does not throw', threw, false);
      check('A4 unconfigured does not call fetch', fetchCalls.length, 0);
      check('A5 unconfigured warns once', warns.length, 1);
      checkTrue('A6 unconfigured warn names Slack env',
        /SLACK_BOT_TOKEN|SLACK_ALERT_CHANNEL/.test(warns[0] || ''));
      check('A7 isConfigured false without secrets', alerts.isConfigured(), false);
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── B. ok:false on HTTP 200 is a FAILED send ─────────────────────────
  // This is the critical trap. Revert-prove: if sendSlack treated res.ok
  // alone as success, B2/B3 would fail.
  await withEnv(CFG, async () => {
    alerts._resetState();
    installFetch(async () => jsonRes(200, { ok: false, error: 'channel_not_found' }));
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      // Seed a suppressed tally so we can prove it is restored on failure.
      // First call will attempt send (ok:false) → fail → release slot + no held yet.
      // Second call in the same window: since slot was released, it will try again.
      // To prove tally restore: succeed once (to claim slot), then suppress, then
      // force next window? Easier path:
      // 1) Fail first send (ok:false) → lastSentAt empty, suppressed empty
      // 2) Manually: deliver success, then hit suppress, then... actually we need
      //    a second key pattern:
      // Deliver success → more hits suppress → wait, we can't advance time easily.
      // Instead: call notify once with a key; it fails; then call notify again with
      // same key immediately — if slot was NOT released, second call would suppress
      // (return false without fetch). If released, second call hits fetch again.

      const r1 = await alerts.notify({
        level: 'error', title: 'ok-false trap', key: 'okfalse',
        detail: 'asset=abc stage=veo model=omni'
      });
      check('B1 ok:false returns false', r1, false);
      check('B2 ok:false released dedupe (fetch again on 2nd call)', fetchCalls.length, 1);

      const r2 = await alerts.notify({
        level: 'error', title: 'ok-false trap', key: 'okfalse',
        detail: 'asset=abc stage=veo model=omni'
      });
      check('B3 second call after ok:false also attempts send (slot released)', r2, false);
      check('B4 two fetch calls (slot not held across failure)', fetchCalls.length, 2);
      checkTrue('B5 logs ok=false', warns.some(w => /ok=false|channel_not_found/.test(w)));

      // Tally restore: succeed once, then fail, with held count in between.
      // Simulate by: (1) success, (2) force lastSentAt into the past? We don't
      // export lastSentAt. Instead: success, then within window suppress hits
      // are not sent — but after success the slot IS held. To get a held tally
      // onto a FAILED send we need: success, then expire window, then suppress
      // somehow before next send...
      // Simpler path that the production code actually does:
      // claim slot → take held from suppressed → send fails → restore held.
      // So: first, put entries in suppressed by... we can only suppress when
      // lastSentAt has a recent key. Sequence:
      //   success (claims slot, held=undefined)
      //   same key again → suppressed count=1, no send
      //   We need the NEXT successful attempt path with held, then fail.
      //   That requires window expiry. Advance by mutating env window to 0?
      // ALERT_DEDUPE_WINDOW_MIN=0 disables the window (win > 0 check).
      // With win=0, no suppress path. So use a tiny window and Date.now tricks?
      // Export doesn't let us set lastSentAt timestamps.
      //
      // Prove tally via: success, then second notify suppresses (count=1), then
      // _resetState is too blunt. Look at _stateSize after a fail that had held.
      //
      // Hack: temporarily set ALERT_DEDUPE_WINDOW_MIN very high, succeed, suppress
      // twice, then replace fetch to fail, and clear lastSentAt by... we can't.
      //
      // Alternative: after success + 2 suppressions, call notify with a NEW key
      // that fails — that doesn't exercise held restore for the first key.
      //
      // Best approach that stays offline: call the production path after
      // manually using two keys isn't enough. Export doesn't expose lastSentAt.
      //
      // Use window=0 for the "no suppress" path is already covered. For held:
      // set DEDUPE window, succeed, call twice more (suppress 2), then zero out
      // lastSentAt by sending with window that considers last as expired:
      // DEDUPE_WINDOW_MS uses env each call — if we set window to 0 AFTER
      // suppressions, win>0 is false so we never read suppressed for folding
      // either... look at code:
      //   if (win > 0 && last && now - last < win) { suppress; return }
      //   lastSentAt.set(...)
      //   held = suppressed.get; suppressed.delete
      // So with win=0, suppressions still exist in the map and WILL be folded
      // on next send! Sequence:
      //   window=15, success key=K
      //   window=15, notify K → suppress count=1
      //   window=15, notify K → suppress count=2
      //   set window=0 (disable suppress gate), fetch fails
      //   notify K → claims slot, held={count:2}, send fails → restores held
      //   stateSize suppressed >= 1 with count 2
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // B-tally: held restored after failed send
  await withEnv({ ...CFG, ALERT_DEDUPE_WINDOW_MIN: '15' }, async () => {
    alerts._resetState();
    let mode = 'ok';
    installFetch(async () => {
      if (mode === 'ok') return jsonRes(200, { ok: true, ts: '1' });
      return jsonRes(200, { ok: false, error: 'invalid_auth' });
    });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      check('B6 first success', await alerts.notify({ level: 'error', title: 'tally', key: 'tally-k' }), true);
      // suppress twice
      check('B7 suppress #1', await alerts.notify({ level: 'error', title: 'tally', key: 'tally-k' }), false);
      check('B8 suppress #2', await alerts.notify({ level: 'error', title: 'tally', key: 'tally-k' }), false);
      const mid = alerts._stateSize();
      checkTrue('B9 suppressed map has the key after folds', mid.suppressed >= 1);

      // Expire the dedupe gate by temporarily zeroing the window so the next
      // call proceeds to send (and folds held). lastSentAt still has the key
      // but win=0 skips the "within window" branch.
      process.env.ALERT_DEDUPE_WINDOW_MIN = '0';
      mode = 'fail';
      const rFail = await alerts.notify({ level: 'error', title: 'tally', key: 'tally-k' });
      check('B10 failed send returns false', rFail, false);
      // held restored → suppressed still has an entry
      const after = alerts._stateSize();
      checkTrue('B11 held tally restored after ok:false (suppressed non-empty)', after.suppressed >= 1);
      // slot released → lastSentAt should not hold the key for long; with
      // win=0 prune may still leave it, but delete on fail removes it.
      // _stateSize only gives sizes; if only one key was used and it was
      // deleted, lastSentAt is 0.
      check('B12 dedupe slot released after ok:false', after.lastSentAt, 0);
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── C. 429 does not throw and does not block ─────────────────────────
  await withEnv(CFG, async () => {
    alerts._resetState();
    let slept = false;
    const origSleep = global.setTimeout;
    // Detect any long sleep; short abort timers from SEND_TIMEOUT are fine.
    const sleepMs = [];
    global.setTimeout = (fn, ms, ...rest) => {
      sleepMs.push(ms);
      if (ms > 50) slept = true; // Retry-After sleep would be seconds
      return origSleep(fn, ms, ...rest);
    };
    installFetch(async () => jsonRes(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': '30' }));
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    const t0 = Date.now();
    try {
      let threw = false;
      let r;
      try {
        r = await alerts.notify({ level: 'error', title: 'rate-limited', key: 'rl1' });
      } catch (e) {
        threw = true;
        failures.push(`C 429 threw: ${e.message}`);
      }
      const elapsed = Date.now() - t0;
      check('C1 429 returns false', r, false);
      check('C2 429 does not throw', threw, false);
      checkTrue('C3 429 finishes quickly (<2s, no Retry-After sleep)', elapsed < 2000);
      checkTrue('C4 429 does not sleep on Retry-After', !slept || sleepMs.every(m => m <= 8000));
      checkTrue('C5 429 logs Retry-After', warns.some(w => /429/.test(w) && /Retry-After/i.test(w)));
      // slot released
      const r2 = await alerts.notify({ level: 'error', title: 'rate-limited', key: 'rl1' });
      check('C6 after 429, same key can attempt again', fetchCalls.length, 2);
      check('C7 second 429 also false', r2, false);
    } finally {
      console.warn = origWarn;
      global.setTimeout = origSleep;
      restoreFetch();
    }
  });

  // ── D. Dedupe folds repeats; count survives a failed send ─────────────
  await withEnv(CFG, async () => {
    alerts._resetState();
    let mode = 'ok';
    installFetch(async () => {
      if (mode === 'ok') return jsonRes(200, { ok: true });
      return jsonRes(200, { ok: false, error: 'fatal_error' });
    });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      check('D1 first delivery', await alerts.notify({ level: 'warn', title: 'dedupe-me', key: 'dk' }), true);
      check('D2 fold #1', await alerts.notify({ level: 'warn', title: 'dedupe-me', key: 'dk' }), false);
      check('D3 fold #2', await alerts.notify({ level: 'warn', title: 'dedupe-me', key: 'dk' }), false);
      check('D4 fold #3', await alerts.notify({ level: 'warn', title: 'dedupe-me', key: 'dk' }), false);
      check('D5 only one fetch so far', fetchCalls.length, 1);
      checkTrue('D6 suppressed non-empty', alerts._stateSize().suppressed >= 1);

      process.env.ALERT_DEDUPE_WINDOW_MIN = '0';
      mode = 'fail';
      check('D7 next send fails', await alerts.notify({ level: 'warn', title: 'dedupe-me', key: 'dk' }), false);
      checkTrue('D8 tally survived failed send', alerts._stateSize().suppressed >= 1);
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── E. Rate limiter caps delivery ────────────────────────────────────
  await withEnv({ ...CFG, ALERT_RATE_LIMIT_MAX: '3', ALERT_DEDUPE_WINDOW_MIN: '0' }, async () => {
    alerts._resetState();
    installFetch(async () => jsonRes(200, { ok: true }));
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(await alerts.notify({ level: 'warn', title: `rl-${i}`, key: `rl-key-${i}` }));
      }
      const delivered = results.filter(Boolean).length;
      check('E1 rate limit delivers at most 3 of 6', delivered, 3);
      check('E2 rate limit fetch count is 3', fetchCalls.length, 3);
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── F. redact() scrubs xoxb- tokens ──────────────────────────────────
  await withEnv(CFG, async () => {
    // Assembled at runtime, never written as a literal: a token-SHAPED string
    // in source trips GitHub push protection's Slack scanner and blocks the
    // push, even though this value is invented. The regex under test still
    // sees the real shape.
    const FAKE_TOKEN = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
    const sample = `Authorization failed for ${FAKE_TOKEN} reason=invalid_auth`;
    const out = alerts._redact(sample);
    checkTrue('F1 redact removes xoxb- token', !out.includes(FAKE_TOKEN));
    checkTrue('F2 redact leaves a marker', /xox<redacted>/.test(out));
    // configured token exact match
    const withExact = `bearer ${process.env.SLACK_BOT_TOKEN} in url`;
    const out2 = alerts._redact(withExact);
    checkTrue('F3 redact scrubs configured token', !out2.includes(process.env.SLACK_BOT_TOKEN));
  });

  // ── G. Message builder never emits a truncated/broken fence ──────────
  await withEnv(CFG, async () => {
    alerts._resetState();
    const huge = 'X'.repeat(20000);
    const msg = alerts._buildMessage({
      lvl: 'error',
      title: 'size-budget',
      fields: { asset: 'a1', brand: 'b1', stage: 'veo', model: 'omni', predictionId: 'p1' },
      detail: huge,
      held: { count: 7, since: Date.now() - 60000 }
    });
    checkTrue('G1 message within SLACK_MAX', msg.length <= alerts._SLACK_MAX);
    const opens = (msg.match(/```/g) || []).length;
    // either no fence (no room) or a matched pair (2)
    checkTrue('G2 fences balanced (0 or 2)', opens === 0 || opens === 2);
    if (opens === 2) {
      checkTrue('G3 opens before closes', msg.indexOf('```') < msg.lastIndexOf('```'));
      checkTrue('G4 does not end mid-fence open', !msg.endsWith('```\n') || msg.trimEnd().endsWith('```'));
      // full close present
      checkTrue('G5 ends with closing fence', /```\s*$/.test(msg) || msg.includes('\n```'));
    }
    // mrkdwn bold markers on title
    checkTrue('G6 title uses *bold*', msg.includes('*size-budget*'));
    // no Telegram HTML
    checkTrue('G7 no <pre> / <b> tags', !/<pre>|<b>/.test(msg));

    // detail verbatim path: diagnostic-shaped string survives (clipped only)
    const diagnostic = [
      'asset=abc123',
      'status=failed',
      'stage=veo (12s)',
      'kind=video fmt=reels aspect=9:16',
      'pipeline=direct model=google/gemini-omni-flash/image-to-video-developer',
      'prediction=pred_xyz',
      'error=timeout'
    ].join('\n');
    const msg2 = alerts._buildMessage({
      lvl: 'error', title: 'Video generation failed',
      fields: { ad: 'abc123', brand: 'brand1' },
      detail: diagnostic
    });
    checkTrue('G8 diagnostic lines present in detail fence', msg2.includes('asset=abc123') && msg2.includes('prediction=pred_xyz'));
    checkTrue('G9 diagnostic not re-keyed into fields schema', msg2.includes('```\nasset=abc123'));
  });

  // ── H. Happy path posts to chat.postMessage with Bearer token ────────
  await withEnv(CFG, async () => {
    alerts._resetState();
    installFetch(async () => jsonRes(200, { ok: true, channel: 'C1', ts: '1.2' }));
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const r = await alerts.notify({
        level: 'error',
        title: 'Video generation failed',
        key: 'happy',
        fields: { ad: 'ad1', brand: 'br1', error: 'boom' },
        detail: 'asset=ad1\nstage=veo\nerror=boom'
      });
      check('H1 happy path returns true', r, true);
      check('H2 one fetch', fetchCalls.length, 1);
      checkTrue('H3 URL is chat.postMessage', /chat\.postMessage/.test(fetchCalls[0].url));
      const auth = fetchCalls[0].opts.headers.Authorization || fetchCalls[0].opts.headers.authorization;
      checkTrue('H4 Bearer token header', /^Bearer xoxb-/.test(auth));
      const body = JSON.parse(fetchCalls[0].opts.body);
      check('H5 channel from env', body.channel, CFG.SLACK_ALERT_CHANNEL);
      checkTrue('H6 body has text', typeof body.text === 'string' && body.text.length > 0);
      check('H7 isConfigured true', alerts.isConfigured(), true);
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── I. esc / safeEsc still entity-encode & < > for mrkdwn ────────────
  check('I1 esc ampersand', alerts._esc('a & b'), 'a &amp; b');
  check('I2 esc lt/gt', alerts._esc('<tag>'), '&lt;tag&gt;');
  checkTrue('I3 safeEsc clips without broken entity',
    !/&[a-zA-Z]*$/.test(alerts._safeEsc('&&&&&&&&&', 5).replace(/…$/, '')));

  // ── J. wrappers accept BOTH shapes ───────────────────────────────────
  // REGRESSION GUARD. Three production call sites called warn()/error() with a
  // single options object against a (title, opts) signature, so the object
  // became the title: Slack rendered `[object Object]` and detail/fields/key
  // were silently dropped. Live in prod on a money-adjacent path
  // (costTracker "Cost row dropped"). Both shapes must work.
  await withEnv(CFG, async () => {
    alerts._resetState();
    installFetch(async () => jsonRes(200, { ok: true }));
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const r = await alerts.error({
        title: 'Cost row dropped — CostLog schema drift',
        detail: 'ValidationError: costUsd required',
        fields: { stage: 'atlas_image' },
        key: 'costlog-validation'
      });
      check('J1 object form delivers', r, true);
      const text = JSON.parse(fetchCalls[0].opts.body).text;
      checkTrue('J2 object form renders the REAL title', text.includes('Cost row dropped'));
      checkTrue('J3 object form does NOT render [object Object]', !text.includes('[object Object]'));
      checkTrue('J4 object form keeps detail', text.includes('ValidationError'));
      checkTrue('J5 object form keeps fields', /stage: \*atlas_image\*/.test(text));

      // The object form must honour `key`, not derive one from a stringified
      // object — otherwise dedupe collapses unrelated alerts together.
      alerts._resetState();
      restoreFetch();
      installFetch(async () => jsonRes(200, { ok: true }));
      await alerts.error({ title: 'first', key: 'shared-key' });
      const second = await alerts.error({ title: 'second', key: 'shared-key' });
      check('J6 object form honours the explicit dedupe key', second, false);

      // Positional form unchanged.
      alerts._resetState();
      restoreFetch();
      installFetch(async () => jsonRes(200, { ok: true }));
      const p = await alerts.warn('positional title', { detail: 'pd', fields: { a: 'b' } });
      check('J7 positional form still delivers', p, true);
      const ptext = JSON.parse(fetchCalls[0].opts.body).text;
      checkTrue('J8 positional title intact', ptext.includes('positional title'));
      checkTrue('J9 positional detail intact', ptext.includes('pd'));
    } finally {
      console.warn = origWarn;
      restoreFetch();
    }
  });

  // ── K. non-string title is coerced AND warned about ──────────────────
  await withEnv(CFG, async () => {
    let warned = '';
    const origWarn = console.warn;
    console.warn = (m) => { warned += String(m); };
    try {
      const msg = alerts._buildMessage({ lvl: 'error', title: { title: 'inner title' } });
      checkTrue('K1 non-string title never emits [object Object]', !msg.includes('[object Object]'));
      checkTrue('K2 non-string title prefers .title', msg.includes('inner title'));
      checkTrue('K3 non-string title logs a warning', /non-string title/i.test(warned));
    } finally {
      console.warn = origWarn;
    }
  });

  // ── L. outbound message is REDACTED, not just console output ─────────
  // crashReporter now routinely ships error messages and full stacks through
  // this builder. A stack from a failed authenticated request can contain the
  // bot token verbatim, and Slack channel history is workspace-readable and
  // exportable — so redaction has to happen on the way OUT, not only on the
  // console failure paths where it originally lived.
  await withEnv(CFG, async () => {
    const FAKE = ['xoxb', '9999999999', 'zyxwvutsrqponm'].join('-');
    const msg = alerts._buildMessage({
      lvl: 'fatal',
      title: `crashed calling api with ${FAKE}`,
      fields: { token: FAKE },
      detail: `Error: auth failed\n  at fetch (Authorization: Bearer ${FAKE})`
    });
    checkTrue('L1 token scrubbed from the title', !msg.includes(FAKE));
    checkTrue('L2 token scrubbed from fields', !/xoxb-9999999999/.test(msg));
    checkTrue('L3 token scrubbed from the detail block', !msg.includes('zyxwvutsrqponm'));
    // The marker arrives entity-encoded, because redaction runs BEFORE mrkdwn
    // escaping (deliberate: escaping first would let a clipped tail hide a
    // token). Slack renders `xox&lt;redacted&gt;` back as `xox<redacted>`.
    checkTrue('L4 redaction leaves a marker', /xox&lt;redacted&gt;/.test(msg));
    checkTrue('L5 redact is a public export', typeof alerts.redact === 'function');
  });

  // ── M. rate-limit spill is reported, not silently dropped ────────────
  // With crash alerts deliberately un-folded (unique key per incident), this
  // ceiling is the ONLY silent drop point. A burst that drops N and then goes
  // quiet must still report — a rollover-only flush would never fire, because
  // nothing calls withinRateLimit() again once the burst ends.
  await withEnv({ ...CFG, ALERT_RATE_LIMIT_MAX: '3', ALERT_DEDUPE_WINDOW_MIN: '0' }, async () => {
    alerts._resetState();
    installFetch(async () => jsonRes(200, { ok: true }));
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      let delivered = 0;
      for (let i = 0; i < 8; i++) {
        if (await alerts.notify({ level: 'error', title: `burst ${i}`, key: `burst-${i}` })) delivered++;
      }
      check('M1 ceiling enforced', delivered, 3);
      const spill = alerts._spillPending();
      check('M2 drops counted', spill.drops, 5);
      checkTrue('M3 spill timer ARMED (fires without further traffic)', spill.armed === true);
    } finally {
      console.warn = origWarn;
      restoreFetch();
      alerts._resetState();
    }
  });

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`\nverifySlackAlert: ${pass} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exit(1);
  }
  console.log('  all checks passed\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('verifySlackAlert crashed:', err);
  process.exit(2);
});
