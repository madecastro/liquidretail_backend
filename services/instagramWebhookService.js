// Meta webhook event handler. Meta posts JSON event payloads to our
// receiver when a subscribed Page/IG account publishes media or
// receives comments. We:
//   1. Verify the HMAC signature in the request header.
//   2. Parse the entry list — each entry corresponds to one IG
//      Business account (entry.id === igUserId).
//   3. Look up the matching active IntegrationCredential.
//   4. For `media` field events, fetch the post details from Graph
//      API and ingest via postSyncService.ingestPost — same code
//      path that the manual + scheduled syncs use.
//
// Comments handling (V3 #3) goes through the same dispatcher but is
// not wired yet.

const crypto = require('crypto');
const axios = require('axios');

const Brand = require('../models/Brand');
const IntegrationCredential = require('../models/IntegrationCredential');
const Media = require('../models/Media');
const { decrypt } = require('./integrationCryptoService');
const { ingestPost, capRemaining } = require('./postSyncService');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;
const POST_FIELDS = [
  'id', 'media_type', 'media_url', 'thumbnail_url', 'permalink',
  'caption', 'timestamp', 'username'
].join(',');

// Verify the X-Hub-Signature-256 header against the raw body using the
// Meta app secret as the HMAC key. Constant-time comparison so timing
// attacks can't tease out the secret.
function verifySignature(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret)        return false;
  if (!signatureHeader)  return false;
  if (!rawBody)          return false;

  // Header format: "sha256=<hex>"
  const m = String(signatureHeader).match(/^sha256=([0-9a-f]+)$/i);
  if (!m) return false;
  const sigHex = m[1];

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  // Both must be the same length for timingSafeEqual.
  if (expected.length !== sigHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sigHex, 'hex'));
  } catch (_) {
    return false;
  }
}

// Top-level dispatcher. Iterates entries, looks up the credential for
// each, dispatches the field events. Errors per-entry don't abort the
// rest — Meta retries failed deliveries based on the overall response,
// but we want partial success when possible.
async function processWebhookPayload(payload) {
  if (!payload || payload.object !== 'instagram') {
    return { ok: true, ignored: 'not an instagram object' };
  }
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const results = [];

  for (const entry of entries) {
    const igUserId = String(entry.id || '').trim();
    if (!igUserId) {
      results.push({ ok: false, reason: 'entry missing id' });
      continue;
    }
    // Find the active credential whose IG user matches this entry.
    const cred = await IntegrationCredential.findOne({
      type: 'instagram', status: 'active', igUserId
    });
    if (!cred) {
      results.push({ ok: false, igUserId, reason: 'no active credential matches igUserId' });
      continue;
    }

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      try {
        const result = await dispatchChange({ cred, change });
        results.push({ ok: true, igUserId, field: change.field, ...result });
      } catch (err) {
        console.warn(`   ⚠️  IG webhook change failed for igUser=${igUserId}: ${err.message}`);
        results.push({ ok: false, igUserId, field: change.field, reason: err.message });
      }
    }
  }
  return { ok: true, processed: results };
}

async function dispatchChange({ cred, change }) {
  const field = change?.field;
  if (field === 'media') {
    return await handleMediaChange({ cred, value: change.value || {} });
  }
  // V3 #3 hook will live here for `comments`.
  return { skipped: `field "${field}" not handled` };
}

// New post / story published. Meta sends `value.media_id`; we fetch the
// full post details via Graph API and pipe through ingestPost. This
// mirrors the polled-sync code path so behavior is identical: idempotent
// on (source, externalId), Cloudinary mirror, DetectRun queued.
async function handleMediaChange({ cred, value }) {
  const mediaId = String(value?.media_id || '').trim();
  if (!mediaId) return { skipped: 'no media_id in payload' };

  // Idempotency short-circuit — already ingested?
  const existing = await Media.findOne({ source: 'instagram', externalId: mediaId }).select('_id').lean();
  if (existing) return { skipped: 'already ingested', mediaId };

  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (err) { throw new Error(`token decrypt failed: ${err.message}`); }

  // Fetch post details directly via Graph API.
  const res = await axios.get(`${META_GRAPH_ROOT}/${mediaId}`, {
    params: { fields: POST_FIELDS, access_token: token },
    timeout: 15000
  });
  const post = res.data;
  if (!post?.id) throw new Error('Graph API returned no post body');

  // Brand context for metadata block.
  const brand = await Brand.findById(cred.brandId).select('name websiteUrl syncSettings').lean();
  const brandName = brand?.name || null;
  const brandUrl  = brand?.websiteUrl || null;

  // Cap-aware enqueue. Brand.syncSettings.dailyDetectRunCap throttles
  // webhook-triggered runs the same way scheduled sync is throttled —
  // a chatty brand can't blow through compute via real-time delivery.
  const cap = brand?.syncSettings?.dailyDetectRunCap;
  let enqueueRun = true;
  if (cap != null) {
    const remaining = await capRemaining(cred.advertiserId, cap);
    enqueueRun = remaining > 0;
    if (!enqueueRun) {
      console.log(`   · IG webhook: cap reached for advertiser=${cred.advertiserId}, deferring DetectRun for media ${mediaId}`);
    }
  }

  const ingested = await ingestPost({
    post,
    cred,
    brandName,
    brandUrl,
    token,
    enqueueRun,
    trigger: 'webhook'
  });
  return { mediaId, ...(ingested || {}) };
}

module.exports = { verifySignature, processWebhookPayload };
