import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createHandler
} from "../../netlify/functions/admin-contracts.mjs";
import {
  hashContractSnapshot,
  resolveContractAcceptanceSource
} from "../../netlify/shared/contract-acceptance.mjs";
import { resolveAcceptedQuotationById } from "../../netlify/shared/contract-eligibility.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import { COMMISSION_AGREEMENT_TERMS } from "../../netlify/shared/contract-terms.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";

const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";
const fixedNow = new Date("2026-10-12T16:00:00.000Z");
const approvedTerms = {
  ...structuredClone(COMMISSION_AGREEMENT_TERMS),
  status: "approved-test-fixture",
  version: "approved-test-1",
  approved: true
};

let database;
let db;
let clientId;
let cookie;
let blockedHandler;
let approvedHandler;
let sequence = 0;

function handlerOptions(termsDefinition) {
  return {
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: adminPassword, ADMIN_SESSION_SECRET: sessionSecret }[name];
    },
    termsDefinition,
    now: () => fixedNow
  };
}

function request(url, options = {}) {
  return new Request(url, {
    method: options.method || "GET",
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function createAcceptedQuotation({ status = "accepted", acceptanceHash = null } = {}) {
  sequence += 1;
  const quotationNumber = `SAS-QUO-2026-${String(8000 + sequence).padStart(4, "0")}`;
  const snapshot = {
    snapshot_version: 2,
    quotation_number: quotationNumber,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: "2026-11-01T16:00:00.000Z",
    client: {
      client_id: String(clientId), full_name: "Pre-Commission Client",
      email: "precontract@example.invalid", phone: null
    },
    inquiry: null,
    artwork: {
      title: "Pre-Commission Portrait", description: "Portrait scope", medium: "Oil",
      dimensions: { width: "20.00", height: "24.00", unit: "in" }
    },
    commercial: {
      price: "400.00", sales_tax_rate: "0.0600", sales_tax: "24.00",
      shipping_charge: "20.00", required_deposit_rate: "0.5000",
      required_deposit: "200.00", total: "444.00",
      estimated_completion: "2027-02-15", special_terms: "Accepted term.",
      shipping_estimate: null
    }
  };
  const hash = hashQuotationSnapshot(snapshot);
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       client_id, artwork_title, artwork_description, artwork_medium,
       artwork_width, artwork_height, snapshot_version,
       quotation_number, version, quotation_status, issued_at, accepted_at,
       expires_at, price, sales_tax_rate, sales_tax, shipping_charge,
       estimated_completion, required_deposit_rate, required_deposit,
       special_terms, quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, 'Pre-Commission Portrait', 'Portrait scope', 'Oil', 20, 24, 2,
       $2, 1, $3, '2026-10-01T16:00:00Z', '2026-10-02T16:00:00Z',
       '2026-11-01T16:00:00Z', 400, .06, 24, 20,
       '2027-02-15', .50, 200, 'Accepted term.', $4::jsonb, $5
     ) RETURNING id`,
    [clientId, quotationNumber, status, JSON.stringify(snapshot), hash]
  )).rows[0];
  await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, request_id
     ) VALUES (
       'quotation', $1, NULL, $2, 'Pre-Commission Client',
       'precontract@example.invalid', '2026-10-02T16:00:00Z',
       'admin_recorded', $3, 1, $4, $5
     )`,
    [quotation.id, clientId, quotationNumber, acceptanceHash || hash, randomUUID()]
  );
  return { id: quotation.id, hash, quotationNumber, snapshot };
}

function issuePayload(quotationId) {
  return {
    request_id: randomUUID(), quotation_id: String(quotationId),
    subtype: "commission_agreement", contract_date: "2026-10-12",
    optional_message: "Review only", delivery_notes: "Pickup pending"
  };
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
  blockedHandler = createHandler(handlerOptions(COMMISSION_AGREEMENT_TERMS));
  approvedHandler = createHandler(handlerOptions(approvedTerms));
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    `INSERT INTO clients (full_name, email)
     VALUES ('Pre-Commission Client', 'precontract@example.invalid') RETURNING id`
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("canonical Contract context permits Client and Quotation without Commission", async () => {
  const quotation = await createAcceptedQuotation();
  const row = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, client_id, quotation_id, document_type,
       document_number, version, file_location, document_snapshot
     ) VALUES (NULL, $1, $2, 'contract', 'SAS-CON-2026-9001', 1,
       '/admin/contract.html', '{"contract":{"status":"issued"}}'::jsonb)
     RETURNING commission_id, client_id, quotation_id`,
    [clientId, quotation.id]
  )).rows[0];
  assert.equal(row.commission_id, null);
  assert.equal(String(row.quotation_id), String(quotation.id));
});

test("legacy Contract context remains valid and unrelated Documents stay strict", async () => {
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ('SAS-COM-2026-9001', $1, 'Legacy', 'Legacy', 'Oil', 1)
     RETURNING id`, [clientId]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version, file_location
     ) VALUES ($1, 'contract', 'SAS-CON-2026-9002', 1, '/legacy')`,
    [commissionId]
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO documents (
       document_type, document_number, version, file_location, document_snapshot
     ) VALUES ('contract', 'SAS-CON-2026-9003', 1, '/invalid', '{}'::jsonb)`
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO documents (
       document_type, document_number, version, file_location, document_snapshot
     ) VALUES ('invoice', 'SAS-INV-2026-9001', 1, '/invalid', '{"invoice":{}}'::jsonb)`
  ));
});

test("pre-Commission preparation produces Snapshot V3 without a fake Commission", async () => {
  const quotation = await createAcceptedQuotation();
  const response = await blockedHandler(request(
    `http://localhost/admin/api/contracts/prepare?quotation_id=${quotation.id}&contract_date=2026-10-12`
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.snapshot.schema_version, 3);
  assert.equal("commission" in body.snapshot, false);
  assert.equal(body.snapshot.quotation.quotation_id, String(quotation.id));
  assert.equal(body.snapshot.commercial.required_deposit, "200.00");
  assert.equal(body.snapshot.terms.approved, false);
  assert.match(body.snapshot.terms.snapshot_hash, /^[0-9a-f]{64}$/);
});

