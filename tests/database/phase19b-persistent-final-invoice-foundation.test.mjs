import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

const previousMigrations = [
  "20260910120000_create_studio_core.sql",
  "20261008000000_create_inquiries.sql",
  "20261009000000_add_client_address.sql",
  "20261009120000_payments_v1_foundation.sql",
  "20261009130000_payment_receipts_v1_foundation.sql"
];
const invoiceMigration = "20261009140000_persistent_final_invoice_v1_foundation.sql";

let database;
let db;
let commissionId;
let payments;
let paymentsSchemaBefore;
let commissionsSchemaBefore;
let historicalDocumentAfterMigration;
let historicalReceiptAfterMigration;

async function applyMigration(filename) {
  const path = new URL(`../../netlify/database/migrations/${filename}`, import.meta.url);
  await db.pool.query(await readFile(path, "utf8"));
}

async function tableSchema(tableName) {
  const result = await db.pool.query(
    `SELECT column_name, data_type, is_nullable, column_default, is_generated
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );

  return result.rows;
}

async function insertDocument(overrides = {}) {
  const values = {
    commission_id: commissionId,
    document_type: "contract",
    document_number: `DOC-${randomUUID()}`,
    version: 1,
    file_location: "/admin/document.html",
    payment_id: null,
    receipt_snapshot: null,
    document_snapshot: null,
    request_id: null,
    ...overrides
  };

  return db.pool.query(
    `INSERT INTO documents (
       commission_id,
       document_type,
       document_number,
       version,
       file_location,
       payment_id,
       receipt_snapshot,
       document_snapshot,
       request_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      values.commission_id,
      values.document_type,
      values.document_number,
      values.version,
      values.file_location,
      values.payment_id,
      values.receipt_snapshot,
      values.document_snapshot,
      values.request_id
    ]
  );
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  db = getDatabase({ connectionString });

  for (const migration of previousMigrations) {
    await applyMigration(migration);
  }

  const clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Invoice Client', 'invoice@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price, sales_tax, shipping
     )
     VALUES ('SAS-COM-2026-1902', $1, 'Final Invoice Foundation', 'Foundation test', 'Oil', 400, 24, 20)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
  payments = (await db.pool.query(
    `INSERT INTO payments (
       commission_id, request_id, payment_type, amount, sales_tax, status
     )
     VALUES
       ($1, $2, 'deposit', 200, 0, 'completed'),
       ($1, $3, 'balance', 244, 24, 'completed')
     RETURNING id`,
    [commissionId, randomUUID(), randomUUID()]
  )).rows;

  const historicalDocumentId = (await db.pool.query(
    `INSERT INTO documents (commission_id, document_type, document_number, version, file_location)
     VALUES ($1, 'contract', 'SAS-CON-2026-1902', 1, '/contract')
     RETURNING id`,
    [commissionId]
  )).rows[0].id;
  const historicalReceiptId = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, payment_id, document_type, document_number,
       version, file_location, receipt_snapshot
     )
     VALUES ($1, $2, 'receipt', 'SAS-REC-2026-1902', 1, '/receipt', '{"type":"receipt"}'::jsonb)
     RETURNING id`,
    [commissionId, payments[0].id]
  )).rows[0].id;

  paymentsSchemaBefore = await tableSchema("payments");
  commissionsSchemaBefore = await tableSchema("commissions");
  await applyMigration(invoiceMigration);

  historicalDocumentAfterMigration = (await db.pool.query(
    "SELECT document_snapshot, request_id FROM documents WHERE id = $1",
    [historicalDocumentId]
  )).rows[0];
  historicalReceiptAfterMigration = (await db.pool.query(
    `SELECT payment_id, receipt_snapshot, document_snapshot, request_id
     FROM documents WHERE id = $1`,
    [historicalReceiptId]
  )).rows[0];

  await db.pool.query("DELETE FROM documents");
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM documents");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("documents.document_snapshot exists as nullable JSONB", async () => {
  const result = await db.pool.query(
    `SELECT data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'documents'
       AND column_name = 'document_snapshot'`
  );

  assert.deepEqual(result.rows[0], { data_type: "jsonb", is_nullable: "YES" });
});

test("historical documents remain valid with a NULL document_snapshot", () => {
  assert.deepEqual(historicalDocumentAfterMigration, {
    document_snapshot: null,
    request_id: null
  });
});

test("an invoice requires document_snapshot", async () => {
  await assert.rejects(
    insertDocument({ document_type: "invoice" }),
    (error) => error.code === "23514"
  );
});

test("a receipt does not require document_snapshot", async () => {
  const result = await insertDocument({
    document_type: "receipt",
    document_number: "SAS-REC-2026-1903",
    payment_id: payments[0].id,
    receipt_snapshot: { type: "receipt" }
  });

  assert.equal(result.rows[0].document_snapshot, null);
});

test("a receipt still requires receipt_snapshot", async () => {
  await assert.rejects(
    insertDocument({
      document_type: "receipt",
      document_number: "SAS-REC-2026-1903",
      payment_id: payments[0].id
    }),
    (error) => error.code === "23514"
  );
});

test("a contract may keep document_snapshot NULL", async () => {
  const result = await insertDocument({ document_type: "contract" });
  assert.equal(result.rows[0].document_snapshot, null);
});

test("a COA may keep document_snapshot NULL", async () => {
  const result = await insertDocument({ document_type: "coa" });
  assert.equal(result.rows[0].document_snapshot, null);
});

test("an invoice accepts a JSON object snapshot", async () => {
  const snapshot = { schema_version: 1, invoice: { status: "PAID" } };
  const result = await insertDocument({
    document_type: "invoice",
    document_snapshot: snapshot
  });

  assert.deepEqual(result.rows[0].document_snapshot, snapshot);
});

test("an invoice rejects a non-object JSON snapshot", async () => {
  await assert.rejects(
    insertDocument({
      document_type: "invoice",
      document_snapshot: JSON.stringify(["not", "an", "object"])
    }),
    (error) => error.code === "23514"
  );
});

test("documents.request_id exists as nullable UUID", async () => {
  const result = await db.pool.query(
    `SELECT data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'documents'
       AND column_name = 'request_id'`
  );

  assert.deepEqual(result.rows[0], {
    data_type: "uuid",
    is_nullable: "YES",
    column_default: null
  });
});

test("request_id permits NULL", async () => {
  const result = await insertDocument();
  assert.equal(result.rows[0].request_id, null);
});

test("request_id accepts a UUID", async () => {
  const requestId = randomUUID();
  const result = await insertDocument({ request_id: requestId });
  assert.equal(result.rows[0].request_id, requestId);
});

test("request_id has a partial unique index", async () => {
  const result = await db.pool.query(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'documents_request_id_unique'`
  );

  assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX/);
  assert.match(result.rows[0].indexdef, /request_id/);
  assert.match(result.rows[0].indexdef, /WHERE \(request_id IS NOT NULL\)/);
});

