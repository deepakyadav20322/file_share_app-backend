// Takedown tool for abuse reports: removes a transfer's files immediately and expires its key.
//   node scripts/remove-transfer.js 482917
// The row stays (flagged deleted, names cleared) so the public statistics remain correct.
require('dotenv').config();
const mongoose = require('mongoose');
const Transfer = require('../models/transfer');
const storage = require('../services/storage');

(async () => {
  const key = process.argv[2];
  if (!/^\d{6}$/.test(key || '')) {
    console.error('Usage: node scripts/remove-transfer.js <6-digit key>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_CONNECTION_URL);
  const transfers = await Transfer.find({ key, deletedAt: null });
  if (!transfers.length) console.log(`No stored transfer found for key ${key}.`);
  for (const t of transfers) {
    const provider = storage.get(t.storage);
    await Promise.all(t.files.map((f) => provider.remove(f.storageKey)));
    await Transfer.updateOne(
      { _id: t._id },
      { $set: { deletedAt: new Date(), expiresAt: new Date(), fileCount: t.fileCount ?? t.files.length, files: [] } }
    );
    console.log(`Removed ${t.files.length} file(s) of transfer ${key}.`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
