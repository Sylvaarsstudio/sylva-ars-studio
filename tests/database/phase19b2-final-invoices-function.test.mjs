import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler as createPaymentsHandler } from "../../netlify/functions/admin-payments.mjs";
import {
  config as invoiceConfig,
  createHandler as createInvoicesHandler
} from "../../netlify/functions/admin-invoices.mjs";
import { listDocuments } from "../../netlify/functions/admin-documents.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";

const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";
const paymentsApi = "http://localhost/admin/api/commissions";
const invoicesApi = "http://localhost/admin/api/documents/invoices";

let database;
let db;
let connectionString;
let paymentsHandler;
let invoicesHandler;
let sessionCookie;
let clientId;
let commissionId;

function handlerOptions(databaseInstance = db) {
  return {
    databaseFactory: () => databaseInstance,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    }
  };
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  paymentsHandler = createPaymentsHandler(handlerOptions());
  invoicesHandler = createInvoicesHandler(handlerOptions());
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(`
    INSERT INTO clients (
      full_name, email, phone, address_line_1, city, state, postal_code, country
    )
    VALUES (
      'Invoice Client', 'invoice@example.invalid', '555-0100',
      '10 Studio Lane', 'York', 'PA', '17402', 'United States'
    )
    RETURNING id
  `)).rows[0].id;
  commissionId = (await db.pool.query(`
    INSERT INTO commissions (
      commission_number, client_id, title, description, medium,
      width, height, price, sales_tax, shipping
    )
    VALUES (
      'SAS-COM-2026-1903', $1, 'Final Invoice Commission',
      'Final invoice test', 'Oil on canvas', 20, 24, 100, 6, 10
    )
    RETURNING id
  `, [clientId])).rows[0].id;
});

afterEach(async () => {
  await db?.pool.query("DROP TRIGGER IF EXISTS reject_invoice_insert ON documents");
  await db?.pool.query("DROP FUNCTION IF EXISTS reject_invoice_insert()");
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
    notes: "Payment note",
    ...overrides
  };
}

function paymentRequest(data, id = commissionId, handler = paymentsHandler) {
  return handler(new Request(`${paymentsApi}/${id}/payments`, {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }));
}

function invoiceRequest(id, cookie = sessionCookie) {
  return invoicesHandler(new Request(`${invoicesApi}/${id}`, {
    headers: cookie ? { Cookie: cookie } : {}
  }));
}

async function record(data) {
  const response = await paymentRequest(data);
  return { response, body: await response.json() };
}

async function createDeposit() {
  return record(payload());
}

async function createFinal(overrides = {}) {
  return record(payload({
    payment_type: "balance",
    amount: "116.00",
    sales_tax: "6.00",
    ...overrides
  }));
}

async function invoiceRow() {
  return (await db.pool.query(
    "SELECT * FROM documents WHERE document_type = 'invoice'"
  )).rows[0];
}

test("non-final payment creates a receipt", async () => {
  const { body } = await createDeposit();
  assert.equal(body.document.document_type, "receipt");
  assert.equal(body.receipt.document_type, "receipt");
});

test("final balance payment creates an invoice", async () => {
  const { response, body } = await createFinal();
  assert.equal(response.status, 201);
  assert.equal(body.document.document_type, "invoice");
});

test("final payment creates no receipt", async () => {
  const { body } = await createFinal();
  const receipts = await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'receipt'"
  );
  assert.equal(body.receipt, null);
  assert.equal(receipts.rows[0].count, 0);
});

test("invoice number follows the approved format", async () => {
  assert.match((await createFinal()).body.document.document_number, /^SAS-INV-\d{4}-\d{4,}$/);
});

test("two concurrent final invoices receive distinct numbers", async () => {
  const secondCommissionId = (await db.pool.query(`
    INSERT INTO commissions (
      commission_number, client_id, title, description, medium, price, sales_tax, shipping
    ) VALUES ('SAS-COM-2026-1904', $1, 'Second Final', 'Second test', 'Oil', 100, 6, 10)
    RETURNING id
  `, [clientId])).rows[0].id;
  const secondDb = getDatabase({ connectionString });
  const secondHandler = createPaymentsHandler(handlerOptions(secondDb));
  const [first, second] = await Promise.all([
    paymentRequest(payload({ payment_type: "balance", amount: "116.00", sales_tax: "6.00" })),
    paymentRequest(
      payload({ payment_type: "balance", amount: "116.00", sales_tax: "6.00" }),
      secondCommissionId,
      secondHandler
    )
  ]);
  const bodies = await Promise.all([first.json(), second.json()]);
  await secondDb.pool.end();
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.notEqual(bodies[0].document.document_number, bodies[1].document.document_number);
});

test("final invoice uses version 1", async () => {
  await createFinal();
  assert.equal((await invoiceRow()).version, 1);
});

test("final invoice stores document_snapshot", async () => {
  await createFinal();
  assert.equal(typeof (await invoiceRow()).document_snapshot, "object");
});

test("snapshot financial status is PAID", async () => {
  await createFinal();
  assert.equal((await invoiceRow()).document_snapshot.invoice.financial_status, "PAID");
});

test("snapshot balance is zero", async () => {
  await createFinal();
  assert.equal((await invoiceRow()).document_snapshot.financial.balance, "0.00");
});

test("snapshot total is cent-precise", async () => {
  await createFinal();
  assert.equal((await invoiceRow()).document_snapshot.financial.total, "116.00");
});

