import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { hashContractSnapshot } from "../../netlify/shared/contract-acceptance.mjs";
import {
  deriveDepositPaymentEligibility,
  ensureRequiredDepositObligationForContractAcceptance,
  requiredDepositPolicy,
  resolveRequiredDepositSource
} from "../../netlify/shared/precommission-deposit.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";

let database;
let db;
let sequence = 0;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

afterEach(async () => {
  await db.pool.query(
    "TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY"
  );
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

async function insertClient(label) {
  return (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ($1, $2) RETURNING id",
    [label, `${label.toLowerCase().replaceAll(" ", "-")}-${sequence}@example.invalid`]
  )).rows[0].id;
}

async function createFixture({
  contractStatus = "issued",
  contractAcceptanceHash = null,
  contractAcceptanceClient = null,
  expiresAt = "2026-11-01T16:00:00.000Z"
} = {}) {
  sequence += 1;
  const clientId = await insertClient("Deposit Client");
  const otherClientId = await insertClient("Other Client");
  const quotationNumber = `SAS-QUO-2026-${String(9000 + sequence).padStart(4, "0")}`;
  const quotationSnapshot = {
    snapshot_version: 2,
    quotation_number: quotationNumber,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: expiresAt,
    client: {
      client_id: String(clientId),
      full_name: "Deposit Client",
      email: `deposit-client-${sequence}@example.invalid`,
      phone: null
    },
    inquiry: null,
    artwork: {
      title: "Deposit Artwork",
      description: "Accepted scope",
      medium: "Oil",
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
       client_id, artwork_title, artwork_description, artwork_medium,
       artwork_width, artwork_height, snapshot_version, quotation_number,
       version, quotation_status, issued_at, accepted_at, expires_at,
       price, sales_tax_rate, sales_tax, shipping_charge,
       required_deposit_rate, required_deposit, quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, 'Deposit Artwork', 'Accepted scope', 'Oil', 20, 24, 2, $2,
       1, 'accepted', '2026-10-01T16:00:00Z', '2026-10-02T16:00:00Z', $3,
       400, .06, 24, 20, .50, 200, $4::jsonb, $5
     ) RETURNING *`,
    [clientId, quotationNumber, expiresAt, JSON.stringify(quotationSnapshot), quotationHash]
  )).rows[0];
  const quotationAcceptance = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, client_id, client_name_entered,
       client_email, accepted_at, acceptance_method, subject_number,
       subject_version, snapshot_hash, request_id
     ) VALUES (
       'quotation', $1, $2, 'Deposit Client', $3, '2026-10-02T16:00:00Z',
       'admin_recorded', $4, 1, $5, $6
     ) RETURNING *`,
    [quotation.id, clientId, quotationSnapshot.client.email, quotationNumber,
     quotationHash, randomUUID()]
  )).rows[0];
  const documentNumber = `SAS-CON-2026-${String(9000 + sequence).padStart(4, "0")}`;
  const contractSnapshot = {
    schema_version: 3,
    contract: {
      document_number: documentNumber,
      version: 1,
      status: contractStatus,
      terms_version: "approved-test-1",
      issued_at: contractStatus === "issued" ? "2026-10-03T16:00:00.000Z" : null
    },
    client: {
      client_id: String(clientId),
      full_name: "Deposit Client",
      email: quotationSnapshot.client.email
    },
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
    terms: {
      approved: true,
      terms_version: "approved-test-1",
      snapshot_hash: "a".repeat(64)
    }
  };
  const document = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, client_id, quotation_id, document_type,
       document_number, version, file_location, document_snapshot, request_id
     ) VALUES (NULL, $1, $2, 'contract', $3, 1, '/admin/contract.html', $4::jsonb, $5)
     RETURNING *`,
    [clientId, quotation.id, documentNumber, JSON.stringify(contractSnapshot), randomUUID()]
  )).rows[0];
  const contractAcceptance = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, document_id, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, terms_version, request_id
     ) VALUES (
       'contract', $1, $2, NULL, $3, 'Deposit Client', $4, NOW(),
       'admin_recorded', $5, 1, $6, 'approved-test-1', $7
     ) RETURNING *`,
    [document.id, quotation.id, contractAcceptanceClient === "other" ? otherClientId : clientId,
     quotationSnapshot.client.email, documentNumber,
     contractAcceptanceHash || hashContractSnapshot(contractSnapshot), randomUUID()]
  )).rows[0];

  return {
    clientId,
    otherClientId,
    quotation,
    quotationAcceptance,
    document,
    contractAcceptance,
    quotationSnapshot,
    contractSnapshot
  };
}

