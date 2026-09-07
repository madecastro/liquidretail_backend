const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { concurrency: CONC } = require('./concurrency');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

let _counter = 0;
function _uniqueId() {
  // 8 chars of base36 random + monotonic counter → effectively zero collision risk
  const rand = Math.random().toString(36).slice(2, 10);
  return `product-${Date.now()}-${++_counter}-${rand}`;
}

function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const uploadOpts = {
      folder: opts.folder || 'liquidretail',
      public_id: _uniqueId(),
      unique_filename: false,
      // overwrite=true so re-renders of the same (campaignId, identityDigest)
      // can replace the existing asset without orphaning. Caller-side de-dupe
      // (queue-time unique index) usually short-circuits before we get here.
      overwrite: opts.overwrite ?? false,
      resource_type: opts.resourceType || 'image',
      ...(opts.publicId ? { public_id: opts.publicId } : {}),
      // Eager transformations — Cloudinary starts pre-generating these
      // derivatives the moment the upload lands instead of lazily on first
      // request. Critical for the composite path: the chrome compositor
      // hits a c_fill,ar_<canvas>,g_auto transform URL immediately after
      // upload, and without an eager hint the lazy transcode is still
      // running, returning 423 Locked. Eager + eager_async (default true
      // for video) gives the transcode a head start without blocking the
      // upload response.
      ...(Array.isArray(opts.eager) && opts.eager.length
        ? { eager: opts.eager, eager_async: opts.eagerAsync !== false }
        : {})
    };
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// Path-based sibling of uploadBufferToCloudinary — same options, same return
// shape, but streams straight from disk with fs.createReadStream instead of
// reading the whole file into a Buffer first. Added for already-rendered
// video masters (brandScriptExecutor's uploadRenderAndStamp): those files can
// be tens/hundreds of MB, and the buffer variant's path was
// disk -> full Buffer in RAM -> streamifier re-wraps it -> network, which
// double-holds the file in memory (fs read buffer + Buffer object) for no
// benefit since upload_stream only ever wants a Readable. Use this whenever
// the source is already a file on disk; keep uploadBufferToCloudinary for
// callers that only have bytes in memory (multer buffers, sharp output, etc).
function uploadFileToCloudinary(filePath, opts = {}) {
  return new Promise((resolve, reject) => {
    const uploadOpts = {
      folder: opts.folder || 'liquidretail',
      public_id: _uniqueId(),
      unique_filename: false,
      // overwrite=true so re-renders of the same (campaignId, identityDigest)
      // can replace the existing asset without orphaning. Caller-side de-dupe
      // (queue-time unique index) usually short-circuits before we get here.
      overwrite: opts.overwrite ?? false,
      resource_type: opts.resourceType || 'image',
      ...(opts.publicId ? { public_id: opts.publicId } : {}),
      // Eager transformations — Cloudinary starts pre-generating these
      // derivatives the moment the upload lands instead of lazily on first
      // request. Critical for the composite path: the chrome compositor
      // hits a c_fill,ar_<canvas>,g_auto transform URL immediately after
      // upload, and without an eager hint the lazy transcode is still
      // running, returning 423 Locked. Eager + eager_async (default true
      // for video) gives the transcode a head start without blocking the
      // upload response.
      ...(Array.isArray(opts.eager) && opts.eager.length
        ? { eager: opts.eager, eager_async: opts.eagerAsync !== false }
        : {})
    };
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    // Forward read errors (e.g. ENOENT if the caller's tempDir was already
    // cleaned up) to the promise — an unhandled 'error' on a Readable throws
    // and would crash the process instead of rejecting like the buffer
    // variant's readFile-then-upload call site did.
    fs.createReadStream(filePath).on('error', reject).pipe(stream);
  });
}

// Mirror a remote URL into Cloudinary. Used by the IG post sync — Meta's
// CDN URLs expire after a few hours, so we hand the URL to Cloudinary's
// fetch loader to land a permanent copy. Returns the upload result.
function uploadUrlToCloudinary(remoteUrl, opts = {}) {
  return cloudinary.uploader.upload(remoteUrl, {
    folder: 'liquidretail',
    public_id: _uniqueId(),
    unique_filename: false,
    overwrite: false,
    resource_type: opts.resourceType || 'image',
    ...(opts.folder    ? { folder: opts.folder } : {}),
    ...(opts.publicId  ? { public_id: opts.publicId } : {})
  });
}

// Extract the Cloudinary public_id from a secure_url. URL format:
//   https://res.cloudinary.com/<cloud>/<resource_type>/upload/[<transforms>/]v<version>/<folder>/<public_id>.<ext>
// Returns the path segment after `/upload/[v<version>/]` minus the
// trailing extension. null if the URL doesn't match the pattern.
function publicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+(?:\?.*)?$/i);
  return m ? m[1] : null;
}

// Delete a single Cloudinary asset by its secure_url. Determines
// resource_type heuristically — videos are .mp4/.mov/.webm/etc.
// Returns the destroy() result or { result: 'skipped' } when the URL
// doesn't parse. Errors are caught + returned, never thrown — callers
// run this in cleanup loops where one bad URL shouldn't abort the
// whole cascade.
async function deleteFromCloudinary(url) {
  const publicId = publicIdFromUrl(url);
  if (!publicId) return { result: 'skipped', reason: 'unparseable url', url };
  const resourceType = /\.(mp4|mov|webm|m4v|mkv)(\?|$)/i.test(url) ? 'video' : 'image';
  try {
    const out = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
    return { ...out, publicId, resourceType };
  } catch (err) {
    return { result: 'error', error: err.message, publicId, resourceType };
  }
}

// Sibling of deleteFromCloudinary when the caller already holds a
// public_id (Ad.cloudinaryPublicId) and the URL failed to parse.
// Same never-throw contract.
async function deletePublicIdFromCloudinary(publicId, { resourceType = 'image' } = {}) {
  if (!publicId || typeof publicId !== 'string') {
    return { result: 'skipped', reason: 'no public_id' };
  }
  try {
    const out = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
    return { ...out, publicId, resourceType };
  } catch (err) {
    return { result: 'error', error: err.message, publicId, resourceType };
  }
}

// Bulk delete with a small concurrency limiter. Cloudinary's free
// tier rate-limits at 500 ops/hr; keep concurrency modest so cascade
// deletes for big brands don't trip it. Override via CLOUDINARY_DELETE_CONCURRENCY.
async function deleteManyFromCloudinary(urls, { concurrency = CONC.CLOUDINARY_DELETE_CONCURRENCY } = {}) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      out[idx] = await deleteFromCloudinary(urls[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

module.exports = {
  uploadBufferToCloudinary,
  uploadFileToCloudinary,
  uploadUrlToCloudinary,
  deleteFromCloudinary,
  deletePublicIdFromCloudinary,
  deleteManyFromCloudinary,
  publicIdFromUrl
};
