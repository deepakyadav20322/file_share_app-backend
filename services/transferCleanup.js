const cron = require('node-cron');
const Transfer = require('../models/transfer');
const storage = require('./storage');
const PendingUpload = require('../models/pendingUpload');

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

// Every 10 minutes: direct-to-S3 uploads started more than 2 hours ago and never finished (tab closed,
// connection lost) are aborted, so their parts do not stay in S3.
const STALE_MS = 2 * 60 * 60 * 1000;
async function cleanupStaleUploads() {
  try {
    const stale = await PendingUpload.find({ createdAt: { $lte: new Date(Date.now() - STALE_MS) } }).limit(200);
    for (const p of stale) {
      const provider = storage.get('s3');
      await Promise.all(p.files.map((f) => provider.abortDirect(f.storageKey, f.uploadId)));
      await PendingUpload.deleteOne({ _id: p._id });
    }
    if (stale.length) console.log(`Aborted ${stale.length} unfinished upload(s).`);
  } catch (error) {
    console.error('Unfinished upload cleanup failed:', error);
  }
}

module.exports = () => {
  cron.schedule('* * * * *', cleanupExpiredTransfers);
  cron.schedule('*/10 * * * *', cleanupStaleUploads);
};
module.exports.removeTransfer = removeTransfer; // also used by the admin "Delete files now" button

module.exports.cleanupStaleUploads = cleanupStaleUploads; // run by the 10-minute job; exported for tests
