const mongoose = require('mongoose');

// People who can sign in. Passwords are never stored: only a salted scrypt hash (see services/password.js).
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 64 },
    passwordHash: { type: String, required: true },
    // Only 'admin' can use the admin panel today; 'user' is reserved for future features.
    role: { type: String, enum: ['admin', 'user'], default: 'user' },
    disabled: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
