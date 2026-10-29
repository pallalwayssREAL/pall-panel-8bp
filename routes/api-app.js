const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireJWT } = require('../middleware/requireJWT');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password, pin, hwid, platform } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'data_kurang' });

  // 1. Cek Maintenance Mode
  const settings = await pool.query('SELECT * FROM system_settings');
  const settingMap = Object.fromEntries(settings.rows.map(x => [x.key, x.value]));
  
  if (settingMap.maintenance === 'true') {
    return res.status(503).json({ error: 'maintenance', message: 'Server sedang maintenance, coba lagi nanti.' });
  }

  // 2. Cek Akun User
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'gagal' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'gagal' });

  // 3. Cek Lisensi
  const lic = await pool.query(
    `SELECT * FROM licenses WHERE user_id=$1 AND status='active'
     AND (lifetime=true OR expires_at > NOW())
     ORDER BY id DESC LIMIT 1`, [user.id]
  );
  if (!lic.rows[0]) return res.status(403).json({ error: 'no_license' });

  // 4. Cek/Bind Device (HWID)
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

  // 5. Bikin Token JWT
  const token = jwt.sign({ id: user.id, username }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    license: {
      key: lic.rows[0].key,
      lifetime: lic.rows[0].lifetime,
      expires_at: lic.rows[0].expires_at
    }
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

module.exports = router;