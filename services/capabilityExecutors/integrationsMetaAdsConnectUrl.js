// Executor for capability integrations.metaAds.connectUrl (Tier 1, brand scope).
// Delegates to the shared helper — see _integrationsAgentCommon.js.

'use strict';

const { connectUrl } = require('./_integrationsAgentCommon');

async function run({ req, args }) {
  return connectUrl({ req, args, providerKey: 'metaAds' });
}

module.exports = { run };
