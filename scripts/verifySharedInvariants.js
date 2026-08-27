#!/usr/bin/env node
'use strict';
//
// verifySharedInvariants — the check that catches the drift a HASH CANNOT SEE.
//
// ── WHY THIS EXISTS ALONGSIDE verifyVendorDrift.js ─────────────────────
// verifyVendorDrift.js answers exactly one question, well: "has anyone
// LOOKED at this vendored file since backend moved on it?" It is a content
// hash of the backend blob against a recorded look. That question is
// structurally blind to two real things:
//
//   1. A FIX LANDS IN ONE REPO. Backend's hash never moved, so drift never
//      fires. The manifest records a fork/unported reason and the porting
//      obligation goes quiet. This is how veoPromptBuilder.js's
//      catalog-title fix sat in adgen only.
//
//   2. THE SAME BUG IN N BYTE-IDENTICAL COPIES. There is no drift at all.
//      Both sides agree, and both are wrong. Byte-equality actively
//      CERTIFIES the bug as fine — veoStoryboardService.js is marked
//      'synced' in the manifest and always will be, correctly, while
//      carrying the identical construct that cost a $0.90 master.
//
// Those are semantic questions, so they need a semantic check. This harness
// reads scripts/shared-invariants.json — named invariants, each a pattern
// that must not appear in a named set of files — and enforces them across
// BOTH repos. That makes a fix provably a fix everywhere, instead of a fix
// in whichever copy someone happened to have open.
//
// ── ANTI-ROT CONTRACT (copied deliberately from expected-failures.json) ─
// `acknowledged` in the JSON is not a mute button:
//   * an UNACKNOWLEDGED match FAILS — that is a new instance of a known bug;
//   * an ACKNOWLEDGED entry whose match is GONE also FAILS, as STALE — the
//     fix landed and the entry must be deleted in the same commit.
// Both directions are required. Only the first would let the list rot into
// a rug; only the second would be useless.
//
// ── WHY PATTERNS AND NOT AN AST ────────────────────────────────────────
// Each invariant's pattern is deliberately a narrow STRUCTURAL regex over
// raw source, not a comment-stripped scan and not an AST query.
//   * Comment stripping: a hand-rolled JS comment stripper has to
//     disambiguate a regex literal from division to know whether a `/` opens
//     a comment. Getting that wrong corrupts the rest of the file silently.
//     That is a worse bug than the one being checked for, and this repo has
//     already been bitten by exactly that class of hand-rolled lexer.
//   * An AST: no parser dependency exists in this repo and adding one for a
//     handful of invariants is not proportionate.
// The chosen escape is to make the pattern require live-code STRUCTURE that
// prose cannot accidentally contain — for the catalog-title invariant, a
// template-literal interpolation (`Product:` followed by `${`). The comments
// that document the fix say `Product: Vaportek.` and `Product: {title}`, and
// neither has `${`, so neither matches. Section PROBE below proves that
// discrimination on fixtures rather than asserting it.
//
// ── BACKEND ABSENT ─────────────────────────────────────────────────────
// Sibling location comes from scripts/lib/siblingBackend.js
// (ADGEN_BACKEND_PATH, else ../liquidretail_backend), same as every other
// cross-repo harness here. Absent → backend-scoped scanning is SKIPPED with
// an INFO and backend-scoped acknowledgements are NOT evaluated for
// staleness (a narrow clone genuinely cannot see them; that is different
// from a bug). Adgen-scoped invariants still run with full teeth, so this
// harness is never a total no-op in a CI that only checks out this repo.
//
// Fully offline: fs + regex. No DB, no network, no git, no new dependency.
//
// USAGE
//   node scripts/verifySharedInvariants.js
//   node scripts/verifySharedInvariants.js --list     print resolved scan targets
//   node scripts/verifySharedInvariants.js --no-prove skip the fixture probes
//
const fs = require('fs');
const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const { resolveBackendRef, readBackendBlob } = require('./lib/vendorDrift');

const ROOT = path.join(__dirname, '..');
const INVARIANTS_PATH = path.join(__dirname, 'shared-invariants.json');
const BACKEND_ROOT = resolveBackendRoot(ROOT);
const INVARIANTS_VERSION = 1;

// ⚠️ The BACKEND side is read from a REMOTE-TRACKING REF, not from the
// sibling working tree — `git show origin/main:<path>`, via vendorDrift's
// readBackendBlob (override with ADGEN_BACKEND_REF).
//
// This is not incidental. The sibling resolved by siblingBackend.js is a
// SHARED long-lived checkout that other sessions have live edits in, and
// which is routinely parked behind origin/main. Reading its working tree
// would let a stale or dirty checkout answer "has this been ported yet?" —
// and the answer would be confidently wrong in whichever direction that
// checkout happened to be sitting. verifyVendorDrift.js already made
// exactly this decision for exactly this reason; this harness must not
// quietly disagree with it, or the two would report different truths about
// the same file. The ADGEN side is read from the working tree, because
// that is the change under review.
const BACKEND_REF = BACKEND_ROOT ? resolveBackendRef(BACKEND_ROOT) : null;

