import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler as createEdgeHandler } from "../../netlify/edge-functions/admin-auth.js";
import { createHandler as createAuthHandler } from "../../netlify/functions/admin-auth.mjs";
import { createHandler as createSessionsHandler } from "../../netlify/functions/admin-sessions.mjs";
import { authorizeAdminRequest } from "../../netlify/shared/admin-authorization.mjs";
import {
  COOKIE_NAME,
  createAdminSessionToken,
  randomToken,
  SESSION_LENGTH_SECONDS
} from "../../netlify/shared/admin-session.mjs";
import {
  cleanupAdminSessions,
  createStoredAdminSession,
  summarizeUserAgent
} from "../../netlify/shared/admin-session-store.mjs";

const sessionSecret = "sas004-test-session-secret-with-sufficient-entropy";
const fixedNow = new Date("2026-11-12T18:00:00.000Z");

let database;
let db;
let identities;

function environment() {
  const values = {
    ADMIN_SESSION_SECRET: sessionSecret,
    ADMIN_OIDC_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    ADMIN_OIDC_CLIENT_SECRET: "test-client-secret",
    ADMIN_OIDC_HOSTED_DOMAIN: "studio.example",
    ADMIN_OIDC_REDIRECT_URI: "https://studio.example/admin-auth/callback",
    ADMIN_BOOTSTRAP_OWNER_EMAIL: "owner@studio.example",
    ADMIN_LEGACY_LOGIN_ENABLED: "false"
  };
  return (name) => values[name];
}

function request(path, method = "GET", cookie = "", body) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  const options = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  return new Request(`https://studio.example${path}`, options);
}

async function issueSession(subject, {
  tokenNow = fixedNow,
  createdAt = tokenNow,
  expiresAt = new Date(createdAt.getTime() + SESSION_LENGTH_SECONDS * 1000),
  userAgent = "Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15"
} = {}) {
  const sessionId = randomToken(24);
  const token = await createAdminSessionToken({
    provider: "google",
    externalSubject: subject,
    sessionId
  }, sessionSecret, { now: () => tokenNow });
  const row = await createStoredAdminSession(db, {
    adminUserId: identities[subject].id,
    sessionIdentifier: sessionId,
    createdAt,
    expiresAt,
    userAgent
  });
  return {
    token,
    row,
    cookie: `${COOKIE_NAME}=${token}`
  };
}

async function completeOidcLogin(auth, userAgent) {
  const start = await auth(new Request(
    "https://studio.example/admin-login?redirect=/admin/dashboard.html",
    { headers: { "User-Agent": userAgent } }
  ));
  const authorization = new URL(start.headers.get("location"));
  const flowCookie = start.headers.get("set-cookie").split(";", 1)[0];
  const callback = await auth(new Request(
    `https://studio.example/admin-auth/callback?code=one-time-code&state=${encodeURIComponent(authorization.searchParams.get("state"))}`,
    { headers: { Cookie: flowCookie, "User-Agent": userAgent } }
  ));
  assert.equal(callback.status, 302);
  const match = callback.headers.get("set-cookie").match(/sylva_admin_session=([^;]+)/);
  assert.ok(match);
  return decodeURIComponent(match[1]);
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
     ) VALUES
       ('google', 'owner-subject', 'owner@studio.example', 'Test Owner', 'owner_admin', 'active'),
       ('google', 'other-owner-subject', 'other-owner@studio.example', 'Other Owner', 'owner_admin', 'active'),
       ('google', 'viewer-subject', 'viewer@studio.example', 'Test Viewer', 'viewer', 'active'),
       ('google', 'disabled-subject', 'disabled@studio.example', 'Disabled User', 'viewer', 'disabled')
     RETURNING id, external_subject, role, status`
  );
  identities = Object.fromEntries(result.rows.map((row) => [row.external_subject, row]));
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("SAS-004 migration stores only a session identifier hash and coarse metadata", async () => {
  const columns = (await db.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'admin_sessions' ORDER BY column_name`
  )).rows.map((row) => row.column_name);
  assert.deepEqual(columns, [
    "admin_user_id", "created_at", "expires_at", "id", "last_seen_at",
    "revoked_at", "revoked_reason", "session_token_hash", "user_agent_summary"
  ]);
  assert.equal(columns.some((name) => /access_token|id_token|mfa|password|ip|geo/i.test(name)), false);
});

