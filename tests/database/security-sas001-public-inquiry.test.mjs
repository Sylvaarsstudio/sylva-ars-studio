import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler
} from "../../netlify/functions/create-request.mjs";
import {
  getCommunicationAutomationRule,
  listCommunicationAutomationPolicy
} from "../../netlify/shared/communication-automation-policy.mjs";

const functionUrl = "http://localhost/api/inquiries";
const fixedNow = new Date("2026-10-31T18:00:00.000Z");

let database;
let db;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM communications");
  await db?.pool.query("DELETE FROM inquiries");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function environmentReader(name) {
  return {
    TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_SECRET_KEY: "test-secret-key"
  }[name];
}

function validPayload(overrides = {}) {
  return {
    request_id: randomUUID(),
    form_type: "contact",
    client_name: "Security Test Client",
    client_email: "security-test@example.invalid",
    message: "A legitimate public inquiry.",
    turnstile_token: "test-turnstile-token",
    ...overrides
  };
}

function createProvider() {
  const calls = [];
  return {
    calls,
    provider: {
      configured: true,
      async sendEmail(message) {
        calls.push(message);
        return {
          provider: "test",
          provider_message_id: `test-message-${calls.length}`,
          accepted_at: new Date(fixedNow)
        };
      }
    }
  };
}

function buildHandler({
  turnstileVerifier = async () => ({ outcome: "valid" }),
  emailProvider,
  publicSendLimit
} = {}) {
  return createHandler({
    databaseFactory: () => db,
    environmentReader,
    turnstileVerifier,
    emailProvider,
    publicSendLimit,
    now: () => new Date(fixedNow)
  });
}

function submit(handler, body) {
  return handler(new Request(functionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), { ip: "203.0.113.10" });
}

async function sideEffectCounts() {
  return (await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM inquiries) AS inquiries,
      (SELECT count(*)::integer FROM communications) AS communications
  `)).rows[0];
}

test("SAS-001 fails closed when external anti-bot configuration is absent", async () => {
  const { provider, calls } = createProvider();
  const handler = createHandler({
    databaseFactory: () => {
      throw new Error("Database must not be reached without anti-bot configuration.");
    },
    environmentReader: () => undefined,
    turnstileVerifier: async () => {
      throw new Error("Verifier must not be reached without configuration.");
    },
    emailProvider: provider,
    now: () => new Date(fixedNow)
  });

  const response = await submit(handler, validPayload());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "inquiry_verification_unavailable");
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-001 rejects missing anti-bot proof before all side effects", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    turnstileVerifier: async () => {
      verificationCalls += 1;
      return { outcome: "valid" };
    }
  });
  const payload = validPayload();
  delete payload.turnstile_token;

  const response = await submit(handler, payload);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, "inquiry_verification_required");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-001 rejects invalid anti-bot proof before persistence or email", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    turnstileVerifier: async () => ({ outcome: "invalid" })
  });

  const response = await submit(handler, validPayload());
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, "inquiry_verification_failed");
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-001 accepts a valid verified public inquiry", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider });

  const response = await submit(handler, validPayload());

  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 1, communications: 1 });
});

test("SAS-001 global limit returns controlled 429 with zero email calls", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider, publicSendLimit: 0 });

  const response = await submit(handler, validPayload());
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(body.code, "inquiry_rate_limited");
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-001 burst cannot exceed the global automatic send ceiling", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider, publicSendLimit: 2 });
  const responses = [];

  for (let index = 0; index < 5; index += 1) {
    responses.push(await submit(handler, validPayload({
      client_email: `burst-${index}@example.invalid`
    })));
  }

  assert.deepEqual(responses.map((response) => response.status), [200, 200, 429, 429, 429]);
  assert.equal(calls.length, 2);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 2, communications: 2 });
});

test("SAS-001 rejects CR and LF in client_name before verification or email", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    turnstileVerifier: async () => {
      verificationCalls += 1;
      return { outcome: "valid" };
    }
  });

  for (const clientName of ["Attacker\rInjected", "Attacker\nInjected"]) {
    const response = await submit(handler, validPayload({ client_name: clientName }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /control characters/i);
  }

  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-001 preserves an ordinary Unicode human name", async () => {
  const { provider } = createProvider();
  const handler = buildHandler({ emailProvider: provider });
  const clientName = "María José 李";

  const response = await submit(handler, validPayload({ client_name: `  ${clientName}  ` }));
  const stored = (await db.pool.query("SELECT client_name FROM inquiries")).rows[0];

  assert.equal(response.status, 200);
  assert.equal(stored.client_name, clientName);
});

test("SAS-001 valid inquiry creates and sends exactly one confirmation", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider });

  assert.equal((await submit(handler, validPayload())).status, 200);
  const communication = (await db.pool.query("SELECT * FROM communications")).rows[0];

  assert.equal(calls.length, 1);
  assert.equal(communication.automation_key, "inquiry_received_confirmation");
  assert.equal(communication.communication_status, "sent");
  assert.deepEqual(await sideEffectCounts(), { inquiries: 1, communications: 1 });
});

test("SAS-001 duplicate verified retry does not duplicate inquiry, outbox, or email", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider });
  const payload = validPayload();

  assert.equal((await submit(handler, payload)).status, 200);
  assert.equal((await submit(handler, payload)).status, 200);

  assert.equal(calls.length, 1);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 1, communications: 1 });
});

test("SAS-001 keeps other safe automation policies unchanged", () => {
  assert.deepEqual(
    listCommunicationAutomationPolicy()
      .filter((item) => item.mode === "auto_send")
      .map((item) => item.key),
    [
      "inquiry_received_confirmation",
      "quotation_acceptance_confirmation",
      "receipt_delivery",
      "final_invoice_delivery"
    ]
  );
  for (const key of [
    "quotation_acceptance_confirmation",
    "receipt_delivery",
    "final_invoice_delivery"
  ]) {
    assert.equal(getCommunicationAutomationRule(key).mode, "auto_send");
  }
});

test("SAS-001 exports a Netlify-native per-source burst limit", () => {
  assert.deepEqual(config, {
    path: "/api/inquiries",
    rateLimit: {
      action: "rate_limit",
      windowLimit: 10,
      windowSize: 60,
      aggregateBy: ["ip", "domain"]
    }
  });
});
