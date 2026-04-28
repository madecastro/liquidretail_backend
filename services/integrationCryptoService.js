// AES-256-GCM symmetric encryption for third-party access tokens at
// rest. Authenticated encryption — any tampering with the ciphertext
// causes decryption to throw. The 96-bit IV is generated fresh per
// call (never reused).
//
// Key source: INTEGRATION_ENCRYPTION_KEY env var, base64-encoded
// 32 bytes. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function getKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) throw new Error('INTEGRATION_ENCRYPTION_KEY not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`INTEGRATION_ENCRYPTION_KEY must be ${KEY_BYTES} base64-decoded bytes (got ${key.length})`);
  }
  return key;
}

// Returns { iv, authTag, ciphertext } as base64 strings — the shape
// stored on IntegrationCredential.accessTokenEnc.
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('encrypt: plaintext must be a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv:         iv.toString('base64'),
    authTag:    tag.toString('base64'),
    ciphertext: ct.toString('base64')
  };
}

function decrypt(blob) {
  if (!blob || !blob.iv || !blob.authTag || !blob.ciphertext) {
    throw new Error('decrypt: malformed blob');
  }
  const iv  = Buffer.from(blob.iv,         'base64');
  const tag = Buffer.from(blob.authTag,    'base64');
  const ct  = Buffer.from(blob.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt };
