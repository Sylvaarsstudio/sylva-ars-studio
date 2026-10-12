import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-communications.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import {
  communicationTemplates,
  getCommunicationTemplate,
  renderCommunicationTemplate,
  resolveCommunicationTemplate
} from "../../netlify/shared/communication-templates.mjs";
import { markCommunicationReady, updateDraftCommunication } from "../../netlify/shared/communications.mjs";

const apiUrl = "http://localhost/admin/api/communications";
const adminPassword = "phase-11b-password";
const sessionSecret = "phase-11b-secret";
let database;
let db;
let handler;
let sessionCookie;
let inquiryId;
let clientId;
let commissionId;
let quotationId;

const quotationSnapshot = {
  quotation_number: "SAS-QUO-2026-9911",
  version: 1,
  issued_at: "2026-10-11T16:00:00.000Z",
  expires_at: "2026-11-10T17:00:00.000Z",
  client: {
    client_id: "1",
    full_name: "Historical Name",
    email: "historical@example.invalid",
    phone: null
  },
  commission: {
    commission_id: "1",
    commission_number: "SAS-COM-2026-9911",
    title: "Template Portrait",
    description: "Portrait",
    medium: "Oil",
    dimensions: { width: "20.00", height: "24.00", unit: "in" }
  },
  commercial: {
    price: "400.00",
    sales_tax_rate: "0.0600",
    sales_tax: "24.00",
    shipping_charge: "20.00",
    total: "444.00",
    required_deposit_rate: "0.5000",
    required_deposit: "200.00",
    estimated_completion: "2027-02-15",
    special_terms: null,
    shipping_estimate: null
  }
};

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: adminPassword, ADMIN_SESSION_SECRET: sessionSecret })[name]
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
});

