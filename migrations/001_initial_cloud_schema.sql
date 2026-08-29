CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    review_id UUID NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX users_username_lower_unique ON users (LOWER(username));
CREATE INDEX users_status_created_at_index ON users (status, created_at DESC);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_id_index ON sessions(user_id);
CREATE INDEX sessions_expires_at_index ON sessions(expires_at);

CREATE TABLE student_records (
    id BIGSERIAL PRIMARY KEY,
    school_name TEXT NOT NULL,
    student_name TEXT NOT NULL,
    roll_number TEXT NOT NULL DEFAULT '',
    class_name TEXT NOT NULL,
    parent_name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    email_address TEXT NOT NULL DEFAULT '',
    date_of_birth DATE,
    address TEXT NOT NULL DEFAULT '',
    tuition_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tuition_fee >= 0),
    transport_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (transport_fee >= 0),
    sports_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (sports_fee >= 0),
    other_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (other_fee >= 0),
    payment_mode TEXT NOT NULL DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'online')),
    amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    session_year TEXT NOT NULL,
    admission_date DATE NOT NULL,
    date_added TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX student_records_date_added_index ON student_records(date_added DESC);
CREATE INDEX student_records_session_year_index ON student_records(session_year);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('backgroundImage', '') ON CONFLICT (key) DO NOTHING;

CREATE TABLE audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_target_created_at_index ON audit_events(target_user_id, created_at DESC);

CREATE TABLE notification_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('registration_pending', 'account_approved', 'account_rejected')),
    recipient TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX notification_outbox_ready_index ON notification_outbox(status, next_attempt_at, id);

CREATE TABLE rate_limits (
    key_hash TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rate_limits_updated_at_index ON rate_limits(updated_at);
