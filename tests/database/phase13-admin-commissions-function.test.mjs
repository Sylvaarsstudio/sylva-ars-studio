import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

import {
  config,
  createHandler
} from "../../netlify/functions/admin-commissions.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const apiUrl = "http://localhost/admin/api/commissions";
const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";

let database;
let db;
let handler;
let sessionCookie;
let clients;
let commissions;
let inquiryId;

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
  const clientResult = await db.pool.query(`
    INSERT INTO clients (full_name, email)
    VALUES
      ('First Client', 'first@example.invalid'),
      ('Second Client', 'second@example.invalid')
    RETURNING id, full_name
  `);
  clients = Object.fromEntries(
    clientResult.rows.map((client) => [client.full_name, client.id])
  );

  const commissionResult = await db.pool.query(`
    INSERT INTO commissions (
      commission_number,
      client_id,
      title,
      description,
      medium,
      price,
      created_at
    )
    VALUES
      ('SAS-COM-2025-0001', $1, 'Earlier Commission', 'Earlier description', 'Oil on canvas', 100, '2026-01-01T10:00:00Z'),
      ('SAS-COM-2025-0002', $2, 'Later Commission', 'Later description', 'Acrylic on canvas', 200, '2026-01-02T10:00:00Z')
    RETURNING id, title
  `, [clients["First Client"], clients["Second Client"]]);
  commissions = Object.fromEntries(
    commissionResult.rows.map((commission) => [commission.title, commission.id])
  );

  inquiryId = (await db.pool.query(`
    INSERT INTO inquiries (form_type, client_name, client_email, message)
    VALUES ('commission_request', 'Inquiry Client', 'first@example.invalid', 'Unchanged')
    RETURNING id
  `)).rows[0].id;
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM communications");
  await db?.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db?.pool.query("TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY");
  await db?.pool.query("DELETE FROM commission_production");
  await db?.pool.query("DELETE FROM commission_lifecycle");
  await db?.pool.query("DELETE FROM commission_inquiries");
  await db?.pool.query("DELETE FROM documents");
  await db?.pool.query("DELETE FROM payments");
  await db?.pool.query("DELETE FROM commissions");
  await db?.pool.query("DELETE FROM quotations");
  await db?.pool.query("DELETE FROM inquiries");
  await db?.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function createPayload(overrides = {}) {
  return {
    client_id: clients["First Client"],
    title: "New Commission",
    description: "A manually approved commission.",
    medium: "Oil",
    width: "20",
    height: "24",
    price: "100.00",
    sales_tax_rate: "0.06",
    shipping: "10.00",
    estimated_completion: "2027-01-15",
    ...overrides
  };
}

function editPayload(overrides = {}) {
  const { client_id, ...payload } = createPayload(overrides);
  return payload;
}

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

test("phase 13 exposes only protected commission paths", () => {
  assert.deepEqual(config.path, [
    "/admin/api/commissions",
    "/admin/api/commissions/:id",
    "/admin/api/commissions/:id/status",
    "/admin/api/commissions/:id/events",
    "/admin/api/commissions/:id/production",
    "/admin/api/commissions/:id/next-action",
    "/admin/api/commissions/:id/obligations",
    "/admin/api/commissions/:id/delivery",
    "/admin/api/commissions/:id/delivery/transition",
    "/admin/api/commissions/:id/delivery/storage",
    "/admin/api/commissions/:id/delivery/storage-notice",
    "/admin/api/commissions/:id/delivery/final-notice"
  ]);
  assert.equal(config.path.every((path) => typeof path === "string"), true);
});

test("phase 13 authenticated admin can list commissions", async () => {
  const response = await request();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 2);
  assert.equal(body.commissions.length, 2);
});

for (const [method, path, body] of [
  ["GET", "", undefined],
  ["GET", "/1", undefined],
  ["POST", "", {}],
  ["PATCH", "/1", {}],
  ["PATCH", "/1/status", { status: "quoted" }],
  ["GET", "/1/events", undefined],
  ["GET", "/1/production", undefined],
  ["GET", "/1/next-action", undefined],
  ["GET", "/1/obligations", undefined],
  ["GET", "/1/delivery", undefined],
  ["POST", "/1/delivery/transition", { next_status: "ready" }]
]) {
  test(`phase 13 rejects unauthenticated ${method} ${path || "list"}`, async () => {
    const response = await request(method, path, body, "");

    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, "Unauthorized.");
  });
}

