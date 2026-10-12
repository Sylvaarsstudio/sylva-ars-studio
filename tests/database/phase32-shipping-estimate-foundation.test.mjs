import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createHandler as createQuotationHandler
} from "../../netlify/functions/admin-quotations.mjs";
import {
  config as shippingConfig,
  createHandler as createShippingHandler
} from "../../netlify/functions/admin-shipping-estimates.mjs";
import {
  buildShippingEstimateSnapshot,
  getShippingRates,
  normalizeParcel,
  normalizeShippingEstimateSnapshot,
  readShippingOrigin
} from "../../netlify/shared/shipping-rates.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const password = "phase-32-password";
const secret = "phase-32-secret";
const fixedNow = new Date("2026-10-11T16:00:00.000Z");
const originVariables = Object.freeze({
  SHIPPING_ORIGIN_NAME: "Configured Studio",
  SHIPPING_ORIGIN_ADDRESS1: "Private origin address",
  SHIPPING_ORIGIN_ADDRESS2: "",
  SHIPPING_ORIGIN_CITY: "York",
  SHIPPING_ORIGIN_STATE: "PA",
  SHIPPING_ORIGIN_POSTAL_CODE: "17402",
  SHIPPING_ORIGIN_COUNTRY: "US"
});

let database;
let db;
let cookie;
let quotationHandler;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  quotationHandler = createQuotationHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({
      ADMIN_PASSWORD: password,
      ADMIN_SESSION_SECRET: secret
    })[name],
    now: () => new Date(fixedNow)
  });
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Estimate Client', 'estimate@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       price, sales_tax, shipping, status
     ) VALUES (
       'SAS-COM-2026-9951', $1, 'Shipping Estimate',
       'Phase 10B.5A test', 'Oil', 400, 24, 20, 'draft'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function environmentReader(overrides = {}) {
  const variables = {
    ADMIN_PASSWORD: password,
    ADMIN_SESSION_SECRET: secret,
    ...originVariables,
    ...overrides
  };
  return (name) => variables[name];
}

function estimateBody(overrides = {}) {
  return {
    destination: {
      recipient_name: "Estimate Recipient",
      address_line1: "100 Destination Avenue",
      address_line2: null,
      city: "Pittsburgh",
      state_region: "PA",
      postal_code: "15222",
      country: "US",
      ...(overrides.destination || {})
    },
    parcel: {
      length: "24",
      width: "20",
      height: "4",
      dimension_unit: "in",
      weight: "12",
      weight_unit: "lb",
      ...(overrides.parcel || {})
    }
  };
}

function normalizedRate(overrides = {}) {
  return {
    provider: "fixture-provider",
    carrier: "Fixture Carrier",
    service: "Ground",
    amount: "35.00",
    currency: "USD",
    estimated_days: 4,
    rate_id: "fixture-rate-1",
    generated_at: "2026-10-11T16:00:00.000Z",
    expires_at: "2026-10-11T17:00:00.000Z",
    ...overrides
  };
}

function shippingRequest(handler, body = estimateBody(), authenticated = true) {
  return handler(new Request("http://localhost/admin/api/shipping/estimate", {
    method: "POST",
    headers: {
      ...(authenticated ? { Cookie: cookie } : {}),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }));
}

function quotationRequest(path, method = "GET", body) {
  return quotationHandler(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

async function createDraft() {
  const response = await quotationRequest(
    `/admin/api/commissions/${commissionId}/quotations`,
    "POST",
    { request_id: randomUUID() }
  );
  return (await response.json()).quotation;
}

test("shipping estimate endpoint is a protected Admin-only path", async () => {
  assert.equal(shippingConfig.path, "/admin/api/shipping/estimate");
  const handler = createShippingHandler({
    environmentReader: environmentReader(),
    rateProvider: { async getShippingRates() { return [normalizedRate()]; } }
  });
  assert.equal((await shippingRequest(handler, estimateBody(), false)).status, 401);
  const methodResponse = await handler(new Request(
    "http://localhost/admin/api/shipping/estimate",
    { method: "GET", headers: { Cookie: cookie } }
  ));
  assert.equal(methodResponse.status, 405);
});

test("shipping origin is server-side environment configuration and incomplete config is explicit", async () => {
  const configured = readShippingOrigin(environmentReader());
  assert.equal(configured.configured, true);
  assert.equal(configured.origin.address_line1, "Private origin address");

  const handler = createShippingHandler({
    environmentReader: environmentReader({ SHIPPING_ORIGIN_POSTAL_CODE: undefined })
  });
  const response = await shippingRequest(handler);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "shipping_origin_not_configured");
  assert.equal(JSON.stringify(body).includes("Private origin address"), false);
  assert.equal("missing" in body, false);
});

test("destination validation rejects missing required address data", async () => {
  const handler = createShippingHandler({ environmentReader: environmentReader() });
  const response = await shippingRequest(handler, estimateBody({
    destination: { address_line1: "" }
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /Address line 1 is required/);
});

test("parcel validation enforces positive finite dimensions, weight, units, and reasonable limits", async () => {
  for (const [field, value] of [
    ["length", "0"],
    ["width", "-1"],
    ["height", "Infinity"],
    ["length", "201"],
    ["weight", "0"],
    ["weight", "501"]
  ]) {
    const result = normalizeParcel({
      ...estimateBody().parcel,
      [field]: value
    });
    assert.match(result.error, /greater than 0/);
  }
  assert.equal(
    normalizeParcel({ ...estimateBody().parcel, dimension_unit: "cm" }).error,
    "Dimension unit must be in."
  );
  assert.equal(
    normalizeParcel({ ...estimateBody().parcel, weight_unit: "kg" }).error,
    "Weight unit must be lb."
  );
});

test("unconfigured provider returns no invented rate", async () => {
  const handler = createShippingHandler({ environmentReader: environmentReader() });
  const response = await shippingRequest(handler);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "rate_provider_not_configured");
  assert.equal(body.message, "Live shipping rates are not configured yet.");
  assert.equal("rates" in body, false);
});

test("injected provider adapter receives normalized context and returns normalized rates", async () => {
  let received;
  const handler = createShippingHandler({
    environmentReader: environmentReader({ SHIPPING_PROVIDER_SECRET: "never-return-this" }),
    rateProvider: {
      async getShippingRates(context) {
        received = context;
        return [normalizedRate({ amount: "35" })];
      }
    }
  });
  const response = await shippingRequest(handler);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.origin.address_line1, "Private origin address");
  assert.equal(received.parcel.length, 24);
  assert.equal(body.rates[0].amount, "35.00");
  assert.equal(body.rates[0].carrier, "Fixture Carrier");
  assert.equal("origin" in body, false);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("Private origin address"), false);
  assert.equal(serialized.includes("never-return-this"), false);
});

test("provider contract rejects malformed output instead of presenting a fake rate", async () => {
  const result = await getShippingRates({
    origin: readShippingOrigin(environmentReader()).origin,
    ...estimateBody()
  }, {
    async getShippingRates() {
      return [normalizedRate({ amount: "not-money" })];
    }
  });
  assert.equal(result.outcome, "invalid_provider_response");
  assert.deepEqual(result.rates, []);
});

test("migration adds the nullable snapshot and issued-row immutability", async () => {
  const column = (await db.pool.query(
    `SELECT is_nullable, data_type
     FROM information_schema.columns
     WHERE table_name = 'quotations'
       AND column_name = 'shipping_estimate_snapshot'`
  )).rows[0];
  assert.deepEqual(column, { is_nullable: "YES", data_type: "jsonb" });
  const draft = await createDraft();
  await assert.rejects(
    db.pool.query(
      "UPDATE quotations SET shipping_estimate_snapshot = '[]'::jsonb WHERE id = $1",
      [draft.id]
    ),
    (error) => error.code === "23514"
  );
});

test("draft stores only a validated estimate snapshot without silently changing Shipping Charge", async () => {
  const draft = await createDraft();
  const estimate = buildShippingEstimateSnapshot(
    normalizedRate(),
    estimateBody().destination,
    estimateBody().parcel
  ).value;
  const response = await quotationRequest(
    `/admin/api/quotations/${draft.id}`,
    "PATCH",
    { shipping_estimate_snapshot: estimate }
  );
  assert.equal(response.status, 200);
  const updated = (await response.json()).quotation;
  assert.equal(updated.shipping_charge, "20.00");
  assert.equal(updated.shipping_estimate_snapshot.estimated_amount, "35.00");
  assert.deepEqual(Object.keys(updated.shipping_estimate_snapshot.destination), [
    "city", "country", "postal_code", "state_region"
  ]);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_events WHERE commission_id = $1",
    [commissionId]
  )).rows[0].count, 1);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations"
  )).rows[0].count, 0);
});