test("two OIDC logins create different stored sessions without retaining raw tokens", async () => {
  const auth = createAuthHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow,
    fetchImplementation: async () => Response.json({ id_token: "opaque-id-token" }),
    idTokenVerifier: async () => ({
      sub: "owner-subject",
      email: "owner@studio.example",
      name: "Test Owner",
      email_verified: true,
      hd: "studio.example",
      auth_time: Math.floor(fixedNow.getTime() / 1000),
      amr: ["pwd", "mfa"]
    })
  });
  const first = await completeOidcLogin(auth, "Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15");
  const second = await completeOidcLogin(auth, "Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36");
  assert.notEqual(first, second);

  const sessions = (await db.pool.query(
    `SELECT session_token_hash, user_agent_summary
     FROM admin_sessions ORDER BY created_at, id`
  )).rows;
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].session_token_hash, sessions[1].session_token_hash);
  assert.equal(JSON.stringify(sessions).includes(first), false);
  assert.equal(JSON.stringify(sessions).includes(second), false);
  assert.deepEqual(new Set(sessions.map((row) => row.user_agent_summary)), new Set([
    "Safari · macOS", "Chrome · macOS"
  ]));
});

test("valid stored session is allowed while unknown and tampered sessions are denied", async () => {
  const valid = await issueSession("owner-subject");
  const allowed = await authorizeAdminRequest(
    request("/admin/api/session", "GET", valid.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.identity.role, "owner_admin");

  const unknownToken = await createAdminSessionToken({
    provider: "google",
    externalSubject: "owner-subject"
  }, sessionSecret, { now: () => fixedNow });
  const unknown = await authorizeAdminRequest(
    request("/admin/api/session", "GET", `${COOKIE_NAME}=${unknownToken}`),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(unknown.response.status, 401);

  const tamperedToken = `${valid.token.slice(0, -1)}${valid.token.endsWith("a") ? "b" : "a"}`;
  const tampered = await authorizeAdminRequest(
    request("/admin/api/session", "GET", `${COOKIE_NAME}=${tamperedToken}`),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(tampered.response.status, 401);
});

test("database-expired and revoked sessions fail even while their signed cookie is valid", async () => {
  const expired = await issueSession("owner-subject", {
    createdAt: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000),
    expiresAt: new Date(fixedNow.getTime() - 60 * 60 * 1000)
  });
  const expiredResult = await authorizeAdminRequest(
    request("/admin/api/session", "GET", expired.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(expiredResult.response.status, 401);

  const revoked = await issueSession("owner-subject");
  await db.pool.query(
    "UPDATE admin_sessions SET revoked_at = $2, revoked_reason = 'test' WHERE id = $1",
    [revoked.row.id, fixedNow]
  );
  const revokedResult = await authorizeAdminRequest(
    request("/admin/api/session", "GET", revoked.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(revokedResult.response.status, 401);
});

test("disabled status and role changes take effect on the next request", async () => {
  const disabled = await issueSession("disabled-subject");
  const denied = await authorizeAdminRequest(
    request("/admin/api/session", "GET", disabled.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(denied.response.status, 401);

  const owner = await issueSession("owner-subject");
  await db.pool.query("UPDATE admin_users SET role = 'viewer' WHERE id = $1", [identities["owner-subject"].id]);
  const roleChanged = await authorizeAdminRequest(
    request("/admin/api/clients", "POST", owner.cookie, { full_name: "Blocked" }),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(roleChanged.response.status, 403);
  assert.equal(roleChanged.identity.role, "viewer");
});

test("logout revokes the current server-side session and replay fails immediately", async () => {
  const current = await issueSession("owner-subject");
  const auth = createAuthHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const response = await auth(request("/admin/logout", "GET", current.cookie));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/admin-login.html");
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  const stored = (await db.pool.query(
    "SELECT revoked_at, revoked_reason FROM admin_sessions WHERE id = $1",
    [current.row.id]
  )).rows[0];
  assert.ok(stored.revoked_at);
  assert.equal(stored.revoked_reason, "logout");

  const replay = await authorizeAdminRequest(
    request("/admin/api/session", "GET", current.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(replay.response.status, 401);
});

test("Owner session inventory is safe and excludes other users", async () => {
  const current = await issueSession("owner-subject");
  await issueSession("owner-subject", { userAgent: "Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1" });
  await issueSession("viewer-subject");
  const handler = createSessionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const response = await handler(request("/admin/api/sessions", "GET", current.cookie));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessions.length, 2);
  assert.equal(body.sessions.filter((session) => session.current_session).length, 1);
  assert.deepEqual(Object.keys(body.sessions[0]).sort(), [
    "created_at", "current_session", "expires_at", "id", "last_seen_at", "user_agent_summary"
  ]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /token|hash|claims?|external_subject|ip_address|geolocation/i
  );
});

test("Owner can revoke another own session but not the current or another user's", async () => {
  const current = await issueSession("owner-subject");
  const other = await issueSession("owner-subject");
  const foreign = await issueSession("viewer-subject");
  const handler = createSessionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });

  const revoked = await handler(request(
    `/admin/api/sessions/${other.row.id}/revoke`, "POST", current.cookie
  ));
  assert.equal(revoked.status, 200);
  const otherReplay = await authorizeAdminRequest(
    request("/admin/api/session", "GET", other.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => fixedNow }
  );
  assert.equal(otherReplay.response.status, 401);

  const currentAttempt = await handler(request(
    `/admin/api/sessions/${current.row.id}/revoke`, "POST", current.cookie
  ));
  assert.equal(currentAttempt.status, 409);

  const foreignAttempt = await handler(request(
    `/admin/api/sessions/${foreign.row.id}/revoke`, "POST", current.cookie
  ));
  assert.equal(foreignAttempt.status, 404);
  assert.equal((await db.pool.query(
    "SELECT revoked_at FROM admin_sessions WHERE id = $1", [foreign.row.id]
  )).rows[0].revoked_at, null);
});

test("Viewer receives 403 for the session inventory and mutations", async () => {
  const viewer = await issueSession("viewer-subject");
  const handler = createSessionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  for (const [method, path] of [
    ["GET", "/admin/api/sessions"],
    ["POST", "/admin/api/sessions/00000000-0000-4000-8000-000000000000/revoke"],
    ["POST", "/admin/api/sessions/sign-out-others"]
  ]) {
    const response = await handler(request(path, method, viewer.cookie));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "admin_forbidden");
  }
});

test("Viewer cannot open the Active Sessions page through the Admin edge gate", async () => {
  const viewer = await issueSession("viewer-subject");
  const edge = createEdgeHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const response = await edge(
    request("/admin/security.html", "GET", viewer.cookie),
    { next: () => new Response("allowed") }
  );
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Forbidden.");
});

test("sign out all other sessions is atomic, idempotent, and preserves current", async () => {
  const current = await issueSession("owner-subject");
  const otherOne = await issueSession("owner-subject");
  const otherTwo = await issueSession("owner-subject");
  const foreign = await issueSession("other-owner-subject");
  const handler = createSessionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const first = await handler(request(
    "/admin/api/sessions/sign-out-others", "POST", current.cookie
  ));
  assert.equal((await first.json()).revoked_count, 2);
  const second = await handler(request(
    "/admin/api/sessions/sign-out-others", "POST", current.cookie
  ));
  assert.equal((await second.json()).revoked_count, 0);

  const rows = (await db.pool.query(
    "SELECT id, revoked_at FROM admin_sessions WHERE id = ANY($1::uuid[])",
    [[current.row.id, otherOne.row.id, otherTwo.row.id, foreign.row.id]]
  )).rows;
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId[current.row.id].revoked_at, null);
  assert.ok(byId[otherOne.row.id].revoked_at);
  assert.ok(byId[otherTwo.row.id].revoked_at);
  assert.equal(byId[foreign.row.id].revoked_at, null);
});

test("concurrent revoke is safe and idempotent", async () => {
  const current = await issueSession("owner-subject");
  const other = await issueSession("owner-subject");
  const handler = createSessionsHandler({
    databaseFactory: () => db,
    environmentReader: environment(),
    now: () => fixedNow
  });
  const responses = await Promise.all([
    handler(request(`/admin/api/sessions/${other.row.id}/revoke`, "POST", current.cookie)),
    handler(request(`/admin/api/sessions/${other.row.id}/revoke`, "POST", current.cookie))
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const row = (await db.pool.query(
    "SELECT revoked_at, revoked_reason FROM admin_sessions WHERE id = $1", [other.row.id]
  )).rows[0];
  assert.ok(row.revoked_at);
  assert.equal(row.revoked_reason, "owner_revoke");
});

test("last_seen_at updates no more than once per ten-minute window", async () => {
  const session = await issueSession("owner-subject");
  const atNineMinutes = new Date(fixedNow.getTime() + 9 * 60 * 1000);
  await authorizeAdminRequest(
    request("/admin/api/session", "GET", session.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => atNineMinutes }
  );
  let stored = (await db.pool.query(
    "SELECT last_seen_at FROM admin_sessions WHERE id = $1", [session.row.id]
  )).rows[0];
  assert.equal(new Date(stored.last_seen_at).getTime(), fixedNow.getTime());

  const atElevenMinutes = new Date(fixedNow.getTime() + 11 * 60 * 1000);
  await authorizeAdminRequest(
    request("/admin/api/session", "GET", session.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => atElevenMinutes }
  );
  stored = (await db.pool.query(
    "SELECT last_seen_at FROM admin_sessions WHERE id = $1", [session.row.id]
  )).rows[0];
  assert.equal(new Date(stored.last_seen_at).getTime(), atElevenMinutes.getTime());
});

test("signed and stored session expiry is absolute at eight hours with no sliding extension", async () => {
  const session = await issueSession("owner-subject");
  assert.equal(
    new Date(session.row.expires_at).getTime() - new Date(session.row.created_at).getTime(),
    SESSION_LENGTH_SECONDS * 1000
  );
  const afterExpiry = new Date(fixedNow.getTime() + SESSION_LENGTH_SECONDS * 1000);
  const denied = await authorizeAdminRequest(
    request("/admin/api/session", "GET", session.cookie),
    { databaseFactory: () => db, environmentReader: environment(), now: () => afterExpiry }
  );
  assert.equal(denied.response.status, 401);
  const stored = (await db.pool.query(
    "SELECT expires_at FROM admin_sessions WHERE id = $1", [session.row.id]
  )).rows[0];
  assert.equal(new Date(stored.expires_at).getTime(), fixedNow.getTime() + SESSION_LENGTH_SECONDS * 1000);
});

test("coarse user-agent summaries omit raw identifiers", () => {
  assert.equal(
    summarizeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15"),
    "Safari · macOS"
  );
  assert.equal(
    summarizeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1"),
    "Safari · iPhone"
  );
  assert.equal(
    summarizeUserAgent("Mozilla/5.0 (Macintosh) Chrome/130.0.0.0 Safari/537.36"),
    "Chrome · macOS"
  );
  assert.equal(summarizeUserAgent("opaque-private-client-value"), null);
});

test("opportunistic cleanup removes only expired or revoked sessions older than retention", async () => {
  const stale = await issueSession("owner-subject", {
    tokenNow: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T08:00:00.000Z")
  });
  const recent = await issueSession("owner-subject");
  await cleanupAdminSessions(db, fixedNow);
  const ids = (await db.pool.query("SELECT id FROM admin_sessions ORDER BY id")).rows.map((row) => row.id);
  assert.equal(ids.includes(stale.row.id), false);
  assert.equal(ids.includes(recent.row.id), true);
});
