import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";
import { Pool } from "pg";

import { config, createHandler } from "../../netlify/functions/admin-precommission-payments.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import { hashContractSnapshot } from "../../netlify/shared/contract-acceptance.mjs";
import { ensureRequiredDepositObligationForContractAcceptance } from "../../netlify/shared/precommission-deposit.mjs";
import { recordPrecommissionDepositPayment } from "../../netlify/shared/precommission-payment.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const paymentTime = new Date("2026-10-12T17:00:00.000Z");
const unconfiguredProvider = Object.freeze({
  configured: false,
  async sendEmail() { throw new Error("Provider must not be called."); }
});

let database;
let db;
let connectionString;
let cookie;
let sequence = 0;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

afterEach(async () => {
  await db.pool.query(
    `TRUNCATE
       communications, commission_events, payment_allocations,
       commission_obligations, acceptances, documents, payments,
       quotations, commissions, clients
     RESTART IDENTITY CASCADE`
  );
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function environmentReader(name) {
  return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
}

async function createCanonicalFixture({ expiresAt = "2026-11-01T17:00:00.000Z" } = {}) {
  sequence += 1;
  const client = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ($1, $2) RETURNING *",
    [`Deposit Client ${sequence}`, `deposit-${sequence}@example.invalid`]
  )).rows[0];
  const quotationNumber = `SAS-QUO-2026-${String(9400 + sequence).padStart(4, "0")}`;
  const quotationSnapshot = {
    snapshot_version: 2,
    quotation_number: quotationNumber,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: expiresAt,
    client: {
      client_id: String(client.id), full_name: client.full_name,
      email: client.email, phone: null
    },
    inquiry: null,
    artwork: {
      title: "Pre-Commission Portrait", description: "Accepted scope", medium: "Oil",
      dimensions: { width: "20.00", height: "24.00", unit: "in" }
    },
    commercial: {
      price: "400.00", sales_tax_rate: "0.0600", sales_tax: "24.00",
      shipping_charge: "20.00", required_deposit_rate: "0.5000",
      required_deposit: "200.00", total: "444.00",
      estimated_completion: "2027-02-15", special_terms: null,
      shipping_estimate: null
    }
  };
  const quotationHash = hashQuotationSnapshot(quotationSnapshot);
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       client_id, artwork_title, artwork_description, artwork_medium,
       artwork_width, artwork_height, snapshot_version, quotation_number,
       version, quotation_status, issued_at, accepted_at, expires_at,
       price, sales_tax_rate, sales_tax, shipping_charge,
       required_deposit_rate, required_deposit, quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, 'Pre-Commission Portrait', 'Accepted scope', 'Oil', 20, 24, 2, $2,
       1, 'accepted', '2026-10-01T16:00:00Z', '2026-10-02T16:00:00Z', $3,
       400, .06, 24, 20, .50, 200, $4::JSONB, $5
     ) RETURNING *`,
    [client.id, quotationNumber, expiresAt, JSON.stringify(quotationSnapshot), quotationHash]
  )).rows[0];
  const quotationAcceptance = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, client_id, client_name_entered,
       client_email, accepted_at, acceptance_method, subject_number,
       subject_version, snapshot_hash, request_id
     ) VALUES (
       'quotation', $1, $2, $3, $4, '2026-10-02T16:00:00Z',
       'admin_recorded', $5, 1, $6, $7
     ) RETURNING *`,
    [quotation.id, client.id, client.full_name, client.email,
     quotationNumber, quotationHash, randomUUID()]
  )).rows[0];
  const contractNumber = `SAS-CON-2026-${String(9400 + sequence).padStart(4, "0")}`;
  const contractSnapshot = {
    schema_version: 3,
    contract: {
      document_number: contractNumber, version: 1, status: "issued",
      terms_version: "approved-test-1", issued_at: "2026-10-03T16:00:00.000Z"
    },
    client: {
      client_id: String(client.id), full_name: client.full_name, email: client.email
    },
    quotation: {
      quotation_id: String(quotation.id), quotation_number: quotationNumber,
      quotation_version: 1, quotation_snapshot_hash: quotationHash,
      quotation_acceptance_id: String(quotationAcceptance.id),
      quotation_accepted_at: quotationAcceptance.accepted_at.toISOString()
    },
    artwork: quotationSnapshot.artwork,
    commercial: quotationSnapshot.commercial,
    terms: {
      approved: true, terms_version: "approved-test-1", snapshot_hash: "a".repeat(64)
    }
  };
  const contract = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, client_id, quotation_id, document_type, document_number,
       version, file_location, document_snapshot, request_id
     ) VALUES (NULL, $1, $2, 'contract', $3, 1, '/admin/contract.html', $4::JSONB, $5)
     RETURNING *`,
    [client.id, quotation.id, contractNumber, JSON.stringify(contractSnapshot), randomUUID()]
  )).rows[0];
  const contractAcceptance = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, document_id, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, terms_version, request_id
     ) VALUES (
       'contract', $1, $2, NULL, $3, $4, $5, '2026-10-04T16:00:00Z',
       'admin_recorded', $6, 1, $7, 'approved-test-1', $8
     ) RETURNING *`,
    [contract.id, quotation.id, client.id, client.full_name, client.email,
     contractNumber, hashContractSnapshot(contractSnapshot), randomUUID()]
  )).rows[0];
  const obligationResult = await ensureRequiredDepositObligationForContractAcceptance(
    db,
    contractAcceptance.id,
    { now: () => new Date("2026-10-05T16:00:00Z") }
  );
  assert.equal(obligationResult.outcome, "success");
  return { client, quotation, quotationSnapshot, contract, contractAcceptance, obligation: obligationResult.obligation };
}

