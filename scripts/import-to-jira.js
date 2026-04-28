// Push backlog.csv to Jira Cloud via REST v3.
//
// Usage:
//   node scripts/import-to-jira.js              # import everything
//   node scripts/import-to-jira.js --label phase-b   # only rows tagged phase-b
//   node scripts/import-to-jira.js --dry-run    # parse + plan, don't POST
//
// Environment:
//   JIRA_BASE_URL          e.g. https://yourco.atlassian.net
//   JIRA_EMAIL             your atlassian login email
//   JIRA_API_TOKEN         from id.atlassian.com/manage-profile/security/api-tokens
//   JIRA_PROJECT_KEY       e.g. LR
//   JIRA_EPIC_LINK_FIELD   custom field id; default customfield_10014 (cloud standard)
//   JIRA_EPIC_NAME_FIELD   custom field id; default customfield_10011 (company-managed only)
//   JIRA_USE_EPIC_NAME_FIELD  set to 'true' if your Jira instance is company-managed
//                             and requires Epic Name. Team-managed projects don't need it.
//
// Two-pass execution:
//   1. Find all Epic rows and create them first, capturing the returned
//      issue keys keyed by Epic Name.
//   2. Create every non-epic row, looking up its Epic Link by name and
//      substituting the captured key.

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CSV_PATH = path.join(__dirname, '..', 'docs', 'backlog.csv');

// ── env ──────────────────────────────────────────────────────────────
const JIRA_BASE_URL    = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_EMAIL       = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN   = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || '';
const EPIC_LINK_FIELD  = process.env.JIRA_EPIC_LINK_FIELD || 'customfield_10014';
const EPIC_NAME_FIELD  = process.env.JIRA_EPIC_NAME_FIELD || 'customfield_10011';
const USE_EPIC_NAME    = String(process.env.JIRA_USE_EPIC_NAME_FIELD || '').toLowerCase() === 'true';

// ── args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const labelFilter = (() => {
  const i = args.indexOf('--label');
  return i >= 0 ? args[i + 1] : null;
})();
const isDryRun = args.includes('--dry-run');

// ── CSV parser (handles quoted fields with embedded commas + quotes) ─
function parseCsv(src) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      field += c;
    } else {
      if (c === '"')  { inQuotes = true; continue; }
      if (c === ',')  { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function rowsToObjects(rows) {
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.length && r.some(c => c && c.trim()))
    .map(r => {
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = (r[i] || '').trim();
      return o;
    });
}

// ── Jira helpers ─────────────────────────────────────────────────────
function authHeader() {
  return { Authorization: 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64') };
}

// Plain text → Atlassian Document Format. Single-paragraph wrap is
// fine for our backlog descriptions; richer formatting can come later.
function adf(text) {
  return {
    type: 'doc', version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text || '') }] }]
  };
}

function buildIssuePayload(row, epicKeyByName) {
  const fields = {
    project:     { key: JIRA_PROJECT_KEY },
    summary:     row.Summary || '(untitled)',
    description: adf(row.Description || ''),
    issuetype:   { name: row['Issue Type'] || 'Story' }
  };
  if (row.Priority)  fields.priority   = { name: row.Priority };
  if (row.Component) fields.components = row.Component.split(';').map(c => ({ name: c.trim() })).filter(c => c.name);
  if (row.Labels) {
    // Jira labels can't contain spaces; semicolons are our separator,
    // commas are CSV-reserved. Split on either, keep alphanumeric+dash.
    fields.labels = row.Labels.split(/[;,]/).map(l => l.trim().replace(/\s+/g, '-')).filter(Boolean);
  }

  const isEpic = (row['Issue Type'] || '').toLowerCase() === 'epic';
  if (isEpic && USE_EPIC_NAME && row['Epic Name']) {
    fields[EPIC_NAME_FIELD] = row['Epic Name'];
  }
  if (!isEpic && row['Epic Link']) {
    const epicKey = epicKeyByName[row['Epic Link']];
    if (epicKey) fields[EPIC_LINK_FIELD] = epicKey;
    else         console.warn(`   ⚠️  ${row.Summary}: Epic Link "${row['Epic Link']}" — no matching epic created in this run`);
  }
  return { fields };
}

async function createIssue(payload) {
  const res = await axios.post(
    `${JIRA_BASE_URL}/rest/api/3/issue`,
    payload,
    { headers: { ...authHeader(), 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  return res.data; // { id, key, self }
}

// ── Main ─────────────────────────────────────────────────────────────
function rowMatchesFilter(row) {
  if (!labelFilter) return true;
  const labels = (row.Labels || '').toLowerCase();
  return labels.split(/[;,]/).map(l => l.trim()).includes(labelFilter.toLowerCase());
}

(async function main() {
  // Sanity-check env up front (skipped on dry-run so you can preview without creds).
  if (!isDryRun) {
    const missing = [];
    if (!JIRA_BASE_URL)    missing.push('JIRA_BASE_URL');
    if (!JIRA_EMAIL)       missing.push('JIRA_EMAIL');
    if (!JIRA_API_TOKEN)   missing.push('JIRA_API_TOKEN');
    if (!JIRA_PROJECT_KEY) missing.push('JIRA_PROJECT_KEY');
    if (missing.length) {
      console.error(`❌ missing env: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  const src = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = rowsToObjects(parseCsv(src));
  const filtered = rows.filter(rowMatchesFilter);

  console.log(`📄 ${rows.length} rows in CSV; ${filtered.length} match filter${labelFilter ? ` (label=${labelFilter})` : ''}`);

  const epics    = filtered.filter(r => (r['Issue Type'] || '').toLowerCase() === 'epic');
  const nonEpics = filtered.filter(r => (r['Issue Type'] || '').toLowerCase() !== 'epic');
  console.log(`   · ${epics.length} epic(s), ${nonEpics.length} non-epic`);

  const epicKeyByName = {};

  if (isDryRun) {
    console.log('\n🟡 DRY RUN — would POST:');
    for (const e of epics) {
      const epicName = e['Epic Name'] || e.Summary;
      epicKeyByName[epicName] = '<NEW-KEY>';
      console.log(`  EPIC  "${e.Summary}"  (Epic Name: ${epicName})`);
    }
    for (const r of nonEpics) {
      const link = r['Epic Link'] ? ` → epic "${r['Epic Link']}"` : '';
      console.log(`  ${(r['Issue Type'] || 'Story').toUpperCase().padEnd(6)} "${r.Summary}"${link}`);
    }
    return;
  }

  // Pass 1: epics
  for (const e of epics) {
    const epicName = e['Epic Name'] || e.Summary;
    try {
      const payload = buildIssuePayload(e, epicKeyByName);
      const created = await createIssue(payload);
      epicKeyByName[epicName] = created.key;
      console.log(`✅ EPIC ${created.key}  ${e.Summary}`);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`❌ EPIC failed for "${e.Summary}": ${detail}`);
    }
  }

  // Pass 2: non-epics with Epic Link resolution
  for (const r of nonEpics) {
    try {
      const payload = buildIssuePayload(r, epicKeyByName);
      const created = await createIssue(payload);
      const epicLine = r['Epic Link'] ? ` (epic ${epicKeyByName[r['Epic Link']] || '?'})` : '';
      console.log(`✅ ${(r['Issue Type'] || 'Story').padEnd(6)} ${created.key}  ${r.Summary}${epicLine}`);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`❌ failed for "${r.Summary}": ${detail}`);
    }
  }

  console.log(`\n🎉 Done.`);
})().catch(err => { console.error(err); process.exit(1); });
