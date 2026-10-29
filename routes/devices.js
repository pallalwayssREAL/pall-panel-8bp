const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  let sql = `
    SELECT d.*, u.username FROM devices d
    JOIN users u ON u.id=d.user_id
  `;
  const p = [];

  // FILTER DEVICE
  if (req.session.admin.role !== 'owner') {
    p.push(req.session.admin.id);
    sql += ` WHERE u.created_by = $${p.length}`;
  }
  sql += ' ORDER BY d.id DESC';

  const r = await pool.query(sql, p);
  res.render('devices', { devices: r.rows, err: req.query.err, admin: req.session.admin });
});

router.post('/:id/reset', async (req, res) => {
  const { note } = req.body;
  if (!note || note.length < 5) return res.redirect('/devices?err=Catatan minimal 5 karakter');
  
  // Cek apakah perangkat ini milik user buatan admin tersebut
  const dev = await pool.query('SELECT user_id FROM devices WHERE id=$1', [req.params.id]);
  const userId = dev.rows[0]?.user_id;

  if (req.session.admin.role !== 'owner') {
    const user = await pool.query('SELECT created_by FROM users WHERE id=$1', [userId]);
    if (user.rows[0]?.created_by !== req.session.admin.id) {
      return res.status(403).send('Akses ditolak: Ini bukan perangkat user lu.');
    }
  }

  await pool.query('UPDATE devices SET revoked=true WHERE id=$1', [req.params.id]);
  await pool.query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
     VALUES ($1,$2,'device_reset','device',$3,$4,'success',$5)`,
    [req.session.admin.id, req.session.admin.role, req.params.id, note, req.ip]
  );
  res.redirect('/devices');
});

module.exports = router;