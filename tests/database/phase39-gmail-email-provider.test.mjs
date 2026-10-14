import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-communications.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import {
  GMAIL_SEND_URL,
  GMAIL_TOKEN_URL,
  buildPlainTextMimeMessage,
  createGmailEmailProvider,
  encodeBase64Url,
  isGmailProviderConfigured
} from "../../netlify/shared/email-provider.mjs";
import { markCommunicationReady } from "../../netlify/shared/communications.mjs";

const gmailValues = Object.freeze({
  GMAIL_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GMAIL_CLIENT_SECRET: "client-secret-value",
  GMAIL_REFRESH_TOKEN: "refresh-token-value",
  GMAIL_SENDER_EMAIL: "studio@example.com"
});
const acceptedAt = new Date("2026-10-11T19:00:00.000Z");

function environmentReader(overrides = {}) {
  const values = { ...gmailValues, ...overrides };
  return (name) => values[name];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function message(overrides = {}) {
  return {
    to: "client@example.com",
    subject: "A Shared Legacy — revisión",
    text: "First line.\nSecond line exactly.",
    idempotency_key: "communication:42",
    metadata: { communication_id: "42", communication_type: "quotation" },
    ...overrides
  };
}

test("Gmail configuration requires all four server-side values", async () => {
  assert.equal(isGmailProviderConfigured(environmentReader()), true);
  assert.equal(isGmailProviderConfigured(environmentReader({ GMAIL_REFRESH_TOKEN: "" })), false);
  let calls = 0;
  const provider = createGmailEmailProvider({
    environmentReader: environmentReader({ GMAIL_CLIENT_SECRET: undefined }),
    fetchImplementation: async () => { calls += 1; }
  });
  assert.equal(provider.configured, false);
  await assert.rejects(provider.sendEmail(message()), (error) => error.code === "provider_not_configured");
  assert.equal(calls, 0);
});

test("plain-text MIME is UTF-8 safe, header-injection resistant, and base64url encoded", () => {
  const mime = buildPlainTextMimeMessage({ from: gmailValues.GMAIL_SENDER_EMAIL, ...message() });
  const encodedSubject = Buffer.from(message().subject, "utf8").toString("base64");
  assert.match(mime, /^From: studio@example\.com\r\nTo: client@example\.com\r\n/);
  assert.match(mime, new RegExp(`Subject: =\\?UTF-8\\?B\\?${encodedSubject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?=`));
  assert.match(mime, /MIME-Version: 1\.0/);
  assert.match(mime, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(mime, /Content-Transfer-Encoding: 8bit/);
  assert.match(mime, /X-SAS-Communication-ID: 42/);
  assert.match(mime, /X-SAS-Idempotency-Key: communication:42/);
  assert.equal(mime.split("\r\n\r\n")[1], message().text);

  const base64url = encodeBase64Url(mime);
  assert.doesNotMatch(base64url, /[+/=]/);
  assert.equal(Buffer.from(base64url, "base64url").toString("utf8"), mime);
  assert.throws(
    () => buildPlainTextMimeMessage({ from: gmailValues.GMAIL_SENDER_EMAIL, ...message({ subject: "Safe\r\nBcc: victim@example.com" }) }),
    (error) => error.code === "provider_rejected"
  );
  assert.throws(
    () => buildPlainTextMimeMessage({ from: "studio@example.com\nBcc: victim@example.com", ...message() }),
    (error) => error.code === "provider_rejected"
  );
  assert.throws(
    () => buildPlainTextMimeMessage({ from: gmailValues.GMAIL_SENDER_EMAIL, ...message({ to: "client@example.com\nCc: victim@example.com" }) }),
    (error) => error.code === "provider_rejected"
  );
});

test("OAuth refresh and Gmail send use the exact REST contract and normalize success", async () => {
  const calls = [];
  const provider = createGmailEmailProvider({
    environmentReader: environmentReader(),
    now: () => acceptedAt,
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      if (url === GMAIL_TOKEN_URL) return jsonResponse({ access_token: "request-only-access-token", token_type: "Bearer" });
      return jsonResponse({ id: "gmail-message-abc", threadId: "gmail-thread-raw" });
    }
  });
  const result = await provider.sendEmail(message());
  assert.deepEqual(result, {
    provider: "gmail",
    provider_message_id: "gmail-message-abc",
    accepted_at: acceptedAt
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, GMAIL_TOKEN_URL);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  const tokenForm = new URLSearchParams(calls[0].options.body);
  assert.equal(tokenForm.get("client_id"), gmailValues.GMAIL_CLIENT_ID);
  assert.equal(tokenForm.get("client_secret"), gmailValues.GMAIL_CLIENT_SECRET);
  assert.equal(tokenForm.get("refresh_token"), gmailValues.GMAIL_REFRESH_TOKEN);
  assert.equal(tokenForm.get("grant_type"), "refresh_token");

  assert.equal(calls[1].url, GMAIL_SEND_URL);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.Authorization, "Bearer request-only-access-token");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  const raw = JSON.parse(calls[1].options.body).raw;
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.equal(mime.split("\r\n\r\n")[1], message().text);
  assert.match(mime, /From: studio@example\.com/);
  assert.match(mime, /To: client@example\.com/);
  assert.equal(JSON.stringify(result).includes("request-only-access-token"), false);
  assert.equal(JSON.stringify(result).includes("gmail-thread-raw"), false);
});

test("OAuth errors and token timeouts are normalized without leaking Google responses", async (context) => {
  await context.test("invalid_grant", async () => {
    const logs = [];
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      fetchImplementation: async () => jsonResponse({
        error: "invalid_grant",
        error_description: `Rejected ${gmailValues.GMAIL_REFRESH_TOKEN}`
      }, 400),
      logger: (...entry) => logs.push(entry)
    });
    await assert.rejects(provider.sendEmail(message()), (error) => {
      assert.equal(error.code, "provider_authentication_failed");
      assert.equal(error.message.includes(gmailValues.GMAIL_REFRESH_TOKEN), false);
      return true;
    });
    assert.deepEqual(logs, [["gmail_provider_error", {
      stage: "token_exchange",
      status: 400,
      google_error: "invalid_grant",
      message: "Rejected [redacted]"
    }]]);
    assert.equal(JSON.stringify(logs).includes(gmailValues.GMAIL_REFRESH_TOKEN), false);
    assert.equal(JSON.stringify(logs).includes(gmailValues.GMAIL_CLIENT_SECRET), false);
  });

  await context.test("timeout", async () => {
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      timeoutMs: 5,
      fetchImplementation: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    });
    await assert.rejects(provider.sendEmail(message()), (error) => error.code === "send_timeout");
  });
});

