import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler
} from "../../netlify/functions/admin-payments.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const apiUrl = "http://localhost/admin/api/commissions";
const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";

let database;
let db;
let connectionString;
let handler;
let sessionCookie;
let clients;
let commissions;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  connectionString = await database.start();
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
      ('Payment Client', 'payment@example.invalid'),
      ('Unchanged Client', 'unchanged@example.invalid')
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
      sales_tax,
      shipping,
      created_at
    )
    VALUES
      ('SAS-COM-2026-1001', $1, 'Payment Commission', 'Payment test', 'Oil', 100, 6, 10, '2026-01-01T10:00:00Z'),
      ('SAS-COM-2026-1002', $2, 'Untouched Commission', 'Unchanged', 'Acrylic', 200, 12, 0, '2026-01-02T10:00:00Z')
    RETURNING id, title
  `, [clients["Payment Client"], clients["Unchanged Client"]]);
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

function paymentPayload(overrides = {}) {
  return {
    request_id: randomUUID(),
    payment_type: "deposit",
    amount: "25.00",
    sales_tax: "0.00",
    payment_method: "Credit card",
    payment_date: "2026-10-09",
    external_reference: "processor-ref",
    notes: "Initial deposit",
    ...overrides
  };
}

function request(
  method = "GET",
  commissionId = commissions["Payment Commission"],
  body,
  cookie = sessionCookie
) {
  const headers = {};

  if (cookie) {
    headers.Cookie = cookie;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  return handler(new Request(`${apiUrl}/${commissionId}/payments`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

async function financials(id = commissions["Payment Commission"]) {
  return (await db.pool.query(
    `SELECT price, deposit_amount, amount_paid, sales_tax, shipping, balance
     FROM commissions
     WHERE id = $1`,
    [id]
  )).rows[0];
}

test("Payments V1 exposes one protected dynamic path", () => {
  assert.equal(config.path, "/admin/api/commissions/:id/payments");
  assert.equal(typeof config.path, "string");
});

test("authenticated admin can list payments", async () => {
  const response = await request();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.total, 0);
  assert.deepEqual(body.payments, []);
});

for (const method of ["GET", "POST"]) {
  test(`unauthenticated ${method} is rejected`, async () => {
    const response = await request(
      method,
      commissions["Payment Commission"],
      method === "POST" ? paymentPayload() : undefined,
      ""
    );

    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, "Unauthorized.");
  });
}

test("GET returns 404 for an unknown commission", async () => {
  const response = await request("GET", "999999999");

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
});

test("POST returns 404 for an unknown commission", async () => {
  const response = await request("POST", "999999999", paymentPayload());

  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, "Commission not found.");
});

for (const paymentType of ["deposit", "installment", "balance"]) {
  test(`POST creates a completed ${paymentType} payment`, async () => {
    const response = await request("POST", undefined, paymentPayload({
      payment_type: paymentType
    }));
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.created, true);
    assert.equal(body.payment.payment_type, paymentType);
    assert.equal(body.payment.status, "completed");
    assert.equal(Object.hasOwn(body.payment, "request_id"), false);
  });
}

for (const paymentType of ["refund", "adjustment", "pending", ""]) {
  test(`POST rejects unsupported payment type ${JSON.stringify(paymentType)}`, async () => {
    const response = await request("POST", undefined, paymentPayload({
      payment_type: paymentType
    }));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, "Payment type is unsupported.");
  });
}

for (const [overrides, message] of [
  [{ amount: "0" }, "Amount must be greater than 0."],
  [{ amount: "-1" }, "Amount must be 0 or greater."],
  [{ amount: "1.001" }, "Amount must be a valid monetary amount."],
  [{ sales_tax: "-0.01" }, "Sales tax must be 0 or greater."],
  [{ sales_tax: "1.001" }, "Sales tax must be a valid monetary amount."],
  [{ amount: "10", sales_tax: "10.01" }, "Sales tax cannot exceed amount."],
  [{ request_id: "not-a-uuid" }, "Request id must be a valid UUID."],
  [{ payment_date: "2026-02-30" }, "Payment date must be a valid date."]
]) {
  test(`POST rejects invalid payment input: ${message}`, async () => {
    const response = await request("POST", undefined, paymentPayload(overrides));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, message);
  });
}

test("POST rejects browser-controlled status and commission id", async () => {
  for (const field of ["status", "commission_id"]) {
    const response = await request("POST", undefined, paymentPayload({
      [field]: field === "status" ? "pending" : "999"
    }));

    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).message,
      "Request body contains unsupported fields."
    );
  }
});

test("empty optional values become NULL and sales tax defaults to zero", async () => {
  const payload = paymentPayload({
    sales_tax: undefined,
    payment_method: "  ",
    payment_date: "",
    external_reference: " ",
    notes: null
  });
  delete payload.sales_tax;
  const response = await request("POST", undefined, payload);
  const payment = (await response.json()).payment;

  assert.equal(response.status, 201);
  assert.equal(payment.sales_tax, "0.00");
  assert.equal(payment.payment_method, null);
  assert.equal(payment.payment_date, null);
  assert.equal(payment.external_reference, null);
  assert.equal(payment.notes, null);
});

test("same request id is idempotent", async () => {
  const payload = paymentPayload();
  const first = await request("POST", undefined, payload);
  const second = await request("POST", undefined, payload);
  const firstBody = await first.json();
  const secondBody = await second.json();
  const counts = await db.pool.query("SELECT count(*)::integer AS count FROM payments");
  const commission = await financials();

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(firstBody.created, true);
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.payment.id, firstBody.payment.id);
  assert.equal(counts.rows[0].count, 1);
  assert.equal(commission.amount_paid, "25.00");
  assert.equal(commission.deposit_amount, "25.00");
});

test("concurrent retries with the same request id remain idempotent", async () => {
  const secondDb = getDatabase({ connectionString });
  const secondHandler = createHandler({
    databaseFactory: () => secondDb,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  });
  const commissionId = commissions["Payment Commission"];
  const payload = paymentPayload();
  const secondRequest = secondHandler(new Request(
    `${apiUrl}/${commissionId}/payments`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  ));
  const [first, second] = await Promise.all([
    request("POST", undefined, payload),
    secondRequest
  ]);
  const bodies = await Promise.all([first.json(), second.json()]);
  await secondDb.pool.end();
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM payments");
  const commission = await financials();

  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.deepEqual(bodies.map((body) => body.created).sort(), [false, true]);
  assert.equal(count.rows[0].count, 1);
  assert.equal(commission.amount_paid, "25.00");
  assert.equal(commission.deposit_amount, "25.00");
});

test("request id cannot be reused across commissions", async () => {
  const payload = paymentPayload();
  await request("POST", undefined, payload);
  const response = await request(
    "POST",
    commissions["Untouched Commission"],
    payload
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).message, "Payment request id is already in use.");
});

test("deposit increments both deposit amount and amount paid", async () => {
  await request("POST", undefined, paymentPayload({ amount: "30.00" }));

  assert.deepEqual(await financials(), {
    price: "100.00",
    deposit_amount: "30.00",
    amount_paid: "30.00",
    sales_tax: "6.00",
    shipping: "10.00",
    balance: "86.00"
  });
});

for (const paymentType of ["installment", "balance"]) {
  test(`${paymentType} increments amount paid but not deposit amount`, async () => {
    await request("POST", undefined, paymentPayload({
      payment_type: paymentType,
      amount: "30.00"
    }));
    const commission = await financials();

    assert.equal(commission.deposit_amount, "0.00");
    assert.equal(commission.amount_paid, "30.00");
    assert.equal(commission.balance, "86.00");
  });
}

test("payment sales tax is included in amount and does not change commission tax", async () => {
  await request("POST", undefined, paymentPayload({
    payment_type: "balance",
    amount: "25.00",
    sales_tax: "6.00"
  }));
  const commission = await financials();

  assert.equal(commission.amount_paid, "25.00");
  assert.equal(commission.sales_tax, "6.00");
  assert.equal(commission.balance, "91.00");
});

test("payment equal to balance is allowed and produces zero balance", async () => {
  const response = await request("POST", undefined, paymentPayload({
    payment_type: "balance",
    amount: "116.00",
    sales_tax: "6.00"
  }));
  const commission = await financials();

  assert.equal(response.status, 201);
  assert.equal(commission.amount_paid, "116.00");
  assert.equal(commission.balance, "0.00");
});

test("overpayment is rejected without inserts or aggregate changes", async () => {
  const before = await financials();
  const response = await request("POST", undefined, paymentPayload({
    amount: "116.01"
  }));
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM payments");

  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).message,
    "Payment amount exceeds the commission balance."
  );
  assert.equal(count.rows[0].count, 0);
  assert.deepEqual(await financials(), before);
});

test("GET orders payments by date, then creation and id descending", async () => {
  const id = commissions["Payment Commission"];
  await db.pool.query(
    `INSERT INTO payments (
       commission_id, request_id, payment_type, amount, payment_date, status, created_at
     )
     VALUES
       ($1, $2, 'installment', 1, NULL, 'completed', '2026-10-10T12:00:00Z'),
       ($1, $3, 'installment', 1, '2026-10-08', 'completed', '2026-10-10T10:00:00Z'),
       ($1, $4, 'installment', 1, '2026-10-09', 'completed', '2026-10-10T09:00:00Z'),
       ($1, $5, 'installment', 1, '2026-10-09', 'completed', '2026-10-10T11:00:00Z')`,
    [id, randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  );
  const body = await (await request()).json();

  assert.deepEqual(
    body.payments.map((payment) => payment.payment_date && String(payment.payment_date).slice(0, 10)),
    ["2026-10-09", "2026-10-09", "2026-10-08", null]
  );
  assert.equal(
    new Date(body.payments[0].created_at) > new Date(body.payments[1].created_at),
    true
  );
  assert.equal(body.payments.every((payment) => !Object.hasOwn(payment, "request_id")), true);
});

test("payment creation does not change inquiries, clients, documents, or another commission", async () => {
  const inquiriesBefore = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const clientsBefore = await db.pool.query("SELECT * FROM clients ORDER BY id");
  const otherBefore = await financials(commissions["Untouched Commission"]);

  await request("POST", undefined, paymentPayload());

  const inquiriesAfter = await db.pool.query("SELECT * FROM inquiries ORDER BY id");
  const clientsAfter = await db.pool.query("SELECT * FROM clients ORDER BY id");
  const documents = await db.pool.query("SELECT count(*)::integer AS count FROM documents");

  assert.deepEqual(inquiriesAfter.rows, inquiriesBefore.rows);
  assert.deepEqual(clientsAfter.rows, clientsBefore.rows);
  assert.deepEqual(await financials(commissions["Untouched Commission"]), otherBefore);
  assert.equal(documents.rows[0].count, 0);
});

test("row lock prevents concurrent payments from exceeding balance", async () => {
  const secondDb = getDatabase({ connectionString });
  const secondHandler = createHandler({
    databaseFactory: () => secondDb,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  });
  const commissionId = commissions["Payment Commission"];
  const secondRequest = (body) => secondHandler(new Request(
    `${apiUrl}/${commissionId}/payments`,
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  ));
  const [first, second] = await Promise.all([
    request("POST", undefined, paymentPayload({
      request_id: randomUUID(),
      payment_type: "installment",
      amount: "70.00"
    })),
    secondRequest(paymentPayload({
      request_id: randomUUID(),
      payment_type: "installment",
      amount: "70.00"
    }))
  ]);
  await secondDb.pool.end();
  const statuses = [first.status, second.status].sort();
  const paymentRows = await db.pool.query(
    "SELECT id, request_id, amount, status FROM payments ORDER BY id"
  );
  const commission = await financials();

  assert.deepEqual(statuses, [201, 409]);
  assert.equal(paymentRows.rows.length, 1, JSON.stringify(paymentRows.rows));
  assert.equal(commission.amount_paid, "70.00");
  assert.equal(commission.balance, "46.00");
});
