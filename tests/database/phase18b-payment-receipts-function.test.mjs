import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler as createPaymentsHandler } from "../../netlify/functions/admin-payments.mjs";
import {
  config as receiptConfig,
  createHandler as createReceiptsHandler
} from "../../netlify/functions/admin-receipts.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";
const paymentsApi = "http://localhost/admin/api/commissions";
const receiptsApi = "http://localhost/admin/api/receipts";

let database;
let db;
let connectionString;
let paymentsHandler;
let receiptsHandler;
let sessionCookie;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const options = {
    databaseFactory: () => db,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  };
  paymentsHandler = createPaymentsHandler(options);
  receiptsHandler = createReceiptsHandler(options);
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(`
    INSERT INTO clients (
      full_name,
      email,
      phone,
      address_line_1,
      city,
      state,
      postal_code,
      country
    )
    VALUES (
      'Receipt Client',
      'receipt@example.invalid',
      '555-0100',
      '10 Studio Lane',
      'York',
      'PA',
      '17402',
      'United States'
    )
    RETURNING id
  `)).rows[0].id;
  commissionId = (await db.pool.query(`
    INSERT INTO commissions (
      commission_number,
      client_id,
      title,
      description,
      medium,
      price,
      sales_tax,
      shipping
    )
    VALUES ('SAS-COM-2026-1801', $1, 'Receipt Commission', 'Receipt test', 'Oil', 100, 6, 10)
    RETURNING id
  `, [clientId])).rows[0].id;
});

afterEach(async () => {
  await db?.pool.query("DROP TRIGGER IF EXISTS reject_receipt_insert ON documents");
  await db?.pool.query("DROP FUNCTION IF EXISTS reject_receipt_insert()");
  await db?.pool.query("DELETE FROM documents");
  await db?.pool.query("DELETE FROM payments");
  await db?.pool.query("DELETE FROM commissions");
  await db?.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function payload(overrides = {}) {
  return {
    request_id: randomUUID(),
    payment_type: "deposit",
    amount: "25.00",
    sales_tax: "0.00",
    payment_method: "card",
    payment_date: "2026-10-09",
    external_reference: "processor-reference",
    notes: "Initial payment",
    ...overrides
  };
}

function paymentRequest(data, id = commissionId, handler = paymentsHandler) {
  return handler(new Request(`${paymentsApi}/${id}/payments`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  }));
}

function receiptRequest(id, cookie = sessionCookie) {
  return receiptsHandler(new Request(`${receiptsApi}/${id}`, {
    headers: cookie ? { Cookie: cookie } : {}
  }));
}

async function createPayment(overrides = {}) {
  const response = await paymentRequest(payload(overrides));
  return { response, body: await response.json() };
}

async function receiptRow() {
  return (await db.pool.query(
    "SELECT * FROM documents WHERE document_type = 'receipt'"
  )).rows[0];
}

test("a valid completed payment creates exactly one receipt", async () => {
  const { response, body } = await createPayment();
  const count = await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'receipt'"
  );

  assert.equal(response.status, 201);
  assert.equal(body.created, true);
  assert.equal(count.rows[0].count, 1);
});

test("receipt links to the created payment", async () => {
  const { body } = await createPayment();
  assert.equal(String((await receiptRow()).payment_id), String(body.payment.id));
});

test("receipt links to the payment commission and uses version 1", async () => {
  await createPayment();
  const receipt = await receiptRow();
  assert.equal(String(receipt.commission_id), String(commissionId));
  assert.equal(receipt.version, 1);
});

test("receipt number follows the approved format", async () => {
  const { body } = await createPayment();
  assert.match(body.receipt.document_number, /^SAS-REC-\d{4}-\d{4,}$/);
});

test("two concurrent receipts receive distinct numbers", async () => {
  const secondDb = getDatabase({ connectionString });
  const secondHandler = createPaymentsHandler({
    databaseFactory: () => secondDb,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  });
  const [first, second] = await Promise.all([
    paymentRequest(payload({ amount: "10.00" })),
    paymentRequest(payload({ amount: "10.00" }), commissionId, secondHandler)
  ]);
  const bodies = await Promise.all([first.json(), second.json()]);
  await secondDb.pool.end();

  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.notEqual(bodies[0].receipt.document_number, bodies[1].receipt.document_number);
});

