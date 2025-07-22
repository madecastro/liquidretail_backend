async function uploadToS3(file) {
  return `https://example-s3-bucket.com/${file.filename}`;
}

module.exports = { uploadToS3 };