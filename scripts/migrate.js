require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

(async () => {
  const client = await pool.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');
    await client.query('BEGIN');
    // Send the complete SQL file in one query so semicolons inside comments
    // or SQL blocks are not incorrectly treated as independent statements.
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Migration berhasil. Balance admin dan harga lisensi sudah tersedia.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration gagal:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
