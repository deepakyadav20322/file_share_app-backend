const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const File = require('../models/file');
const { v4: uuidv4 } = require('uuid');
const limits = require('../config/limits');
const rateLimit = require('../services/rateLimit');
const capacity = require('../services/capacity');
const guard = require('../services/abuseGuard');
const settings = require('../services/settings');

const MAX_CLASSIC_SIZE = 1000000 * 100; // 100mb

let storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/') ,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
              cb(null, uniqueName)
    } ,
});

let upload = multer({
    storage,
    limits: { fileSize: MAX_CLASSIC_SIZE, files: 1, fields: 2, fieldSize: 1024, parts: 4 },
    fileFilter: (req, file, cb) => {
        if (guard.isBlockedName(file.originalname)) {
            const e = new Error(`Files of type .${guard.extensionOf(file.originalname)} are not allowed.`);
            e.code = 'BLOCKED_TYPE';
            return cb(e);
        }
        cb(null, true);
    },
}).single('myfile');

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: limits.classicUploadsPerHour,
    message: 'Upload limit reached for now. Please try again in a while.',
});
const sendLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: limits.emailsPerHour,
    message: 'You have sent several emails already. Please try again later.',
});

router.post('/', uploadLimiter, async (req, res) => {
    if (!(await settings.get('uploadsEnabled'))) {
        return res.status(503).send({ error: 'Sending is paused for maintenance. Please try again soon.' });
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_CLASSIC_SIZE + 1000000) {
        res.set('Connection', 'close');
        return res.status(413).send({ error: 'File is too large (100 MB maximum).' });
    }
    const release = await capacity.reserve(Number.isFinite(declared) && declared > 0 ? declared : MAX_CLASSIC_SIZE);
    if (!release) return res.status(503).send({ error: 'SendAnyFile is full at the moment. Please try again later.' });
    res.on('close', release);

    upload(req, res, async (err) => {
      if (err) {
        if (err.code === 'BLOCKED_TYPE') return res.status(415).send({ error: err.message });
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send({ error: 'File is too large (100 MB maximum).' });
        return res.status(400).send({ error: 'This upload is not valid.' });
      }
      if (!req.file) return res.status(400).send({ error: 'Please choose a file.' });
      try {
        const file = new File({
            filename: req.file.filename,
            uuid: uuidv4(),
            path: req.file.path,
            size: req.file.size
        });
        const response = await file.save();
        res.status(200).json({ file: `${process.env.LIVE_APP_BASE_URL}/files/${response.uuid}` });
      } catch (e) {
        console.error('Classic upload failed:', e);
        res.status(500).send({ error: 'Something went wrong.' });
      }
    });
});

router.post('/send', sendLimiter, async (req, res) => {
  if (!(await settings.get('emailEnabled'))) {
    return res.status(503).send({ error: 'Email sharing is switched off right now. Share the link instead.' });
  }
  const { uuid, emailTo, emailFrom } = req.body || {};
  if (!guard.isUuid(uuid) || !guard.isEmail(emailTo) || !guard.isEmail(emailFrom)) {
      return res.status(422).send({ error: 'Please enter valid sender and receiver emails.'});
  }
  try {
    const file = await File.findOne({ uuid: uuid });
    if (!file) return res.status(404).send({ error: 'Link has been expired.' });
    if (file.receiver) {
      return res.status(200).json({ message: 'Email already sent once.'});
    }

    const blocked = guard.checkMailBudget(req, emailTo);
    if (blocked) return res.status(429).send({ error: blocked });

    // Claim the single email atomically so parallel requests cannot send it twice.
    const claim = await File.updateOne({ _id: file._id, receiver: { $in: ['', null] } }, { $set: { sender: emailFrom, receiver: emailTo } });
    if (claim.modifiedCount !== 1) return res.status(200).json({ message: 'Email already sent once.'});

    const sendMail = require('../services/mailService');
    try {
      await sendMail({
        to: emailTo,
        replyTo: emailFrom,
        subject: 'SendAnyFile file sharing',
        text: `${emailFrom} shared a file with you. SendAnyFile does not verify the sender, so only open files from people you know.`,
        html: require('../services/emailTemplate')({
                  emailFrom,
                  downloadLink: `${process.env.LIVE_APP_BASE_URL}/files/${file.uuid}?source=email` ,
                  size: parseInt(file.size/1000) + ' KB',
                  expires: '24 hours'
              })
      });
      return res.status(200).json({success: true,message:'Email send successfully'});
    } catch (mailErr) {
      console.error('Classic email failed:', mailErr);
      await File.updateOne({ _id: file._id }, { $set: { sender: '', receiver: '' } }).catch(() => {});
      return res.status(500).json({error: 'Error in email sending.'});
    }
  } catch(err) {
    return res.status(500).send({ error: 'Something went wrong.'});
  }
});

module.exports = router;
