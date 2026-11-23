const mongoose = require('mongoose');

// Who changed what from the admin panel (never stores passwords). Kept for 90 days.
const auditSchema = new mongoose.Schema(
  {
    ip: { type: String, default: '' },
    by: { type: String, default: '' }, // username of the admin who made the change
    changes: [{ key: String, from: mongoose.Schema.Types.Mixed, to: mongoose.Schema.Types.Mixed, _id: false }],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AdminAudit', auditSchema);
