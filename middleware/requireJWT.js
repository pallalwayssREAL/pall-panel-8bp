'use strict';
const jwt = require('jsonwebtoken');
const pool = require('../db');

function getSecret() {
  // Prefer a dedicated JWT_SECRET; fall back to SESSION_SECRET so tokens stay
  // verifiable even when only one of the two env vars is configured.
  return process.env.JWT_SECRET || process.env.SESSION_SECRET;
}

/**
 * Verify the Bearer token AND re-check live state on every request:
 * - user still exists and is 'active' (suspend/ban/delete cuts access instantly)
 * - token not present in revoked_tokens (manual revocation support)
 */
async function requireJWT(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });

  let payload;
  try {
    payload = jwt.verify(token, getSecret());
  } catch (err) {
    const code = err && err.name === 'TokenExpiredError' ? 'token_expired' : 'invalid_token';
    return res.status(401).json({ error: code });
  }

  try {
    // Manual revocation list (best-effort: skip check if table missing).
    try {
      const rv = await pool.query('SELECT 1 FROM revoked_tokens WHERE jti=$1 LIMIT 1', [payload.jti || token.slice(-32)]);
      if (rv.rows[0]) return res.status(401).json({ error: 'token_revoked' });
    } catch (e) {
      if (e.code !== '42P01') console.error('revoked_tokens check failed:', e.message);
    }

    const u = await pool.query("SELECT id, username, status FROM users WHERE id=$1", [payload.id]);
    const user = u.rows[0];
    if (!user) return res.status(401).json({ error: 'user_not_found' });
    if (user.status !== 'active') return res.status(403).json({ error: 'account_disabled', status: user.status });

    req.user = { id: user.id, username: user.username, jti: payload.jti };
    next();
  } catch (e) {
    console.error('requireJWT DB check failed:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}

module.exports = { requireJWT, getSecret };
