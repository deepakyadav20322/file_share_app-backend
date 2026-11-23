const router = require('express').Router();
const rateLimit = require('../services/rateLimit');
const sendMail = require('../services/mailService');
const { counter, clientKey } = require('../services/rateLimit');
const { isEmail } = require('../services/abuseGuard');
const settings = require('../services/settings');
const ContactMessage = require('../models/contactMessage');

// Even many different IPs cannot flood the inbox: at most 100 messages a day overall.
const perDay = counter(24 * 60 * 60 * 1000);

// 5 messages per hour per IP keeps the form from being used to spam the inbox.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'You have sent several messages already. Please try again in a while.',
});

const { TOPICS } = ContactMessage;
const NEEDS_KEY = ['Remove a file', 'Report abuse']; // these topics must name the transfer (6-digit key)
const oneLine = (value, max) => (typeof value === 'string' ? value : '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
// Names go into a mail header, so drop characters that could add addresses or break the header.
const headerSafe = (value) => value.replace(/[<>",;()@[\]\\]/g, '').trim();

router.post('/', limiter, async (req, res) => {
  if (!(await settings.get('contactEnabled'))) {
    return res.status(503).json({ error: 'The contact form is switched off right now.' });
  }
  const { name, email, message, website, topic, fileKey } = req.body || {};

  // Hidden "website" field: real users never fill it, bots usually do. Pretend success.
  if (website) return res.json({ success: true });

  const cleanName = headerSafe(oneLine(name, 100));
  const cleanEmail = oneLine(email, 200);
  const cleanTopic = TOPICS.includes(topic) ? topic : 'Question';
  const cleanMessage = (typeof message === 'string' ? message : '').trim().slice(0, 2000);
  const needsKey = NEEDS_KEY.includes(cleanTopic);
  const cleanKey = typeof fileKey === 'string' ? fileKey.trim() : '';

  if (!cleanName || !isEmail(cleanEmail) || cleanMessage.length < 5) {
    return res.status(422).json({ error: 'Please enter your name, a valid email and a message.' });
  }
  if (needsKey && !/^\d{6}$/.test(cleanKey)) {
    return res.status(422).json({ error: 'Please enter the 6-digit key of the transfer.' });
  }

  if (perDay.hit('all') > 100) return res.status(429).json({ error: 'Messages are paused for today. Please try again tomorrow.' });

  // Saved first, so the message reaches the admin Messages page even if the e-mail copy fails.
  try {
    await ContactMessage.create({
      topic: cleanTopic,
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      fileKey: needsKey ? cleanKey : '',
      ip: clientKey(req.ip),
    });
  } catch (e) {
    console.error('Contact save failed:', e);
    return res.status(500).json({ error: 'Could not send your message. Please try again later.' });
  }

  // E-mail copy to the owner, sent in the background (skipped when no address is configured).
  const to = process.env.CONTACT_EMAIL || process.env.MAIL_USER;
  if (to) {
    const keyLine = needsKey ? `Transfer key: ${cleanKey}\n` : '';
    sendMail({
      replyTo: `${cleanName} <${cleanEmail}>`,
      to,
      subject: `SendAnyFile contact (${cleanTopic}): ${cleanName}`,
      text: `Topic: ${cleanTopic}\nFrom: ${cleanName} <${cleanEmail}>\n${keyLine}\n${cleanMessage}`,
    }).catch((e) => console.error('Contact mail failed (the message is saved):', e.message));
  }

  res.json({ success: true, message: 'Message sent. We will get back to you soon.' });
});

module.exports = router;
