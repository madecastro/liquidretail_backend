const express = require('express');
const multer = require('multer');
const router = express.Router();
const Job = require('../models/Job');
const Brand = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const { tenantFilter } = require('../middleware/tenantHelpers');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
const MAX_SIZE_MB = 100;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 }
});

router.post('/', upload.single('photo'), async (req, res) => {
  try {
    const { buffer, mimetype } = req.file;
    const fileType = VIDEO_TYPES.includes(mimetype) ? 'video' : 'image';
    const metadata = req.body;

    const job = new Job({
      fileBuffer: buffer,
      fileType,
      status: 'queued',
      metadata: {
        truck_number: metadata.truck_number,
        price: metadata.price,
        delivery_date: metadata.delivery_date,
        delivery_time: metadata.delivery_time,
        delivery_location: metadata.delivery_location
      }
    });

    await job.save();
    console.log(`🆕 Job queued: ${job._id} (${fileType})`);
    res.status(202).json({ jobId: job._id, fileType });
  } catch (err) {
    console.error('❌ Failed to queue upload:', err);
    res.status(500).json({ error: 'Upload failed', message: err.message });
  }
});

// ── Upload-3: manual product upload ──────────────────────────────────
// POST /api/upload/product
//
// Multipart fields:
//   image       — file (required)
//   title       — string (required)
//   price       — number, optional
//   currency    — 3-letter ISO, optional (USD / EUR / etc.)
//   productUrl  — http(s) URL, optional
//   gtin        — UPC/EAN barcode, optional
//   mpn         — manufacturer part number, optional
//   category    — free text, optional
//   description — free text, optional
//
// Creates a CatalogProduct row with source='manual-upload' under the
// active brand. draft=true unless BOTH price AND productUrl are
// provided — drafts surface in the catalog browser's drafts queue
// for the user to complete before they're matchable.
//
// Idempotent on (brandId, externalId) where externalId is
// `manual:<title-slug>` — re-uploading the same title under the same
// brand updates the existing row instead of creating duplicates.
router.post('/product', upload.single('image'), async (req, res) => {
  try {
    const brandId = req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'X-Brand-Id header required' });
    if (!req.file)  return res.status(400).json({ error: 'image file required' });

    // Tenant guard via brand lookup.
    const brand = await Brand.findOne(tenantFilter(req, { _id: brandId })).select('name').lean();
    if (!brand) return res.status(404).json({ error: 'brand not found' });

    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });

    // Optional numeric / URL / code validation.
    let price = null;
    if (req.body.price != null && req.body.price !== '') {
      const p = Number(req.body.price);
      if (!Number.isFinite(p) || p < 0) {
        return res.status(400).json({ error: 'price must be a non-negative number' });
      }
      price = p;
    }
    const currencyRaw = String(req.body.currency || '').toUpperCase().trim();
    if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) {
      return res.status(400).json({ error: 'currency must be 3-letter ISO code (USD, EUR, ...)' });
    }
    const currency = currencyRaw || null;

    const productUrl = String(req.body.productUrl || '').trim() || null;
    if (productUrl && !/^https?:\/\//.test(productUrl)) {
      return res.status(400).json({ error: 'productUrl must be http or https' });
    }

    const gtin = normalizeGtin(req.body.gtin);
    const mpn         = (String(req.body.mpn || '').trim()) || null;
    const category    = (String(req.body.category || '').trim()) || null;
    const description = (String(req.body.description || '').trim()) || null;

    const slug = slugify(title);
    if (!slug) return res.status(400).json({ error: 'title produces empty slug' });
    const externalId = `manual:${slug}`;

    // Upload to Cloudinary first — if this fails, we don't write a
    // CatalogProduct row that points at nothing.
    let uploaded;
    try {
      uploaded = await uploadBufferToCloudinary(req.file.buffer, {
        resourceType: 'image',
        folder:       'brand_products'
      });
    } catch (err) {
      return res.status(500).json({ error: `image upload failed: ${err.message}` });
    }

    // draft=true unless the row has the minimum to be a usable product:
    // price AND productUrl. Either missing → user finishes via the
    // drafts UI later (Upload-5).
    const draft = !(price != null && productUrl);

    let result;
    try {
      result = await CatalogProduct.findOneAndUpdate(
        { brandId, externalId },
        {
          $set: {
            title, description, category,
            brand:        brand.name || null,
            price, currency,
            availability: price != null ? 'in stock' : null,
            imageUrl:     uploaded.secure_url,
            productUrl,
            gtin, mpn,
            draft,
            lastSyncedAt: new Date()
          },
          $setOnInsert: {
            advertiserId: req.advertiserId,
            brandId,
            source:       'manual-upload',
            externalId,
            firstSeenAt:  new Date()
          }
        },
        { upsert: true, new: true, rawResult: true }
      );
    } catch (err) {
      return res.status(500).json({ error: `CatalogProduct upsert failed: ${err.message}` });
    }

    const product = result.value;
    const isNew   = !result.lastErrorObject?.updatedExisting;
    console.log(`📦 manual product ${isNew ? 'created' : 'updated'}: brand=${brand.name} title="${title}" draft=${draft}`);

    res.status(isNew ? 201 : 200).json({
      ok:      true,
      created: isNew,
      product: serializeProduct(product)
    });
  } catch (err) {
    console.error('manual product upload failed:', err);
    res.status(500).json({ error: err.message || 'manual product upload failed' });
  }
});

function serializeProduct(p) {
  return {
    id:           String(p._id),
    _id:          String(p._id),
    externalId:   p.externalId,
    source:       p.source,
    draft:        !!p.draft,
    title:        p.title,
    description:  p.description || null,
    category:     p.category || null,
    brand:        p.brand || null,
    price:        p.price ?? null,
    currency:     p.currency || null,
    availability: p.availability || null,
    imageUrl:     p.imageUrl || null,
    productUrl:   p.productUrl || null,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,
    lastSyncedAt: p.lastSyncedAt || null
  };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// 8/12/13/14-digit GTINs only; reject junk.
function normalizeGtin(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/[^\d]/g, '');
  if (![8, 12, 13, 14].includes(cleaned.length)) return null;
  return cleaned;
}

module.exports = router;
