#!/usr/bin/env node
//
// postStatus.js — post an engineering/orchestration status update to the
// #rs-status Slack channel, from the command line, with no service or
// deploy involved.
//
// WHY THIS EXISTS: #rs-status already carries a live per-run feed for
// AD-GENERATION runs (services/runFeedService.js — one parent message per
// CampaignRun, threaded event log). That feed says nothing about the
// ENGINEERING work happening around those runs — a bug found, a fix
// shipped, a PR merged, trunk gone red, a test suite failing. Today that
// only exists inside agent conversations. This script is the missing half:
// a boring, ad-hoc way for an orchestrating agent (or a human) to post that
// kind of update from a shell, reusing the exact same Slack app/token
// runFeedService and alertService already use.
//
// ── WHO THIS IS FOR (read before writing a message) ───────────────────────
// The owner reads this channel INSTEAD of watching sessions or logs. Every
// message must be followable by someone who has never opened this codebase.
//   GOOD:  --headline "Ad quotes were getting cut off mid-sentence — fixed"
//   BAD:   --headline "Fixed truncation in slotContent.js"
//   GOOD:  --headline "Found a bug where a Slack outage could go unnoticed for days — fixing it now" --status working
//   BAD:   --headline "Investigating runFeedService silent-failure mode" --status working
// Say what changed for a HUMAN, not which file or function moved. If you
// must name a mechanism, put the plain-English consequence first.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//   node scripts/postStatus.js --headline "<short line>" [--detail "<more>"]
//       [--status working|done|broken] [--thread-key <id>] [--channel <id>]
//       [--new-thread] [--dry-run]
//
//   node scripts/postStatus.js --list-threads
//   node scripts/postStatus.js --help
//
// Examples:
//   # Kick off a long piece of work — this becomes the THREAD PARENT.
//   node scripts/postStatus.js --thread-key pr-330-slack-status \
//     --status working \
//     --headline "Building a way to post plain-English progress updates here"
//
//   # Update on the same piece of work — posts INTO that thread, no new parent.
//   node scripts/postStatus.js --thread-key pr-330-slack-status \
//     --status done \
//     --headline "Done — this message is the proof it works" \
//     --detail "Every future update from an agent can now show up here as it happens, not just when someone asks."
//
//   # One-off ping, no thread bookkeeping.
//   node scripts/postStatus.js --status broken \
//     --headline "The nightly catalog sync did not run last night" \
//     --detail "Nobody broke anything on purpose — the schedule looks wrong. Looking into it now."
//
// ── THREADING ────────────────────────────────────────────────────────────
// --thread-key <id> is any short string an agent chooses to name one
// continuous piece of work (a PR, an incident, a session). The FIRST post
// under a given key creates a parent message and remembers its Slack
// timestamp locally, keyed by that string. Every later post with the SAME
// --thread-key replies into that same thread instead of starting a new
// parent, so a long session reads as one message with a growing thread
// under it, not a flood of one-line posts in the main channel.
//
// State lives in a single local JSON file (see STATE_FILE below), never
// committed. If that file is lost or you are on a different machine/
// worktree, the next post under a previously-used --thread-key simply
// starts a NEW parent message — thread continuity breaks, but nothing
// errors and nothing is lost; it just looks like a fresh thread instead of
// a continued one. Use --new-thread to force a fresh parent on purpose
// (e.g. starting a new session under the same key name).
//
// ── FAILURE CONTRACT — the opposite of runFeedService on purpose ─────────
// runFeedService is fire-and-forget by design (it must never block a
// render). This script is the OPPOSITE: it is a CLI, nothing else is
// waiting on it, and a swallowed failure here is exactly the bug that left
// #rs-status silently dead for two days. So: any failure prints the real
// Slack error (never the token) to stderr and exits NON-ZERO. There is no
// silent-degrade mode.
//
// ── AUTH ───────────────────────────────────────────────────────────────────
// Reuses the same secret and channel every other Slack path in this repo
// uses — no second mechanism:
//   SLACK_BOT_TOKEN            (Render env / local .env — never printed)
//   SLACK_ALERT_CHANNEL_STATUS (committed default in config/defaults.env,
//                               currently C0BMMD5AN84 = #rs-status)
// --channel overrides the destination for a one-off post without touching
// either.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same two-step load order index.js/worker.js use: real env first (so a
// Render/local override always wins), repo-committed non-secret defaults
// second. dotenv never overrides an already-set var.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'defaults.env'), quiet: true });

