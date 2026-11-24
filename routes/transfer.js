const router = require('express').Router();
const multer = require('multer');
const archiverLib = require('archiver');
// archiver 7 exports a function, archiver 8 exports classes; support both.
const createZip = (options) =>
  typeof archiverLib === 'function' ? archiverLib('zip', options) : new archiverLib.ZipArchive(options);
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Transfer = require('../models/transfer');
const limits = require('../config/limits');
const storage = require('../services/storage');
const rateLimit = require('../services/rateLimit');
const { clientKey } = rateLimit;
const capacity = require('../services/capacity');
const guard = require('../services/abuseGuard');
const settings = require('../services/settings');
const uploadProgress = require('../services/uploadProgress');
const PendingUpload = require('../models/pendingUpload');

const MB = 1024 * 1024;
const fmtMB = (bytes) => `${+(bytes / MB).toFixed(2)} MB`;

const decodeName = (name) => guard.safeFileName(Buffer.from(String(name), 'latin1').toString('utf8'));

// Files are small by design (see config/limits.js), so they are buffered in memory
// and handed to whichever storage provider is active.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // +1 so a file of exactly the limit is accepted (multer rejects at >=); the exact check is below.
    fileSize: limits.maxFileSize + 1,
    files: limits.maxFiles,
    // Only expiryMinutes and maxDownloads are expected as text fields; refuse floods of extra fields/parts.
    fields: 4,
    fieldSize: 1024,
    fieldNameSize: 50,
    parts: limits.maxFiles + 4,
    headerPairs: 30,
  },
  fileFilter: (req, file, cb) => {
    const name = decodeName(file.originalname);
    if (guard.isBlockedName(name)) {
      const e = new Error(`Files of type .${guard.extensionOf(name)} are not allowed.`);
      e.code = 'BLOCKED_TYPE';
      return cb(e);
    }
    cb(null, true);
  },
}).array('files', limits.maxFiles);

const HOUR = 60 * 60 * 1000;
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// The page asks how far saving has got about twice a second while an upload finishes.
const progressLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });
const zipLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, message: 'Too many zip downloads. Please wait a minute.' });
const uploadLimiter = rateLimit({
  windowMs: HOUR,
  max: limits.uploadsPerHour,
  message: 'Upload limit reached for now. Please try again in a while.',
});
const uploadGate = guard.gate(limits.maxConcurrentUploads);
const zipGate = guard.gate(limits.maxConcurrentZips);

async function generateKey() {
  for (let i = 0; i < 10; i++) {
    const key = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const taken = await Transfer.exists({ key, expiresAt: { $gt: new Date() } });
    if (!taken) return key;
  }
  throw new Error('Could not generate a unique key');
}

const findActive = (key) =>
  /^\d{6}$/.test(key) ? Transfer.findOne({ key, expiresAt: { $gt: new Date() } }) : null;

// Downloads are counted per file: a zip counts once for every file in it. A file is gone for
// good once it has been downloaded `maxDownloads` times.
const cap = (t) => t.maxDownloads || limits.defaultDownloads;
const fileLeft = (t, f) => Math.max(0, cap(t) - (f.downloads || 0));

const publicView = (t) => ({
  key: t.key,
  expiresAt: t.expiresAt,
  totalSize: t.totalSize,
  maxDownloads: cap(t),
  // Best case for the receiver: the most downloads any single file still has.
  downloadsLeft: Math.max(0, ...t.files.map((f) => fileLeft(t, f))),
  files: t.files.map((f, index) => ({ index, name: f.originalName, size: f.size, downloadsLeft: fileLeft(t, f) })),
});

