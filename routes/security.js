const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { audit } = require('../lib/audit');
const { revokeAdminSessions } = require('../lib/sessions');
const router = express.Router();

// Pengaturan keamanan sekarang berada di halaman profil.
router.get('/', (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  return res.redirect('/profile');
});

// Proses ganti PIN: angka saja, 4-8 digit, disimpan dalam bentuk bcrypt hash.
router.post('/pin', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  const oldPin = typeof req.body.old_pin === 'string' ? req.body.old_pin : '';
  const newPin = typeof req.body.new_pin === 'string' ? req.body.new_pin : '';
  try {
    if (!/^\d{4,8}$/.test(newPin)) return res.redirect('/profile?error=PIN harus 4–8 angka');
    const r = await pool.query('SELECT * FROM admins WHERE id=$1 AND active=true', [req.session.admin.id]);
    const admin = r.rows[0];
    if (!admin) return res.redirect('/login');
    if (admin.security_pin) {
      let oldValid = false;
      if (String(admin.security_pin).startsWith('$2')) oldValid = await bcrypt.compare(oldPin, admin.security_pin);
      else oldValid = admin.security_pin === oldPin;
      if (!oldValid) return res.redirect('/profile?error=PIN lama salah');
    }
    const pinHash = await bcrypt.hash(newPin, 10);
    await pool.query('UPDATE admins SET security_pin=$1 WHERE id=$2', [pinHash, admin.id]);
    await audit(req, 'security_pin_change', { targetType: 'admin', targetId: admin.id });
    return res.redirect('/profile?pesan=PIN berhasil diubah');
  } catch (e) {
    console.error('PIN update failed:', e);
    return res.redirect('/profile?error=Gagal memperbarui PIN');
  }
});

// Proses Ganti Password
router.post('/password', async (req, res) => {
  if (!req.session.admin) return res.redirect('/login');
  const oldPassword = typeof req.body.old_password === 'string' ? req.body.old_password : '';
  const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';
  const confirmPassword = typeof req.body.confirm_password === 'string' ? req.body.confirm_password : '';

  if (newPassword !== confirmPassword) return res.redirect('/profile?error=Password baru tidak cocok');
  if (newPassword.length < 8) return res.redirect('/profile?error=Password minimal 8 karakter');
  if (newPassword.length > 128) return res.redirect('/profile?error=Password maksimal 128 karakter');

  const r = await pool.query('SELECT id, role, password_hash FROM admins WHERE id=$1 AND active=true', [req.session.admin.id]);
  const admin = r.rows[0];
  if (!admin) return res.redirect('/logout');

  const valid = await bcrypt.compare(oldPassword, admin.password_hash);
  if (!valid) {
    await audit(req, 'password_change', { targetType: 'admin', targetId: admin.id, result: 'failed', note: 'Password lama salah' });
    return res.redirect('/profile?error=Password lama salah');
  }

  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE admins SET password_hash=$1 WHERE id=$2', [hash, admin.id]);
  // Sign out every other device/browser that is still logged in with the old password.
  await revokeAdminSessions(admin.id, req.sessionID);
  await audit(req, 'password_change', { targetType: 'admin', targetId: admin.id, note: 'Sesi lain dikeluarkan' });

  res.redirect('/profile?pesan=Password berhasil diubah. Perangkat lain sudah dikeluarkan');
});

module.exports = router;