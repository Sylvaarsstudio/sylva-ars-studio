import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-communications.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import { createGmailEmailProvider } from "../../netlify/shared/email-provider.mjs";
import {
  isQueuedStale,
  markCommunicationReady,
  reconcileCommunication,
  resolveQueuedCommunicationManually
} from "../../netlify/shared/communications.mjs";

const apiUrl = "http://localhost/admin/api/communications";
const adminPassword = "phase-11c3-password";
const sessionSecret = "phase-11c3-secret";
const nowValue = new Date("2026-10-11T20:00:00.000Z");
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
    "INSERT INTO clients (full_name, email) VALUES ('Recovery Client', 'recovery@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price, sales_tax, shipping)
     VALUES ('SAS-COM-2026-4011', $1, 'Recovery Work', 'Portrait', 'Oil', 400, 24, 20) RETURNING id`,
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

function provider({ reconcileEmail, sendEmail } = {}) {
  return {
    configured: true,
    reconcileEmail: reconcileEmail || (async () => ({
      provider: "fake", result: "inconclusive", code: "provider_reconciliation_error"
    })),
    sendEmail: sendEmail || (async () => {
      throw new Error("sendEmail must not be called during reconciliation.");
    })
  };
}

function makeHandler(emailProvider, clock = () => nowValue) {
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

async function createQueued({ queuedAt = new Date(nowValue.getTime() - 5 * 60 * 1000) } = {}) {
  const draft = (await db.pool.query(
    `INSERT INTO communications (
       client_id, commission_id, channel, communication_type, recipient, subject, body_snapshot
     ) VALUES ($1, $2, 'email', 'general', 'reviewed@example.invalid', 'Reviewed subject', 'Reviewed body exactly.')
     RETURNING *`,
    [clientId, commissionId]
  )).rows[0];
  const ready = await markCommunicationReady(db, draft.id, () => new Date("2026-10-11T19:50:00.000Z"));
  return (await db.pool.query(
    `UPDATE communications
     SET communication_status = 'queued', queued_at = $1
     WHERE id = $2
     RETURNING *`,
    [queuedAt, ready.communication.id]
  )).rows[0];
}

test("reconciliation schema is additive and enforces controlled states", async () => {
  const columns = (await db.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'communications'
       AND column_name IN ('reconciliation_status', 'reconciled_at', 'reconciliation_note')
     ORDER BY column_name`
  )).rows.map((row) => row.column_name);
  assert.deepEqual(columns, ["reconciled_at", "reconciliation_note", "reconciliation_status"]);
  const queued = await createQueued();
  await assert.rejects(
    db.pool.query("UPDATE communications SET reconciliation_status = 'invented' WHERE id = $1", [queued.id]),
    /communications_reconciliation_(status|state)_check/
  );
  await assert.rejects(
    db.pool.query("UPDATE communications SET reconciliation_status = 'confirmed_sent' WHERE id = $1", [queued.id]),
    /communications_reconciliation_state_check/
  );
});

test("stale detection uses the controlled three-minute window without mutating records", async () => {
  assert.equal(isQueuedStale({ communication_status: "queued", queued_at: "2026-10-11T19:58:00Z" }, nowValue), false);
  assert.equal(isQueuedStale({ communication_status: "queued", queued_at: "2026-10-11T19:57:00Z" }, nowValue), true);
  assert.equal(isQueuedStale({ communication_status: "sent", queued_at: "2026-10-11T19:00:00Z" }, nowValue), false);
});

test("Gmail reconciliation is safely unsupported with gmail.send and performs no read or network call", async () => {
  let fetchCalls = 0;
  const gmail = createGmailEmailProvider({
    environmentReader: (name) => ({
      GMAIL_CLIENT_ID: "client", GMAIL_CLIENT_SECRET: "secret",
      GMAIL_REFRESH_TOKEN: "refresh", GMAIL_SENDER_EMAIL: "studio@example.com"
    })[name],
    fetchImplementation: async () => { fetchCalls += 1; }
  });
  assert.deepEqual(await gmail.reconcileEmail({ communication_id: "1" }), {
    provider: "gmail", result: "inconclusive", code: "reconciliation_not_supported_with_current_scope"
  });
  assert.equal(fetchCalls, 0);
});

test("only stale queued communications can reconcile", async () => {
  const recent = await createQueued({ queuedAt: new Date(nowValue.getTime() - 60 * 1000) });
  let response = await request(makeHandler(provider()), "POST", `/${recent.id}/reconcile`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "queued_not_stale");

  await db.pool.query("UPDATE communications SET communication_status = 'sent', sent_at = $1, provider_message_id = 'existing' WHERE id = $2", [nowValue, recent.id]);
  response = await request(makeHandler(provider()), "POST", `/${recent.id}/reconcile`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "reconciliation_not_allowed");
});

