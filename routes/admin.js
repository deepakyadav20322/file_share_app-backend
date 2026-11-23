const router = require('express').Router();
const mongoose = require('mongoose');
const AdminAudit = require('../models/adminAudit');
const ContactMessage = require('../models/contactMessage');
const Transfer = require('../models/transfer');
const { removeTransfer } = require('../services/transferCleanup');
const settings = require('../services/settings');
const auth = require('../services/auth');
const { clientKey } = require('../services/rateLimit');

// Every route below needs a valid access token of a user with the admin role (see services/auth.js).
router.use(auth.requireAuth, auth.requireRole('admin'));

const recentAudit = () =>
  AdminAudit.find().sort({ createdAt: -1 }).limit(10).select('-__v').lean();

router.get('/config', async (req, res) => {
  try {
    res.json({
      user: { username: req.user.username, role: req.user.role },
      definitions: settings.DEFINITIONS,
      values: await settings.load(true),
      audit: await recentAudit(),
      openMessages: await ContactMessage.countDocuments({ status: 'open' }),
    });
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Saving also asks for the ID and password again (step-up check), on top of the access token.
router.put('/config', auth.requireStepUp, async (req, res) => {
  const { changes, errors } = settings.validate(req.body?.values);
  if (errors.length) return res.status(422).json({ error: errors.join('. ') });

  try {
    const { values, diff } = await settings.save(changes);
    if (diff.length) {
      await AdminAudit.create({ ip: clientKey(req.ip), by: req.user.username, changes: diff });
      console.log(`Admin ${req.user.username} changed settings:`, diff.map((d) => `${d.key}: ${d.from} -> ${d.to}`).join(', '));
    }
    res.json({ values, audit: await recentAudit() });
  } catch (e) {
    console.error('Admin save failed:', e);
    res.status(500).json({ error: 'Could not save.' });
  }
});

// ---- Contact messages ---------------------------------------------------------------------------------
const PAGE_SIZE = 20;

// What happened to the transfer a message points at (only for Remove a file / Report abuse).
// Keys are reused after a transfer is gone, so take the newest transfer created before the message.
const findTransferFor = (key, before) => Transfer.findOne({ key, createdAt: { $lte: before } }).sort({ createdAt: -1 });

async function transferInfo(key, before) {
  if (!key) return null;
  const t = await findTransferFor(key, before).select('fileCount totalSize expiresAt deletedAt createdAt').lean();
  if (!t) return { status: 'not found' };
  const status = t.deletedAt ? 'deleted' : t.expiresAt <= new Date() ? 'expired' : 'active';
  return { status, fileCount: t.fileCount, totalSize: t.totalSize, createdAt: t.createdAt, expiresAt: t.expiresAt, deletedAt: t.deletedAt };
}

// List with filters: ?topic=Feedback&status=open&page=1 (all optional).
router.get('/messages', async (req, res) => {
  const filter = {};
  if (ContactMessage.TOPICS.includes(req.query.topic)) filter.topic = req.query.topic;
  if (['open', 'done'].includes(req.query.status)) filter.status = req.query.status;
  const page = Math.max(1, Math.min(1000, parseInt(req.query.page, 10) || 1));

  try {
    const [items, total, byTopic, byStatus] = await Promise.all([
      ContactMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).select('-__v').lean(),
      ContactMessage.countDocuments(filter),
      // Counts for the filter chips: per topic within the chosen status, and per status within the chosen topic.
      ContactMessage.aggregate([{ $match: filter.status ? { status: filter.status } : {} }, { $group: { _id: '$topic', n: { $sum: 1 } } }]),
      ContactMessage.aggregate([{ $match: filter.topic ? { topic: filter.topic } : {} }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    for (const m of items) m.transfer = await transferInfo(m.fileKey, m.createdAt);
    res.json({
      items,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      counts: {
        topic: Object.fromEntries(byTopic.map((c) => [c._id, c.n])),
        status: Object.fromEntries(byStatus.map((c) => [c._id, c.n])),
      },
    });
  } catch (e) {
    console.error('Admin messages failed:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Mark a message done (with an optional note) or open it again: { done: true, note: "Files deleted" }.
router.patch('/messages/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
  const done = req.body?.done === true;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
  const update = done
    ? { status: 'done', doneAt: new Date(), doneBy: req.user.username, doneNote: note }
    : { status: 'open', doneAt: null, doneBy: '', doneNote: '' };

  try {
    const message = await ContactMessage.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).select('-__v').lean();
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    message.transfer = await transferInfo(message.fileKey, message.createdAt);
    res.json({ message });
  } catch (e) {
    res.status(500).json({ error: 'Could not update the message.' });
  }
});

// "Delete files now" on a Remove a file / Report abuse message: removes that transfer's files from storage
// at once and stops the key working. Only the transfer named in the message can be deleted this way.
router.post('/messages/:id/delete-transfer', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Message not found.' });
  try {
    const message = await ContactMessage.findById(req.params.id).lean();
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (!message.fileKey) return res.status(400).json({ error: 'This message has no transfer key.' });

    const transfer = await findTransferFor(message.fileKey, message.createdAt);
    if (!transfer) return res.status(404).json({ error: 'No transfer with this key was found.' });
    if (transfer.deletedAt) return res.status(409).json({ error: 'These files are already deleted.' });

    await removeTransfer(transfer);
    console.log(`Admin ${req.user.username} deleted transfer ${transfer.key} (${transfer.files.length} file(s)) from message ${message._id}.`);
    res.json({ message: { ...message, transfer: await transferInfo(message.fileKey, message.createdAt) } });
  } catch (e) {
    console.error('Admin delete transfer failed:', e);
    res.status(500).json({ error: 'Could not delete the files.' });
  }
});

module.exports = router;
