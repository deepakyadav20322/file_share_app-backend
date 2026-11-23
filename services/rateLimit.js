// Small in-memory limiter, enough to stop brute-forcing 6-digit keys on a single instance.

// One IPv6 user can rotate through billions of addresses inside their /64, so IPv6 clients are
// grouped by /64. IPv4-mapped addresses (::ffff:1.2.3.4) are treated as plain IPv4.
const clientKey = (ip = '') => {
  const v4 = ip.replace(/^::ffff:/i, '');
  return v4.includes(':') ? v4.split(':').slice(0, 4).join(':') : v4;
};

// Fixed-window counter keyed by any string; old keys are swept automatically.
const counter = (windowMs) => {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 60 * 1000)).unref();

  const live = (key) => {
    const e = hits.get(key);
    return e && e.resetAt > Date.now() ? e : null;
  };
  return {
    hit(key) {
      let e = live(key);
      if (!e) {
        e = { count: 0, resetAt: Date.now() + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return e.count;
    },
    peek: (key) => live(key)?.count || 0,
  };
};

const rateLimit = ({ windowMs, max, message = 'Too many attempts. Please wait a minute and try again.' }) => {
  const c = counter(windowMs);
  return (req, res, next) => {
    if (c.hit(clientKey(req.ip)) > max) return res.status(429).json({ error: message });
    next();
  };
};

module.exports = rateLimit;
module.exports.counter = counter;
module.exports.clientKey = clientKey;
