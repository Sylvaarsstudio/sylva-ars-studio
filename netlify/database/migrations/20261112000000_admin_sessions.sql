CREATE TABLE admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id BIGINT NOT NULL
    REFERENCES admin_users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE
    CHECK (length(session_token_hash) = 43),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
    CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 64),
  user_agent_summary TEXT
    CHECK (user_agent_summary IS NULL OR length(user_agent_summary) BETWEEN 1 AND 80),
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX admin_sessions_active_user
  ON admin_sessions (admin_user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_sessions_cleanup
  ON admin_sessions (expires_at, revoked_at);

COMMENT ON TABLE admin_sessions IS
  'Server-side inventory for signed Admin sessions. Stores only a SHA-256 session identifier hash and coarse device metadata; never raw cookies or identity-provider tokens.';

COMMENT ON COLUMN admin_sessions.session_token_hash IS
  'Base64url SHA-256 hash of the random signed-session identifier. The raw session token and identifier are never stored.';

COMMENT ON COLUMN admin_sessions.user_agent_summary IS
  'Coarse browser and device label derived at login; the raw User-Agent, IP address, geolocation, and fingerprint are not stored.';
