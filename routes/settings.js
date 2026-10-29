const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  const r = await pool.query('SELECT * FROM system_settings');
  const map = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  const db = await pool.query('SELECT NOW() AS now');
  res.render('settings', { s: map, dbTime: db.rows[0].now, ok: req.query.ok, error: req.query.error });
});

// RUTE SIMPAN PAKE AJAX (JSON)
router.post('/', async (req, res) => {
  const allow = ['maintenance', 'announcement', 'min_app_version'];
  try {
    for (const k of allow) {
      if (req.body[k] !== undefined) {
        await pool.query(
          `INSERT INTO system_settings (key,value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
          [k, req.body[k]]
        );
      }
    }
    res.json({ success: true, message: 'Setelan berhasil disimpan!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Gagal menyimpan ke database' });
  }
});

module.exports = router;