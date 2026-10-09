import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

let database;
let db;
let clientId;
let depositedCommissionId;
let noDepositCommissionId;
let legacyPaymentId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations(
    "./netlify/database/migrations",
    "20261009000000_add_client_address"
  );

  db = getDatabase({ connectionString });
  const client = await db.pool.query(
    `INSERT INTO clients (full_name, email)
     VALUES ('Payments Foundation Client', 'payments-foundation@example.invalid')
     RETURNING id`
  );
  clientId = client.rows[0].id;

  const commissions = await db.pool.query(
    `INSERT INTO commissions (
       commission_number,
       client_id,
       title,
       description,
       medium,
       price,
       deposit_amount,
       sales_tax,
       shipping
     )
     VALUES
       ('SAS-COM-2026-9001', $1, 'Legacy Deposit', 'Backfill validation', 'Oil', 500, 250, 30, 20),
       ('SAS-COM-2026-9002', $1, 'No Legacy Deposit', 'Zero backfill validation', 'Drawing', 500, 0, 0, 60)
     RETURNING id, title, balance`,
    [clientId]
  );
  depositedCommissionId = commissions.rows.find(
    ({ title }) => title === "Legacy Deposit"
  ).id;
  noDepositCommissionId = commissions.rows.find(
    ({ title }) => title === "No Legacy Deposit"
  ).id;
  assert.equal(
    commissions.rows.find(({ title }) => title === "Legacy Deposit").balance,
    "300.00"
  );
  assert.equal(
    commissions.rows.find(({ title }) => title === "No Legacy Deposit").balance,
    "560.00"
  );

  const payment = await db.pool.query(
    `INSERT INTO payments (
       commission_id,
       payment_type,
       amount,
       sales_tax,
       payment_method,
       payment_date,
       status
     )
     VALUES ($1, 'deposit', 250, 0, 'check', '2026-10-01', 'completed')
     RETURNING id`,
    [depositedCommissionId]
  );
  legacyPaymentId = payment.rows[0].id;

  await database.applyMigrations("./netlify/database/migrations");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("payments foundation adds amount_paid with the approved default", async () => {
  const column = await db.pool.query(
    `SELECT data_type, numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'commissions'
       AND column_name = 'amount_paid'`
  );

  assert.deepEqual(column.rows[0], {
    data_type: "numeric",
    numeric_precision: 12,
    numeric_scale: 2,
    is_nullable: "NO",
    column_default: "0"
  });

  const inserted = await db.pool.query(
    `INSERT INTO commissions (
       commission_number,
       client_id,
       title,
       description,
       medium,
       price
     )
     VALUES ('SAS-COM-2026-9003', $1, 'Default Amount Paid', 'Default validation', 'Oil', 100)
     RETURNING amount_paid`,
    [clientId]
  );

  assert.equal(inserted.rows[0].amount_paid, "0.00");
});

test("payments foundation rejects negative amount_paid", async () => {
  await assert.rejects(
    db.pool.query(
      "UPDATE commissions SET amount_paid = -0.01 WHERE id = $1",
      [noDepositCommissionId]
    ),
    (error) => error.code === "23514"
  );
});

test("payments foundation backfills historical deposits without changing balance", async () => {
  const result = await db.pool.query(
    `SELECT title, deposit_amount, amount_paid, balance
     FROM commissions
     WHERE id IN ($1, $2)
     ORDER BY title`,
    [depositedCommissionId, noDepositCommissionId]
  );

  assert.deepEqual(result.rows, [
    {
      title: "Legacy Deposit",
      deposit_amount: "250.00",
      amount_paid: "250.00",
      balance: "300.00"
    },
    {
      title: "No Legacy Deposit",
      deposit_amount: "0.00",
      amount_paid: "0.00",
      balance: "560.00"
    }
  ]);
});

