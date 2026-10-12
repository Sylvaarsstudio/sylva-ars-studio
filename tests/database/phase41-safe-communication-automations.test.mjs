import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler as createAcceptanceHandler } from "../../netlify/functions/admin-acceptances.mjs";
import { createHandler as createPaymentHandler } from "../../netlify/functions/admin-payments.mjs";
import { createHandler as createQuotationHandler } from "../../netlify/functions/admin-quotations.mjs";
import { createHandler as createInquiryHandler } from "../../netlify/functions/create-request.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import {
  getCommunicationAutomationRule,
  listCommunicationAutomationPolicy
} from "../../netlify/shared/communication-automation-policy.mjs";
import { EmailProviderError } from "../../netlify/shared/email-provider.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const now = new Date("2026-10-11T18:00:00.000Z");
const unconfiguredProvider = Object.freeze({
  configured: false,
  async sendEmail() {
    throw new Error("Unconfigured provider must not be called.");
  }
});

let database;
let db;
let cookie;
let connectionString;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

afterEach(async () => {
  await db.pool.query("DELETE FROM communications");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
  await db.pool.query("DELETE FROM inquiries");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function environmentReader(name) {
  return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
}

function adminRequest(handler, path, method = "GET", body) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }));
}

function publicInquiryRequest(handler, body) {
  return handler(new Request("http://localhost/.netlify/functions/create-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

async function createCommission(number = "SAS-COM-2026-9101", price = "100.00") {
  const client = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Automation Client', 'automation@example.invalid') RETURNING id"
  )).rows[0];
  const commission = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       price, sales_tax, shipping
     ) VALUES ($1, $2, 'Automation Portrait', 'Scope', 'Oil', $3, 6, 10)
     RETURNING id`,
    [number, client.id, price]
  )).rows[0];
  return { clientId: client.id, commissionId: commission.id };
}

async function createIssuedQuotation(provider = unconfiguredProvider) {
  const { commissionId } = await createCommission();
  const options = {
    databaseFactory: () => db,
    environmentReader,
    now: () => new Date(now),
    emailProvider: provider
  };
  const quotationHandler = createQuotationHandler(options);
  const draftResponse = await adminRequest(
    quotationHandler,
    `/admin/api/commissions/${commissionId}/quotations`,
    "POST",
    { request_id: randomUUID() }
  );
  const draft = (await draftResponse.json()).quotation;
  const issuedResponse = await adminRequest(
    quotationHandler,
    `/admin/api/quotations/${draft.id}/issue`,
    "POST"
  );
  return { commissionId, quotation: (await issuedResponse.json()).quotation };
}

test("automation policy exposes exactly four safe auto-send rules and keeps sensitive types review-required", () => {
  const policy = listCommunicationAutomationPolicy();
  assert.deepEqual(
    policy.filter((item) => item.mode === "auto_send").map((item) => item.key),
    [
      "inquiry_received_confirmation",
      "quotation_acceptance_confirmation",
      "receipt_delivery",
      "final_invoice_delivery"
    ]
  );
  for (const key of [
    "quotation", "contract", "payment_request", "final_presentation",
    "delivery_ready", "pickup_scheduled", "shipping_notice",
    "storage_notice", "final_storage_notice", "thank_you"
  ]) assert.equal(getCommunicationAutomationRule(key)?.mode, "review_required", key);
  assert.equal(policy.some((item) => /calendar/i.test(`${item.key} ${item.trigger}`)), false);
});

test("Inquiry creation persists one neutral ready confirmation and retries remain idempotent", async () => {
  const handler = createInquiryHandler({
    databaseFactory: () => db,
    emailProvider: unconfiguredProvider,
    now: () => new Date(now)
  });
  const requestId = randomUUID();
  const payload = {
    request_id: requestId,
    form_type: "contact",
    client_name: "Inquiry Client",
    client_email: "inquiry@example.invalid",
    message: "Please contact me."
  };
  const first = await publicInquiryRequest(handler, payload);
  const second = await publicInquiryRequest(handler, payload);
  const inquiries = await db.pool.query("SELECT * FROM inquiries");
  const communications = await db.pool.query("SELECT * FROM communications");
  const events = await db.pool.query("SELECT * FROM commission_events");

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(inquiries.rows.length, 1);
  assert.equal(communications.rows.length, 1);
  assert.equal(communications.rows[0].inquiry_id, inquiries.rows[0].id);
  assert.equal(communications.rows[0].recipient, "inquiry@example.invalid");
  assert.equal(communications.rows[0].template_key, "inquiry_received_confirmation");
  assert.equal(communications.rows[0].automation_key, "inquiry_received_confirmation");
  assert.equal(communications.rows[0].automation_mode, "auto_send");
  assert.equal(communications.rows[0].communication_status, "ready");
  assert.equal(communications.rows[0].client_id, null);
  assert.equal(communications.rows[0].commission_id, null);
  assert.equal(events.rows.length, 0);
  assert.match(communications.rows[0].body_snapshot, /inquiry has been received successfully/i);
  assert.doesNotMatch(
    communications.rows[0].body_snapshot,
    /inquiry (?:was|is) accepted|commission approved|availability confirmed|price confirmed|production slot reserved|response deadline guaranteed/i
  );
});

test("Inquiry provider failure never rolls back the Inquiry or duplicates a send on source retry", async () => {
  let providerCalls = 0;
  const provider = {
    configured: true,
    async sendEmail() {
      providerCalls += 1;
      throw new EmailProviderError("provider_unavailable");
    }
  };
  const handler = createInquiryHandler({
    databaseFactory: () => db,
    emailProvider: provider,
    now: () => new Date(now)
  });
  const payload = {
    request_id: randomUUID(), form_type: "contact",
    client_name: "Inquiry Client", client_email: "inquiry@example.invalid",
    message: "Please contact me."
  };
  assert.equal((await publicInquiryRequest(handler, payload)).status, 200);
  assert.equal((await publicInquiryRequest(handler, payload)).status, 200);
  const inquiryCount = await db.pool.query("SELECT count(*)::integer AS count FROM inquiries");
  const communication = (await db.pool.query("SELECT * FROM communications")).rows[0];
  assert.equal(inquiryCount.rows[0].count, 1);
  assert.equal(communication.communication_status, "failed");
  assert.equal(communication.error_code, "provider_unavailable");
  assert.equal(providerCalls, 1);
});

test("concurrent Inquiry submission retries create one Inquiry and one confirmation", async () => {
  const secondDb = getDatabase({ connectionString });
  const firstHandler = createInquiryHandler({
    databaseFactory: () => db,
    emailProvider: unconfiguredProvider,
    now: () => new Date(now)
  });
  const secondHandler = createInquiryHandler({
    databaseFactory: () => secondDb,
    emailProvider: unconfiguredProvider,
    now: () => new Date(now)
  });
  const payload = {
    request_id: randomUUID(), form_type: "contact",
    client_name: "Concurrent Inquiry", client_email: "concurrent@example.invalid",
    message: "One canonical request."
  };
  const responses = await Promise.all([
    publicInquiryRequest(firstHandler, payload),
    publicInquiryRequest(secondHandler, payload)
  ]);
  await secondDb.pool.end();
  const inquiries = await db.pool.query("SELECT count(*)::integer AS count FROM inquiries");
  const communications = await db.pool.query("SELECT count(*)::integer AS count FROM communications");

  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(inquiries.rows[0].count, 1);
  assert.equal(communications.rows[0].count, 1);
});

test("Inquiry and its automatic outbox roll back together on an outbox database failure", async () => {
  await db.pool.query(`
    CREATE FUNCTION reject_inquiry_automation_outbox()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.automation_key = 'inquiry_received_confirmation' THEN
        RAISE EXCEPTION 'forced Inquiry automation outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_inquiry_automation_outbox_trigger
    BEFORE INSERT ON communications
    FOR EACH ROW EXECUTE FUNCTION reject_inquiry_automation_outbox();
  `);
  const handler = createInquiryHandler({
    databaseFactory: () => db,
    emailProvider: unconfiguredProvider,
    now: () => new Date(now)
  });
  let response;
  try {
    response = await publicInquiryRequest(handler, {
      request_id: randomUUID(), form_type: "contact",
      client_name: "Rollback Inquiry", client_email: "rollback@example.invalid",
      message: "This operation must be atomic."
    });
  } finally {
    await db.pool.query(`
      DROP TRIGGER IF EXISTS reject_inquiry_automation_outbox_trigger ON communications;
      DROP FUNCTION IF EXISTS reject_inquiry_automation_outbox();
    `);
  }
  assert.equal(response.status, 500);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM inquiries")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM communications")).rows[0].count, 0);
});

test("Quotation acceptance creates one snapshot-based automatic Communication and isolates provider failure", async () => {
  let providerCalls = 0;
  const provider = {
    configured: true,
    async sendEmail() {
      providerCalls += 1;
      throw new EmailProviderError("provider_unavailable");
    }
  };
  const { quotation } = await createIssuedQuotation(provider);
  const handler = createAcceptanceHandler({
    databaseFactory: () => db,
    environmentReader,
    emailProvider: provider,
    now: () => new Date("2026-10-12T15:30:00.000Z")
  });
  const body = {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Automation Client",
    client_email: "automation@example.invalid",
    accepted_by_client_confirmation: true
  };
  const first = await adminRequest(handler, `/admin/api/quotations/${quotation.id}/accept`, "POST", body);
  const second = await adminRequest(handler, `/admin/api/quotations/${quotation.id}/accept`, "POST", body);
  const acceptances = await db.pool.query("SELECT * FROM acceptances");
  const communication = (await db.pool.query("SELECT * FROM communications")).rows[0];
  const storedQuotation = (await db.pool.query("SELECT quotation_status FROM quotations WHERE id = $1", [quotation.id])).rows[0];

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(acceptances.rows.length, 1);
  assert.equal(storedQuotation.quotation_status, "accepted");
  assert.equal(communication.quotation_id, quotation.id);
  assert.equal(communication.automation_source_key, `quotation-acceptance:${acceptances.rows[0].id}`);
  assert.equal(communication.template_key, "quotation_acceptance_confirmation");
  assert.equal(communication.recipient, quotation.quotation_snapshot.client.email);
  assert.match(communication.body_snapshot, new RegExp(quotation.quotation_snapshot.quotation_number));
  assert.match(communication.body_snapshot, new RegExp(quotation.quotation_snapshot.commission.title));
  assert.equal(communication.communication_status, "failed");
  assert.equal(providerCalls, 1);
});

test("Acceptance status, evidence, events, and outbox roll back together on outbox failure", async () => {
  const { quotation } = await createIssuedQuotation();
  await db.pool.query(`
    CREATE FUNCTION reject_acceptance_automation_outbox()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.automation_key = 'quotation_acceptance_confirmation' THEN
        RAISE EXCEPTION 'forced Acceptance automation outbox failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_acceptance_automation_outbox_trigger
    BEFORE INSERT ON communications
    FOR EACH ROW EXECUTE FUNCTION reject_acceptance_automation_outbox();
  `);
  const handler = createAcceptanceHandler({
    databaseFactory: () => db,
    environmentReader,
    emailProvider: unconfiguredProvider,
    now: () => new Date("2026-10-12T15:30:00.000Z")
  });
  let response;
  try {
    response = await adminRequest(handler, `/admin/api/quotations/${quotation.id}/accept`, "POST", {
      request_id: randomUUID(), acceptance_method: "admin_recorded",
      client_name_entered: "Automation Client",
      client_email: "automation@example.invalid",
      accepted_by_client_confirmation: true
    });
  } finally {
    await db.pool.query(`
      DROP TRIGGER IF EXISTS reject_acceptance_automation_outbox_trigger ON communications;
      DROP FUNCTION IF EXISTS reject_acceptance_automation_outbox();
    `);
  }
  const storedQuotation = (await db.pool.query(
    "SELECT quotation_status FROM quotations WHERE id = $1", [quotation.id]
  )).rows[0];
  assert.equal(response.status, 500);
  assert.equal(storedQuotation.quotation_status, "issued");
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM acceptances")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM communications")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM commission_events WHERE event_type IN ('quotation_accepted', 'communication_automation_created')")).rows[0].count, 0);
});

test("automatic provider invocation starts only after the Inquiry and outbox are committed", async () => {
  let observedCommittedState = false;
  const provider = {
    configured: true,
    async sendEmail(message) {
      const inquiry = await db.pool.query(
        "SELECT id FROM inquiries WHERE client_email = $1", [message.to]
      );
      const communication = await db.pool.query(
        "SELECT communication_status FROM communications WHERE recipient = $1", [message.to]
      );
      observedCommittedState = inquiry.rows.length === 1
        && communication.rows[0]?.communication_status === "queued";
      return {
        provider: "test",
        provider_message_id: "test-message-1",
        accepted_at: new Date(now)
      };
    }
  };
  const handler = createInquiryHandler({
    databaseFactory: () => db,
    emailProvider: provider,
    now: () => new Date(now)
  });
  const response = await publicInquiryRequest(handler, {
    request_id: randomUUID(), form_type: "contact",
    client_name: "Committed Inquiry", client_email: "committed@example.invalid",
    message: "Confirm commit ordering."
  });
  const communication = (await db.pool.query("SELECT * FROM communications")).rows[0];
  assert.equal(response.status, 200);
  assert.equal(observedCommittedState, true);
  assert.equal(communication.communication_status, "sent");
});

async function recordPayment({ amount, provider, requestId = randomUUID() }) {
  const { commissionId } = await createCommission(
    amount === "116.00" ? "SAS-COM-2026-9202" : "SAS-COM-2026-9201"
  );
  const handler = createPaymentHandler({
    databaseFactory: () => db,
    environmentReader,
    emailProvider: provider,
    now: () => new Date(now)
  });
  const response = await adminRequest(handler, `/admin/api/commissions/${commissionId}/payments`, "POST", {
    request_id: requestId,
    payment_type: amount === "116.00" ? "balance" : "deposit",
    amount,
    sales_tax: amount === "116.00" ? "6.00" : "0.00",
    payment_method: "card",
    payment_date: "2026-10-11"
  });
  return { commissionId, handler, requestId, response };
}

test("Receipt automation uses the canonical Document, survives provider failure, and remains idempotent", async () => {
  let providerCalls = 0;
  const provider = {
    configured: true,
    async sendEmail() {
      providerCalls += 1;
      throw new EmailProviderError("provider_unavailable");
    }
  };
  const operation = await recordPayment({ amount: "25.00", provider });
  const firstBody = await operation.response.json();
  const retry = await adminRequest(
    operation.handler,
    `/admin/api/commissions/${operation.commissionId}/payments`,
    "POST",
    {
      request_id: operation.requestId, payment_type: "deposit", amount: "25.00",
      sales_tax: "0.00", payment_method: "card", payment_date: "2026-10-11"
    }
  );
  const documents = await db.pool.query("SELECT * FROM documents");
  const communications = await db.pool.query("SELECT * FROM communications");
  const payments = await db.pool.query("SELECT * FROM payments");

  assert.equal(operation.response.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(payments.rows.length, 1);
  assert.equal(documents.rows.length, 1);
  assert.equal(communications.rows.length, 1);
  assert.equal(documents.rows[0].document_type, "receipt");
  assert.equal(String(communications.rows[0].document_id), String(documents.rows[0].id));
  assert.equal(communications.rows[0].automation_key, "receipt_delivery");
  assert.equal(communications.rows[0].automation_source_key, `receipt:${documents.rows[0].id}`);
  assert.match(communications.rows[0].body_snapshot, new RegExp(documents.rows[0].document_number));
  assert.equal(communications.rows[0].communication_status, "failed");
  assert.equal(firstBody.document.id, String(documents.rows[0].id));
  assert.equal(providerCalls, 1);
});

test("Final Invoice automation stays Ready when the provider is not configured", async () => {
  const operation = await recordPayment({ amount: "116.00", provider: unconfiguredProvider });
  const documents = await db.pool.query("SELECT * FROM documents");
  const communications = await db.pool.query("SELECT * FROM communications");
  const payments = await db.pool.query("SELECT * FROM payments");

  assert.equal(operation.response.status, 201);
  assert.equal(payments.rows.length, 1);
  assert.equal(documents.rows.length, 1);
  assert.equal(communications.rows.length, 1);
  assert.equal(documents.rows[0].document_type, "invoice");
  assert.equal(String(communications.rows[0].document_id), String(documents.rows[0].id));
  assert.equal(communications.rows[0].automation_key, "final_invoice_delivery");
  assert.equal(communications.rows[0].automation_source_key, `final-invoice:${documents.rows[0].id}`);
  assert.match(communications.rows[0].body_snapshot, new RegExp(documents.rows[0].document_number));
  assert.equal(communications.rows[0].communication_status, "ready");
  assert.equal(communications.rows[0].error_code, null);
});

test("Commission automation events contain only non-sensitive identifiers and policy metadata", async () => {
  const { quotation } = await createIssuedQuotation();
  const handler = createAcceptanceHandler({
    databaseFactory: () => db,
    environmentReader,
    emailProvider: unconfiguredProvider,
    now: () => new Date("2026-10-12T15:30:00.000Z")
  });
  await adminRequest(handler, `/admin/api/quotations/${quotation.id}/accept`, "POST", {
    request_id: randomUUID(), acceptance_method: "admin_recorded",
    client_name_entered: "Automation Client",
    client_email: "automation@example.invalid",
    accepted_by_client_confirmation: true
  });
  const event = (await db.pool.query(
    "SELECT payload FROM commission_events WHERE event_type = 'communication_automation_created'"
  )).rows[0];
  const serialized = JSON.stringify(event.payload);
  assert.deepEqual(Object.keys(event.payload).sort(), [
    "automation_key", "communication_id", "communication_type",
    "template_key", "template_version"
  ]);
  assert.doesNotMatch(serialized, /@|recipient|subject|body|Automation Client/i);
});