test("phase 13 lists commissions by created_at descending", async () => {
  const body = await (await request()).json();

  assert.deepEqual(
    body.commissions.map((commission) => commission.title),
    ["Later Commission", "Earlier Commission"]
  );
});

test("phase 13 returns commission detail by id", async () => {
  const id = commissions["Later Commission"];
  const response = await request("GET", `/${id}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(String(body.commission.id), String(id));
  assert.equal(body.commission.client_name, "Second Client");
  assert.equal(body.commission.title, "Later Commission");
  assert.equal(body.commission.status, "draft");
});

test("Admin Commission read model prefers canonical lifecycle and exposes compact activation context", async () => {
  const id = commissions["Later Commission"];
  await db.pool.query(
    `INSERT INTO commission_lifecycle (
       commission_id, lifecycle_status, activated_at, activation_source
     ) VALUES ($1, 'active', '2026-10-12T15:00:00Z', 'required_deposit')`,
    [id]
  );
  const contract = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, client_id, document_type, document_number,
       version, file_location, document_snapshot
     ) VALUES ($1, $2, 'contract', 'SAS-CON-2026-0099', 1,
       '/admin/contract.html', '{}'::jsonb)
     RETURNING id`,
    [id, clients["Second Client"]]
  )).rows[0];

  const detail = await (await request("GET", `/${id}`)).json();
  const listed = await (await request()).json();
  const listRow = listed.commissions.find((commission) => String(commission.id) === String(id));

  assert.equal(detail.commission.lifecycle_status, "active");
  assert.equal(detail.commission.activation_source, "required_deposit");
  assert.equal(new Date(detail.commission.activated_at).toISOString(), "2026-10-12T15:00:00.000Z");
  assert.equal(String(detail.commission.contract_document_id), String(contract.id));
  assert.equal(detail.commission.contract_document_number, "SAS-CON-2026-0099");
  assert.equal(listRow.lifecycle_status, "active");
});

