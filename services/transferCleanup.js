const cron = require('node-cron');
const Transfer = require('../models/transfer');
const storage = require('./storage');

// Deletes one transfer's files from storage (disk or S3). The database row is kept and flagged with
// deletedAt so public statistics survive; file names are scrubbed, only counts remain. The expiry is
// moved to now (if later), so the key stops working at once.
async function removeTransfer(transfer) {
  const provider = storage.get(transfer.storage);
  await Promise.all(transfer.files.map((f) => provider.remove(f.storageKey)));
  const now = new Date();
  await Transfer.updateOne(
    { _id: transfer._id },
    {
      $set: {
        deletedAt: now,
        expiresAt: transfer.expiresAt < now ? transfer.expiresAt : now,
        fileCount: transfer.fileCount ?? transfer.files.length,
        files: [],
      },
    }
  );
}

// Every minute: remove transfers whose time is up.
async function cleanupExpiredTransfers() {
  try {
    const expired = await Transfer.find({ expiresAt: { $lte: new Date() }, deletedAt: null });
    for (const transfer of expired) await removeTransfer(transfer);
    if (expired.length) console.log(`Cleaned up ${expired.length} expired transfer(s).`);
  } catch (error) {
    console.error('Transfer cleanup failed:', error);
  }
}

module.exports = () => cron.schedule('* * * * *', cleanupExpiredTransfers);
module.exports.removeTransfer = removeTransfer; // also used by the admin "Delete files now" button
