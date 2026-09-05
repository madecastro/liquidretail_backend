// scripts/rpd/lib/publishNetlifyApi.js — publish a run directory to Netlify via
// the REST API. No CLI, no login state, no zip binary: just a token.
//
// WHY THE API AND NOT THE CLI: the owner has two Netlify accounts and switches
// between them. `netlify switch --email` mutates a machine-wide login, so which
// account a publish lands in depends on invisible local state — and on Render
// there is no interactive login at all. A token IS the account selector, so this
// path is both deterministic locally and the only thing that works hosted.
//
// Uses the DIGEST flow (declare sha1s → upload only what Netlify asks for)
// rather than a zip upload, because `zip` is not guaranteed on Render's node
// image and this needs nothing but node's crypto + fetch.
//
// Auth: NETLIFY_AUTH_TOKEN — a Personal Access Token from the account that owns
// the target team (User settings → Applications → Personal access tokens).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.netlify.com/api/v1';

// What may be published is defined ONCE, in publishStage.js, so this path and
// the CLI path cannot drift (they did: the CLI published the ledger).
const { shouldPublish } = require('./publishStage');

function token() {
  const t = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  if (!t) {
    throw new Error(
      'rpd: NETLIFY_AUTH_TOKEN is required to publish to Netlify. Create a Personal ' +
      'Access Token in the account that owns the target team (User settings → ' +
      'Applications → Personal access tokens) and export it. The token selects the ' +
      'account, so no `netlify switch` is needed.'
    );
  }
  return t;
}

async function api(pathname, { method = 'GET', body = null, raw = null, contentType = null } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(contentType ? { 'Content-Type': contentType } : (body ? { 'Content-Type': 'application/json' } : {}))
    },
    body: raw != null ? raw : (body ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* some endpoints return empty */ }
  if (!res.ok) {
    const why = (json && (json.message || json.error)) || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`Netlify API ${method} ${pathname} → ${res.status}: ${why}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Every file, recursively, as { "/rel/path": {abs, sha1} }.
function collectFiles(root) {
  const out = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const rel = `/${path.relative(root, abs).split(path.sep).join('/')}`;
      if (!shouldPublish(abs)) continue;
      const buf = fs.readFileSync(abs);
      out[rel] = { abs, sha1: crypto.createHash('sha1').update(buf).digest('hex') };
    }
  })(root);
  return out;
}

async function resolveSite({ site, team }) {
  // Exact-name match across visible sites; `?name=` on Netlify is a fuzzy filter,
  // so matching in code avoids deploying into a similarly-named site.
  const list = await api(`/sites?filter=all&per_page=200`);
  const found = (list || []).find((s) => s && s.name === site);
  if (found) return found;
  if (!team) {
    throw new Error(
      `rpd: Netlify site "${site}" not found, and no --team/RPD_NETLIFY_TEAM given to create it in. ` +
      'Pass the team slug so a new site cannot land in the wrong account.'
    );
  }
  console.log(`rpd: creating Netlify site "${site}" in team "${team}"`);
  return api(`/${encodeURIComponent(team)}/sites`, { method: 'POST', body: { name: site } });
}

async function publishRunNetlifyApi(runDir, { site = 'rs-rpd', team = null, draft = true } = {}) {
  const root = path.resolve(runDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`rpd: runDir not found or not a directory: ${root}`);
  }
  const accountSlug = team || process.env.RPD_NETLIFY_TEAM || null;
  const siteObj = await resolveSite({ site, team: accountSlug });

  const files = collectFiles(root);
  const names = Object.keys(files);
  if (!names.length) throw new Error(`rpd: nothing to publish in ${root}`);

  // DRAFT deploy on purpose: its URL is immutable, so a LEARNINGS row still
  // shows THAT run later. A production deploy would be overwritten by the next
  // publish, silently re-pointing every historical link at the newest gallery.
  const digest = {};
  for (const n of names) digest[n] = files[n].sha1;
  const deploy = await api(`/sites/${siteObj.id}/deploys`, {
    method: 'POST',
    body: { files: digest, draft: !!draft }
  });

  const required = new Set(deploy.required || []);
  const toUpload = names.filter((n) => required.has(files[n].sha1));
  console.log(`rpd: ${names.length} file(s) declared, ${toUpload.length} to upload`);
  for (const n of toUpload) {
    await api(`/deploys/${deploy.id}/files${n}`, {
      method: 'PUT',
      raw: fs.readFileSync(files[n].abs),
      contentType: 'application/octet-stream'
    });
    console.log(`  ↑ ${n}`);
  }

  // Poll briefly for the deploy to leave 'uploading'/'preparing'.
  let state = deploy.state;
  let final = deploy;
  for (let i = 0; i < 20 && state !== 'ready' && state !== 'error'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    final = await api(`/deploys/${deploy.id}`);
    state = final.state;
  }
  const url = final.deploy_ssl_url || final.deploy_url || final.ssl_url || final.url || null;
  if (state === 'error') throw new Error(`rpd: Netlify deploy ended in state 'error' (${final.error_message || 'no message'})`);
  if (url) console.log(`Published: ${url}   [state: ${state}]`);
  return { url, host: 'netlify', site, team: accountSlug, deployId: final.id, state };
}

module.exports = { publishRunNetlifyApi, collectFiles };
