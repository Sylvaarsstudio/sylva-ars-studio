import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-contracts.mjs";
import { COMMISSION_AGREEMENT_TERMS } from "../../netlify/shared/contract-terms.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";

const password = "phase5-admin";
const secret = "phase5-secret";
const fixedNow = new Date("2026-10-11T16:00:00.000Z");
let database;
let db;
let handler;
let cookie;
let clientId;
let otherClientId;
let commissionId;
let otherCommissionId;
let sequence = 0;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret })[name],
    now: () => new Date(fixedNow)
  });
});

beforeEach(async () => {
  sequence += 1;
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email, phone) VALUES ('Phase Five Client', 'phase5@example.invalid', '555-0150') RETURNING id"
  )).rows[0].id;
  otherClientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Other Client', 'other-phase5@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = await insertCommission(clientId, 8000 + sequence, "draft");
  otherCommissionId = await insertCommission(otherClientId, 9000 + sequence, "approved");
});

afterEach(async () => {
  await db.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

async function insertCommission(ownerId, number, status) {
  return (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       width, height, price, sales_tax, shipping, status, estimated_completion
     ) VALUES ($1, $2, 'Live Title', 'Live Description', 'Oil', 30, 40,
       999, 99, 88, $3, '2030-01-01') RETURNING id`,
    [`SAS-COM-2026-${number}`, ownerId, status]
  )).rows[0].id;
}

function quotationSnapshot(id = commissionId, overrides = {}) {
  return {
    quotation_number: `SAS-QUO-2026-${String(6000 + sequence).padStart(4, "0")}`,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: "2026-11-01T16:00:00.000Z",
    client: {
      client_id: String(clientId), full_name: "Phase Five Client",
      email: "phase5@example.invalid", phone: "555-0150"
    },
    commission: {
      commission_id: String(id), commission_number: `SAS-COM-2026-${8000 + sequence}`,
      title: "Accepted Title", description: "Accepted Description", medium: "Watercolor",
      dimensions: { width: "18.00", height: "24.00", unit: "in" }
    },
    commercial: {
      price: "400.00", sales_tax_rate: "0.0700", sales_tax: "28.00",
      shipping_charge: "25.00", required_deposit_rate: "0.5000",
      required_deposit: "200.00", total: "453.00",
      estimated_completion: "2027-04-15", special_terms: "Accepted special terms."
    },
    ...overrides
  };
}

async function insertQuotation({
  status = "accepted",
  withAcceptance = true,
  expiresAt = "2026-11-01T16:00:00Z",
  snapshot = quotationSnapshot(),
  storedHash = null,
  acceptanceHash = null,
  acceptanceClientId = clientId,
  acceptanceCommissionId = commissionId,
  quotationNumber = null
} = {}) {
  const number = quotationNumber || snapshot.quotation_number;
  const hash = storedHash || hashQuotationSnapshot(snapshot);
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, quotation_number, version, quotation_status,
       issued_at, accepted_at, expires_at, price, sales_tax_rate,
       sales_tax, shipping_charge, estimated_completion,
       required_deposit_rate, required_deposit, special_terms,
       quotation_snapshot, snapshot_hash
     ) VALUES ($1, $2, 1, $3, '2026-10-01T16:00:00Z',
       $4, $5, 400, .07, 28, 25, '2027-04-15', .50, 200,
       'Accepted special terms.', $6::jsonb, $7) RETURNING id`,
    [commissionId, number, status, status === "accepted" ? "2026-10-02T16:00:00Z" : null,
     expiresAt, JSON.stringify(snapshot), hash]
  )).rows[0];
  if (withAcceptance) {
    await db.pool.query(
      `INSERT INTO acceptances (
         acceptance_type, quotation_id, commission_id, client_id,
         client_name_entered, client_email, accepted_at, acceptance_method,
         subject_number, subject_version, snapshot_hash, request_id
       ) VALUES ('quotation', $1, $2, $3, 'Phase Five Client',
         'phase5@example.invalid', '2026-10-02T16:00:00Z', 'admin_recorded',
         $4, 1, $5, $6)`,
      [quotation.id, acceptanceCommissionId, acceptanceClientId, number,
       acceptanceHash || hash, randomUUID()]
    );
  }
  return quotation.id;
}

function request(path) {
  return handler(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }));
}

function prepare() {
  return request(`/admin/api/contracts/prepare?commission_id=${commissionId}&contract_date=2026-10-11`);
}

test("valid accepted quotation prepares the canonical contract snapshot", async () => {
  const quotationId = await insertQuotation();
  const response = await prepare();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.issuance_enabled, false);
  assert.equal(body.snapshot.schema_version, 2);
  assert.equal(body.snapshot.quotation.quotation_id, String(quotationId));
  assert.equal(body.snapshot.quotation.quotation_number, quotationSnapshot().quotation_number);
  assert.equal(body.snapshot.quotation.quotation_version, 1);
  assert.equal(body.snapshot.quotation.quotation_acceptance_id.length > 0, true);
  assert.equal(body.snapshot.contract.status, "draft");
  assert.equal(body.snapshot.contract.document_number, null);
  assert.equal(body.snapshot.client.client_id, String(clientId));
  assert.equal(body.snapshot.commission.commission_id, String(commissionId));
  assert.equal(body.snapshot.commission.commission_number, quotationSnapshot().commission.commission_number);
});

