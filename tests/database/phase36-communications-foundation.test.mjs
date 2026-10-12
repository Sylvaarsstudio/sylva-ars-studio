import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { config, createHandler } from "../../netlify/functions/admin-communications.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import {
  communicationChannels,
  communicationStatuses,
  communicationTypes,
  createCommunication,
  normalizeCommunicationInput,
  updateDraftCommunication
} from "../../netlify/shared/communications.mjs";

const apiUrl = "http://localhost/admin/api/communications";
const adminPassword = "communications-test-password";
const sessionSecret = "communications-test-secret";
let database;
let db;
let handler;
let sessionCookie;
let inquiryId;
let clientId;
let commissionId;
let quotationId;
let documentId;

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
     VALUES ('commission_request', 'Communication Client', 'communications@example.invalid', 'Commission inquiry') RETURNING id`
  )).rows[0].id;
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Communication Client', 'communications@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-9901', $1, 'Communication Study', 'Test', 'Oil', 400) RETURNING id`,
    [clientId]
  )).rows[0].id;
  quotationId = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       snapshot_version, quotation_number, version, price, sales_tax_rate,
       sales_tax, shipping_charge, required_deposit
     ) VALUES ($1, $2, 'Communication Study', 'Test', 'Oil', 1,
       'SAS-QUO-2026-9901', 1, 400, 0.06, 24, 20, 200) RETURNING id`,
    [commissionId, clientId]
  )).rows[0].id;
  documentId = (await db.pool.query(
    `INSERT INTO documents (commission_id, document_type, document_number, file_location)
     VALUES ($1, 'contract', 'SAS-CON-2026-9901', '/admin/contract.html') RETURNING id`,
    [commissionId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE communications RESTART IDENTITY");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM acceptances");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM inquiries");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function draftInput(overrides = {}) {
  return {
    inquiry_id: inquiryId,
    client_id: clientId,
    commission_id: commissionId,
    quotation_id: quotationId,
    document_id: documentId,
    channel: "email",
    communication_type: "quotation",
    recipient: "recipient@example.invalid",
    subject: "Quotation available",
    body_snapshot: "Exact draft body.",
    request_id: randomUUID(),
    ...overrides
  };
}

function request(method = "GET", path = "", body, cookie = sessionCookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return handler(new Request(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

test("communications schema, relationships, indexes, and controlled vocabularies exist", async () => {
  const columns = new Set((await db.pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'communications'"
  )).rows.map((row) => row.column_name));
  for (const column of [
    "id", "inquiry_id", "client_id", "commission_id", "quotation_id", "document_id",
    "channel", "communication_type", "communication_status", "recipient", "subject",
    "body_snapshot", "provider_message_id", "request_id", "created_at", "ready_at",
    "queued_at", "sent_at", "delivered_at", "bounced_at", "failed_at", "cancelled_at", "error_code",
    "template_key", "template_version"
  ]) assert.ok(columns.has(column), column);

  const indexes = new Set((await db.pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'communications'"
  )).rows.map((row) => row.indexname));
  for (const index of [
    "communications_commission_id_index", "communications_client_id_index",
    "communications_inquiry_id_index", "communications_status_index",
    "communications_created_at_index", "communications_request_id_unique"
  ]) assert.ok(indexes.has(index), index);
  assert.deepEqual(communicationChannels, ["email", "manual"]);
  assert.ok(communicationTypes.includes("final_storage_notice"));
  assert.ok(communicationStatuses.includes("cancelled"));
});

test("database requires body, a valid relationship, and valid vocabulary", async () => {
  await assert.rejects(db.pool.query(
    `INSERT INTO communications (channel, communication_type, recipient, body_snapshot)
     VALUES ('email', 'general', 'x@example.invalid', 'Body')`
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, recipient, body_snapshot)
     VALUES ($1, 'sms', 'general', 'x@example.invalid', 'Body')`, [commissionId]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, recipient, body_snapshot)
     VALUES ($1, 'email', 'general', 'x@example.invalid', '')`, [commissionId]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, recipient, body_snapshot)
     VALUES (999999, 'email', 'general', 'x@example.invalid', 'Body')`
  ));
});

