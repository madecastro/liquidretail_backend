// scripts/rpd/lib/publish.js — deploy an RPD runDir to Cloudflare Pages.
// Needs CLOUDFLARE_API_TOKEN (CLOUDFLARE_ACCOUNT_ID if you have one).
// A missing project is created once, then deploy is retried once.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function requireCloudflareEnv() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'rpd: CLOUDFLARE_API_TOKEN is required to publish. ' +
      'Set CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID if you have one).'
    );
  }
}

function runWrangler(args) {
  // Capture for URL / project-not-found parse, then replay. stdio:'inherit'
  // would print but drop the bytes we need to parse.
  const result = spawnSync('npx', ['--yes', 'wrangler', ...args], {
    encoding: 'utf8',
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result;
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function isProjectNotFound(text) {
  return /project not found|does not exist|doesn't exist|no project named|pages project.{0,40}not found/i.test(text);
}

function parsePagesUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9._-]+\.pages\.dev[^\s"'<>]*/i);
  if (!m) return null;
  return m[0].replace(/[.,;)]+$/, '');
}

function deployArgs(runDir, project, branch) {
  return [
    'pages', 'deploy', runDir,
    '--project-name', project,
    '--branch', branch,
    '--commit-dirty=true'
  ];
}

function publishRun(runDir, { project = 'rs-rpd', branch = 'main' } = {}) {
  requireCloudflareEnv();

  const abs = path.resolve(runDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`rpd: runDir not found or not a directory: ${abs}`);
  }

  let result = runWrangler(deployArgs(abs, project, branch));
  if (result.status !== 0 && isProjectNotFound(combinedOutput(result))) {
    console.log(`rpd: project "${project}" not found — creating once, then retrying deploy`);
    const created = runWrangler([
      'pages', 'project', 'create', project,
      '--production-branch', branch
    ]);
    if (created.status !== 0) {
      throw new Error(`rpd: wrangler pages project create failed (exit ${created.status})`);
    }
    result = runWrangler(deployArgs(abs, project, branch));
  }

  if (result.status !== 0) {
    throw new Error(`rpd: wrangler pages deploy failed (exit ${result.status})`);
  }

  const url = parsePagesUrl(combinedOutput(result));
  console.log('Note: a fresh Pages project can 522 for ~2 minutes while propagating.');
  if (url) console.log(`Published: ${url}`);
  else console.log('Published: (could not parse a *.pages.dev URL from wrangler output)');
  return { url };
}

module.exports = { publishRun };