test("arbitrary or privacy-expanding estimate snapshots are rejected", async () => {
  const draft = await createDraft();
  const estimate = buildShippingEstimateSnapshot(
    normalizedRate(),
    estimateBody().destination,
    estimateBody().parcel
  ).value;
  const arbitrary = {
    ...estimate,
    destination: {
      ...estimate.destination,
      address_line1: "Do not persist this"
    }
  };
  const response = await quotationRequest(
    `/admin/api/quotations/${draft.id}`,
    "PATCH",
    { shipping_estimate_snapshot: arbitrary }
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /unsupported field: address_line1/);
  assert.match(
    normalizeShippingEstimateSnapshot({ ...estimate, unexpected: true }).error,
    /unsupported field: unexpected/
  );
});

test("explicit draft update can align Shipping Charge while deposit stays price-only", async () => {
  const draft = await createDraft();
  const estimate = buildShippingEstimateSnapshot(
    normalizedRate(),
    estimateBody().destination,
    estimateBody().parcel
  ).value;
  const response = await quotationRequest(
    `/admin/api/quotations/${draft.id}`,
    "PATCH",
    {
      shipping_estimate_snapshot: estimate,
      shipping_charge: estimate.estimated_amount
    }
  );
  const updated = (await response.json()).quotation;
  assert.equal(updated.shipping_charge, "35.00");
  assert.equal(updated.required_deposit, "200.00");
  assert.equal(updated.sales_tax, "24.00");
});

