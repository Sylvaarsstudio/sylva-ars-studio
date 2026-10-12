import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  buildContractSnapshot,
  config,
  contractNumberLockNamespace,
  createHandler,
  getCommissionContext,
  getNextContractVersion
} from "../../netlify/functions/admin-contracts.mjs";
import { COMMISSION_AGREEMENT_TERMS } from "../../netlify/shared/contract-terms.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";

const adminPassword = "local-admin-password";
const sessionSecret = "local-session-secret";
const prepareUrl = "http://localhost/admin/api/contracts/prepare";
const issueUrl = "http://localhost/admin/api/documents/contracts";
const fixedNow = new Date("2026-10-10T01:35:00.000Z");
const approvedTerms = {
  ...structuredClone(COMMISSION_AGREEMENT_TERMS),
  status: "approved-test-fixture",
  version: "approved-test-1",
  approved: true
};

let database;
let db;
let sessionCookie;
let blockedHandler;
let approvedHandler;
let clientId;
let commissions;

async function addAcceptedQuotation(commissionId, sequence) {
  const quotationNumber = `SAS-QUO-2026-${String(7000 + sequence).padStart(4, "0")}`;
  const snapshot = {
    quotation_number: quotationNumber,
    version: 1,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: "2026-11-01T16:00:00.000Z",
    client: {
      client_id: String(clientId), full_name: "Contract Client",
      email: "contract@example.invalid", phone: "555-0100"
    },
    commission: {
      commission_id: String(commissionId),
      commission_number: `SAS-COM-2026-${String(sequence + 2001).padStart(4, "0")}`,
      title: `${sequence === 1 ? "quoted" : "approved"} Commission`,
      description: "Persistent contract test", medium: "Oil",
      dimensions: { width: "20.00", height: "24.00", unit: "in" }
    },
    commercial: {
      price: "400.00", sales_tax_rate: "0.0600", sales_tax: "24.00",
      shipping_charge: "20.00", required_deposit_rate: "0.5000",
      required_deposit: "200.00", total: "444.00",
      estimated_completion: "2027-02-15", special_terms: "Accepted studio term."
    }
  };
  const hash = hashQuotationSnapshot(snapshot);
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, quotation_number, version, quotation_status,
       issued_at, accepted_at, expires_at, price, sales_tax_rate,
       sales_tax, shipping_charge, estimated_completion,
       required_deposit_rate, required_deposit, special_terms,
       quotation_snapshot, snapshot_hash
     ) VALUES ($1, $2, 1, 'accepted', '2026-10-01T16:00:00Z',
       '2026-10-02T16:00:00Z', '2026-11-01T16:00:00Z', 400, .06,
       24, 20, '2027-02-15', .50, 200, 'Accepted studio term.', $3::jsonb, $4)
     RETURNING id`,
    [commissionId, quotationNumber, JSON.stringify(snapshot), hash]
  )).rows[0];
  await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, request_id
     ) VALUES ('quotation', $1, $2, $3, 'Contract Client',
       'contract@example.invalid', '2026-10-02T16:00:00Z', 'admin_recorded',
       $4, 1, $5, $6)`,
    [quotation.id, commissionId, clientId, quotationNumber, hash, randomUUID()]
  );
  return quotation.id;
}

function options(termsDefinition) {
  return {
    databaseFactory: () => db,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: adminPassword,
        ADMIN_SESSION_SECRET: sessionSecret
      }[name];
    },
    termsDefinition,
    now: () => fixedNow
  };
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
  blockedHandler = createHandler(options(COMMISSION_AGREEMENT_TERMS));
  approvedHandler = createHandler(options(approvedTerms));
});

beforeEach(async () => {
  clientId = (await db.pool.query(`
    INSERT INTO clients (
      full_name, email, phone, address_line_1, city, state, postal_code, country
    ) VALUES (
      'Contract Client', 'contract@example.invalid', '555-0100',
      '10 Studio Lane', 'York', 'PA', '17402', 'United States'
    ) RETURNING id
  `)).rows[0].id;
  commissions = {};

  for (const status of ["draft", "quoted", "approved", "in_progress", "completed", "cancelled"]) {
    commissions[status] = (await db.pool.query(`
      INSERT INTO commissions (
        commission_number, client_id, title, description, medium,
        width, height, price, deposit_amount, amount_paid, sales_tax,
        shipping, status, estimated_completion
      ) VALUES (
        $1, $2, $3, 'Persistent contract test', 'Oil',
        20, 24, 400, 75, 75, 24, 20, $4, '2027-02-15'
      ) RETURNING id
    `, [`SAS-COM-2026-${String(Object.keys(commissions).length + 2001).padStart(4, "0")}`, clientId, `${status} Commission`, status])).rows[0].id;
  }
  await addAcceptedQuotation(commissions.quoted, 1);
  await addAcceptedQuotation(commissions.approved, 2);
});