// Where a repo-relative contract path lives in each tree. adgen prefixes
// everything with src/; backend has services/ and models/ at its root.
// This is the same pairing scripts/lib/vendorDrift.js discoverVendored()
// uses, stated once here rather than inferred.
const REPO_LAYOUT = {
  adgen: { root: ROOT, prefix: 'src' },
  backend: { root: BACKEND_ROOT, prefix: '' },
};

function parseArgs(argv) {
  const opts = { list: false, prove: true };
  for (const arg of argv) {
    if (arg === '--list') opts.list = true;
    else if (arg === '--no-prove') opts.prove = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 72).join('\n'));
      process.exit(0);
    } else {
      console.error(`verifySharedInvariants: unknown flag ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// A malformed or missing file is a HARD ERROR, never a silent empty list.
// "no invariants are enforced" must not be reachable by typo — same
// reasoning as runVerifySuite.js's loadExpectedFailures().
function loadInvariants() {
  if (!fs.existsSync(INVARIANTS_PATH)) {
    console.error(
      `verifySharedInvariants: missing ${path.relative(ROOT, INVARIANTS_PATH)} — ` +
      'this harness enforces nothing without it, which must never happen silently.'
    );
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(INVARIANTS_PATH, 'utf8'));
  } catch (err) {
    console.error(`verifySharedInvariants: shared-invariants.json is not valid JSON — ${err.message}`);
    process.exit(1);
  }
  if (!parsed || parsed.version !== INVARIANTS_VERSION) {
    console.error(
      `verifySharedInvariants: shared-invariants.json version ${parsed && parsed.version} != ${INVARIANTS_VERSION}`
    );
    process.exit(1);
  }
  if (!Array.isArray(parsed.invariants) || parsed.invariants.length === 0) {
    console.error('verifySharedInvariants: shared-invariants.json must contain a non-empty "invariants" array');
    process.exit(1);
  }
  for (const inv of parsed.invariants) {
    if (!inv.id) fatal('an invariant has no id');
    if (!inv.forbiddenPattern) fatal(`invariant ${inv.id} has no forbiddenPattern`);
    if (!Array.isArray(inv.appliesTo) || !inv.appliesTo.length) fatal(`invariant ${inv.id} has an empty appliesTo`);
    for (const ack of inv.acknowledged || []) {
      if (!REPO_LAYOUT[ack.repo]) fatal(`invariant ${inv.id}: acknowledged entry has unknown repo "${ack.repo}"`);
      if (!ack.path) fatal(`invariant ${inv.id}: an acknowledged entry has no path`);
      // Same bar as expected-failures.json: an entry nobody can act on is
      // worse than no entry, because it looks like due diligence.
      if (!String(ack.reason || '').trim()) fatal(`invariant ${inv.id}: acknowledged ${ack.repo}/${ack.path} has no reason`);
      if (!String(ack.removeWhen || '').trim()) fatal(`invariant ${inv.id}: acknowledged ${ack.repo}/${ack.path} has no removeWhen`);
    }
  }
  return parsed;
}

function fatal(msg) {
  console.error(`verifySharedInvariants: ${msg}`);
  process.exit(1);
}

function resolveScanPath(repo, relPath) {
  const layout = REPO_LAYOUT[repo];
  if (!layout || !layout.root) return null;
  return layout.prefix ? path.join(layout.root, layout.prefix, relPath) : path.join(layout.root, relPath);
}

// Matches are reported per LINE so a failure names something a human can
// open. Acknowledgements are keyed on repo+path and deliberately NOT on a
// line number: a line-keyed acknowledgement goes stale on every unrelated
// edit above it, which trains people to bulk-update the file without
// reading it — the exact rot this design is trying to avoid.
// adgen: the working tree (that IS the change under review).
// backend: the blob at BACKEND_REF (see the note on BACKEND_REF above).
function readSource(repo, relPath) {
  if (repo === 'backend') {
    if (!BACKEND_ROOT) return null;
    const blob = readBackendBlob(BACKEND_ROOT, BACKEND_REF, relPath);
    return blob ? blob.bytes.toString('utf8') : null;
  }
  const abs = resolveScanPath(repo, relPath);
  if (!abs) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return null;
  }
}

function scanSource(source, pattern) {
  if (source == null) return { readable: false, matches: [] };
  const matches = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(pattern);
    if (re.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return { readable: true, matches };
}

// PROBE — prove the pattern discriminates, on fixtures, in-memory. A
// harness that asserts "this regex is precise" without demonstrating it is
// just a claim. Temporary strings only; no repo file is touched.
function runPatternProbe(pattern) {
  const shouldMatch = [
    'lines.push(`Product: ${product?.title || \'(untitled product)\'}`);',
    '    lines.push(`Product: ${product.title}.`);',
    'const s = `Product:   ${x}`;',
  ];
  const shouldNotMatch = [
    '  // master): `Product: Vaportek.` was read as a brand-name render',
    '// `Product: {title}` used to lead this list; it was removed entirely',
    '  /^Product: /,',
    "lines.push('Product: static string');",
    '  // Do not re-add a named Product field.',
  ];
  const failures = [];
  for (const s of shouldMatch) {
    if (!new RegExp(pattern).test(s)) failures.push(`FALSE NEGATIVE: pattern missed live code -> ${s}`);
  }
  for (const s of shouldNotMatch) {
    if (new RegExp(pattern).test(s)) failures.push(`FALSE POSITIVE: pattern matched prose/inert -> ${s}`);
  }
  return failures;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = loadInvariants();
  const failures = [];
  const infos = [];
  let pass = 0;

  function check(label, fn) {
    try {
      fn();
      pass += 1;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }

  if (!BACKEND_ROOT) {
    infos.push(
      'sibling liquidretail_backend not found (ADGEN_BACKEND_PATH or ../liquidretail_backend) — ' +
      'backend-scoped scanning SKIPPED and backend acknowledgements NOT checked for staleness. ' +
      'adgen-scoped invariants still ran with full teeth.'
    );
  }

  if (opts.list) {
    for (const inv of doc.invariants) {
      for (const repo of Object.keys(REPO_LAYOUT)) {
        for (const rel of inv.appliesTo) {
          const abs = resolveScanPath(repo, rel);
          console.log(`${inv.id}  ${repo}  ${abs || '(repo absent)'}`);
        }
      }
    }
    return;
  }

  for (const inv of doc.invariants) {
    if (opts.prove) {
      check(`${inv.id}: pattern discriminates live code from prose`, () => {
        const probeFailures = runPatternProbe(inv.forbiddenPattern);
        if (probeFailures.length) throw new Error(probeFailures.join('\n'));
        infos.push(`${inv.id}: pattern probe passed (3 live-code fixtures matched, 5 prose/inert fixtures did not)`);
      });
    }

    const found = [];       // {repo, path, line, text}
    const unreadable = [];  // {repo, path}
    const skippedRepos = new Set();

    for (const repo of Object.keys(REPO_LAYOUT)) {
      if (!REPO_LAYOUT[repo].root) { skippedRepos.add(repo); continue; }
      for (const rel of inv.appliesTo) {
        const res = scanSource(readSource(repo, rel), inv.forbiddenPattern);
        if (!res.readable) { unreadable.push({ repo, path: rel }); continue; }
        for (const m of res.matches) found.push({ repo, path: rel, line: m.line, text: m.text });
      }
    }

    // A file named in appliesTo that does not exist is a REAL problem, not a
    // shrug: either the module was renamed (and the invariant now enforces
    // nothing on it) or the list is stale. Either way a human must look.
    // Only report it for repos that ARE present.
    check(`${inv.id}: every appliesTo file exists`, () => {
      const real = unreadable.filter((u) => !skippedRepos.has(u.repo));
      if (!real.length) return;
      throw new Error(
        `${real.length} file(s) named in appliesTo could not be read — renamed, moved, or the ` +
        `list is stale, and the invariant is silently enforcing nothing on them:\n    ` +
        real.map((u) => `${u.repo}/${u.path}`).join('\n    ')
      );
    });

    const ackList = inv.acknowledged || [];
    const ackKey = (repo, p) => `${repo} ${p}`;
    const ackIndex = new Map(ackList.map((a) => [ackKey(a.repo, a.path), a]));
    const matchedAckKeys = new Set();

    // Acknowledgements are keyed on repo+path, NOT on a line number: a
    // line-keyed entry goes stale on every unrelated edit above it, which
    // trains people to bulk-update this file without reading it — the exact
    // rot this design is avoiding.
    //
    // But repo+path ALONE would let an acknowledged file HIDE A NEW
    // INSTANCE: acknowledge the hit at :68 and a second one added at :200
    // keys to the same entry and passes silently. So each entry also carries
    // `count` (default 1) — how many instances it attests to. A different
    // number fails in EITHER direction:
    //   more  -> a new instance was added beside a known one;
    //   fewer -> some were fixed, so the entry overstates the debt.
    // That keeps line-independence while closing the hole.
    const countByKey = new Map();
    for (const f of found) {
      const key = ackKey(f.repo, f.path);
      countByKey.set(key, (countByKey.get(key) || 0) + 1);
    }

    const unacknowledged = [];
    const miscounted = [];
    for (const f of found) {
      const key = ackKey(f.repo, f.path);
      if (ackIndex.has(key)) { matchedAckKeys.add(key); continue; }
      unacknowledged.push(f);
    }
    for (const [key, actual] of countByKey) {
      const ack = ackIndex.get(key);
      if (!ack) continue;
      const expected = Number.isInteger(ack.count) ? ack.count : 1;
      if (actual !== expected) {
        miscounted.push({ key, expected, actual, lines: found.filter((f) => ackKey(f.repo, f.path) === key) });
      }
    }

    check(`${inv.id}: no new unacknowledged instances`, () => {
      if (!unacknowledged.length) return;
      throw new Error(
        `${unacknowledged.length} NEW instance(s) of a known-harmful construct.\n    ` +
        `WHY THIS MATTERS: ${Array.isArray(inv.rationale) ? inv.rationale.filter(Boolean)[0] : inv.rationale}\n    ` +
        unacknowledged.map((f) => `${f.repo}/${f.path}:${f.line}  ${f.text}`).join('\n    ') +
        `\n    Fix it, or — if it is genuinely intended — add an entry with a reason and a ` +
        `removeWhen to scripts/shared-invariants.json (invariant ${inv.id}).`
      );
    });

    check(`${inv.id}: acknowledged instance counts still match`, () => {
      if (!miscounted.length) return;
      const out = [
        `${miscounted.length} acknowledged file(s) no longer hold the attested number of ` +
        `instances. An acknowledgement covers a COUNT, not a whole file, so a new instance ` +
        `cannot hide beside a known one:`,
      ];
      for (const m of miscounted) {
        out.push(`  ${m.key}  attested ${m.expected}, found ${m.actual}`);
        for (const f of m.lines) out.push(`    :${f.line}  ${f.text}`);
        out.push(
          m.actual > m.expected
            ? `    MORE than attested — a new instance was added. Fix it, or raise "count" only if genuinely intended.`
            : `    FEWER than attested — some were fixed. Lower "count", or delete the entry if all are gone.`
        );
      }
      throw new Error(out.join('\n'));
    });

    // STALE — the fix landed but the entry is still listed. Same property
    // runVerifySuite.js enforces on expected-failures.json.
    check(`${inv.id}: no stale acknowledgements`, () => {
      const stale = ackList.filter((a) => {
        if (skippedRepos.has(a.repo)) return false;          // cannot judge; INFO below
        if (unreadable.some((u) => u.repo === a.repo && u.path === a.path)) return false;
        return !matchedAckKeys.has(ackKey(a.repo, a.path));
      });
      if (!stale.length) return;
      throw new Error(
        `${stale.length} acknowledged instance(s) NO LONGER MATCH — the construct is gone, so ` +
        `the entry is now suppressing nothing and must be deleted:\n    ` +
        stale.map((a) => `${a.repo}/${a.path}  (removeWhen: ${a.removeWhen})`).join('\n    ') +
        `\n    Deleting the entry is part of the fix, in the same commit.`
      );
    });

    for (const a of ackList) {
      if (skippedRepos.has(a.repo)) {
        infos.push(`${inv.id}: acknowledged ${a.repo}/${a.path} NOT evaluated (${a.repo} repo absent)`);
      }
    }

    const scanned = Object.keys(REPO_LAYOUT).filter((r) => !skippedRepos.has(r));
    infos.push(
      `${inv.id}: scanned ${inv.appliesTo.length} path(s) x ${scanned.length} repo(s) [${scanned.join(', ')}] — ` +
      `${found.length} match(es), ${matchedAckKeys.size} acknowledged, ${unacknowledged.length} new`
    );
    for (const f of found) {
      const known = ackIndex.has(ackKey(f.repo, f.path)) ? 'acknowledged' : 'NEW';
      infos.push(`  ${known}: ${f.repo}/${f.path}:${f.line}`);
    }
  }

  console.log(
    `verifySharedInvariants: ${doc.invariants.length} invariant(s)` +
    (BACKEND_ROOT ? ` vs backend ${BACKEND_REF || '(no ref — working tree)'}` : ' (backend absent)')
  );
  for (const line of infos) console.log(`  info: ${line}`);

  const total = pass + failures.length;
  if (failures.length) {
    console.log(`\n❌ verifySharedInvariants: ${failures.length} of ${total} check(s) FAILED`);
    for (const f of failures) {
      for (const line of String(f).split('\n')) console.log(`   ${line}`);
    }
    process.exit(1);
  }
  console.log(`\n✅ verifySharedInvariants: ${total}/${total} checks passed`);
}

main();
