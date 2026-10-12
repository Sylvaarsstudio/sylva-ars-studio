import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";
import { Pool } from "pg";

import { createHandler } from "../../netlify/functions/admin-precommission-payments.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import { hashContractSnapshot } from "../../netlify/shared/contract-acceptance.mjs";
import { ensureRequiredDepositObligationForContractAcceptance } from "../../netlify/shared/precommission-deposit.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const activationTime = new Date("2026-10-12T17:00:00.000Z");
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
       communications, commission_events, commission_lifecycle,
       commission_production, commission_inquiries, payment_allocations,
       commission_obligations, acceptances, documents, payments,
       quotations, commissions, clients, inquiries
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

async function createCanonicalFixture({ withInquiry = false } = {}) {
  sequence += 1;
  const client = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ($1, $2) RETURNING *",
    [`Activation Client ${sequence}`, `activation-${sequence}@example.invalid`]
  )).rows[0];
  const inquiry = withInquiry ? (await db.pool.query(
    `INSERT INTO inquiries (form_type, client_name, client_email, message)
     VALUES ('commission_request', $1, $2, 'Canonical origin') RETURNING *`,
    [client.full_name, client.email]
  )).rows[0] : null;
  const quotationNumber = `SAS-QUO-2026-${String(9700 + sequence).padStart(4, "0")}`;
  const quotationSnapshot = {
    snapshot_version: 2,
    quotation_number: quotationNumber,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: "2026-11-01T17:00:00.000Z",
    client: {
      client_id: String(client.id),
      full_name: client.full_name,
      email: client.email,
      phone: null
    },
    inquiry: inquiry ? { inquiry_id: inquiry.id } : null,
    artwork: {
      title: "Activated Portrait",
      description: "Immutable accepted scope",
      medium: "Oil on linen",
      dimensions: { width: "20.00", height: "24.00", unit: "in" }
    },
    commercial: {
      price: "400.00",
      sales_tax_rate: "0.0600",
      sales_tax: "24.00",
      shipping_charge: "20.00",
      required_deposit_rate: "0.5000",
      required_deposit: "200.00",
      total: "444.00",
      estimated_completion: "2027-02-15",
      special_terms: null,
      shipping_estimate: null
    }
  };
  const quotationHash = hashQuotationSnapshot(quotationSnapshot);
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       client_id, inquiry_id, artwork_title, artwork_description, artwork_medium,
       artwork_width, artwork_height, snapshot_version, quotation_number,
       version, quotation_status, issued_at, accepted_at, expires_at,
       price, sales_tax_rate, sales_tax, shipping_charge,
       required_deposit_rate, required_deposit, estimated_completion,
       quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, $2, 'Mutable title must not win', 'Mutable description must not win',
       'Mutable medium', 1, 1, 2, $3, 1, 'accepted',
       '2026-10-01T16:00:00Z', '2026-10-02T16:00:00Z',
       '2026-11-01T17:00:00Z', 1, 0, 0, 0, .50, 1,
       '2030-01-01', $4::JSONB, $5
     ) RETURNING *`,
    [client.id, inquiry?.id || null, quotationNumber, JSON.stringify(quotationSnapshot), quotationHash]
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
  const contractNumber = `SAS-CON-2026-${String(9700 + sequence).padStart(4, "0")}`;
  const contractSnapshot = {
    schema_version: 3,
    contract: {
      document_number: contractNumber,
      version: 1,
      status: "issued",
      terms_version: "approved-test-1",
      issued_at: "2026-10-03T16:00:00.000Z"
    },
    client: { client_id: String(client.id), full_name: client.full_name, email: client.email },
    quotation: {
      quotation_id: String(quotation.id),
      quotation_number: quotationNumber,
      quotation_version: 1,
      quotation_snapshot_hash: quotationHash,
      quotation_acceptance_id: String(quotationAcceptance.id),
      quotation_accepted_at: quotationAcceptance.accepted_at.toISOString()
    },
    artwork: quotationSnapshot.artwork,
    commercial: quotationSnapshot.commercial,
    terms: { approved: true, terms_version: "approved-test-1", snapshot_hash: "a".repeat(64) }
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
  return {
    client,
    inquiry,
    quotation,
    quotationAcceptance,
    quotationSnapshot,
    contract,
    contractAcceptance,
    contractSnapshot,
    obligation: obligationResult.obligation
  };
}

function createPaymentRequest(obligationId, requestId = randomUUID()) {
  return new Request("http://localhost/admin/api/payments/precommission-deposit", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      obligation_id: obligationId,
      request_id: requestId,
      payment_method: "bank_transfer",
      payment_date: "2026-10-12"
    })
  });
}

function createPaymentHandler(databaseConnection = db, overrides = {}) {
  return createHandler({
    databaseFactory: () => databaseConnection,
    environmentReader,
    emailProvider: unconfiguredProvider,
    now: () => new Date(activationTime),
    ...overrides
  });
}

async function readCounts() {
  const names = [
    "payments", "payment_allocations", "commission_obligations", "documents",
    "communications", "commissions", "commission_lifecycle", "commission_production"
  ];
  const result = {};
  for (const name of names) {
    result[name] = (await db.pool.query(`SELECT count(*)::INTEGER AS count FROM ${name}`)).rows[0].count;
  }
  result.activation_events = (await db.pool.query(
    "SELECT count(*)::INTEGER AS count FROM commission_events WHERE event_type = 'commission_activated'"
  )).rows[0].count;
  return result;
}

test("B4 migration adds a legacy-compatible canonical lifecycle and event vocabulary", async () => {
  const columns = (await db.pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'commission_lifecycle'`
  )).rows;
  assert.deepEqual(
    columns.map((row) => row.column_name).sort(),
    ["activated_at", "activation_source", "commission_id", "created_at", "lifecycle_status", "updated_at"].sort()
  );
  const client = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Legacy', 'legacy-b4@example.invalid') RETURNING id"
  )).rows[0];
  await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-9999', $1, 'Legacy', 'Legacy record', 'Oil', 100)`,
    [client.id]
  );
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_lifecycle")).rows[0].count, 0);
});

