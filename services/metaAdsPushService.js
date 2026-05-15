// Meta Marketing API → Ad publish (Phase D push-back).
//
// Three Graph calls per Ad: upload image → create AdCreative → create
// Ad as PAUSED inside an existing AdSet. Operator-driven (no auto-
// publish loop) and always lands paused so a misclicked push can't
// burn budget — operator activates from Meta Ads Manager.
//
// pushAdsBatch fans out N rows with a small concurrency cap so a
// 50-ad push doesn't hammer Meta's rate limit. Each per-ad failure is
// captured in metaSyncStatus='failed' + metaSyncError; the batch
// always returns a per-ad result list rather than throwing.
//
// Page id resolution: AdCreative.object_story_spec.page_id is the
// Page the ad "runs from". Pulled off the brand's connected
// Instagram credential (IG ad accounts always link a Page); errors
// out with a clear message if the brand has no IG cred yet.

const axios = require('axios');

const Ad                    = require('../models/Ad');
const Campaign              = require('../models/Campaign');
const IntegrationCredential = require('../models/IntegrationCredential');
const { decrypt }           = require('./integrationCryptoService');

const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_GRAPH_ROOT  = `https://graph.facebook.com/${META_API_VERSION}`;

// Per-batch concurrency cap. Meta's per-app rate limit is generous
// (200 calls/hr/user) but ad-account-level write throttling kicks in
// faster. 3 in-flight is conservative; bump if a brand's batches feel
// slow once we have telemetry.
const PUSH_CONCURRENCY = 3;

// Video processing — Meta's /advideos is async. Upload returns
// immediately with a video_id, but the video isn't usable in an
// AdCreative until status.video_status === 'ready'. Real-world
// processing takes 30s–3min; we cap at 5min so a stuck video doesn't
// hold a worker indefinitely. The poll backs off from 4s to 10s so
// we don't spam Graph for short videos while still being responsive.
const VIDEO_POLL_INITIAL_MS  = 4000;
const VIDEO_POLL_MAX_MS      = 10000;
const VIDEO_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

// Operator's freeform CTA text → Meta's call_to_action enum. Falls
// through to SHOP_NOW (the most common e-commerce CTA) when nothing
// matches. Keyword bands are tested in order — "shop now" hits SHOP_NOW
// before "now" hits ORDER_NOW. New patterns get appended; never
// reordered without checking the test cases.
const CTA_PATTERNS = [
  { re: /\b(buy|purchase|order)\b/i,                        type: 'ORDER_NOW' },
  { re: /\b(shop|browse|view\s+products?)\b/i,              type: 'SHOP_NOW' },
  { re: /\b(get|claim)\s+(offer|deal|discount|coupon)\b/i,  type: 'GET_OFFER' },
  { re: /\b(save|deal|discount|off|sale|promo)\b/i,         type: 'GET_OFFER' },
  { re: /\b(sign\s*up|register|join|create\s+account)\b/i,  type: 'SIGN_UP' },
  { re: /\b(subscribe|subscription)\b/i,                    type: 'SUBSCRIBE' },
  { re: /\b(download|install|get\s+the\s+app)\b/i,          type: 'DOWNLOAD' },
  { re: /\b(book|reserve|schedule)\b/i,                     type: 'BOOK_TRAVEL' },
  { re: /\b(contact|message|talk\s+to\s+us)\b/i,            type: 'CONTACT_US' },
  { re: /\b(learn|discover|explore|see\s+more|find\s+out)\b/i, type: 'LEARN_MORE' }
];
function mapCtaTextToEnum(text) {
  if (!text || typeof text !== 'string') return 'SHOP_NOW';
  for (const { re, type } of CTA_PATTERNS) if (re.test(text)) return type;
  return 'SHOP_NOW';
}

// Resolve the brand's connected Page id. Required for object_story_spec
// on every AdCreative. Pulled off the IG IntegrationCredential since
// Meta Ads uses the same Business-Manager-linked Page. Errors out
// clearly when the brand hasn't connected IG yet — without a Page,
// the ad can't be published.
async function resolveBrandPageId(brandId) {
  const igCred = await IntegrationCredential.findOne({
    brandId, type: 'instagram', status: 'active'
  }).select('pageId pageName').lean();
  if (!igCred?.pageId) {
    const err = new Error('Brand has no connected Facebook Page (connect Instagram first).');
    err.code = 'no-page';
    throw err;
  }
  return { pageId: igCred.pageId, pageName: igCred.pageName || null };
}