for (const [status, expected] of [
  [401, "provider_authentication_failed"],
  [403, "provider_rejected"],
  [429, "provider_rate_limit"],
  [503, "provider_unavailable"],
  [400, "provider_rejected"]
]) {
  test(`Gmail ${status} normalizes as ${expected}`, async () => {
    let call = 0;
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      fetchImplementation: async () => {
        call += 1;
        return call === 1
          ? jsonResponse({ access_token: "access-token" })
          : jsonResponse({ error: { message: "raw Google detail" } }, status);
      }
    });
    await assert.rejects(provider.sendEmail(message()), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.message.includes("raw Google detail"), false);
      return true;
    });
  });
}

test("valid OAuth plus Gmail send-as rejection is distinct and safely diagnosed", async () => {
  let call = 0;
  const logs = [];
  const provider = createGmailEmailProvider({
    environmentReader: environmentReader(),
    logger: (...entry) => logs.push(entry),
    fetchImplementation: async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ access_token: "ephemeral-access-token" })
        : jsonResponse({
            error: {
              code: 403,
              message: `From studio@example.com to ${message().to} is not authorized. ${message().text}`,
              errors: [{ reason: "forbidden" }]
            }
          }, 403);
    }
  });

  await assert.rejects(
    provider.sendEmail(message()),
    (error) => error.code === "provider_rejected"
  );
  assert.deepEqual(logs, [["gmail_provider_error", {
    stage: "gmail_send",
    status: 403,
    google_error: "forbidden",
    message: "From [redacted] to [redacted] is not authorized. [redacted]"
  }]]);
  const serialized = JSON.stringify(logs);
  for (const forbidden of [
    gmailValues.GMAIL_CLIENT_ID,
    gmailValues.GMAIL_CLIENT_SECRET,
    gmailValues.GMAIL_REFRESH_TOKEN,
    "ephemeral-access-token",
    "studio@example.com",
    message().to,
    message().text
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("Gmail API 401 is diagnosed at gmail_send while remaining authentication failure", async () => {
  let call = 0;
  const logs = [];
  const provider = createGmailEmailProvider({
    environmentReader: environmentReader(),
    logger: (...entry) => logs.push(entry),
    fetchImplementation: async () => (++call === 1
      ? jsonResponse({ access_token: "ephemeral-access-token" })
      : jsonResponse({ error: {
          code: 401,
          message: "Invalid Credentials",
          errors: [{ reason: "authError" }]
        } }, 401))
  });

  await assert.rejects(
    provider.sendEmail(message()),
    (error) => error.code === "provider_authentication_failed"
  );
  assert.deepEqual(logs, [["gmail_provider_error", {
    stage: "gmail_send",
    status: 401,
    google_error: "authError",
    message: "Invalid Credentials"
  }]]);
});

test("network failures, Gmail timeout, and malformed success are safely normalized", async (context) => {
  await context.test("network", async () => {
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      fetchImplementation: async () => { throw new TypeError("network detail"); }
    });
    await assert.rejects(provider.sendEmail(message()), (error) => error.code === "provider_unavailable");
  });

  await context.test("Gmail timeout", async () => {
    let call = 0;
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      timeoutMs: 5,
      fetchImplementation: async (_url, options) => {
        call += 1;
        if (call === 1) return jsonResponse({ access_token: "access-token" });
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
    });
    await assert.rejects(provider.sendEmail(message()), (error) => error.code === "send_timeout");
  });

  await context.test("malformed response", async () => {
    let call = 0;
    const provider = createGmailEmailProvider({
      environmentReader: environmentReader(),
      fetchImplementation: async () => (++call === 1
        ? jsonResponse({ access_token: "access-token" })
        : jsonResponse({ threadId: "missing-id" }))
    });
    await assert.rejects(provider.sendEmail(message()), (error) => error.code === "send_error");
  });
});

