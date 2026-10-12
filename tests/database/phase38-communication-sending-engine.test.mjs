import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-communications.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import {
  EmailProviderError,
  createUnconfiguredEmailProvider,
  normalizeEmailProviderError,
  validateEmailProviderResult
} from "../../netlify/shared/email-provider.mjs";
import { markCommunicationReady } from "../../netlify/shared/communications.mjs";

const apiUrl = "http://localhost/admin/api/communications";
const adminPassword = "phase-11c1-password";
const sessionSecret = "phase-11c1-secret";
const queuedAt = new Date("2026-10-11T18:00:00.000Z");
const acceptedAt = new Date("2026-10-11T18:00:01.000Z");
let database;
let db;
let sessionCookie;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Sending Client', 'client@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price, sales_tax, shipping)
     VALUES ('SAS-COM-2026-3811', $1, 'Reviewed Work', 'Portrait', 'Oil', 400, 24, 20) RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE communications RESTART IDENTITY");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function makeHandler(emailProvider, clock = () => queuedAt) {
  return createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: adminPassword, ADMIN_SESSION_SECRET: sessionSecret })[name],
    emailProvider,
    clock
  });
}

function request(handler, method, path, body) {
  return handler(new Request(`${apiUrl}${path}`, {
    method,
    headers: { Cookie: sessionCookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

async function createCommunication({ channel = "email", status = "draft", recipient = "reviewed@example.invalid" } = {}) {
  return (await db.pool.query(
    `INSERT INTO communications (
       client_id, commission_id, channel, communication_type, communication_status,
       recipient, subject, body_snapshot, sent_at
     ) VALUES ($1, $2, $3, 'general', $4, $5, 'Reviewed subject', 'Reviewed body exactly.',
       CASE WHEN $4 = 'sent' THEN NOW() ELSE NULL END)
     RETURNING *`,
    [clientId, commissionId, channel, status, recipient]
  )).rows[0];
}

async function createReadyCommunication() {
  const draft = await createCommunication();
  const result = await markCommunicationReady(db, draft.id, () => new Date("2026-10-11T17:59:00.000Z"));
  return result.communication;
}

function successProvider(sendEmail) {
  return {
    configured: true,
    sendEmail: sendEmail || (async () => ({
      provider: "fake",
      provider_message_id: "fake-message-3811",
      accepted_at: acceptedAt
    }))
  };
}

test("provider adapter normalizes its contract without any live implementation", async () => {
  assert.equal(normalizeEmailProviderError(new Error("raw")).code, "send_error");
  assert.equal(normalizeEmailProviderError({ code: "send_timeout" }).code, "send_timeout");
  assert.throws(() => validateEmailProviderResult({ provider: "fake" }), /invalid response/);
  const provider = createUnconfiguredEmailProvider();
  assert.equal(provider.configured, false);
  await assert.rejects(provider.sendEmail({}), (error) => error.code === "provider_not_configured");
});

test("sending constraints and state guards preserve the Phase 11C.1 workflow", async () => {
  const draft = await createCommunication();
  await assert.rejects(
    db.pool.query("UPDATE communications SET communication_status = 'queued' WHERE id = $1", [draft.id]),
    /Draft communications may only be marked ready/
  );
  const ready = await markCommunicationReady(db, draft.id);
  await db.pool.query(
    "UPDATE communications SET communication_status = 'queued', queued_at = NOW() WHERE id = $1",
    [ready.communication.id]
  );
  await assert.rejects(
    db.pool.query("UPDATE communications SET communication_status = 'ready' WHERE id = $1", [draft.id]),
    /Queued communications may only become sent or failed/
  );
  await assert.rejects(
    db.pool.query("UPDATE communications SET provider_message_id = 'client-value' WHERE id = $1", [draft.id]),
    /communications_provider_message_status_check/
  );
});

test("draft and manual communications cannot enter the sending engine", async () => {
  const calls = [];
  const provider = successProvider(async (message) => { calls.push(message); return {}; });
  const handler = makeHandler(provider);
  const draft = await createCommunication();
  let response = await request(handler, "POST", `/${draft.id}/send`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "not_ready");

  const manual = await createCommunication({ channel: "manual", status: "sent", recipient: "Client" });
  response = await request(handler, "POST", `/${manual.id}/send`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "invalid_channel");
  assert.equal(calls.length, 0);
});

test("a ready email sends the reviewed snapshot exactly and records server-only result metadata", async () => {
  const ready = await createReadyCommunication();
  const calls = [];
  const handler = makeHandler(successProvider(async (message) => {
    calls.push(message);
    return { provider: "fake", provider_message_id: "external-123", accepted_at: acceptedAt };
  }));
  const response = await request(handler, "POST", `/${ready.id}/send`, {
    recipient: "attacker@example.invalid", subject: "Changed", body_snapshot: "Changed"
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.communication.communication_status, "sent");
  assert.equal(body.communication.provider_message_id, "external-123");
  assert.equal(new Date(body.communication.queued_at).toISOString(), queuedAt.toISOString());
  assert.equal(new Date(body.communication.sent_at).toISOString(), acceptedAt.toISOString());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    to: "reviewed@example.invalid",
    subject: "Reviewed subject",
    text: "Reviewed body exactly.",
    idempotency_key: `communication:${ready.id}`,
    metadata: { communication_id: String(ready.id), communication_type: "general" }
  });
});

test("live Client changes after review do not alter the provider payload", async () => {
  const ready = await createReadyCommunication();
  await db.pool.query("UPDATE clients SET email = 'changed@example.invalid' WHERE id = $1", [clientId]);
  let providerPayload;
  const handler = makeHandler(successProvider(async (message) => {
    providerPayload = message;
    return { provider: "fake", provider_message_id: "snapshot-safe", accepted_at: acceptedAt };
  }));
  await request(handler, "POST", `/${ready.id}/send`);
  assert.equal(providerPayload.to, "reviewed@example.invalid");
  assert.equal(providerPayload.subject, "Reviewed subject");
  assert.equal(providerPayload.text, "Reviewed body exactly.");
});

test("an HTTP retry after success returns the stored result without another provider call", async () => {
  const ready = await createReadyCommunication();
  let calls = 0;
  const handler = makeHandler(successProvider(async () => {
    calls += 1;
    return { provider: "fake", provider_message_id: "single-send", accepted_at: acceptedAt };
  }));
  assert.equal((await request(handler, "POST", `/${ready.id}/send`)).status, 200);
  const retry = await request(handler, "POST", `/${ready.id}/send`);
  const body = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(body.changed, false);
  assert.equal(body.communication.provider_message_id, "single-send");
  assert.equal(calls, 1);
});

test("concurrent sends atomically claim once and make one provider call", async () => {
  const ready = await createReadyCommunication();
  let calls = 0;
  let releaseProvider;
  let reportStarted;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const handler = makeHandler(successProvider(async () => {
    calls += 1;
    reportStarted();
    await providerGate;
    return { provider: "fake", provider_message_id: "concurrent-one", accepted_at: acceptedAt };
  }));

  const first = request(handler, "POST", `/${ready.id}/send`);
  await started;
  const second = await request(handler, "POST", `/${ready.id}/send`);
  const secondBody = await second.json();
  assert.equal(second.status, 409);
  assert.equal(secondBody.code, "send_in_progress");
  assert.equal(calls, 1);
  releaseProvider();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test("normalized provider failure is terminal and never auto-retries", async () => {
  const ready = await createReadyCommunication();
  let calls = 0;
  const handler = makeHandler(successProvider(async () => {
    calls += 1;
    throw new EmailProviderError("provider_unavailable");
  }), (() => {
    const values = [queuedAt, new Date("2026-10-11T18:00:02.000Z")];
    return () => values.shift() || values.at(-1);
  })());
  const response = await request(handler, "POST", `/${ready.id}/send`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "provider_unavailable");
  const stored = (await db.pool.query("SELECT * FROM communications WHERE id = $1", [ready.id])).rows[0];
  assert.equal(stored.communication_status, "failed");
  assert.equal(stored.error_code, "provider_unavailable");
  assert.ok(stored.failed_at);
  assert.equal(stored.provider_message_id, null);

  const retry = await request(handler, "POST", `/${ready.id}/send`);
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, "provider_unavailable");
  assert.equal(calls, 1);
});

test("the unconfigured default adapter makes no external call and leaves Ready unchanged", async () => {
  const ready = await createReadyCommunication();
  const handler = createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: adminPassword, ADMIN_SESSION_SECRET: sessionSecret })[name]
  });
  const response = await request(handler, "POST", `/${ready.id}/send`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "provider_not_configured");
  const stored = (await db.pool.query("SELECT communication_status, queued_at FROM communications WHERE id = $1", [ready.id])).rows[0];
  assert.equal(stored.communication_status, "ready");
  assert.equal(stored.queued_at, null);
});

test("queued, sent, and failed events contain no message content or PII", async () => {
  const sent = await createReadyCommunication();
  await request(makeHandler(successProvider()), "POST", `/${sent.id}/send`);
  const failed = await createReadyCommunication();
  await request(makeHandler(successProvider(async () => {
    throw new EmailProviderError("provider_rejected");
  })), "POST", `/${failed.id}/send`);

  const events = (await db.pool.query(
    `SELECT event_type, payload FROM commission_events
     WHERE event_type IN ('communication_queued', 'communication_sent', 'communication_failed')
     ORDER BY id`
  )).rows;
  assert.deepEqual(events.map((event) => event.event_type), [
    "communication_queued", "communication_sent", "communication_queued", "communication_failed"
  ]);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("reviewed@example.invalid"), false);
  assert.equal(serialized.includes("Reviewed subject"), false);
  assert.equal(serialized.includes("Reviewed body exactly"), false);
  assert.equal(serialized.includes("fake-message-3811"), false);
  assert.match(serialized, /provider_rejected/);
});

test("the protected send route is exposed without accepting a frontend provider identifier", async () => {
  const ready = await createReadyCommunication();
  const handler = makeHandler(successProvider());
  const unauthorized = await handler(new Request(`${apiUrl}/${ready.id}/send`, { method: "POST" }));
  assert.equal(unauthorized.status, 401);

  const patch = await request(handler, "PATCH", `/${ready.id}`, {
    provider_message_id: "frontend-value"
  });
  assert.equal(patch.status, 400);
});
