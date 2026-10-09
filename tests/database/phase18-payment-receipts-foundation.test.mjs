import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

const migrations = [
  "20260910120000_create_studio_core.sql",
  "20261008000000_create_inquiries.sql",
  "20261009000000_add_client_address.sql",
  "20261009120000_payments_v1_foundation.sql"
];
const receiptMigration = "20261009130000_payment_receipts_v1_foundation.sql";

let database;
let db;
let clientId;
let commissionId;
let payments;

async function applyMigration(filename) {
  const path = new URL(`../../netlify/database/migrations/${filename}`, import.meta.url);
  await db.pool.query(await readFile(path, "utf8"));
}

async function insertDocument(overrides = {}) {
  const values = {
    commission_id: commissionId,
    document_type: "receipt",
    document_number: `SAS-REC-2026-${String(overrides.sequence || 1).padStart(4, "0")}`,
    version: 1,
    file_location: "/admin/payment-receipt.html",
    payment_id: payments[0].id,
    receipt_snapshot: { payment: { id: payments[0].id } },
    ...overrides
  };

  delete values.sequence;

  return db.pool.query(
    `INSERT INTO documents (
       commission_id,
       document_type,
       document_number,
       version,
       file_location,
       payment_id,
       receipt_snapshot
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      values.commission_id,
      values.document_type,
      values.document_number,
      values.version,
      values.file_location,
      values.payment_id,
      values.receipt_snapshot
    ]
  );
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  db = getDatabase({ connectionString });

  for (const migration of migrations) {
    await applyMigration(migration);
  }

  const clientResult = await db.pool.query(
    `INSERT INTO clients (full_name, email)
     VALUES ('Receipt Client', 'receipt-client@example.invalid')
     RETURNING id`
  );
  clientId = clientResult.rows[0].id;

  const commissionResult = await db.pool.query(
    `INSERT INTO commissions (
       commission_number,
       client_id,
       title,
       description,
       medium,
       price,
       sales_tax,
       shipping
     )
     VALUES ('SAS-COM-2026-1801', $1, 'Receipt Commission', 'Foundation test', 'Oil', 500, 30, 60)
     RETURNING id`,
    [clientId]
  );
  commissionId = commissionResult.rows[0].id;

  const paymentResult = await db.pool.query(
    `INSERT INTO payments (
       commission_id,
       request_id,
       payment_type,
       amount,
       sales_tax,
       status
     )
     VALUES
       ($1, $2, 'deposit', 250, 0, 'completed'),
       ($1, $3, 'balance', 340, 30, 'completed')
     RETURNING id, request_id`,
    [commissionId, randomUUID(), randomUUID()]
  );
  payments = paymentResult.rows;

  await applyMigration(receiptMigration);
});

beforeEach(async () => {
  await db.pool.query("DELETE FROM documents");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

for (const documentType of ["receipt", "contract", "invoice", "coa"]) {
  test(`${documentType} remains a valid document type`, async () => {
    const isReceipt = documentType === "receipt";
    const result = await insertDocument({
      document_type: documentType,
      document_number: `${documentType.toUpperCase()}-2026-0001`,
      payment_id: isReceipt ? payments[0].id : null,
      receipt_snapshot: isReceipt ? { type: "receipt" } : null
    });

    assert.equal(result.rows[0].document_type, documentType);
  });
}

test("documents exposes a nullable BIGINT payment_id", async () => {
  const result = await db.pool.query(
    `SELECT data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'documents'
       AND column_name = 'payment_id'`
  );

  assert.deepEqual(result.rows[0], {
    data_type: "bigint",
    is_nullable: "YES"
  });
});

test("documents.payment_id rejects an unknown payment", async () => {
  await assert.rejects(
    insertDocument({ payment_id: "999999999" }),
    (error) => error.code === "23503"
  );
});

test("documents.payment_id uses ON DELETE RESTRICT", async () => {
  await insertDocument();

  await assert.rejects(
    db.pool.query("DELETE FROM payments WHERE id = $1", [payments[0].id]),
    (error) => error.code === "23503"
  );
});

test("a receipt requires payment_id", async () => {
  await assert.rejects(
    insertDocument({ payment_id: null }),
    (error) => error.code === "23514"
  );
});

test("a non-receipt document permits a NULL payment_id", async () => {
  const result = await insertDocument({
    document_type: "invoice",
    document_number: "SSA-2026-NULL-PAYMENT",
    payment_id: null,
    receipt_snapshot: null
  });

  assert.equal(result.rows[0].payment_id, null);
});

test("the receipt-per-payment index is partial and unique", async () => {
  const result = await db.pool.query(
    `SELECT indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'documents_receipt_payment_unique'`
  );

  assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX/);
  assert.match(result.rows[0].indexdef, /payment_id/);
  assert.match(result.rows[0].indexdef, /document_type.*receipt/);
});

test("a payment cannot have two receipts", async () => {
  await insertDocument();

  await assert.rejects(
    insertDocument({ document_number: "SAS-REC-2026-0002" }),
    (error) => error.code === "23505"
  );
});

test("different payments can each have one receipt", async () => {
  await insertDocument();
  await insertDocument({
    payment_id: payments[1].id,
    document_number: "SAS-REC-2026-0002",
    receipt_snapshot: { payment: { id: payments[1].id } }
  });

  const result = await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'receipt'"
  );
  assert.equal(result.rows[0].count, 2);
});

test("receipt document_number is unique across receipts", async () => {
  await insertDocument();

  await assert.rejects(
    insertDocument({
      payment_id: payments[1].id,
      document_number: "SAS-REC-2026-0001",
      version: 2,
      receipt_snapshot: { payment: { id: payments[1].id } }
    }),
    (error) => error.code === "23505"
  );
});

test("generic document versioning still works for non-receipts", async () => {
  for (const version of [1, 2]) {
    await insertDocument({
      document_type: "contract",
      document_number: "SAS-CONTRACT-2026-0001",
      version,
      payment_id: null,
      receipt_snapshot: null
    });
  }

  const result = await db.pool.query(
    `SELECT version
     FROM documents
     WHERE document_number = 'SAS-CONTRACT-2026-0001'
     ORDER BY version`
  );
  assert.deepEqual(result.rows.map(({ version }) => version), [1, 2]);
});

test("payments exposes nullable NUMERIC(12,2) balance_after_payment", async () => {
  const result = await db.pool.query(
    `SELECT data_type, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payments'
       AND column_name = 'balance_after_payment'`
  );

  assert.deepEqual(result.rows[0], {
    data_type: "numeric",
    numeric_precision: 12,
    numeric_scale: 2,
    is_nullable: "YES"
  });
});

test("balance_after_payment permits NULL", async () => {
  await db.pool.query(
    "UPDATE payments SET balance_after_payment = NULL WHERE id = $1",
    [payments[0].id]
  );
  const result = await db.pool.query(
    "SELECT balance_after_payment FROM payments WHERE id = $1",
    [payments[0].id]
  );

  assert.equal(result.rows[0].balance_after_payment, null);
});

test("balance_after_payment rejects negative values", async () => {
  await assert.rejects(
    db.pool.query(
      "UPDATE payments SET balance_after_payment = -0.01 WHERE id = $1",
      [payments[0].id]
    ),
    (error) => error.code === "23514"
  );
});

test("payments created before the receipt migration remain NULL", async () => {
  const result = await db.pool.query(
    "SELECT balance_after_payment FROM payments ORDER BY id"
  );

  assert.deepEqual(
    result.rows.map(({ balance_after_payment }) => balance_after_payment),
    [null, null]
  );
});

test("documents exposes a nullable JSONB receipt_snapshot", async () => {
  const result = await db.pool.query(
    `SELECT data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'documents'
       AND column_name = 'receipt_snapshot'`
  );

  assert.deepEqual(result.rows[0], {
    data_type: "jsonb",
    is_nullable: "YES"
  });
});

test("a receipt requires receipt_snapshot", async () => {
  await assert.rejects(
    insertDocument({ receipt_snapshot: null }),
    (error) => error.code === "23514"
  );
});

test("non-receipt documents permit a NULL receipt_snapshot", async () => {
  const result = await insertDocument({
    document_type: "coa",
    document_number: "SSA-COA-2026-1801",
    payment_id: null,
    receipt_snapshot: null
  });

  assert.equal(result.rows[0].receipt_snapshot, null);
});

test("receipt_snapshot stores valid JSON", async () => {
  const snapshot = {
    receipt_number: "SAS-REC-2026-0001",
    client: { full_name: "Receipt Client" },
    payment: { amount: "250.00" }
  };
  const result = await insertDocument({ receipt_snapshot: snapshot });

  assert.deepEqual(result.rows[0].receipt_snapshot, snapshot);
});

test("the pre-receipt studio schema remains intact", async () => {
  const tables = await db.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('clients', 'commissions', 'payments', 'documents', 'inquiries')
     ORDER BY table_name`
  );
  const payment = await db.pool.query(
    `SELECT payment_type, amount, status
     FROM payments
     WHERE id = $1`,
    [payments[0].id]
  );

  assert.deepEqual(
    tables.rows.map(({ table_name }) => table_name),
    ["clients", "commissions", "documents", "inquiries", "payments"]
  );
  assert.deepEqual(payment.rows[0], {
    payment_type: "deposit",
    amount: "250.00",
    status: "completed"
  });
});