test("payments foundation balance is generated from amount_paid", async () => {
  const column = await db.pool.query(
    `SELECT is_generated, generation_expression
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'commissions'
       AND column_name = 'balance'`
  );
  const expression = column.rows[0].generation_expression;

  assert.equal(column.rows[0].is_generated, "ALWAYS");
  assert.match(expression, /amount_paid/);
  assert.doesNotMatch(expression, /deposit_amount/);

  await db.pool.query(
    "UPDATE commissions SET amount_paid = 300 WHERE id = $1",
    [depositedCommissionId]
  );
  const updated = await db.pool.query(
    "SELECT deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
    [depositedCommissionId]
  );

  assert.deepEqual(updated.rows[0], {
    deposit_amount: "250.00",
    amount_paid: "300.00",
    balance: "250.00"
  });
});

test("payments foundation prevents direct balance writes", async () => {
  await assert.rejects(
    db.pool.query(
      "UPDATE commissions SET balance = 0 WHERE id = $1",
      [noDepositCommissionId]
    ),
    (error) => error.code === "428C9"
  );
});

test("payments foundation constrains financial aggregates", async () => {
  await assert.rejects(
    db.pool.query(
      "UPDATE commissions SET amount_paid = 561 WHERE id = $1",
      [noDepositCommissionId]
    ),
    (error) => error.code === "23514"
  );
});

