import { getDatabase } from "@netlify/database";
import { createRemoteJWKSet, jwtVerify } from "jose";

import {
  buildOidcFlowCookie,
  buildSessionCookie,
  clearOidcFlowCookie,
  clearSessionCookie,
  createAdminSessionToken,
  createOidcFlowToken,
  getCookie,
  OIDC_FLOW_COOKIE_NAME,
  randomToken,
  verifyOidcFlowToken
} from "../shared/admin-session.mjs";
import {
  isLegacyAdminEnabled,
  readEnvironmentVariable
} from "../shared/admin-authorization.mjs";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const SAFE_DIAGNOSTIC_FACTS = new Set([
  "auth_time_present",
  "auth_time_age_bucket",
  "amr_present",
  "amr_count",
  "hosted_domain_match",
  "email_verified",
  "mfa_evidence"
]);

class AdminOidcDiagnosticError extends Error {
  constructor(stage, reason, {
    status,
    facts = {},
    cause
  } = {}) {
    super(`Admin OIDC ${stage} failed.`, cause ? { cause } : undefined);
    this.name = "AdminOidcDiagnosticError";
    this.stage = stage;
    this.reason = reason;
    if (Number.isInteger(status)) this.status = status;
    this.facts = Object.fromEntries(
      Object.entries(facts).filter(([key, value]) => (
        SAFE_DIAGNOSTIC_FACTS.has(key)
        && (typeof value === "boolean" || typeof value === "string" || Number.isInteger(value))
      ))
    );
  }
}

function logAdminOidcError(logger, error, {
  stage = "unknown",
  reason = "unexpected_error",
  status
} = {}) {
  const diagnostic = error instanceof AdminOidcDiagnosticError
    ? {
        stage: error.stage,
        reason: error.reason,
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
        ...error.facts
      }
    : {
        stage,
        reason,
        ...(Number.isInteger(status) ? { status } : {})
      };
  logger("admin_oidc_error", diagnostic);
}

function redirect(location, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(null, {
    status: 302,
    headers: responseHeaders
  });
}

function loginError(code, headers = {}) {
  return redirect(`/admin-login.html?error=${encodeURIComponent(code)}`, headers);
}

function safeAdminRedirect(value) {
  return typeof value === "string" && /^\/admin\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value)
    ? value
    : "/admin/dashboard.html";
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function timingSafeTextEqual(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right))
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function hasMfaEvidence(amr) {
  if (!Array.isArray(amr)) return false;
  const methods = new Set(amr.filter((value) => typeof value === "string"));
  return methods.has("mfa");
}

async function verifyGoogleIdToken(idToken, {
  clientId,
  nonce,
  hostedDomain,
  now = () => new Date(),
  jwtVerifier = jwtVerify,
  keySet = GOOGLE_JWKS
}) {
  let payload;
  try {
    ({ payload } = await jwtVerifier(idToken, keySet, {
      audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"]
    }));
  } catch (error) {
    if (error?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && error?.claim === "iss") {
      throw new AdminOidcDiagnosticError("issuer_validation", "invalid_issuer", { cause: error });
    }
    if (error?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && error?.claim === "aud") {
      throw new AdminOidcDiagnosticError("audience_validation", "invalid_audience", { cause: error });
    }
    const reason = typeof error?.code === "string" && error.code.startsWith("ERR_JWKS")
      ? "jwks_resolution_failed"
      : "signature_or_token_validation_failed";
    throw new AdminOidcDiagnosticError("id_token_signature", reason, { cause: error });
  }
  const currentTime = Math.floor(now().getTime() / 1000);
  if (payload.nonce !== nonce) {
    throw new AdminOidcDiagnosticError("nonce_validation", "nonce_mismatch");
  }
  if (payload.email_verified !== true) {
    throw new AdminOidcDiagnosticError("email_verified", "email_not_verified", {
      facts: { email_verified: payload.email_verified === true }
    });
  }
  if (payload.hd !== hostedDomain) {
    throw new AdminOidcDiagnosticError("hosted_domain", "hosted_domain_mismatch", {
      facts: { hosted_domain_match: false }
    });
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new AdminOidcDiagnosticError("admin_identity_lookup", "required_identity_claim_missing");
  }
  if (!Number.isInteger(payload.auth_time)) {
    throw new AdminOidcDiagnosticError("auth_time_missing", "claim_missing", {
      facts: {
        auth_time_present: false,
        auth_time_age_bucket: "missing"
      }
    });
  }
  if (payload.auth_time > currentTime + 60) {
    throw new AdminOidcDiagnosticError("auth_time_stale", "claim_in_future", {
      facts: {
        auth_time_present: true,
        auth_time_age_bucket: "future"
      }
    });
  }
  if (!Array.isArray(payload.amr)) {
    throw new AdminOidcDiagnosticError("amr_missing", "claim_missing", {
      facts: {
        amr_present: false,
        amr_count: 0,
        mfa_evidence: "missing"
      }
    });
  }
  if (!hasMfaEvidence(payload.amr)) {
    throw new AdminOidcDiagnosticError("amr_insufficient", "mfa_evidence_insufficient", {
      facts: {
        amr_present: true,
        amr_count: payload.amr.length,
        mfa_evidence: "insufficient"
      }
    });
  }
  return payload;
}

