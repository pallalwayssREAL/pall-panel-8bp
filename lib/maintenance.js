'use strict';
const pool = require('../db');

/**
 * Read system_settings as a plain key->value map. Returns {} if the table is
 * missing or the query fails, so page rendering never crashes on DB issues.
 */
async function getSettingsMap() {
  try {
    const r = await pool.query('SELECT key, value FROM system_settings');
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  } catch (e) {
    console.error('getSettingsMap failed:', e.message);
    return {};
  }
}

function isMaintenanceOn(map) {
  return String(map.maintenance) === 'true';
}

/**
 * Global maintenance gate for the whole panel (admin pages included).
 * - Owner can always access everything so they can turn maintenance back off.
 * - Everyone else gets a friendly 503 page except static assets and /logout.
 * Place right after session middleware in api/index.js.
 */
function maintenanceGate(req, res, next) {
  const isAdminSession = !!(req.session && req.session.admin);
  const isOwner = isAdminSession && req.session.admin.role === 'owner';
  if (!isAdminSession || isOwner) return next();

  getSettingsMap()
    .then((map) => {
      if (!isMaintenanceOn(map)) return next();
      return res.status(503).type('html').send(
        '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sedang Maintenance</title></head>' +
        '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080711;color:#f8f4ff;font-family:system-ui,sans-serif">' +
        '<div style="max-width:460px;padding:28px;border:1px solid rgba(188,132,255,.25);border-radius:16px;background:#100d1d">' +
        '<h1 style="margin:0 0 10px;font-size:22px">🛠️ Server Sedang Maintenance</h1>' +
        '<p style="margin:0 0 18px;color:#a9a0bc;line-height:1.6">' +
        escapeHtml(map.announcement || 'Sistem sedang dalam pemeliharaan. Coba lagi beberapa saat.') +
        '</p><a href="/logout" style="color:#d879ff">Keluar</a></div></body></html>'
      );
    })
    .catch(() => next());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { getSettingsMap, isMaintenanceOn, maintenanceGate };
