// Shared abuse controls: wrong-key lockouts, concurrency gates, mail budgets, safe names and addresses.
const path = require('path');
const limits = require('../config/limits');
const { counter, clientKey } = require('./rateLimit');

// ---- wrong 6-digit keys ----------------------------------------------------------------------
// Only FAILED lookups count. An IP that keeps guessing is locked out for the window, and while the
// whole site sees a burst of failures, any IP that has already failed once is blocked too, so a
// botnet cannot simply rotate addresses. Visitors with a clean record are never affected.
const ipFails = counter(10 * 60 * 1000);
const allFails = counter(60 * 1000);

const keyBlocked = (req) => {
  const mine = ipFails.peek(clientKey(req.ip));
  if (mine >= limits.keyFailuresPerIp) return true;
  const burst = allFails.peek('all');
  // Burst: IPs that already guessed wrong are blocked. Heavy attack (2x): everyone waits a minute,
  // which stops address-rotating bots even though it briefly pauses key lookups for real visitors.
  return burst >= limits.keyFailuresGlobalPerMinute * 2 || (mine >= 1 && burst >= limits.keyFailuresGlobalPerMinute);
};
const keyFailed = (req) => {
  ipFails.hit(clientKey(req.ip));
  allFails.hit('all');
};
const keyGuard = (req, res, next) =>
  keyBlocked(req) ? res.status(429).json({ error: 'Too many wrong keys. Please wait a few minutes and try again.' }) : next();

// ---- concurrency gate (memory / CPU protection) ----------------------------------------------
const gate = (max) => {
  let active = 0;
  return {
    // Returns false when full; otherwise the slot is released automatically when the response ends.
    enter(res) {
      if (active >= max) return false;
      active += 1;
      let left = false;
      const leave = () => {
        if (!left) {
          left = true;
          active -= 1;
        }
      };
      res.on('close', leave);
      res.on('finish', leave);
      return true;
    },
  };
};

// ---- mail budgets ----------------------------------------------------------------------------
const mailRecipient = counter(60 * 60 * 1000);
const mailDay = counter(24 * 60 * 60 * 1000);
const mailIp = counter(60 * 60 * 1000);

// Returns an error message when this mail must not be sent, otherwise null (and counts it).
const checkMailBudget = (req, to) => {
  if (mailIp.peek(clientKey(req.ip)) >= limits.emailsPerHour) return 'You have sent several emails already. Please try again later.';
  if (mailRecipient.peek(String(to).toLowerCase()) >= limits.emailsPerRecipientPerHour) return 'That address has received several emails already. Please try again later.';
  if (mailDay.peek('all') >= limits.emailsPerDay) return 'Email sending is paused for today. Share the key or link instead.';
  mailIp.hit(clientKey(req.ip));
  mailRecipient.hit(String(to).toLowerCase());
  mailDay.hit('all');
  return null;
};

// ---- validation helpers ----------------------------------------------------------------------
// Plain address only: no display names, commas, quotes or angle brackets that could add recipients
// or inject markup. Strings only (objects from JSON bodies are rejected).
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL.test(v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);

const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Control characters and bidi overrides (which make "photo‮gpj.exe" look like "photoexe.jpg").
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

const safeFileName = (name) => {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(BAD_CHARS, '').trim();
  const trimmed = base.replace(/^\.+$/, '').slice(0, 180);
  return trimmed || 'file';
};

const extensionOf = (name) => path.extname(name).slice(1).toLowerCase();
const isBlockedName = (name) => limits.blockedExtensions.includes(extensionOf(name));

const safeMime = (m) => (/^[\w.+-]{1,60}\/[\w.+-]{1,100}$/.test(m || '') ? m : 'application/octet-stream');

module.exports = {
  keyGuard, keyFailed, keyBlocked, gate, checkMailBudget,
  isEmail, isUuid, escapeHtml, safeFileName, extensionOf, isBlockedName, safeMime,
};
