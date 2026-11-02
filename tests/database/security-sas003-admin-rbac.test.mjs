import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

import {
  AdminOidcDiagnosticError,
  config as authConfig,
  createHandler as createAuthHandler,
  hasMfaEvidence,
  logAdminOidcError,
  verifyGoogleIdToken
} from "../../netlify/functions/admin-auth.mjs";
import { createHandler as createClientsHandler } from "../../netlify/functions/admin-clients.mjs";
import { createHandler as createCommissionsHandler } from "../../netlify/functions/admin-commissions.mjs";
import { createHandler as createSessionInfoHandler } from "../../netlify/functions/admin-session-info.mjs";
import { createHandler as createEdgeHandler } from "../../netlify/edge-functions/admin-auth.js";
import { authorizeAdminRequest } from "../../netlify/shared/admin-authorization.mjs";
import {
  COOKIE_NAME,
  createAdminSessionToken,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const sessionSecret = "sas003-test-session-secret-with-sufficient-entropy";
const fixedNow = new Date("2026-11-01T16:00:00.000Z");
const identityRows = [
  ["owner-subject", "owner@example.invalid", "Test Owner", "owner_admin", "active"],
  ["viewer-subject", "viewer@example.invalid", "Test Viewer", "viewer", "active"],
  ["disabled-subject", "disabled@example.invalid", "Disabled Viewer", "viewer", "disabled"]
];

let database;
let db;
let identities;

function environment(overrides = {}) {
  const values = {
    ADMIN_SESSION_SECRET: sessionSecret,
    ADMIN_OIDC_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    ADMIN_OIDC_CLIENT_SECRET: "test-client-secret",
    ADMIN_OIDC_HOSTED_DOMAIN: "studio.example",
    ADMIN_OIDC_REDIRECT_URI: "https://studio.example/admin-auth/callback",
    ADMIN_BOOTSTRAP_OWNER_EMAIL: "new-owner@studio.example",
    ADMIN_BOOTSTRAP_VIEWER_EMAIL: "new-viewer@studio.example",
    ADMIN_LEGACY_LOGIN_ENABLED: "false",
    ...overrides
  };
  return (name) => values[name];
}

async function sessionCookie(subject, options = {}) {
  const token = await createAdminSessionToken({
    provider: "google",
    externalSubject: subject
  }, sessionSecret, { now: options.now || (() => fixedNow) });
  return `${COOKIE_NAME}=${token}`;
}

function request(path, method, cookie, body = { role: "owner_admin" }) {
  const headers = { Cookie: cookie, "X-Admin-Role": "owner_admin" };
  const options = { method, headers };
  if (!["GET", "HEAD"].includes(method)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return new Request(`https://studio.example${path}`, options);
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

beforeEach(async () => {
  await db.pool.query("DELETE FROM admin_oidc_flows");
  await db.pool.query("DELETE FROM admin_users");
  const result = await db.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, display_name, role, status
     )
     SELECT 'google', subject, email, display_name, role, status
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
       AS values(subject, email, display_name, role, status)
     RETURNING id, external_subject, role, status`,
    [
      identityRows.map((row) => row[0]),
      identityRows.map((row) => row[1]),
      identityRows.map((row) => row[2]),
      identityRows.map((row) => row[3]),
      identityRows.map((row) => row[4])
    ]
  );
  identities = Object.fromEntries(result.rows.map((row) => [row.external_subject, row]));
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("SAS-003 migration stores stable external identities and no credential material", async () => {
  const columns = await db.pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'admin_users'
     ORDER BY column_name`
  );
  const names = columns.rows.map((row) => row.column_name);
  assert.ok(names.includes("external_subject"));
  assert.ok(names.includes("role"));
  assert.ok(names.includes("status"));
  assert.equal(names.some((name) => /password|secret|token|mfa/i.test(name)), false);
  await assert.rejects(
    db.pool.query(
      `INSERT INTO admin_users (
         identity_provider, external_subject, email, role, status
       ) VALUES ('google', 'owner-subject', 'other@example.invalid', 'owner_admin', 'active')`
    ),
    /duplicate key/i
  );
});

test("SAS-003 sessions are unique, signed, expiring, and contain no role", async () => {
  const first = await createAdminSessionToken({ provider: "google", externalSubject: "owner-subject" }, sessionSecret, { now: () => fixedNow });
  const second = await createAdminSessionToken({ provider: "google", externalSubject: "owner-subject" }, sessionSecret, { now: () => fixedNow });
  assert.notEqual(first, second);
  assert.equal(first.includes("owner_admin"), false);

  const valid = await authorizeAdminRequest(
    request("/admin/api/clients", "GET", `${COOKIE_NAME}=${first}`),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.identity.role, "owner_admin");

  const tampered = `${first.slice(0, -1)}${first.endsWith("a") ? "b" : "a"}`;
  const denied = await authorizeAdminRequest(
    request("/admin/api/clients", "GET", `${COOKIE_NAME}=${tampered}`),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(denied.response.status, 401);

  const expired = await authorizeAdminRequest(
    request("/admin/api/clients", "GET", `${COOKIE_NAME}=${first}`),
    {
      databaseFactory: () => db,
      environmentReader: environment(),
      now: () => new Date(fixedNow.getTime() + 8 * 60 * 60 * 1000)
    }
  );
  assert.equal(expired.response.status, 401);
});

test("owner is writable, viewer is read-only, and disabled identities are unauthorized", async () => {
  const owner = await authorizeAdminRequest(
    request("/admin/api/clients", "POST", await sessionCookie("owner-subject")),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(owner.ok, true);

  const viewerRead = await authorizeAdminRequest(
    request("/admin/api/clients", "GET", await sessionCookie("viewer-subject")),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(viewerRead.ok, true);
  assert.equal(viewerRead.identity.role, "viewer");

  const viewerWrite = await authorizeAdminRequest(
    request("/admin/api/clients", "PATCH", await sessionCookie("viewer-subject")),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(viewerWrite.response.status, 403);
  assert.equal((await viewerWrite.response.json()).code, "admin_forbidden");

  const disabled = await authorizeAdminRequest(
    request("/admin/api/clients", "GET", await sessionCookie("disabled-subject")),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(disabled.response.status, 401);
});

test("viewer is denied across the complete mutation matrix despite role spoofing", async () => {
  const mutations = [
    ["POST", "/admin/api/clients"], ["PATCH", "/admin/api/clients/1"],
    ["PATCH", "/admin/api/inquiries/00000000-0000-4000-8000-000000000000"],
    ["POST", "/admin/api/inquiries/00000000-0000-4000-8000-000000000000/convert-client"],
    ["PATCH", "/admin/api/commissions/1"], ["PATCH", "/admin/api/commissions/1/status"],
    ["POST", "/admin/api/commissions/1/delivery"], ["PATCH", "/admin/api/commissions/1/delivery"],
    ["POST", "/admin/api/commissions/1/delivery/transition"],
    ["POST", "/admin/api/commissions/1/delivery/storage"],
    ["POST", "/admin/api/communications"], ["PATCH", "/admin/api/communications/1"],
    ["POST", "/admin/api/communications/1/ready"], ["POST", "/admin/api/communications/1/send"],
    ["POST", "/admin/api/communications/1/reconcile"], ["POST", "/admin/api/communications/1/resolve"],
    ["POST", "/admin/api/documents/contracts"], ["POST", "/admin/api/clients/1/quotations"],
    ["PATCH", "/admin/api/quotations/1"], ["POST", "/admin/api/quotations/1/issue"],
    ["POST", "/admin/api/quotations/1/mark-sent"], ["POST", "/admin/api/quotations/1/withdraw"],
    ["POST", "/admin/api/quotations/1/new-version"], ["POST", "/admin/api/quotations/1/accept"],
    ["POST", "/admin/api/commissions/1/payments"],
    ["POST", "/admin/api/payments/precommission-deposit"],
    ["POST", "/admin/api/shipping/estimate"]
  ];
  const cookie = await sessionCookie("viewer-subject");
  for (const [method, path] of mutations) {
    const result = await authorizeAdminRequest(request(`${path}?role=owner_admin`, method, cookie), {
      databaseFactory: () => db,
      environmentReader: environment(),
      now: () => fixedNow
    });
    assert.equal(result.response.status, 403, `${method} ${path}`);
    assert.equal((await result.response.json()).code, "admin_forbidden", `${method} ${path}`);
  }
});

test("all admin business handlers use the centralized authorizer", async () => {
  const files = [
    "admin-acceptances.mjs", "admin-calendar.mjs", "admin-clients.mjs",
    "admin-commissions.mjs", "admin-communications.mjs", "admin-contracts.mjs",
    "admin-documents.mjs", "admin-inquiries.mjs", "admin-invoices.mjs",
    "admin-payments.mjs", "admin-precommission-payments.mjs", "admin-quotations.mjs",
    "admin-receipts.mjs", "admin-shipping-estimates.mjs"
  ];
  for (const file of files) {
    const source = await readFile(`netlify/functions/${file}`, "utf8");
    assert.match(source, /authorizeAdminRequest\(request/);
    assert.doesNotMatch(source, /hasValidAdminSession/);
  }
});

test("viewer denial happens before persistence and owner can use the same endpoint", async () => {
  const handler = createClientsHandler({
    databaseFactory: () => db,
    environmentReader: environment()
  });
  const beforeCount = Number((await db.pool.query("SELECT count(*) FROM clients")).rows[0].count);
  const viewerResponse = await handler(request(
    "/admin/api/clients",
    "POST",
    await sessionCookie("viewer-subject", { now: () => new Date() }),
    { full_name: "Blocked Client", email: "blocked@example.invalid" }
  ));
  assert.equal(viewerResponse.status, 403);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM clients")).rows[0].count), beforeCount);

  const ownerResponse = await handler(request(
    "/admin/api/clients",
    "POST",
    await sessionCookie("owner-subject", { now: () => new Date() }),
    { full_name: "Allowed Client", email: "allowed@example.invalid" }
  ));
  assert.equal(ownerResponse.status, 201);
  await db.pool.query("DELETE FROM clients WHERE email = 'allowed@example.invalid'");
});

test("admin session endpoint exposes only server-resolved identity and role", async () => {
  const handler = createSessionInfoHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const response = await handler(request(
    "/admin/api/session",
    "GET",
    await sessionCookie("viewer-subject")
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.identity, {
    display_name: "Test Viewer",
    email: "viewer@example.invalid",
    role: "viewer",
    read_only: true,
    legacy: false
  });
  assert.equal(JSON.stringify(body).includes("external_subject"), false);
});

test("temporary legacy access is explicit and automatically closes once OIDC is configured", async () => {
  const password = "legacy-test-password";
  const oldToken = await createSessionToken(password, sessionSecret);
  const legacyRequest = request("/admin/api/clients", "GET", `${COOKIE_NAME}=${oldToken}`);
  const disabled = await authorizeAdminRequest(legacyRequest, {
    databaseFactory: () => db,
    environmentReader: environment({ ADMIN_PASSWORD: password })
  });
  assert.equal(disabled.response.status, 401);

  const enabled = await authorizeAdminRequest(legacyRequest, {
    databaseFactory: () => db,
    environmentReader: environment({
      ADMIN_PASSWORD: password,
      ADMIN_LEGACY_LOGIN_ENABLED: "true"
    })
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.identity.legacy, true);
});

test("edge gate accepts signed Google sessions and rejects legacy after cutover", async () => {
  const edge = createEdgeHandler({ environmentReader: environment() });
  let nextCalls = 0;
  const context = { next: () => { nextCalls += 1; return new Response("ok"); } };
  const accepted = await edge(request(
    "/admin/dashboard.html",
    "GET",
    await sessionCookie("owner-subject", { now: () => new Date() })
  ), context);
  assert.equal(accepted.status, 200);
  assert.equal(nextCalls, 1);

  const legacyToken = await createAdminSessionToken({
    provider: "legacy",
    externalSubject: "legacy-migration-owner"
  }, sessionSecret, { now: () => new Date() });
  const denied = await edge(request(
    "/admin/dashboard.html",
    "GET",
    `${COOKIE_NAME}=${legacyToken}`
  ), context);
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get("location"), /^\/admin-login\.html/);
});

test("commission status event is attributed to the current individual admin", async () => {
  const client = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Actor Client', 'actor-client@example.invalid') RETURNING id"
  )).rows[0];
  const commission = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-9001', $1, 'Actor Test', 'Attribution test', 'Oil', 100)
     RETURNING id`,
    [client.id]
  )).rows[0];
  const handler = createCommissionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const response = await handler(request(
    `/admin/api/commissions/${commission.id}/status`,
    "PATCH",
    await sessionCookie("owner-subject", { now: () => new Date() }),
    { status: "quoted" }
  ));
  assert.equal(response.status, 200);
  const event = (await db.pool.query(
    `SELECT actor_type, actor_id FROM commission_events
     WHERE commission_id = $1 AND event_type = 'commission_status_changed'`,
    [commission.id]
  )).rows[0];
  assert.deepEqual(event, {
    actor_type: "admin",
    actor_id: String(identities["owner-subject"].id)
  });
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commissions WHERE id = $1", [commission.id]);
  await db.pool.query("DELETE FROM clients WHERE id = $1", [client.id]);
});

test("session identity endpoint exposes a Netlify-statically-discoverable path", async () => {
  const source = await readFile("netlify/functions/admin-session-info.mjs", "utf8");
  assert.match(
    source,
    /export const config = \{ path: "\/admin\/api\/session" \};/,
    "Netlify requires the custom function path to be a string literal during bundling"
  );
});

test("Google OIDC uses PKCE, consumes state once, provisions configured owner, and never stores tokens", async () => {
  await db.pool.query("DELETE FROM admin_users");
  let exchanges = 0;
  const auth = createAuthHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow,
    fetchImplementation: async (_url, options) => {
      exchanges += 1;
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.ok(body.get("code_verifier").length >= 43);
      return Response.json({ id_token: "test-id-token", access_token: "discard-me" });
    },
    idTokenVerifier: async (_token, verification) => {
      assert.equal(verification.hostedDomain, "studio.example");
      assert.ok(verification.nonce.length >= 20);
      return {
        sub: "new-owner-subject",
        email: "new-owner@studio.example",
        name: "New Test Owner",
        email_verified: true,
        hd: "studio.example",
        amr: ["pwd", "mfa"],
        auth_time: Math.floor(fixedNow.getTime() / 1000)
      };
    }
  });

  const start = await auth(new Request(
    "https://studio.example/admin-login?redirect=/admin/clients.html"
  ));
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get("location"));
  assert.equal(authorization.origin, "https://accounts.google.com");
  assert.equal(authorization.searchParams.get("scope"), "openid email profile");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("code_challenge"), true);
  assert.equal(authorization.searchParams.has("max_age"), false);
  const requestedClaims = JSON.parse(authorization.searchParams.get("claims"));
  assert.equal(requestedClaims.id_token.amr.essential, true);
  assert.equal(requestedClaims.id_token.auth_time.essential, true);
  const flowCookie = start.headers.get("set-cookie").split(";", 1)[0];
  const callbackUrl = `https://studio.example/admin-auth/callback?code=one-time-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}`;
  const invalidState = await auth(new Request(
    "https://studio.example/admin-auth/callback?code=must-not-be-exchanged&state=wrong-state",
    { headers: { Cookie: flowCookie } }
  ));
  assert.equal(invalidState.status, 302);
  assert.match(invalidState.headers.get("location"), /error=invalid_oidc_state/);
  assert.equal(exchanges, 0);

  const callback = await auth(new Request(callbackUrl, { headers: { Cookie: flowCookie } }));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/admin/clients.html");
  assert.match(callback.headers.get("set-cookie"), /sylva_admin_session=/);
  const stored = (await db.pool.query(
    "SELECT external_subject, email, role, status FROM admin_users"
  )).rows;
  assert.deepEqual(stored, [{
    external_subject: "new-owner-subject",
    email: "new-owner@studio.example",
    role: "owner_admin",
    status: "active"
  }]);
  assert.equal(JSON.stringify(stored).includes("discard-me"), false);

  const replay = await auth(new Request(callbackUrl, { headers: { Cookie: flowCookie } }));
  assert.equal(replay.status, 302);
  assert.match(replay.headers.get("location"), /error=invalid_oidc_state/);
  assert.equal(exchanges, 1);
});

const validGoogleClaims = {
  iss: "https://accounts.google.com",
  aud: "test-client-id.apps.googleusercontent.com",
  sub: "safe-test-subject",
  email: "owner@studio.example",
  email_verified: true,
  hd: "studio.example",
  nonce: "safe-test-nonce",
  auth_time: Math.floor(fixedNow.getTime() / 1000),
  amr: ["pwd", "mfa"]
};

function verifyClaims(payload, overrides = {}) {
  return verifyGoogleIdToken("opaque-test-id-token", {
    clientId: "test-client-id.apps.googleusercontent.com",
    nonce: "safe-test-nonce",
    hostedDomain: "studio.example",
    now: () => fixedNow,
    jwtVerifier: async () => ({ payload }),
    keySet: {},
    ...overrides
  });
}

async function assertOidcDiagnostic(operation, stage, reason) {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof AdminOidcDiagnosticError, true);
    assert.equal(error.stage, stage);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("Google claim diagnostics isolate issuer, audience, nonce, domain, email, time sanity, and MFA failures", async () => {
  for (const [claim, stage, reason] of [
    ["iss", "issuer_validation", "invalid_issuer"],
    ["aud", "audience_validation", "invalid_audience"]
  ]) {
    await assertOidcDiagnostic(
      verifyClaims(validGoogleClaims, {
        jwtVerifier: async () => {
          const error = new Error("claim validation failed");
          error.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
          error.claim = claim;
          throw error;
        }
      }),
      stage,
      reason
    );
  }

  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, nonce: "wrong" }),
    "nonce_validation",
    "nonce_mismatch"
  );
  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, email_verified: false }),
    "email_verified",
    "email_not_verified"
  );
  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, hd: "other.example" }),
    "hosted_domain",
    "hosted_domain_mismatch"
  );
  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, auth_time: undefined }),
    "auth_time_missing",
    "claim_missing"
  );
  await assertOidcDiagnostic(
    verifyClaims({
      ...validGoogleClaims,
      auth_time: Math.floor(fixedNow.getTime() / 1000) + 61
    }),
    "auth_time_stale",
    "claim_in_future"
  );
  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, amr: undefined }),
    "amr_missing",
    "claim_missing"
  );
  await assertOidcDiagnostic(
    verifyClaims({ ...validGoogleClaims, amr: ["pwd"] }),
    "amr_insufficient",
    "mfa_evidence_insufficient"
  );

  assert.deepEqual(await verifyClaims(validGoogleClaims), validGoogleClaims);

  const establishedMfaSession = {
    ...validGoogleClaims,
    auth_time: Math.floor(fixedNow.getTime() / 1000) - (24 * 60 * 60)
  };
  assert.deepEqual(
    await verifyClaims(establishedMfaSession),
    establishedMfaSession,
    "auth_time records the Google session authentication event; MFA evidence is enforced through amr"
  );
});