const STATE_FILE = path.join(__dirname, '..', '.rs-status-threads.json');

const SLACK_MAX = 3900; // headroom under Slack's ~4000 text limit, same margin runFeedService uses

const STATUS_MAP = {
  working:  { emoji: '🛠️', color: '#ECB22E', label: 'WORKING' },
  progress: { emoji: '🛠️', color: '#ECB22E', label: 'WORKING' },
  wip:      { emoji: '🛠️', color: '#ECB22E', label: 'WORKING' },
  done:     { emoji: '✅', color: '#2EB67D', label: 'DONE' },
  success:  { emoji: '✅', color: '#2EB67D', label: 'DONE' },
  fixed:    { emoji: '✅', color: '#2EB67D', label: 'DONE' },
  broken:   { emoji: '🔴', color: '#E01E5A', label: 'BROKEN' },
  failed:   { emoji: '🔴', color: '#E01E5A', label: 'BROKEN' },
  error:    { emoji: '🔴', color: '#E01E5A', label: 'BROKEN' },
  down:     { emoji: '🔴', color: '#E01E5A', label: 'BROKEN' }
};

function printHelp() {
  console.log(`Usage:
  node scripts/postStatus.js --headline "<short line>" [options]
  node scripts/postStatus.js --list-threads
  node scripts/postStatus.js --help

Options:
  --headline <text>     Required (unless --list-threads/--help). One line,
                         plain English, no code/file names if avoidable.
  --detail <text>        Optional. A sentence or two of extra context.
  --status <level>       working | done | broken (default: working).
                         Synonyms accepted: progress/wip, success/fixed, failed/error/down.
  --thread-key <id>      Group this post with earlier posts under the same
                         id into one Slack thread. Omit for a standalone ping.
  --new-thread           With --thread-key: force a fresh parent message
                         even if this key already has one stored.
  --channel <id>         Override the destination channel (default:
                         SLACK_ALERT_CHANNEL_STATUS from the environment).
  --dry-run              Build and print the message, but do not call Slack
                         and do not touch stored thread state.
  --list-threads         Print the locally stored thread-key -> Slack
                         message mapping and exit.
  --help, -h             This message.

Examples:
  node scripts/postStatus.js --status working --thread-key pr-330 \\
    --headline "Building a way to post plain-English progress updates here"

  node scripts/postStatus.js --status done --thread-key pr-330 \\
    --headline "Done — this message is the proof it works"

Write for the owner, not for another engineer:
  GOOD: "Ad quotes were getting cut off mid-sentence — fixed"
  BAD:  "Fixed truncation in slotContent.js"
`);
}

function parseArgs(argv) {
  const out = {
    headline: null,
    detail: null,
    status: 'working',
    threadKey: null,
    channel: null,
    newThread: false,
    dryRun: false,
    listThreads: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq > -1 ? arg.slice(0, eq) : arg;
    const inlineVal = eq > -1 ? arg.slice(eq + 1) : null;
    const next = () => (inlineVal !== null ? inlineVal : argv[++i]);
    switch (flag) {
      case '--headline': out.headline = next(); break;
      case '--detail': out.detail = next(); break;
      case '--status': out.status = String(next() || '').toLowerCase(); break;
      case '--thread-key': out.threadKey = next(); break;
      case '--channel': out.channel = next(); break;
      case '--new-thread': out.newThread = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--list-threads': out.listThreads = true; break;
      case '--help':
      case '-h': out.help = true; break;
      default:
        console.error(`postStatus: unrecognized argument "${arg}" (see --help)`);
        process.exit(2);
    }
  }
  return out;
}

