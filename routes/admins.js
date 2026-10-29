const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { revokeAdminSessions } = require('../lib/sessions');
const router = express.Router();

router.get('/', async (req, res) => {
  const r = await pool.query('SELECT id, username, role, active, balance, created_at FROM admins ORDER BY id ASC');
  res.render('admins', { admins: r.rows, admin: req.session.admin, pesan: req.query.pesan, error: req.query.error });
});

router.post('/create', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const pin = typeof req.body.pin === 'string' ? req.body.pin : '';
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || password.length < 10 || !/^\d{4,8}$/.test(pin)) {
    return res.redirect('/admins?error=Username 3-32 karakter, password minimal 10 karakter, PIN 4-8 angka');
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const pinHash = await bcrypt.hash(pin, 10);
    await pool.query(
      `INSERT INTO admins (username, password_hash, role, security_pin) 
       VALUES ($1, $2, 'admin', $3)`,
      [username, hash, pinHash]
    );
    res.redirect('/admins?pesan=Admin baru berhasil dibuat');
  } catch (e) {
    res.redirect('/admins?error=Username sudah dipakai atau terjadi kesalahan');
  }
});



// Owner-only credit top-up. Keep balance update and ledger entry in one transaction.
router.post('/:id/balance', async (req, res) => {
  if (req.session.admin.role !== 'owner') return res.status(403).send('Akses ditolak');
  const id = Number.parseInt(req.params.id, 10);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 240);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
    return res.redirect('/admins?error=Jumlah kredit harus berupa angka positif yang valid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetRes = await client.query("SELECT id, role, balance FROM admins WHERE id=$1 FOR UPDATE", [id]);
    const target = targetRes.rows[0];
    if (!target || target.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.redirect('/admins?error=Saldo hanya bisa ditambahkan ke akun admin');
    }
    const nextBalance = Number(target.balance) + amount;
    if (!Number.isSafeInteger(nextBalance)) throw new Error('Balance limit exceeded');
    await client.query('UPDATE admins SET balance=$1 WHERE id=$2', [nextBalance, id]);
    await client.query(
      `INSERT INTO admin_balance_transactions (admin_id, actor_id, transaction_type, amount, balance_after, note)
       VALUES ($1,$2,'topup',$3,$4,$5)`,
      [id, req.session.admin.id, amount, nextBalance, note || 'Top up oleh Owner']
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
       VALUES ($1,'owner','balance_topup','admin',$2,$3,'success',$4)`,
      [req.session.admin.id, id, `Ditambah ${amount} kredit. Saldo akhir ${nextBalance}. ${note}`.trim(), req.ip]
    );
    await client.query('COMMIT');
    return res.redirect('/admins?pesan=Saldo admin berhasil ditambahkan');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Admin balance top-up failed:', e.message);
    return res.redirect('/admins?error=Top up gagal diproses');
  } finally {
    client.release();
  }
});

router.post('/:id/toggle', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id === req.session.admin.id) return res.redirect('/admins?error=Tidak bisa mengubah status akun sendiri');
  const found = await pool.query('SELECT id, role, active FROM admins WHERE id=$1', [id]);
  const target = found.rows[0];
  if (!target || target.role === 'owner') return res.redirect('/admins?error=Akun owner tidak dapat dinonaktifkan dari menu ini');
  const nextActive = !target.active;
  await pool.query('UPDATE admins SET active=$1 WHERE id=$2', [nextActive, id]);
  if (!nextActive) await revokeAdminSessions(id); // deactivated admin is logged out immediately
  await pool.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, result, ip) VALUES ($1,$2,$3,'admin',$4,'success',$5)`, [req.session.admin.id, req.session.admin.role, nextActive ? 'admin_activate' : 'admin_suspend', id, req.ip]);
  res.redirect('/admins?pesan=' + (nextActive ? 'Admin diaktifkan' : 'Admin dinonaktifkan'));
});

router.post('/:id/delete', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id === req.session.admin.id) return res.redirect('/admins?error=Tidak bisa menghapus akun sendiri');
  const found = await pool.query('SELECT id, role FROM admins WHERE id=$1', [id]);
  if (!found.rows[0] || found.rows[0].role === 'owner') return res.redirect('/admins?error=Akun owner tidak dapat dihapus');
  await pool.query('DELETE FROM admins WHERE id=$1', [id]);
  await revokeAdminSessions(id);
  await pool.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, result, ip) VALUES ($1,$2,'admin_delete','admin',$3,'success',$4)`, [req.session.admin.id, req.session.admin.role, id, req.ip]);
  res.redirect('/admins?pesan=Admin berhasil dihapus');
});

module.exports = router;