test("payment stores the exact balance after payment", async () => {
  const { body } = await createPayment();
  const stored = await db.pool.query(
    "SELECT balance_after_payment FROM payments WHERE id = $1",
    [body.payment.id]
  );

  assert.equal(body.payment.balance_after_payment, "91.00");
  assert.equal(stored.rows[0].balance_after_payment, "91.00");
});

test("snapshot stores the exact balance after payment", async () => {
  await createPayment();
  assert.equal((await receiptRow()).receipt_snapshot.payment.balance_after_payment, "91.00");
});

test("snapshot contains client data", async () => {
  await createPayment();
  assert.deepEqual((await receiptRow()).receipt_snapshot.client, {
    name: "Receipt Client",
    email: "receipt@example.invalid",
    phone: "555-0100",
    address_line_1: "10 Studio Lane",
    address_line_2: null,
    city: "York",
    state: "PA",
    postal_code: "17402",
    country: "United States"
  });
});

test("snapshot contains commission data and cent-precise total", async () => {
  await createPayment();
  assert.deepEqual((await receiptRow()).receipt_snapshot.commission, {
    id: commissionId,
    number: "SAS-COM-2026-1801",
    title: "Receipt Commission",
    price: "100.00",
    sales_tax: "6.00",
    shipping: "10.00",
    total: "116.00"
  });
});

test("snapshot contains payment data", async () => {
  const { body } = await createPayment();
  const payment = (await receiptRow()).receipt_snapshot.payment;

  assert.equal(String(payment.id), String(body.payment.id));
  assert.equal(payment.type, "deposit");
  assert.equal(payment.amount, "25.00");
  assert.equal(payment.sales_tax, "0.00");
  assert.equal(payment.method, "card");
  assert.equal(String(payment.payment_date).slice(0, 10), "2026-10-09");
  assert.equal(payment.external_reference, "processor-reference");
  assert.equal(payment.notes, "Initial payment");
});

test("snapshot contains studio data from the shared business source", async () => {
  await createPayment();
  assert.deepEqual((await receiptRow()).receipt_snapshot.studio, {
    name: "Sylva Ars Studio LLC",
    email: "contact@sylvaarsstudio.com",
    phone: "+1 (717) 220-5592",
    website: "sylvaarsstudio.com"
  });
});

test("snapshot remains unchanged after client and commission edits", async () => {
  await createPayment();
  const before = (await receiptRow()).receipt_snapshot;
  await db.pool.query("UPDATE clients SET full_name = 'Changed Client' WHERE id = $1", [clientId]);
  await db.pool.query("UPDATE commissions SET title = 'Changed Title' WHERE id = $1", [commissionId]);
  const after = (await receiptRow()).receipt_snapshot;

  assert.deepEqual(after, before);
});

test("retry returns the same payment and receipt", async () => {
  const data = payload();
  const first = await paymentRequest(data);
  const second = await paymentRequest(data);
  const firstBody = await first.json();
  const secondBody = await second.json();

  assert.equal(firstBody.created, true);
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.payment.id, firstBody.payment.id);
  assert.equal(secondBody.receipt.id, firstBody.receipt.id);
});

test("retry does not generate another receipt number", async () => {
  const data = payload();
  const firstBody = await (await paymentRequest(data)).json();
  const secondBody = await (await paymentRequest(data)).json();
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM documents");

  assert.equal(secondBody.receipt.document_number, firstBody.receipt.document_number);
  assert.equal(count.rows[0].count, 1);
});

test("database still prevents a second receipt for one payment", async () => {
  await createPayment();
  const receipt = await receiptRow();

  await assert.rejects(
    db.pool.query(
      `INSERT INTO documents (
         commission_id, payment_id, document_type, document_number,
         version, file_location, receipt_snapshot
       )
       VALUES ($1, $2, 'receipt', 'SAS-REC-2099-9999', 1, '/admin/payment-receipt.html', '{}'::jsonb)`,
      [commissionId, receipt.payment_id]
    ),
    (error) => error.code === "23505"
  );
});