// ── local thread-state store ──────────────────────────────────────────────
// { "<thread-key>": { ts, channel, headline, createdAt, lastPostAt } }
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`postStatus: could not read ${STATE_FILE} (${err.message}) — starting fresh`);
    }
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (err) {
    // Not fatal to the post that already succeeded — but the caller needs to
    // know threading may not continue next time.
    console.warn(`postStatus: could not persist thread state to ${STATE_FILE} (${err.message})`);
  }
}

// ── formatting (mirrors runFeedService/alertService conventions) ─────────
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function clip(s, max) {
  const str = String(s ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

function resolveStatus(raw) {
  const key = String(raw || 'working').toLowerCase();
  return STATUS_MAP[key] || STATUS_MAP.working;
}

function buildMessage({ headline, detail, status, isThreadReply }) {
  const s = resolveStatus(status);
  const fallbackText = clip(`${s.emoji} ${headline}`, 150);
  const bodyLines = [`${s.emoji} *${esc(headline)}*`];
  if (detail) bodyLines.push(esc(detail));
  bodyLines.push(`\`${s.label} · ${new Date().toISOString()} · via postStatus.js on ${os.hostname()}\``);
  const bodyText = clip(bodyLines.join('\n'), SLACK_MAX);
  return {
    fallbackText,
    attachment: {
      color: s.color,
      mrkdwn_in: ['text'],
      text: bodyText
    },
    isThreadReply
  };
}

// ── Slack transport ────────────────────────────────────────────────────────
const SEND_TIMEOUT_MS = 8000;

async function slackApi(token, method, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { httpStatus: res.status, httpOk: res.ok, json };
  } catch (err) {
    const why = err && err.name === 'AbortError' ? `timeout after ${SEND_TIMEOUT_MS}ms` : (err && err.message) || String(err);
    return { httpStatus: null, httpOk: false, json: null, transportError: why };
  } finally {
    clearTimeout(timer);
  }
}

function diagnoseSlackError(errorCode) {
  if (errorCode === 'not_in_channel' || errorCode === 'channel_not_found') {
    return 'NEEDS A HUMAN: the Slack bot is not a member of this channel (or the channel id is wrong). ' +
      'Someone with access to the #rs-status Slack channel must invite the bot (in Slack: ' +
      '/invite @<bot name> in that channel). This cannot be fixed from code.';
  }
  if (errorCode === 'invalid_auth' || errorCode === 'token_revoked' || errorCode === 'account_inactive') {
    return 'NEEDS A HUMAN: SLACK_BOT_TOKEN is invalid or revoked. Someone must reissue/reinstall the ' +
      'Slack app token and update SLACK_BOT_TOKEN in the Render dashboard (and local .env if used). ' +
      'This cannot be fixed from code.';
  }
  if (errorCode === 'missing_scope') {
    return 'NEEDS A HUMAN: the Slack app token is missing an OAuth scope (likely chat:write). ' +
      'Someone must add the scope in the Slack app config and reinstall it to the workspace.';
  }
  return null;
}

async function postMessage({ token, channel, attachment, fallbackText, threadTs }) {
  const body = {
    channel,
    text: fallbackText,
    attachments: [attachment]
  };
  if (threadTs) body.thread_ts = threadTs;

  const result = await slackApi(token, 'chat.postMessage', body);

  if (result.transportError) {
    return { ok: false, error: `network error talking to Slack: ${result.transportError}` };
  }
  if (result.httpStatus === 429) {
    const retryAfter = 'unknown';
    return { ok: false, error: `Slack rate-limited this request (HTTP 429, retry-after ${retryAfter})` };
  }
  if (!result.httpOk) {
    return { ok: false, error: `Slack HTTP ${result.httpStatus}: ${JSON.stringify(result.json)}` };
  }
  if (!result.json || result.json.ok !== true) {
    const errorCode = result.json && result.json.error ? String(result.json.error) : 'unknown (no ok field in response)';
    const diagnosis = diagnoseSlackError(errorCode);
    return { ok: false, error: `Slack rejected the post: "${errorCode}"${diagnosis ? `\n${diagnosis}` : ''}` };
  }
  return { ok: true, ts: result.json.ts, channel: result.json.channel || channel };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printHelp(); process.exit(0); }

  if (args.listThreads) {
    const state = loadState();
    const keys = Object.keys(state);
    if (!keys.length) {
      console.log(`No stored threads yet (${STATE_FILE} does not exist or is empty).`);
      process.exit(0);
    }
    console.log(`Stored threads (${STATE_FILE}):\n`);
    for (const k of keys) {
      const e = state[k];
      console.log(`  ${k}`);
      console.log(`    channel: ${e.channel}   ts: ${e.ts}`);
      console.log(`    last headline: ${e.headline || '(none recorded)'}`);
      console.log(`    created: ${e.createdAt || '?'}   last post: ${e.lastPostAt || '?'}\n`);
    }
    process.exit(0);
  }

  if (!args.headline) {
    console.error('postStatus: --headline is required (see --help)');
    process.exit(2);
  }
  if (!STATUS_MAP[args.status]) {
    console.error(`postStatus: --status "${args.status}" not recognized. Use working, done, or broken.`);
    process.exit(2);
  }

  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  const channel = (args.channel || process.env.SLACK_ALERT_CHANNEL_STATUS || '').trim();

  console.log(`postStatus: SLACK_BOT_TOKEN is ${token ? 'SET' : 'MISSING'}`);
  console.log(`postStatus: target channel is ${channel || 'MISSING'}`);

  if (!token) {
    console.error('postStatus: SLACK_BOT_TOKEN is not set in the environment. Cannot post. ' +
      'This needs a human to set it (Render dashboard secret, or local .env) — see CLAUDE.md §4a.');
    process.exit(1);
  }
  if (!channel) {
    console.error('postStatus: no destination channel resolved (SLACK_ALERT_CHANNEL_STATUS is unset ' +
      'and --channel was not passed). Cannot post.');
    process.exit(1);
  }

  const state = loadState();
  const existing = args.threadKey && !args.newThread ? state[args.threadKey] : null;
  const threadTs = existing && existing.channel === channel ? existing.ts : null;

  const msg = buildMessage({
    headline: args.headline,
    detail: args.detail,
    status: args.status,
    isThreadReply: Boolean(threadTs)
  });

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was sent. This is what would have posted:\n');
    console.log(`channel: ${channel}`);
    console.log(`thread_ts: ${threadTs || '(new parent message)'}`);
    console.log(`fallback text: ${msg.fallbackText}`);
    console.log(`attachment color: ${msg.attachment.color}`);
    console.log(`body:\n${msg.attachment.text}\n`);
    process.exit(0);
  }

  const result = await postMessage({
    token,
    channel,
    attachment: msg.attachment,
    fallbackText: msg.fallbackText,
    threadTs
  });

  if (!result.ok) {
    console.error(`postStatus: FAILED to post to Slack.\n${result.error}`);
    process.exit(1);
  }

  console.log(`postStatus: posted OK — channel=${result.channel} ts=${result.ts}${threadTs ? ' (thread reply)' : ' (new parent)'}`);

  if (args.threadKey) {
    const now = new Date().toISOString();
    state[args.threadKey] = {
      ts: threadTs || result.ts,
      channel: result.channel,
      headline: args.headline,
      createdAt: (existing && existing.createdAt) || now,
      lastPostAt: now
    };
    saveState(state);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`postStatus: unexpected error — ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