// Atomic claims, so parallel requests cannot download past the limit.
const claimFile = async (t, index) => {
  const path = `files.${index}.downloads`;
  const r = await Transfer.updateOne({ _id: t._id, [path]: { $not: { $gte: cap(t) } } }, { $inc: { [path]: 1 } });
  return r.modifiedCount === 1;
};
const claimAll = async (t) => {
  const r = await Transfer.updateOne(
    { _id: t._id, files: { $not: { $elemMatch: { downloads: { $gte: cap(t) } } } } },
    { $inc: { 'files.$[].downloads': 1 } }
  );
  return r.modifiedCount === 1;
};

// Looks up an active transfer; wrong or expired keys count towards the sender's lockout.
const lookup = async (req, res) => {
  const transfer = await findActive(req.params.key);
  if (!transfer) {
    guard.keyFailed(req);
    res.status(404).json({ error: 'Key is invalid or has expired.' });
    return null;
  }
  return transfer;
};

// Limits for the frontend, so they are configured in one place only (.env).
router.get('/config', async (req, res) => {
  const flags = await settings.load();
  res.json({
    features: { email: flags.emailEnabled, contact: flags.contactEnabled, uploads: flags.uploadsEnabled },
    maxFiles: limits.maxFiles,
    maxFileSize: limits.maxFileSize,
    maxTotalSize: limits.maxTotalSize,
    expiryMinutes: limits.defaultExpiryMinutes,
    maxDownloads: limits.maxDownloads,
    defaultDownloads: limits.defaultDownloads,
    expiryOptions: limits.expiryOptionsMinutes,
    maxExpiryMinutes: limits.maxExpiryMinutes,
    blockedExtensions: limits.blockedExtensions,
    storage: storage.current(), // 's3' means saving takes a second step after the upload
    directUpload: storage.current() === 's3', // browser uploads straight to S3 (see /direct/* below)
  });
});

// How much of the saving step is done (0-100). Unknown ids answer 0.
router.get('/progress/:id', progressLimiter, (req, res) => {
  res.json({ percent: uploadProgress.percent(req.params.id) ?? 0 });
});

// ---------------------------------------------------------------------------------------------------
// Direct upload (S3 only): the browser sends the file bytes straight to S3, so the server never holds
// them. 1) /direct/start checks the files and returns signed part links, 2) the browser uploads the parts,
// 3) /direct/complete checks what arrived and creates the transfer. /direct/abort cancels.
// ---------------------------------------------------------------------------------------------------
const LINK_SECONDS = 30 * 60; // signed part links stay valid long enough for a slow connection
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const directLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// Same rules as the normal upload, applied to the file list the browser declares.
function checkDeclared(body) {
  const list = Array.isArray(body?.files) ? body.files : [];
  if (!list.length) return { status: 400, error: 'Please add at least one file.' };
  if (list.length > limits.maxFiles) return { status: 413, error: `You can send at most ${limits.maxFiles} files at a time.` };

  const files = [];
  for (const f of list) {
    const name = guard.safeFileName(typeof f?.name === 'string' ? f.name : '');
    const size = Number(f?.size);
    if (!name || !Number.isInteger(size) || size < 0) return { status: 400, error: 'This upload is not valid.' };
    if (size === 0) return { status: 400, error: `${name} is empty.` };
    if (guard.isBlockedName(name)) return { status: 415, error: `Files of type .${guard.extensionOf(name)} are not allowed.` };
    if (size > limits.maxFileSize) return { status: 413, error: `Each file must be ${fmtMB(limits.maxFileSize)} or smaller.` };
    files.push({ name, size, mimeType: guard.safeMime(typeof f?.type === 'string' ? f.type : '') });
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > limits.maxTotalSize) return { status: 413, error: `Total size must be ${fmtMB(limits.maxTotalSize)} or smaller.` };

  const rawExpiry = body.expiryMinutes;
  const expiryMinutes = rawExpiry === undefined ? limits.defaultExpiryMinutes : Number(rawExpiry);
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > limits.maxExpiryMinutes) {
    return { status: 400, error: `Expiry must be between 1 minute and ${limits.maxExpiryMinutes / 60} hours.` };
  }
  const rawDl = body.maxDownloads;
  const maxDownloads = rawDl === undefined ? limits.defaultDownloads : /^[1-5]$/.test(String(rawDl)) ? Number(rawDl) : NaN;
  if (!Number.isInteger(maxDownloads) || maxDownloads > limits.maxDownloads) {
    return { status: 400, error: `Downloads must be a number from 1 to ${limits.maxDownloads}.` };
  }
  return { files, totalSize, expiryMinutes, maxDownloads };
}

