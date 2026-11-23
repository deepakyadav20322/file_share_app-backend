// How much disk space SendAnyFile is using, so uploads can be refused before the disk fills up.
const Transfer = require('../models/transfer');
const File = require('../models/file');
const limits = require('../config/limits');

let cache = { at: 0, bytes: 0 };
let inFlight = 0; // bytes of uploads currently being received

async function usedBytes() {
  if (Date.now() - cache.at < 10 * 1000) return cache.bytes;
  const [t] = await Transfer.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: null, b: { $sum: '$totalSize' } } }]);
  const [c] = await File.aggregate([{ $group: { _id: null, b: { $sum: '$size' } } }]);
  cache = { at: Date.now(), bytes: (t?.b || 0) + (c?.b || 0) };
  return cache.bytes;
}

// Reserves room for an incoming upload; returns a release() function, or null when there is no room.
async function reserve(bytes) {
  if (limits.maxStorageBytes) {
    if ((await usedBytes()) + inFlight + bytes > limits.maxStorageBytes) return null;
  }
  inFlight += bytes;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight -= bytes;
      cache.at = 0; // recount soon
    }
  };
}

module.exports = { reserve };
