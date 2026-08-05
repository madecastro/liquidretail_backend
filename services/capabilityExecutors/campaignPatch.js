// Executor for capability campaign.patch (Tier 1, campaign scope).
//
// Edits reach-social campaign fields. Refuses synced campaigns
// (meta-ads / google-ads) because their state mirrors the platform.
// Returns the prior values so the operator can revert.

'use strict';

const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign');

const VALID_KINDS = new Set(['brand', 'product', 'promotional', 'collection', null]);

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawId = args?.campaignId;
  if (!rawId) return { ok: false, error: 'campaignId required' };
  if (!mongoose.isValidObjectId(rawId)) {
    return { ok: false, error: `campaignId "${rawId}" is not a valid ObjectId` };
  }

  const c = await Campaign.findOne({ _id: rawId, advertiserId: req.advertiserId });
  if (!c) return { ok: false, error: `campaign ${rawId} not found` };
  if (c.platform !== 'reach-social') {
    return { ok: false, error: 'only reach-social campaigns are editable via the agent' };
  }

  const changed = {};
  const prior = {};

  if (args?.name != null) {
    const trimmed = String(args.name).trim();
    if (!trimmed) return { ok: false, error: 'name cannot be empty' };
    if (trimmed.length > 200) return { ok: false, error: `name too long (${trimmed.length} > 200 chars)` };
    if (trimmed !== c.name) {
      prior.name = c.name;
      changed.name = trimmed;
      c.name = trimmed;
    }
  }

  if (args?.campaignKind !== undefined) {
    const k = args.campaignKind === null ? null : String(args.campaignKind);
    if (!VALID_KINDS.has(k)) {
      return { ok: false, error: `campaignKind must be one of ${[...VALID_KINDS].map((v) => String(v)).join(', ')}` };
    }
    if (k !== c.kind) {
      prior.campaignKind = c.kind;
      changed.campaignKind = k;
      c.kind = k;
    }
  }

  if (args?.useImageRefAsProduction !== undefined) {
    const next = !!args.useImageRefAsProduction;
    if (next !== !!c.useImageRefAsProduction) {
      prior.useImageRefAsProduction = !!c.useImageRefAsProduction;
      changed.useImageRefAsProduction = next;
      c.useImageRefAsProduction = next;
    }
  }

  if (args?.promotionalDetails !== undefined) {
    if (args.promotionalDetails === null) {
      prior.promotionalDetails = c.promotionalDetails || null;
      changed.promotionalDetails = null;
      c.promotionalDetails = null;
    } else if (typeof args.promotionalDetails === 'object') {
      const merged = { ...(c.promotionalDetails || {}), ...args.promotionalDetails };
      if (merged.startsAt) merged.startsAt = new Date(merged.startsAt);
      if (merged.endsAt)   merged.endsAt   = new Date(merged.endsAt);
      if (merged.raffleDrawDate) merged.raffleDrawDate = new Date(merged.raffleDrawDate);
      prior.promotionalDetails = c.promotionalDetails || null;
      changed.promotionalDetails = merged;
      c.promotionalDetails = merged;
      c.markModified('promotionalDetails');
    } else {
      return { ok: false, error: 'promotionalDetails must be object or null' };
    }
  }

  if (Object.keys(changed).length === 0) {
    return {
      ok: true,
      kind: 'campaignUpdate',
      data: { _id: String(c._id), name: c.name, noop: true, note: 'no changes to apply' }
    };
  }

  await c.save();

  return {
    ok: true,
    kind: 'campaignUpdate',
    data: {
      _id: String(c._id),
      name: c.name,
      campaignKind: c.kind,
      useImageRefAsProduction: !!c.useImageRefAsProduction,
      changed,
      prior
    }
  };
}

module.exports = { run };