test("duplicating a non-NULL request_id fails", async () => {
  const requestId = randomUUID();
  await insertDocument({ request_id: requestId });

  await assert.rejects(
    insertDocument({ request_id: requestId }),
    (error) => error.code === "23505"
  );
});

test("existing documents do not require request_id", async () => {
  assert.equal(historicalReceiptAfterMigration.request_id, null);
});

test("UNIQUE document_number and version remains enforced", async () => {
  await insertDocument({ document_number: "SAS-CON-2026-2001", version: 1 });

  await assert.rejects(
    insertDocument({ document_number: "SAS-CON-2026-2001", version: 1 }),
    (error) => error.code === "23505"
  );
});

test("document versioning continues to support multiple versions", async () => {
  await insertDocument({ document_number: "SAS-CON-2026-2002", version: 1 });
  await insertDocument({ document_number: "SAS-CON-2026-2002", version: 2 });
  const result = await db.pool.query(
    "SELECT version FROM documents WHERE document_number = 'SAS-CON-2026-2002' ORDER BY version"
  );

  assert.deepEqual(result.rows.map(({ version }) => version), [1, 2]);
});

test("receipt constraints and historical receipt data remain intact", () => {
  assert.equal(String(historicalReceiptAfterMigration.payment_id), String(payments[0].id));
  assert.deepEqual(historicalReceiptAfterMigration.receipt_snapshot, { type: "receipt" });
  assert.equal(historicalReceiptAfterMigration.document_snapshot, null);
});

test("one receipt per payment remains enforced", async () => {
  await insertDocument({
    document_type: "receipt",
    document_number: "SAS-REC-2026-2001",
    payment_id: payments[1].id,
    receipt_snapshot: { type: "receipt" }
  });

  await assert.rejects(
    insertDocument({
      document_type: "receipt",
      document_number: "SAS-REC-2026-2002",
      payment_id: payments[1].id,
      receipt_snapshot: { type: "receipt" }
    }),
    (error) => error.code === "23505"
  );
});

test("payments schema is unchanged by the invoice foundation", async () => {
  assert.deepEqual(await tableSchema("payments"), paymentsSchemaBefore);
});

test("commissions schema is unchanged by the invoice foundation", async () => {
  assert.deepEqual(await tableSchema("commissions"), commissionsSchemaBefore);
});

test("database comments document receipt and final invoice roles", async () => {
  const result = await db.pool.query(
    `SELECT conname, obj_description(oid, 'pg_constraint') AS comment
     FROM pg_constraint
     WHERE conrelid = 'documents'::regclass
       AND conname IN (
         'documents_receipt_snapshot_required_check',
         'documents_invoice_snapshot_required_check'
       )
     ORDER BY conname`
  );

  assert.match(result.rows[0].comment, /final invoice.*immutable closing financial document/i);
  assert.match(result.rows[1].comment, /receipt.*completed payment.*outstanding balance/i);
});
