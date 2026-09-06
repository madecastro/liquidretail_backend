// scripts/rpd/lib/publishNetlify.js — publish a run directory to Netlify.
//
// Sibling of publish.js (Cloudflare Pages). Netlify keeps gallery hosting on the
// same platform as the frontend, and the run directory is already a
// self-contained static folder, so this is a straight `netlify deploy`.
//
// PERMANENT PER-RUN URLS: deploy WITHOUT --prod on purpose. Netlify's `deploy_url`
// (`https://<deployId>--<site>.netlify.app`) is immutable per deploy, which is what
// LEARNINGS.md needs — a link that still shows THAT run a month later. `--prod`
// would publish to the site URL, which the next run would overwrite, silently
// re-pointing every historical row at the newest gallery.
//
// ⚠️ ACCESS: Netlify site password protection is a PAID capability
// (`secure_site`). On a Free team a published gallery is readable by anyone with
// the URL — the same posture as an ungated Cloudflare Pages deploy, and NOT a
// substitute for Cloudflare Access. Client-side Netlify Identity does not fix it
// either: the .mp4/.png assets stay directly fetchable regardless of any login
// widget. Do not put anything in a gallery you would not want forwarded until a
// real gate is in place.
//
// Auth: NETLIFY_AUTH_TOKEN (hosted/CI) or an interactive `netlify login` (local).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stageForPublish } = require('./publishStage');

function run(args, { json = false } = {}) {
  const res = spawnSync('npx', ['--yes', 'netlify-cli', ...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
  if (res.error) throw res.error;
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (!json) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
  }
  return { status: res.status, out, stdout: res.stdout || '' };
}

// The CLI prints human noise around --json output on some paths, so parse the
// first balanced JSON object rather than assuming the whole buffer is JSON.
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function siteExists(site) {
  const { status, out } = run(['api', 'listSites', '--data', '{"filter":"all"}'], { json: true });
  if (status !== 0) return false;
  try {
    const arr = JSON.parse(out.slice(out.indexOf('[')));
    return Array.isArray(arr) && arr.some((s) => s && s.name === site);
  } catch {
    return false;
  }
}

function publishRunNetlify(runDir, { site = 'rs-rpd', team = null, create = true } = {}) {
  // TEAM MATTERS, and getting it wrong is not a no-op. `sites:create` is
  // ambiguous once a login has more than one team, and the team determines
  // whether password protection is even available: `secure_site` is a PAID
  // capability, so a gallery created on a Free personal team cannot be gated
  // while the same gallery on a Pro team can. Pass the slug explicitly.
  const accountSlug = team || process.env.RPD_NETLIFY_TEAM || null;
  const abs = path.resolve(runDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`rpd: runDir not found or not a directory: ${abs}`);
  }
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    // Not fatal locally: the CLI may hold an interactive login. It IS fatal on a
    // hosted runner, so say so rather than failing with a confusing CLI error.
    console.log('rpd: NETLIFY_AUTH_TOKEN unset — relying on an interactive `netlify login` (required on Render/CI).');
  }

  if (create && !siteExists(site)) {
    console.log(`rpd: Netlify site "${site}" not found — creating it once`);
    const createArgs = ['sites:create', '--name', site, '--disable-linking'];
    if (accountSlug) createArgs.push('--account-slug', accountSlug);
    const created = run(createArgs);
    if (created.status !== 0) {
      throw new Error(
        `rpd: could not create Netlify site "${site}" (exit ${created.status}).` +
        (accountSlug ? '' : ' If this login has more than one team, pass --team <slug> (or RPD_NETLIFY_TEAM).') +
        ' If the name is taken globally, pass a different --site.'
      );
    }
  }

  // No --prod: see the permanent-URL note at the top of this file.
  // Deploy from a STAGED copy so the ledger is excluded on this path too — the
  // CLI has no per-file exclude, and publishing the whole directory is exactly
  // how manifest.json ended up public once.
  // --no-build is REQUIRED: netlify-cli v26 runs a build step by default, and a
  // run directory is already finished static output with no build to run (it
  // fails with a bare "Error while running build").
  const staged = stageForPublish(abs);
  let dep;
  try {
    dep = run(['deploy', '--dir', staged.dir, '--site', site, '--no-build', '--json'], { json: true });
  } finally {
    staged.cleanup();
  }
  if (dep.status !== 0) {
    throw new Error(`rpd: netlify deploy failed (exit ${dep.status})\n${dep.out.slice(0, 600)}`);
  }
  const parsed = firstJsonObject(dep.out) || {};
  const url = parsed.deploy_url || parsed.deploy_ssl_url || null;
  if (url) console.log(`Published: ${url}`);
  else console.log('Published, but no deploy_url was returned — check the Netlify dashboard.');
  console.log(
    'Note: Netlify site password protection requires a paid team (capability `secure_site`). ' +
    'On a Free team this URL is readable by anyone who has it.'
  );
  return { url, host: 'netlify', site, team: accountSlug };
}

module.exports = { publishRunNetlify };
