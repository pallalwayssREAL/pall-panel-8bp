const express = require('express');
const pool = require('../db');
const router = express.Router();

// Keep profile usable on deployments where the profile migration was not run yet.
// The migration file remains the canonical schema upgrade; these IF NOT EXISTS
// guards are a safe compatibility fallback and do not touch existing values.
let profileSchemaReady;
async function ensureProfileSchema() {
  if (!profileSchemaReady) {
    profileSchemaReady = (async () => {
      await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS display_name VARCHAR(60)');
      await pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS profile_image TEXT');
    })().catch((err) => {
      profileSchemaReady = null;
      throw err;
    });
  }
  return profileSchemaReady;
}

router.get('/', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  try {
    await ensureProfileSchema();
    const result = await pool.query(
      'SELECT id, username, role, display_name, profile_image, created_at FROM admins WHERE id=$1 AND active=true',
      [req.session.admin.id]
    );
    if (!result.rows[0]) return res.redirect('/logout');
    const profile = result.rows[0];
    // Recent sign-in attempts against this username (including failed ones made by someone else).
    let loginHistory = [];
    try {
      const h = await pool.query(
        'SELECT success, ip, created_at FROM login_attempts WHERE username=$1 ORDER BY id DESC LIMIT 6',
        [profile.username]
      );
      loginHistory = h.rows;
    } catch (historyErr) {
      console.error('Login history load failed:', historyErr.message);
    }
    res.render('profile', {
      profile,
      loginHistory,
      admin: { ...req.session.admin, username: profile.username, role: profile.role, display_name: profile.display_name, profile_image: profile.profile_image },
      pesan: req.query.pesan, error: req.query.error
    });
  } catch (err) {
    console.error('Profile load failed:', err.message);
    res.status(500).send('Profil gagal dimuat. Periksa koneksi database dan jalankan npm run migrate. Detail teknis tersedia di log server.');
  }
});

router.post('/update', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  const displayName = String(req.body.display_name || '').trim().slice(0, 60);
  const image = String(req.body.profile_image || '').trim();
  if (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    return res.redirect('/profile?error=Format%20foto%20profil%20tidak%20valid');
  }
  if (image.length > 1500000) return res.redirect('/profile?error=Ukuran%20foto%20terlalu%20besar');
  try {
    await ensureProfileSchema();
    const updated = await pool.query(
      'UPDATE admins SET display_name=$1, profile_image=$2 WHERE id=$3 AND active=true RETURNING id',
      [displayName || null, image || null, req.session.admin.id]
    );
    if (!updated.rowCount) return res.redirect('/logout');
    // Audit is best-effort: a missing/older audit schema must not make a successful profile save look failed.
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, result, ip)
         VALUES ($1,$2,'profile_update','admin',$3,'success',$4)`,
        [req.session.admin.id, req.session.admin.role, req.session.admin.id, req.ip]
      );
    } catch (auditErr) {
      console.error('Profile audit write failed:', auditErr.message);
    }
    return res.redirect('/profile?pesan=Profil%20berhasil%20diperbarui');
  } catch (err) {
    console.error('Profile update failed:', err.message);
    return res.redirect('/profile?error=Gagal%20menyimpan%20profil');
  }
});

module.exports = router;