test("an in-window Acceptance remains eligible after the Quotation expiry date", async () => {
  const quotation = await createAcceptedQuotation();
  const result = await resolveAcceptedQuotationById(db, quotation.id, new Date("2027-01-01T16:00:00Z"));
  assert.equal(result.outcome, "eligible");
});

test("mismatched Acceptance hash and invalid quotation states block preparation", async () => {
  const mismatch = await createAcceptedQuotation({ acceptanceHash: "b".repeat(64) });
  let response = await blockedHandler(request(
    `http://localhost/admin/api/contracts/prepare?quotation_id=${mismatch.id}`
  ));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "acceptance_hash_mismatch");

  const withdrawn = await createAcceptedQuotation({ status: "withdrawn" });
  response = await blockedHandler(request(
    `http://localhost/admin/api/contracts/prepare?quotation_id=${withdrawn.id}`
  ));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "invalid_quotation_status");
});

test("unapproved terms permit preview but keep issuance locked", async () => {
  const quotation = await createAcceptedQuotation();
  const preview = await blockedHandler(request(
    `http://localhost/admin/api/contracts/prepare?quotation_id=${quotation.id}`
  ));
  assert.equal(preview.status, 200);
  const issued = await blockedHandler(request(
    "http://localhost/admin/api/documents/contracts",
    { method: "POST", body: issuePayload(quotation.id) }
  ));
  assert.equal(issued.status, 423);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'contract'"
  )).rows[0].count, 0);
});

test("approved fixture proves future issuance creates a pre-Commission Contract", async () => {
  const quotation = await createAcceptedQuotation();
  const response = await approvedHandler(request(
    "http://localhost/admin/api/documents/contracts",
    { method: "POST", body: issuePayload(quotation.id) }
  ));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.document.commission_id, null);
  assert.equal(String(body.document.client_id), String(clientId));
  assert.equal(String(body.document.quotation_id), String(quotation.id));
  assert.equal(body.document.document_snapshot.schema_version, 3);
});

test("canonical Contract Acceptance is append-only and unique per Document", async () => {
  const quotation = await createAcceptedQuotation();
  const issued = await approvedHandler(request(
    "http://localhost/admin/api/documents/contracts",
    { method: "POST", body: issuePayload(quotation.id) }
  ));
  const document = (await issued.json()).document;
  const source = await resolveContractAcceptanceSource(db, document.id);
  assert.equal(source.outcome, "eligible");
  const acceptance = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, document_id, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, terms_version, request_id
     ) VALUES (
       'contract', $1, $2, NULL, $3, 'Pre-Commission Client',
       'precontract@example.invalid', NOW(), 'admin_recorded',
       $4, $5, $6, $7, $8
     ) RETURNING id`,
    [document.id, quotation.id, clientId, document.document_number, document.version,
     source.snapshot_hash, source.terms_version, randomUUID()]
  )).rows[0];
  await assert.rejects(db.pool.query(
    "UPDATE acceptances SET client_name_entered = 'Changed' WHERE id = $1",
    [acceptance.id]
  ), /append-only/i);
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, document_id, quotation_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, terms_version, request_id
     ) VALUES ('contract', $1, $2, $3, 'Pre-Commission Client',
       'precontract@example.invalid', NOW(), 'admin_recorded', $4, $5, $6, $7, $8)`,
    [document.id, quotation.id, clientId, document.document_number, document.version,
     source.snapshot_hash, source.terms_version, randomUUID()]
  ));
});

test("issued Contract snapshot is immutable while future Commission linking is allowed once", async () => {
  const quotation = await createAcceptedQuotation();
  const document = (await (await approvedHandler(request(
    "http://localhost/admin/api/documents/contracts",
    { method: "POST", body: issuePayload(quotation.id) }
  ))).json()).document;
  await assert.rejects(db.pool.query(
    "UPDATE documents SET document_snapshot = '{}'::jsonb WHERE id = $1",
    [document.id]
  ), /immutable/i);
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price,
       source_quotation_id
     ) VALUES ('SAS-COM-2026-9002', $1, 'Activated', 'Activated', 'Oil', 400, $2)
     RETURNING id`,
    [clientId, quotation.id]
  )).rows[0].id;
  await db.pool.query("UPDATE documents SET commission_id = $1 WHERE id = $2", [commissionId, document.id]);
  await assert.rejects(db.pool.query(
    "UPDATE documents SET commission_id = NULL WHERE id = $1", [document.id]
  ), /immutable/i);
  assert.equal(hashContractSnapshot(document.document_snapshot).length, 64);
});