async function resolveOrProvisionIdentity(database, claims, environmentReader, now) {
  const provider = "google";
  const subject = claims.sub;
  const email = claims.email.trim().toLowerCase();
  const displayName = typeof claims.name === "string" ? claims.name.trim() || null : null;
  let existing;
  try {
    existing = await database.pool.query(
      `SELECT id, identity_provider, external_subject, email, display_name, role, status
       FROM admin_users
       WHERE identity_provider = $1 AND external_subject = $2`,
      [provider, subject]
    );
  } catch (error) {
    throw new AdminOidcDiagnosticError("admin_identity_lookup", "database_lookup_failed", {
      cause: error
    });
  }

  if (existing.rows[0]) {
    if (existing.rows[0].status !== "active") {
      throw new AdminOidcDiagnosticError("admin_identity_disabled", "identity_disabled", {
        status: 401
      });
    }
    let updated;
    try {
      updated = await database.pool.query(
        `UPDATE admin_users
         SET email = $1, display_name = $2, last_login_at = $3, updated_at = $3
         WHERE id = $4
         RETURNING id, identity_provider, external_subject, email, display_name, role, status`,
        [email, displayName, now(), existing.rows[0].id]
      );
    } catch (error) {
      throw new AdminOidcDiagnosticError("admin_identity_lookup", "database_update_failed", {
        cause: error
      });
    }
    return updated.rows[0];
  }

  const ownerEmail = environmentReader("ADMIN_BOOTSTRAP_OWNER_EMAIL")?.trim().toLowerCase();
  const viewerEmail = environmentReader("ADMIN_BOOTSTRAP_VIEWER_EMAIL")?.trim().toLowerCase();
  let role = null;
  if (ownerEmail && email === ownerEmail) role = "owner_admin";
  if (viewerEmail && email === viewerEmail) {
    if (role) {
      throw new AdminOidcDiagnosticError("owner_bootstrap", "bootstrap_identity_overlap");
    }
    role = "viewer";
  }
  if (!role) {
    throw new AdminOidcDiagnosticError("owner_bootstrap", "identity_not_bootstrapped", {
      status: 401
    });
  }

  let inserted;
  try {
    inserted = await database.pool.query(
      `INSERT INTO admin_users (
         identity_provider, external_subject, email, display_name, role,
         status, last_login_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6)
       RETURNING id, identity_provider, external_subject, email, display_name, role, status`,
      [provider, subject, email, displayName, role, now()]
    );
  } catch (error) {
    throw new AdminOidcDiagnosticError("owner_bootstrap", "database_insert_failed", {
      cause: error
    });
  }
  return inserted.rows[0];
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  fetchImplementation = globalThis.fetch?.bind(globalThis),
  idTokenVerifier = verifyGoogleIdToken,
  now = () => new Date(),
  logger = (...arguments_) => console.error(...arguments_)
} = {}) {
  return async function handler(request) {
    const url = new URL(request.url);
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET");

    if (url.pathname === "/admin-logout") {
      return redirect("/admin-login.html", { "Set-Cookie": clearSessionCookie() });
    }

    if (url.pathname === "/admin-login" && request.method === "POST") {
      if (!sessionSecret || !isLegacyAdminEnabled(environmentReader)) {
        return loginError("legacy_disabled");
      }
      const adminPassword = environmentReader("ADMIN_PASSWORD") || "";
      const form = new URLSearchParams(await request.text());
      if (!adminPassword || !await timingSafeTextEqual(form.get("password") || "", adminPassword)) {
        return loginError("invalid_legacy_login");
      }
      const token = await createAdminSessionToken({
        provider: "legacy",
        externalSubject: "legacy-migration-owner"
      }, sessionSecret, { now });
      return redirect(safeAdminRedirect(form.get("redirect")), {
        "Set-Cookie": buildSessionCookie(token)
      });
    }

    if (url.pathname === "/admin-login" && request.method === "GET") {
      const clientId = environmentReader("ADMIN_OIDC_CLIENT_ID");
      const hostedDomain = environmentReader("ADMIN_OIDC_HOSTED_DOMAIN");
      if (!sessionSecret || !clientId || !hostedDomain) {
        return isLegacyAdminEnabled(environmentReader)
          ? redirect("/admin-login.html?legacy=1")
          : loginError("oidc_not_configured");
      }
      const state = randomToken(32);
      const nonce = randomToken(32);
      const codeVerifier = randomToken(48);
      const redirectTo = safeAdminRedirect(url.searchParams.get("redirect"));
      const flowToken = await createOidcFlowToken({ state, nonce, codeVerifier, redirectTo }, sessionSecret, { now });
      const redirectUri = environmentReader("ADMIN_OIDC_REDIRECT_URI")
        || `${url.origin}/admin-auth/callback`;
      try {
        const database = databaseFactory();
        await database.pool.query(
          "DELETE FROM admin_oidc_flows WHERE expires_at < $1",
          [now()]
        );
        await database.pool.query(
          `INSERT INTO admin_oidc_flows (state_hash, expires_at)
           VALUES ($1, $2)`,
          [await sha256Base64Url(state), new Date(now().getTime() + 10 * 60 * 1000)]
        );
      } catch (error) {
        logAdminOidcError(logger, error, {
          stage: "oidc_flow_lookup",
          reason: "flow_initialization_failed"
        });
        return loginError("oidc_flow_failed");
      }
      const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        access_type: "online",
        prompt: "select_account",
        hd: hostedDomain,
        state,
        nonce,
        code_challenge: await sha256Base64Url(codeVerifier),
        code_challenge_method: "S256",
        claims: JSON.stringify({
          id_token: {
            amr: { essential: true },
            auth_time: { essential: true }
          }
        })
      }).toString();
      return redirect(authorizationUrl.toString(), {
        "Set-Cookie": buildOidcFlowCookie(flowToken)
      });
    }

    if (url.pathname !== "/admin-auth/callback" || request.method !== "GET") {
      return Response.json({
        success: false,
        code: "admin_auth_not_found",
        message: "Admin authentication endpoint not found."
      }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    const clearFlowHeader = { "Set-Cookie": clearOidcFlowCookie() };
    if (!sessionSecret) {
      logAdminOidcError(logger, null, {
        stage: "session_creation",
        reason: "session_secret_missing"
      });
      return loginError("oidc_denied", clearFlowHeader);
    }
    if (url.searchParams.get("error")) {
      logAdminOidcError(logger, null, {
        stage: "state_validation",
        reason: "provider_denied"
      });
      return loginError("oidc_denied", clearFlowHeader);
    }
    const flow = await verifyOidcFlowToken(
      getCookie(request, OIDC_FLOW_COOKIE_NAME),
      sessionSecret,
      { now }
    );
    if (!flow) {
      logAdminOidcError(logger, null, {
        stage: "flow_expired",
        reason: "flow_cookie_invalid_or_expired"
      });
      return loginError("invalid_oidc_state", clearFlowHeader);
    }
    if (!await timingSafeTextEqual(url.searchParams.get("state") || "", flow.state)) {
      logAdminOidcError(logger, null, {
        stage: "state_validation",
        reason: "state_mismatch"
      });
      return loginError("invalid_oidc_state", clearFlowHeader);
    }

    const consumed = await databaseFactory().pool.query(
      `UPDATE admin_oidc_flows
       SET consumed_at = $1
       WHERE state_hash = $2
         AND consumed_at IS NULL
         AND expires_at > $1
       RETURNING state_hash`,
      [now(), await sha256Base64Url(flow.state)]
    ).catch((error) => {
      logAdminOidcError(logger, error, {
        stage: "oidc_flow_lookup",
        reason: "replay_check_failed"
      });
      return { rows: [] };
    });
    if (!consumed.rows[0]) {
      logAdminOidcError(logger, null, {
        stage: "flow_replayed",
        reason: "flow_missing_expired_or_consumed"
      });
      return loginError("invalid_oidc_state", clearFlowHeader);
    }

    const code = url.searchParams.get("code");
    const clientId = environmentReader("ADMIN_OIDC_CLIENT_ID");
    const clientSecret = environmentReader("ADMIN_OIDC_CLIENT_SECRET");
    const hostedDomain = environmentReader("ADMIN_OIDC_HOSTED_DOMAIN");
    if (!code || !clientId || !clientSecret || !hostedDomain || !fetchImplementation) {
      logAdminOidcError(logger, null, {
        stage: "token_exchange",
        reason: code ? "oidc_configuration_missing" : "authorization_code_missing"
      });
      return loginError("oidc_not_configured", clearFlowHeader);
    }

    try {
      const redirectUri = environmentReader("ADMIN_OIDC_REDIRECT_URI")
        || `${url.origin}/admin-auth/callback`;
      let tokenResponse;
      try {
        tokenResponse = await fetchImplementation(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: flow.code_verifier
          })
        });
      } catch (error) {
        throw new AdminOidcDiagnosticError("token_exchange", "request_failed", {
          cause: error
        });
      }
      let tokenResult;
      try {
        tokenResult = await tokenResponse.json();
      } catch (error) {
        throw new AdminOidcDiagnosticError("token_exchange", "invalid_json_response", {
          status: tokenResponse.status,
          cause: error
        });
      }
      if (!tokenResponse.ok) {
        throw new AdminOidcDiagnosticError("token_exchange", "http_error", {
          status: tokenResponse.status
        });
      }
      if (typeof tokenResult.id_token !== "string") {
        throw new AdminOidcDiagnosticError("token_exchange", "id_token_missing", {
          status: tokenResponse.status
        });
      }
      const claims = await idTokenVerifier(tokenResult.id_token, {
        clientId,
        nonce: flow.nonce,
        hostedDomain,
        now
      });
      const identity = await resolveOrProvisionIdentity(
        databaseFactory(), claims, environmentReader, now
      );
      if (!identity) return loginError("admin_not_authorized", clearFlowHeader);
      let sessionToken;
      try {
        sessionToken = await createAdminSessionToken({
          provider: identity.identity_provider,
          externalSubject: identity.external_subject
        }, sessionSecret, { now });
      } catch (error) {
        throw new AdminOidcDiagnosticError("session_creation", "session_signing_failed", {
          cause: error
        });
      }
      const headers = new Headers(clearFlowHeader);
      try {
        headers.append("Set-Cookie", buildSessionCookie(sessionToken));
      } catch (error) {
        throw new AdminOidcDiagnosticError("cookie_creation", "session_cookie_failed", {
          cause: error
        });
      }
      return redirect(flow.redirect_to, headers);
    } catch (error) {
      logAdminOidcError(logger, error);
      const loginCode = error instanceof AdminOidcDiagnosticError
        && error.stage === "token_exchange"
        ? "oidc_exchange_failed"
        : error instanceof AdminOidcDiagnosticError
          && error.status === 401
          ? "admin_not_authorized"
          : "oidc_verification_failed";
      return loginError(loginCode, clearFlowHeader);
    }
  };
}

export const config = {
  path: ["/admin-login", "/admin-auth/callback", "/admin-logout"],
  rateLimit: { windowLimit: 20, windowSize: 180, aggregateBy: ["ip"] }
};

export {
  AdminOidcDiagnosticError,
  createHandler,
  hasMfaEvidence,
  logAdminOidcError,
  resolveOrProvisionIdentity,
  safeAdminRedirect,
  verifyGoogleIdToken
};

export default createHandler();
