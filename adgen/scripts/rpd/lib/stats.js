// scripts/rpd/lib/stats.js — cross-run cost + latency rollup for the RPD harness.
//
// Scans every <outRoot>/*/manifest.json and aggregates cells by
// (kind, model, durationSec-or-size, resolution). Settled figures are
// ONLY costSource==='actual' — a group with zero settled cells shows
// 'n/a', never 0 (0 would look like a free render). Latency p50/p95 are
// computed by sorting; p95 on tiny n is noise and is labelled as such
// in the table header. One unreadable run never fails the whole scan.

const fs = require('fs');
const path = require('path');

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finite(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

// Video cells omit kind (runner.js); static cells stamp kind:'static'.
function cellKind(cell) {
  return cell.kind === 'static' ? 'static' : 'video';
}

// Static groups on plate size (1024x1024); video groups on durationSec.
function cellDim(cell, kind) {
  if (kind === 'static') return cell.size != null && cell.size !== '' ? String(cell.size) : '—';
  return cell.durationSec != null && cell.durationSec !== '' ? String(cell.durationSec) : '—';
}

function cellRes(cell) {
  return cell.resolution != null && cell.resolution !== '' ? String(cell.resolution) : '—';
}

function groupKey(kind, model, dim, resolution) {
  return `${kind}\0${model}\0${dim}\0${resolution}`;
}

// Sorted-sample percentile. p95 on n<20 is the last (or near-last) value
// and is noise — formatTable marks the column; we still report the number
// so the operator can see the sample rather than a blank.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function minOf(nums) {
  if (!nums.length) return null;
  return Math.min.apply(null, nums);
}

function maxOf(nums) {
  if (!nums.length) return null;
  return Math.max.apply(null, nums);
}

// Numbers must never be invented: empty settled/latency sets render as n/a.
function na(v, fmt) {
  if (v == null || !Number.isFinite(Number(v))) return 'n/a';
  return fmt ? fmt(Number(v)) : Number(v);
}

function fmtUsd(n) {
  return `$${n.toFixed(4)}`;
}

function fmtMs(n) {
  return Math.round(n);
}

function sortRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.kind !== b.kind) return String(a.kind).localeCompare(String(b.kind));
    if (a.model !== b.model) return String(a.model).localeCompare(String(b.model));
    if (a.dim !== b.dim) {
      return String(a.dim).localeCompare(String(b.dim), undefined, { numeric: true });
    }
    return String(a.resolution).localeCompare(String(b.resolution), undefined, { numeric: true });
  });
}

function emptyGroup(kind, model, dim, resolution) {
  return {
    kind,
    model,
    dim,
    resolution,
    n: 0,
    settled: [],
    estimateOnly: 0,
    latency: [],
    atlasExec: [],
    seedCold: [],
    seenRunsForCold: new Set()
  };
}