test("snapshot contains the complete payment history", async () => {
  await createDeposit();
  await createFinal({ amount: "91.00", request_id: randomUUID() });
  assert.equal((await invoiceRow()).document_snapshot.payments.length, 2);
});

test("prior payment history includes its receipt number", async () => {
  const deposit = await createDeposit();
  await createFinal({ amount: "91.00", request_id: randomUUID() });
  assert.equal(
    (await invoiceRow()).document_snapshot.payments.find(
      (payment) => payment.payment_type === "deposit"
    ).receipt_number,
    deposit.body.receipt.document_number
  );
});

test("final payment history has no receipt number", async () => {
  await createFinal();
  assert.equal((await invoiceRow()).document_snapshot.payments.at(-1).receipt_number, null);
});

test("invoice file location uses the protected persistent page", async () => {
  const { body } = await createFinal();
  assert.equal(body.document.file_location, `/admin/invoice.html?document=${body.document.id}`);
});

test("retry returns the same final invoice", async () => {
  const data = payload({ payment_type: "balance", amount: "116.00", sales_tax: "6.00" });
  const first = await record(data);
  const second = await record(data);
  assert.equal(second.body.created, false);
  assert.equal(second.body.document.id, first.body.document.id);
});

test("retry creates no second invoice number", async () => {
  const data = payload({ payment_type: "balance", amount: "116.00", sales_tax: "6.00" });
  await record(data);
  await record(data);
  const count = await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'invoice'"
  );
  assert.equal(count.rows[0].count, 1);
});

test("invoice insert failure rolls back payment", async () => {
  await db.pool.query(`
    CREATE FUNCTION reject_invoice_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.document_type = 'invoice' THEN
        RAISE EXCEPTION 'invoice rejected for atomicity test';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.pool.query(`
    CREATE TRIGGER reject_invoice_insert BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION reject_invoice_insert()
  `);
  const { response } = await createFinal();
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM payments");
  assert.equal(response.status, 500);
  assert.equal(count.rows[0].count, 0);
});

test("invoice insert failure leaves amount_paid unchanged", async () => {
  await db.pool.query(`
    CREATE FUNCTION reject_invoice_insert() RETURNS trigger AS $$ BEGIN
      IF NEW.document_type = 'invoice' THEN RAISE EXCEPTION 'rejected'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql
  `);
  await db.pool.query(`CREATE TRIGGER reject_invoice_insert BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION reject_invoice_insert()`);
  await createFinal();
  const row = (await db.pool.query(
    "SELECT amount_paid FROM commissions WHERE id = $1", [commissionId]
  )).rows[0];
  assert.equal(row.amount_paid, "0.00");
});

test("invoice insert failure leaves deposit_amount unchanged", async () => {
  await db.pool.query(`
    CREATE FUNCTION reject_invoice_insert() RETURNS trigger AS $$ BEGIN
      IF NEW.document_type = 'invoice' THEN RAISE EXCEPTION 'rejected'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql
  `);
  await db.pool.query(`CREATE TRIGGER reject_invoice_insert BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION reject_invoice_insert()`);
  await createFinal();
  const row = (await db.pool.query(
    "SELECT deposit_amount FROM commissions WHERE id = $1", [commissionId]
  )).rows[0];
  assert.equal(row.deposit_amount, "0.00");
});

test("receipt path remains unchanged for a non-final payment", async () => {
  const { body } = await createDeposit();
  assert.match(body.receipt.file_location, /^\/admin\/payment-receipt\.html\?receipt=/);
});

test("non-final receipt snapshot behavior remains unchanged", async () => {
  await createDeposit();
  const row = (await db.pool.query(
    "SELECT receipt_snapshot FROM documents WHERE document_type = 'receipt'"
  )).rows[0];
  assert.equal(row.receipt_snapshot.payment.balance_after_payment, "91.00");
});

test("documents endpoint data includes the final invoice", async () => {
  await createFinal();
  const documents = await listDocuments(db, { commissionId: String(commissionId) });
  assert.equal(documents.some((document) => document.document_type === "invoice"), true);
});

test("historical receipt remains intact after final invoice creation", async () => {
  const deposit = await createDeposit();
  const before = await db.pool.query("SELECT * FROM documents WHERE id = $1", [deposit.body.receipt.id]);
  await createFinal({ amount: "91.00", request_id: randomUUID() });
  const after = await db.pool.query("SELECT * FROM documents WHERE id = $1", [deposit.body.receipt.id]);
  assert.deepEqual(after.rows, before.rows);
});

test("invoice endpoint exposes one protected dynamic path", () => {
  assert.equal(invoiceConfig.path, "/admin/api/documents/invoices/:id");
  assert.equal(typeof invoiceConfig.path, "string");
});

test("authenticated invoice GET returns only persisted snapshot data", async () => {
  const { body } = await createFinal();
  const response = await invoiceRequest(body.document.id);
  const invoice = (await response.json()).invoice;
  assert.equal(response.status, 200);
  assert.equal(invoice.document_number, body.document.document_number);
  assert.equal(invoice.snapshot.invoice.number, body.document.document_number);
});

test("unauthenticated invoice GET returns 401", async () => {
  assert.equal((await invoiceRequest("1", "")).status, 401);
});

test("a non-invoice document returns 404 from invoice endpoint", async () => {
  const { body } = await createDeposit();
  assert.equal((await invoiceRequest(body.receipt.id)).status, 404);
});
