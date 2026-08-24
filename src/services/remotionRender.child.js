'use strict';
//
// Remotion titling child. Spawned by remotionChildSupervisor for every
// production renderTitles call.
//
// House pattern (brandScriptRunner.child.js):
//   - config JSON on stdin
//   - progress lines prefixed '::'
//   - last stdout line is a JSON report { ok: true, finalPath, tempDir, timings }
//     or { ok: false, error: { name, message, stack, code } }
//   - process exits; the OS reclaims Chrome + ffmpeg RSS
//
// The parent holds the REMOTION_QUEUE_CONCURRENCY pool. This process runs
// exactly one render and dies. REMOTION_IN_CHILD=1 (set by the supervisor)
// makes remotionRenderService.renderTitles run in-process here instead of
// spawning another child.

const { serializeError } = require('./remotionChildSupervisor');

process.env.REMOTION_IN_CHILD = '1';

function readConfigFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`stdin was not valid JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

function progress(msg) {
  process.stdout.write(`:: ${msg}\n`);
}

async function main() {
  const config = await readConfigFromStdin();
  progress(`starting remotion child ad=${config.adId || '?'} format=${config.format || '?'}`);
  const { renderTitles } = require('./remotionRenderService');
  const result = await renderTitles(config);
  // Paths only. The parent uploads finalPath and rm's tempDir.
  const report = JSON.stringify({
    ok: true,
    finalPath: result.finalPath,
    tempDir: result.tempDir,
    timings: result.timings || {}
  }) + '\n';
  await new Promise((resolve, reject) => {
    process.stdout.write(report, (err) => (err ? reject(err) : resolve()));
  });
  // Remotion's Chrome / asset server can pin the event loop after the
  // render returns. Without an explicit exit the parent sits on close
  // until RENDER_TIMEOUT_MS and then SIGKILLs a SUCCESSFUL render,
  // classifying it as timeout. brandScriptRunner.child.js didn't need
  // this because canvas does not keep a browser open.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${(err && err.stack) || (err && err.message) || String(err)}\n`);
  const report = JSON.stringify({ ok: false, error: serializeError(err) }) + '\n';
  process.stdout.write(report, () => process.exit(1));
  // If stdout is already closed, the callback never fires — still die.
  setTimeout(() => process.exit(1), 1000).unref();
});
