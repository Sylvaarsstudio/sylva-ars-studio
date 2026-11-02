import { getDatabase } from "@netlify/database";

import {
  COOKIE_NAME,
  getCookie,
  hasValidAdminSession,
  verifyAdminSessionToken
} from "./admin-session.mjs";

const ADMIN_ROLES = Object.freeze({
  OWNER: "owner_admin",
  VIEWER: "viewer"
});

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  if (globalThis.Deno?.env?.get) return globalThis.Deno.env.get(name);
  return process.env[name];
}

function jsonResponse(status, code, message) {
  return Response.json({ success: false, code, message }, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function isLegacyAdminEnabled(environmentReader = readEnvironmentVariable) {
  const configured = environmentReader("ADMIN_LEGACY_LOGIN_ENABLED");
  if (configured === "true") return true;
  if (configured === "false") return false;
  return !environmentReader("ADMIN_OIDC_CLIENT_ID");
}

function legacyIdentity() {
  return {
    id: null,
    identity_provider: "legacy",
    external_subject: "legacy-migration-owner",
    email: null,
    display_name: "Legacy migration owner",
    role: ADMIN_ROLES.OWNER,
    status: "active",
    legacy: true
  };
}

async function findActiveAdminIdentity(database, provider, externalSubject) {
  const result = await database.pool.query(
    `SELECT
       id,
       identity_provider,
       external_subject,
       email,
       display_name,
       role,
       status,
       last_login_at,
       created_at,
       updated_at
     FROM admin_users
     WHERE identity_provider = $1
       AND external_subject = $2`,
    [provider, externalSubject]
  );
  return result.rows[0] || null;
}

async function resolveAdminIdentity(request, {
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date()
} = {}) {
  const sessionSecret = environmentReader("ADMIN_SESSION_SECRET");
  if (!sessionSecret) {
    return {
      error: jsonResponse(
        500,
        "admin_auth_not_configured",
        "Admin authentication is not configured."
      )
    };
  }

  const token = getCookie(request, COOKIE_NAME);
  const payload = await verifyAdminSessionToken(token, sessionSecret, { now });

  if (payload?.provider === "google") {
    const identity = await findActiveAdminIdentity(
      databaseFactory(),
      payload.provider,
      payload.sub
    );
    if (identity?.status === "active") return { identity, session: payload };
    return { error: jsonResponse(401, "admin_unauthorized", "Unauthorized.") };
  }

  const legacyEnabled = isLegacyAdminEnabled(environmentReader);
  if (payload?.provider === "legacy" && legacyEnabled) {
    return { identity: legacyIdentity(), session: payload };
  }

  const adminPassword = environmentReader("ADMIN_PASSWORD");
  if (
    legacyEnabled
    && adminPassword
    && await hasValidAdminSession(request, adminPassword, sessionSecret)
  ) {
    return { identity: legacyIdentity(), session: null };
  }

  return { error: jsonResponse(401, "admin_unauthorized", "Unauthorized.") };
}

async function authorizeAdminRequest(request, options = {}) {
  let resolved;
  try {
    resolved = await resolveAdminIdentity(request, options);
  } catch (error) {
    console.error("Admin authorization failed.", {
      error_type: error?.name || "Error",
      error_code: error?.code || "unknown"
    });
    return {
      ok: false,
      response: jsonResponse(
        500,
        "admin_authorization_failed",
        "Admin authorization could not be completed."
      )
    };
  }

  if (resolved.error) return { ok: false, response: resolved.error };

  const method = request.method.toUpperCase();
  if (
    resolved.identity.role === ADMIN_ROLES.VIEWER
    && method !== "GET"
    && method !== "HEAD"
  ) {
    return {
      ok: false,
      identity: resolved.identity,
      response: jsonResponse(403, "admin_forbidden", "Read-only access.")
    };
  }

  return { ok: true, identity: resolved.identity, session: resolved.session };
}

export {
  ADMIN_ROLES,
  authorizeAdminRequest,
  findActiveAdminIdentity,
  isLegacyAdminEnabled,
  readEnvironmentVariable,
  resolveAdminIdentity
};
