import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

import {
  config,
  createHandler,
  getClient
} from "../../netlify/functions/admin-clients.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const apiUrl = "http://localhost/admin/api/clients";
const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";

let database;
let db;
let handler;
let sessionCookie;
let seededClients;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");

  db = getDatabase({ connectionString });
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  });
  const token = await createSessionToken(adminPassword, sessionSecret);
  sessionCookie = `${COOKIE_NAME}=${token}`;
});

beforeEach(async () => {
  const result = await db.pool.query(`
    INSERT INTO clients (full_name, email, phone, created_at)
    VALUES
      ('First Client', 'first@example.invalid', NULL, '2026-01-01T10:00:00Z'),
      ('Second Client', 'second@example.invalid', '555-0102', '2026-01-02T10:00:00Z'),
      ('Third Client', 'third@example.invalid', '555-0103', '2026-01-03T10:00:00Z')
    RETURNING id, full_name
  `);
  seededClients = Object.fromEntries(
    result.rows.map((client) => [client.full_name, client.id])
  );

  await db.pool.query(`
    INSERT INTO inquiries (form_type, client_name, client_email, message)
    VALUES ('contact', 'Inquiry Client', 'inquiry@example.invalid', 'Unchanged')
  `);
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM inquiries");
  await db?.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(path = "", cookie = sessionCookie) {
  const headers = {};

  if (cookie) {
    headers.Cookie = cookie;
  }

  return handler(new Request(`${apiUrl}${path}`, { headers }));
}

test("phase 10 exposes only protected admin client paths", () => {
  assert.deepEqual(config.path, [
    "/admin/api/clients",
    "/admin/api/clients/:id"
  ]);
  assert.equal(config.path.every((path) => typeof path === "string"), true);
});

test("phase 10 authenticated admin can list clients", async () => {
  const response = await request();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 3);
  assert.equal(body.clients.length, 3);
});

for (const path of ["", "/1"]) {
  test(`phase 10 rejects unauthenticated client request ${path || "list"}`, async () => {
    const response = await request(path, "");

    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, "Unauthorized.");
  });
}

test("phase 10 lists clients by created_at descending", async () => {
  const body = await (await request()).json();

  assert.deepEqual(
    body.clients.map((client) => client.full_name),
    ["Third Client", "Second Client", "First Client"]
  );
});

test("phase 10 returns only the requested client detail", async () => {
  const id = seededClients["Second Client"];
  const response = await request(`/${id}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.client).sort(), [
    "created_at",
    "email",
    "full_name",
    "id",
    "phone"
  ]);
  assert.equal(String(body.client.id), String(id));
  assert.equal(body.client.full_name, "Second Client");
  assert.equal(body.client.email, "second@example.invalid");
  assert.equal(body.client.phone, "555-0102");
});

test("phase 10 returns 404 for an unknown client", async () => {
  const response = await request("/999999999");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Client not found.");
});

test("phase 10 client detail uses parameterized SQL", async () => {
  const calls = [];
  const fakeDb = {
    pool: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      }
    }
  };

  await getClient(fakeDb, "42");

  assert.match(calls[0].text, /id = \$1/);
  assert.deepEqual(calls[0].values, ["42"]);
  assert.equal(calls[0].text.includes("42"), false);
});

test("phase 10 reads do not modify studio data", async () => {
  const clientsBefore = await db.pool.query(
    "SELECT id, full_name, email, phone, created_at FROM clients ORDER BY id"
  );
  const inquiriesBefore = await db.pool.query(
    "SELECT * FROM inquiries ORDER BY id"
  );

  await request();
  await request(`/${seededClients["First Client"]}`);

  const clientsAfter = await db.pool.query(
    "SELECT id, full_name, email, phone, created_at FROM clients ORDER BY id"
  );
  const inquiriesAfter = await db.pool.query(
    "SELECT * FROM inquiries ORDER BY id"
  );
  const relatedCounts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM commissions) AS commissions,
      (SELECT count(*)::integer FROM payments) AS payments,
      (SELECT count(*)::integer FROM documents) AS documents
  `);

  assert.deepEqual(clientsAfter.rows, clientsBefore.rows);
  assert.deepEqual(inquiriesAfter.rows, inquiriesBefore.rows);
  assert.deepEqual(relatedCounts.rows[0], {
    commissions: 0,
    payments: 0,
    documents: 0
  });
});