// Resolve the active Meta Ads credential for the brand. Carries the
// access token + the ad account id used as the URL prefix on every
// write call.
async function resolveMetaAdsCred(brandId) {
  const cred = await IntegrationCredential.findOne({
    brandId, type: 'meta-ads', status: 'active'
  }).select('accessTokenEnc platformData');
  if (!cred) {
    const err = new Error('Brand has no active Meta Ads credential. Connect Meta Ads first.');
    err.code = 'no-meta-ads-cred';
    throw err;
  }
  if (!cred.platformData?.adAccountId) {
    const err = new Error('Meta Ads credential missing adAccountId — re-finalize via the picker.');
    err.code = 'no-ad-account';
    throw err;
  }
  let token;
  try { token = decrypt(cred.accessTokenEnc); }
  catch (e) { const err = new Error(`token decrypt failed: ${e.message}`); err.code = 'decrypt'; throw err; }
  return { cred, token, adAccountId: cred.platformData.adAccountId };
}

// Upload an image to the ad account's image library. Meta accepts
// either base64 bytes or a URL; we use URL since our renderer's
// output already lives on Cloudinary. Returns the image_hash needed
// to reference the image inside the AdCreative.
async function uploadImageToMeta({ adAccountId, token, imageUrl }) {
  const res = await axios.post(
    `${META_GRAPH_ROOT}/${adAccountId}/adimages`,
    null,
    {
      params: { url: imageUrl, access_token: token },
      timeout: 30000
    }
  );
  // Meta returns { images: { '<filename>': { hash, url } } }. Filename
  // is internal — we just need the hash from the first (only) entry.
  const images = res.data?.images || {};
  const firstKey = Object.keys(images)[0];
  const hash = firstKey ? images[firstKey].hash : null;
  if (!hash) throw new Error('Meta /adimages returned no hash');
  return hash;
}

// Upload a video to the ad account's video library. Meta processes
// it asynchronously — this call returns a video_id immediately, but
// the AdCreative can't reference the video until its status flips to
// 'ready'. Caller follows up with waitForVideoReady().
async function uploadVideoToMeta({ adAccountId, token, videoUrl }) {
  const res = await axios.post(
    `${META_GRAPH_ROOT}/${adAccountId}/advideos`,
    null,
    {
      params: { file_url: videoUrl, access_token: token },
      timeout: 60000   // generous — Meta sometimes holds the request
                      // open while it does an initial fetch from our URL
    }
  );
  if (!res.data?.id) throw new Error('Meta /advideos returned no id');
  return res.data.id;
}

// Poll the video's status field until it reads 'ready'. Backs off
// from 4s → 10s so quick videos aren't penalized by a slow first
// poll while long videos don't hammer Graph. Errors out on Meta-
// reported processing failures or the 5-minute wall clock.
async function waitForVideoReady({ videoId, token }) {
  const startedAt = Date.now();
  let waitMs = VIDEO_POLL_INITIAL_MS;
  while (Date.now() - startedAt < VIDEO_PROCESSING_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, waitMs));
    waitMs = Math.min(VIDEO_POLL_MAX_MS, Math.round(waitMs * 1.5));
    let res;
    try {
      res = await axios.get(
        `${META_GRAPH_ROOT}/${videoId}`,
        {
          params: { fields: 'status', access_token: token },
          timeout: 15000
        }
      );
    } catch (err) {
      // Transient — keep polling. Meta occasionally 5xxs during
      // processing windows; a few retries are cheaper than failing
      // the whole push.
      console.warn(`   ⚠️  video ${videoId} status poll glitched: ${err.message}`);
      continue;
    }
    const phase = res.data?.status?.video_status;   // 'ready' | 'processing' | 'error'
    if (phase === 'ready') return true;
    if (phase === 'error') {
      const detail = res.data?.status?.processing_phase || 'unknown processing error';
      throw new Error(`Meta rejected video ${videoId}: ${detail}`);
    }
    // 'processing' — keep waiting.
  }
  throw new Error(`Meta video ${videoId} did not finish processing within ${VIDEO_PROCESSING_TIMEOUT_MS / 1000}s`);
}

