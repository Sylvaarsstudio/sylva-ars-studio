import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createHandler,
  getCommissionObligationsId
} from "../../netlify/functions/admin-commissions.mjs";
import {
  allocatePaymentToObligation,
  createCommissionObligation,
  deriveObligationFinancials,
  obligationStatuses,
  obligationTypes,
  readCommissionObligations,
  validateAllocation
} from "../../netlify/shared/commission-obligations.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const migrationPath = new URL(
  "../../netlify/database/migrations/20261011170000_create_commission_obligations.sql",
  import.meta.url
);

let database;
let db;
let clientIds;
let commissionIds;
let paymentIds;
let handler;
let sessionCookie;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-29-password";
  const secret = "phase-29-secret";
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
    }
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

beforeEach(async () => {
  clientIds = [];
  commissionIds = [];
  paymentIds = [];
  for (const suffix of [1, 2]) {
    const clientId = (await db.pool.query(
      "INSERT INTO clients (full_name, email) VALUES ($1, $2) RETURNING id",
      [`Obligation Client ${suffix}`, `obligation-${suffix}@example.invalid`]
    )).rows[0].id;
    clientIds.push(clientId);
    const commissionId = (await db.pool.query(
      `INSERT INTO commissions (
         commission_number, client_id, title, description, medium, price,
         deposit_amount, amount_paid, sales_tax, shipping, status
       ) VALUES ($1, $2, $3, 'Phase 9 foundation', 'Oil', 500, 50, 50, 30, 20, 'draft')
       RETURNING id`,
      [`SAS-COM-2026-99${suffix}1`, clientId, `Obligation Commission ${suffix}`]
    )).rows[0].id;
    commissionIds.push(commissionId);
    const paymentId = (await db.pool.query(
      `INSERT INTO payments (
         commission_id, payment_type, amount, sales_tax, status, request_id
       ) VALUES ($1, 'installment', 100, 0, 'completed', $2)
       RETURNING id`,
      [commissionId, randomUUID()]
    )).rows[0].id;
    paymentIds.push(paymentId);
  }
});

