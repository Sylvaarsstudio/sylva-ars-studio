import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

import {
  config,
  createHandler,
  listInquiries,
  updateInquiryStatus
} from "../../netlify/functions/admin-inquiries.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const apiUrl = "http://localhost/admin/api/inquiries";
const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";

let database;
let db;
let handler;
let sessionCookie;
let seeded;

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
    INSERT INTO inquiries (
      form_type,
      client_name,
      client_email,
      client_phone,
      artwork_title,
      artwork_subject,
      artwork_size,
      budget_range,
      estimated_date,
      occasion,
      shipping_location,
      preferred_contact_method,
      reference_notes,
      organization_project,
      collaboration_type,
      message,
      status,
      created_at,
      updated_at
    ) VALUES
      ('contact', 'Contact Client', 'contact@example.invalid', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Contact message', 'new', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'),
      ('artwork_inquiry', 'Artwork Client', 'artwork@example.invalid', NULL, 'Still Here', NULL, NULL, NULL, NULL, NULL, 'York, PA', 'email', NULL, NULL, NULL, 'Artwork message', 'reviewing', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
      ('commission_request', 'Commission Client', 'commission@example.invalid', NULL, NULL, 'Portrait', '24 x 36 in', '$1,000 - $2,500', 'within_3_months', 'birthday', 'Miami, FL', NULL, 'Reference notes', NULL, NULL, 'Commission message', 'new', '2026-01-03T10:00:00Z', '2026-01-03T10:00:00Z'),
      ('collaboration', 'Collaboration Client', 'collaboration@example.invalid', NULL, NULL, NULL, NULL, NULL, 'flexible', NULL, NULL, NULL, NULL, 'Museum exhibition', 'Exhibition', 'Collaboration message', 'replied', '2026-01-04T10:00:00Z', '2026-01-04T10:00:00Z')
    RETURNING id, form_type
  `);

  seeded = Object.fromEntries(
    result.rows.map((row) => [row.form_type, row.id])
  );
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM inquiries");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(method = "GET", path = "", body, cookie = sessionCookie) {
  const headers = {};

  if (cookie) {
    headers.Cookie = cookie;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return handler(new Request(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

test("phase 8 exposes only admin-scoped custom paths", () => {
  assert.equal(Array.isArray(config.path), true);
  assert.equal(config.path.every((path) => typeof path === "string"), true);
  assert.deepEqual(config.path, [
    "/admin/api/inquiries",
    "/admin/api/inquiries/:id"
  ]);
});

test("phase 8 lists inquiries by created_at descending", async () => {
  const response = await request();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 4);
  assert.deepEqual(
    body.inquiries.map((inquiry) => inquiry.form_type),
    ["collaboration", "commission_request", "artwork_inquiry", "contact"]
  );
});

test("phase 8 filters inquiries by status", async () => {
  const response = await request("GET", "?status=new");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.inquiries.every((inquiry) => inquiry.status === "new"), true);
});

test("phase 8 filters inquiries by form type", async () => {
  const response = await request("GET", "?form_type=artwork_inquiry");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.inquiries[0].id, seeded.artwork_inquiry);
});

test("phase 8 returns inquiry detail for a valid UUID", async () => {
  const response = await request("GET", `/${seeded.commission_request}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.inquiry.id, seeded.commission_request);
  assert.equal(body.inquiry.artwork_subject, "Portrait");
  assert.equal(body.inquiry.message, "Commission message");
});

test("phase 8 returns 404 for an unknown UUID", async () => {
  const response = await request(
    "GET",
    "/00000000-0000-4000-8000-000000000001"
  );
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.message, "Inquiry not found.");
});

test("phase 8 updates only status and updated_at", async () => {
  const id = seeded.contact;
  const before = await db.pool.query("SELECT * FROM inquiries WHERE id = $1", [id]);
  const response = await request("PATCH", `/${id}`, { status: "accepted" });
  const body = await response.json();
  const afterUpdate = await db.pool.query("SELECT * FROM inquiries WHERE id = $1", [id]);
  const beforeRow = before.rows[0];
  const afterRow = afterUpdate.rows[0];

  assert.equal(response.status, 200);
  assert.equal(body.inquiry.id, id);
  assert.equal(body.inquiry.status, "accepted");
  assert.equal(afterRow.updated_at > beforeRow.updated_at, true);

  for (const field of Object.keys(beforeRow)) {
    if (field !== "status" && field !== "updated_at") {
      assert.deepEqual(afterRow[field], beforeRow[field]);
    }
  }
});

test("phase 8 rejects an invalid status without changing the row", async () => {
  const id = seeded.contact;
  const response = await request("PATCH", `/${id}`, { status: "archived" });
  const body = await response.json();
  const stored = await db.pool.query(
    "SELECT status FROM inquiries WHERE id = $1",
    [id]
  );

  assert.equal(response.status, 400);
  assert.equal(body.message, "Unsupported status.");
  assert.equal(stored.rows[0].status, "new");
});

test("phase 8 rejects attempts to update fields other than status", async () => {
  const response = await request("PATCH", `/${seeded.contact}`, {
    status: "closed",
    message: "Changed"
  });

  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).message,
    "Request body must contain only status."
  );
});

test("phase 8 uses parameterized SQL for filters and status updates", async () => {
  const calls = [];
  const fakeDb = {
    pool: {
      async query(text, values) {
        calls.push({ text, values });
        return { rows: [] };
      }
    }
  };
  const id = "00000000-0000-4000-8000-000000000001";

  await listInquiries(fakeDb, {
    status: "reviewing",
    formType: "contact"
  });
  await updateInquiryStatus(fakeDb, id, "closed");

  assert.match(calls[0].text, /status = \$1/);
  assert.match(calls[0].text, /form_type = \$2/);
  assert.deepEqual(calls[0].values, ["reviewing", "contact"]);
  assert.match(calls[1].text, /status = \$1/);
  assert.match(calls[1].text, /id = \$2/);
  assert.deepEqual(calls[1].values, ["closed", id]);
  assert.equal(calls[1].text.includes(id), false);
});

for (const [method, path, body] of [
  ["GET", "", undefined],
  ["GET", "/00000000-0000-4000-8000-000000000001", undefined],
  ["PATCH", "/00000000-0000-4000-8000-000000000001", { status: "closed" }]
]) {
  test(`phase 8 rejects unauthenticated ${method} ${path || "list"}`, async () => {
    const response = await request(method, path, body, "");

    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, "Unauthorized.");
  });
}

test("phase 8 does not create clients or commissions", async () => {
  await request();
  await request("GET", `/${seeded.artwork_inquiry}`);
  await request("PATCH", `/${seeded.commission_request}`, { status: "reviewing" });

  const counts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM clients) AS clients,
      (SELECT count(*)::integer FROM commissions) AS commissions
  `);

  assert.deepEqual(counts.rows[0], { clients: 0, commissions: 0 });
});