test("phase 6 returns protected commission activity without internal audit fields", async () => {
  const id = commissions["Later Commission"];
  assert.equal((await request("PATCH", `/${id}/status`, { status: "quoted" })).status, 200);
  const response = await request("GET", `/${id}/events`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.deepEqual(Object.keys(body.events[0]).sort(), [
    "actor_type",
    "event_type",
    "id",
    "occurred_at",
    "payload",
    "source_id",
    "source_type"
  ]);
  assert.equal(body.events[0].event_type, "commission_status_changed");
  assert.equal(body.events[0].source_type, "commission");
  assert.deepEqual(body.events[0].payload, {
    previous_status: "draft",
    new_status: "quoted"
  });
});

test("phase 6 activity returns 404 for an unknown commission and rejects mutations", async () => {
  assert.equal((await request("GET", "/999999/events")).status, 404);
  assert.equal((await request("POST", `/${commissions["Later Commission"]}/events`, {})).status, 405);
});

test("phase 13 returns 404 for an unknown commission", async () => {
  const response = await request("GET", "/999999999");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
});

for (const [currentStatus, nextStatus] of [
  ["draft", "quoted"],
  ["draft", "cancelled"],
  ["quoted", "draft"],
  ["quoted", "approved"],
  ["quoted", "cancelled"],
  ["approved", "quoted"],
  ["approved", "in_progress"],
  ["approved", "cancelled"],
  ["in_progress", "approved"],
  ["in_progress", "completed"],
  ["in_progress", "cancelled"],
  ["completed", "in_progress"],
  ["cancelled", "draft"]
]) {
  test(`commission status permits ${currentStatus} to ${nextStatus}`, async () => {
    const id = commissions["Earlier Commission"];
    await db.pool.query("UPDATE commissions SET status = $1 WHERE id = $2", [
      currentStatus,
      id
    ]);

    const response = await request("PATCH", `/${id}/status`, {
      status: nextStatus
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.commission.status, nextStatus);
  });
}

for (const [currentStatus, nextStatus] of [
  ["draft", "completed"],
  ["draft", "in_progress"],
  ["quoted", "completed"],
  ["completed", "draft"],
  ["cancelled", "approved"]
]) {
  test(`commission status rejects ${currentStatus} to ${nextStatus}`, async () => {
    const id = commissions["Earlier Commission"];
    await db.pool.query("UPDATE commissions SET status = $1 WHERE id = $2", [
      currentStatus,
      id
    ]);

    const response = await request("PATCH", `/${id}/status`, {
      status: nextStatus
    });
    const stored = await db.pool.query(
      "SELECT status FROM commissions WHERE id = $1",
      [id]
    );

    assert.equal(response.status, 409);
    assert.equal(
      (await response.json()).message,
      "Commission status transition is not allowed."
    );
    assert.equal(stored.rows[0].status, currentStatus);
  });
}

test("commission status rejects an unknown status", async () => {
  const id = commissions["Earlier Commission"];
  const response = await request("PATCH", `/${id}/status`, {
    status: "archived"
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, "Status is invalid.");
});

test("commission status returns 404 for an unknown commission", async () => {
  const response = await request("PATCH", "/999999999/status", {
    status: "quoted"
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
});

test("commission status rejects additional payload fields", async () => {
  const id = commissions["Earlier Commission"];
  const response = await request("PATCH", `/${id}/status`, {
    status: "quoted",
    price: "1.00"
  });

  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).message,
    "Request body must contain only status."
  );
});

test("commission status changes only status and creates only its audit event", async () => {
  const id = commissions["Earlier Commission"];
  await db.pool.query("UPDATE commissions SET status = 'in_progress' WHERE id = $1", [id]);
  const before = (await db.pool.query(
    `SELECT commission_number, client_id, price, deposit_amount, balance
     FROM commissions
     WHERE id = $1`,
    [id]
  )).rows[0];
  const inquiriesBefore = await db.pool.query("SELECT * FROM inquiries ORDER BY id");

  const response = await request("PATCH", `/${id}/status`, {
    status: "completed"
  });
  const after = (await db.pool.query(
    `SELECT commission_number, client_id, price, deposit_amount, balance, status
     FROM commissions
     WHERE id = $1`,
    [id]
  )).rows[0];
  const inquiriesAfter = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const relatedCounts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM payments) AS payments,
      (SELECT count(*)::integer FROM documents) AS documents
  `);
  const event = (await db.pool.query(
    "SELECT event_type, payload FROM commission_events WHERE commission_id = $1",
    [id]
  )).rows[0];
  const { status, ...unchanged } = after;

  assert.equal(response.status, 200);
  assert.equal(status, "completed");
  assert.deepEqual(unchanged, before);
  assert.deepEqual(inquiriesAfter.rows, inquiriesBefore.rows);
  assert.deepEqual(relatedCounts.rows[0], { payments: 0, documents: 0 });
  assert.equal(event.event_type, "commission_status_changed");
  assert.deepEqual(event.payload, { previous_status: "in_progress", new_status: "completed" });
});

for (const [field, value, responseField, expected] of [
  ["title", "Updated Title", "title", "Updated Title"],
  ["description", "Updated description.", "description", "Updated description."],
  ["medium", "Drawing", "medium", "Drawing"],
  ["width", "30.25", "width", "30.25"],
  ["height", "40.50", "height", "40.50"],
  ["price", "500.00", "price", "500.00"],
  ["sales_tax_rate", "0.08", "sales_tax", "8.00"],
  ["shipping", "25.00", "shipping", "25.00"],
  ["estimated_completion", "2027-08-15", "estimated_completion", "2027-08-15"]
]) {
  test(`commission edit updates approved field ${field}`, async () => {
    const id = commissions["Earlier Commission"];
    const response = await request("PATCH", `/${id}`, editPayload({ [field]: value }));
    const body = await response.json();
    const actual = responseField === "estimated_completion"
      ? String(body.commission[responseField]).slice(0, 10)
      : String(body.commission[responseField]);

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(actual, expected);
  });
}

for (const [field, value, message] of [
  ["title", "   ", "Title is required."],
  ["description", "", "Description is required."],
  ["medium", "Fresco", "Medium is unsupported."],
  ["sales_tax_rate", "0.09", "Sales tax rate is unsupported."],
  ["width", "0", "Width must be greater than 0."],
  ["height", "-1", "Height must be greater than 0."],
  ["price", "-0.01", "Price must be 0 or greater."],
  ["shipping", "-0.01", "Shipping must be 0 or greater."]
]) {
  test(`commission edit rejects invalid ${field}`, async () => {
    const id = commissions["Earlier Commission"];
    const response = await request("PATCH", `/${id}`, editPayload({ [field]: value }));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, message);
  });
}

test("commission edit returns 404 for an unknown commission", async () => {
  const response = await request("PATCH", "/999999999", editPayload());

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
});

for (const field of [
  "id",
  "commission_number",
  "client_id",
  "deposit_amount",
  "balance",
  "status",
  "created_at",
  "sales_tax"
]) {
  test(`commission edit rejects protected field ${field}`, async () => {
    const id = commissions["Earlier Commission"];
    const response = await request("PATCH", `/${id}`, {
      ...editPayload(),
      [field]: "protected"
    });

    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).message,
      "Request body contains unsupported fields."
    );
  });
}

test("commission edit preserves immutable and workflow fields", async () => {
  const id = commissions["Earlier Commission"];
  await db.pool.query(
    "UPDATE commissions SET deposit_amount = 25, status = 'approved' WHERE id = $1",
    [id]
  );
  const before = (await db.pool.query(
    `SELECT commission_number, client_id, deposit_amount, status, created_at
     FROM commissions
     WHERE id = $1`,
    [id]
  )).rows[0];

  const response = await request("PATCH", `/${id}`, editPayload({
    title: "Immutable Fields Preserved",
    price: "200.00"
  }));
  const after = (await db.pool.query(
    `SELECT commission_number, client_id, deposit_amount, status, created_at
     FROM commissions
     WHERE id = $1`,
    [id]
  )).rows[0];

  assert.equal(response.status, 200);
  assert.deepEqual(after, before);
});

test("commission edit recalculates tax and generated balance", async () => {
  const id = commissions["Earlier Commission"];
  const response = await request("PATCH", `/${id}`, editPayload({
    price: "400.00",
    sales_tax_rate: "0.07",
    shipping: "20.00"
  }));
  const commission = (await response.json()).commission;

  assert.equal(response.status, 200);
  assert.equal(commission.price, "400.00");
  assert.equal(commission.sales_tax, "28.00");
  assert.equal(commission.shipping, "20.00");
  assert.equal(commission.deposit_amount, "0.00");
  assert.equal(commission.balance, "448.00");
});

test("commission edit changes no inquiries, payments, or documents", async () => {
  const id = commissions["Earlier Commission"];
  const inquiriesBefore = await db.pool.query("SELECT * FROM inquiries ORDER BY id");

  const response = await request("PATCH", `/${id}`, editPayload());
  const inquiriesAfter = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const relatedCounts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM payments) AS payments,
      (SELECT count(*)::integer FROM documents) AS documents
  `);

  assert.equal(response.status, 200);
  assert.deepEqual(inquiriesAfter.rows, inquiriesBefore.rows);
  assert.deepEqual(relatedCounts.rows[0], { payments: 0, documents: 0 });
});

test("RC2.1 blocks direct Admin Commission creation", async () => {
  const response = await request("POST", "", createPayload());
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, "accepted_quotation_required");
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commissions"
  )).rows[0].count, 2);
});

test("phase 21 legacy commission detail remains valid without provenance", async () => {
  const response = await request("GET", `/${commissions["Earlier Commission"]}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.commission.inquiries, []);
});

test("commission edit accepts the outside-Pennsylvania zero-tax rate", async () => {
  const id = commissions["Earlier Commission"];
  const response = await request("PATCH", `/${id}`, editPayload({
    price: "400.00",
    sales_tax_rate: "0.00",
    shipping: "20.00"
  }));
  const commission = (await response.json()).commission;

  assert.equal(response.status, 200);
  assert.equal(commission.sales_tax, "0.00");
  assert.equal(commission.deposit_amount, "0.00");
  assert.equal(commission.shipping, "20.00");
  assert.equal(commission.balance, "420.00");
});
