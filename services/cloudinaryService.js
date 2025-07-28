const cloudinary = require('cloudinary').v2;
const path = require('path');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadBufferToCloudinary(file) {
  const result = await cloudinary.uploader.upload(file.path, {
    folder: 'liquidretail',
    use_filename: true,
    unique_filename: false,
    overwrite: false
  });

  return result.secure_url;
}

module.exports = { uploadBufferToCloudinary };