test("OIDC diagnostics log only categorical fields and never exception messages, PII, tokens, or raw claims", () => {
  const captured = [];
  const error = new AdminOidcDiagnosticError(
    "amr_insufficient",
    "mfa_evidence_insufficient",
    {
      facts: {
        amr_present: true,
        amr_count: 1,
        mfa_evidence: "insufficient",
        email: "must-not-be-logged@example.invalid",
        raw_claims: "must-not-be-logged"
      },
      cause: new Error("authorization-code id-token client-secret password")
    }
  );
  logAdminOidcError((...arguments_) => captured.push(arguments_), error);
  logAdminOidcError(
    (...arguments_) => captured.push(arguments_),
    new Error("owner@example.invalid nonce-value state-value pkce-verifier")
  );

  assert.deepEqual(captured, [
    ["admin_oidc_error", {
      stage: "amr_insufficient",
      reason: "mfa_evidence_insufficient",
      amr_present: true,
      amr_count: 1,
      mfa_evidence: "insufficient"
    }],
    ["admin_oidc_error", {
      stage: "unknown",
      reason: "unexpected_error"
    }]
  ]);
  const serialized = JSON.stringify(captured);
  for (const prohibited of [
    "must-not-be-logged",
    "authorization-code",
    "id-token",
    "client-secret",
    "password",
    "owner@example.invalid",
    "nonce-value",
    "state-value",
    "pkce-verifier"
  ]) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test("MFA policy requires Google's explicit multifactor evidence", () => {
  assert.equal(hasMfaEvidence(["pwd", "mfa"]), true);
  assert.equal(hasMfaEvidence(["mfa", "pwd", "swk"]), true);
  assert.equal(hasMfaEvidence(["hwk"]), false);
  assert.equal(hasMfaEvidence(["swk"]), false);
  assert.equal(hasMfaEvidence(["pwd", "otp"]), false);
  assert.equal(hasMfaEvidence(["pwd"]), false);
  assert.equal(hasMfaEvidence(["sms"]), false);
  assert.equal(hasMfaEvidence(undefined), false);
});

test("authentication endpoints have a valid per-IP Netlify brute-force limit", () => {
  assert.deepEqual(authConfig.rateLimit, {
    windowLimit: 20,
    windowSize: 180,
    aggregateBy: ["ip"]
  });
});