afterEach(async () => {
  await db?.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db?.pool.query("DELETE FROM documents");
  await db?.pool.query("DELETE FROM quotations");
  await db?.pool.query("DELETE FROM payments");
  await db?.pool.query("DELETE FROM commissions");
  await db?.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function authenticatedRequest(url, options = {}) {
  return new Request(url, {
    method: options.method || "GET",
    headers: {
      Cookie: sessionCookie,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

function prepare(status, query = "") {
  return blockedHandler(authenticatedRequest(
    `${prepareUrl}?commission_id=${commissions[status]}${query}`
  ));
}

function issuePayload(status = "quoted", overrides = {}) {
  return {
    request_id: randomUUID(),
    commission_id: String(commissions[status]),
    subtype: "commission_agreement",
    contract_date: "2026-10-09",
    optional_message: "Prepared for review",
    delivery_notes: "Pickup details pending",
    ...overrides
  };
}

function issue(handler, data) {
  return handler(authenticatedRequest(issueUrl, { method: "POST", body: data }));
}

async function documentCount() {
  return (await db.pool.query(
    "SELECT count(*)::integer AS count FROM documents WHERE document_type = 'contract'"
  )).rows[0].count;
}

test("contract routes use valid protected paths", () => {
  assert.deepEqual(config.path, [
    "/admin/api/contracts/prepare",
    "/admin/api/contracts/eligibility",
    "/admin/api/documents/contracts"
  ]);
});

test("quoted commission can be prepared", async () => {
  assert.equal((await prepare("quoted")).status, 200);
});

test("approved commission can be prepared", async () => {
  assert.equal((await prepare("approved")).status, 200);
});

for (const status of ["draft", "in_progress", "completed", "cancelled"]) {
  test(`${status} commission cannot be prepared`, async () => {
    const response = await prepare(status);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "no_accepted_quotation");
  });
}

test("prepare reads client and commission data from the database", async () => {
  const body = await (await prepare("quoted")).json();
  assert.equal(body.snapshot.client.full_name, "Contract Client");
  assert.equal(body.snapshot.artwork.title, "quoted Commission");
  assert.equal(body.snapshot.artwork.medium, "Oil");
});

test("browser cannot override protected contract data", async () => {
  const response = await issue(approvedHandler, issuePayload("quoted", {
    price: "0.01",
    sales_tax: "0.00",
    client_name: "Browser Override"
  }));
  assert.equal(response.status, 400);
  assert.equal(await documentCount(), 0);
});

test("financial derivation uses 50 percent of price and persisted tax and shipping", async () => {
  const financial = (await (await prepare("quoted")).json()).snapshot.commercial_terms;
  assert.deepEqual(financial, {
    price: "400.00",
    sales_tax_rate: "0.0600",
    sales_tax: "24.00",
    shipping_charge: "20.00",
    required_deposit_rate: "0.5000",
    required_deposit: "200.00",
    total: "444.00",
    estimated_remaining_after_required_deposit: "244.00",
    estimated_completion: "2027-02-15",
    special_terms: "Accepted studio term."
  });
});

test("deposit_amount is not used as required deposit", async () => {
  const snapshot = (await (await prepare("quoted")).json()).snapshot;
  assert.equal(snapshot.commercial_terms.required_deposit, "200.00");
  assert.equal(snapshot.commercial_terms.required_deposit === "75.00", false);
});

test("default contract date uses America/New_York without UTC rollover", async () => {
  const body = await (await prepare("quoted")).json();
  assert.equal(body.snapshot.contract.contract_date, "2026-10-09");
});

test("draft snapshot is not issued and has no contract number", async () => {
  const body = await (await prepare("quoted")).json();
  assert.equal(body.snapshot.contract.status, "draft");
  assert.equal(body.snapshot.contract.document_number, null);
  assert.equal(body.snapshot.contract.version, null);
  assert.equal(body.snapshot.contract.subtype, "commission_agreement");
});

test("production contract terms remain unapproved", () => {
  assert.equal(COMMISSION_AGREEMENT_TERMS.status, "draft");
  assert.equal(COMMISSION_AGREEMENT_TERMS.approved, false);
});

test("blocked POST returns 423 and inserts no contract", async () => {
  const response = await issue(blockedHandler, issuePayload());
  assert.equal(response.status, 423);
  assert.match((await response.json()).message, /terms are still under review/i);
  assert.equal(await documentCount(), 0);
});

test("blocked POST does not consume a contract number", async () => {
  await issue(blockedHandler, issuePayload());
  const response = await issue(approvedHandler, issuePayload());
  const body = await response.json();
  assert.equal(body.document.document_number, "SAS-CON-2026-0001");
});

test("approved test fixture exercises future creation infrastructure", async () => {
  const response = await issue(approvedHandler, issuePayload());
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.document.document_snapshot.contract.status, "issued");
  assert.ok(body.document.quotation_id);
  assert.equal(
    String(body.document.quotation_id),
    body.document.document_snapshot.quotation.quotation_id
  );
  assert.match(body.document.file_location, /^\/admin\/contract\.html\?document=/);
});

test("contract numbering format and namespace are independent", async () => {
  const paymentId = (await db.pool.query(
    `INSERT INTO payments (
       commission_id, payment_type, amount, payment_date, status
     ) VALUES ($1, 'deposit', 1, '2026-10-09', 'completed')
     RETURNING id`,
    [commissions.quoted]
  )).rows[0].id;
  await db.pool.query(`
    INSERT INTO documents (
      commission_id, payment_id, document_type, document_number, version,
      file_location, receipt_snapshot, document_snapshot
    )
    VALUES
      ($1, NULL, 'invoice', 'SAS-INV-2026-9999', 1, '/invoice', NULL, '{"invoice":{}}'::jsonb),
      ($1, $2, 'receipt', 'SAS-REC-2026-9999', 1, '/receipt', '{}'::jsonb, NULL)
  `, [commissions.quoted, paymentId]);
  const body = await (await issue(approvedHandler, issuePayload())).json();
  assert.equal(body.document.document_number, "SAS-CON-2026-0001");
  assert.equal(contractNumberLockNamespace === 20260910, false);
});

test("concurrent contract creation produces distinct stable numbers", async () => {
  const [first, second] = await Promise.all([
    issue(approvedHandler, issuePayload("quoted")),
    issue(approvedHandler, issuePayload("approved"))
  ]);
  const bodies = await Promise.all([first.json(), second.json()]);
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.deepEqual(
    bodies.map((body) => body.document.document_number).sort(),
    ["SAS-CON-2026-0001", "SAS-CON-2026-0002"]
  );
});

test("versioning helper preserves family progression", () => {
  assert.equal(getNextContractVersion(undefined), 1);
  assert.equal(getNextContractVersion(1), 2);
  assert.equal(getNextContractVersion(2), 3);
});

test("version snapshot keeps its number, increments version, and supersedes explicitly", async () => {
  const commission = await getCommissionContext(db, commissions.quoted);
  const first = buildContractSnapshot({
    commission,
    contractDate: "2026-10-09",
    terms: approvedTerms,
    number: "SAS-CON-2026-0001",
    version: 1,
    issuedAt: "2026-10-09T16:00:00.000Z",
    status: "issued"
  });
  const firstBeforeVersioning = structuredClone(first);
  const second = buildContractSnapshot({
    commission,
    contractDate: "2026-10-09",
    terms: approvedTerms,
    number: first.contract.number,
    version: getNextContractVersion(first.contract.version),
    issuedAt: "2026-10-09T17:00:00.000Z",
    supersedesDocumentId: 42,
    status: "issued"
  });

  assert.equal(second.contract.number, first.contract.number);
  assert.equal(second.contract.version, 2);
  assert.equal(second.contract.supersedes_document_id, 42);
  assert.deepEqual(first, firstBeforeVersioning);
});

test("stored contract snapshot remains immutable after source edits", async () => {
  const body = await (await issue(approvedHandler, issuePayload())).json();
  const before = body.document.document_snapshot;
  await db.pool.query("UPDATE clients SET full_name = 'Changed Client' WHERE id = $1", [clientId]);
  await db.pool.query("UPDATE commissions SET price = 999 WHERE id = $1", [commissions.quoted]);
  const after = (await db.pool.query(
    "SELECT document_snapshot FROM documents WHERE id = $1",
    [body.document.id]
  )).rows[0].document_snapshot;
  assert.deepEqual(after, before);
});

test("same request_id is idempotent", async () => {
  const data = issuePayload();
  const first = await issue(approvedHandler, data);
  const second = await issue(approvedHandler, data);
  const bodies = await Promise.all([first.json(), second.json()]);
  assert.deepEqual([first.status, second.status], [201, 200]);
  assert.equal(String(bodies[0].document.id), String(bodies[1].document.id));
  assert.equal(await documentCount(), 1);
});

test("same request_id with different intent returns conflict", async () => {
  const data = issuePayload("quoted");
  await issue(approvedHandler, data);
  const response = await issue(approvedHandler, {
    ...issuePayload("approved"),
    request_id: data.request_id
  });
  assert.equal(response.status, 409);
  assert.equal(await documentCount(), 1);
});

test("same request_id with changed contract fields returns conflict", async () => {
  const data = issuePayload("quoted");
  await issue(approvedHandler, data);
  const response = await issue(approvedHandler, {
    ...data,
    optional_message: "Different contract intent"
  });
  assert.equal(response.status, 409);
  assert.equal(await documentCount(), 1);
});

test("duplicate contract family is rejected", async () => {
  await issue(approvedHandler, issuePayload());
  const response = await issue(approvedHandler, issuePayload());
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /already exists/i);
  assert.equal(await documentCount(), 1);
});

test("unauthenticated preparation is rejected", async () => {
  const response = await blockedHandler(new Request(
    `${prepareUrl}?commission_id=${commissions.quoted}`
  ));
  assert.equal(response.status, 401);
});
