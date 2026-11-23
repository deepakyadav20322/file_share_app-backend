// Sign-in, access/refresh tokens and sessions for the admin panel.
//
//  - Passwords are stored only as scrypt hashes (services/password.js).
//  - Login password = <password> + DDHHmm (IST) while LOGIN_TIME_SUFFIX is on (the default). The time
//    part is checked separately and only the real password part is compared with the stored hash.
//  - A successful login opens a session that lasts SESSION_MINUTES (default 15) in total.
//    Inside it, the short-lived access token (ACCESS_TOKEN_MINUTES, default 5) is renewed with the
//    refresh token. Refreshing never extends the session: after 15 minutes every token is dead.
//  - Refresh tokens rotate on every use. Presenting an old one again revokes the whole session.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const AuthSession = require('../models/authSession');
const { hashPassword, verifyPassword } = require('./password');
const { counter, clientKey } = require('./rateLimit');

const minutes = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const ACCESS_MS = minutes(process.env.ACCESS_TOKEN_MINUTES, 5) * 60 * 1000;
const SESSION_MS = minutes(process.env.SESSION_MINUTES, 15) * 60 * 1000;
const TIME_SUFFIX = String(process.env.LOGIN_TIME_SUFFIX ?? 'true').toLowerCase() !== 'false';
const ISSUER = 'sendanyfile';
const AUDIENCE = 'sendanyfile-admin';

// Set JWT_ACCESS_SECRET (32+ random characters) in .env. Without it a random key is made on every
// start, which is safe but signs everyone out whenever the server restarts.
let ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
if (!ACCESS_SECRET || ACCESS_SECRET.length < 32) {
  ACCESS_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('JWT_ACCESS_SECRET is missing or shorter than 32 characters: using a temporary key (sessions end on restart).');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

// ---- time part of the password (IST, no daylight saving) ----------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const stampAt = (time) => {
  const d = new Date(time + (5 * 60 + 30) * 60 * 1000);
  return `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};
// Current minute and one either side (typing time, small clock differences); no early exit.
const stampOk = (suffix) => {
  const now = Date.now();
  let ok = false;
  for (const t of [now - 60000, now, now + 60000]) ok = same(suffix, stampAt(t)) || ok;
  return ok;
};

// ---- lock-outs: 5 wrong tries per IP, 20 across all IPs, per 15 minutes ----------------------------
const WINDOW = 15 * 60 * 1000;
const ipFails = counter(WINDOW);
const allFails = counter(WINDOW);
const isLocked = (req) => ipFails.peek(clientKey(req.ip)) >= 5 || allFails.peek('all') >= 20;
const recordFailure = (req) => {
  ipFails.hit(clientKey(req.ip));
  allFails.hit('all');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hash used when the username does not exist, so unknown users cost the same time as known ones.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

// Returns the user when username + password (+ time part) are right, otherwise null.
async function checkCredentials(username, password) {
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  const user = name && name.length <= 64 ? await User.findOne({ username: name }) : null;

  let plain = typeof password === 'string' && password.length <= 200 ? password : '';
  let timeOk = true;
  if (TIME_SUFFIX) {
    timeOk = plain.length > 6 && stampOk(plain.slice(-6));
    plain = plain.length > 6 ? plain.slice(0, -6) : '';
  }
  const hashOk = await verifyPassword(plain, user ? user.passwordHash : await dummyHash);
  return user && hashOk && timeOk && !user.disabled ? user : null;
}

// ---- tokens ------------------------------------------------------------------------------------------
const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');

function issueTokens(session, user, refreshToken) {
  const now = Date.now();
  const accessMs = Math.min(ACCESS_MS, session.expiresAt.getTime() - now);
  const accessToken = jwt.sign({ role: user.role, sid: String(session._id) }, ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: String(user._id),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: Math.max(1, Math.floor(accessMs / 1000)),
  });
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(now + accessMs).toISOString(),
    sessionExpiresAt: session.expiresAt.toISOString(),
    user: { username: user.username, role: user.role },
  };
}

async function startSession(user, req) {
  const refreshToken = newRefreshToken();
  const session = await AuthSession.create({
    userId: user._id,
    refreshHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + SESSION_MS),
    ip: clientKey(req.ip),
    userAgent: String(req.get('user-agent') || '').slice(0, 200),
  });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return issueTokens(session, user, refreshToken);
}

// Swaps a refresh token for a new pair. Returns null when it is unknown, expired, revoked or reused.
async function refresh(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const h = sha256(token);
  const session = await AuthSession.findOne({ $or: [{ refreshHash: h }, { prevRefreshHash: h }] });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;

  if (session.refreshHash !== h) {
    // An already-used token came back: someone copied it. Kill the whole session.
    await AuthSession.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
    console.warn('Refresh token reuse detected: session revoked.');
    return null;
  }
  const user = await User.findById(session.userId);
  if (!user || user.disabled) return null;

  const next = newRefreshToken();
  const done = await AuthSession.updateOne(
    { _id: session._id, refreshHash: h, revokedAt: null },
    { $set: { prevRefreshHash: h, refreshHash: sha256(next), lastRefreshAt: new Date() } }
  );
  return done.modifiedCount === 1 ? issueTokens(session, user, next) : null;
}

async function logout(token) {
  if (typeof token !== 'string' || token.length > 100) return;
  const h = sha256(token);
  await AuthSession.updateOne({ $or: [{ refreshHash: h }, { prevRefreshHash: h }], revokedAt: null }, { $set: { revokedAt: new Date() } });
}

// ---- Express middleware ----------------------------------------------------------------------------
// Valid access token + live session + active user, else 401.
async function requireAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const m = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(m[1], ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    const session = await AuthSession.findOne({ _id: p.sid, revokedAt: null, expiresAt: { $gt: new Date() } });
    const user = session && String(session.userId) === p.sub ? await User.findById(p.sub) : null;
    if (!user || user.disabled) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: String(user._id), username: user.username, role: user.role };
    req.sessionId = String(session._id);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' });

// Extra check for sensitive actions: the signed-in user must type their ID and password again.
// Wrong answers count towards the same lock-out as login.
async function requireStepUp(req, res, next) {
  if (isLocked(req)) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const user = await checkCredentials(req.get('x-admin-id'), req.get('x-admin-password'));
  if (user && String(user._id) === req.user.id) return next();
  recordFailure(req);
  await sleep(600);
  res.status(403).json({ error: 'Forbidden' });
}

async function seedAdmin() {
  try {
    if (await User.exists({ role: 'admin' })) return;
    const username = String(process.env.ADMIN_ID || 'admin').trim().toLowerCase();
    // First start only: this value is hashed and stored. Changing .env later does not change the stored
    // password; use `node scripts/set-admin-password.js` for that.
    const initial = process.env.ADMIN_SECRET || 'Deepak@321';
    await User.create({ username, passwordHash: await hashPassword(initial), role: 'admin' });
    console.log(`Created the admin user "${username}" (password stored as a hash).`);
  } catch (e) {
    if (e.code !== 11000) console.error('Could not create the admin user:', e);
  }
}

module.exports = {
  checkCredentials, startSession, refresh, logout, requireAuth, requireRole, requireStepUp,
  isLocked, recordFailure, sleep, seedAdmin, config: { ACCESS_MS, SESSION_MS, TIME_SUFFIX },
};
