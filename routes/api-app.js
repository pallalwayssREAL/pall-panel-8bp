const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireJWT, getSecret } = require('../middleware/requireJWT');
const { createRateLimiter } = require('../lib/rateLimit');
const router = express.Router();

// Brute-force protection for the app login endpoint (layered with DB attempts log).
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Terlalu banyak percobaan login. Coba lagi nanti.' });

// Log failed app logins into the same table the panel uses, so admins can see abuse.
async function logAttempt(username, ip, success) {
  try {
    await pool.query('INSERT INTO login_attempts (username, success, ip) VALUES ($1,$2,$3)', [username || null, !!success, ip || null]);
  } catch (e) { console.error('login_attempts write failed:', e.message); }
}

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, pin, hwid, platform, app_version } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'data_kurang' });

  // 1. Cek Maintenance Mode (via DB, real-time)
  let settingMap = {};
  try {
    const settings = await pool.query('SELECT key, value FROM system_settings');
    settingMap = Object.fromEntries(settings.rows.map(x => [x.key, x.value]));
  } catch (e) { console.error('settings read failed:', e.message); }

  if (settingMap.maintenance === 'true') {
    return res.status(503).json({ error: 'maintenance', message: settingMap.announcement || 'Server sedang maintenance, coba lagi nanti.' });
  }

  // 1b. Minimum app version gate (semver sederhana A.B.C)
  if (settingMap.min_app_version && /^\d+\.\d+\.\d+$/.test(settingMap.min_app_version)) {
    const cmp = (a, b) => {
      const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
      return 0;
    };
    if (app_version && cmp(app_version, settingMap.min_app_version) < 0) {
      return res.status(426).json({ error: 'update_required', min_version: settingMap.min_app_version, message: 'Update aplikasi ke versi minimal ' + settingMap.min_app_version });
    }
  }

  // 2. Rate-limit per-akun via DB (bersama IP limiter di atas)
  const ip = req.ip;
  try {
    const att = await pool.query(
      `SELECT COUNT(*) FROM login_attempts WHERE username=$1 AND success=false AND created_at > NOW() - interval '15 minutes'`,
      [username]
    );
    if (parseInt(att.rows[0].count, 10) >= 10) {
      return res.status(429).json({ error: 'rate_limited', message: 'Terlalu banyak percobaan login untuk akun ini. Tunggu 15 menit.' });
    }
  } catch (e) { console.error('attempt check failed:', e.message); }

  // 3. Cek Akun User
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  if (!user) { await logAttempt(username, ip, false); return res.status(401).json({ error: 'gagal' }); }
  if (user.status !== 'active') { await logAttempt(username, ip, false); return res.status(403).json({ error: 'account_disabled', status: user.status }); }

  const ok = !!(password && await bcrypt.compare(password, user.password_hash));
  await logAttempt(username, ip, ok);
  if (!ok) return res.status(401).json({ error: 'gagal' });

  // 4. Cek Lisensi
  const lic = await pool.query(
    `SELECT * FROM licenses WHERE user_id=$1 AND status='active'
     AND (lifetime=true OR expires_at > NOW())
     ORDER BY id DESC LIMIT 1`, [user.id]
  );
  if (!lic.rows[0]) return res.status(403).json({ error: 'no_license' });

  // 5. Cek/Bind Device (HWID)
  if (hwid && platform) {
    const dev = await pool.query(
      'SELECT * FROM devices WHERE user_id=$1 AND hwid=$2 AND revoked=false',
      [user.id, hwid]
    );
    if (!dev.rows[0]) {
      const cnt = await pool.query(
        'SELECT COUNT(*) FROM devices WHERE user_id=$1 AND revoked=false', [user.id]
      );
      if (parseInt(cnt.rows[0].count) >= user.device_limit) {
        return res.status(403).json({ error: 'device_limit' });
      }
      await pool.query(
        'INSERT INTO devices (user_id, hwid, platform) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [user.id, hwid, platform]
      );
    }
  }

  // 6. Bikin Token JWT (dengan jti supaya bisa dicabut lewat revoked_tokens)
  const jti = crypto.randomUUID();
  const token = jwt.sign({ id: user.id, username, jti }, getSecret(), { expiresIn: '7d' });
  res.json({
    token,
    license: {
      key: lic.rows[0].key,
      lifetime: lic.rows[0].lifetime,
      expires_at: lic.rows[0].expires_at
    },
    announcement: settingMap.announcement || null
  });
});

router.get('/verify', requireJWT, async (req, res) => {
  const r = await pool.query(
    `SELECT key, lifetime, expires_at, status FROM licenses
     WHERE user_id=$1 AND status='active'
     AND (lifetime=true OR expires_at > NOW())
     ORDER BY id DESC LIMIT 1`, [req.user.id]
  );
  if (!r.rows[0]) return res.status(403).json({ error: 'no_license' });
  res.json({ ok: true, license: r.rows[0] });
});

// Logout dari sisi app: cabut token aktif sampai masa berlaku alaminya habis.
router.post('/logout', requireJWT, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES ($1,$2, NOW() + interval '7 days')
       ON CONFLICT (jti) DO NOTHING`,
      [req.user.jti || crypto.randomUUID(), req.user.id]
    );
  } catch (e) {
    if (e.code !== '42P01') { console.error('token revoke failed:', e.message); return res.status(500).json({ error: 'server_error' }); }
  }
  res.json({ ok: true });
});

module.exports = router;