test("issue preserves estimate and uses Shipping Charge—not estimate directly—in totals", async () => {
  const draft = await createDraft();
  const estimate = buildShippingEstimateSnapshot(
    normalizedRate({ amount: "35.00" }),
    estimateBody().destination,
    estimateBody().parcel
  ).value;
  await quotationRequest(
    `/admin/api/quotations/${draft.id}`,
    "PATCH",
    {
      shipping_estimate_snapshot: estimate,
      shipping_charge: "40.00"
    }
  );
  const issue = await quotationRequest(
    `/admin/api/quotations/${draft.id}/issue`,
    "POST"
  );
  const issued = (await issue.json()).quotation;
  assert.equal(issued.quotation_snapshot.commercial.shipping_charge, "40.00");
  assert.equal(issued.quotation_snapshot.commercial.total, "464.00");
  assert.equal(issued.quotation_snapshot.commercial.required_deposit, "200.00");
  assert.equal(
    issued.quotation_snapshot.commercial.shipping_estimate.estimated_amount,
    "35.00"
  );
  assert.equal(
    (await quotationRequest(
      `/admin/api/quotations/${draft.id}`,
      "PATCH",
      { shipping_estimate_snapshot: null }
    )).status,
    409
  );
  await assert.rejects(
    db.pool.query(
      "UPDATE quotations SET shipping_estimate_snapshot = NULL WHERE id = $1",
      [draft.id]
    ),
    /immutable/i
  );
});

test("new draft version copies the estimate snapshot for explicit revision", async () => {
  const draft = await createDraft();
  const estimate = buildShippingEstimateSnapshot(
    normalizedRate(),
    estimateBody().destination,
    estimateBody().parcel
  ).value;
  await quotationRequest(
    `/admin/api/quotations/${draft.id}`,
    "PATCH",
    { shipping_estimate_snapshot: estimate }
  );
  await quotationRequest(`/admin/api/quotations/${draft.id}/issue`, "POST");
  const response = await quotationRequest(
    `/admin/api/quotations/${draft.id}/new-version`,
    "POST"
  );
  const next = (await response.json()).quotation;
  assert.equal(next.quotation_status, "draft");
  assert.deepEqual(next.shipping_estimate_snapshot, estimate);
});
