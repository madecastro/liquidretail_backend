// Executor for capability media.finalizeUpload (Tier 1, brand scope).
//
// Pairs with media.upload — after the frontend has POSTed the file
// directly to Cloudinary using the signed credential media.upload
// issued, the resulting secure_url comes back here to create the
// Media doc. Without this executor, media.upload is a dead-end that
// leaves the uploaded blob orphaned.
//
// SECURITY: the secureUrl must be under our own Cloudinary cloud name,
// otherwise the executor refuses. This prevents an operator (or a
// rogue LLM) from smuggling an arbitrary external URL into our Media
// collection under the guise of a "finalized upload."

'use strict';

const mongoose = require('mongoose');
const Brand = require('../../models/Brand');
const Media = require('../../models/Media');

const ALLOWED_FILE_TYPES = new Set(['image', 'video']);
const MAX_FILENAME_LEN = 300;

function isOurCloudinaryUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;
  // Cloudinary secure_url pattern:
  //   https://res.cloudinary.com/<cloud>/{image|video}/upload/[<transforms>/]v<version>/<path>.<ext>
  const prefix = `https://res.cloudinary.com/${cloudName}/`;
  return url.startsWith(prefix);
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }
  const secureUrl = String(args?.secureUrl || '').trim();
  if (!secureUrl) return { ok: false, error: 'secureUrl required' };
  if (!isOurCloudinaryUrl(secureUrl)) {
    return { ok: false, error: 'secureUrl must be a Cloudinary URL under this deployment\'s cloud (checked via CLOUDINARY_CLOUD_NAME env)' };
  }
  const fileType = args?.fileType || 'image';
  if (!ALLOWED_FILE_TYPES.has(fileType)) {
    return { ok: false, error: `fileType must be one of: ${[...ALLOWED_FILE_TYPES].join(', ')}` };
  }
  const fileName = args?.fileName != null ? String(args.fileName).trim() : null;
  if (fileName && fileName.length > MAX_FILENAME_LEN) {
    return { ok: false, error: `fileName too long (${fileName.length} > ${MAX_FILENAME_LEN} chars)` };
  }
  const metadata = args?.metadata;
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    return { ok: false, error: 'metadata must be a plain object or null' };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  // Synthetic externalId matches the manual_upload path used by
  // routes/detect.js POST /. Prevents (source, externalId) uniqueness
  // collisions when the same operator finalizes multiple uploads.
  const externalId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const media = await Media.create({
    advertiserId: req.advertiserId,
    brandId:      brand._id,
    externalId,
    source:       'manual_upload',
    sourceUrl:    null,
    fileType,
    fileUrl:      secureUrl,
    fileMimeType: null,
    fileName:     fileName || null,
    metadata:     metadata || {},
    classification: { socialPostType: 'manual_upload' }
  });

  return {
    ok: true,
    kind: 'mediaUpdate',
    data: {
      _id:       String(media._id),
      brandId:   String(brand._id),
      brandName: brand.name,
      fileUrl:   media.fileUrl,
      fileType:  media.fileType,
      fileName:  media.fileName,
      note: 'Media doc created from finalized upload. Run detect.process to kick off the detect pipeline; or reference this mediaId in a downstream capability directly.'
    }
  };
}

module.exports = { run };
