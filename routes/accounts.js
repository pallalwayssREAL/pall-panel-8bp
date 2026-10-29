const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { audit } = require('../lib/audit');
const router = express.Router();

router.get('/', async (req, res) => {
  const { q, status, page } = req.query;
  const limit = 10;
  const currentPage = parseInt(page) || 1;
  const offset = (currentPage - 1) * limit;

  let sql = "SELECT * FROM users WHERE status <> 'deleted'";
  let countSql = "SELECT COUNT(*) FROM users WHERE status <> 'deleted'";
  const p = [];

  // FILTER: Kalau bukan owner, cuma bisa liat user yang DIA buat
  if (req.session.admin.role !== 'owner') {
    p.push(req.session.admin.id);
    sql += ` AND created_by = $${p.length}`;
    countSql += ` AND created_by = $${p.length}`;
  }
  
  if (q) { 
    p.push(`%${q}%`); 
    sql += ` AND username ILIKE $${p.length}`; 
    countSql += ` AND username ILIKE $${p.length}`; 
  }
  if (status) { 
    p.push(status); 
    sql += ` AND status=$${p.length}`; 
    countSql += ` AND status=$${p.length}`; 
  }
  
  sql += ` ORDER BY id DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`;
  
  const countResult = await pool.query(countSql, p);
  const totalData = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalData / limit) || 1;

  const queryParams = [...p, limit, offset];
  const r = await pool.query(sql, queryParams);

  res.render('accounts', { 
    users: r.rows, q, status, admin: req.session.admin,
    currentPage, totalPages, totalData
  });
});

const USERNAME_RE = /^\S{3,32}$/; // 3-32 karakter tanpa spasi (batas kolom DB: 32)

router.post('/create', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const deviceLimit = Math.min(20, Math.max(1, parseInt(req.body.device_limit, 10) || 1));
  if (!USERNAME_RE.test(username)) return res.redirect('/accounts?err=Username 3-32 karakter tanpa spasi');
  if (password.length < 4 || password.length > 128) return res.redirect('/accounts?err=Password user 4-128 karakter');
  try {
    const hash = await bcrypt.hash(password, 10);
    // Simpan ID Admin/Owner yang bikin user ini (created_by)
    const r = await pool.query(
      'INSERT INTO users (username, password_hash, device_limit, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [username, hash, deviceLimit, req.session.admin.id]
    );
    await audit(req, 'account_create', { targetType: 'user', targetId: r.rows[0].id, note: `Akun ${username} dibuat` });
    res.redirect('/accounts');
  } catch (e) {
    console.error('Account create failed:', e.message);
    res.redirect('/accounts?err=Username sudah dipakai');
  }
});

// Fungsi buat ngecek apakah admin berhak ngedit user ini; mengembalikan user-nya (atau null).
async function ownedUser(userId, admin) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const r = await pool.query('SELECT id, username, created_by FROM users WHERE id=$1', [id]);
  const user = r.rows[0];
  if (!user) return null;
  if (admin.role === 'owner' || user.created_by === admin.id) return user;
  return null;
}
function denied(res) { return res.status(403).send('Akses Ditolak'); }

router.post('/:id/rename', async (req, res) => {
  const user = await ownedUser(req.params.id, req.session.admin);
  if (!user) return denied(res);
  const username = String(req.body.username || '').trim();
  if (!USERNAME_RE.test(username)) return res.redirect('/accounts?err=Username 3-32 karakter tanpa spasi');
  try {
    await pool.query('UPDATE users SET username=$1 WHERE id=$2', [username, user.id]);
  } catch (e) {
    return res.redirect('/accounts?err=Username sudah dipakai');
  }
  await audit(req, 'account_rename', { targetType: 'user', targetId: user.id, note: `${user.username} -> ${username}` });
  res.redirect('/accounts');
});

router.post('/:id/reset-password', async (req, res) => {
  const user = await ownedUser(req.params.id, req.session.admin);
  if (!user) return denied(res);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 4 || password.length > 128) return res.redirect('/accounts?err=Password user 4-128 karakter');
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);
  await audit(req, 'account_reset_password', { targetType: 'user', targetId: user.id, note: `Password ${user.username} direset` });
  res.redirect('/accounts');
});

router.post('/:id/suspend', async (req, res) => {
  const user = await ownedUser(req.params.id, req.session.admin);
  if (!user) return denied(res);
  await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [user.id]);
  await audit(req, 'account_suspend', { targetType: 'user', targetId: user.id, note: `Akun ${user.username} disuspend` });
  res.redirect('/accounts');
});

router.post('/:id/activate', async (req, res) => {
  const user = await ownedUser(req.params.id, req.session.admin);
  if (!user) return denied(res);
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [user.id]);
  await audit(req, 'account_activate', { targetType: 'user', targetId: user.id, note: `Akun ${user.username} diaktifkan` });
  res.redirect('/accounts');
});

// Soft delete: riwayat lisensi/perangkat & audit tetap utuh, akses langsung mati.
router.post('/:id/delete', async (req, res) => {
  const user = await ownedUser(req.params.id, req.session.admin);
  if (!user) return denied(res);
  await pool.query("UPDATE users SET status='deleted' WHERE id=$1", [user.id]);
  await audit(req, 'account_delete', { targetType: 'user', targetId: user.id, note: `Akun ${user.username} dihapus (soft-delete)` });
  res.redirect('/accounts');
});

module.exports = router;
