const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const router = express.Router();

const VALID_DURATIONS = new Set(['4jam', '7', '30', '90', '365', 'lifetime', 'custom']);
function generateKey() {
  const raw = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `PALL-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
}
function durationLabel(duration, customDays) {
  if (duration === '4jam') return '4 Jam';
  if (duration === 'lifetime') return 'Lifetime';
  if (duration === 'custom') return `${customDays} Hari (Custom)`;
  return `${duration} Hari`;
}
async function licenseCost(client, duration, customDays) {
  if (duration === 'custom') {
    const base = await client.query("SELECT credits FROM license_prices WHERE duration_key='custom_month'");
    const monthly = Number(base.rows[0]?.credits ?? 8);
    return Math.max(1, Math.ceil(Number(customDays) / 30) * monthly);
  }
  const result = await client.query('SELECT credits FROM license_prices WHERE duration_key=$1', [duration]);
  if (!result.rows.length) throw new Error('Harga lisensi belum dikonfigurasi');
  return Number(result.rows[0].credits);
}
function expiryFor(duration, customDays, existingExpiry = null) {
  if (duration === 'lifetime') return { lifetime: true, days: null, expiresAt: null };
  let days = duration === '4jam' ? 0 : duration === 'custom' ? Number.parseInt(customDays, 10) : Number.parseInt(duration, 10);
  const now = new Date();
  let expiresAt = existingExpiry ? new Date(existingExpiry) : now;
  if (Number.isNaN(expiresAt.getTime()) || expiresAt < now) expiresAt = now;
  if (duration === '4jam') expiresAt.setHours(expiresAt.getHours() + 4);
  else expiresAt.setDate(expiresAt.getDate() + days);
  return { lifetime: false, days, expiresAt };
}
async function isUserAllowed(client, userId, admin) {
  if (admin.role === 'owner') return true;
  const r = await client.query('SELECT created_by FROM users WHERE id=$1', [userId]);
  return r.rows[0] && String(r.rows[0].created_by) === String(admin.id);
}
function validateDuration(duration, customDays) {
  if (!VALID_DURATIONS.has(String(duration))) return 'Durasi lisensi tidak valid';
  if (duration === 'custom' && (!Number.isInteger(Number(customDays)) || Number(customDays) < 1 || Number(customDays) > 3650)) return 'Durasi custom harus 1-3650 hari';
  return null;
}

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const p = [];
    let whereClause = 'WHERE 1=1';
    if (req.session.admin.role !== 'owner') {
      p.push(req.session.admin.id);
      whereClause += ` AND u.created_by = $${p.length}`;
    }
    const countRes = await pool.query(`SELECT COUNT(*) FROM licenses l JOIN users u ON u.id=l.user_id ${whereClause}`, p);
    const totalData = Number.parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.max(1, Math.ceil(totalData / limit));
    const r = await pool.query(
      `SELECT l.*, u.username FROM licenses l JOIN users u ON u.id=l.user_id ${whereClause}
       ORDER BY l.id DESC LIMIT $${p.length + 1} OFFSET $${p.length + 2}`,
      [...p, limit, offset]
    );
    let userSql = 'SELECT id, username FROM users';
    const userParams = [];
    if (req.session.admin.role !== 'owner') {
      userParams.push(req.session.admin.id);
      userSql += ` WHERE created_by = $${userParams.length}`;
    }
    userSql += ' ORDER BY username';
    const users = await pool.query(userSql, userParams);
    const balanceRes = await pool.query('SELECT balance FROM admins WHERE id=$1', [req.session.admin.id]);
    const priceRes = await pool.query('SELECT duration_key, credits FROM license_prices ORDER BY duration_key');
    const prices = Object.fromEntries(priceRes.rows.map(x => [x.duration_key, Number(x.credits)]));
    const txParams = [];
    let txWhere = '';
    if (req.session.admin.role !== 'owner') { txParams.push(req.session.admin.id); txWhere = 'WHERE t.admin_id=$1'; }
    const txRes = await pool.query(
      `SELECT t.*, a.username AS admin_username, actor.username AS actor_username
       FROM admin_balance_transactions t
       JOIN admins a ON a.id=t.admin_id
       LEFT JOIN admins actor ON actor.id=t.actor_id
       ${txWhere} ORDER BY t.id DESC LIMIT 15`, txParams);
    res.render('licenses', {
      licenses: r.rows, users: users.rows, admin: req.session.admin,
      currentPage: page, totalPages, balance: Number(balanceRes.rows[0]?.balance || 0),
      prices, transactions: txRes.rows, err: req.query.err || '', pesan: req.query.pesan || ''
    });
  } catch (e) {
    console.error('License page failed:', e.message);
    res.status(500).send('Gagal memuat halaman lisensi. Pastikan migrasi balance sudah dijalankan.');
  }
});

router.post('/prices', async (req, res) => {
  if (req.session.admin.role !== 'owner') return res.status(403).send('Akses ditolak');
  const keys = ['4jam', '7', '30', '90', '365', 'lifetime', 'custom_month'];
  const values = keys.map(k => Number(req.body[`price_${k}`]));
  if (values.some(v => !Number.isSafeInteger(v) || v < 0 || v > 1000000000)) {
    return res.redirect('/licenses?err=Harga harus berupa kredit bulat 0 sampai 1 miliar');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < keys.length; i++) {
      await client.query(
        `INSERT INTO license_prices (duration_key, credits, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (duration_key) DO UPDATE SET credits=EXCLUDED.credits, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [keys[i], values[i], req.session.admin.id]
      );
    }
    await client.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, note, result, ip)
      VALUES ($1,'owner','license_prices_update','license_prices',$2,'success',$3)`,
      [req.session.admin.id, JSON.stringify(Object.fromEntries(keys.map((k,i)=>[k,values[i]])),), req.ip]);
    await client.query('COMMIT');
    res.redirect('/licenses?pesan=Harga lisensi berhasil disimpan');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('License prices update failed:', e.message);
    res.redirect('/licenses?err=Gagal menyimpan harga lisensi');
  } finally { client.release(); }
});

router.post('/issue', async (req, res) => {
  const { user_id, duration, custom_days } = req.body;
  const invalid = validateDuration(duration, custom_days);
  if (invalid) return res.redirect('/licenses?err=' + encodeURIComponent(invalid));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await isUserAllowed(client, user_id, req.session.admin))) {
      await client.query('ROLLBACK');
      return res.status(403).send('Akses ditolak: ini bukan user yang dibuat oleh akun lu.');
    }
    const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user_id]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.redirect('/licenses?err=User tidak ditemukan'); }
    const cost = await licenseCost(client, duration, custom_days);
    let balanceAfter = null;
    if (req.session.admin.role !== 'owner') {
      const a = await client.query('SELECT balance FROM admins WHERE id=$1 FOR UPDATE', [req.session.admin.id]);
      const balance = Number(a.rows[0]?.balance ?? 0);
      if (balance < cost) {
        await client.query('ROLLBACK');
        return res.redirect('/licenses?err=' + encodeURIComponent(`Saldo tidak cukup. Butuh ${cost} kredit, saldo ${balance}. Hubungi Owner.`));
      }
      balanceAfter = balance - cost;
      await client.query('UPDATE admins SET balance=$1 WHERE id=$2', [balanceAfter, req.session.admin.id]);
    }
    const expiry = expiryFor(duration, custom_days);
    const key = generateKey();
    const inserted = await client.query(
      `INSERT INTO licenses (user_id, key, duration_days, lifetime, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [user_id, key, expiry.days, expiry.lifetime, expiry.expiresAt]
    );
    if (req.session.admin.role !== 'owner' && cost > 0) {
      await client.query(`INSERT INTO admin_balance_transactions (admin_id, actor_id, transaction_type, amount, balance_after, license_id, note)
        VALUES ($1,$1,'license_issue',$2,$3,$4,$5)`,
        [req.session.admin.id, -cost, balanceAfter, inserted.rows[0].id, `Terbitkan lisensi ${durationLabel(duration, custom_days)}`]);
    }
    await client.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
      VALUES ($1,$2,'license_issue','license',$3,$4,'success',$5)`,
      [req.session.admin.id, req.session.admin.role, inserted.rows[0].id,
       `${durationLabel(duration, custom_days)}; biaya ${req.session.admin.role === 'owner' ? 0 : cost} kredit`, req.ip]);
    await client.query('COMMIT');
    res.redirect('/licenses?pesan=' + encodeURIComponent(req.session.admin.role === 'owner' ? 'Lisensi berhasil dibuat' : `Lisensi dibuat. Terpakai ${cost} kredit; saldo tersisa ${balanceAfter}.`));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('License issue failed:', e.message);
    res.redirect('/licenses?err=Gagal membuat lisensi');
  } finally { client.release(); }
});

router.post('/update', async (req, res) => {
  const { user_id, action, duration, custom_days } = req.body;
  if (!['renew', 'suspend', 'revoke'].includes(String(action))) return res.redirect('/licenses?err=Aksi tidak valid');
  if (action === 'renew') {
    const invalid = validateDuration(duration, custom_days);
    if (invalid) return res.redirect('/licenses?err=' + encodeURIComponent(invalid));
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await isUserAllowed(client, user_id, req.session.admin))) {
      await client.query('ROLLBACK'); return res.status(403).send('Akses ditolak: ini bukan user yang dibuat oleh akun lu.');
    }
    const result = await client.query('SELECT * FROM licenses WHERE user_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE', [user_id]);
    const license = result.rows[0];
    if (!license) { await client.query('ROLLBACK'); return res.redirect('/licenses?err=Lisensi tidak ditemukan'); }
    if (action === 'renew') {
      const cost = await licenseCost(client, duration, custom_days);
      let balanceAfter = null;
      if (req.session.admin.role !== 'owner') {
        const a = await client.query('SELECT balance FROM admins WHERE id=$1 FOR UPDATE', [req.session.admin.id]);
        const balance = Number(a.rows[0]?.balance ?? 0);
        if (balance < cost) {
          await client.query('ROLLBACK');
          return res.redirect('/licenses?err=' + encodeURIComponent(`Saldo tidak cukup. Perpanjangan butuh ${cost} kredit, saldo ${balance}.`));
        }
        balanceAfter = balance - cost;
        await client.query('UPDATE admins SET balance=$1 WHERE id=$2', [balanceAfter, req.session.admin.id]);
      }
      const expiry = expiryFor(duration, custom_days, license.expires_at);
      await client.query("UPDATE licenses SET expires_at=$1, status='active', lifetime=$2, duration_days=$3 WHERE id=$4",
        [expiry.expiresAt, expiry.lifetime, expiry.days, license.id]);
      if (req.session.admin.role !== 'owner' && cost > 0) {
        await client.query(`INSERT INTO admin_balance_transactions (admin_id, actor_id, transaction_type, amount, balance_after, license_id, note)
          VALUES ($1,$1,'license_renewal',$2,$3,$4,$5)`,
          [req.session.admin.id, -cost, balanceAfter, license.id, `Perpanjangan ${durationLabel(duration, custom_days)}`]);
      }
      await client.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
        VALUES ($1,$2,'license_renew','license',$3,$4,'success',$5)`,
        [req.session.admin.id, req.session.admin.role, license.id, `${durationLabel(duration, custom_days)}; biaya ${req.session.admin.role === 'owner' ? 0 : cost} kredit`, req.ip]);
      await client.query('COMMIT');
      return res.redirect('/licenses?pesan=' + encodeURIComponent(req.session.admin.role === 'owner' ? 'Lisensi berhasil diperpanjang' : `Lisensi diperpanjang; terpakai ${cost} kredit, saldo tersisa ${balanceAfter}.`));
    }
    if (action === 'suspend') await client.query("UPDATE licenses SET status='suspended' WHERE id=$1", [license.id]);
    if (action === 'revoke') await client.query("UPDATE licenses SET status='revoked' WHERE id=$1", [license.id]);
    await client.query(`INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, note, result, ip)
      VALUES ($1,$2,'license_update','license',$3,$4,'success',$5)`,
      [req.session.admin.id, req.session.admin.role, license.id, action, req.ip]);
    await client.query('COMMIT');
    res.redirect('/licenses?pesan=Status lisensi diperbarui');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('License update failed:', e.message);
    res.redirect('/licenses?err=Gagal memperbarui lisensi');
  } finally { client.release(); }
});

module.exports = router;
