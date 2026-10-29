const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { audit } = require('../lib/audit');
const { revokeAdminSessions } = require('../lib/sessions');
const router = express.Router();

const MAX_ATTEMPTS = 5;

async function tooManyAttempts(username, ip) {
  const r = await pool.query(
    `SELECT COUNT(*) FROM login_attempts
     WHERE success=false AND (username=$1 OR ip=$2)
       AND created_at > NOW() - interval '15 minutes'`,
    [username, ip]
  );
  return parseInt(r.rows[0].count) >= MAX_ATTEMPTS;
}

router.get('/login', (req, res) => {
  // Reset any unfinished two-step login when the login screen is opened.
  req.session.pendingAdminId = null;
  req.session.pendingAdminUsername = null;
  req.session.pendingAdminAt = null;
  res.render('login', { error: null, show_pin: false, username: '' });
});

// Logging out changes state, so it is POST-only (CSRF-protected). A plain GET only shows a confirmation page.
router.get('/logout', (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  res.render('logout');
});

router.post('/logout', async (req, res) => {
  if (req.session.admin) await audit(req, 'logout', { targetType: 'admin', targetId: req.session.admin.id });
  req.session.destroy(() => {
    res.clearCookie('pall.sid');
    res.redirect('/login');
  });
});

router.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const pin = typeof req.body.pin === 'string' ? req.body.pin : '';
  const ip = req.ip;
  const wantsJson = req.xhr || (req.get('accept') || '').includes('application/json');

  try {
    if (await tooManyAttempts(username, ip)) {
      await pool.query('INSERT INTO login_attempts (username, success, ip) VALUES ($1,false,$2)', [username || null, ip]);
      if (wantsJson) return res.status(429).json({ ok: false, message: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      return res.status(429).render('login', { error: 'Terlalu banyak percobaan. Coba lagi nanti.', show_pin: false, username: '' });
    }

    // Step 2 is only accepted after the password step created a pending session.
    if (pin) {
      if (!/^\d{4,8}$/.test(pin) || !req.session.pendingAdminId || !req.session.pendingAdminAt || Date.now() - req.session.pendingAdminAt > 5 * 60 * 1000) {
        if (wantsJson) return res.status(401).json({ ok: false, message: 'Sesi verifikasi berakhir. Login ulang.', reset: true });
        req.session.pendingAdminId = null;
        req.session.pendingAdminUsername = null;
        req.session.pendingAdminAt = null;
        return res.status(401).render('login', { error: 'Sesi verifikasi berakhir. Login ulang.', show_pin: false, username: '' });
      }

      const r = await pool.query('SELECT * FROM admins WHERE id=$1 AND username=$2 AND active=true', [req.session.pendingAdminId, username]);
      const admin = r.rows[0];
      let pinOk = false;
      if (admin && admin.security_pin) {
        if (String(admin.security_pin).startsWith('$2')) {
          pinOk = await bcrypt.compare(pin, admin.security_pin);
        } else {
          // Backward compatibility for old plaintext PINs; successful login upgrades it to bcrypt.
          pinOk = admin.security_pin === pin;
          if (pinOk) {
            const pinHash = await bcrypt.hash(pin, 10);
            await pool.query('UPDATE admins SET security_pin=$1 WHERE id=$2', [pinHash, admin.id]);
          }
        }
      }

      await pool.query('INSERT INTO login_attempts (username, success, ip) VALUES ($1,$2,$3)', [username || null, !!pinOk, ip]);
      if (!pinOk) {
        if (wantsJson) return res.status(401).json({ ok: false, message: 'PIN salah. Periksa kembali PIN lu.' });
        return res.status(401).render('login', { error: 'PIN salah!', show_pin: true, username });
      }

      // Regenerate session ID after full authentication to mitigate session fixation.
      return req.session.regenerate(async (err) => {
        if (err) {
          if (wantsJson) return res.status(500).json({ ok: false, message: 'Gagal membuat sesi aman.' });
          return res.status(500).render('login', { error: 'Gagal membuat sesi aman.', show_pin: false, username: '' });
        }
        req.session.admin = { id: admin.id, username: admin.username, role: admin.role, must_change_password: false };
        try {
          await pool.query(`INSERT INTO audit_logs (actor_id, actor_role, action, result, ip) VALUES ($1,$2,'login','success',$3)`, [admin.id, admin.role, ip]);
        } catch (e) { console.error('Audit login failed:', e.message); }
        req.session.save((saveErr) => {
          if (saveErr) {
            if (wantsJson) return res.status(500).json({ ok: false, message: 'Gagal menyimpan sesi.' });
            return res.status(500).render('login', { error: 'Gagal menyimpan sesi.', show_pin: false, username: '' });
          }
          if (wantsJson) return res.status(200).json({ ok: true, message: 'PIN benar. Akses diterima.', redirect: '/' });
          return res.redirect('/');
        });
      });
    }

    // Step 1: verify password, then create a short-lived pending authentication state.
    const r = await pool.query('SELECT * FROM admins WHERE username=$1 AND active=true', [username]);
    const admin = r.rows[0];
    const ok = !!(admin && password && await bcrypt.compare(password, admin.password_hash));
    await pool.query('INSERT INTO login_attempts (username, success, ip) VALUES ($1,$2,$3)', [username || null, !!ok, ip]);

    if (!ok) {
      req.session.pendingAdminId = null;
      req.session.pendingAdminUsername = null;
      req.session.pendingAdminAt = null;
      return res.status(401).render('login', { error: 'Username atau password salah', show_pin: false, username: '' });
    }
    req.session.pendingAdminId = admin.id;
    req.session.pendingAdminUsername = admin.username;
    req.session.pendingAdminAt = Date.now();
    return req.session.save((saveErr) => {
      if (saveErr) return res.status(500).render('login', { error: 'Gagal memulai verifikasi.', show_pin: false, username: '' });
      res.render('login', { error: null, show_pin: true, username: admin.username });
    });
  } catch (e) {
    console.error('Login error:', e);
    if (wantsJson) return res.status(500).json({ ok: false, message: 'Terjadi kesalahan server.' });
    return res.status(500).render('login', { error: 'Terjadi kesalahan server. Coba lagi.', show_pin: false, username: '' });
  }
});

