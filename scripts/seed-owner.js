require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../db');

(async () => {
  const username = (process.env.OWNER_USERNAME || 'PALL').trim();
  const password = process.env.OWNER_PASSWORD || '';
  const pin = process.env.OWNER_PIN || '';
  if (password.length < 12) throw new Error('Set OWNER_PASSWORD (minimal 12 karakter) sebelum menjalankan seed.');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Set OWNER_PIN berupa 4-8 angka sebelum menjalankan seed.');
  const passwordHash = await bcrypt.hash(password, 12);
  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    `INSERT INTO admins (username, password_hash, role, security_pin)
     VALUES ($1,$2,'owner',$3)
     ON CONFLICT (username) DO NOTHING`,
    [username, passwordHash, pinHash]
  );
  console.log('Owner seed selesai. Jika username sudah ada, data yang ada tidak diubah.');
  await pool.end();
  process.exit(0);
})().catch(async e => {
  console.error(e.message || e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