beforeEach(async () => {
  inquiryId = (await db.pool.query(
    `INSERT INTO inquiries (form_type, client_name, client_email, message)
     VALUES ('contact', 'Inquiry Person', 'inquiry@example.invalid', 'Hello') RETURNING id`
  )).rows[0].id;
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Current Client', 'current@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price, sales_tax, shipping)
     VALUES ('SAS-COM-2026-9911', $1, 'Live Title', 'Portrait', 'Oil', 400, 24, 20) RETURNING id`,
    [clientId]
  )).rows[0].id;
  const snapshot = structuredClone(quotationSnapshot);
  snapshot.client.client_id = String(clientId);
  snapshot.commission.commission_id = String(commissionId);
  quotationId = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       snapshot_version, quotation_number, version, quotation_status,
       issued_at, accepted_at, expires_at, price, sales_tax_rate, sales_tax,
       shipping_charge, estimated_completion, required_deposit,
       quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, $2, 'Live Title', 'Portrait', 'Oil', 1,
       'SAS-QUO-2026-9911', 1, 'accepted',
       '2026-10-11T16:00:00Z', '2026-10-12T16:00:00Z', '2026-11-10T17:00:00Z',
       400, 0.06, 24, 20, '2027-02-15', 200, $3::jsonb, $4
     ) RETURNING id`,
    [commissionId, clientId, JSON.stringify(snapshot), "a".repeat(64)]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE communications RESTART IDENTITY");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM acceptances");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM deliveries");
  await db.pool.query("DELETE FROM commission_obligations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM inquiries");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(method, path, body) {
  return handler(new Request(`${apiUrl}${path}`, {
    method,
    headers: { Cookie: sessionCookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

function quotationTemplateInput(overrides = {}) {
  return {
    template_key: "quotation",
    quotation_id: String(quotationId),
    commission_id: null,
    inquiry_id: null,
    document_id: null,
    ...overrides
  };
}

test("the central registry exposes the approved versioned templates", () => {
  assert.deepEqual(communicationTemplates.map((item) => item.key), [
    "inquiry_received_confirmation", "inquiry_reply", "quotation",
    "quotation_acceptance_confirmation", "contract", "payment_request", "receipt",
    "final_invoice", "final_presentation", "delivery_ready", "pickup_scheduled",
    "shipping_notice", "storage_notice", "final_storage_notice", "thank_you"
  ]);
  for (const item of communicationTemplates) {
    assert.equal(item.version, item.key === "receipt" ? 2 : 1);
    assert.equal(item.channel, "email");
    assert.equal(item.review_policy, "review_required");
    assert.ok(item.required_context.length > 0);
  }
  assert.equal(getCommunicationTemplate("unknown"), null);
});

test("controlled rendering is deterministic and never evaluates arbitrary expressions", () => {
  const item = getCommunicationTemplate("inquiry_reply");
  const context = { client_name: "{{constructor.constructor('return process')()}}" };
  const first = renderCommunicationTemplate(item, context);
  const second = renderCommunicationTemplate(item, context);
  assert.deepEqual(first, second);
  assert.match(first.body, /\{\{constructor\.constructor/);
  assert.equal(first.body.includes(process.version), false);
});

test("strict rendering reports missing variables instead of inserting nullish text", () => {
  const result = renderCommunicationTemplate(getCommunicationTemplate("quotation"), {
    client_name: "Client"
  });
  assert.equal(result.error, "template_context_incomplete");
  assert.ok(result.missing_context.includes("quotation_number"));
  assert.equal(JSON.stringify(result).includes("undefined"), false);
});

test("canonical quotation resolution uses the issued snapshot and current Client recipient", async () => {
  const resolved = await resolveCommunicationTemplate(db, quotationTemplateInput());
  assert.equal(resolved.outcome, "success");
  assert.equal(resolved.recipient, "current@example.invalid");
  assert.match(resolved.subject, /SAS-QUO-2026-9911/);
  assert.match(resolved.body, /Template Portrait/);
  assert.match(resolved.body, /\$444\.00/);
  assert.match(resolved.body, /\$200\.00/);
  assert.match(resolved.body, /February 15, 2027/);
  assert.equal(resolved.body.includes("Live Title"), false);
});

test("unknown and incomplete contexts are blocked without persistence", async () => {
  let response = await request("POST", "/template-preview", { template_key: "unknown" });
  assert.equal(response.status, 404);
  response = await request("POST", "/from-template", {
    ...quotationTemplateInput({ quotation_id: null }), request_id: randomUUID()
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.code, "template_context_incomplete");
  assert.deepEqual(body.missing_context, ["quotation_id"]);
  assert.equal((await db.pool.query("SELECT count(*) FROM communications")).rows[0].count, "0");
});

test("template preview returns exact content and persists nothing", async () => {
  const before = (await db.pool.query("SELECT count(*) FROM communications")).rows[0].count;
  const response = await request("POST", "/template-preview", quotationTemplateInput());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.complete, true);
  assert.equal(body.template, "quotation");
  assert.equal(body.version, 1);
  assert.equal(body.recipient, "current@example.invalid");
  assert.equal(body.missing_context.length, 0);
  assert.equal((await db.pool.query("SELECT count(*) FROM communications")).rows[0].count, before);
});

test("generation saves template metadata and exact snapshots with one safe event", async () => {
  const preview = await (await request("POST", "/template-preview", quotationTemplateInput())).json();
  const response = await request("POST", "/from-template", {
    ...quotationTemplateInput(), request_id: randomUUID()
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.communication.communication_status, "draft");
  assert.equal(body.communication.template_key, "quotation");
  assert.equal(body.communication.template_version, 1);
  assert.equal(body.communication.recipient, preview.recipient);
  assert.equal(body.communication.subject, preview.subject);
  assert.equal(body.communication.body_snapshot, preview.body);
  const event = (await db.pool.query("SELECT event_type, payload FROM commission_events")).rows[0];
  assert.equal(event.event_type, "communication_generated_from_template");
  assert.deepEqual(event.payload, {
    communication_id: String(body.communication.id), template_key: "quotation",
    template_version: 1, communication_type: "quotation"
  });
  assert.equal(JSON.stringify(event.payload).includes("current@example.invalid"), false);
  assert.equal(JSON.stringify(event.payload).includes(preview.body), false);
});

test("a generated Draft is stable when canonical Client or Quotation sources later change", async () => {
  const body = await (await request("POST", "/from-template", {
    ...quotationTemplateInput(), request_id: randomUUID()
  })).json();
  await db.pool.query("UPDATE clients SET full_name = 'Changed Client', email = 'changed@example.invalid' WHERE id = $1", [clientId]);
  await db.pool.query("UPDATE commissions SET title = 'Changed Live Title' WHERE id = $1", [commissionId]);
  const stored = (await db.pool.query(
    "SELECT recipient, subject, body_snapshot FROM communications WHERE id = $1", [body.communication.id]
  )).rows[0];
  assert.equal(stored.recipient, "current@example.invalid");
  assert.equal(stored.subject, body.communication.subject);
  assert.equal(stored.body_snapshot, body.communication.body_snapshot);
});

test("generation retry is idempotent", async () => {
  const requestId = randomUUID();
  const input = { ...quotationTemplateInput(), request_id: requestId };
  const first = await request("POST", "/from-template", input);
  const second = await request("POST", "/from-template", input);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).created, false);
  assert.equal((await db.pool.query("SELECT count(*) FROM communications")).rows[0].count, "1");
  assert.equal((await db.pool.query("SELECT count(*) FROM commission_events")).rows[0].count, "1");
});

test("explicit review marks a valid Draft ready with server timestamp and a safe event", async () => {
  const generated = await (await request("POST", "/from-template", {
    ...quotationTemplateInput(), request_id: randomUUID()
  })).json();
  const readyAt = new Date("2026-10-12T19:30:00Z");
  const result = await markCommunicationReady(db, generated.communication.id, () => readyAt);
  assert.equal(result.outcome, "success");
  assert.equal(result.changed, true);
  assert.equal(result.communication.communication_status, "ready");
  assert.equal(result.communication.sent_at, null);
  assert.equal(new Date(result.communication.ready_at).toISOString(), readyAt.toISOString());
  const events = (await db.pool.query("SELECT event_type, payload FROM commission_events ORDER BY id")).rows;
  assert.deepEqual(events.map((event) => event.event_type), [
    "communication_generated_from_template", "communication_marked_ready"
  ]);
  assert.equal(events[1].payload.communication_id, String(generated.communication.id));
  assert.equal(Object.hasOwn(events[1].payload, "recipient"), false);
  assert.equal(Object.hasOwn(events[1].payload, "body"), false);
});

test("ready Communications are frozen and cannot be edited or treated as sent", async () => {
  const generated = await (await request("POST", "/from-template", {
    ...quotationTemplateInput(), request_id: randomUUID()
  })).json();
  await markCommunicationReady(db, generated.communication.id);
  const update = await updateDraftCommunication(db, generated.communication.id, {
    communication_type: "general", recipient: "other@example.invalid", subject: "Other", body_snapshot: "Other"
  });
  assert.equal(update.outcome, "not_editable");
  await assert.rejects(db.pool.query(
    "UPDATE communications SET subject = 'Rewritten' WHERE id = $1", [generated.communication.id]
  ), /immutable/i);
  const row = (await db.pool.query("SELECT communication_status, sent_at FROM communications WHERE id = $1", [generated.communication.id])).rows[0];
  assert.equal(row.communication_status, "ready");
  assert.equal(row.sent_at, null);
});

test("review validates recipient and body defensively and creates no send or queue state", async () => {
  function fakeDb(row) {
    const queries = [];
    const connection = {
      async query(sql) {
        queries.push(sql);
        if (sql.startsWith("SELECT *")) return { rows: [row] };
        return { rows: [] };
      },
      release() {}
    };
    return { db: { pool: { connect: async () => connection } }, queries };
  }
  let fake = fakeDb({ id: 1, communication_status: "draft", channel: "email", recipient: "invalid", subject: "Subject", body_snapshot: "Body" });
  assert.equal((await markCommunicationReady(fake.db, 1)).outcome, "invalid_content");
  fake = fakeDb({ id: 1, communication_status: "draft", channel: "email", recipient: "valid@example.invalid", subject: "Subject", body_snapshot: "" });
  assert.equal((await markCommunicationReady(fake.db, 1)).outcome, "invalid_content");
  assert.equal(fake.queries.some((sql) => /queued|sent_at\s*=/.test(sql)), false);
});

test("ready API is explicit and idempotent without itself sending or queuing", async () => {
  const generated = await (await request("POST", "/from-template", {
    ...quotationTemplateInput(), request_id: randomUUID()
  })).json();
  const first = await request("POST", `/${generated.communication.id}/ready`);
  const second = await request("POST", `/${generated.communication.id}/ready`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).changed, false);
  assert.equal((await db.pool.query(
    "SELECT count(*) FROM commission_events WHERE event_type = 'communication_marked_ready'"
  )).rows[0].count, "1");
});