function directDepositValues(fixture, overrides = {}) {
  return [
    overrides.clientId ?? fixture.clientId,
    overrides.quotationId ?? fixture.quotation.id,
    overrides.documentId ?? fixture.document.id,
    overrides.acceptanceId ?? fixture.contractAcceptance.id,
    overrides.amount ?? "200.00",
    randomUUID()
  ];
}

async function insertDirectDeposit(fixture, overrides = {}) {
  return db.pool.query(
    `INSERT INTO commission_obligations (
       commission_id, client_id, quotation_id, contract_document_id,
       contract_acceptance_id, obligation_type, amount, source_type,
       source_id, request_id
     ) VALUES (NULL, $1, $2, $3, $4, 'deposit', $5,
       'contract_acceptance', $4::BIGINT::TEXT, $6)
     RETURNING *`,
    directDepositValues(fixture, overrides)
  );
}

test("migration adds nullable pre-Commission context FKs and the unique deposit source", async () => {
  const columns = new Map((await db.pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'commission_obligations'`
  )).rows.map((row) => [row.column_name, row]));
  assert.equal(columns.get("commission_id").is_nullable, "YES");
  for (const name of ["client_id", "quotation_id", "contract_document_id", "contract_acceptance_id"]) {
    assert.equal(columns.get(name).is_nullable, "YES", name);
  }
  const foreignKeys = (await db.pool.query(
    `SELECT constraint_name
     FROM information_schema.referential_constraints
     WHERE constraint_name LIKE 'commission_obligations_%_fkey'`
  )).rows.map((row) => row.constraint_name);
  for (const name of [
    "commission_obligations_client_id_fkey",
    "commission_obligations_quotation_id_fkey",
    "commission_obligations_contract_document_id_fkey",
    "commission_obligations_contract_acceptance_id_fkey"
  ]) assert.ok(foreignKeys.includes(name), name);
  const indexes = (await db.pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'commission_obligations'"
  )).rows.map((row) => row.indexname);
  assert.ok(indexes.includes("commission_obligations_contract_acceptance_deposit_unique"));
});

test("schema permits only a complete canonical pre-Commission deposit context", async () => {
  const fixture = await createFixture();
  const valid = (await insertDirectDeposit(fixture)).rows[0];
  assert.equal(valid.commission_id, null);
  assert.equal(valid.amount, "200.00");

  for (const column of ["client_id", "quotation_id", "contract_document_id", "contract_acceptance_id"]) {
    await assert.rejects(db.pool.query(
      `INSERT INTO commission_obligations (
         commission_id, client_id, quotation_id, contract_document_id,
         contract_acceptance_id, obligation_type, amount
       ) VALUES (NULL, $1, $2, $3, $4, 'deposit', 200)`,
      [
        column === "client_id" ? null : fixture.clientId,
        column === "quotation_id" ? null : fixture.quotation.id,
        column === "contract_document_id" ? null : fixture.document.id,
        column === "contract_acceptance_id" ? null : fixture.contractAcceptance.id
      ]
    ));
  }
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_obligations (commission_id, obligation_type, amount) VALUES (NULL, 'storage_fee', 10)"
  ));
});

test("legacy Commission obligations remain valid", async () => {
  const fixture = await createFixture();
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ($1, $2, 'Legacy', 'Legacy obligation', 'Oil', 400)
     RETURNING id`,
    [`SAS-COM-2026-${String(9000 + sequence).padStart(4, "0")}`, fixture.clientId]
  )).rows[0].id;
  const obligation = (await db.pool.query(
    `INSERT INTO commission_obligations (commission_id, obligation_type, amount)
     VALUES ($1, 'storage_fee', 10) RETURNING *`,
    [commissionId]
  )).rows[0];
  assert.equal(String(obligation.commission_id), String(commissionId));
});

