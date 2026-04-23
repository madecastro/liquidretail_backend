const express = require('express');
const router = express.Router();
const Media = require('../models/Media');

// PATCH /api/media/:mediaId/rights
// Body: { approved: boolean, approvedBy?: string, notes?: string }
// Toggles the creator-rights flag used by the layout generator to decide
// whether UGC fields ship on the creative input. When approved flips true,
// approvedAt is stamped server-side; when it flips false, approvedAt +
// approvedBy are cleared so history doesn't linger misleadingly.
router.patch('/:mediaId/rights', express.json(), async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { approved, approvedBy, notes } = req.body || {};
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'body.approved (boolean) is required' });
    }
    const update = approved
      ? {
          'rights.approved':   true,
          'rights.approvedBy': approvedBy || req.user?.email || 'unknown',
          'rights.approvedAt': new Date(),
          ...(typeof notes === 'string' ? { 'rights.notes': notes } : {})
        }
      : {
          'rights.approved':   false,
          'rights.approvedBy': null,
          'rights.approvedAt': null,
          ...(typeof notes === 'string' ? { 'rights.notes': notes } : {})
        };

    const media = await Media.findByIdAndUpdate(mediaId, { $set: update }, { new: true });
    if (!media) return res.status(404).json({ error: 'Media not found' });

    res.json({
      mediaId: media._id,
      rights:  media.rights || { approved: false }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Rights update failed' });
  }
});

module.exports = router;
