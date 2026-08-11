// Executor for capability media.upload (Tier 1, brand scope).
//
// Returns a signed Cloudinary direct-upload payload the frontend uses
// to POST a file straight to Cloudinary without proxying through this
// server. The chat drawer renders an <UploadCard> with the returned
// endpoint + signature; on completion the frontend POSTs the resulting
// secure_url back through the existing upload/media finalization
// route.
//
// The signature is short-lived (default 10 min) and scoped to a
// per-brand folder so a leaked payload can't upload into another
// tenant's assets. The advertiserId gate is upstream (auth middleware);
// the folder path bakes brandId in as belt-and-braces.

'use strict';

const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const Brand = require('../../models/Brand');

const DEFAULT_TTL_SEC = 600;                          // 10 min
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;        // matches routes/upload multer cap

const ALLOWED_RESOURCE_TYPES = new Set(['image', 'video']);

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const resourceType = args?.resourceType || 'image';
  if (!ALLOWED_RESOURCE_TYPES.has(resourceType)) {
    return { ok: false, error: `resourceType must be one of: ${[...ALLOWED_RESOURCE_TYPES].join(', ')}` };
  }
  const ttlSec = Number.isFinite(args?.ttlSec) ? Math.max(60, Math.min(args.ttlSec, 3600)) : DEFAULT_TTL_SEC;

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return { ok: false, error: 'Cloudinary credentials not configured on this instance — check CLOUDINARY_* env vars' };
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = `agent-uploads/${String(req.advertiserId)}/${String(brand._id)}`;
  const paramsToSign = { timestamp, folder };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

  return {
    ok: true,
    kind: 'uploadDirective',
    data: {
      endpoint: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
      method: 'POST',
      formFields: {
        api_key:   apiKey,
        timestamp: String(timestamp),
        folder,
        signature
      },
      constraints: {
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        resourceType,
        allowedMimeTypesHint: resourceType === 'image'
          ? ['image/jpeg', 'image/png', 'image/webp']
          : ['video/mp4', 'video/quicktime', 'video/webm']
      },
      expiresAt: new Date((timestamp + ttlSec) * 1000),
      brand: { _id: String(brand._id), name: brand.name },
      note: 'Frontend POSTs the file directly to endpoint with formFields as multipart/form-data. On success, POST the returned secure_url back to /api/media (finalization endpoint) to create the Media row. This capability does not create a Media doc — it only issues the upload credential.'
    }
  };
}

module.exports = { run };