test("database rejects mismatched provenance and a second deposit for one Acceptance", async () => {
  const fixture = await createFixture();
  const unrelated = await createFixture();
  await assert.rejects(insertDirectDeposit(fixture, { clientId: fixture.otherClientId }));
  await assert.rejects(insertDirectDeposit(fixture, { quotationId: unrelated.quotation.id }));
  await assert.rejects(insertDirectDeposit(fixture, { documentId: unrelated.document.id }));
  await assert.rejects(insertDirectDeposit(fixture, { amount: "199.99" }));
  await insertDirectDeposit(fixture);
  await assert.rejects(insertDirectDeposit(fixture));
});

test("helper derives amount from the immutable Quotation snapshot and creates no other records", async () => {
  const fixture = await createFixture();
  const result = await ensureRequiredDepositObligationForContractAcceptance(
    db,
    fixture.contractAcceptance.id,
    { amount: "1.00", now: () => new Date("2026-10-12T16:00:00Z") }
  );
  assert.equal(result.outcome, "success");
  assert.equal(result.obligation.amount, "200.00");
  assert.equal(result.obligation.outstanding_amount, "200.00");
  assert.equal(result.obligation.obligation_status, "open");
  assert.equal(result.obligation.allow_partial, false);
  assert.equal(result.obligation.deposit_payment_eligible, true);
  assert.equal((await db.pool.query(
    "SELECT due_at FROM commission_obligations WHERE id = $1",
    [result.obligation.id]
  )).rows[0].due_at, null);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM commissions")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM payments")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM communications")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM commission_events")).rows[0].count, 0);
});

test("helper rejects a mismatched Contract Acceptance and a draft Contract", async () => {
  let fixture = await createFixture({ contractAcceptanceHash: "b".repeat(64) });
  let result = await ensureRequiredDepositObligationForContractAcceptance(db, fixture.contractAcceptance.id);
  assert.equal(result.outcome, "contract_snapshot_mismatch");
  await db.pool.query(
    "TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY"
  );
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM clients");

  fixture = await createFixture({ contractStatus: "draft" });
  result = await ensureRequiredDepositObligationForContractAcceptance(db, fixture.contractAcceptance.id);
  assert.equal(result.outcome, "not_issued");
});

test("helper rejects Client relationship mismatches", async () => {
  const fixture = await createFixture({ contractAcceptanceClient: "other" });
  const source = await resolveRequiredDepositSource(db.pool, fixture.contractAcceptance.id);
  assert.equal(source.outcome, "contract_client_mismatch");
});

test("idempotent and concurrent creation yields exactly one obligation", async () => {
  const fixture = await createFixture();
  const [first, second] = await Promise.all([
    ensureRequiredDepositObligationForContractAcceptance(db, fixture.contractAcceptance.id),
    ensureRequiredDepositObligationForContractAcceptance(db, fixture.contractAcceptance.id)
  ]);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["idempotent", "success"]);
  const retry = await ensureRequiredDepositObligationForContractAcceptance(db, fixture.contractAcceptance.id);
  assert.equal(retry.outcome, "idempotent");
  assert.equal(String(first.obligation.id), String(second.obligation.id));
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations"
  )).rows[0].count, 1);
});

test("expiry changes payment eligibility without deleting the historical obligation", async () => {
  const fixture = await createFixture({ expiresAt: "2026-10-11T16:00:00.000Z" });
  const result = await ensureRequiredDepositObligationForContractAcceptance(
    db,
    fixture.contractAcceptance.id,
    { now: () => new Date("2026-10-12T16:00:00.000Z") }
  );
  assert.equal(result.outcome, "success");
  assert.equal(result.obligation.deposit_payment_eligible, false);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations"
  )).rows[0].count, 1);
});

test("required-deposit policy is full-payment-only and has no independent due date", async () => {
  assert.deepEqual(requiredDepositPolicy, {
    allow_partial: false,
    full_payment_only: true,
    deadline_source: "quotation.expires_at"
  });
  assert.equal(
    deriveDepositPaymentEligibility("2026-10-12T16:00:00Z", new Date("2026-10-12T16:00:00Z"))
      .deposit_payment_eligible,
    true
  );
  assert.equal(
    deriveDepositPaymentEligibility("2026-10-12T16:00:00Z", new Date("2026-10-12T16:00:00.001Z"))
      .deposit_payment_eligible,
    false
  );
});
