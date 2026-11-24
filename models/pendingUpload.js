const mongoose = require('mongoose');

// A direct-to-S3 upload that has started but is not finished yet. When the browser says "done", the files
// are checked and a real Transfer (with its key) is created; this record is then removed. Unfinished ones
// are aborted by the cleanup job after a couple of hours (see services/transferCleanup.js).
const pendingUploadSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true }, // SHA-256 of the secret the browser holds
    ip: { type: String, default: '' },
    files: [
      {
        _id: false,
        name: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, default: 'application/octet-stream' },
        storageKey: { type: String, required: true },
        uploadId: { type: String, required: true },
      },
    ],
    totalSize: { type: Number, required: true },
    expiryMinutes: { type: Number, required: true },
    maxDownloads: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
pendingUploadSchema.index({ createdAt: 1 });

module.exports = mongoose.model('PendingUpload', pendingUploadSchema);
