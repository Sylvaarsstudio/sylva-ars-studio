import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createHandler,
  inquiryFieldLengthLimits,
  maxRequestBodyBytes
} from "../../netlify/functions/create-request.mjs";

const functionUrl = "http://localhost/api/inquiries";
const fixedNow = new Date("2026-11-01T20:00:00.000Z");

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
          provider_message_id: `sas002-${calls.length}`,
          accepted_at: new Date(fixedNow)
        };
      }
    }
  };
}

function buildHandler({ emailProvider, onVerification = () => {} } = {}) {
  return createHandler({
    databaseFactory: () => db,
    environmentReader,
    turnstileVerifier: async () => {
      onVerification();
      return { outcome: "valid" };
    },
    emailProvider,
    now: () => new Date(fixedNow)
  });
}

function validPayload(formType = "contact", overrides = {}) {
  return {
    request_id: randomUUID(),
    form_type: formType,
    client_name: "SAS-002 Test Client",
    client_email: "sas002@example.invalid",
    message: "A valid bounded inquiry.",
    turnstile_token: "test-turnstile-token",
    ...overrides
  };
}

function requestFromBody(body, headers = {}) {
  return new Request(functionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body
  });
}

function submit(handler, payload) {
  return handler(requestFromBody(JSON.stringify(payload)), { ip: "203.0.113.20" });
}

function submitRaw(handler, body, headers) {
  return handler(requestFromBody(body, headers), { ip: "203.0.113.20" });
}

