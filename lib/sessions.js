'use strict';
const pool = require('../db');

/**
 * Remove every stored session that belongs to an admin, optionally keeping one
 * (the session that is making the change). Used after password changes and when an
 * admin is deactivated or deleted, so old logins stop working immediately.
 */
async function revokeAdminSessions(adminId, exceptSid = null) {
  try {
    await pool.query(
      `DELETE FROM "session" WHERE (sess->'admin'->>'id') = $1::text AND ($2::text IS NULL OR sid <> $2::text)`,
      [String(adminId), exceptSid]
    );
  } catch (err) {
    console.error('Session revoke failed:', err.message);
  }
}

module.exports = { revokeAdminSessions };
