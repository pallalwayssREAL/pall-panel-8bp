'use strict';
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// The panel uses inline <script>/<style> blocks and Google Fonts; everything else is same-origin only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

/* ---------------- CSRF (synchronizer token kept in the server-side session) ---------------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function sameToken(sent, expected) {
  if (typeof sent !== 'string' || typeof expected !== 'string' || !sent || !expected) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function wantsJson(req) {
  return !!(req.xhr || (req.get('accept') || '').includes('application/json') || (req.get('content-type') || '').includes('application/json'));
}

function csrfProtection(req, res, next) {
  // /api is used by the desktop/mobile app with its own credentials, not browser cookies.
  if (req.path === '/api' || req.path.startsWith('/api/')) return next();
  const token = ensureToken(req);
  res.locals.csrfToken = token;
  if (SAFE_METHODS.has(req.method)) return next();

  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (sameToken(sent, token)) return next();

  console.warn('CSRF check failed:', req.method, req.originalUrl);
  const message = 'Sesi keamanan tidak valid atau sudah kedaluwarsa. Muat ulang halaman lalu coba lagi.';
  if (wantsJson(req)) return res.status(403).json({ ok: false, success: false, message });
  return res.status(403).type('html').send(
    '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Akses ditolak</title></head>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080711;color:#f8f4ff;font-family:system-ui,sans-serif">' +
    '<div style="max-width:420px;padding:28px;border:1px solid rgba(188,132,255,.25);border-radius:16px;background:#100d1d">' +
    '<h1 style="margin:0 0 10px;font-size:20px">Permintaan ditolak</h1><p style="margin:0 0 18px;color:#a9a0bc;line-height:1.6">' + message +
    '</p><a href="/" style="color:#d879ff">Kembali ke dashboard</a></div></body></html>'
  );
}

/** Adds the hidden token to every POST form and a <meta> tag, so views need no manual changes. */
function injectCsrf(html, token) {
  if (typeof html !== 'string' || !token) return html;
  const field = '<input type="hidden" name="_csrf" value="' + token + '">';
  let out = html.replace(/<form\b[^>]*>/gi, (tag) => (/\bmethod\s*=\s*["']?post\b/i.test(tag) ? tag + field : tag));
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, '<meta name="csrf-token" content="' + token + '"></head>');
  return out;
}

function csrfRender(req, res, next) {
  const original = res.render;
  res.render = function render(view, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const token = res.locals.csrfToken || '';
    return original.call(this, view, options, (err, html) => {
      if (callback) return callback(err, err ? html : injectCsrf(html, token));
      if (err) return req.next(err);
      return res.send(injectCsrf(html, token));
    });
  };
  next();
}

/* ---------------- Not-found + error pages ---------------- */

function notFound(req, res) {
  if (wantsJson(req) || req.path.startsWith('/api/')) return res.status(404).json({ ok: false, message: 'Tidak ditemukan' });
  return res.status(404).type('text/plain').send('Halaman tidak ditemukan.');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('Unhandled error on ' + req.method + ' ' + req.originalUrl + ':', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const message = 'Terjadi kesalahan pada server. Coba lagi beberapa saat.';
  if (wantsJson(req) || req.path.startsWith('/api/')) return res.status(500).json({ ok: false, success: false, message });
  return res.status(500).type('text/plain').send(message);
}

module.exports = { securityHeaders, csrfProtection, csrfRender, injectCsrf, notFound, errorHandler, sameToken };