// --- FITUR SETELAN & KEAMANAN ---

router.get('/account/password', (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  res.render('password', { error: null });
});

router.post('/account/password', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
  if (!password || password !== confirm || password.length < 8) {
    return res.render('password', { error: 'Password minimal 8 karakter dan harus sama dengan konfirmasi' });
  }
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2', [hash, req.session.admin.id]);
  await revokeAdminSessions(req.session.admin.id, req.sessionID);
  await audit(req, 'password_change', { targetType: 'admin', targetId: req.session.admin.id, note: 'Password diganti (wajib ganti)' });
  req.session.admin.must_change_password = false;
  res.redirect('/');
});

// --- DASHBOARD ---
// $1 is NULL for the owner (sees everything) or the admin id (sees only their own users/licenses/logs).
const STAT_QUERIES = {
  accounts:    'SELECT COUNT(*)::int AS c FROM users WHERE ($1::int IS NULL OR created_by = $1)',
  lic_active:  `SELECT COUNT(*)::int AS c FROM licenses l JOIN users u ON u.id=l.user_id
                WHERE l.status='active' AND (l.lifetime=true OR l.expires_at > NOW()) AND ($1::int IS NULL OR u.created_by = $1)`,
  lic_expired: `SELECT COUNT(*)::int AS c FROM licenses l JOIN users u ON u.id=l.user_id
                WHERE (l.status='expired' OR (l.lifetime=false AND l.expires_at < NOW())) AND ($1::int IS NULL OR u.created_by = $1)`,
  dev_android: `SELECT COUNT(*)::int AS c FROM devices d JOIN users u ON u.id=d.user_id
                WHERE d.platform='android' AND d.revoked=false AND ($1::int IS NULL OR u.created_by = $1)`,
  dev_windows: `SELECT COUNT(*)::int AS c FROM devices d JOIN users u ON u.id=d.user_id
                WHERE d.platform='windows' AND d.revoked=false AND ($1::int IS NULL OR u.created_by = $1)`,
  logs:        'SELECT COUNT(*)::int AS c FROM audit_logs WHERE ($1::int IS NULL OR actor_id = $1)'
};