function collectStats(outRoot) {
  const root = outRoot == null ? '' : String(outRoot);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }

  const groups = new Map();

  for (const name of names) {
    const runDir = path.join(root, name);
    let st;
    try {
      st = fs.statSync(runDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const mf = path.join(runDir, 'manifest.json');
    let manifest;
    try {
      if (!fs.existsSync(mf)) continue;
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch {
      continue; // one bad manifest must not fail the rollup
    }
    if (!isObj(manifest) || !Array.isArray(manifest.cells)) continue;

    const cells = manifest.cells.filter(isObj);

    // Cold seed probe = first timings.seedProbe[0].ms on this run (probes
    // are de-duped across cells; only the first GET pays the Cloudinary
    // transform). Attributed to that cell's group, once.
    let coldMs = null;
    let coldKey = null;
    for (const cell of cells) {
      const probes = isObj(cell.timings) && Array.isArray(cell.timings.seedProbe)
        ? cell.timings.seedProbe
        : [];
      if (!probes.length) continue;
      const ms = finite(probes[0] && probes[0].ms);
      if (ms == null) continue;
      const kind = cellKind(cell);
      coldMs = ms;
      coldKey = groupKey(kind, String(cell.model || ''), cellDim(cell, kind), cellRes(cell));
      break;
    }

    for (const cell of cells) {
      const kind = cellKind(cell);
      const model = String(cell.model || '');
      const dim = cellDim(cell, kind);
      const resolution = cellRes(cell);
      const key = groupKey(kind, model, dim, resolution);
      if (!groups.has(key)) groups.set(key, emptyGroup(kind, model, dim, resolution));
      const g = groups.get(key);
      g.n += 1;

      if (cell.costSource === 'actual') {
        const usd = finite(cell.costUsd);
        if (usd != null) g.settled.push(usd);
      } else if (cell.costSource === 'estimated') {
        g.estimateOnly += 1;
      }

      const t = isObj(cell.timings) ? cell.timings : {};
      const lat = kind === 'static' ? finite(t.submitAndPollMs) : finite(t.queueToTerminalMs);
      if (lat != null) g.latency.push(lat);

      // Present (including published 0) — missing is not 0.
      if (t.atlasExecutionTime != null) {
        const exec = finite(t.atlasExecutionTime);
        if (exec != null) g.atlasExec.push(exec);
      }
    }

    if (coldMs != null && coldKey && groups.has(coldKey)) {
      const g = groups.get(coldKey);
      if (!g.seenRunsForCold.has(runDir)) {
        g.seenRunsForCold.add(runDir);
        g.seedCold.push(coldMs);
      }
    }
  }

  const rows = [];
  for (const g of groups.values()) {
    const latSorted = g.latency.slice().sort((a, b) => a - b);
    rows.push({
      kind: g.kind,
      model: g.model,
      dim: g.dim,
      resolution: g.resolution,
      n: g.n,
      settledMean: na(mean(g.settled), fmtUsd),
      settledMin: na(minOf(g.settled), fmtUsd),
      settledMax: na(maxOf(g.settled), fmtUsd),
      estimateOnly: g.estimateOnly,
      latP50: na(percentile(latSorted, 0.50), fmtMs),
      latP95: na(percentile(latSorted, 0.95), fmtMs),
      atlasExecMean: na(mean(g.atlasExec), fmtMs),
      seedColdMean: na(mean(g.seedCold), fmtMs)
    });
  }
  return sortRows(rows);
}

const COLS = [
  { key: 'kind',          head: 'kind' },
  { key: 'model',         head: 'model' },
  { key: 'dim',           head: 'dur/size' },
  { key: 'resolution',    head: 'res' },
  { key: 'n',             head: 'n' },
  { key: 'settledMean',   head: 'settledμ' },
  { key: 'settledMin',    head: 'settled min' },
  { key: 'settledMax',    head: 'settled max' },
  { key: 'estimateOnly',  head: 'est-only' },
  { key: 'latP50',        head: 'lat p50 ms' },
  { key: 'latP95',        head: 'lat p95 ms*' },
  { key: 'atlasExecMean', head: 'atlas exec μ' },
  { key: 'seedColdMean',  head: 'seed cold μ' }
];

function formatTable(rows) {
  const list = sortRows(Array.isArray(rows) ? rows : []);
  const note = '* p95 on tiny n is noise (sorted-sample; last value when n=1)';
  if (!list.length) return `(no runs)\n${note}`;

  const widths = COLS.map((c) => c.head.length);
  const cells = list.map((row) => COLS.map((c, i) => {
    const s = row[c.key] == null ? '' : String(row[c.key]);
    if (s.length > widths[i]) widths[i] = s.length;
    return s;
  }));

  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const out = [line(COLS.map((c) => c.head)), rule];
  for (const vals of cells) out.push(line(vals));
  out.push(note);
  return out.join('\n');
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows) {
  const list = sortRows(Array.isArray(rows) ? rows : []);
  const header = COLS.map((c) => csvEscape(c.head)).join(',');
  const lines = [header];
  for (const row of list) {
    lines.push(COLS.map((c) => csvEscape(row[c.key])).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { collectStats, formatTable, toCsv };
