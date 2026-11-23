const router = require('express').Router();
const auth = require('../services/auth');
const rateLimit = require('../services/rateLimit');

const noStore = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
router.use(noStore);

// Refresh and logout are cheap but still limited per IP.
const tokenLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many requests. Please wait a minute.' });

router.post('/login', async (req, res) => {
  if (auth.isLocked(req)) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }
  const { username, password } = req.body || {};
  try {
    const user = await auth.checkCredentials(username, password);
    if (!user) {
      auth.recordFailure(req);
      console.warn(`Sign-in failed from ${req.ip}`);
      await auth.sleep(600); // slows guessing; the reply never says which part was wrong
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(await auth.startSession(user, req));
  } catch (e) {
    console.error('Login failed:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/refresh', tokenLimiter, async (req, res) => {
  try {
    const tokens = await auth.refresh(req.body?.refreshToken);
    if (!tokens) return res.status(401).json({ error: 'Session ended. Please sign in again.' });
    res.json(tokens);
  } catch (e) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/logout', tokenLimiter, async (req, res) => {
  try {
    await auth.logout(req.body?.refreshToken);
  } catch (e) {
    /* nothing to undo: the client forgets its tokens either way */
  }
  res.json({ success: true });
});

router.get('/me', auth.requireAuth, (req, res) => res.json({ user: { username: req.user.username, role: req.user.role } }));

module.exports = router;
