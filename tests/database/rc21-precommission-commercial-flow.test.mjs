import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler as createAcceptanceHandler } from "../../netlify/functions/admin-acceptances.mjs";
import { createHandler as createClientHandler } from "../../netlify/functions/admin-clients.mjs";
import { createHandler as createCommissionHandler } from "../../netlify/functions/admin-commissions.mjs";
import {
  createCommissionFromQuotation,
  createHandler as createQuotationHandler
} from "../../netlify/functions/admin-quotations.mjs";
import { resolveAcceptedQuotation } from "../../netlify/shared/contract-eligibility.mjs";
import { readCommissionNextAction } from "../../netlify/shared/commission-next-action.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const issuedNow = new Date("2026-10-12T14:00:00.000Z");
const acceptedNow = new Date("2026-10-12T15:00:00.000Z");
let database;
let db;
let db2;
let cookie;
let clients;
let quotations;
let quotations2;
let acceptances;
let commissions;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  db2 = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  const auth = {
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret })[name]
  };
  clients = createClientHandler(auth);
  quotations = createQuotationHandler({ ...auth, now: () => new Date(issuedNow) });
  quotations2 = createQuotationHandler({
    databaseFactory: () => db2,
    environmentReader: auth.environmentReader,
    now: () => new Date(issuedNow)
  });
  acceptances = createAcceptanceHandler({
    ...auth,
    now: () => new Date(acceptedNow),
    emailProvider: {
      isConfigured: () => false,
      async sendEmail() { throw Object.assign(new Error("not configured"), { code: "provider_not_configured" }); }
    }
  });
  commissions = createCommissionHandler(auth);
});

beforeEach(async () => {
  await db.pool.query("DELETE FROM communications");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commission_inquiries");
  await db.pool.query("DELETE FROM commissions WHERE source_quotation_id IS NOT NULL");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM inquiries");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await db2?.pool.end();
  await database?.stop();
});

function invoke(handler, path, method = "GET", body) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }));
}

async function createClient(overrides = {}) {
  const response = await invoke(clients, "/admin/api/clients", "POST", {
    full_name: "Precommission Client",
    email: "precommission@example.invalid",
    phone: null,
    address_line_1: null,
    address_line_2: null,
    city: null,
    state: null,
    postal_code: null,
    country: null,
    ...overrides
  });
  return { response, body: await response.json() };
}

function quotationBody(overrides = {}) {
  return {
    artwork_title: "Precommission Portrait",
    artwork_description: "A canonical pre-Commission scope.",
    artwork_medium: "Oil",
    artwork_width: 20,
    artwork_height: 24,
    price: "400.00",
    sales_tax_rate: "0.06",
    shipping_charge: "20.00",
    estimated_completion: "2027-01-15",
    special_terms: "Studio-approved scope only.",
    shipping_estimate_snapshot: null,
    request_id: randomUUID(),
    inquiry_id: null,
    ...overrides
  };
}

test("RC2.1 schema makes Quotation Client-owned and preserves nullable legacy links", async () => {
  const columns = await db.pool.query(
    `SELECT table_name, column_name, is_nullable
     FROM information_schema.columns
     WHERE (table_name = 'quotations' AND column_name IN ('commission_id', 'client_id', 'inquiry_id', 'snapshot_version'))
        OR (table_name = 'documents' AND column_name IN ('commission_id', 'client_id'))
        OR (table_name = 'acceptances' AND column_name = 'commission_id')
        OR (table_name = 'commissions' AND column_name = 'source_quotation_id')`
  );
  const nullable = Object.fromEntries(columns.rows.map((row) => [
    `${row.table_name}.${row.column_name}`,
    row.is_nullable
  ]));
  assert.equal(nullable["quotations.commission_id"], "YES");
  assert.equal(nullable["quotations.client_id"], "NO");
  assert.equal(nullable["quotations.inquiry_id"], "YES");
  assert.equal(nullable["documents.commission_id"], "YES");
  assert.equal(nullable["documents.client_id"], "YES");
  assert.equal(nullable["acceptances.commission_id"], "YES");
  assert.equal(nullable["commissions.source_quotation_id"], "YES");
});

