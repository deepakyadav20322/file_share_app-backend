const express = require('express');
const Transfer = require('../models/transfer');
const limits = require('../config/limits');

const router = express.Router();
const DAYS = 14;
const CACHE_MS = 30 * 1000;
let cache = null;

const filesIn = { $ifNull: ['$fileCount', { $size: '$files' }] };

async function compute() {
  const now = new Date();
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (DAYS - 1));

  const [totals] = await Transfer.aggregate([
    {
      $group: {
        _id: null,
        created: { $sum: 1 },
        deleted: { $sum: { $cond: [{ $ne: ['$deletedAt', null] }, 1, 0] } },
        filesShared: { $sum: filesIn },
        filesDeleted: { $sum: { $cond: [{ $ne: ['$deletedAt', null] }, filesIn, 0] } },
        bytesShared: { $sum: '$totalSize' },
        since: { $min: '$createdAt' },
      },
    },
  ]);

  const [live] = await Transfer.aggregate([
    { $match: { deletedAt: null } },
    { $group: { _id: null, transfers: { $sum: 1 }, files: { $sum: filesIn }, oldest: { $min: '$createdAt' } } },
  ]);

  const dayKey = (d) => d.toISOString().slice(0, 10);
  const [created, removed] = await Promise.all([
    Transfer.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    ]),
    Transfer.aggregate([
      { $match: { deletedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$deletedAt' } }, n: { $sum: 1 } } },
    ]),
  ]);
  const c = Object.fromEntries(created.map((r) => [r._id, r.n]));
  const r = Object.fromEntries(removed.map((x) => [x._id, x.n]));
  const daily = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: dayKey(d), created: c[dayKey(d)] || 0, deleted: r[dayKey(d)] || 0 };
  });

  const t = totals || {};
  const l = live || {};
  return {
    transfersCreated: t.created || 0,
    transfersDeleted: t.deleted || 0,
    filesShared: t.filesShared || 0,
    filesDeleted: t.filesDeleted || 0,
    bytesShared: t.bytesShared || 0,
    storedTransfers: l.transfers || 0,
    storedFiles: l.files || 0,
    oldestStoredMinutes: l.oldest ? Math.max(0, Math.round((now - l.oldest) / 60000)) : 0,
    maxExpiryMinutes: limits.maxExpiryMinutes,
    since: t.since || null,
    daily,
    updatedAt: now,
  };
}

// Public, read-only, and contains only counts: no keys, names or anything about individual transfers.
router.get('/', async (req, res) => {
  try {
    // ?fresh=1 skips the cache (used by the Refresh button) but is throttled to one recompute per 3 s.
    const maxAge = req.query.fresh ? 3000 : CACHE_MS;
    if (!cache || Date.now() - cache.at > maxAge) cache = { at: Date.now(), data: await compute() };
    res.json(cache.data);
  } catch (e) {
    console.error('Stats failed:', e);
    res.status(500).json({ error: 'Could not load statistics.' });
  }
});

module.exports = router;
