'use strict';
// Single entrypoint for all three roles. ADGEN_ROLE selects which one
// runs. Boot sequence: connect Mongo → start role → install graceful
// shutdown → wait.

const { ROLE, PORT, WORKER_ID } = require('./config');
const { connect, disconnect } = require('./db');

async function main() {
  console.log(`liquidretail_adgen role=${ROLE} worker=${WORKER_ID}`);

  await connect();

  if (ROLE === 'api') {
    const { buildApp } = require('./routes/api');
    const app = buildApp();
    const server = app.listen(PORT, () => {
      console.log(`api listening on :${PORT}`);
    });
    installShutdown(async () => {
      server.close();
      await disconnect();
    });
    return;
  }

  if (ROLE === 'orchestrator') {
    const orchestrator = require('./services/orchestrator');
    await orchestrator.run();
    installShutdown(async () => {
      orchestrator.shutdown();
      await disconnect();
    });
    return;
  }

  if (ROLE === 'renderer') {
    const renderer = require('./services/renderer');
    await renderer.run();
    installShutdown(async () => {
      // AWAIT: renderer.shutdown is async now — drains in-flight processAd()
      // promises and releases any remaining claims for peer pickup before we
      // let installShutdown call process.exit(0). Fire-and-forget here would
      // race with process.exit and lose the release write.
      await renderer.shutdown();
      await disconnect();
    });
    return;
  }

  if (ROLE === 'titler') {
    const titler = require('./services/titler');
    await titler.run();
    installShutdown(async () => {
      // AWAIT for the same reason renderer does: titler.shutdown drains
      // in-flight titling and releases any remaining claims so a peer
      // titler picks them up on the next poll.
      await titler.shutdown();
      await disconnect();
    });
    return;
  }
}

function installShutdown(fn) {
  let dying = false;
  const handle = (sig) => async () => {
    if (dying) return;
    dying = true;
    console.log(`received ${sig}, shutting down`);
    try { await fn(); } catch (err) { console.error('shutdown error', err); }
    process.exit(0);
  };
  process.on('SIGTERM', handle('SIGTERM'));
  process.on('SIGINT',  handle('SIGINT'));
}

main().catch(err => {
  console.error('fatal boot error:', err);
  process.exit(1);
});