test("full Deposit Payment atomically activates one snapshot-derived Commission and promotes only permitted relations", async () => {
  const fixture = await createCanonicalFixture();
  const contractSnapshotBefore = structuredClone(fixture.contract.document_snapshot);
  const contractAcceptanceBefore = (await db.pool.query(
    "SELECT row_to_json(a) AS value FROM acceptances a WHERE id = $1",
    [fixture.contractAcceptance.id]
  )).rows[0].value;
  const quotationAcceptanceBefore = (await db.pool.query(
    "SELECT row_to_json(a) AS value FROM acceptances a WHERE id = $1",
    [fixture.quotationAcceptance.id]
  )).rows[0].value;
  const response = await createPaymentHandler()(createPaymentRequest(fixture.obligation.id));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.commission.lifecycle_status, "active");
  assert.match(body.commission.commission_number, /^SAS-COM-2026-[0-9]{4,}$/);

  const commission = (await db.pool.query(
    "SELECT * FROM commissions WHERE id = $1",
    [body.commission.id]
  )).rows[0];
  assert.equal(String(commission.source_quotation_id), String(fixture.quotation.id));
  assert.equal(String(commission.client_id), String(fixture.client.id));
  assert.equal(commission.title, fixture.quotationSnapshot.artwork.title);
  assert.equal(commission.description, fixture.quotationSnapshot.artwork.description);
  assert.equal(commission.medium, fixture.quotationSnapshot.artwork.medium);
  assert.equal(commission.width, "20.00");
  assert.equal(commission.height, "24.00");
  assert.equal(commission.price, "400.00");
  assert.equal(commission.sales_tax, "24.00");
  assert.equal(commission.shipping, "20.00");
  assert.equal(commission.deposit_amount, "200.00");
  assert.equal(commission.amount_paid, "200.00");
  assert.equal(commission.balance, "244.00");
  assert.equal(commission.estimated_completion.toISOString().slice(0, 10), "2027-02-15");
  assert.equal(commission.status, "draft");

  const lifecycle = (await db.pool.query(
    "SELECT * FROM commission_lifecycle WHERE commission_id = $1",
    [commission.id]
  )).rows[0];
  assert.equal(lifecycle.lifecycle_status, "active");
  assert.equal(lifecycle.activation_source, "required_deposit");
  const production = (await db.pool.query(
    "SELECT * FROM commission_production WHERE commission_id = $1",
    [commission.id]
  )).rows[0];
  assert.equal(production.production_status, "not_started");

  const links = await db.pool.query(
    `SELECT
       (SELECT commission_id FROM documents WHERE id = $1) AS contract_commission_id,
       (SELECT commission_id FROM commission_obligations WHERE id = $2) AS obligation_commission_id,
       (SELECT commission_id FROM payments WHERE id = $3) AS payment_commission_id,
       (SELECT commission_id FROM documents WHERE id = $4) AS receipt_commission_id,
       (SELECT commission_id FROM acceptances WHERE id = $5) AS acceptance_commission_id,
       (SELECT commission_id FROM communications WHERE document_id = $4) AS communication_commission_id`,
    [fixture.contract.id, fixture.obligation.id, body.payment.id, body.receipt.id, fixture.contractAcceptance.id]
  );
  for (const key of ["contract_commission_id", "obligation_commission_id", "payment_commission_id", "receipt_commission_id"]) {
    assert.equal(String(links.rows[0][key]), String(commission.id));
  }
  assert.equal(links.rows[0].acceptance_commission_id, null);
  assert.equal(links.rows[0].communication_commission_id, null);
  assert.deepEqual((await db.pool.query("SELECT document_snapshot FROM documents WHERE id = $1", [fixture.contract.id])).rows[0].document_snapshot, contractSnapshotBefore);
  assert.deepEqual((await db.pool.query("SELECT row_to_json(a) AS value FROM acceptances a WHERE id = $1", [fixture.contractAcceptance.id])).rows[0].value, contractAcceptanceBefore);
  assert.deepEqual((await db.pool.query("SELECT row_to_json(a) AS value FROM acceptances a WHERE id = $1", [fixture.quotationAcceptance.id])).rows[0].value, quotationAcceptanceBefore);
  const receiptSnapshot = (await db.pool.query(
    "SELECT receipt_snapshot FROM documents WHERE id = $1",
    [body.receipt.id]
  )).rows[0].receipt_snapshot;
  assert.equal(Object.hasOwn(receiptSnapshot, "commission"), false);
  assert.equal(receiptSnapshot.reference.type, "quotation");
  assert.equal(receiptSnapshot.quotation.quotation_id, String(fixture.quotation.id));

  const activation = (await db.pool.query(
    "SELECT * FROM commission_events WHERE commission_id = $1 AND event_type = 'commission_activated'",
    [commission.id]
  )).rows;
  assert.equal(activation.length, 1);
  assert.equal(activation[0].actor_type, "system");
  assert.equal(activation[0].source_type, "obligation");
  assert.equal(activation[0].source_id, String(fixture.obligation.id));
  assert.deepEqual(Object.keys(activation[0].payload).sort(), [
    "activating_payment_id", "contract_acceptance_id", "contract_document_id",
    "deposit_obligation_id", "quotation_acceptance_id", "quotation_id"
  ].sort());
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_events WHERE event_type = 'production_initialized'")).rows[0].count, 1);
});

