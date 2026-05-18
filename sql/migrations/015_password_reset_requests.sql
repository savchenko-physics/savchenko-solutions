-- Log table for password reset requests (so admin can manually share reset links)
CREATE TABLE IF NOT EXISTS password_reset_requests (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reset_token VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    handled_at TIMESTAMPTZ,
    handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address VARCHAR(45)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status ON password_reset_requests (status);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_created ON password_reset_requests (created_at DESC);