async function createIssuedAcceptedQuotation(clientId, overrides = {}) {
  const draftResponse = await invoke(
    quotations,
    `/admin/api/clients/${clientId}/quotations`,
    "POST",
    quotationBody(overrides)
  );
  assert.equal(draftResponse.status, 201);
  const draft = (await draftResponse.json()).quotation;
  const issuedResponse = await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  assert.equal(issuedResponse.status, 201);
  const issued = (await issuedResponse.json()).quotation;
  const acceptanceResponse = await invoke(acceptances, `/admin/api/quotations/${issued.id}/accept`, "POST", {
    request_id: randomUUID(),
    acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client",
    client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  assert.equal(acceptanceResponse.status, 201);
  return { quotation: (await invoke(quotations, `/admin/api/quotations/${issued.id}`)).json(), issued };
}

test("manual Client creation works without an Inquiry and normalizes duplicate email", async () => {
  const first = await createClient();
  assert.equal(first.response.status, 201);
  assert.equal(first.body.client.email, "precommission@example.invalid");
  const duplicate = await createClient({ email: "PRECOMMISSION@example.invalid" });
  assert.equal(duplicate.response.status, 409);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM inquiries")).rows[0].count), 0);
});

test("pre-Commission Quotation V2 issues a Client-linked document and accepts without Commission", async () => {
  const { body } = await createClient();
  const clientId = body.client.id;
  const draftResponse = await invoke(quotations, `/admin/api/clients/${clientId}/quotations`, "POST", quotationBody());
  const draft = (await draftResponse.json()).quotation;
  assert.equal(draftResponse.status, 201);
  assert.equal(draft.commission_id, null);
  assert.equal(Number(draft.snapshot_version), 2);
  const issuedResponse = await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  const issued = (await issuedResponse.json()).quotation;
  assert.equal(issued.quotation_snapshot.snapshot_version, 2);
  assert.equal(issued.quotation_snapshot.commission, undefined);
  assert.equal(issued.quotation_snapshot.artwork.title, "Precommission Portrait");
  const document = (await db.pool.query("SELECT * FROM documents WHERE quotation_id = $1", [draft.id])).rows[0];
  assert.equal(document.commission_id, null);
  assert.equal(String(document.client_id), String(clientId));
  const accepted = await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).acceptance.commission_id, null);
});

test("unaccepted Quotation cannot create a Commission and direct Admin creation is blocked", async () => {
  const { body } = await createClient();
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody())).json()).quotation;
  assert.equal((await invoke(quotations, `/admin/api/quotations/${draft.id}/create-commission`, "POST")).status, 409);
  assert.equal((await invoke(commissions, "/admin/api/commissions", "POST", {})).status, 409);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commissions")).rows[0].count), 0);
});

test("legacy records remain valid without fabricated source or Inquiry relationships", async () => {
  const { body } = await createClient();
  const commission = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ('SAS-COM-2026-9900', $1, 'Legacy Work', 'Historical record', 'Oil', 300)
     RETURNING id, source_quotation_id`,
    [body.client.id]
  )).rows[0];
  await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       snapshot_version, quotation_number, version, price, sales_tax_rate,
       sales_tax, shipping_charge, required_deposit
     ) VALUES ($1, $2, 'Legacy Work', 'Historical record', 'Oil', 1,
       'SAS-QUO-2026-9900', 1, 300, 0.06, 18, 0, 150)`,
    [commission.id, body.client.id]
  );

  assert.equal(commission.source_quotation_id, null);
  assert.equal(Number((await db.pool.query(
    "SELECT count(*) FROM commission_inquiries WHERE commission_id = $1",
    [commission.id]
  )).rows[0].count), 0);
});

