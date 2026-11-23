const mongoose = require('mongoose');

const TOPICS = ['Question', 'Feedback', 'Remove a file', 'Report abuse'];

// A message sent from the Contact page, so admins can work through them on /admin/messages.
// Kept for one year, then removed automatically.
const contactMessageSchema = new mongoose.Schema(
  {
    topic: { type: String, enum: TOPICS, required: true, index: true },
    name: { type: String, required: true, maxlength: 100 },
    email: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 2000 },
    fileKey: { type: String, default: '', maxlength: 6 }, // 6-digit transfer key (Remove a file / Report abuse)
    ip: { type: String, default: '' }, // to spot abuse; shown to admins only
    status: { type: String, enum: ['open', 'done'], default: 'open', index: true },
    doneAt: { type: Date, default: null },
    doneBy: { type: String, default: '' }, // admin username
    doneNote: { type: String, default: '', maxlength: 500 }, // optional note, e.g. "files deleted"
  },
  { timestamps: true }
);
contactMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
module.exports.TOPICS = TOPICS;
