const mongoose = require('mongoose');

// One row per sign-in. The refresh token itself is never stored, only its SHA-256 hash.
// expiresAt is fixed when the user signs in (default 15 minutes) and refreshing never extends it,
// so every token of the session stops working at that moment.
const authSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshHash: { type: String, required: true, index: true },
    prevRefreshHash: { type: String, default: null, index: true }, // previous token: seeing it again means it was stolen
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastRefreshAt: { type: Date, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expired sessions are deleted by MongoDB

module.exports = mongoose.model('AuthSession', authSessionSchema);