async function sideEffectCounts() {
  return (await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM inquiries) AS inquiries,
      (SELECT count(*)::integer FROM communications) AS communications
  `)).rows[0];
}

function emailWithLength(length) {
  const localPart = "a".repeat(64);
  let remaining = length - localPart.length - 1;
  const labels = [];
  while (remaining > 63) {
    labels.push("b".repeat(63));
    remaining -= 64;
  }
  labels.push("c".repeat(remaining));
  return `${localPart}@${labels.join(".")}`;
}

const fieldBoundaries = [
  {
    field: "form_type",
    formType: "commission_request",
    value: (length) => `commission_request${"x".repeat(length - 18)}`
  },
  { field: "client_name", formType: "contact", value: (length) => "Ñ".repeat(length) },
  { field: "client_email", formType: "contact", value: emailWithLength },
  { field: "client_phone", formType: "artwork_inquiry", value: (length) => "1".repeat(length) },
  { field: "artwork_title", formType: "artwork_inquiry", value: (length) => "A".repeat(length) },
  { field: "artwork_subject", formType: "commission_request", value: (length) => "S".repeat(length) },
  { field: "artwork_size", formType: "commission_request", value: (length) => "Z".repeat(length) },
  { field: "budget_range", formType: "commission_request", value: (length) => "$".repeat(length) },
  {
    field: "estimated_date",
    formType: "commission_request",
    value: (length) => `within_3_months${"x".repeat(length - 15)}`
  },
  {
    field: "occasion",
    formType: "commission_request",
    value: (length) => `wedding_anniversary${"x".repeat(length - 19)}`
  },
  { field: "shipping_location", formType: "artwork_inquiry", value: (length) => "L".repeat(length) },
  { field: "preferred_contact_method", formType: "artwork_inquiry", value: (length) => "E".repeat(length) },
  { field: "reference_notes", formType: "commission_request", value: (length) => "R".repeat(length) },
  { field: "organization_project", formType: "collaboration", value: (length) => "P".repeat(length) },
  { field: "collaboration_type", formType: "collaboration", value: (length) => "C".repeat(length) },
  { field: "message", formType: "contact", value: (length) => "M".repeat(length) },
  {
    field: "request_id",
    formType: "contact",
    value: (length) => `00000000-0000-4000-8000-000000000001${"x".repeat(length - 36)}`
  },
  { field: "turnstile_token", formType: "contact", value: (length) => "T".repeat(length) }
];

assert.deepEqual(
  fieldBoundaries.map(({ field }) => field).sort(),
  Object.keys(inquiryFieldLengthLimits).sort()
);

for (const { field, formType, value } of fieldBoundaries) {
  const limit = inquiryFieldLengthLimits[field];

  test(`SAS-002 accepts ${field} at its ${limit}-character boundary`, async () => {
    const { provider, calls } = createProvider();
    const handler = buildHandler({ emailProvider: provider });
    const response = await submit(handler, validPayload(formType, {
      [field]: value(limit)
    }));

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(await sideEffectCounts(), { inquiries: 1, communications: 1 });
  });

  test(`SAS-002 rejects ${field} above its ${limit}-character boundary`, async () => {
    let verificationCalls = 0;
    const { provider, calls } = createProvider();
    const handler = buildHandler({
      emailProvider: provider,
      onVerification: () => { verificationCalls += 1; }
    });
    const response = await submit(handler, validPayload(formType, {
      [field]: value(limit + 1)
    }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, "inquiry_field_too_long");
    assert.equal(verificationCalls, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
  });
}

test("SAS-002 accepts an exactly 48 KiB valid JSON request envelope", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider });
  const json = JSON.stringify(validPayload());
  const padding = " ".repeat(maxRequestBodyBytes - Buffer.byteLength(json));

  const response = await submitRaw(handler, json + padding);

  assert.equal(Buffer.byteLength(json + padding), maxRequestBodyBytes);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 1, communications: 1 });
});

test("SAS-002 rejects a request envelope above 48 KiB before verification", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    onVerification: () => { verificationCalls += 1; }
  });
  const json = JSON.stringify(validPayload());
  const padding = " ".repeat(maxRequestBodyBytes + 1 - Buffer.byteLength(json));

  const response = await submitRaw(handler, json + padding);
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.code, "inquiry_payload_too_large");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-002 rejects an oversized Content-Length before consuming JSON", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    onVerification: () => { verificationCalls += 1; }
  });

  const response = await submitRaw(
    handler,
    JSON.stringify(validPayload()),
    { "Content-Length": String(maxRequestBodyBytes + 1) }
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "inquiry_payload_too_large");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

for (const scenario of [
  {
    name: "unsupported field",
    payload: validPayload("contact", { attacker_metadata: "unexpected" }),
    code: "inquiry_invalid_fields"
  },
  {
    name: "ambiguous camelCase alias",
    payload: validPayload("contact", { clientName: "Second representation" }),
    code: "inquiry_invalid_fields"
  },
  {
    name: "field belonging to another form type",
    payload: validPayload("contact", { artwork_title: "Not allowed on contact" }),
    code: "inquiry_invalid_fields"
  },
  {
    name: "excessive object key count",
    payload: {
      ...validPayload(),
      ...Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`extra_${index}`, "x"]))
    },
    code: "inquiry_invalid_structure"
  },
  {
    name: "nested object",
    payload: validPayload("contact", { message: { nested: "value" } }),
    code: "inquiry_invalid_structure"
  },
  {
    name: "array value",
    payload: validPayload("contact", { message: ["value"] }),
    code: "inquiry_invalid_structure"
  }
]) {
  test(`SAS-002 rejects ${scenario.name} without side effects`, async () => {
    let verificationCalls = 0;
    const { provider, calls } = createProvider();
    const handler = buildHandler({
      emailProvider: provider,
      onVerification: () => { verificationCalls += 1; }
    });

    const response = await submit(handler, scenario.payload);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, scenario.code);
    assert.equal(verificationCalls, 0);
    assert.equal(calls.length, 0);
    assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
  });
}

test("SAS-002 rejects malformed JSON without side effects", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    onVerification: () => { verificationCalls += 1; }
  });

  const response = await submitRaw(handler, "{not-json");

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "inquiry_invalid_json");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-002 rejects duplicate top-level JSON fields without side effects", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    onVerification: () => { verificationCalls += 1; }
  });
  const payload = validPayload();
  const duplicateJson = `{
    "request_id":"${payload.request_id}",
    "form_type":"contact",
    "client_name":"Duplicate Test",
    "client_email":"duplicate@example.invalid",
    "message":"first",
    "message":"second",
    "turnstile_token":"test-turnstile-token"
  }`;

  const response = await submitRaw(handler, duplicateJson);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "inquiry_invalid_fields");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-002 rejects syntactically invalid email without side effects", async () => {
  let verificationCalls = 0;
  const { provider, calls } = createProvider();
  const handler = buildHandler({
    emailProvider: provider,
    onVerification: () => { verificationCalls += 1; }
  });

  const response = await submit(handler, validPayload("contact", {
    client_email: "not-an-email"
  }));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "inquiry_invalid_fields");
  assert.equal(verificationCalls, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 0, communications: 0 });
});

test("SAS-002 accepts realistic bounded business input for every public form", async () => {
  const { provider, calls } = createProvider();
  const handler = buildHandler({ emailProvider: provider });
  const payloads = [
    validPayload("contact", {
      client_name: "María José 李",
      client_email: "maria@example.invalid",
      message: "Hello Sylva Ars Studio,\n\nI would like to discuss an original artwork.\n\nThank you."
    }),
    validPayload("artwork_inquiry", {
      client_name: "Zoë Hernández",
      client_email: "zoe@example.invalid",
      client_phone: "+1 (717) 555-0100",
      artwork_title: "Still Here",
      shipping_location: "Montréal, Québec, Canada",
      preferred_contact_method: "Email",
      message: "Please share availability, framing details, and insured shipping options."
    }),
    validPayload("commission_request", {
      client_name: "Anaïs Müller",
      client_email: "anais@example.invalid",
      client_phone: "+49 30 123456",
      artwork_subject: "A multi-generational family portrait in a quiet garden setting",
      artwork_size: "24 x 36 in",
      budget_range: "$1,000 - $2,500",
      estimated_date: "within_3_months",
      occasion: "wedding_anniversary",
      shipping_location: "Berlin, Germany",
      reference_notes: "References include several daylight photographs.\nPlease prioritize natural expressions.",
      message: "I am flexible on composition and would welcome the studio's guidance."
    }),
    validPayload("collaboration", {
      client_name: "Søren Dubois",
      client_email: "soren@example.invalid",
      client_phone: "+33 1 55 55 55 55",
      organization_project: "Musée Horizon — contemporary portrait exhibition",
      collaboration_type: "Exhibition",
      estimated_date: "flexible",
      occasion: "none",
      message: "We are planning a collaborative exhibition with an editorial program and public talk."
    })
  ];

  for (const payload of payloads) {
    assert.equal((await submit(handler, payload)).status, 200);
  }

  assert.equal(calls.length, 4);
  assert.deepEqual(await sideEffectCounts(), { inquiries: 4, communications: 4 });
});