router.post('/direct/start', uploadLimiter, async (req, res) => {
  if (storage.current() !== 's3') return res.status(400).json({ error: 'Direct upload is not available.' });
  if (!(await settings.get('uploadsEnabled'))) {
    return res.status(503).json({ error: 'Sending is paused for maintenance. Please try again soon.' });
  }
  const checked = checkDeclared(req.body);
  if (checked.error) return res.status(checked.status).json({ error: checked.error });

  // Room check, counting uploads that are still in progress too.
  const [pending] = await PendingUpload.aggregate([{ $group: { _id: null, b: { $sum: '$totalSize' } } }]);
  const release = await capacity.reserve(checked.totalSize + (pending?.b || 0));
  if (!release) return res.status(503).json({ error: 'SendAnyFile is full at the moment. Please try again later.' });
  release();

  const provider = storage.get('s3');
  const started = [];
  try {
    const answer = [];
    for (const f of checked.files) {
      const ext = path.extname(f.name).toLowerCase();
      const storageKey = `${uuidv4()}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
      const { uploadId, parts } = await provider.startDirect(storageKey, f.size, f.mimeType, LINK_SECONDS);
      started.push({ ...f, storageKey, uploadId });
      answer.push({ parts });
    }
    const token = crypto.randomBytes(24).toString('base64url');
    await PendingUpload.create({
      tokenHash: sha256(token),
      ip: clientKey(req.ip),
      files: started,
      totalSize: checked.totalSize,
      expiryMinutes: checked.expiryMinutes,
      maxDownloads: checked.maxDownloads,
    });
    res.status(201).json({ uploadToken: token, files: answer });
  } catch (e) {
    console.error('Direct upload start failed:', e);
    await Promise.all(started.map((f) => provider.abortDirect(f.storageKey, f.uploadId)));
    res.status(500).json({ error: 'Could not start the upload. Please try again.' });
  }
});

router.post('/direct/complete', directLimiter, async (req, res) => {
  const token = typeof req.body?.uploadToken === 'string' ? req.body.uploadToken : '';
  // Taken (and removed) in one step, so a second "done" for the same upload cannot create a second transfer.
  const pending = token ? await PendingUpload.findOneAndDelete({ tokenHash: sha256(token) }) : null;
  if (!pending) return res.status(404).json({ error: 'This upload has expired. Please try again.' });

  const provider = storage.get('s3');
  const joined = [];
  try {
    for (const f of pending.files) {
      const sizes = Array.from({ length: Math.max(1, Math.ceil(f.size / provider.partSize)) }, (_, i) =>
        Math.min(provider.partSize, f.size - i * provider.partSize)
      );
      const finalSize = await provider.finishDirect(f.storageKey, f.uploadId, sizes);
      joined.push(f.storageKey);
      if (finalSize !== f.size) throw Object.assign(new Error('Size mismatch'), { code: 'PART_MISMATCH' });
    }

    const transfer = await Transfer.create({
      key: await generateKey(),
      storage: 's3',
      files: pending.files.map((f) => ({ originalName: f.name, storageKey: f.storageKey, size: f.size, mimeType: f.mimeType })),
      fileCount: pending.files.length,
      totalSize: pending.totalSize,
      maxDownloads: pending.maxDownloads,
      expiresAt: new Date(Date.now() + pending.expiryMinutes * 60 * 1000),
    });
    res.status(201).json(publicView(transfer));
  } catch (e) {
    // Nothing half-finished is kept: joined files are deleted, the others are aborted.
    await Promise.all(
      pending.files.map((f) =>
        joined.includes(f.storageKey) ? provider.remove(f.storageKey) : provider.abortDirect(f.storageKey, f.uploadId)
      )
    );
    if (e.code === 'PART_MISMATCH' || e.name === 'NoSuchUpload' || e.name === 'InvalidPart') {
      return res.status(400).json({ error: 'The upload did not finish correctly. Please try again.' });
    }
    console.error('Direct upload complete failed:', e);
    res.status(500).json({ error: 'Could not store the files. Please try again.' });
  }
});

router.post('/direct/abort', directLimiter, async (req, res) => {
  const token = typeof req.body?.uploadToken === 'string' ? req.body.uploadToken : '';
  const pending = token ? await PendingUpload.findOneAndDelete({ tokenHash: sha256(token) }) : null;
  if (pending) {
    const provider = storage.get('s3');
    await Promise.all(pending.files.map((f) => provider.abortDirect(f.storageKey, f.uploadId)));
  }
  res.json({ success: true });
});

router.post('/', uploadLimiter, async (req, res) => {
  if (!(await settings.get('uploadsEnabled'))) {
    return res.status(503).json({ error: 'Sending is paused for maintenance. Please try again soon.' });
  }
  // Refuse oversized bodies up front, before reading them into memory.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limits.maxTotalSize + MB) {
    res.set('Connection', 'close');
    return res.status(413).json({ error: `Total size must be ${fmtMB(limits.maxTotalSize)} or smaller.` });
  }

  if (!uploadGate.enter(res)) {
    res.set('Retry-After', '10');
    return res.status(503).json({ error: 'SendAnyFile is busy right now. Please try again in a few seconds.' });
  }
  const release = await capacity.reserve(Number.isFinite(declared) && declared > 0 ? declared : limits.maxTotalSize);
  if (!release) {
    return res.status(503).json({ error: 'SendAnyFile is full at the moment. Please try again later.' });
  }
  res.on('close', release);

  upload(req, res, async (err) => {
    if (err) {
      if (err.code === 'BLOCKED_TYPE') return res.status(415).json({ error: err.message });
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `Each file must be ${fmtMB(limits.maxFileSize)} or smaller.`
            : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
            ? `You can send at most ${limits.maxFiles} files at a time.`
            : 'This upload is not valid.';
        return res.status(413).json({ error: message });
      }
      return res.status(400).json({ error: 'This upload is not valid.' });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Please add at least one file.' });
    if (files.some((f) => f.size > limits.maxFileSize)) {
      return res.status(413).json({ error: `Each file must be ${fmtMB(limits.maxFileSize)} or smaller.` });
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > limits.maxTotalSize) {
      return res.status(413).json({ error: `Total size must be ${fmtMB(limits.maxTotalSize)} or smaller.` });
    }

    // Sender-chosen expiry: any whole number of minutes from 1 up to the configured maximum.
    const rawExpiry = req.body?.expiryMinutes;
    const expiryMinutes =
      rawExpiry === undefined ? limits.defaultExpiryMinutes : typeof rawExpiry === 'string' ? Number(rawExpiry) : NaN;
    if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > limits.maxExpiryMinutes) {
      return res.status(400).json({ error: `Expiry must be between 1 minute and ${limits.maxExpiryMinutes / 60} hours.` });
    }

    // How many times each file may be downloaded: a single digit from 1 to the configured maximum (5).
    const rawDl = req.body?.maxDownloads;
    const maxDownloads = rawDl === undefined ? limits.defaultDownloads : /^[1-5]$/.test(rawDl) ? Number(rawDl) : NaN;
    if (!Number.isInteger(maxDownloads) || maxDownloads > limits.maxDownloads) {
      return res.status(400).json({ error: `Downloads must be a number from 1 to ${limits.maxDownloads}.` });
    }

    const provider = storage.get(storage.current());
    const saved = [];
    const track = uploadProgress.start(req.get('x-upload-id'), totalSize);
    let doneBytes = 0;
    try {
      for (const f of files) {
        // The sender pressed Cancel while saving: stop and tidy up instead of creating a transfer nobody sees.
        if (res.destroyed) throw Object.assign(new Error('cancelled'), { cancelled: true });
        const name = decodeName(f.originalname);
        const ext = path.extname(name).toLowerCase();
        const storageKey = `${uuidv4()}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
        const before = doneBytes;
        await provider.save(storageKey, f.buffer, f.mimetype, (loaded) => track.update(before + Math.min(loaded, f.size)));
        doneBytes += f.size;
        track.update(doneBytes);
        saved.push({
          originalName: name,
          storageKey,
          size: f.size,
          mimeType: guard.safeMime(f.mimetype),
        });
      }

      if (res.destroyed) throw Object.assign(new Error('cancelled'), { cancelled: true });
      track.finish();
      const transfer = await Transfer.create({
        key: await generateKey(),
        storage: provider.name,
        files: saved,
        fileCount: saved.length,
        totalSize,
        maxDownloads,
        expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
      });
      res.status(201).json(publicView(transfer));
    } catch (e) {
      if (!e.cancelled) console.error('Transfer upload failed:', e);
      await Promise.all(saved.map((s) => provider.remove(s.storageKey)));
      if (e.cancelled) return;
      res.status(500).json({ error: 'Could not store the files. Please try again.' });
    }
  });
});

