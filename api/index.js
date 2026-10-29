require('dotenv').config();
require('../lib/asyncErrors'); // forward rejected promises from async routes to the error handler
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const pool = require('../db');

const authRouter     = require('../routes/auth');
const accountsRouter = require('../routes/accounts');
const adminsRouter   = require('../routes/admins');
const profileRouter  = require('../routes/profile');
const licensesRouter = require('../routes/licenses');
const devicesRouter  = require('../routes/devices');
const securityRouter = require('../routes/security');
const auditRouter    = require('../routes/audit');
const notificationsRouter = require('../routes/notifications');
const settingsRouter = require('../routes/settings');
const apiAppRouter   = require('../routes/api-app');
const { requireRole } = require('../middleware/requireRole');
const { securityHeaders, csrfProtection, csrfRender, notFound, errorHandler } = require('../middleware/security');
const { maintenanceGate } = require('../lib/maintenance');
const { createRateLimiter } = require('../lib/rateLimit');

const app = express();
if (!process.env.SESSION_SECRET && !process.env.JWT_SECRET) {
  throw new Error('Set SESSION_SECRET (recommended) or JWT_SECRET in Vercel Environment Variables.');
}
app.disable('x-powered-by');
if (process.env.VERCEL || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(securityHeaders);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Browser selalu minta /favicon.ico — sajikan logo supaya tidak 404.
app.get('/favicon.ico', (req, res) => res.redirect('/logo.png'));

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'pall.sid',
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

app.use(csrfRender);
app.use(csrfProtection);

// Rate-limit the admin panel login endpoint too (layered with DB login_attempts).
app.post('/login', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }));

// Maintenance mode now covers the whole panel for non-owner admins.
app.use(maintenanceGate);

app.use('/', authRouter);
app.use('/profile', requireRole('owner','admin'), profileRouter);
app.use('/accounts', requireRole('owner','admin'), accountsRouter);
app.use('/admins',   requireRole('owner'),         adminsRouter); // <--- PASTIIN ADA
app.use('/licenses', requireRole('owner','admin'), licensesRouter);
app.use('/devices',  requireRole('owner','admin'), devicesRouter);
app.use('/security', requireRole('owner','admin'), securityRouter);
app.use('/audit',    requireRole('owner','admin'), auditRouter);
app.use('/notifications', requireRole('owner','admin'), notificationsRouter);
app.use('/settings', requireRole('owner'),         settingsRouter);
app.use('/api',      apiAppRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;