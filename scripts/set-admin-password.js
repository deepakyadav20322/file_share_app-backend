// Sets a new admin password (stored as a hash) and signs the admin out everywhere.
//   node scripts/set-admin-password.js <new-password> [username]
// The password must be at least 10 characters. Use a long random one: it is the part that stays secret.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const AuthSession = require('../models/authSession');
const { hashPassword } = require('../services/password');

(async () => {
  const [password, name] = [process.argv[2], (process.argv[3] || process.env.ADMIN_ID || 'admin').toLowerCase()];
  if (!password || password.length < 10) {
    console.error('Usage: node scripts/set-admin-password.js <new-password (10+ characters)> [username]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_CONNECTION_URL);
  const user = await User.findOne({ username: name });
  if (!user) {
    console.error(`No user named "${name}".`);
    process.exit(1);
  }
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
  await AuthSession.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  console.log(`Password updated for "${name}". All of their sessions were ended.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