test("real Inquiry provenance is preserved and no Inquiry is fabricated when absent", async () => {
  const withInquiry = await createCanonicalFixture({ withInquiry: true });
  const first = await createPaymentHandler()(createPaymentRequest(withInquiry.obligation.id));
  const firstBody = await first.json();
  const provenance = (await db.pool.query(
    "SELECT * FROM commission_inquiries WHERE commission_id = $1",
    [firstBody.commission.id]
  )).rows;
  assert.equal(provenance.length, 1);
  assert.equal(provenance[0].inquiry_id, withInquiry.inquiry.id);
  assert.equal(provenance[0].relationship_type, "origin");

  await db.pool.query(
    `TRUNCATE communications, commission_events, commission_lifecycle,
       commission_production, commission_inquiries, payment_allocations,
       commission_obligations, acceptances, documents, payments,
       quotations, commissions, clients, inquiries RESTART IDENTITY CASCADE`
  );
  const withoutInquiry = await createCanonicalFixture();
  await createPaymentHandler()(createPaymentRequest(withoutInquiry.obligation.id));
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM inquiries")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_inquiries")).rows[0].count, 0);
});

test("idempotent retries recover the one activated Commission", async () => {
  const fixture = await createCanonicalFixture();
  const requestId = randomUUID();
  const first = await (await createPaymentHandler()(createPaymentRequest(fixture.obligation.id, requestId))).json();
  const sameRequest = await (await createPaymentHandler()(createPaymentRequest(fixture.obligation.id, requestId))).json();
  const newRequest = await (await createPaymentHandler()(createPaymentRequest(fixture.obligation.id))).json();
  assert.equal(first.created, true);
  assert.equal(sameRequest.created, false);
  assert.equal(newRequest.created, false);
  assert.equal(first.commission.id, sameRequest.commission.id);
  assert.equal(first.commission.id, newRequest.commission.id);
  const counts = await readCounts();
  assert.equal(counts.payments, 1);
  assert.equal(counts.payment_allocations, 1);
  assert.equal(counts.commissions, 1);
  assert.equal(counts.commission_lifecycle, 1);
  assert.equal(counts.commission_production, 1);
  assert.equal(counts.activation_events, 1);
});

