// Phase 4 follow-up #6 — Persona avatar generation.
//
// Generates a portrait illustration for an audience persona using
// gpt-image-1, then uploads it to Cloudinary so the URL is stable
// (OpenAI image URLs in the response would expire). Returns the
// permanent Cloudinary URL for persistence on
// brand.demographics[i].avatarUrl.
//
// Style choice: warm flat-illustration portraits, not photorealistic
// faces. This sidesteps the uncanny-valley issue and keeps the avatars
// clearly persona-stand-ins rather than implying a real person we
// shouldn't depict. Soft brand-neutral palette so personas across
// different brands all read as a cohesive set.

const OpenAI = require('openai');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Build a tight portrait prompt from the persona attributes the
// operator filled in. We deliberately drop pain points from the
// prompt — those describe internal state, not visual appearance, and
// asking the model to depict "worried about X" produces frowny
// stock-photo faces that aren't useful as audience avatars.
function buildPersonaPrompt(persona, brandContext) {
  const { name, description, interests, toneHint } = persona || {};
  const pieces = [];

  pieces.push(
    'Flat illustration head-and-shoulders portrait of a friendly fictional persona, ' +
    'soft warm color palette, simple solid background, modern editorial style, ' +
    'centered subject, no text, no logos, no watermarks.'
  );

  if (name)        pieces.push(`Persona name: "${name}".`);
  if (description) pieces.push(`Persona description: ${description}.`);
  if (Array.isArray(interests) && interests.length) {
    pieces.push(`Interests: ${interests.slice(0, 6).join(', ')}.`);
  }
  if (toneHint)    pieces.push(`Personality tone: ${toneHint}.`);

  if (brandContext?.category) {
    pieces.push(`Reflects the audience of a ${brandContext.category} brand.`);
  }

  pieces.push(
    'IMPORTANT: do NOT depict any real, identifiable person. ' +
    'Generic stylized illustration, not a photograph.'
  );

  return pieces.join(' ');
}

async function generateAvatarForPersona(persona, brandContext = {}) {
  if (!persona?.name && !persona?.description) {
    throw new Error('persona must have at least a name or description to generate an avatar');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }

  const prompt = buildPersonaPrompt(persona, brandContext);

  const res = await openai.images.generate({
    model:  'gpt-image-1',
    prompt,
    size:   '1024x1024',
    n:      1
  });

  const b64 = res?.data?.[0]?.b64_json;
  if (!b64) throw new Error('image generation returned no data');
  const buffer = Buffer.from(b64, 'base64');

  // Path-style publicId lands the asset under
  // liquidretail/avatars/<unique> for easy filtering in the Cloudinary
  // console and any future cascade-delete handling. (The shared
  // uploadBufferToCloudinary hardcodes its top-level folder to
  // 'liquidretail'; nesting via publicId is the supported way to
  // sub-folder without forking that helper.)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const upload = await uploadBufferToCloudinary(buffer, {
    publicId: `avatars/persona-${stamp}`
  });

  return {
    url:      upload.secure_url,
    publicId: upload.public_id,
    prompt
  };
}

module.exports = {
  generateAvatarForPersona,
  buildPersonaPrompt   // exported for testing
};
