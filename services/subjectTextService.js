const OpenAI = require('openai');
const JSON5 = require('json5');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Single GPT-4.1 call: returns subjects, text regions, AND a structured
// background analysis so downstream stages (smart crops, AI extension /
// generation, overlay zones, ad layout) can condition on the scene style.
//
// Optional `hints` (brand / category / caption) come from the upload form and
// help the model pick the correct primary subject and write a richer
// description.
//
// Phase A-0 — also emits a small set of derived display fields used by the
// Media Library page:
//   primarySubjectLabel  — concise label ("Person (Runner)", "Bottle (Vacuum
//                          Insulated)") suitable for a one-line UI chip
//   secondaryElementsTags — short noun list extracted from secondary subjects
//                          + background notes ("Mountain", "Trees", "Trail")
//   background.mood       — 2–4 mood adjectives ("Active", "Adventurous")
//   background.sceneType  — refined scene type ("Outdoor Trail", "Studio",
//                          "Urban Street") — more specific than `setting`
//
// Output shape:
//   {
//     subjects:  [{ id, role, description, x1, y1, x2, y2 }],
//     text:      [{ id, content, type, x1, y1, x2, y2, confidence }],
//     background:{ description, setting, palette, lighting, style, notes,
//                  mood, sceneType },
//     primarySubjectLabel:   string | null,
//     secondaryElementsTags: string[]
//   }
async function detectSubjectsAndText(imageUrl, hints = {}) {
  const { brand, category, caption } = hints;
  const hintLines = [];
  if (brand)    hintLines.push(`- User states the BRAND is: ${brand}`);
  if (category) hintLines.push(`- User states the CATEGORY is: ${category}`);
  if (caption)  hintLines.push(`- User's caption: "${caption}"`);
  const hintBlock = hintLines.length
    ? `\n\nUSER HINTS (use these to pick which subject is PRIMARY and to enrich its description):\n${hintLines.join('\n')}`
    : '';

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `You are a computer vision assistant. Analyze the image and return a JSON object with three keys: "subjects", "text", and "background".

"subjects": array of visual subjects/objects you see. Each item:
  { "id": "s1", "role": "primary"|"secondary"|"background", "description": "...", "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0 }
  Coordinates are normalized 0-1 (x=left→right, y=top→bottom).
  - Exactly ONE subject should have role "primary" (the product or person the image is about).
  - "secondary" subjects are additional recognizable items that share focus (other products, people interacting, props).
  - "background" role is for items/objects that are part of the scene but not the focus (decor, distant figures). Do not confuse this with the "background" key below.

"text": array of readable text regions. Each item:
  { "id": "t1", "content": "exact text", "type": "product_label"|"brand"|"serial"|"warning"|"general", "x1": 0.0, "y1": 0.0, "x2": 1.0, "y2": 1.0, "confidence": 0.0-1.0 }
  Coordinates are normalized 0-1.

"background": a structured analysis of the SCENE (not a subject) so AI image generators can extend or regenerate it faithfully:
  {
    "description": "one concise sentence describing the setting — what's behind / around the subject",
    "setting":     "studio" | "indoor" | "outdoor" | "lifestyle" | "abstract" | "product-shot-on-solid" | "other",
    "palette":     ["#rrggbb", ...],                // 2–5 dominant hex colors of the BACKGROUND, not the subject
    "lighting":    "hard studio" | "soft diffused" | "golden hour" | "overcast" | "dim indoor" | "harsh overhead" | "backlit" | "flash" | "other",
    "style":       "photorealistic" | "editorial" | "lifestyle" | "minimalist" | "cluttered" | "high-contrast" | "muted" | "vibrant" | "other",
    "notes":       "anything else an AI image generator should know to extend this scene — e.g. 'beach at low tide, sand texture visible, soft waves far left'",
    "mood":        ["adjective", ...],              // 2–4 mood/feeling adjectives describing the OVERALL emotional tone (e.g. ["active","adventurous"], ["calm","minimal"], ["festive","warm"])
    "sceneType":   "concise scene-type label — a refinement of \"setting\" that adds context. Examples: \"Outdoor Trail\", \"Studio\", \"Urban Street\", \"Beach\", \"Office\", \"Kitchen\", \"Mountain Summit\". 1–3 words."
  }

"primarySubjectLabel": a SHORT concise label for the primary subject suitable for a one-line UI chip. Format "<Noun> (<role/qualifier>)" when a role is meaningful, else just the noun. Examples: "Person (Runner)", "Person (Cyclist)", "Bottle (Vacuum Insulated)", "Sneakers", "Backpack", "Coffee Cup". Always derived from the chosen primary subject. Max 30 chars.

"secondaryElementsTags": array of 2–6 short noun tags describing the OTHER notable elements visible in the frame (not the primary subject). Drawn from secondary subjects + background contents. Single-word or two-word tags, capitalized. Examples: ["Mountain", "Trees", "Trail"], ["Coffee Mug", "Notebook"], ["Skyline", "Crosswalk"]. Omit if nothing notable.

"contentNature": classify this post for ad-suitability using BOTH the caption (if provided) and visible text in the image:
  - "evergreen":     lifestyle, product-in-use, behind-the-scenes, brand origin, customer testimonial without a time-bound offer. Reusable in ads year-round.
  - "promotional":   contains a specific offer or sale ("20% off", "BOGO", "Black Friday deal", "Sale ends Friday", "Use code XYZ"). Time-bound; stale fast.
  - "announcement":  teases or announces something new ("Coming soon", "New flavor dropping", "Just launched", "Drops tomorrow", collab reveals, event teasers). Time-bound; stale once the thing has launched.
  - "unknown":       neither caption nor image text gives a clear signal.

"contentNatureConfidence": 0.0-1.0 — how confident you are in the classification. ≥0.7 when caption or visible text directly signals (e.g. "% off" or "coming soon"); ≤0.5 when you're inferring from softer signals.

"contentNatureReason": one short sentence citing the specific signal (e.g. "Caption says 'Black Friday 50% off'", "Visible text reads 'Coming soon'", "Lifestyle product-in-use shot with no time-bound language"). Max 120 chars.

"shotType": classify the photographic style. Look at framing, scene composition, and whether the product is isolated or in context:
  - "lifestyle":     product shown in real-world context (in use, on a table, in a kitchen scene, held in hand, plated, etc.) — has scene, props, or ambient context
  - "on_model":      person wearing, holding, or using the product (face may be cropped or full)
  - "product_only":  isolated studio shot — single product on plain or solid background (white, gray, transparent, gradient). No human, no scene.
  - "flat_lay":      top-down arrangement of one or more items on a flat surface
  - "detail":        close-up / macro of a specific feature or texture (not the full product)
  - "packaging":     box, label, or wrapper shot — emphasis on packaging, not the product itself
  - "unknown":       ambiguous or doesn't fit any of the above

"shotTypeConfidence": 0.0-1.0 — confidence in the shot type classification.

"shotTypeReason": one short sentence citing the visual signal (e.g. "Bottle held over a steaming bowl of noodles on a wooden table", "Studio shot of bottle on white seamless"). Max 120 chars.

The PRIMARY subject's description should be detailed enough to search for it online — include material, color, cut/silhouette, notable features, and any product name/label you can read.${hintBlock}

Return ONLY valid JSON, no markdown, no explanation.`
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ],
    max_tokens: 2500,
    temperature: 0.2
  });

  const raw = response.choices[0].message.content.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('GPT returned no JSON for subject/text detection');

  const parsed = JSON5.parse(match[0]);

  const subjects = (parsed.subjects || []).map((s, i) => ({
    id: s.id || `s${i + 1}`,
    role: s.role || 'secondary',
    description: s.description || '',
    x1: clamp(s.x1), y1: clamp(s.y1), x2: clamp(s.x2), y2: clamp(s.y2)
  }));

  const text = (parsed.text || []).map((t, i) => ({
    id: t.id || `t${i + 1}`,
    content: t.content || '',
    type: t.type || 'general',
    x1: clamp(t.x1), y1: clamp(t.y1), x2: clamp(t.x2), y2: clamp(t.y2),
    confidence: Math.min(1, Math.max(0, parseFloat(t.confidence) || 0.8))
  }));

  const bg = parsed.background || {};
  const background = {
    description: typeof bg.description === 'string' ? bg.description : '',
    setting:     typeof bg.setting === 'string' ? bg.setting : '',
    palette:     Array.isArray(bg.palette) ? bg.palette.filter(c => typeof c === 'string').slice(0, 5) : [],
    lighting:    typeof bg.lighting === 'string' ? bg.lighting : '',
    style:       typeof bg.style === 'string' ? bg.style : '',
    notes:       typeof bg.notes === 'string' ? bg.notes : '',
    // Phase A-0 — small derived display fields
    mood:        Array.isArray(bg.mood)
                   ? bg.mood.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim()).slice(0, 4)
                   : [],
    sceneType:   typeof bg.sceneType === 'string' ? bg.sceneType.trim().slice(0, 40) : ''
  };

  // Phase A-0 — concise primary-subject label + secondary element tags.
  // Both are best-effort; UI handles missing values gracefully.
  const primarySubjectLabel = (typeof parsed.primarySubjectLabel === 'string' && parsed.primarySubjectLabel.trim())
    ? parsed.primarySubjectLabel.trim().slice(0, 30)
    : null;
  const secondaryElementsTags = Array.isArray(parsed.secondaryElementsTags)
    ? parsed.secondaryElementsTags
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => t.trim().slice(0, 30))
        .slice(0, 6)
    : [];

  // Content-nature classification — used downstream by the seed filter
  // in campaignAdsGenerationService to exclude time-bound promotional /
  // announcement UGC from default ad inventory. Default to 'unknown' so
  // an LLM that doesn't return the field gets included rather than
  // excluded by mistake.
  const CONTENT_NATURE_VALUES = new Set(['evergreen', 'promotional', 'announcement', 'unknown']);
  const rawNature = typeof parsed.contentNature === 'string' ? parsed.contentNature.trim().toLowerCase() : '';
  const contentNature = CONTENT_NATURE_VALUES.has(rawNature) ? rawNature : 'unknown';
  const contentNatureConfidence = typeof parsed.contentNatureConfidence === 'number'
    ? Math.max(0, Math.min(1, parsed.contentNatureConfidence))
    : 0.5;
  const contentNatureReason = typeof parsed.contentNatureReason === 'string'
    ? parsed.contentNatureReason.trim().slice(0, 120)
    : null;

  // Shot-type classification — used by seedsFromProduct (Tier 0) to
  // pick a lifestyle/on-model shot as the visual hero of a product_image
  // ad, and by layoutInputService to pick a product_only shot for the
  // product.image inset. Relevant primarily for catalog product Media;
  // UGC posts almost always land on 'lifestyle' but downstream UGC
  // consumers don't read the field.
  const SHOT_TYPE_VALUES = new Set([
    'lifestyle', 'on_model', 'product_only', 'flat_lay', 'detail', 'packaging', 'unknown'
  ]);
  const rawShot = typeof parsed.shotType === 'string' ? parsed.shotType.trim().toLowerCase() : '';
  const shotType = SHOT_TYPE_VALUES.has(rawShot) ? rawShot : 'unknown';
  const shotTypeConfidence = typeof parsed.shotTypeConfidence === 'number'
    ? Math.max(0, Math.min(1, parsed.shotTypeConfidence))
    : 0.5;
  const shotTypeReason = typeof parsed.shotTypeReason === 'string'
    ? parsed.shotTypeReason.trim().slice(0, 120)
    : null;

  return {
    subjects, text, background,
    primarySubjectLabel, secondaryElementsTags,
    contentNature, contentNatureConfidence, contentNatureReason,
    shotType, shotTypeConfidence, shotTypeReason
  };
}

function clamp(v) {
  return Math.min(1, Math.max(0, parseFloat(v) || 0));
}

module.exports = { detectSubjectsAndText };