test("independent concurrent handlers converge on exactly one complete activated graph", async () => {
  const fixture = await createCanonicalFixture();
  const dbA = { pool: new Pool({ connectionString }) };
  const dbB = { pool: new Pool({ connectionString }) };
  try {
    const [first, second] = await Promise.all([
      createPaymentHandler(dbA)(createPaymentRequest(fixture.obligation.id)),
      createPaymentHandler(dbB)(createPaymentRequest(fixture.obligation.id))
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    const counts = await readCounts();
    assert.equal(counts.payments, 1);
    assert.equal(counts.payment_allocations, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_obligations WHERE obligation_status = 'satisfied'")).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM documents WHERE document_type = 'receipt'")).rows[0].count, 1);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM communications WHERE automation_key = 'receipt_delivery'")).rows[0].count, 1);
    assert.equal(counts.commissions, 1);
    assert.equal(counts.commission_lifecycle, 1);
    assert.equal(counts.commission_production, 1);
    assert.equal(counts.activation_events, 1);
  } finally {
    await dbA.pool.end();
    await dbB.pool.end();
  }
});

for (const stage of [
  "commission_inserted",
  "relationships_promoted",
  "production_initialized",
  "activation_event_created"
]) {
  test(`failure after ${stage} rolls back the entire B3+B4 transaction`, async () => {
    const fixture = await createCanonicalFixture();
    const handler = createPaymentHandler(db, {
      activationOptions: {
        afterStage(currentStage) {
          if (currentStage === stage) throw new Error(`Injected ${stage} failure`);
        }
      },
      errorReporter() {}
    });
    const response = await handler(createPaymentRequest(fixture.obligation.id));
    assert.equal(response.status, 500);
    const counts = await readCounts();
    assert.equal(counts.payments, 0);
    assert.equal(counts.payment_allocations, 0);
    assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "open");
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM documents WHERE document_type = 'receipt'")).rows[0].count, 0);
    assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM communications")).rows[0].count, 0);
    assert.equal(counts.commissions, 0);
    assert.equal(counts.commission_lifecycle, 0);
    assert.equal(counts.commission_production, 0);
    assert.equal(counts.activation_events, 0);
  });
}

test("an unrelated existing Commission for the source Quotation blocks activation and rolls back B3", async () => {
  const fixture = await createCanonicalFixture();
  await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price, source_quotation_id
     ) VALUES ('SAS-COM-2026-9998', $1, 'Conflict', 'Conflict', 'Oil', 400, $2)`,
    [fixture.client.id, fixture.quotation.id]
  );
  const response = await createPaymentHandler(db, { errorReporter() {} })(
    createPaymentRequest(fixture.obligation.id)
  );
  assert.equal(response.status, 500);
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM payments")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT obligation_status FROM commission_obligations")).rows[0].obligation_status, "open");
  assert.equal((await db.pool.query("SELECT count(*)::INTEGER AS count FROM commission_lifecycle")).rows[0].count, 0);
});