// Create an AdCreative referencing the uploaded image. Headline and
// body come from the Ad's render-time copy snapshot; landing URL is
// the operator-supplied CTA URL with tracking params appended.
async function createAdCreative({ adAccountId, token, ad, imageHash, pageId }) {
  const ctaText = ad.ctaText || 'Shop now';
  const ctaUrl = composeCtaUrl(ad.ctaUrl, ad.ctaUrlParams);
  const message  = ad.copy?.headline || ad.copy?.quote || ad.copy?.productName || '';
  const headline = ad.copy?.productName || ad.copy?.headline || '';
  const body = {
    name: `${ad.template} ${ad.aspectRatio} ${String(ad._id).slice(-8)}`,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        image_hash: imageHash,
        link:       ctaUrl || 'https://example.com',
        message,
        name:       headline,
        call_to_action: {
          type:  mapCtaTextToEnum(ctaText),
          value: { link: ctaUrl || 'https://example.com' }
        }
      }
    }
  };
  const res = await axios.post(
    `${META_GRAPH_ROOT}/${adAccountId}/adcreatives`,
    body,
    { params: { access_token: token }, timeout: 30000 }
  );
  if (!res.data?.id) throw new Error('Meta /adcreatives returned no id');
  return res.data.id;
}

// Video AdCreative — uses video_data instead of link_data and
// requires a poster (image_url) so Ads Manager has a still to show
// in the gallery. ad.posterUrl comes from renderService when the
// video composite was built.
async function createAdCreativeForVideo({ adAccountId, token, ad, videoId, pageId }) {
  const ctaText = ad.ctaText || 'Shop now';
  const ctaUrl = composeCtaUrl(ad.ctaUrl, ad.ctaUrlParams);
  const message  = ad.copy?.headline || ad.copy?.quote || ad.copy?.productName || '';
  const headline = ad.copy?.productName || ad.copy?.headline || '';
  if (!ad.posterUrl) throw new Error('video ad has no posterUrl — Meta requires a poster image');
  const body = {
    name: `${ad.template} ${ad.aspectRatio} ${String(ad._id).slice(-8)} (video)`,
    object_story_spec: {
      page_id: pageId,
      video_data: {
        video_id:  videoId,
        image_url: ad.posterUrl,
        title:     headline,
        message,
        call_to_action: {
          type:  mapCtaTextToEnum(ctaText),
          value: { link: ctaUrl || 'https://example.com' }
        }
      }
    }
  };
  const res = await axios.post(
    `${META_GRAPH_ROOT}/${adAccountId}/adcreatives`,
    body,
    { params: { access_token: token }, timeout: 30000 }
  );
  if (!res.data?.id) throw new Error('Meta /adcreatives (video) returned no id');
  return res.data.id;
}

// Create the Ad inside the chosen AdSet, always paused. Operator
// activates in Ads Manager — keeps an accidental push from burning
// budget the second the request lands.
async function createAd({ adAccountId, token, ad, adsetId, creativeId }) {
  const body = {
    name:      `${ad.template} · ${ad.aspectRatio} · ${String(ad._id).slice(-6)}`,
    adset_id:  adsetId,
    creative:  { creative_id: creativeId },
    status:    'PAUSED'
  };
  const res = await axios.post(
    `${META_GRAPH_ROOT}/${adAccountId}/ads`,
    body,
    { params: { access_token: token }, timeout: 30000 }
  );
  if (!res.data?.id) throw new Error('Meta /ads returned no id');
  return res.data.id;
}

function composeCtaUrl(url, params) {
  const u = String(url || '').trim();
  const p = String(params || '').trim().replace(/^[?&]/, '');
  if (!u) return '';
  if (!p) return u;
  return u.includes('?') ? `${u}&${p}` : `${u}?${p}`;
}

// Push a single rendered Ad to Meta. Caller supplies the resolved
// cred + page context so a batch can amortize the lookup once.
// Mutates the Ad doc with metaSyncStatus + ids + timestamps; throws
// on upload/create failure so the batch loop can catch and stamp
// failed status without halting.
async function pushOne({ ad, adsetId, adAccountId, token, pageId, metaCampaignId }) {
  if (!ad.renderUrl) throw new Error('ad has no renderUrl (not yet rendered)');
  // Video and image branches diverge on the upload + creative steps;
  // the final Ad creation is identical. Video adds a poll-for-ready
  // wait (Meta's /advideos is async, ~30s–3min) before the creative
  // can reference the video_id.
  let creativeId;
  if (ad.kind === 'video') {
    const videoId = await uploadVideoToMeta({ adAccountId, token, videoUrl: ad.renderUrl });
    console.log(`   📹 video uploaded (id=${videoId}) — polling for ready…`);
    await waitForVideoReady({ videoId, token });
    console.log(`   📹 video ${videoId} ready — building creative`);
    creativeId = await createAdCreativeForVideo({ adAccountId, token, ad, videoId, pageId });
  } else {
    const imageHash = await uploadImageToMeta({ adAccountId, token, imageUrl: ad.renderUrl });
    creativeId = await createAdCreative({ adAccountId, token, ad, imageHash, pageId });
  }
  const metaAdId = await createAd({ adAccountId, token, ad, adsetId, creativeId });
  ad.metaAdId         = metaAdId;
  ad.metaAdCreativeId = creativeId;
  ad.metaAdsetId      = adsetId;
  ad.metaCampaignId   = metaCampaignId || null;
  ad.metaAdAccountId  = adAccountId;
  ad.metaPageId       = pageId;
  ad.metaSyncStatus   = 'synced';
  ad.metaSyncError    = null;
  ad.metaSyncedAt     = new Date();
  await ad.save();
  return { adId: String(ad._id), ok: true, metaAdId, metaAdCreativeId: creativeId };
}

