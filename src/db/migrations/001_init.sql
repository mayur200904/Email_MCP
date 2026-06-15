CREATE TABLE IF NOT EXISTS mail_connections (
    id SERIAL PRIMARY KEY,
    connection_type TEXT NOT NULL DEFAULT 'yahoo',
    yahoo_email TEXT NOT NULL,
    encrypted_app_password TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS connection_events (
    id SERIAL PRIMARY KEY,
    mail_connection_id INTEGER REFERENCES mail_connections(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_connections_status ON mail_connections(status);
CREATE INDEX IF NOT EXISTS idx_connection_events_connection_id ON connection_events(mail_connection_id);