function paymentInput(obligationId, overrides = {}) {
  return {
    obligation_id: String(obligationId),
    request_id: randomUUID(),
    amount: null,
    payment_method: "bank_transfer",
    payment_date: "2026-10-12",
    external_reference: "External reference",
    notes: null,
    ...overrides
  };
}

test("pre-Commission deposit endpoint is explicit and separate from Commission Payments", () => {
  assert.equal(config.path, "/admin/api/payments/precommission-deposit");
});

test("schema permits only the strict canonical pre-Commission Payment and Receipt contexts", async () => {
  const fixture = await createCanonicalFixture();
  const columns = new Map((await db.pool.query(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'payments'"
  )).rows.map((row) => [row.column_name, row.is_nullable]));
  assert.equal(columns.get("commission_id"), "YES");
  for (const name of ["client_id", "quotation_id", "precommission_obligation_id"]) {
    assert.equal(columns.get(name), "YES");
  }
  await assert.rejects(db.pool.query(
    `INSERT INTO payments (
       commission_id, request_id, payment_type, amount, status,
       client_id, quotation_id, precommission_obligation_id
     ) VALUES (NULL, $1, 'balance', 200, 'completed', $2, $3, $4)`,
    [randomUUID(), fixture.client.id, fixture.quotation.id, fixture.obligation.id]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO payments (commission_id, request_id, payment_type, amount, status)
     VALUES (NULL, $1, 'deposit', 200, 'completed')`,
    [randomUUID()]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version,
       file_location, payment_id, receipt_snapshot
     ) VALUES (NULL, 'receipt', 'SAS-REC-2026-9998', 1,
       '/admin/payment-receipt.html', NULL, '{}'::JSONB)`,
  ));
});

test("valid payment atomically satisfies the obligation and creates one immutable Receipt and outbox", async () => {
  const fixture = await createCanonicalFixture();
  const result = await recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    { now: () => new Date(paymentTime) }
  );
  assert.equal(result.outcome, "success");
  assert.equal(result.created, true);
  assert.equal(result.payment.amount, "200.00");
  assert.equal(result.payment.sales_tax, "0.00");
  assert.equal(result.payment.balance_after_payment, null);
  assert.equal(result.payment.commission_id, result.commission.id);
  assert.equal(result.allocation.amount, "200.00");
  assert.equal(result.obligation.obligation_status, "satisfied");
  assert.equal(result.obligation.remaining, "0.00");

  const receipt = (await db.pool.query(
    "SELECT * FROM documents WHERE id = $1",
    [result.receipt.id]
  )).rows[0];
  assert.equal(String(receipt.commission_id), result.commission.id);
  assert.equal(String(receipt.client_id), String(fixture.client.id));
  assert.equal(String(receipt.quotation_id), String(fixture.quotation.id));
  assert.equal(receipt.receipt_snapshot.quotation.number, fixture.quotation.quotation_number);
  assert.equal(receipt.receipt_snapshot.reference.number, fixture.quotation.quotation_number);
  assert.equal(receipt.receipt_snapshot.deposit.remaining_after_payment, "0.00");
  assert.equal(Object.hasOwn(receipt.receipt_snapshot, "commission"), false);
  await assert.rejects(db.pool.query(
    "UPDATE documents SET receipt_snapshot = jsonb_set(receipt_snapshot, '{deposit,remaining_after_payment}', '\"1.00\"') WHERE id = $1",
    [receipt.id]
  ));

  const communication = (await db.pool.query("SELECT * FROM communications")).rows[0];
  assert.equal(communication.automation_key, "receipt_delivery");
  assert.equal(communication.communication_status, "ready");
  assert.equal(communication.commission_id, null);
  assert.equal(String(communication.client_id), String(fixture.client.id));
  assert.equal(String(communication.quotation_id), String(fixture.quotation.id));
  assert.match(communication.body_snapshot, new RegExp(fixture.quotation.quotation_number));
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commissions")).rows[0].count, 1);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_events WHERE event_type = 'commission_activated'")).rows[0].count, 1);
});

