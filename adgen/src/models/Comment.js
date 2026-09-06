// Inbound social-platform comment on a Media.
//
// Populated by mediaInsightsService.fetchCommentsForMedia, which
// pulls /{ig-media-id}/comments from the Instagram Graph API and
// upserts one Comment doc per (mediaId, externalId) pair.
// Idempotent: re-running the fetch updates likeCount / replyCount
// in place rather than creating duplicates.
//
// Replies (threaded) are flattened onto this same collection with
// parentExternalId pointing at the parent comment's externalId.
// V1 only fetches top-level comments; reply ingestion is a later
// pass once the operator-facing UI exposes threaded view.

const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  mediaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Media',      required: true, index: true },
  brandId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },
  advertiserId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },

  source:         { type: String, enum: ['instagram', 'tiktok', 'meta'], required: true, default: 'instagram' },
  // Platform's id for the comment.
  externalId:     { type: String, required: true },

  text:           { type: String, default: '' },
  authorUsername: { type: String, default: null },
  authorId:       { type: String, default: null },

  likeCount:      { type: Number, default: 0 },
  replyCount:     { type: Number, default: 0 },

  postedAt:       { type: Date,   default: null },
  // Top-level comments leave this null. Replies set it to the parent
  // comment's externalId so threaded views can rebuild the tree.
  parentExternalId: { type: String, default: null, index: true },

  fetchedAt:      { type: Date,   default: Date.now },

  // Whether this comment may be printed as social proof on a paid ad, decided
  // ONCE at ingest by inference over the whole sentence (see
  // services/quoteSnippetService.judgeProofLines and docs/PROOF_JUDGE.md).
  //
  // It lives on the row, not in each renderer, because a comment's sentiment
  // does not change between ads — and because every surface that renders one
  // must reach the SAME verdict. Four separate consumers previously each
  // decided for themselves, with three different answers and one no answer at
  // all: the Director was handed raw comments, complaints included.
  //
  // `line` is the ad-ready shortened form. Shortening happens here, at the
  // same time as the judgment, so a comment is judged and shortened exactly
  // once and nothing downstream trims it again.
  //
  // Absent (undefined) means NOT YET JUDGED, which is not the same as
  // rejected: consumers judge those lazily and persist the result, so the
  // collection fills in without a backfill.
  proofJudgment: {
    usable:   { type: Boolean, default: undefined },
    reason:   { type: String,  default: null },
    line:     { type: String,  default: null },
    model:    { type: String,  default: null },
    judgedAt: { type: Date,    default: null }
  }
}, { timestamps: true });

// One row per (media, platform comment id). Re-fetching upserts.
commentSchema.index({ mediaId: 1, externalId: 1 }, { unique: true });
// Listing — newest first per media.
commentSchema.index({ mediaId: 1, postedAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
