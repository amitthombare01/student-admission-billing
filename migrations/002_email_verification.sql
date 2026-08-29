ALTER TABLE users
    ADD COLUMN email_verified_at TIMESTAMPTZ;

-- Accounts created before this migration already went through the legacy
-- administrator-notification flow, so retain their current eligibility.
UPDATE users
SET email_verified_at = created_at
WHERE email_verified_at IS NULL
  AND (role = 'admin' OR status <> 'pending');

ALTER TABLE users
    ADD CONSTRAINT users_active_staff_email_verified_check
    CHECK (role <> 'staff' OR status <> 'active' OR email_verified_at IS NOT NULL);

CREATE INDEX users_pending_email_index
    ON users (status, email_verified_at, created_at DESC);
