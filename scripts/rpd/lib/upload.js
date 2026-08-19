// scripts/rpd/lib/upload.js — mirror settled RPD cell files to Cloudinary.
//
// Upload failure must NEVER un-settle a cell: this helper never throws.
// Requires CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET; absent config is
// a soft {ok:false}, not an exception.

const path = require('path');

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function resolveCellPath(runDir, rel) {
  if (!rel || typeof rel !== 'string') return null;
  return path.isAbsolute(rel) ? rel : path.join(runDir, rel);
}

function resourceTypeFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp4' ? 'video' : 'image';
}

async function uploadCellOutputs(runDir, cell, runName) {
  const errors = [];
  if (!cloudinaryConfigured()) {
    return { ok: false, errors: ['CLOUDINARY_* not configured'] };
  }
  try {
    const { uploadFileToCloudinary } = require('../../../services/cloudinaryService');
    const folder = `liquidretail/rpd/${String(runName || 'untitled')}`;

    async function put(rel, label) {
      const abs = resolveCellPath(runDir, rel);
      if (!abs) {
        errors.push(`rpd: missing ${label}`);
        return null;
      }
      try {
        const result = await uploadFileToCloudinary(abs, {
          folder,
          resourceType: resourceTypeFor(abs)
        });
        const url = result && result.secure_url;
        if (!url) {
          errors.push(`rpd: ${label} upload returned no secure_url`);
          return null;
        }
        return url;
      } catch (err) {
        errors.push(`rpd: ${label} upload failed: ${err.message || err}`);
        return null;
      }
    }

    if (cell.localPath) {
      const url = await put(cell.localPath, 'localPath');
      if (url) cell.uploadedUrl = url;
    } else {
      errors.push('rpd: cell.localPath is required');
    }

    if (cell.titledPath) {
      const url = await put(cell.titledPath, 'titledPath');
      if (url) cell.titledUploadedUrl = url;
    }

    return { ok: errors.length === 0, errors };
  } catch (err) {
    errors.push(`rpd: uploadCellOutputs: ${err.message || err}`);
    return { ok: false, errors };
  }
}


// Mirror the MANIFEST itself, not just the media. On an ephemeral host the run
// directory dies with the job, and the manifest IS the spend ledger — losing it
// means the settled prices and receipts are unrecoverable even though the media
// survived. Cloudinary takes non-media via resourceType 'raw'.
async function uploadManifest(runDir, runName) {
  if (!cloudinaryConfigured()) return { ok: false, errors: ['CLOUDINARY_* not configured'] };
  try {
    const { uploadFileToCloudinary } = require('../../../services/cloudinaryService');
    const abs = path.join(runDir, 'manifest.json');
    const result = await uploadFileToCloudinary(abs, {
      folder: `liquidretail/rpd/${String(runName || 'untitled')}`,
      resourceType: 'raw',
      publicId: 'manifest.json',
      overwrite: true   // the ledger is rewritten as cells settle; keep one current copy
    });
    const url = result && result.secure_url;
    return url ? { ok: true, url } : { ok: false, errors: ['no secure_url'] };
  } catch (err) {
    return { ok: false, errors: [`manifest upload failed: ${err.message || err}`] };
  }
}

module.exports = { uploadCellOutputs, uploadManifest };