router.get('/:key', lookupLimiter, guard.keyGuard, async (req, res) => {
  try {
    const transfer = await lookup(req, res);
    if (transfer) res.json(publicView(transfer));
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Public URL of the frontend, used for the link inside emails (never taken from the client).
const frontendUrl = () =>
  (process.env.FRONTEND_URL || (process.env.ALLOWED_CLIENTS || '').split(',')[0] || 'http://localhost:3001')
    .trim()
    .replace(/\/$/, '');

const MAX_EMAILS_PER_TRANSFER = 3;

router.post('/:key/email', lookupLimiter, guard.keyGuard, async (req, res) => {
  if (!(await settings.get('emailEnabled'))) {
    return res.status(503).json({ error: 'Email sharing is switched off right now. Share the key or link instead.' });
  }
  const { emailFrom, emailTo } = req.body || {};
  if (!guard.isEmail(emailFrom) || !guard.isEmail(emailTo)) {
    return res.status(422).json({ error: 'Please enter valid sender and receiver emails.' });
  }

  let claimed = null;
  try {
    const transfer = await lookup(req, res);
    if (!transfer) return;

    const blocked = guard.checkMailBudget(req, emailTo);
    if (blocked) return res.status(429).json({ error: blocked });

    // Claim one of the transfer's emails atomically so parallel requests cannot exceed the cap.
    claimed = await Transfer.updateOne(
      { _id: transfer._id, emailsSent: { $lt: MAX_EMAILS_PER_TRANSFER } },
      { $inc: { emailsSent: 1 } }
    );
    if (claimed.modifiedCount !== 1) {
      claimed = null;
      return res.status(429).json({ error: 'Email limit reached for this transfer.' });
    }

    const minutesLeft = Math.max(1, Math.round((transfer.expiresAt - Date.now()) / 60000));
    await require('../services/mailService')({
      to: emailTo,
      replyTo: emailFrom,
      subject: 'SendAnyFile file sharing',
      text: `${emailFrom} shared ${transfer.files.length} file(s) with you. SendAnyFile does not verify the sender, so only open files from people you know.`,
      html: require('../services/emailTemplate')({
        emailFrom,
        downloadLink: `${frontendUrl()}/receive/${transfer.key}`,
        size: `${transfer.files.length} file(s), ${parseInt(transfer.totalSize / 1000)} KB`,
        expires: `${minutesLeft} minute${minutesLeft > 1 ? 's' : ''} (or use key ${transfer.key})`,
      }),
    });
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (e) {
    console.error('Transfer email failed:', e);
    // Give the claimed email back if nothing was sent.
    if (claimed) await Transfer.updateOne({ key: req.params.key, emailsSent: { $gt: 0 } }, { $inc: { emailsSent: -1 } }).catch(() => {});
    res.status(500).json({ error: 'Error in email sending.' });
  }
});

// Headers shared by every file response: never rendered, never sniffed, never cached.
const DOWNLOAD_LINK_SECONDS = 30; // a signed download link must be used within this time to start

const downloadHeaders = (res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
};

// All files of a transfer as one zip.
router.get('/:key/zip', zipLimiter, guard.keyGuard, async (req, res) => {
  try {
    const transfer = await lookup(req, res);
    if (!transfer) return;
    if (!zipGate.enter(res)) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Too many zips are being prepared. Please try again in a moment.' });
    }
    // Prepared before the downloads are counted, so a setup error never uses up anyone's downloads.
    const provider = storage.get(transfer.storage);
    const archive = createZip({ zlib: { level: 6 } });
    if (!(await claimAll(transfer))) {
      return res.status(429).json({ error: 'Some files have used all their downloads. Download the remaining files one by one.' });
    }

    archive.on('error', () => res.destroy());
    res.on('close', () => archive.abort()); // stop reading files when the client leaves
    downloadHeaders(res);
    res.attachment(`sendanyfile-${transfer.key}.zip`);
    archive.pipe(res);

    // Files may share a name, so number duplicates: report.pdf, report (1).pdf ...
    const used = new Map();
    for (const f of transfer.files) {
      const clean = guard.safeFileName(f.originalName);
      const count = used.get(clean) || 0;
      used.set(clean, count + 1);
      const { name, ext } = path.parse(clean);
      const entryName = count ? `${name} (${count})${ext}` : clean;
      archive.append(await provider.read(f.storageKey), { name: entryName });
    }
    await archive.finalize();
  } catch (e) {
    console.error('Transfer zip failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Could not create the zip.' });
    else res.destroy();
  }
});

router.get('/:key/files/:index', lookupLimiter, guard.keyGuard, async (req, res) => {
  try {
    const transfer = await lookup(req, res);
    if (!transfer) return;
    const file = /^\d{1,2}$/.test(req.params.index) ? transfer.files[Number(req.params.index)] : null;
    if (!file) return res.status(404).json({ error: 'File not found or the key has expired.' });

    // HEAD only asks about the file (link checkers, some download managers): answer, but never count it.
    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', guard.safeMime(file.mimeType));
      res.setHeader('Content-Length', file.size);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end();
    }

    if (!(await claimFile(transfer, Number(req.params.index)))) {
      return res.status(429).json({ error: 'This file has already been downloaded the allowed number of times.' });
    }

    // S3: send the browser straight to S3 with a 30-second signed link, so the bytes never pass through
    // this server. The download was counted above, and the link itself is never shown on any page.
    const provider = storage.get(transfer.storage);
    if (provider.downloadUrl) {
      try {
        const url = await provider.downloadUrl(file.storageKey, guard.safeFileName(file.originalName), guard.safeMime(file.mimeType), DOWNLOAD_LINK_SECONDS);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.redirect(302, url);
      } catch (e) {
        console.error('Signed download link failed, streaming instead:', e.message);
      }
    }

    const stream = await provider.read(file.storageKey);
    downloadHeaders(res);
    res.attachment(guard.safeFileName(file.originalName));
    res.setHeader('Content-Type', guard.safeMime(file.mimeType));
    res.setHeader('Content-Length', file.size);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy()); // free the file handle if the client disconnects
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Could not read the file.' });
  }
});

module.exports = router;