test("server derives the full amount and rejects underpayment and overpayment before writes", async () => {
  const fixture = await createCanonicalFixture();
  for (const amount of ["199.99", "200.01"]) {
    const result = await recordPrecommissionDepositPayment(
      db,
      paymentInput(fixture.obligation.id, { amount }),
      { now: () => new Date(paymentTime) }
    );
    assert.equal(result.outcome, "amount_mismatch");
  }
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payments")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payment_allocations")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "open");
});

test("expired Quotation blocks every payment-side write", async () => {
  const fixture = await createCanonicalFixture({ expiresAt: "2026-10-11T17:00:00.000Z" });
  const result = await recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    { now: () => new Date(paymentTime) }
  );
  assert.equal(result.outcome, "quotation_expired_for_deposit");
  for (const table of ["payments", "payment_allocations", "communications"]) {
    assert.equal((await db.pool.query(`SELECT count(*)::INTEGER AS count FROM ${table}`)).rows[0].count, 0);
  }
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM documents WHERE document_type = 'receipt'")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "open");
});

test("database allocation validator rejects cross-context and duplicate allocations", async () => {
  const fixture = await createCanonicalFixture();
  const result = await recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    { now: () => new Date(paymentTime) }
  );
  await assert.rejects(db.pool.query(
    "INSERT INTO payment_allocations (payment_id, obligation_id, amount) VALUES ($1, $2, 200)",
    [result.payment.id, fixture.obligation.id]
  ));
});

test("database rejects Client, Quotation, and Obligation context mismatches", async () => {
  const first = await createCanonicalFixture();
  const second = await createCanonicalFixture();
  const insert = (clientId, quotationId, obligationId) => db.pool.query(
    `INSERT INTO payments (
       commission_id, client_id, quotation_id, precommission_obligation_id,
       request_id, payment_type, amount, sales_tax, status, balance_after_payment
     ) VALUES (NULL, $1, $2, $3, $4, 'deposit', 200, 0, 'completed', NULL)`,
    [clientId, quotationId, obligationId, randomUUID()]
  );

  await assert.rejects(insert(second.client.id, first.quotation.id, first.obligation.id));
  await assert.rejects(insert(first.client.id, second.quotation.id, first.obligation.id));
  await assert.rejects(insert(first.client.id, first.quotation.id, second.obligation.id));
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payments")).rows[0].count, 0);
});

test("closed Deposit Obligation is rejected without financial or document writes", async () => {
  const fixture = await createCanonicalFixture();
  await db.pool.query(
    `UPDATE commission_obligations
     SET obligation_status = 'waived', waived_at = $2, updated_at = $2
     WHERE id = $1`,
    [fixture.obligation.id, paymentTime]
  );
  const result = await recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    { now: () => new Date(paymentTime) }
  );
  assert.equal(result.outcome, "obligation_not_open");
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payments")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM documents WHERE document_type = 'receipt'")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM communications")).rows[0].count, 0);
});

test("same request is idempotent and creates no duplicate canonical records", async () => {
  const fixture = await createCanonicalFixture();
  const input = paymentInput(fixture.obligation.id);
  const first = await recordPrecommissionDepositPayment(db, input, { now: () => new Date(paymentTime) });
  const second = await recordPrecommissionDepositPayment(db, input, { now: () => new Date(paymentTime) });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.payment.id, second.payment.id);
  for (const [table, where] of [
    ["payments", "commission_id IS NOT NULL"],
    ["payment_allocations", "TRUE"],
    ["documents", "document_type = 'receipt'"],
    ["communications", "automation_key = 'receipt_delivery'"]
  ]) assert.equal((await db.pool.query(`SELECT count(*)::INTEGER AS count FROM ${table} WHERE ${where}`)).rows[0].count, 1);
});

