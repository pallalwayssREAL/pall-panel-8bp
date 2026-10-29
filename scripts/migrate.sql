CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin')),
  totp_secret TEXT,
  security_pin VARCHAR(10) DEFAULT NULL,  -- INI KOLOM PIN BARU
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(16) DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  device_limit INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS licenses (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  duration_days INT,
  lifetime BOOLEAN DEFAULT FALSE,
  status VARCHAR(16) DEFAULT 'active' CHECK (status IN ('active','expired','suspended','revoked')),
  issued_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  hwid TEXT NOT NULL,
  platform VARCHAR(16) CHECK (platform IN ('android','windows')),
  bound_at TIMESTAMP DEFAULT NOW(),
  revoked BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, hwid)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INT,
  actor_role VARCHAR(16),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INT,
  note TEXT,
  result VARCHAR(16),
  ip TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  username TEXT,
  success BOOLEAN,
  ip TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Compatibility upgrades for existing deployments
ALTER TABLE admins ALTER COLUMN security_pin TYPE TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INT REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS display_name VARCHAR(60);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS profile_image TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked BOOLEAN DEFAULT FALSE;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS lifetime BOOLEAN DEFAULT FALSE;
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;


-- Admin credit balance and immutable ledger for license issuance.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0);
CREATE TABLE IF NOT EXISTS admin_balance_transactions (
  id BIGSERIAL PRIMARY KEY,
  admin_id INT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  actor_id INT REFERENCES admins(id) ON DELETE SET NULL,
  transaction_type VARCHAR(24) NOT NULL CHECK (transaction_type IN ('topup','license_issue','license_renewal','adjustment')),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  license_id INT REFERENCES licenses(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_admin_created ON admin_balance_transactions(admin_id, created_at DESC);
CREATE TABLE IF NOT EXISTS license_prices (
  duration_key VARCHAR(24) PRIMARY KEY,
  credits BIGINT NOT NULL CHECK (credits >= 0),
  updated_by INT REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO license_prices (duration_key, credits) VALUES
 ('4jam',0),('7',3),('30',8),('90',20),('365',60),('lifetime',150),('custom_month',8)
ON CONFLICT (duration_key) DO NOTHING;

-- Trial 4 jam selalu gratis, termasuk pada database yang sudah pernah dimigrasikan.
UPDATE license_prices SET credits = 0, updated_at = NOW() WHERE duration_key = '4jam';


-- Full update: query performance indexes (safe to rerun).
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_licenses_user_issued ON licenses (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses (expires_at);
CREATE INDEX IF NOT EXISTS idx_devices_user_bound ON devices (user_id, bound_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admins_active_role ON admins (active, role);


-- Modern admin notification center. Every recipient can only read/update their own rows.
CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGSERIAL PRIMARY KEY,
  recipient_admin_id INT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  type VARCHAR(16) NOT NULL DEFAULT 'info' CHECK (type IN ('info','success','warning','security')),
  source_audit_id INT REFERENCES audit_logs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_recipient_unread
  ON admin_notifications(recipient_admin_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_notifications_recipient_created
  ON admin_notifications(recipient_admin_id, created_at DESC);

-- Notify active admins about important audited actions, but avoid noise from login/profile edits.
CREATE OR REPLACE FUNCTION pall_notify_admin_audit_event() RETURNS trigger AS $$
DECLARE
  v_title VARCHAR(120);
  v_message TEXT;
  v_type VARCHAR(16);
BEGIN
  IF NEW.action IN ('login','logout','profile_update','password_change','account_rename','account_reset_password','account_activate') OR COALESCE(NEW.result,'success') <> 'success' THEN
    RETURN NEW;
  END IF;
  v_title := CASE
    WHEN NEW.action ILIKE '%license%' THEN 'Aktivitas lisensi'
    WHEN NEW.action ILIKE '%balance%' OR NEW.action ILIKE '%topup%' THEN 'Perubahan saldo'
    WHEN NEW.action ILIKE '%admin%' OR NEW.action ILIKE '%role%' THEN 'Perubahan akun admin'
    WHEN NEW.action ILIKE '%device%' OR NEW.action ILIKE '%hwid%' THEN 'Aktivitas perangkat'
    WHEN NEW.action ILIKE '%setting%' OR NEW.action ILIKE '%price%' THEN 'Pengaturan sistem berubah'
    ELSE 'Aktivitas panel'
  END;
  v_message := 'Aksi ' || COALESCE(NEW.action,'aktivitas') || ' tercatat pada ' || to_char(COALESCE(NEW.created_at,NOW()), 'YYYY-MM-DD HH24:MI:SS') || '.';
  v_type := CASE WHEN NEW.action ILIKE '%security%' OR NEW.action ILIKE '%admin%' OR NEW.action ILIKE '%role%' THEN 'security' ELSE 'info' END;
  INSERT INTO admin_notifications(recipient_admin_id,title,message,type,source_audit_id)
  SELECT a.id, v_title, v_message, v_type, NEW.id
  FROM admins a
  WHERE a.active IS DISTINCT FROM FALSE AND a.id IS DISTINCT FROM NEW.actor_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pall_notify_admin_audit_event ON audit_logs;
CREATE TRIGGER trg_pall_notify_admin_audit_event
AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION pall_notify_admin_audit_event();

-- Update sistem: token revocation list + indeks login_attempts (rate limiting)
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens (expires_at);
DELETE FROM revoked_tokens WHERE expires_at < NOW();
CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time ON login_attempts (username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, created_at DESC);
