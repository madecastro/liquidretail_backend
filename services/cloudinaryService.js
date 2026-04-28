const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

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
      folder: 'liquidretail',
      public_id: _uniqueId(),
      unique_filename: false,
      overwrite: false,
      resource_type: opts.resourceType || 'image',
      ...(opts.publicId ? { public_id: opts.publicId } : {})
    };
    const stream = cloudinary.uploader.upload_stream(uploadOpts, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    streamifier.createReadStream(buffer).pipe(stream);
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

module.exports = { uploadBufferToCloudinary, uploadUrlToCloudinary };
