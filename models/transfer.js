const mongoose = require('mongoose');

const transferSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, index: true },
    storage: { type: String, enum: ['local', 's3'], default: 'local' },
    files: [
      {
        originalName: { type: String, required: true },
        storageKey: { type: String, required: true },
        size: { type: Number, required: true },
        mimeType: { type: String, default: 'application/octet-stream' },
        downloads: { type: Number, default: 0 },
      },
    ],
    // Kept after the files are removed so public stats still work (names are scrubbed, counts stay).
    fileCount: { type: Number },
    totalSize: { type: Number, required: true },
    // Set when the files were removed from storage; the row itself is kept for statistics.
    deletedAt: { type: Date, default: null, index: true },
    emailsSent: { type: Number, default: 0 },
    // How many times each file may be downloaded (1..5, chosen by the sender). Counted per file in files[].downloads.
    maxDownloads: { type: Number, default: 1, min: 1, max: 5 },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transfer', transferSchema);
