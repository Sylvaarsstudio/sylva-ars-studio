CREATE TABLE admin_users (
  id BIGSERIAL PRIMARY KEY,
  identity_provider TEXT NOT NULL
    CHECK (identity_provider IN ('google')),
  external_subject TEXT NOT NULL
    CHECK (length(external_subject) BETWEEN 1 AND 255),
  email TEXT NOT NULL
    CHECK (length(trim(email)) BETWEEN 3 AND 254),
  display_name TEXT,
  role TEXT NOT NULL
    CHECK (role IN ('owner_admin', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_provider, external_subject)
);

CREATE UNIQUE INDEX admin_users_email_identity_unique
  ON admin_users (identity_provider, lower(email));

COMMENT ON TABLE admin_users IS
  'Server-side SAS Admin identity and role mapping. External passwords, OAuth tokens, and MFA secrets are never stored here.';

COMMENT ON COLUMN admin_users.external_subject IS
  'Immutable subject identifier from the verified external identity provider; email is not the primary identity key.';

CREATE TABLE admin_oidc_flows (
  state_hash TEXT PRIMARY KEY
    CHECK (length(state_hash) = 43),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX admin_oidc_flows_expiry
  ON admin_oidc_flows (expires_at);

COMMENT ON TABLE admin_oidc_flows IS
  'Short-lived replay guard for Admin OIDC callbacks. Stores only a SHA-256 state fingerprint; no OAuth tokens, verifier, nonce, or credentials.';
