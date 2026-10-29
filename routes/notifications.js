const express = require('express');
const pool = require('../db');
const router = express.Router();

// Notifications are private to the signed-in admin. IDs are always scoped to recipient.
router.get('/feed', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, message, type, created_at, read_at
       FROM admin_notifications WHERE recipient_admin_id=$1
       ORDER BY created_at DESC LIMIT 30`,
      [req.session.admin.id]
    );
    const unread = await pool.query(
      'SELECT COUNT(*)::int AS count FROM admin_notifications WHERE recipient_admin_id=$1 AND read_at IS NULL',
      [req.session.admin.id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, notifications: result.rows, unread: unread.rows[0].count });
  } catch (err) {
    console.error('Notification feed failed:', err.message);
    res.status(503).json({ ok: false, message: 'Pusat notifikasi belum siap. Jalankan migrasi database.' });
  }
});

router.post('/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false });
  try {
    await pool.query(
      'UPDATE admin_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND recipient_admin_id=$2',
      [id, req.session.admin.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Notification read failed:', err.message);
    res.status(503).json({ ok: false });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await pool.query('UPDATE admin_notifications SET read_at=NOW() WHERE recipient_admin_id=$1 AND read_at IS NULL', [req.session.admin.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Notification read-all failed:', err.message);
    res.status(503).json({ ok: false });
  }
});

module.exports = router;
