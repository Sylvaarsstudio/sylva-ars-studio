import { hashAdminSessionIdentifier } from "./admin-session.mjs";

const LAST_SEEN_THROTTLE_MILLISECONDS = 10 * 60 * 1000;
const SESSION_RETENTION_DAYS = 30;

function summarizeUserAgent(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  let browser = "Browser";
  if (/Edg\//i.test(value)) browser = "Edge";
  else if (/(?:CriOS|Chrome)\//i.test(value)) browser = "Chrome";
  else if (/(?:FxiOS|Firefox)\//i.test(value)) browser = "Firefox";
  else if (/Safari\//i.test(value)) browser = "Safari";

  let device = "Unknown device";
  if (/iPhone/i.test(value)) device = "iPhone";
  else if (/iPad/i.test(value)) device = "iPad";
  else if (/Android/i.test(value)) device = "Android";
  else if (/(?:Macintosh|Mac OS X)/i.test(value)) device = "macOS";
  else if (/Windows/i.test(value)) device = "Windows";
  else if (/Linux/i.test(value)) device = "Linux";

  if (browser === "Browser" && device === "Unknown device") return null;
  return `${browser} · ${device}`;
}

async function cleanupAdminSessions(database, now = new Date()) {
  return database.pool.query(
    `DELETE FROM admin_sessions
     WHERE expires_at < $1::timestamptz - ($2 * INTERVAL '1 day')
        OR revoked_at < $1::timestamptz - ($2 * INTERVAL '1 day')`,
    [now, SESSION_RETENTION_DAYS]
  );
}

async function createStoredAdminSession(database, {
  adminUserId,
  sessionIdentifier,
  createdAt,
  expiresAt,
  userAgent
}) {
  const tokenHash = await hashAdminSessionIdentifier(sessionIdentifier);
  const result = await database.pool.query(
    `INSERT INTO admin_sessions (
       admin_user_id, session_token_hash, created_at, last_seen_at,
       expires_at, user_agent_summary
     ) VALUES ($1, $2, $3, $3, $4, $5)
     RETURNING id, admin_user_id, created_at, last_seen_at, expires_at,
               revoked_at, revoked_reason, user_agent_summary`,
    [
      adminUserId,
      tokenHash,
      createdAt,
      expiresAt,
      summarizeUserAgent(userAgent)
    ]
  );
  return result.rows[0];
}

async function resolveStoredAdminSession(database, {
  sessionIdentifier,
  provider,
  externalSubject,
  now = new Date(),
  touch = true
}) {
  const tokenHash = await hashAdminSessionIdentifier(sessionIdentifier);
  const result = await database.pool.query(
    `SELECT
       sessions.id AS session_id,
       sessions.admin_user_id,
       sessions.created_at AS session_created_at,
       sessions.last_seen_at,
       sessions.expires_at AS session_expires_at,
       sessions.user_agent_summary,
       users.id,
       users.identity_provider,
       users.external_subject,
       users.email,
       users.display_name,
       users.role,
       users.status,
       users.last_login_at,
       users.created_at,
       users.updated_at
     FROM admin_sessions AS sessions
     INNER JOIN admin_users AS users ON users.id = sessions.admin_user_id
     WHERE sessions.session_token_hash = $1
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > $2
       AND users.identity_provider = $3
       AND users.external_subject = $4
       AND users.status = 'active'`,
    [tokenHash, now, provider, externalSubject]
  );
  const row = result.rows[0];
  if (!row) return null;

  let lastSeenUpdated = false;
  if (touch) {
    const touched = await database.pool.query(
      `UPDATE admin_sessions
       SET last_seen_at = $2
       WHERE id = $1
         AND revoked_at IS NULL
         AND expires_at > $2
         AND last_seen_at <= $2::timestamptz - INTERVAL '10 minutes'
       RETURNING id`,
      [row.session_id, now]
    );
    lastSeenUpdated = Boolean(touched.rows[0]);
  }

  return {
    identity: {
      id: row.id,
      identity_provider: row.identity_provider,
      external_subject: row.external_subject,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
      status: row.status,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      updated_at: row.updated_at
    },
    session: {
      id: row.session_id,
      admin_user_id: row.admin_user_id,
      created_at: row.session_created_at,
      last_seen_at: lastSeenUpdated ? now : row.last_seen_at,
      expires_at: row.session_expires_at,
      user_agent_summary: row.user_agent_summary
    },
    lastSeenUpdated
  };
}

async function revokeStoredSessionByIdentifier(database, {
  sessionIdentifier,
  now = new Date(),
  reason = "logout"
}) {
  const tokenHash = await hashAdminSessionIdentifier(sessionIdentifier);
  const result = await database.pool.query(
    `UPDATE admin_sessions
     SET revoked_at = COALESCE(revoked_at, $2),
         revoked_reason = COALESCE(revoked_reason, $3)
     WHERE session_token_hash = $1
     RETURNING id, revoked_at, revoked_reason`,
    [tokenHash, now, reason]
  );
  return result.rows[0] || null;
}

async function listActiveAdminSessions(database, {
  adminUserId,
  currentSessionId,
  now = new Date()
}) {
  const result = await database.pool.query(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent_summary
     FROM admin_sessions
     WHERE admin_user_id = $1
       AND revoked_at IS NULL
       AND expires_at > $2
     ORDER BY created_at DESC, id DESC`,
    [adminUserId, now]
  );
  return result.rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    current_session: row.id === currentSessionId,
    user_agent_summary: row.user_agent_summary || "Unknown browser · Unknown device"
  }));
}

async function revokeOwnAdminSession(database, {
  adminUserId,
  currentSessionId,
  targetSessionId,
  now = new Date()
}) {
  const target = await database.pool.query(
    `SELECT id
     FROM admin_sessions
     WHERE id = $1 AND admin_user_id = $2`,
    [targetSessionId, adminUserId]
  );
  if (!target.rows[0]) return { outcome: "not_found" };
  if (target.rows[0].id === currentSessionId) return { outcome: "current_session" };

  const revoked = await database.pool.query(
    `UPDATE admin_sessions
     SET revoked_at = COALESCE(revoked_at, $3),
         revoked_reason = COALESCE(revoked_reason, 'owner_revoke')
     WHERE id = $1 AND admin_user_id = $2
     RETURNING id, revoked_at`,
    [targetSessionId, adminUserId, now]
  );
  return { outcome: "revoked", session: revoked.rows[0] };
}

async function revokeOtherAdminSessions(database, {
  adminUserId,
  currentSessionId,
  now = new Date()
}) {
  const result = await database.pool.query(
    `UPDATE admin_sessions
     SET revoked_at = $3,
         revoked_reason = 'owner_sign_out_others'
     WHERE admin_user_id = $1
       AND id <> $2
       AND revoked_at IS NULL
       AND expires_at > $3
     RETURNING id`,
    [adminUserId, currentSessionId, now]
  );
  return result.rows.map((row) => row.id);
}

export {
  LAST_SEEN_THROTTLE_MILLISECONDS,
  SESSION_RETENTION_DAYS,
  cleanupAdminSessions,
  createStoredAdminSession,
  listActiveAdminSessions,
  resolveStoredAdminSession,
  revokeOtherAdminSessions,
  revokeOwnAdminSession,
  revokeStoredSessionByIdentifier,
  summarizeUserAgent
};