test("request_id is unique while manual imports may omit it", async () => {
  const requestId = randomUUID();
  const values = [commissionId, requestId];
  await db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, recipient, body_snapshot, request_id)
     VALUES ($1, 'email', 'general', 'a@example.invalid', 'One', $2)`, values
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, recipient, body_snapshot, request_id)
     VALUES ($1, 'email', 'general', 'b@example.invalid', 'Two', $2)`, values
  ));
  await db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, communication_status, recipient, body_snapshot, sent_at)
     VALUES ($1, 'manual', 'manual_note', 'sent', 'Client', 'Called Client', NOW()),
            ($1, 'manual', 'manual_note', 'sent', 'Client', 'Met Client', NOW())`, [commissionId]
  );
});

test("draft content is editable but sent historical content and cancelled status are protected", async () => {
  const created = await createCommunication(db, normalizeCommunicationInput(draftInput()).communication);
  const edited = await updateDraftCommunication(db, created.communication.id, {
    recipient: "updated@example.invalid", subject: "Updated", body_snapshot: "Updated exact body.", communication_type: "general"
  });
  assert.equal(edited.outcome, "success");
  assert.equal(edited.communication.body_snapshot, "Updated exact body.");

  const manual = await createCommunication(db, normalizeCommunicationInput(draftInput({ request_id: null }), { manual: true }).communication, { manual: true });
  await assert.rejects(db.pool.query(
    "UPDATE communications SET body_snapshot = 'Rewritten' WHERE id = $1", [manual.communication.id]
  ), /immutable/i);
  await assert.rejects(db.pool.query(
    "UPDATE communications SET communication_status = 'draft' WHERE id = $1", [manual.communication.id]
  ), /cannot return/i);
  const cancelledId = (await db.pool.query(
    `INSERT INTO communications (commission_id, channel, communication_type, communication_status, recipient, body_snapshot)
     VALUES ($1, 'email', 'general', 'cancelled', 'x@example.invalid', 'Cancelled') RETURNING id`, [commissionId]
  )).rows[0].id;
  await assert.rejects(db.pool.query(
    "UPDATE communications SET communication_status = 'draft' WHERE id = $1", [cancelledId]
  ), /cannot be reopened/i);
});

test("draft creation is idempotent and creates a minimal Commission event atomically", async () => {
  const input = normalizeCommunicationInput(draftInput()).communication;
  const first = await createCommunication(db, input);
  const retry = await createCommunication(db, input);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal((await db.pool.query("SELECT count(*) FROM communications")).rows[0].count, "1");
  const event = (await db.pool.query("SELECT * FROM commission_events")).rows[0];
  assert.equal(event.event_type, "communication_draft_created");
  assert.equal(event.source_type, "communication");
  assert.deepEqual(event.payload, {
    communication_type: "quotation", channel: "email", communication_id: String(first.communication.id)
  });
  assert.equal(JSON.stringify(event.payload).includes("Exact draft body"), false);
});

test("inquiry-only drafts do not invent a Commission event", async () => {
  const normalized = normalizeCommunicationInput(draftInput({
    client_id: null, commission_id: null, quotation_id: null, document_id: null
  }));
  const result = await createCommunication(db, normalized.communication);
  assert.equal(result.outcome, "success");
  assert.equal((await db.pool.query("SELECT count(*) FROM commission_events")).rows[0].count, "0");
});

test("manual record is sent at server time, sends nothing, and creates one safe event", async () => {
  const now = new Date("2026-10-11T18:30:00Z");
  const normalized = normalizeCommunicationInput(draftInput({ channel: "email", request_id: null }), { manual: true });
  const result = await createCommunication(db, normalized.communication, { manual: true, now: () => now });
  assert.equal(result.communication.channel, "manual");
  assert.equal(result.communication.communication_status, "sent");
  assert.equal(new Date(result.communication.sent_at).toISOString(), now.toISOString());
  assert.equal(result.communication.provider_message_id, null);
  const event = (await db.pool.query("SELECT event_type, payload FROM commission_events")).rows[0];
  assert.equal(event.event_type, "manual_communication_recorded");
  assert.equal(Object.hasOwn(event.payload, "body_snapshot"), false);
});

test("invalid cross-Commission relationships are rejected before creation", async () => {
  const otherClient = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Other', 'other@example.invalid') RETURNING id"
  )).rows[0].id;
  const result = await createCommunication(db, normalizeCommunicationInput(draftInput({ client_id: otherClient })).communication);
  assert.equal(result.outcome, "invalid_relationship");
  assert.match(result.message, /does not match/);
  assert.equal((await db.pool.query("SELECT count(*) FROM communications")).rows[0].count, "0");
  assert.equal((await db.pool.query("SELECT count(*) FROM commission_events")).rows[0].count, "0");
});

test("Admin API paths are protected and use only supported Netlify path strings", async () => {
  assert.deepEqual(config.path, [
    "/admin/api/communications", "/admin/api/communications/manual",
    "/admin/api/communications/templates", "/admin/api/communications/template-preview",
    "/admin/api/communications/from-template", "/admin/api/communications/:id/ready",
    "/admin/api/communications/:id/send",
    "/admin/api/communications/:id/reconcile",
    "/admin/api/communications/:id/reconcile/manual-sent",
    "/admin/api/communications/:id/reconcile/manual-failed",
    "/admin/api/communications/:id"
  ]);
  assert.equal(config.path.every((path) => typeof path === "string"), true);
  assert.equal((await request("GET", "", undefined, null)).status, 401);
});

test("Admin API creates, edits, reads, and filters a draft", async () => {
  const input = draftInput();
  const createResponse = await request("POST", "", input);
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  const editResponse = await request("PATCH", `/${created.communication.id}`, {
    recipient: "edited@example.invalid", subject: null, body_snapshot: "Edited body.", communication_type: "general"
  });
  assert.equal(editResponse.status, 200);
  const detail = await (await request("GET", `/${created.communication.id}`)).json();
  assert.equal(detail.communication.body_snapshot, "Edited body.");
  const list = await (await request("GET", `?commission_id=${commissionId}&status=draft&type=general&channel=email`)).json();
  assert.equal(list.total, 1);
  assert.equal(Object.hasOwn(list.communications[0], "body_snapshot"), false);
});

test("manual API creates a sent record but sent records cannot be edited", async () => {
  const response = await request("POST", "/manual", draftInput({ channel: "email" }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.communication.channel, "manual");
  assert.equal(body.communication.communication_status, "sent");
  const edit = await request("PATCH", `/${body.communication.id}`, {
    recipient: "x@example.invalid", subject: null, body_snapshot: "Changed", communication_type: "general"
  });
  assert.equal(edit.status, 409);
});

test("API rejects invalid relationships and idempotent retry does not duplicate", async () => {
  const invalid = await request("POST", "", draftInput({ commission_id: "999999" }));
  assert.equal(invalid.status, 400);
  const input = draftInput();
  assert.equal((await request("POST", "", input)).status, 201);
  const retry = await request("POST", "", input);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).created, false);
});