test("accepted Quotation creates exactly one canonical Commission with Production and no fake Inquiry", async () => {
  const { body } = await createClient();
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody())).json()).quotation;
  await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  const conversion = await invoke(quotations, `/admin/api/quotations/${draft.id}/create-commission`, "POST");
  assert.equal(conversion.status, 201);
  const commission = (await conversion.json()).commission;
  assert.equal(String(commission.source_quotation_id), String(draft.id));
  assert.equal((await db.pool.query("SELECT production_status FROM commission_production WHERE commission_id = $1", [commission.id])).rows[0].production_status, "not_started");
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commission_inquiries WHERE commission_id = $1", [commission.id])).rows[0].count), 0);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM inquiries")).rows[0].count), 0);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commission_events WHERE commission_id = $1 AND event_type = 'commission_created_from_quotation'", [commission.id])).rows[0].count), 1);
  const linkedQuotations = await invoke(
    quotations,
    `/admin/api/commissions/${commission.id}/quotations`
  );
  assert.deepEqual(
    (await linkedQuotations.json()).quotations.map((item) => String(item.id)),
    [String(draft.id)]
  );
  const eligibility = await resolveAcceptedQuotation(db, commission.id, acceptedNow);
  assert.equal(eligibility.outcome, "eligible");
  const nextAction = await readCommissionNextAction(db, commission.id, { now: acceptedNow });
  assert.equal(nextAction.code, "prepare_contract");
  assert.equal(nextAction.blocking_reason, "contract_terms_under_review");
});

test("conversion helper preserves the same atomic production path", async () => {
  const { body } = await createClient();
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody())).json()).quotation;
  await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  const result = await createCommissionFromQuotation(db, draft.id, () => new Date(acceptedNow));
  assert.equal(result.outcome, "success");
});

test("concurrent accepted-Quotation conversion creates one Commission", async () => {
  const { body } = await createClient();
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody())).json()).quotation;
  await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  const [left, right] = await Promise.all([
    invoke(quotations, `/admin/api/quotations/${draft.id}/create-commission`, "POST"),
    invoke(quotations2, `/admin/api/quotations/${draft.id}/create-commission`, "POST")
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commissions WHERE source_quotation_id = $1", [draft.id])).rows[0].count), 1);
});

test("concurrent conversion helpers preserve one source-Quotation Commission", async () => {
  const { body } = await createClient();
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody())).json()).quotation;
  await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  const settled = await Promise.allSettled([
    createCommissionFromQuotation(db, draft.id, () => new Date(acceptedNow)),
    createCommissionFromQuotation(db2, draft.id, () => new Date(acceptedNow))
  ]);
  const failure = settled.find((result) => result.status === "rejected" && result.reason?.code !== "25P02")
    || settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  const results = settled.map((result) => result.value);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
});

test("real Inquiry provenance follows the Quotation into Commission creation", async () => {
  const { body } = await createClient();
  const inquiryId = randomUUID();
  await db.pool.query(
    `INSERT INTO inquiries (id, form_type, client_name, client_email, message)
     VALUES ($1, 'commission_request', 'Precommission Client', 'precommission@example.invalid', 'Request')`,
    [inquiryId]
  );
  const draft = (await (await invoke(quotations, `/admin/api/clients/${body.client.id}/quotations`, "POST", quotationBody({ inquiry_id: inquiryId }))).json()).quotation;
  await invoke(quotations, `/admin/api/quotations/${draft.id}/issue`, "POST");
  await invoke(acceptances, `/admin/api/quotations/${draft.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Precommission Client", client_email: "precommission@example.invalid",
    accepted_by_client_confirmation: true
  });
  const commission = (await (await invoke(quotations, `/admin/api/quotations/${draft.id}/create-commission`, "POST")).json()).commission;
  const provenance = (await db.pool.query("SELECT inquiry_id, relationship_type FROM commission_inquiries WHERE commission_id = $1", [commission.id])).rows[0];
  assert.equal(provenance.inquiry_id, inquiryId);
  assert.equal(provenance.relationship_type, "origin");
});
