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

  await db.pool.query(`
    INSERT INTO inquiries (form_type, client_name, client_email, message)
    VALUES ('commission_request', 'Inquiry Client', 'inquiry@example.invalid', 'Unchanged')
  `);
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM documents");
  await db?.pool.query("DELETE FROM payments");
  await db?.pool.query("DELETE FROM commissions");
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
    "/admin/api/commissions/:id"
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
  ["PATCH", "/1", {}]
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

test("phase 13 returns 404 for an unknown commission", async () => {
  const response = await request("GET", "/999999999");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
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

test("phase 13 creates a valid draft commission", async () => {
  const response = await request("POST", "", createPayload());
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.success, true);
  assert.equal(String(body.commission.client_id), String(clients["First Client"]));
  assert.equal(body.commission.title, "New Commission");
  assert.equal(body.commission.status, "draft");
  assert.equal(body.commission.deposit_amount, "0.00");
  assert.equal(body.commission.sales_tax, "6.00");
  assert.equal(body.commission.balance, "116.00");
});

for (const medium of ["Acrylic", "Watercolor", "Oil", "Drawing"]) {
  test(`phase 14 accepts the approved medium ${medium}`, async () => {
    const response = await request("POST", "", createPayload({ medium }));

    assert.equal(response.status, 201);
    assert.equal((await response.json()).commission.medium, medium);
  });
}

test("phase 14 rejects an unsupported medium", async () => {
  const response = await request("POST", "", createPayload({
    medium: "Fresco"
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, "Medium is unsupported.");
});

for (const [rate, expectedTax] of [
  ["0.00", "0.00"],
  ["0.06", "24.00"],
  ["0.07", "28.00"],
  ["0.08", "32.00"]
]) {
  test(`phase 14 calculates sales tax for rate ${rate}`, async () => {
    const response = await request("POST", "", createPayload({
      price: "400.00",
      sales_tax_rate: rate,
      shipping: "0"
    }));
    const commission = (await response.json()).commission;

    assert.equal(response.status, 201);
    assert.equal(commission.price, "400.00");
    assert.equal(commission.sales_tax, expectedTax);
    assert.equal(commission.balance, String((400 + Number(expectedTax)).toFixed(2)));
  });
}

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

for (const rate of ["", "0.05", "0.09", "7"] ) {
  test(`phase 14 rejects sales tax rate ${JSON.stringify(rate)}`, async () => {
    const response = await request("POST", "", createPayload({
      sales_tax_rate: rate
    }));

    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Sales tax rate/);
  });
}

test("phase 14 rejects a browser-supplied sales tax amount", async () => {
  const response = await request("POST", "", {
    ...createPayload(),
    sales_tax: "0.01"
  });

  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).message,
    "Request body contains unsupported fields."
  );
});

test("phase 15 required deposit policy does not reduce stored balance", async () => {
  const response = await request("POST", "", createPayload({
    price: "400.00",
    sales_tax_rate: "0.06",
    shipping: "20.00"
  }));
  const commission = (await response.json()).commission;

  assert.equal(response.status, 201);
  assert.equal(commission.price, "400.00");
  assert.equal(commission.sales_tax, "24.00");
  assert.equal(commission.shipping, "20.00");
  assert.equal(commission.deposit_amount, "0.00");
  assert.equal(commission.balance, "444.00");
});

test("phase 13 rejects an unknown client", async () => {
  const response = await request("POST", "", createPayload({
    client_id: "999999999"
  }));

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Client not found.");
});

for (const [field, value, message] of [
  ["title", "   ", "Title is required."],
  ["description", "", "Description is required."],
  ["medium", " ", "Medium is required."],
  ["width", "0", "Width must be greater than 0."],
  ["width", "-1", "Width must be greater than 0."],
  ["height", "0", "Height must be greater than 0."],
  ["height", "-1", "Height must be greater than 0."],
  ["price", "-0.01", "Price must be 0 or greater."],
  ["shipping", "-0.01", "Shipping must be 0 or greater."],
  ["estimated_completion", "2027-02-30", "Estimated completion must be a valid date."]
]) {
  test(`phase 13 rejects invalid ${field} value ${JSON.stringify(value)}`, async () => {
    const response = await request("POST", "", createPayload({ [field]: value }));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, message);
  });
}

test("phase 13 applies optional numeric defaults and NULL dimensions", async () => {
  const response = await request("POST", "", createPayload({
    width: "",
    height: null,
    shipping: undefined,
    estimated_completion: ""
  }));
  const commission = (await response.json()).commission;

  assert.equal(response.status, 201);
  assert.equal(commission.width, null);
  assert.equal(commission.height, null);
  assert.equal(commission.sales_tax, "6.00");
  assert.equal(commission.shipping, "0.00");
  assert.equal(commission.estimated_completion, null);
});

test("phase 13 commission number matches the approved format", async () => {
  const response = await request("POST", "", createPayload());
  const commission = (await response.json()).commission;

  assert.equal(response.status, 201);
  assert.match(commission.commission_number, /^SAS-COM-\d{4}-\d{4,}$/);
});

test("phase 13 concurrent creations receive distinct commission numbers", async () => {
  const [firstResponse, secondResponse] = await Promise.all([
    request("POST", "", createPayload({ title: "Concurrent One" })),
    request("POST", "", createPayload({ title: "Concurrent Two" }))
  ]);
  const first = await firstResponse.json();
  const second = await secondResponse.json();

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.notEqual(first.commission.commission_number, second.commission.commission_number);
});

test("phase 13 creation changes only commissions", async () => {
  const inquiriesBefore = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const clientsBefore = await db.pool.query("SELECT * FROM clients ORDER BY id");

  const response = await request("POST", "", createPayload());
  const inquiriesAfter = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const clientsAfter = await db.pool.query("SELECT * FROM clients ORDER BY id");
  const relatedCounts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM payments) AS payments,
      (SELECT count(*)::integer FROM documents) AS documents
  `);

  assert.equal(response.status, 201);
  assert.deepEqual(inquiriesAfter.rows, inquiriesBefore.rows);
  assert.deepEqual(clientsAfter.rows, clientsBefore.rows);
  assert.deepEqual(relatedCounts.rows[0], {
    payments: 0,
    documents: 0
  });
});
