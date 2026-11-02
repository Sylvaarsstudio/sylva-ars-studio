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
  if (["mfa", "hwk", "swk"].some((method) => methods.has(method))) return true;
  const knowledge = methods.has("pwd") || methods.has("pin");
  const secondFactor = ["otp", "sms", "tel", "face", "fpt"].some((method) => methods.has(method));
  return knowledge && secondFactor;
}

async function verifyGoogleIdToken(idToken, {
  clientId,
  nonce,
  hostedDomain,
  now = () => new Date()
}) {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    audience: clientId,
    issuer: ["https://accounts.google.com", "accounts.google.com"]
  });
  const currentTime = Math.floor(now().getTime() / 1000);
  if (
    payload.nonce !== nonce
    || payload.email_verified !== true
    || payload.hd !== hostedDomain
    || typeof payload.sub !== "string"
    || typeof payload.email !== "string"
    || !Number.isInteger(payload.auth_time)
    || payload.auth_time > currentTime + 60
    || currentTime - payload.auth_time > 10 * 60
    || !hasMfaEvidence(payload.amr)
  ) {
    throw new Error("Google identity claims did not satisfy the admin policy.");
  }
  return payload;
}

async function resolveOrProvisionIdentity(database, claims, environmentReader, now) {
  const provider = "google";
  const subject = claims.sub;
  const email = claims.email.trim().toLowerCase();
  const displayName = typeof claims.name === "string" ? claims.name.trim() || null : null;
  const existing = await database.pool.query(
    `SELECT id, identity_provider, external_subject, email, display_name, role, status
     FROM admin_users
     WHERE identity_provider = $1 AND external_subject = $2`,
    [provider, subject]
  );

  if (existing.rows[0]) {
    if (existing.rows[0].status !== "active") return null;
    const updated = await database.pool.query(
      `UPDATE admin_users
       SET email = $1, display_name = $2, last_login_at = $3, updated_at = $3
       WHERE id = $4
       RETURNING id, identity_provider, external_subject, email, display_name, role, status`,
      [email, displayName, now(), existing.rows[0].id]
    );
    return updated.rows[0];
  }

  const ownerEmail = environmentReader("ADMIN_BOOTSTRAP_OWNER_EMAIL")?.trim().toLowerCase();
  const viewerEmail = environmentReader("ADMIN_BOOTSTRAP_VIEWER_EMAIL")?.trim().toLowerCase();
  let role = null;
  if (ownerEmail && email === ownerEmail) role = "owner_admin";
  if (viewerEmail && email === viewerEmail) {
    if (role) throw new Error("Admin bootstrap identities overlap.");
    role = "viewer";
  }
  if (!role) return null;

  const inserted = await database.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, display_name, role,
       status, last_login_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6)
     RETURNING id, identity_provider, external_subject, email, display_name, role, status`,
    [provider, subject, email, displayName, role, now()]
  );
  return inserted.rows[0];
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  fetchImplementation = globalThis.fetch?.bind(globalThis),
  idTokenVerifier = verifyGoogleIdToken,
  now = () => new Date()
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
        console.error("Admin OIDC flow initialization failed.", {
          error_type: error?.name || "Error",
          error_code: error?.code || "unknown"
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
        max_age: "600",
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
    if (!sessionSecret || url.searchParams.get("error")) {
      return loginError("oidc_denied", clearFlowHeader);
    }
    const flow = await verifyOidcFlowToken(
      getCookie(request, OIDC_FLOW_COOKIE_NAME),
      sessionSecret,
      { now }
    );
    if (!flow || !await timingSafeTextEqual(url.searchParams.get("state") || "", flow.state)) {
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
      console.error("Admin OIDC replay check failed.", {
        error_type: error?.name || "Error",
        error_code: error?.code || "unknown"
      });
      return { rows: [] };
    });
    if (!consumed.rows[0]) return loginError("invalid_oidc_state", clearFlowHeader);

    const code = url.searchParams.get("code");
    const clientId = environmentReader("ADMIN_OIDC_CLIENT_ID");
    const clientSecret = environmentReader("ADMIN_OIDC_CLIENT_SECRET");
    const hostedDomain = environmentReader("ADMIN_OIDC_HOSTED_DOMAIN");
    if (!code || !clientId || !clientSecret || !hostedDomain || !fetchImplementation) {
      return loginError("oidc_not_configured", clearFlowHeader);
    }

    try {
      const redirectUri = environmentReader("ADMIN_OIDC_REDIRECT_URI")
        || `${url.origin}/admin-auth/callback`;
      const tokenResponse = await fetchImplementation(GOOGLE_TOKEN_ENDPOINT, {
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
      const tokenResult = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || typeof tokenResult.id_token !== "string") {
        return loginError("oidc_exchange_failed", clearFlowHeader);
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
      const sessionToken = await createAdminSessionToken({
        provider: identity.identity_provider,
        externalSubject: identity.external_subject
      }, sessionSecret, { now });
      const headers = new Headers(clearFlowHeader);
      headers.append("Set-Cookie", buildSessionCookie(sessionToken));
      return redirect(flow.redirect_to, headers);
    } catch (error) {
      console.error("Admin OIDC callback failed.", {
        error_type: error?.name || "Error",
        error_code: error?.code || "unknown"
      });
      return loginError("oidc_verification_failed", clearFlowHeader);
    }
  };
}

export const config = {
  path: ["/admin-login", "/admin-auth/callback", "/admin-logout"],
  rateLimit: { windowLimit: 20, windowSize: 180, aggregateBy: ["ip"] }
};

export {
  createHandler,
  hasMfaEvidence,
  resolveOrProvisionIdentity,
  safeAdminRedirect,
  verifyGoogleIdToken
};

export default createHandler();