test("real concurrent independent handlers produce one canonical payment graph", async () => {
  const fixture = await createCanonicalFixture();
  const dbA = { pool: new Pool({ connectionString }) };
  const dbB = { pool: new Pool({ connectionString }) };
  const failures = [];
  const options = (databaseConnection) => ({
    databaseFactory: () => databaseConnection,
    environmentReader,
    emailProvider: unconfiguredProvider,
    now: () => new Date(paymentTime),
    errorReporter: (error) => failures.push({
      code: error?.code,
      constraint: error?.constraint,
      stage: error?.precommission_stage,
      message: error?.message
    })
  });
  const handlerA = createHandler(options(dbA));
  const handlerB = createHandler(options(dbB));
  const request = (requestId) => new Request(
    "http://localhost/admin/api/payments/precommission-deposit",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        obligation_id: fixture.obligation.id,
        request_id: requestId,
        payment_method: "bank_transfer",
        payment_date: "2026-10-12"
      })
    }
  );
  try {
    const [first, second] = await Promise.all([
      handlerA(request(randomUUID())),
      handlerB(request(randomUUID()))
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      [200, 201],
      JSON.stringify(failures)
    );
    for (const [table, where] of [
      ["payments", "commission_id IS NOT NULL"],
      ["payment_allocations", "TRUE"],
      ["documents", "document_type = 'receipt'"],
      ["communications", "automation_key = 'receipt_delivery'"]
    ]) assert.equal((await db.pool.query(`SELECT count(*)::INTEGER AS count FROM ${table} WHERE ${where}`)).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "satisfied");
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commissions")).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_lifecycle WHERE lifecycle_status = 'active'")).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_production WHERE production_status = 'not_started'")).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_events WHERE event_type = 'commission_activated'")).rows[0].count, 1);
  } finally {
    await dbA.pool.end();
    await dbB.pool.end();
  }
});

test("failure after Payment creation rolls back Payment, Allocation, Receipt, outbox, and satisfaction", async () => {
  const fixture = await createCanonicalFixture();
  await assert.rejects(recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    {
      now: () => new Date(paymentTime),
      afterPaymentCreated: () => { throw new Error("Injected failure"); }
    }
  ), /Injected failure/);
  for (const table of ["payments", "payment_allocations", "communications"]) {
    assert.equal((await db.pool.query(`SELECT count(*)::INTEGER AS count FROM ${table}`)).rows[0].count, 0);
  }
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM documents WHERE document_type = 'receipt'")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "open");
});

test("the default B4 handoff activates the Commission inside the B3 transaction", async () => {
  const fixture = await createCanonicalFixture();
  const result = await recordPrecommissionDepositPayment(
    db,
    paymentInput(fixture.obligation.id),
    { now: () => new Date(paymentTime) }
  );
  assert.equal(result.activation_handoff.created, true);
  assert.equal(result.activation_handoff.commission.id, result.commission.id);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commissions")).rows[0].count, 1);
});

test("legacy Commission Payment and Receipt remain valid", async () => {
  const fixture = await createCanonicalFixture();
  const commission = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ($1, $2, 'Legacy Commission', 'Legacy flow', 'Oil', 400)
     RETURNING *`,
    [`SAS-COM-2026-${String(9400 + sequence).padStart(4, "0")}`, fixture.client.id]
  )).rows[0];
  const payment = (await db.pool.query(
    `INSERT INTO payments (
       commission_id, request_id, payment_type, amount, sales_tax, status
     ) VALUES ($1, $2, 'deposit', 200, 0, 'completed') RETURNING *`,
    [commission.id, randomUUID()]
  )).rows[0];
  const receipt = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, client_id, payment_id, document_type, document_number,
       version, file_location, receipt_snapshot
     ) VALUES ($1, $2, $3, 'receipt', $4, 1, '/admin/payment-receipt.html', $5::JSONB)
     RETURNING *`,
    [commission.id, fixture.client.id, payment.id,
     `SAS-REC-2026-${String(9800 + sequence).padStart(4, "0")}`,
     JSON.stringify({ receipt: { number: "legacy" }, payment: { id: String(payment.id) } })]
  )).rows[0];
  assert.equal(String(receipt.commission_id), String(commission.id));
});

test("endpoint authenticates, rejects amount mismatch with 422, and leaves the outbox ready when provider is absent", async () => {
  const fixture = await createCanonicalFixture();
  const handler = createHandler({
    databaseFactory: () => db,
    environmentReader,
    emailProvider: unconfiguredProvider,
    now: () => new Date(paymentTime)
  });
  const unauthorized = await handler(new Request(
    "http://localhost/admin/api/payments/precommission-deposit",
    { method: "POST" }
  ));
  assert.equal(unauthorized.status, 401);
  const response = await handler(new Request(
    "http://localhost/admin/api/payments/precommission-deposit",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        obligation_id: fixture.obligation.id,
        request_id: randomUUID(),
        amount: "199.99",
        payment_method: "bank_transfer"
      })
    }
  ));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "amount_mismatch");
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payments")).rows[0].count, 0);
});