test("commercial artwork and client data come only from the accepted quotation", async () => {
  await insertQuotation();
  const snapshot = (await (await prepare()).json()).snapshot;
  assert.equal(snapshot.client.full_name, "Phase Five Client");
  assert.equal(snapshot.artwork.title, "Accepted Title");
  assert.equal(snapshot.artwork.medium, "Watercolor");
  assert.equal(snapshot.commercial_terms.price, "400.00");
  assert.equal(snapshot.commercial_terms.sales_tax_rate, "0.0700");
  assert.equal(snapshot.commercial_terms.sales_tax, "28.00");
  assert.equal(snapshot.commercial_terms.shipping_charge, "25.00");
  assert.equal(snapshot.commercial_terms.required_deposit, "200.00");
  assert.equal(snapshot.commercial_terms.estimated_completion, "2027-04-15");
  assert.equal(snapshot.commercial_terms.special_terms, "Accepted special terms.");
});

test("live Commission and Client edits do not change the prepared draft", async () => {
  await insertQuotation();
  const before = (await (await prepare()).json()).snapshot;
  await db.pool.query(
    "UPDATE commissions SET title = 'Changed', price = 1, sales_tax = 0, shipping = 0, estimated_completion = '2040-01-01' WHERE id = $1",
    [commissionId]
  );
  await db.pool.query("UPDATE clients SET full_name = 'Changed Client', email = 'changed@example.invalid' WHERE id = $1", [clientId]);
  const afterSnapshot = (await (await prepare()).json()).snapshot;
  assert.deepEqual(afterSnapshot, before);
});

test("legacy Commission status is not Contract eligibility authority", async () => {
  await insertQuotation();
  const response = await prepare();
  assert.equal(response.status, 200);
  assert.equal((await db.pool.query("SELECT status FROM commissions WHERE id = $1", [commissionId])).rows[0].status, "draft");
});

test("no quotation blocks preparation", async () => {
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "no_accepted_quotation");
});

for (const status of ["draft", "issued", "sent"]) {
  test(`${status} quotation without Acceptance blocks preparation`, async () => {
    await insertQuotation({ status, withAcceptance: false });
    const response = await prepare();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "no_accepted_quotation");
  });
}

test("accepted status without Acceptance blocks preparation", async () => {
  await insertQuotation({ withAcceptance: false });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "missing_acceptance");
});

test("accepted quotation past expires_at blocks preparation", async () => {
  await insertQuotation({ expiresAt: "2026-10-10T16:00:00Z" });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "expired");
});

for (const status of ["withdrawn", "superseded"] ) {
  test(`${status} quotation with Acceptance blocks preparation`, async () => {
    await insertQuotation({ status });
    const response = await prepare();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "invalid_quotation_status");
  });
}

test("quotation snapshot hash mismatch blocks preparation", async () => {
  await insertQuotation({ storedHash: "0".repeat(64), acceptanceHash: "0".repeat(64) });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "quotation_hash_mismatch");
});

test("Acceptance hash mismatch blocks preparation", async () => {
  await insertQuotation({ acceptanceHash: "f".repeat(64) });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "acceptance_hash_mismatch");
});

test("Acceptance client mismatch blocks preparation", async () => {
  await insertQuotation({ acceptanceClientId: otherClientId });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "acceptance_relationship_mismatch");
});

test("Acceptance commission mismatch blocks preparation", async () => {
  await insertQuotation({ acceptanceCommissionId: otherCommissionId });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "acceptance_relationship_mismatch");
});

test("multiple accepted quotations block instead of choosing latest", async () => {
  await insertQuotation();
  const secondSnapshot = quotationSnapshot(commissionId);
  secondSnapshot.quotation_number = `SAS-QUO-2026-${String(7000 + sequence).padStart(4, "0")}`;
  await insertQuotation({ snapshot: secondSnapshot, quotationNumber: secondSnapshot.quotation_number });
  const response = await prepare();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "ambiguous_accepted_quotation");
});

test("eligibility endpoint exposes only canonical source metadata", async () => {
  await insertQuotation();
  const response = await request(`/admin/api/contracts/eligibility?commission_id=${commissionId}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.eligible, true);
  assert.equal(body.quotation.quotation_number, quotationSnapshot().quotation_number);
  assert.equal(Object.hasOwn(body, "snapshot"), false);
});

test("Contract issuance remains locked and creates no Document", async () => {
  await insertQuotation();
  const response = await handler(new Request("http://localhost/admin/api/documents/contracts", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({})
  }));
  assert.equal(response.status, 423);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM documents WHERE document_type = 'contract'")).rows[0].count, 0);
});
