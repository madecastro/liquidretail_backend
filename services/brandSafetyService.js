// Phase 4 follow-up #5 — Brand Safety enforcement for the matcher.
//
// brand.brandSafety.blockedTopics is an operator-curated list of topics
// (e.g. ['Alcohol','Gambling','Guns','Hate Speech','Adult','Tobacco'])
// that should NOT appear in this brand's matched media. When the
// matcher runs on a post (Media), we evaluate the post's text-bearing
// signals — caption, OCR-detected text, comments — against the blocked-
// topic list. A hit short-circuits the matcher with outcome=do_not_use,
// preventing the post from generating ad creative downstream
// (layoutInputService already hard-stops on do_not_use).
//
// Word-boundary matching: each topic is treated as a phrase and
// required to appear with surrounding word boundaries, so 'Adult'
// matches 'adult content' but not 'adulthood', and 'Gun' matches
// 'gun rack' but not 'begun'. Multi-word topics like 'Hate Speech'
// match the literal phrase (with whitespace tolerance).

const Brand = require('../models/Brand');

// Soft keyword expansion. The operator-facing topic is the LABEL;
// the synonyms widen the substring net so matching doesn't depend on
// the post author using the exact label term. Conservative coverage —
// extend as misses are observed in production.
const TOPIC_SYNONYMS = {
  'alcohol':       ['wine', 'beer', 'spirits', 'liquor', 'whiskey', 'whisky', 'vodka', 'tequila', 'rum', 'bourbon', 'champagne', 'cocktail', 'martini'],
  'tobacco':       ['cigarette', 'cigar', 'vape', 'vaping', 'e-cig', 'ecig', 'nicotine', 'smoking'],
  'guns':          ['gun', 'firearm', 'rifle', 'handgun', 'pistol', 'shotgun', 'ammo', 'ammunition'],
  'gun':           ['firearm', 'rifle', 'handgun', 'pistol', 'shotgun', 'ammo', 'ammunition'],
  'gambling':      ['casino', 'poker', 'betting', 'sportsbook', 'lottery', 'slots'],
  'adult':         ['nsfw', 'explicit', 'mature content', 'porn'],
  'hate speech':   [],   // semantic; no safe substring expansion
  'misinformation':[],
  'counterfeits':  ['counterfeit', 'fake', 'replica', 'knockoff', 'knock-off'],
  'animal abuse':  []
};

async function loadBrandSafety(brandId) {
  if (!brandId) return null;
  try {
    const doc = await Brand.findById(brandId).select('brandSafety name').lean();
    if (!doc) return null;
    const safety = doc.brandSafety || {};
    return {
      brandName:     doc.name || null,
      blockedTopics: Array.isArray(safety.blockedTopics) ? safety.blockedTopics : [],
      category:      safety.category || null,
      riskScore:     typeof safety.riskScore === 'number' ? safety.riskScore : null
    };
  } catch (err) {
    console.warn(`   ⚠️  brandSafety: failed to load brand ${brandId}: ${err.message}`);
    return null;
  }
}

// Build the haystack from the post-level text signals available to the
// matcher. caption is the post text (creator intent), textDetected is
// OCR over the image (labels, scene text), comments are post-level
// engagement text. All three are author/creator-controlled and worth
// gating on; we deliberately do NOT include the candidate product
// fields (those are the brand's own catalog, presumed safe).
function buildHaystack({ caption, textDetected, comments }) {
  const parts = [];
  if (typeof caption === 'string' && caption.trim()) {
    parts.push({ text: caption, source: 'caption' });
  }
  for (const t of (textDetected || [])) {
    const txt = typeof t === 'string' ? t : t?.content;
    if (typeof txt === 'string' && txt.trim()) {
      parts.push({ text: txt, source: 'ocr' });
    }
  }
  for (const c of (comments || [])) {
    const txt = typeof c === 'string' ? c : c?.text;
    if (typeof txt === 'string' && txt.trim()) {
      parts.push({ text: txt, source: 'comment' });
    }
  }
  return parts;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary phrase match. Whitespace inside the phrase is
// tolerant — multiple spaces / linebreaks count as one word break.
function phraseRegex(phrase) {
  const escaped = escapeRegex(phrase).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
}

// Evaluate post-level safety. Returns { safe, hits } where hits is
// an array of { topic, signal, source, snippet } describing each
// match for ops/audit. The matcher logs the full list and surfaces
// the topic names in outcomeReasoning.
function evaluatePostSafety(blockedTopics, signals) {
  if (!Array.isArray(blockedTopics) || blockedTopics.length === 0) {
    return { safe: true, hits: [] };
  }
  const parts = buildHaystack(signals);
  if (parts.length === 0) return { safe: true, hits: [] };

  const hits = [];
  for (const topic of blockedTopics) {
    const topicStr = String(topic || '').trim();
    if (!topicStr) continue;
    const lower = topicStr.toLowerCase();
    const phrases = [topicStr, ...(TOPIC_SYNONYMS[lower] || [])];
    const compiled = phrases.map(p => ({ phrase: p, rx: phraseRegex(p) }));

    for (const part of parts) {
      for (const { phrase, rx } of compiled) {
        const m = part.text.match(rx);
        if (m) {
          hits.push({
            topic:   topicStr,
            phrase:  phrase,
            source:  part.source,
            snippet: snippetAround(part.text, m.index || 0, phrase.length)
          });
          break;       // one hit per topic per signal is enough
        }
      }
    }
  }
  return { safe: hits.length === 0, hits };
}

function snippetAround(text, start, len) {
  const a = Math.max(0, start - 24);
  const b = Math.min(text.length, start + len + 24);
  const s = text.slice(a, b).replace(/\s+/g, ' ').trim();
  return (a > 0 ? '…' : '') + s + (b < text.length ? '…' : '');
}

module.exports = {
  loadBrandSafety,
  evaluatePostSafety
};
