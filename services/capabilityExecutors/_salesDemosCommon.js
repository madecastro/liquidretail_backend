// Shared helper for Phase 10 sales-demos capabilities. All sales.*
// capabilities beyond bootstrap require the caller be scoped to the
// Sales Demos advertiser (matches routes/salesDemos.js:requireSales-
// DemosScope). This module centralizes the check so every executor
// stays consistent.

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const { ensureSalesDemosAdvertiser } = require('../salesDemosService');

async function requireSalesDemosScope(req) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const adv = await ensureSalesDemosAdvertiser();
  if (String(req.advertiserId) !== String(adv._id)) {
    return { ok: false, error: 'caller is not scoped to the Sales Demos advertiser — use sales.bootstrap to join first', code: 'NOT_IN_SCOPE' };
  }
  return { ok: true, salesAdvertiserId: adv._id };
}

async function findDemoBrand({ req, args, select }) {
  const scope = await requireSalesDemosScope(req);
  if (!scope.ok) return scope;
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const q = Brand.findOne({
    _id: rawBrandId,
    advertiserId: scope.salesAdvertiserId,
    isDemo: true
  });
  if (select) q.select(select);
  const brand = await q;
  if (!brand) return { ok: false, error: 'demo brand not found' };
  return { ok: true, brand };
}

module.exports = { requireSalesDemosScope, findDemoBrand };