test("receipt insert failure rolls back payment and commission aggregates", async () => {
  await db.pool.query(`
    CREATE FUNCTION reject_receipt_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.document_type = 'receipt' THEN
        RAISE EXCEPTION 'receipt rejected for atomicity test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.pool.query(`
    CREATE TRIGGER reject_receipt_insert
    BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION reject_receipt_insert()
  `);
  const response = await paymentRequest(payload());
  const paymentCount = await db.pool.query("SELECT count(*)::integer AS count FROM payments");
  const commission = await db.pool.query(
    "SELECT amount_paid, deposit_amount, balance FROM commissions WHERE id = $1",
    [commissionId]
  );

  assert.equal(response.status, 500);
  assert.equal(paymentCount.rows[0].count, 0);
  assert.deepEqual(commission.rows[0], {
    amount_paid: "0.00",
    deposit_amount: "0.00",
    balance: "116.00"
  });
});

test("payment creation creates no non-receipt documents", async () => {
  await createPayment();
  const rows = await db.pool.query("SELECT document_type FROM documents");
  assert.deepEqual(rows.rows, [{ document_type: "receipt" }]);
});

test("existing contract invoice and coa rows remain unchanged", async () => {
  await db.pool.query(`
    INSERT INTO documents (commission_id, document_type, document_number, version, file_location)
    VALUES
      ($1, 'contract', 'CON-1801', 1, '/contract'),
      ($1, 'invoice', 'INV-1801', 1, '/invoice'),
      ($1, 'coa', 'COA-1801', 1, '/coa')
  `, [commissionId]);
  const before = await db.pool.query(
    "SELECT * FROM documents WHERE document_type <> 'receipt' ORDER BY id"
  );
  await createPayment();
  const after = await db.pool.query(
    "SELECT * FROM documents WHERE document_type <> 'receipt' ORDER BY id"
  );

  assert.deepEqual(after.rows, before.rows);
});

test("receipt endpoint exposes one protected dynamic path", () => {
  assert.equal(receiptConfig.path, "/admin/api/receipts/:id");
  assert.equal(typeof receiptConfig.path, "string");
});

test("authenticated receipt GET returns snapshot data", async () => {
  const { body } = await createPayment();
  const response = await receiptRequest(body.receipt.id);
  const receipt = (await response.json()).receipt;

  assert.equal(response.status, 200);
  assert.equal(receipt.document_number, body.receipt.document_number);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.snapshot.receipt.number, body.receipt.document_number);
});

test("unauthenticated receipt GET returns 401", async () => {
  const response = await receiptRequest("1", "");
  assert.equal(response.status, 401);
});

test("unknown receipt returns 404", async () => {
  const response = await receiptRequest("999999999");
  assert.equal(response.status, 404);
});

test("non-receipt document returns 404", async () => {
  const document = await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version, file_location
     )
     VALUES ($1, 'contract', 'CON-1802', 1, '/contract')
     RETURNING id`,
    [commissionId]
  );
  const response = await receiptRequest(document.rows[0].id);

  assert.equal(response.status, 404);
});

test("receipt endpoint returns stored snapshot after client edit", async () => {
  const { body } = await createPayment();
  await db.pool.query("UPDATE clients SET full_name = 'Changed Client' WHERE id = $1", [clientId]);
  const receipt = (await (await receiptRequest(body.receipt.id)).json()).receipt;

  assert.equal(receipt.snapshot.client.name, "Receipt Client");
});

test("receipt endpoint returns stored snapshot after commission edit", async () => {
  const { body } = await createPayment();
  await db.pool.query("UPDATE commissions SET title = 'Changed Title' WHERE id = $1", [commissionId]);
  const receipt = (await (await receiptRequest(body.receipt.id)).json()).receipt;

  assert.equal(receipt.snapshot.commission.title, "Receipt Commission");
});
