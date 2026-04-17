const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const uploadOpts = {
      folder: 'liquidretail',
      public_id: `product-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
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

module.exports = { uploadBufferToCloudinary };