// Last 7 days (Asia/Jakarta), zero-filled. Timestamps are stored as naive UTC.
const DAYS_CTE = `WITH days AS (
  SELECT generate_series(((NOW() AT TIME ZONE 'Asia/Jakarta')::date - 6)::timestamp, (NOW() AT TIME ZONE 'Asia/Jakarta')::date::timestamp, interval '1 day')::date AS day
)`;
const LICENSE_TREND_SQL = `${DAYS_CTE}
  SELECT to_char(d.day,'YYYY-MM-DD') AS day, COUNT(x.id)::int AS total
  FROM days d
  LEFT JOIN (
    SELECT l.id, ((l.issued_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date AS day
    FROM licenses l JOIN users u ON u.id=l.user_id
    WHERE l.issued_at >= NOW() - interval '9 days' AND ($1::int IS NULL OR u.created_by = $1)
  ) x ON x.day = d.day
  GROUP BY d.day ORDER BY d.day`;
const ACTIVITY_TREND_SQL = `${DAYS_CTE}
  SELECT to_char(d.day,'YYYY-MM-DD') AS day, COUNT(x.id)::int AS total
  FROM days d
  LEFT JOIN (
    SELECT a.id, ((a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Jakarta')::date AS day
    FROM audit_logs a
    WHERE a.created_at >= NOW() - interval '9 days' AND a.action NOT IN ('login','logout') AND ($1::int IS NULL OR a.actor_id = $1)
  ) x ON x.day = d.day
  GROUP BY d.day ORDER BY d.day`;
const EXPIRING_SQL = `SELECT u.username, l.expires_at, (COUNT(*) OVER())::int AS total
  FROM licenses l JOIN users u ON u.id=l.user_id
  WHERE l.status='active' AND l.lifetime=false AND l.expires_at > NOW() AND l.expires_at <= NOW() + interval '7 days'
    AND ($1::int IS NULL OR u.created_by = $1)
  ORDER BY l.expires_at ASC LIMIT 6`;

router.get('/', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');

  const isOwner = req.session.admin.role === 'owner';
  const adminId = req.session.admin.id;
  const scope = [isOwner ? null : adminId];

  const keys = Object.keys(STAT_QUERIES);
  const statRows = await Promise.all(keys.map((k) => pool.query(STAT_QUERIES[k], scope)));
  const stats = {};
  keys.forEach((k, i) => { stats[k] = statRows[i].rows[0].c; });

  const recentSql = `SELECT a.action, a.target_type, a.note, a.result, a.created_at, adm.username AS actor_name
       FROM audit_logs a LEFT JOIN admins adm ON adm.id=a.actor_id
       ${isOwner ? '' : 'WHERE a.actor_id=$1'} ORDER BY a.id DESC LIMIT 8`;
  const recent = await pool.query(recentSql, isOwner ? [] : [adminId]);

  // Insight widgets are optional: if one query fails the rest of the dashboard still renders.
  const safe = async (sql, fallback) => { try { return (await pool.query(sql, scope)).rows; } catch (e) { console.error('Dashboard widget failed:', e.message); return fallback; } };
  const [licenseTrend, activityTrend, expiring] = await Promise.all([
    safe(LICENSE_TREND_SQL, []), safe(ACTIVITY_TREND_SQL, []), safe(EXPIRING_SQL, [])
  ]);

  let profileData = {};
  try {
    profileData = (await pool.query('SELECT display_name, profile_image, balance FROM admins WHERE id=$1', [adminId])).rows[0] || {};
  } catch (e) {
    profileData = (await pool.query('SELECT display_name, profile_image FROM admins WHERE id=$1', [adminId])).rows[0] || {};
  }

  res.render('dashboard', {
    stats,
    recent: recent.rows,
    insights: { licenseTrend, activityTrend, expiring, expiringTotal: expiring[0] ? expiring[0].total : 0 },
    balance: !isOwner && profileData.balance !== undefined ? Number(profileData.balance) : null,
    admin: { ...req.session.admin, display_name: profileData.display_name, profile_image: profileData.profile_image },
    pesan: req.query.pesan,
    error: req.query.error
  });
});

module.exports = router;