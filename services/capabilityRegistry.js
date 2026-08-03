// Capability registry — SINGLE source of truth for what the home-page
// AI agent can do, AND what the UI can expose in menus. Both layers read
// the same array so they cannot drift.
//
// Every capability describes ONE user-facing action. Agent tools are
// generated from these entries via capabilitiesToTools(); UI menus are
// filtered by applicableCapabilities(scope, contextDoc). The `execute`
// block resolves to an in-process service call — no self-HTTP re-auth
// cycle — so tenant scoping stays on the authenticated `req`.
//
// RULES ENFORCED HERE:
// - id is globally unique.
// - tier ∈ [0, 4]:
//     0 = read-only, autonomous
//     1 = cheap write, inline confirm
//     2 = billable write, confirm + resource/spend estimate
//     3 = external / hard-to-reverse, explicit "I understand" confirm
//     4 = multi-step workflow, plan-first
// - scope ∈ {'ad', 'brand', 'advertiser', 'product', 'campaign', 'global'}
//   — the context shape the capability needs. UI filters by scope so a
//   brand-scoped menu never shows an ad-scoped capability.
// - args uses JSONSchema (OpenAI/Anthropic tool-schema compatible).
// - execute.kind ∈ {'service'}. HTTP kind reserved for cross-service
//   calls; not used yet.
// - when (optional) is an array of Mongo-style predicates evaluated
//   against the context doc — see applicableCapabilities.
//
// FORBIDDEN HERE:
// - Business logic. The registry describes actions, never implements
//   them. Every execute lands in an existing service.
// - Cross-tenant leaks. Services MUST tenant-scope; the executor only
//   forwards `req` (carrying advertiserId + user).
// - Bypassing spend caps. Tier 2+ capabilities MUST consult spendGuard
//   inside the service before dispatching billable work.

'use strict';

const VALID_TIERS   = new Set([0, 1, 2, 3, 4]);
const VALID_SCOPES  = new Set(['ad', 'brand', 'advertiser', 'product', 'campaign', 'global']);
const VALID_KINDS   = new Set(['service']);   // 'route' reserved for later

// ═══════════════════════════════════════════════════════════════════
// THE MANIFEST
// ═══════════════════════════════════════════════════════════════════
//
// Add entries here. Every entry is a plain object; no code in this file
// runs on load. Order is display order for the manifest render.

