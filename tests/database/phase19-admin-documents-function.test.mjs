import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler
} from "../../netlify/functions/admin-documents.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";
const apiUrl = "http://localhost/admin/api/documents";

let database;
let db;
let handler;
let sessionCookie;
let firstCommissionId;
let secondCommissionId;
let paymentId;

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
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;

  const clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Document Client', 'documents@example.invalid') RETURNING id"
  )).rows[0].id;
  firstCommissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-1901', $1, 'First Commission', 'First', 'Oil', 100)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
  secondCommissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-1902', $1, 'Second Commission', 'Second', 'Acrylic', 200)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
  paymentId = (await db.pool.query(
    `INSERT INTO payments (commission_id, payment_type, amount, payment_date, status)
     VALUES ($1, 'deposit', 50, '2026-10-09', 'completed') RETURNING id`,
    [firstCommissionId]
  )).rows[0].id;

  await db.pool.query(
    `INSERT INTO documents
       (commission_id, document_type, document_number, version, file_location, created_at, payment_id, receipt_snapshot)
     VALUES
       ($1, 'contract', 'SAS-CON-2026-0001', 1, '/documents/contract.pdf', '2026-10-08T12:00:00Z', NULL, NULL),
       ($1, 'invoice', 'SAS-INV-2026-0001', 2, '/documents/invoice.pdf', '2026-10-09T12:00:00Z', NULL, NULL),
       ($2, 'coa', 'SAS-COA-2026-0001', 1, '/documents/coa.pdf', '2026-10-09T12:00:00Z', NULL, NULL),
       ($1, 'receipt', 'SAS-REC-2026-0001', 1, '/admin/receipts/1.html', '2026-10-10T12:00:00Z', $3, '{}'::jsonb)`,
    [firstCommissionId, secondCommissionId, paymentId]
  );
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(query = "", options = {}) {
  return handler(new Request(`${apiUrl}${query}`, {
    method: options.method || "GET",
    headers: options.auth === false ? {} : { Cookie: sessionCookie }
  }));
}

test("configuration exposes the single protected collection route", () => {
  assert.equal(config.path, "/admin/api/documents");
});

test("authenticated GET succeeds", async () => {
  assert.equal((await request()).status, 200);
});

test("GET without authentication returns 401", async () => {
  assert.equal((await request("", { auth: false })).status, 401);
});

test("complete listing returns every persistent document", async () => {
  const body = await (await request()).json();
  assert.equal(body.total, 4);
  assert.equal(body.documents.length, 4);
});

test("listing orders by created_at DESC and id DESC", async () => {
  const body = await (await request()).json();
  assert.equal(body.documents[0].document_type, "receipt");
  assert.equal(body.documents[1].document_type, "coa");
  assert.equal(body.documents[2].document_type, "invoice");
  assert.equal(body.documents[3].document_type, "contract");
});

test("commission_id filters documents", async () => {
  const body = await (await request(`?commission_id=${secondCommissionId}`)).json();
  assert.equal(body.total, 1);
  assert.equal(body.documents[0].commission.title, "Second Commission");
});

test("document_type filters documents", async () => {
  const body = await (await request("?document_type=invoice")).json();
  assert.equal(body.total, 1);
  assert.equal(body.documents[0].document_type, "invoice");
});

test("combined filters are applied", async () => {
  const body = await (await request(`?commission_id=${firstCommissionId}&document_type=receipt`)).json();
  assert.equal(body.total, 1);
  assert.equal(body.documents[0].document_type, "receipt");
});

test("invalid commission_id returns 400", async () => {
  assert.equal((await request("?commission_id=0")).status, 400);
});

test("invalid document_type returns 400", async () => {
  assert.equal((await request("?document_type=other")).status, 400);
});

test("receipt metadata is returned without its snapshot", async () => {
  const body = await (await request("?document_type=receipt")).json();
  assert.equal(body.documents[0].document_number, "SAS-REC-2026-0001");
  assert.equal(body.documents[0].file_location, "/admin/receipts/1.html");
  assert.equal("receipt_snapshot" in body.documents[0], false);
});

test("receipt includes its payment association", async () => {
  const body = await (await request("?document_type=receipt")).json();
  assert.equal(String(body.documents[0].payment.id), String(paymentId));
  assert.equal(body.documents[0].payment.payment_type, "deposit");
  assert.equal(String(body.documents[0].payment.payment_date).slice(0, 10), "2026-10-09");
});

test("document without payment returns payment null", async () => {
  const body = await (await request("?document_type=invoice")).json();
  assert.equal(body.documents[0].payment, null);
});

test("response never exposes receipt_snapshot", async () => {
  const body = await (await request()).json();
  assert.equal(JSON.stringify(body).includes("receipt_snapshot"), false);
});

test("GET does not modify data", async () => {
  const before = await db.pool.query("SELECT count(*)::integer AS count FROM documents");
  await request("?document_type=contract");
  const afterResult = await db.pool.query("SELECT count(*)::integer AS count FROM documents");
  assert.equal(afterResult.rows[0].count, before.rows[0].count);
});

test("POST is not exposed", async () => assert.equal((await request("", { method: "POST" })).status, 405));
test("PATCH is not exposed", async () => assert.equal((await request("", { method: "PATCH" })).status, 405));
test("DELETE is not exposed", async () => assert.equal((await request("", { method: "DELETE" })).status, 405));