test("confirmed sent closes queued without a send call and records only safe audit payload", async () => {
  const queued = await createQueued();
  let sends = 0;
  const result = await reconcileCommunication(db, queued.id, provider({
    reconcileEmail: async () => ({
      provider: "fake", result: "confirmed_sent", provider_message_id: "confirmed-provider-id",
      sent_at: "2026-10-11T19:55:00.000Z"
    }),
    sendEmail: async () => { sends += 1; }
  }), () => nowValue);
  assert.equal(result.result, "confirmed_sent");
  assert.equal(result.communication.communication_status, "sent");
  assert.equal(result.communication.provider_message_id, "confirmed-provider-id");
  assert.equal(new Date(result.communication.sent_at).toISOString(), "2026-10-11T19:55:00.000Z");
  assert.equal(sends, 0);
  const events = (await db.pool.query(
    "SELECT event_type, payload FROM commission_events WHERE commission_id = $1 ORDER BY id",
    [commissionId]
  )).rows;
  assert.deepEqual(events.map((event) => event.event_type), [
    "communication_marked_ready", "communication_reconciliation_started", "communication_reconciled_sent"
  ]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /reviewed@example|Reviewed subject|Reviewed body|confirmed-provider-id/);
});

test("confirmed not sent becomes terminal failed and never auto-retries", async () => {
  const queued = await createQueued();
  let sends = 0;
  const result = await reconcileCommunication(db, queued.id, provider({
    reconcileEmail: async () => ({ provider: "fake", result: "confirmed_not_sent" }),
    sendEmail: async () => { sends += 1; }
  }), () => nowValue);
  assert.equal(result.communication.communication_status, "failed");
  assert.equal(result.communication.reconciliation_status, "confirmed_not_sent");
  assert.equal(result.communication.error_code, "reconciliation_confirmed_not_sent");
  assert.equal(sends, 0);
  const retry = await request(makeHandler(provider()), "POST", `/${queued.id}/send`);
  assert.equal(retry.status, 409);
});

test("inconclusive remains queued, preserves uncertainty, and never sends", async () => {
  const queued = await createQueued();
  let sends = 0;
  const result = await reconcileCommunication(db, queued.id, provider({
    reconcileEmail: async () => ({
      provider: "gmail", result: "inconclusive", code: "reconciliation_not_supported_with_current_scope"
    }),
    sendEmail: async () => { sends += 1; }
  }), () => nowValue);
  assert.equal(result.communication.communication_status, "queued");
  assert.equal(result.communication.reconciliation_status, "inconclusive");
  assert.equal(result.communication.reconciliation_note, "gmail_send_scope_cannot_read_mailbox");
  assert.equal(sends, 0);
});

test("manual resolution requires exact confirmation and never calls the provider", async () => {
  const first = await createQueued();
  await reconcileCommunication(db, first.id, provider(), () => nowValue);
  assert.equal((await resolveQueuedCommunicationManually(db, first.id, "sent", "wrong", () => nowValue)).outcome, "confirmation_required");
  const sent = await resolveQueuedCommunicationManually(
    db, first.id, "sent", "MARK_AS_SENT_VERIFIED_EXTERNALLY", () => nowValue
  );
  assert.equal(sent.communication.communication_status, "sent");
  assert.equal(sent.communication.reconciliation_note, "admin_verified_externally_sent");
  assert.equal(sent.communication.provider_message_id, null);

  const second = await createQueued();
  await reconcileCommunication(db, second.id, provider(), () => nowValue);
  const failed = await resolveQueuedCommunicationManually(
    db, second.id, "failed", "MARK_AS_FAILED_NO_RETRY", () => nowValue
  );
  assert.equal(failed.communication.communication_status, "failed");
  assert.equal(failed.communication.reconciliation_status, "inconclusive");
  assert.equal(failed.communication.error_code, "manual_reconciliation_failed");
});

test("manual endpoints are authenticated and accept only stale inconclusive records", async () => {
  const queued = await createQueued();
  const handler = makeHandler(provider());
  let response = await handler(new Request(`${apiUrl}/${queued.id}/reconcile`, { method: "POST" }));
  assert.equal(response.status, 401);

  response = await request(handler, "POST", `/${queued.id}/reconcile/manual-sent`, {
    confirmation: "MARK_AS_SENT_VERIFIED_EXTERNALLY"
  });
  assert.equal(response.status, 409);
  await request(handler, "POST", `/${queued.id}/reconcile`);
  response = await request(handler, "POST", `/${queued.id}/reconcile/manual-sent`, { confirmation: "wrong" });
  assert.equal(response.status, 400);
});

test("concurrent reconciliation claims call the provider once and a send race cannot duplicate delivery", async () => {
  const queued = await createQueued();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reconcileCalls = 0;
  let sendCalls = 0;
  const fake = provider({
    reconcileEmail: async () => {
      reconcileCalls += 1;
      await gate;
      return { provider: "fake", result: "inconclusive", code: "provider_reconciliation_error" };
    },
    sendEmail: async () => { sendCalls += 1; }
  });
  const handler = makeHandler(fake);
  const first = request(handler, "POST", `/${queued.id}/reconcile`);
  while (reconcileCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = await request(handler, "POST", `/${queued.id}/reconcile`);
  const sendRace = await request(handler, "POST", `/${queued.id}/send`);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "reconciliation_in_progress");
  assert.equal(sendRace.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(reconcileCalls, 1);
  assert.equal(sendCalls, 0);
});
