'use strict';
const pool = require('../db');

/**
 * Best-effort audit writer. A failure to write the audit row is logged but never
 * turns a successful action into an error for the person using the panel.
 */
async function audit(req, action, opts = {}) {
  const actor = opts.actor || (req.session && req.session.admin) || {};
  const targetId = Number.isSafeInteger(Number(opts.targetId)) ? Number(opts.targetId) : null;
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actor.id || null, actor.role || null, action, opts.targetType || null, targetId,
       opts.note ? String(opts.note).slice(0, 500) : null, opts.result || 'success', req.ip || null]
    );
  } catch (err) {
    console.error('Audit write failed (' + action + '):', err.message);
  }
}

module.exports = { audit };