test("payments foundation adds UUID request_id with a unique default", async () => {
  const column = await db.pool.query(
    `SELECT data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payments'
       AND column_name = 'request_id'`
  );
  const payment = await db.pool.query(
    "SELECT request_id FROM payments WHERE id = $1",
    [legacyPaymentId]
  );

  assert.equal(column.rows[0].data_type, "uuid");
  assert.equal(column.rows[0].is_nullable, "NO");
  assert.match(column.rows[0].column_default, /gen_random_uuid\(\)/);
  assert.match(
    String(payment.rows[0].request_id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test("payments foundation rejects duplicate request_id", async () => {
  const requestId = (await db.pool.query(
    "SELECT request_id FROM payments WHERE id = $1",
    [legacyPaymentId]
  )).rows[0].request_id;

  await assert.rejects(
    db.pool.query(
      `INSERT INTO payments (commission_id, payment_type, amount, request_id)
       VALUES ($1, 'installment', 1, $2)`,
      [depositedCommissionId, requestId]
    ),
    (error) => error.code === "23505"
  );
});

test("payments foundation adds created_at and nullable audit text fields", async () => {
  const columns = await db.pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payments'
       AND column_name IN ('created_at', 'external_reference', 'notes')
     ORDER BY column_name`
  );
  const legacy = await db.pool.query(
    `SELECT created_at, external_reference, notes
     FROM payments
     WHERE id = $1`,
    [legacyPaymentId]
  );

  assert.equal(columns.rows[0].column_name, "created_at");
  assert.equal(columns.rows[0].data_type, "timestamp with time zone");
  assert.equal(columns.rows[0].is_nullable, "NO");
  assert.match(columns.rows[0].column_default, /now\(\)/i);
  assert.deepEqual(
    columns.rows.slice(1).map(({ column_name, data_type, is_nullable }) => ({
      column_name,
      data_type,
      is_nullable
    })),
    [
      { column_name: "external_reference", data_type: "text", is_nullable: "YES" },
      { column_name: "notes", data_type: "text", is_nullable: "YES" }
    ]
  );
  assert.ok(legacy.rows[0].created_at instanceof Date);
  assert.equal(legacy.rows[0].external_reference, null);
  assert.equal(legacy.rows[0].notes, null);
});

test("payments foundation preserves the original payment columns", async () => {
  const columns = await db.pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'payments'
       AND column_name IN (
         'id',
         'commission_id',
         'payment_type',
         'amount',
         'sales_tax',
         'payment_method',
         'payment_date',
         'status'
       )`
  );
  const byName = Object.fromEntries(
    columns.rows.map((column) => [column.column_name, column])
  );

  assert.deepEqual(byName.id, {
    column_name: "id",
    data_type: "bigint",
    is_nullable: "NO"
  });
  assert.deepEqual(byName.commission_id, {
    column_name: "commission_id",
    data_type: "bigint",
    is_nullable: "NO"
  });
  assert.deepEqual(byName.payment_type, {
    column_name: "payment_type",
    data_type: "text",
    is_nullable: "NO"
  });
  assert.deepEqual(byName.amount, {
    column_name: "amount",
    data_type: "numeric",
    is_nullable: "NO"
  });
  assert.deepEqual(byName.sales_tax, {
    column_name: "sales_tax",
    data_type: "numeric",
    is_nullable: "NO"
  });
  assert.deepEqual(byName.payment_method, {
    column_name: "payment_method",
    data_type: "text",
    is_nullable: "YES"
  });
  assert.deepEqual(byName.payment_date, {
    column_name: "payment_date",
    data_type: "date",
    is_nullable: "YES"
  });
  assert.deepEqual(byName.status, {
    column_name: "status",
    data_type: "text",
    is_nullable: "NO"
  });
});

for (const paymentType of [
  "deposit",
  "installment",
  "balance",
  "refund",
  "adjustment"
]) {
  test(`payments foundation preserves payment type ${paymentType}`, async () => {
    const inserted = await db.pool.query(
      `INSERT INTO payments (commission_id, payment_type, amount)
       VALUES ($1, $2, 1)
       RETURNING payment_type`,
      [noDepositCommissionId, paymentType]
    );

    assert.equal(inserted.rows[0].payment_type, paymentType);
  });
}

for (const status of ["pending", "completed", "failed", "refunded", "void"]) {
  test(`payments foundation preserves payment status ${status}`, async () => {
    const inserted = await db.pool.query(
      `INSERT INTO payments (commission_id, payment_type, amount, status)
       VALUES ($1, 'installment', 1, $2)
       RETURNING status`,
      [noDepositCommissionId, status]
    );

    assert.equal(inserted.rows[0].status, status);
  });
}

test("payments foundation preserves positive amount constraint", async () => {
  await assert.rejects(
    db.pool.query(
      `INSERT INTO payments (commission_id, payment_type, amount)
       VALUES ($1, 'deposit', 0)`,
      [noDepositCommissionId]
    ),
    (error) => error.code === "23514"
  );
});

test("payments foundation preserves nonnegative sales_tax constraint", async () => {
  await assert.rejects(
    db.pool.query(
      `INSERT INTO payments (commission_id, payment_type, amount, sales_tax)
       VALUES ($1, 'balance', 1, -0.01)`,
      [noDepositCommissionId]
    ),
    (error) => error.code === "23514"
  );
});

test("payments foundation documents gross amount and included sales tax semantics", async () => {
  const comments = await db.pool.query(
    `SELECT
       (SELECT col_description(a.attrelid, a.attnum)
        FROM pg_attribute AS a
        WHERE a.attrelid = 'payments'::regclass
          AND a.attname = 'amount') AS amount_comment,
       (SELECT col_description(a.attrelid, a.attnum)
        FROM pg_attribute AS a
        WHERE a.attrelid = 'payments'::regclass
          AND a.attname = 'sales_tax') AS sales_tax_comment,
       (SELECT col_description(a.attrelid, a.attnum)
        FROM pg_attribute AS a
        WHERE a.attrelid = 'commissions'::regclass
          AND a.attname = 'amount_paid') AS amount_paid_comment`
  );

  assert.match(comments.rows[0].amount_comment, /Gross money actually received/);
  assert.match(comments.rows[0].amount_comment, /included in this amount/);
  assert.match(comments.rows[0].sales_tax_comment, /never added to amount/);
  assert.match(comments.rows[0].amount_paid_comment, /Total accumulated gross money/);
});
