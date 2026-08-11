// Executor for capability integrations.googleAds.listCredentials (Tier 0, brand scope).
// Delegates to the shared helper — see _integrationsAgentCommon.js.

'use strict';

const { listCredentials } = require('./_integrationsAgentCommon');

async function run({ req, args }) {
  return listCredentials({ req, args, providerKey: 'googleAds' });
}

module.exports = { run };
