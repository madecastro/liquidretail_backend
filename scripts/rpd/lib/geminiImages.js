// scripts/rpd/lib/geminiImages.js — fetch + base64-encode reference images
// for the Gemini Developer API's inline-image request shape.
//
// Atlas takes plain URL strings (image_url / images: [url, ...]); Gemini's
// `input` array takes {type:'image', data: <base64>, mime_type} — see
// buildRequestBody in services/geminiVideoService.js. Only called at SUBMIT
// time (never during dry-run expansion), so a dry run stays free and
// network-free exactly like the Atlas path.

const axios = require('axios');

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif'
};

function guessMimeType(url, contentType) {
  if (contentType && contentType.startsWith('image/')) return contentType.split(';')[0].trim();
  const m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url || '');
  const ext = m ? m[1].toLowerCase() : null;
  return (ext && EXT_MIME[ext]) || 'image/jpeg';
}

async function fetchImageAsBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxRedirects: 3 });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching reference image: ${url}`);
  return {
    data: Buffer.from(res.data).toString('base64'),
    mimeType: guessMimeType(url, res.headers && res.headers['content-type']),
    sourceUrl: url,
    bytes: res.data.length
  };
}

async function fetchImagesAsBase64(urls) {
  const out = [];
  for (const url of urls) out.push(await fetchImageAsBase64(url));
  return out;
}

module.exports = { fetchImageAsBase64, fetchImagesAsBase64, guessMimeType };
