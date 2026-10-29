# PALL 8BP Panel — Update Notes

## Yang diperbarui
- Login admin sekarang benar-benar dua tahap: password harus lolos sebelum PIN bisa diverifikasi.
- PIN admin hanya angka 4–8 digit di form, dan disimpan dengan bcrypt hash. PIN plaintext lama tetap didukung sekali lalu di-upgrade saat login berhasil.
- Session ID diganti setelah login sukses; cookie memakai HttpOnly, SameSite=Lax, dan Secure di Vercel/production.
- Header keamanan dasar dan batas ukuran body request ditambahkan.
- Dashboard menampilkan Quick Actions dan Aktivitas Terbaru.
- Owner dapat mengaktifkan/menonaktifkan admin, dan akun owner tidak dapat dihapus dari menu admin.
- Perubahan lisensi penting dicatat ke audit log; validasi durasi lisensi ditambahkan.
- PIN keyboard di form login, ganti PIN, dan buat admin dibatasi ke angka.

## Sebelum deploy
1. Backup database Supabase terlebih dahulu.
2. Pastikan Vercel Environment Variables berisi `POSTGRES_URL` atau `DATABASE_URL`, `JWT_SECRET`, dan `SESSION_SECRET` (gunakan nilai acak panjang yang berbeda untuk kedua secret).
3. Jalankan `npm run migrate` pada environment yang terhubung ke database Supabase. File migrasi menambahkan kolom kompatibilitas dan memperbesar kolom hash PIN.
4. Jika perlu membuat owner baru, atur `OWNER_USERNAME`, `OWNER_PASSWORD` (minimal 12 karakter), dan `OWNER_PIN` (4–8 angka), lalu jalankan `npm run seed`. Seed tidak mengubah akun yang sudah ada.
5. Deploy ulang ke Vercel.
6. Tes login password → PIN, salah PIN, ubah PIN, buat/nonaktifkan admin, buat lisensi, dan logout.

## Catatan
- File `.env` dan `node_modules` tidak disertakan dalam ZIP. Jangan pernah upload secret ke repository publik.
- Perubahan ini belum diuji langsung di database/Vercel milikmu; lakukan backup dan uji di preview deployment terlebih dahulu.


## Balance admin & harga lisensi

Sistem balance menggunakan tabel PostgreSQL/Supabase dan transaksi atomik:
- Hanya Owner yang dapat menambah kredit admin melalui **Akun Admin**.
- Admin dikenai biaya saat menerbitkan lisensi atau memperpanjangnya; jika saldo tidak cukup, aksi dibatalkan.
- Owner dapat mengatur harga kredit berdasarkan durasi pada halaman **Lisensi**.
- Harga default: 4 jam = 0 (gratis); 7 hari = 3; 30 hari = 8; 90 hari = 20; 1 tahun = 60; lifetime = 150; custom = 8 kredit per blok 30 hari.
- Riwayat perubahan saldo disimpan di `admin_balance_transactions`; audit top-up juga masuk ke `audit_logs`.

### Deploy
1. Backup database Supabase terlebih dahulu.
2. Jalankan `npm run migrate` menggunakan `POSTGRES_URL` atau `DATABASE_URL` yang menunjuk ke database Supabase target. Script migrasi aman dijalankan ulang.
3. Deploy source code ke Vercel dan pastikan environment variable database/session yang lama tetap terpasang.
4. Login sebagai Owner, buka **Akun Admin** untuk top up dan **Lisensi** untuk memeriksa harga.

Catatan: owner dikecualikan dari pemotongan saldo; saldo admin baru dimulai dari 0. Perubahan skema belum diterapkan ke database live dari paket ini.


## Profil admin dan keamanan
- Jalankan migrasi database terbaru: `npm run migrate` (menambahkan kolom `admins.display_name` dan `admins.profile_image`).
- Buka menu **Profil & Keamanan** untuk mengatur nama tampilan, mengunggah foto profil, mengganti password, dan mengganti security PIN.
- Foto profil diperkecil di browser menjadi gambar JPEG sebelum dikirim ke server.