const CAPABILITIES = [

  // ── Tier 0: read-only, autonomous ────────────────────────────────

  {
    id:       'catalog.listProducts',
    title:    'List products',
    describe: 'List products for the current brand. Filter by rough state — e.g. missing lifestyle image, missing on-site reviews, or none for a full list. Returns count plus up to 20 sample rows.',
    tier:     0,
    scope:    'brand',
    args: {
      type: 'object',
      properties: {
        brandId: {
          type: 'string',
          description: 'Brand ObjectId. Defaults to the caller-selected brand.'
        },
        missing: {
          type: 'string',
          enum: ['lifestyle_image', 'onsite_reviews', 'video_media'],
          description: 'Optional filter: only include products lacking this asset.'
        },
        limit: {
          type: 'integer',
          minimum: 1, maximum: 100,
          description: 'Row cap (default 20). The count is always the full total.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/catalogListProducts',
      method:  'run'
    }
  },

  {
    id:       'ad.inspect',
    title:    'Inspect ad',
    describe: 'Return the generation-inspector payload for one ad — model, prompt, references, warnings, regen state. Same source the Generation Details modal reads.',
    tier:     0,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId:    { type: 'string', description: 'Ad ObjectId.' },
        brandId: { type: 'string', description: 'Optional — inferred from the ad if omitted.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adInspect',
      method:  'run'
    }
  },

  {
    id:       'spend.today',
    title:    'Spend today',
    describe: 'Return the current advertiser\'s ad-generation spend since midnight UTC. Breaks down by provider (Atlas video, Atlas image, LLM) and returns a total in USD.',
    tier:     0,
    scope:    'advertiser',
    args: {
      type: 'object',
      properties: {
        sinceHoursAgo: {
          type: 'integer',
          minimum: 1, maximum: 168,
          description: 'Window in hours (default 24). Cap 168 = 7 days.'
        }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/spendToday',
      method:  'run'
    }
  },

  // ── Tier 1: cheap writes, inline confirmation required ───────────

  {
    id:       'ad.archive',
    title:    'Archive ad',
    describe: 'Move one ad to status \'archived\'. Reversible via ad.restore. Does not delete the render or the artifact — just hides the ad from active views. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adArchive',
      method:  'run'
    }
  },

  {
    id:       'ad.restore',
    title:    'Restore archived ad',
    describe: 'Move an archived ad back to status \'draft\'. Reverses ad.archive. Requires operator confirmation.',
    tier:     1,
    scope:    'ad',
    args: {
      type: 'object',
      required: ['adId'],
      properties: {
        adId: { type: 'string', description: 'Ad ObjectId.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/adRestore',
      method:  'run'
    }
  },

  {
    id:       'brand.updateTagline',
    title:    'Update brand tagline',
    describe: 'Set a brand\'s tagline (marketing one-liner used in generated ads and layout inputs). Reversible by calling again with the previous value. Requires operator confirmation.',
    tier:     1,
    scope:    'brand',
    args: {
      type: 'object',
      required: ['brandId', 'tagline'],
      properties: {
        brandId: { type: 'string', description: 'Brand ObjectId.' },
        tagline: { type: 'string', minLength: 1, maxLength: 200,
                   description: 'New tagline text. Max 200 chars.' }
      },
      additionalProperties: false
    },
    execute: {
      kind:    'service',
      service: './capabilityExecutors/brandUpdateTagline',
      method:  'run'
    }
  }

  // Tier 2+ entries land in follow-up PRs (see backlog row 167).
];

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert a capability list into OpenAI-compatible tool schemas —
 * accepted verbatim by Atlas's chat/completions gateway and, in the
 * follow-up streaming PR, by the native Anthropic SDK too.
 */
function capabilitiesToTools(caps = CAPABILITIES) {
  return caps.map((c) => ({
    type: 'function',
    function: {
      name:        c.id.replace(/\./g, '__'),   // OpenAI: [a-zA-Z0-9_-]{1,64}
      description: `[tier=${c.tier}, scope=${c.scope}] ${c.describe}`,
      parameters:  c.args || { type: 'object', properties: {}, additionalProperties: false }
    }
  }));
}

/**
 * Reverse of capabilitiesToTools' name-munging. Tool call names arrive
 * as 'catalog__listProducts'; the registry keys them as 'catalog.listProducts'.
 */
function capabilityById(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

function capabilityByToolName(name) {
  const id = String(name || '').replace(/__/g, '.');
  return capabilityById(id);
}

/**
 * Filter capabilities by scope and evaluate `when` predicates against a
 * context doc. Returns { ok, why? } tuples so the UI can show WHY a
 * capability is disabled (e.g. "ad is exported — read-only").
 *
 * A capability with no `when` array is always applicable within scope.
 * A `when` array is AND-joined; every clause must pass.
 */
function applicableCapabilities(scope, contextDoc = {}) {
  return CAPABILITIES
    .filter((c) => c.scope === scope)
    .map((c) => {
      const failing = (c.when || []).find((clause) => !evalClause(clause, contextDoc));
      return failing
        ? { capability: c, ok: false, why: describeClause(failing) }
        : { capability: c, ok: true };
    });
}

/**
 * Render a compact human-readable manifest for injection into the agent's
 * system prompt. Deliberately terse — the LLM only needs id, tier, scope,
 * and a one-sentence describe to route intents. Full args live in the
 * tool schemas via capabilitiesToTools.
 */
function describeManifest(caps = CAPABILITIES) {
  return caps.map((c) =>
    `- id=${c.id} tier=${c.tier} scope=${c.scope}: ${c.describe}`
  ).join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL — where the sift-lite matcher would live
// ═══════════════════════════════════════════════════════════════════

// Tiny Mongo-style operator evaluator. Supports $eq (implicit), $ne, $in,
// $nin, $exists. Dot-path field lookup. NO regex / no arbitrary code.
// Kept in-file so the registry file has zero deps.
function getPath(doc, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), doc);
}
function evalClause(clause, doc) {
  return Object.entries(clause).every(([field, cond]) => {
    const actual = getPath(doc, field);
    if (cond == null || typeof cond !== 'object') return actual === cond;
    if ('$eq'     in cond) return actual === cond.$eq;
    if ('$ne'     in cond) return actual !== cond.$ne;
    if ('$in'     in cond) return Array.isArray(cond.$in)  && cond.$in.includes(actual);
    if ('$nin'    in cond) return Array.isArray(cond.$nin) && !cond.$nin.includes(actual);
    if ('$exists' in cond) return cond.$exists ? actual != null : actual == null;
    return false;   // unknown operator — fail closed
  });
}
function describeClause(clause) {
  return Object.entries(clause).map(([field, cond]) => {
    if (cond == null || typeof cond !== 'object') return `${field}=${JSON.stringify(cond)}`;
    const [op, val] = Object.entries(cond)[0] || [];
    return `${field} ${op} ${JSON.stringify(val)}`;
  }).join(' AND ');
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION (verifier consumes this)
// ═══════════════════════════════════════════════════════════════════

/**
 * Return structural problems with the manifest. Empty array means clean.
 * Called by scripts/verifyAgentRegistry.js in CI and at boot when
 * AGENT_ENABLED=true.
 */
function validateManifest(caps = CAPABILITIES) {
  const problems = [];
  const seen = new Set();
  for (const c of caps) {
    const at = `[${c.id || '<no-id>'}]`;
    if (!c.id || typeof c.id !== 'string') problems.push(`${at} missing id`);
    if (seen.has(c.id)) problems.push(`${at} duplicate id`);
    seen.add(c.id);
    if (!c.title)                            problems.push(`${at} missing title`);
    if (!c.describe)                         problems.push(`${at} missing describe`);
    if (!VALID_TIERS.has(c.tier))            problems.push(`${at} invalid tier ${c.tier}`);
    if (!VALID_SCOPES.has(c.scope))          problems.push(`${at} invalid scope ${c.scope}`);
    if (!c.execute)                          problems.push(`${at} missing execute block`);
    if (c.execute && !VALID_KINDS.has(c.execute.kind))
      problems.push(`${at} execute.kind='${c.execute.kind}' invalid (want one of ${[...VALID_KINDS].join(',')})`);
    if (c.execute?.kind === 'service' && (!c.execute.service || !c.execute.method))
      problems.push(`${at} execute service+method required`);
    if (c.args && c.args.type !== 'object')
      problems.push(`${at} args.type must be 'object' (got '${c.args.type}')`);
  }
  return problems;
}

module.exports = {
  CAPABILITIES,
  capabilitiesToTools,
  capabilityById,
  capabilityByToolName,
  applicableCapabilities,
  describeManifest,
  validateManifest,
  // exported for the verifier's precondition tests
  __test: { evalClause, describeClause, getPath }
};
