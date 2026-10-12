import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createCommission,
  listCommissionEvents,
  updateCommissionStatus
} from "../../netlify/functions/admin-commissions.mjs";
import {
  createDraft,
  createNewVersion,
  issueQuotation,
  transitionQuotation
} from "../../netlify/functions/admin-quotations.mjs";
import { recordQuotationAcceptance } from "../../netlify/functions/admin-acceptances.mjs";
import { createPayment } from "../../netlify/functions/admin-payments.mjs";

const fixedNow = new Date("2026-10-11T16:00:00.000Z");
let database;
let db;
let clientId;
let commissionId;
let inquiryId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email, phone) VALUES ('Audit Client', 'audit@example.invalid', '555-0100') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       width, height, price, sales_tax, shipping, estimated_completion
     ) VALUES ('SAS-COM-2026-9601', $1, 'Audit Portrait', 'Audit scope', 'Oil',
       20, 24, 100, 6, 10, '2027-02-15') RETURNING id`,
    [clientId]
  )).rows[0].id;
  inquiryId = (await db.pool.query(
    `INSERT INTO inquiries (
       form_type, client_name, client_email, message, status
     ) VALUES ('commission_request', 'Audit Client', 'audit@example.invalid', 'Audit inquiry', 'accepted')
     RETURNING id`
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM communications");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commission_inquiries");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM inquiries");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function commissionInput(originInquiryId = null) {
  return {
    client_id: String(clientId),
    title: "Created Commission",
    description: "Created from integration test",
    medium: "Oil",
    width: "20.00",
    height: "24.00",
    price: "400.00",
    sales_tax: "24.00",
    shipping: "20.00",
    estimated_completion: "2027-03-01",
    origin_inquiry_id: originInquiryId
  };
}

async function eventsFor(id = commissionId) {
  return (await db.pool.query(
    `SELECT event_type, actor_type, source_type, source_id, payload, request_id
     FROM commission_events WHERE commission_id = $1 ORDER BY id`,
    [id]
  )).rows;
}

async function createIssuedQuotation() {
  const requestId = randomUUID();
  const draft = await createDraft(db, commissionId, requestId, () => new Date(fixedNow));
  await issueQuotation(db, draft.quotation.id, () => new Date(fixedNow));
  return draft.quotation;
}

function paymentInput(overrides = {}) {
  return {
    request_id: randomUUID(),
    payment_type: "deposit",
    amount: "50.00",
    sales_tax: "0.00",
    payment_method: "card",
    payment_date: "2026-10-11",
    external_reference: null,
    notes: null,
    ...overrides
  };
}

test("origin provenance creates inquiry_linked atomically and optional provenance stays silent", async () => {
  const linked = await createCommission(db, commissionInput(String(inquiryId)), 2026);
  assert.equal(linked.outcome, "success");
  const linkedEvents = await eventsFor(linked.commission.id);
  assert.deepEqual(linkedEvents.map((event) => event.event_type), [
    "production_initialized",
    "inquiry_linked"
  ]);
  assert.equal(linkedEvents[1].source_type, "inquiry");
  assert.equal(linkedEvents[1].source_id, String(inquiryId));
  assert.deepEqual(linkedEvents[1].payload, { relationship_type: "origin" });

  const unlinked = await createCommission(db, commissionInput(), 2026);
  assert.deepEqual(
    (await eventsFor(unlinked.commission.id)).map((event) => event.event_type),
    ["production_initialized"]
  );
});

test("failed provenance transaction leaves neither Commission nor event", async () => {
  const before = Number((await db.pool.query("SELECT count(*) FROM commissions")).rows[0].count);
  const result = await createCommission(db, commissionInput(randomUUID()), 2026);
  assert.equal(result.outcome, "inquiry_not_found");
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commissions")).rows[0].count), before);
  assert.equal(Number((await db.pool.query("SELECT count(*) FROM commission_events")).rows[0].count), 0);
});

test("quotation lifecycle emits specific events and an idempotent draft retry stays singular", async () => {
  const requestId = randomUUID();
  const first = await createDraft(db, commissionId, requestId, () => new Date(fixedNow));
  const retry = await createDraft(db, commissionId, requestId, () => new Date(fixedNow));
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  await issueQuotation(db, first.quotation.id, () => new Date(fixedNow));
  await transitionQuotation(db, first.quotation.id, "mark-sent", () => new Date("2026-10-11T17:00:00Z"));
  await transitionQuotation(db, first.quotation.id, "withdraw", () => new Date("2026-10-11T18:00:00Z"));
  assert.deepEqual((await eventsFor()).map((event) => event.event_type), [
    "quotation_created", "quotation_issued", "quotation_sent", "quotation_withdrawn"
  ]);
  assert.equal((await eventsFor())[0].request_id, requestId);
});

test("new quotation version and actual supersession are recorded exactly once", async () => {
  const original = await createIssuedQuotation();
  const version = await createNewVersion(db, original.id);
  assert.equal(version.created, true);
  await issueQuotation(db, version.quotation.id, () => new Date("2026-10-12T16:00:00Z"));
  const types = (await eventsFor()).map((event) => event.event_type);
  assert.equal(types.filter((type) => type === "quotation_created").length, 2);
  assert.equal(types.filter((type) => type === "quotation_issued").length, 2);
  assert.equal(types.filter((type) => type === "quotation_superseded").length, 1);
});

test("admin-recorded Acceptance emits quotation_accepted from the Acceptance source", async () => {
  const quotation = await createIssuedQuotation();
  const requestId = randomUUID();
  const result = await recordQuotationAcceptance(db, quotation.id, {
    request_id: requestId,
    acceptance_method: "admin_recorded",
    client_name_entered: "Audit Client",
    client_email: "audit@example.invalid"
  }, () => new Date("2026-10-12T12:00:00Z"));
  assert.equal(result.created, true);
  const event = (await eventsFor()).find((item) => item.event_type === "quotation_accepted");
  assert.equal(event.actor_type, "admin");
  assert.equal(event.source_type, "acceptance");
  assert.equal(event.source_id, String(result.acceptance.id));
  assert.equal(event.request_id, requestId);
  assert.equal(Object.hasOwn(event.payload, "client_email"), false);
});

test("failed Acceptance and idempotent Mark Sent retry create no extra event", async () => {
  const quotation = await createIssuedQuotation();
  const before = (await eventsFor()).length;
  const failed = await recordQuotationAcceptance(db, quotation.id, {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Wrong Client", client_email: "wrong@example.invalid"
  }, () => new Date("2026-10-12T12:00:00Z"));
  assert.equal(failed.outcome, "client_mismatch");
  assert.equal((await eventsFor()).length, before);
  assert.equal((await transitionQuotation(db, quotation.id, "mark-sent", () => new Date())).outcome, "success");
  const afterSent = (await eventsFor()).length;
  const repeated = await transitionQuotation(db, quotation.id, "mark-sent", () => new Date());
  assert.equal(repeated.outcome, "success");
  assert.equal(repeated.created, false);
  assert.equal((await eventsFor()).length, afterSent);
});

test("legacy Commission status transition writes a minimal audit event", async () => {
  const result = await updateCommissionStatus(db, commissionId, "quoted");
  assert.equal(result.outcome, "success");
  const event = (await eventsFor())[0];
  assert.equal(event.event_type, "commission_status_changed");
  assert.deepEqual(event.payload, { previous_status: "draft", new_status: "quoted" });
  assert.equal(event.source_type, "commission");
});

test("payments emit payment and document events without claiming deposit satisfaction", async () => {
  const deposit = paymentInput();
  const first = await createPayment(db, commissionId, deposit);
  assert.equal(first.created, true);
  const retry = await createPayment(db, commissionId, deposit);
  assert.equal(retry.created, false);
  let types = (await eventsFor()).map((event) => event.event_type);
  assert.deepEqual(types.toSorted(), [
    "communication_automation_created", "payment_recorded", "receipt_issued"
  ]);
  assert.equal(types.includes("deposit_received"), false);

  const final = await createPayment(db, commissionId, paymentInput({
    payment_type: "balance", amount: "66.00", sales_tax: "6.00"
  }));
  assert.equal(final.created, true);
  types = (await eventsFor()).map((event) => event.event_type);
  assert.deepEqual(types.toSorted(), [
    "balance_paid", "communication_automation_created", "communication_automation_created",
    "final_invoice_issued", "payment_recorded", "payment_recorded", "receipt_issued"
  ]);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM payments")).rows[0].count, 2);
});

test("read model returns newest events first and does not expose master-record PII", async () => {
  await updateCommissionStatus(db, commissionId, "quoted");
  await updateCommissionStatus(db, commissionId, "approved");
  const events = await listCommissionEvents(db, commissionId);
  assert.equal(events.length, 2);
  assert.ok(Number(events[0].id) > Number(events[1].id));
  for (const event of events) {
    assert.equal(Object.hasOwn(event, "client_email"), false);
    assert.equal(Object.hasOwn(event.payload, "client_email"), false);
  }
  assert.equal(await listCommissionEvents(db, "999999"), null);
});

test("Contract preview remains read-only and deliberately emits no event", async () => {
  assert.equal(
    Number((await db.pool.query("SELECT count(*) FROM commission_events WHERE event_type = 'contract_preview_prepared'")).rows[0].count),
    0
  );
});