afterEach(async () => {
  await db.pool.query("DELETE FROM payment_allocations");
  await db.pool.query("DELETE FROM commission_obligations");
  await db.pool.query("DELETE FROM acceptances");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("DELETE FROM commission_events");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commission_inquiries");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

async function createObligation({
  commissionId = commissionIds[0],
  amount = "100.00",
  obligationType = "other",
  requestId = randomUUID()
} = {}) {
  return createCommissionObligation(db, {
    commissionId,
    obligationType,
    amount,
    requestId
  });
}

function adminRequest(method = "GET", id = commissionIds[0], authenticated = true) {
  return handler(new Request(
    `http://localhost/admin/api/commissions/${id}/obligations`,
    {
      method,
      headers: authenticated ? { Cookie: sessionCookie } : {}
    }
  ));
}

test("phase 9 migration creates both canonical financial tables and indexes", async () => {
  const tables = (await db.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('commission_obligations', 'payment_allocations')`
  )).rows.map((row) => row.table_name).sort();
  assert.deepEqual(tables, ["commission_obligations", "payment_allocations"]);

  const columns = new Map((await db.pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name IN ('commission_obligations', 'payment_allocations')`
  )).rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  for (const name of [
    "commission_obligations.id", "commission_obligations.commission_id",
    "commission_obligations.obligation_type", "commission_obligations.obligation_status",
    "commission_obligations.amount", "commission_obligations.due_at",
    "commission_obligations.source_type", "commission_obligations.source_id",
    "commission_obligations.description", "commission_obligations.satisfied_at",
    "commission_obligations.waived_at", "commission_obligations.voided_at",
    "commission_obligations.request_id", "commission_obligations.created_at",
    "commission_obligations.updated_at", "payment_allocations.id",
    "payment_allocations.payment_id", "payment_allocations.obligation_id",
    "payment_allocations.amount", "payment_allocations.created_at"
  ]) assert.ok(columns.has(name), name);
  assert.equal(columns.get("commission_obligations.amount").data_type, "numeric");

  const indexes = (await db.pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename IN ('commission_obligations', 'payment_allocations')`
  )).rows.map((row) => row.indexname);
  assert.ok(indexes.includes("commission_obligations_request_id_unique"));
  assert.ok(indexes.includes("commission_obligations_commission_status_index"));
  assert.ok(indexes.includes("payment_allocations_payment_id_index"));
  assert.ok(indexes.includes("payment_allocations_obligation_id_index"));
});

test("database controls obligation vocabularies, positive money, terminal timestamps, and request idempotency", async () => {
  for (const type of obligationTypes) {
    await db.pool.query(
      `INSERT INTO commission_obligations (commission_id, obligation_type, amount)
       VALUES ($1, $2, 1)`,
      [commissionIds[0], type]
    );
  }
  for (const status of obligationStatuses) {
    const timestampColumn = {
      satisfied: "satisfied_at",
      waived: "waived_at",
      voided: "voided_at"
    }[status];
    await db.pool.query(
      `INSERT INTO commission_obligations (
         commission_id, obligation_type, obligation_status, amount${timestampColumn ? `, ${timestampColumn}` : ""}
       ) VALUES ($1, 'other', $2, 1${timestampColumn ? ", NOW()" : ""})`,
      [commissionIds[0], status]
    );
  }
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_obligations (commission_id, obligation_type, amount) VALUES ($1, 'refund', 1)",
    [commissionIds[0]]
  ));
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_obligations (commission_id, obligation_type, obligation_status, amount) VALUES ($1, 'other', 'partial', 1)",
    [commissionIds[0]]
  ));
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_obligations (commission_id, obligation_type, amount) VALUES ($1, 'other', 0)",
    [commissionIds[0]]
  ));
  await assert.rejects(db.pool.query(
    "INSERT INTO payment_allocations (payment_id, obligation_id, amount) VALUES ($1, 999999, 0)",
    [paymentIds[0]]
  ));
  const requestId = randomUUID();
  await createObligation({ requestId });
  const retry = await createObligation({ requestId });
  assert.equal(retry.outcome, "idempotent");
  const conflict = await createObligation({ requestId, amount: "2.00" });
  assert.equal(conflict.outcome, "request_id_conflict");
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE request_id = $1",
    [requestId]
  )).rows[0].count, 1);
});

test("foreign keys use RESTRICT and prevent deletion of referenced records", async () => {
  const obligation = (await createObligation()).obligation;
  await allocatePaymentToObligation(db, {
    paymentId: paymentIds[0], obligationId: obligation.id, amount: "25.00"
  });
  const deleteRules = (await db.pool.query(
    `SELECT constraint_name, delete_rule
     FROM information_schema.referential_constraints
     WHERE constraint_name IN (
       'commission_obligations_commission_id_fkey',
       'payment_allocations_payment_id_fkey',
       'payment_allocations_obligation_id_fkey'
     )`
  )).rows;
  assert.equal(deleteRules.length, 3);
  assert.ok(deleteRules.every((row) => row.delete_rule === "RESTRICT"));
  await assert.rejects(db.pool.query("DELETE FROM commissions WHERE id = $1", [commissionIds[0]]));
  await assert.rejects(db.pool.query("DELETE FROM payments WHERE id = $1", [paymentIds[0]]));
  await assert.rejects(db.pool.query("DELETE FROM commission_obligations WHERE id = $1", [obligation.id]));
});

test("derived model distinguishes unpaid, partial, satisfied, waived, and voided obligations", () => {
  assert.deepEqual(deriveObligationFinancials("100.00", "0.00"), {
    allocated_amount: "0.00", outstanding_amount: "100.00", financial_condition: "unpaid"
  });
  assert.deepEqual(deriveObligationFinancials("100.00", "25.00"), {
    allocated_amount: "25.00", outstanding_amount: "75.00", financial_condition: "partially_satisfied"
  });
  assert.deepEqual(deriveObligationFinancials("100.00", "100.00"), {
    allocated_amount: "100.00", outstanding_amount: "0.00", financial_condition: "satisfied"
  });
  assert.equal(deriveObligationFinancials("100.00", "0.00", "waived").outstanding_amount, "0.00");
  assert.equal(deriveObligationFinancials("100.00", "0.00", "voided").outstanding_amount, "0.00");
});

test("read model is uninitialized for existing Commissions and no migration backfill exists", async () => {
  const result = await readCommissionObligations(db, commissionIds[0]);
  const migration = readFileSync(migrationPath, "utf8");
  assert.deepEqual(result, { initialized: false, obligations: [] });
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+commission_obligations[\s\S]*SELECT/i);
});

test("read model calculates full, partial, and zero outstanding amounts from allocations", async () => {
  const obligation = (await createObligation()).obligation;
  let result = await readCommissionObligations(db, commissionIds[0]);
  assert.equal(result.obligations[0].outstanding_amount, "100.00");
  assert.equal(result.obligations[0].financial_condition, "unpaid");

  await allocatePaymentToObligation(db, {
    paymentId: paymentIds[0], obligationId: obligation.id, amount: "40.00"
  });
  result = await readCommissionObligations(db, commissionIds[0]);
  assert.equal(result.obligations[0].allocated_amount, "40.00");
  assert.equal(result.obligations[0].outstanding_amount, "60.00");
  assert.equal(result.obligations[0].financial_condition, "partially_satisfied");

  await allocatePaymentToObligation(db, {
    paymentId: paymentIds[0], obligationId: obligation.id, amount: "60.00"
  });
  result = await readCommissionObligations(db, commissionIds[0]);
  assert.equal(result.obligations[0].obligation_status, "satisfied");
  assert.equal(result.obligations[0].outstanding_amount, "0.00");
  assert.equal(result.obligations[0].financial_condition, "satisfied");
});

test("allocation validation rejects payment over-allocation, obligation over-allocation, and cross-Commission links", async () => {
  const obligation = (await createObligation({ amount: "150.00" })).obligation;
  assert.equal(validateAllocation({
    payment: { commission_id: commissionIds[0], amount: "100.00", status: "completed" },
    obligation: { commission_id: commissionIds[0], amount: "150.00", obligation_status: "open" },
    paymentAllocated: "90.00", obligationAllocated: "0.00", amount: "20.00"
  }).outcome, "payment_overallocated");
  assert.equal(validateAllocation({
    payment: { commission_id: commissionIds[0], amount: "100.00", status: "completed" },
    obligation: { commission_id: commissionIds[0], amount: "150.00", obligation_status: "open" },
    paymentAllocated: "0.00", obligationAllocated: "140.00", amount: "20.00"
  }).outcome, "obligation_overallocated");
  assert.equal((await allocatePaymentToObligation(db, {
    paymentId: paymentIds[1], obligationId: obligation.id, amount: "10.00"
  })).outcome, "cross_commission");
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM payment_allocations")).rows[0].count, 0);
});

test("completed allocation satisfies the obligation atomically without changing legacy Commission aggregates", async () => {
  const before = (await db.pool.query(
    "SELECT deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
    [commissionIds[0]]
  )).rows[0];
  const obligation = (await createObligation()).obligation;
  const result = await allocatePaymentToObligation(db, {
    paymentId: paymentIds[0], obligationId: obligation.id, amount: "100.00"
  }, { now: () => new Date("2026-10-11T20:00:00Z") });
  const row = (await db.pool.query(
    "SELECT obligation_status, satisfied_at FROM commission_obligations WHERE id = $1",
    [obligation.id]
  )).rows[0];
  const after = (await db.pool.query(
    "SELECT deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
    [commissionIds[0]]
  )).rows[0];
  assert.equal(result.outcome, "success");
  assert.equal(result.obligation_satisfied, true);
  assert.equal(row.obligation_status, "satisfied");
  assert.equal(row.satisfied_at.toISOString(), "2026-10-11T20:00:00.000Z");
  assert.deepEqual(after, before);
});

test("concurrent allocations lock rows and cannot over-allocate Payment or Obligation", async () => {
  const obligation = (await createObligation()).obligation;
  const results = await Promise.all([
    allocatePaymentToObligation(db, {
      paymentId: paymentIds[0], obligationId: obligation.id, amount: "60.00"
    }),
    allocatePaymentToObligation(db, {
      paymentId: paymentIds[0], obligationId: obligation.id, amount: "60.00"
    })
  ]);
  assert.equal(results.filter((result) => result.outcome === "success").length, 1);
  assert.ok(results.some((result) => ["payment_overallocated", "obligation_overallocated"].includes(result.outcome)));
  assert.equal((await db.pool.query(
    "SELECT COALESCE(SUM(amount), 0)::TEXT AS total FROM payment_allocations"
  )).rows[0].total, "60.00");
});

test("accepted Quotation, existing Payment, and legacy status do not create obligations", async () => {
  const snapshot = { quotation_number: "SAS-QUO-2026-9901", version: 1 };
  await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       snapshot_version, quotation_number, version, quotation_status,
       issued_at, accepted_at, expires_at, price, sales_tax_rate, sales_tax,
       shipping_charge, required_deposit, quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, $2, 'Obligation Commission 1', 'Phase 9 foundation', 'Oil', 1,
       'SAS-QUO-2026-9901', 1, 'accepted', NOW(), NOW(), NOW() + INTERVAL '30 days',
       500, 0.06, 30, 20, 250, $3::jsonb, $4
     )`,
    [commissionIds[0], clientIds[0], JSON.stringify(snapshot), "a".repeat(64)]
  );
  await db.pool.query("UPDATE commissions SET status = 'approved' WHERE id = $1", [commissionIds[0]]);
  assert.equal((await readCommissionObligations(db, commissionIds[0])).initialized, false);
});

test("read-only Admin API is authenticated, returns empty and populated models, and rejects mutations", async () => {
  assert.equal(getCommissionObligationsId(`/admin/api/commissions/${commissionIds[0]}/obligations`), String(commissionIds[0]));
  assert.equal((await adminRequest("GET", commissionIds[0], false)).status, 401);
  let response = await adminRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    commission_id: String(commissionIds[0]),
    initialized: false,
    obligations: []
  });

  await createObligation({ obligationType: "storage_fee", amount: "75.00" });
  response = await adminRequest();
  const body = await response.json();
  assert.equal(body.initialized, true);
  assert.equal(body.obligations[0].obligation_type, "storage_fee");
  assert.equal(body.obligations[0].outstanding_amount, "75.00");
  assert.equal((await adminRequest("POST")).status, 405);
  assert.equal((await adminRequest("PATCH")).status, 405);
  assert.equal((await adminRequest("DELETE")).status, 405);
  assert.equal((await adminRequest("GET", "999999")).status, 404);
});

test("Phase 9 creates no Commission Events and does not change Next Action financial behavior", async () => {
  const eventsBefore = (await db.pool.query("SELECT count(*)::integer AS count FROM commission_events")).rows[0].count;
  await createObligation();
  const eventsAfter = (await db.pool.query("SELECT count(*)::integer AS count FROM commission_events")).rows[0].count;
  assert.equal(eventsAfter, eventsBefore);

  const nextActionSource = readFileSync(
    new URL("../../netlify/shared/commission-next-action.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(nextActionSource, /await_deposit|await_final_payment|commission_obligations/);
});