let database;
let db;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("the existing send endpoint wires Gmail without auto-send and persists only normalized output", async () => {
  const clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Gmail Client', 'live@example.com') RETURNING id"
  )).rows[0].id;
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-3911', $1, 'Gmail Work', 'Portrait', 'Oil', 500) RETURNING id`,
    [clientId]
  )).rows[0].id;
  const draft = (await db.pool.query(
    `INSERT INTO communications (
       client_id, commission_id, channel, communication_type, recipient, subject, body_snapshot
     ) VALUES ($1, $2, 'email', 'general', 'reviewed@example.com', 'Reviewed ü subject', 'Reviewed body.\nExact second line.')
     RETURNING *`,
    [clientId, commissionId]
  )).rows[0];
  await markCommunicationReady(db, draft.id, () => new Date("2026-10-11T18:59:00.000Z"));
  await db.pool.query("UPDATE clients SET email = 'changed@example.com' WHERE id = $1", [clientId]);

  const googleCalls = [];
  const adminPassword = "phase-11c2-password";
  const sessionSecret = "phase-11c2-secret";
  const env = environmentReader({ ADMIN_PASSWORD: adminPassword, ADMIN_SESSION_SECRET: sessionSecret });
  const handler = createHandler({
    databaseFactory: () => db,
    environmentReader: env,
    providerFetch: async (url, options) => {
      googleCalls.push({ url, options });
      return url === GMAIL_TOKEN_URL
        ? jsonResponse({ access_token: "ephemeral-access-token" })
        : jsonResponse({ id: "gmail-persisted-id", extra: "raw-response-field" });
    },
    clock: () => acceptedAt
  });
  assert.equal(googleCalls.length, 0);
  const cookie = `${COOKIE_NAME}=${await createSessionToken(adminPassword, sessionSecret)}`;
  const sendRequest = () => handler(new Request(`http://localhost/admin/api/communications/${draft.id}/send`, {
    method: "POST", headers: { Cookie: cookie }
  }));
  const first = await sendRequest();
  const body = await first.json();
  assert.equal(first.status, 200);
  assert.equal(body.provider, "gmail");
  assert.equal(body.communication.provider_message_id, "gmail-persisted-id");
  assert.equal(new Date(body.communication.sent_at).toISOString(), acceptedAt.toISOString());
  assert.equal(googleCalls.length, 2);
  const mime = Buffer.from(JSON.parse(googleCalls[1].options.body).raw, "base64url").toString("utf8");
  assert.match(mime, /To: reviewed@example\.com/);
  assert.doesNotMatch(mime, /changed@example\.com/);
  assert.equal(mime.split("\r\n\r\n")[1], "Reviewed body.\nExact second line.");

  const retry = await sendRequest();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).changed, false);
  assert.equal(googleCalls.length, 2);

  const stored = (await db.pool.query("SELECT * FROM communications WHERE id = $1", [draft.id])).rows[0];
  const serialized = JSON.stringify(stored);
  for (const forbidden of [
    gmailValues.GMAIL_CLIENT_SECRET, gmailValues.GMAIL_REFRESH_TOKEN,
    "ephemeral-access-token", "raw-response-field"
  ]) assert.equal(serialized.includes(forbidden), false);
  const eventPayloads = JSON.stringify((await db.pool.query(
    "SELECT payload FROM commission_events WHERE source_type = 'communication' AND source_id = $1 ORDER BY id",
    [String(draft.id)]
  )).rows);
  assert.equal(eventPayloads.includes("reviewed@example.com"), false);
  assert.equal(eventPayloads.includes("Reviewed body"), false);
  assert.equal(eventPayloads.includes("gmail-persisted-id"), false);

  await db.pool.query("TRUNCATE communications RESTART IDENTITY");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});
