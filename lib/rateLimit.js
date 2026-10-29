'use strict';

/**
 * Lightweight fixed-window rate limiter, kept in memory (no extra dependency).
 * Suitable for serverless/edge deployments where each instance keeps its own
 * small map; combined with DB-backed login_attempts this gives layered defense.
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 20, keyFn = (req) => req.ip, message = 'Terlalu banyak permintaan. Coba lagi nanti.' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  // Periodic cleanup so the map never grows unbounded.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (sweeper.unref) sweeper.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = keyFn(req) || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'rate_limited', message });
    }
    next();
  };
}

module.exports = { createRateLimiter };
