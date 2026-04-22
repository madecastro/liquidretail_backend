// Product match orchestrator. Runs every enabled provider in parallel and
// returns a normalized result shape the UI can render uniformly.
//
// Adding a new provider (e.g. Vertex AI Product Search for a brand catalog):
//   1. Create server/services/providers/<name>.js exporting { match, isEnabled, PROVIDER_NAME }
//   2. require + register it below
//   3. Its output slot in the response appears automatically; no call-site changes.

const geminiSearch = require('./providers/geminiSearchProvider');
const googleLens   = require('./providers/googleLensProvider');

const PROVIDERS = [
  geminiSearch,
  googleLens
];

async function findProductMatches({ brand, category, caption, primarySubject, textDetected, imageUrl }) {
  const enabled = PROVIDERS.filter(p => p.isEnabled());
  const skipped = PROVIDERS.filter(p => !p.isEnabled()).map(p => p.PROVIDER_NAME);

  if (enabled.length === 0) {
    return {
      query: { brand, category, caption, primarySubject },
      providers: {},
      errors: {},
      skipped,
      totalMatches: 0
    };
  }

  const tasks = enabled.map(p =>
    p.match({ brand, category, caption, primarySubject, textDetected, imageUrl })
     .then(result => ({ status: 'ok', name: p.PROVIDER_NAME, result }))
     .catch(err => ({ status: 'err', name: p.PROVIDER_NAME, error: err.message || String(err) }))
  );

  const settled = await Promise.all(tasks);

  const providers = {};
  const errors = {};
  let totalMatches = 0;
  for (const s of settled) {
    if (s.status === 'ok') {
      providers[s.name] = s.result;
      totalMatches += s.result.matches.length;
    } else {
      errors[s.name] = s.error;
      console.warn(`   ✗ ${s.name}: ${s.error}`);
    }
  }

  return {
    query: { brand, category, caption, primarySubject, textDetected },
    providers,
    errors,
    skipped,
    totalMatches
  };
}

module.exports = { findProductMatches };