// Resolve the meta-ads campaign id for an adsetId by walking the
// brand's synced Campaigns. Stored alongside metaAdsetId so the
// "View in Ads Manager" link can deep-link to the right context.
async function findMetaCampaignIdForAdset({ brandId, adsetId }) {
  const campaign = await Campaign.findOne({
    brandId, platform: 'meta-ads', 'adSets.externalId': adsetId
  }).select('externalId').lean();
  return campaign?.externalId || null;
}

// Public entry — single or batch push.
// Body: { adIds: [string], adsetId: string, brandId: string, requestedBy?: string }
// Returns: { pushed: N, failed: N, perAd: [{adId, ok, metaAdId?, error?}] }
async function pushAdsBatch({ adIds, adsetId, brandId, requestedBy = null }) {
  if (!adIds?.length) return { pushed: 0, failed: 0, perAd: [] };
  if (!adsetId) throw new Error('adsetId required');
  if (!brandId) throw new Error('brandId required');

  // Cred + page context once per batch.
  const [{ token, adAccountId }, page, metaCampaignId] = await Promise.all([
    resolveMetaAdsCred(brandId),
    resolveBrandPageId(brandId),
    findMetaCampaignIdForAdset({ brandId, adsetId })
  ]);
  console.log(
    `📣 Meta push batch: brand=${brandId} adset=${adsetId} ads=${adIds.length} ` +
    `account=${adAccountId} page=${page.pageId} requestedBy=${requestedBy || 'system'}`
  );

  const ads = await Ad.find({ _id: { $in: adIds }, brandId });
  const adsById = new Map(ads.map(a => [String(a._id), a]));
  const perAd = [];
  let cursor = 0;

  // Hand-rolled bounded concurrency — Promise.allSettled with chunking
  // would let one slow ad hold up the next chunk. This worker pattern
  // keeps PUSH_CONCURRENCY ads in flight at all times.
  async function worker() {
    while (cursor < adIds.length) {
      const idx = cursor++;
      const adId = adIds[idx];
      const ad = adsById.get(String(adId));
      if (!ad) {
        perAd.push({ adId, ok: false, error: 'ad not found in this brand' });
        continue;
      }
      try {
        const result = await pushOne({ ad, adsetId, adAccountId, token, pageId: page.pageId, metaCampaignId });
        perAd.push(result);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        ad.metaSyncStatus = 'failed';
        ad.metaSyncError  = msg.slice(0, 1000);
        ad.metaSyncedAt   = new Date();
        try { await ad.save(); } catch (_) { /* swallow — primary failure already captured */ }
        perAd.push({ adId: String(adId), ok: false, error: msg });
        console.warn(`   ⚠️  Meta push failed for ad ${adId}: ${msg}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(PUSH_CONCURRENCY, adIds.length) }, () => worker());
  await Promise.all(workers);

  const pushed = perAd.filter(r => r.ok).length;
  const failed = perAd.length - pushed;
  console.log(`📣 Meta push batch done: pushed=${pushed} failed=${failed}`);
  return { pushed, failed, perAd };
}

// List AdSets across the brand's synced Meta Ads campaigns. Flat
// shape so the UI's single dropdown can render groups by campaign.
async function listAdsetsForBrand(brandId) {
  const campaigns = await Campaign.find({
    brandId, platform: 'meta-ads'
  }).select('externalId name status adSets').lean();
  const out = [];
  for (const c of campaigns) {
    for (const s of (c.adSets || [])) {
      out.push({
        adsetId:        s.externalId,
        adsetName:      s.name || '(unnamed adset)',
        adsetStatus:    s.status || null,
        campaignId:     c.externalId,
        campaignName:   c.name || '(unnamed campaign)',
        campaignStatus: c.status || null
      });
    }
  }
  return out;
}

module.exports = {
  pushAdsBatch,
  listAdsetsForBrand,
  mapCtaTextToEnum     // exported for tests / direct use
};
