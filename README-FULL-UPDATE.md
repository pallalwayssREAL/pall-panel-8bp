# PALL 8BP — Full Update

## Ringkasan
- Menyamakan gaya panel, header, sidebar, kartu, tabel, dan pencarian agar lebih konsisten dengan dashboard.
- Merapikan command palette, filter tabel, export CSV, toast, fokus keyboard, dan responsif layar kecil.
- Mempertahankan halaman inti: Dashboard, Activity/Audit Log, Akun User, Lisensi, Perangkat, Akun Admin (Owner), Setelan (Owner), dan Profil.
- Menambahkan indeks PostgreSQL idempoten untuk query username, lisensi, perangkat, audit log, dan admin.
- Migrasi profil, balance, transaksi saldo, dan harga lisensi tetap disertakan di `scripts/migrate.sql`.

## Cara pasang
1. Backup database Supabase dan source code yang sedang dipakai.
2. Ekstrak ZIP dan pasang dependencies dengan `npm ci`.
3. Pastikan environment variable yang sudah digunakan aplikasi tersedia di environment lokal/Vercel. Jangan mengirim file `.env` atau secret ke publik.
4. Jalankan `npm run migrate` terhadap database target yang benar. Migrasi menambah kolom/tabel/indeks; tetap periksa `scripts/migrate.sql` sebelum menjalankannya pada produksi.
5. Jalankan `npm run dev` untuk pengujian lokal, lalu cek login, role Owner/Admin, Profil, pencarian tabel, ekspor CSV, perubahan lisensi/saldo, audit log, dan tampilan mobile.
6. Deploy ke Vercel setelah pengujian di preview deployment berhasil.

## Keamanan dan batas pengujian
- Jangan memasukkan `POSTGRES_URL`, `DATABASE_URL`, `SESSION_SECRET`, `JWT_SECRET`, atau service-role key ke source publik.
- Backup database sebelum migrasi. Jangan menjalankan `seed` kecuali memang ingin menyiapkan akun Owner sesuai petunjuk `scripts/seed-owner.js`.
- ZIP ini belum terhubung ke project Supabase/Vercel milik pengguna dan belum diuji dengan kredensial produksi. Lakukan pengujian di staging/preview terlebih dahulu.

## Modern system upgrade (notification center + navigation)

This revision adds a database-backed notification center and standardizes the left sidebar order:
Dashboard → Akun Admin (Owner only) → Akun User → Lisensi → Perangkat → Activity → Setelan (Owner only) → Profil → Log Out.

### Required database migration

Back up the database first, then run `npm run migrate` against the same PostgreSQL/Supabase database used by the deployment. The migration creates `admin_notifications`, indexes it, and installs a trigger that turns important successful audit events into notifications for other active admins. Login and profile-update events are excluded to reduce noise. Notifications are scoped by the authenticated admin on read/update endpoints.

The notification bell is added as a floating control on authenticated pages. It supports unread counts, marking one/all as read, and refreshes while the page is visible. If the migration has not run, the UI shows a helpful unavailable state rather than breaking the rest of the panel.

### Verify before production

1. Run `npm ci`.
2. Run `npm run migrate` with the intended database credentials.
3. Run `npm run dev` with `SESSION_SECRET` (or `JWT_SECRET`) and database environment variables configured.
4. Sign in as Owner and Admin; verify each role sees only permitted menu items.
5. Perform an audited action and verify the notification appears for other active admins.
6. Verify marking a notification read affects only the signed-in admin's notification.

## Profile recovery and navigation update
- Shared sidebar order: Dashboard, Akun Admin (Owner only), Akun User, Lisensi, Perangkat, Activity, Setelan (Owner only), Profil, then separated Log Out.
- Profile route now safely adds the two optional profile columns if they are missing, while the normal migration remains the recommended schema path.
- Profile save success is no longer reported as a failure solely because an audit-log insert failed; that issue is logged separately.
- Profile form styling was corrected so the intro heading does not inherit card-heading borders/background.

Before production deployment, back up the database and test profile load/save, image upload, login, and role-based menu visibility in a preview deployment.

## Security hardening + dashboard insights update

### Keamanan
- **CSRF protection** untuk semua request POST di panel (`middleware/security.js`). Token disimpan di session server dan disisipkan otomatis ke setiap `<form method="POST">` (hidden field `_csrf`) serta ke `<meta name="csrf-token">`. Request `fetch` memakai header `X-CSRF-Token`. Endpoint `/api/*` (aplikasi desktop/mobile) tidak terpengaruh.
- **Content-Security-Policy** + `Strict-Transport-Security` (produksi) + `Cross-Origin-Opener-Policy`. CSP mengizinkan inline script/style (dipakai view) dan Google Fonts; semua sumber lain hanya same-origin.
- **Logout kini POST.** Tautan Log Out otomatis dikirim sebagai form ber-token oleh `pall-enhancements.js`; membuka `/logout` langsung hanya menampilkan halaman konfirmasi.
- **Audit log lengkap** untuk Akun User: `account_create/rename/reset_password/suspend/activate/delete`, plus `password_change` dan `logout` (`lib/audit.js`, best-effort sehingga kegagalan audit tidak menggagalkan aksi).
- **Ganti password mengeluarkan semua sesi lain** (`lib/sessions.js`). Admin yang dinonaktifkan atau dihapus juga langsung ter-logout.
- **Error handling async**: `lib/asyncErrors.js` meneruskan promise reject di route async ke error handler global, sehingga request tidak lagi menggantung. Tersedia juga handler 404 dan 500.
- Validasi input akun user: username 3-32 karakter tanpa spasi, password 4-128 karakter, `device_limit` dibatasi 1-20.
- Query dashboard sekarang berparameter (tidak ada lagi interpolasi `${adminId}` ke SQL).

### Dashboard & Profil
- Kartu **Saldo Kredit** (role admin) / **Hak Akses** (owner) di banner dashboard.
- Dua grafik 7 hari terakhir (zona Asia/Jakarta): **Lisensi Diterbitkan** dan **Aktivitas Panel**.
- Panel **Lisensi Segera Berakhir** (7 hari ke depan, ditandai merah jika kurang dari 48 jam).
- Profil: kartu **Riwayat Login** (6 percobaan terakhir, termasuk yang gagal).
- Tidak ada dependency baru.

### Setelah deploy
1. Jalankan `npm run migrate` (memperbarui trigger notifikasi agar aksi `logout`, `password_change`, dan aksi akun minor tidak membanjiri notifikasi).
2. Uji di preview deployment: login 2 langkah, semua form POST, Log Out, ganti password (sesi di browser lain harus keluar), widget dashboard untuk role Owner dan Admin.
3. Jika ada form/fetch kustom yang Anda tambahkan sendiri, kirim `_csrf` (form) atau header `X-CSRF-Token` (fetch).
