const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { action, from, to } = req.query;
    
    let sql = `
      SELECT 
        a.*, 
        adm.username AS actor_name,
        u.username AS target_user_name,
        adm_t.username AS target_admin_name
      FROM audit_logs a 
      LEFT JOIN admins adm ON adm.id = a.actor_id 
      LEFT JOIN users u ON (a.target_type = 'user' AND u.id = a.target_id)
      LEFT JOIN admins adm_t ON (a.target_type = 'admin' AND adm_t.id = a.target_id)
      WHERE 1=1
    `;
    
    const p = [];

    // FILTER AUDIT (Admin cuma liat log dia sendiri)
    if (req.session.admin.role !== 'owner') {
      p.push(req.session.admin.id);
      sql += ` AND a.actor_id = $${p.length}`;
    }

    if (action) { p.push(action); sql += ` AND a.action=$${p.length}`; }
    if (from)   { p.push(from);   sql += ` AND a.created_at >= $${p.length}`; }
    if (to)     { p.push(to);     sql += ` AND a.created_at <= $${p.length}`; }
    
    sql += ' ORDER BY a.id DESC LIMIT 200';
    
    const r = await pool.query(sql, p);
    res.render('audit', { logs: r.rows, action, from, to, admin: req.session.admin, error: null });
  } catch (e) {
    console.error(e);
    res.render('audit', { logs: [], action: '', from: '', to: '', admin: req.session.admin, error: 'Kesalahan database.' });
  }
});

router.get('/export.csv', async (req, res) => {
  let sql = 'SELECT * FROM audit_logs';
  const p = [];
  if (req.session.admin.role !== 'owner') {
    p.push(req.session.admin.id);
    sql += ` WHERE actor_id = $${p.length}`;
  }
  sql += ' ORDER BY id DESC';

  const r = await pool.query(sql, p);
  const cols = Object.keys(r.rows[0] || {});
  const csv = [
    cols.join(','),
    ...r.rows.map(row => cols.map(c => JSON.stringify(row[c] ?? '')).join(','))
  ].join('\n');
  res.header('Content-Type', 'text/csv');
  res.attachment('pall_audit.csv');
  res.send(csv);
});

module.exports = router;