const express = require('express');
const pool = require('../db');
const { audit } = require('../lib/audit');
const router = express.Router();

// Validasi ketat sebelum disimpan — nilai mentah bisa merusak render & logika gate.
const VALIDATORS = {
  maintenance: (v) => (['true', 'false'].includes(String(v)) ? String(v) : null),
  announcement: (v) => {
    const s = String(v ?? '').trim();
    if (s.length > 500) return null;
    // strip karakter kontrol; EJS escape saat render, tapi ini lapisan kedua
    return s.replace(/[\u0000-\u001f\u007f]/g, '');
  },
  min_app_version: (v) => {
    const s = String(v ?? '').trim();
    if (s === '') return '';
    return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(s) ? s : null;
  }
};

router.get('/', async (req, res) => {
  const r = await pool.query('SELECT * FROM system_settings');
  const map = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  const db = await pool.query('SELECT NOW() AS now');
  res.render('settings', { s: map, dbTime: db.rows[0].now, ok: req.query.ok, error: req.query.error });
});

// RUTE SIMPAN PAKE AJAX (JSON)
router.post('/', async (req, res) => {
  const errors = [];
  const clean = {};
  for (const [k, validate] of Object.entries(VALIDATORS)) {
    if (req.body[k] === undefined) continue;
    const v = validate(req.body[k]);
    if (v === null) { errors.push(`Nilai "${k}" tidak valid`); continue; }
    clean[k] = v;
  }
  if (errors.length) return res.status(400).json({ success: false, message: errors.join('. ') });

  try {
    for (const [k, v] of Object.entries(clean)) {
      await pool.query(
        `INSERT INTO system_settings (key,value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
        [k, v]
      );
    }
    await audit(req, 'setting_update', { targetType: 'system', note: 'Setelan diubah: ' + Object.keys(clean).join(', ') });
    res.json({ success: true, message: 'Setelan berhasil disimpan!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Gagal menyimpan ke database' });
  }
});

module.exports = router;
