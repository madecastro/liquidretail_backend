// Executor for capability integrations.metaAds.disconnect (Tier 1, brand scope).
// Delegates to the shared helper — see _integrationsAgentCommon.js.

'use strict';

const { disconnect } = require('./_integrationsAgentCommon');

async function run({ req, args }) {
  return disconnect({ req, args, providerKey: 'metaAds' });
}

module.exports = { run };
