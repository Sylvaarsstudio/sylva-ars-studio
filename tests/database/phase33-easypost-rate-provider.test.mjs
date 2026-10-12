import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHandler as createShippingHandler
} from "../../netlify/functions/admin-shipping-estimates.mjs";
import {
  EASYPOST_SHIPMENTS_ENDPOINT,
  ShippingRateProviderError,
  buildEasyPostShipmentPayload,
  createEasyPostRateProvider,
  poundsToOunces
} from "../../netlify/shared/easypost-rate-provider.mjs";
import {
  buildShippingEstimateSnapshot
} from "../../netlify/shared/shipping-rates.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const password = "phase-33-password";
const secret = "phase-33-secret";
const apiKey = "EZTK-safe-test-key";
const fixedNow = new Date("2026-10-11T18:30:00.000Z");
const origin = Object.freeze({
  name: "Configured Studio",
  address_line1: "Private origin address",
  address_line2: null,
  city: "York",
  state_region: "PA",
  postal_code: "17402",
  country: "US"
});
const destination = Object.freeze({
  recipient_name: "Estimate Recipient",
  address_line1: "100 Destination Avenue",
  address_line2: "Suite 2",
  city: "Pittsburgh",
  state_region: "PA",
  postal_code: "15222",
  country: "US"
});
const parcel = Object.freeze({
  length: 24,
  width: 20,
  height: 4,
  dimension_unit: "in",
  weight: 12,
  weight_unit: "lb"
});

const cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;

function environmentReader(overrides = {}) {
  const variables = {
    ADMIN_PASSWORD: password,
    ADMIN_SESSION_SECRET: secret,
    SHIPPING_ORIGIN_NAME: origin.name,
    SHIPPING_ORIGIN_ADDRESS1: origin.address_line1,
    SHIPPING_ORIGIN_ADDRESS2: "",
    SHIPPING_ORIGIN_CITY: origin.city,
    SHIPPING_ORIGIN_STATE: origin.state_region,
    SHIPPING_ORIGIN_POSTAL_CODE: origin.postal_code,
    SHIPPING_ORIGIN_COUNTRY: origin.country,
    EASYPOST_API_KEY: apiKey,
    ...overrides
  };
  return (name) => variables[name];
}

function estimateBody(overrides = {}) {
  return {
    destination: { ...destination, ...(overrides.destination || {}) },
    parcel: { ...parcel, ...(overrides.parcel || {}) }
  };
}

function easyPostRate(overrides = {}) {
  return {
    id: "rate_easypost_1",
    carrier: "USPS",
    service: "Priority",
    rate: "35.00",
    retail_rate: "99.00",
    list_rate: "88.00",
    currency: "USD",
    delivery_days: 2,
    created_at: "2026-10-11T18:00:00.000Z",
    ...overrides
  };
}

function shippingRequest(handler, body = estimateBody()) {
  return handler(new Request("http://localhost/admin/api/shipping/estimate", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }));
}

test("missing EASYPOST_API_KEY preserves the provider-not-configured contract", async () => {
  const handler = createShippingHandler({
    environmentReader: environmentReader({ EASYPOST_API_KEY: undefined })
  });
  const response = await shippingRequest(handler);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "rate_provider_not_configured");
  assert.equal(JSON.stringify(body).includes(apiKey), false);
});

test("EasyPost Shipment request uses Basic Auth and maps origin, destination, and lb to oz", async () => {
  let captured;
  const handler = createShippingHandler({
    environmentReader: environmentReader(),
    fetchImplementation: async (url, options) => {
      captured = { url, options };
      return Response.json({
        id: "shp_rating_only",
        rates: [
          easyPostRate({ id: "rate_slow", carrier: "UPS", service: "Ground", rate: "40.00" }),
          easyPostRate(),
          easyPostRate({ id: "", rate: "1.00" }),
          easyPostRate({ id: "rate_zero", rate: "0.00" })
        ]
      });
    },
    providerTimeoutMs: 100
  });
  const response = await shippingRequest(handler);
  const body = await response.json();
  const providerPayload = JSON.parse(captured.options.body);

  assert.equal(captured.url, EASYPOST_SHIPMENTS_ENDPOINT);
  assert.equal(captured.options.method, "POST");
  assert.equal(
    captured.options.headers.Authorization,
    `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`
  );
  assert.deepEqual(Object.keys(providerPayload), ["shipment"]);
  assert.deepEqual(Object.keys(providerPayload.shipment), [
    "from_address", "to_address", "parcel"
  ]);
  assert.deepEqual(providerPayload.shipment.from_address, {
    name: origin.name,
    street1: origin.address_line1,
    city: origin.city,
    state: origin.state_region,
    zip: origin.postal_code,
    country: origin.country
  });
  assert.deepEqual(providerPayload.shipment.to_address, {
    name: destination.recipient_name,
    street1: destination.address_line1,
    street2: destination.address_line2,
    city: destination.city,
    state: destination.state_region,
    zip: destination.postal_code,
    country: destination.country
  });
  assert.deepEqual(providerPayload.shipment.parcel, {
    length: 24,
    width: 20,
    height: 4,
    weight: 192
  });
  assert.equal(poundsToOunces(12), 192);
  assert.equal(response.status, 200);
  assert.equal(body.rates.length, 2);
  assert.equal(body.rates[0].provider, "easypost");
  assert.equal(body.rates[0].amount, "35.00");
  assert.equal(body.rates[0].rate_id, "rate_easypost_1");
  assert.equal(body.rates[0].generated_at, "2026-10-11T18:00:00.000Z");
  assert.equal(body.rates[0].expires_at, null);
  assert.equal(JSON.stringify(body).includes("99.00"), false);
  assert.equal(JSON.stringify(body).includes("88.00"), false);
  assert.equal(JSON.stringify(body).includes("shp_rating_only"), false);
  assert.equal(JSON.stringify(body).includes(origin.address_line1), false);
  assert.equal(JSON.stringify(body).includes(apiKey), false);
});

test("Shipment payload contains no customs, insurance, buy, or carrier-specific options", () => {
  const payload = buildEasyPostShipmentPayload({ origin, destination, parcel });
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "customs", "insurance", "buy", "delivery_confirmation", "carrier_accounts", "options"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("international destinations are rejected before EasyPost is called", async () => {
  let called = false;
  const handler = createShippingHandler({
    environmentReader: environmentReader(),
    fetchImplementation: async () => {
      called = true;
      return Response.json({ rates: [] });
    }
  });
  const response = await shippingRequest(handler, estimateBody({
    destination: { country: "CA" }
  }));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "international_shipping_not_supported_yet");
  assert.equal(called, false);
});

test("provider HTTP failures are normalized without raw provider details", async () => {
  for (const [status, providerBody, expectedCode, expectedStatus] of [
    [401, { error: { code: "UNAUTHORIZED", message: "secret auth detail" } }, "provider_authentication_failed", 502],
    [429, { error: { code: "RATE_LIMIT", message: "raw limit detail" } }, "provider_rate_limit", 503],
    [503, { error: { code: "INTERNAL", message: "raw outage detail" } }, "provider_unavailable", 503],
    [422, { error: { code: "ADDRESS.INVALID", message: "full address rejected" } }, "invalid_shipping_address", 422],
    [422, { error: { code: "PARCEL.INVALID", message: "weight rejected" } }, "invalid_parcel", 422]
  ]) {
    const handler = createShippingHandler({
      environmentReader: environmentReader(),
      fetchImplementation: async () => Response.json(providerBody, { status })
    });
    const response = await shippingRequest(handler);
    const body = await response.json();
    assert.equal(response.status, expectedStatus);
    assert.equal(body.code, expectedCode);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("secret auth detail"), false);
    assert.equal(serialized.includes("raw limit detail"), false);
    assert.equal(serialized.includes("raw outage detail"), false);
    assert.equal(serialized.includes("full address rejected"), false);
    assert.equal(serialized.includes("weight rejected"), false);
  }
});

test("timeout and network failures normalize to provider_unavailable", async () => {
  const provider = createEasyPostRateProvider({
    apiKey,
    timeoutMs: 5,
    fetchImplementation: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  await assert.rejects(
    provider.getShippingRates({ origin, destination, parcel }),
    (error) => error instanceof ShippingRateProviderError
      && error.code === "provider_unavailable"
  );
  const networkProvider = createEasyPostRateProvider({
    apiKey,
    fetchImplementation: async () => {
      throw new TypeError("network failed");
    }
  });
  await assert.rejects(
    networkProvider.getShippingRates({ origin, destination, parcel }),
    (error) => error instanceof ShippingRateProviderError
      && error.code === "provider_unavailable"
  );
});

test("malformed responses and responses without valid rates have distinct safe errors", async () => {
  const cases = [
    [{ not_rates: [] }, "shipping_rate_error"],
    [{ rates: [easyPostRate({ id: "", rate: "not-money" })] }, "no_rates_available"]
  ];
  for (const [providerBody, expectedCode] of cases) {
    const provider = createEasyPostRateProvider({
      apiKey,
      fetchImplementation: async () => Response.json(providerBody)
    });
    await assert.rejects(
      provider.getShippingRates({ origin, destination, parcel }),
      (error) => error.code === expectedCode
    );
  }
});

test("selected EasyPost rate produces the minimal existing Quotation snapshot", async () => {
  const provider = createEasyPostRateProvider({
    apiKey,
    now: () => new Date(fixedNow),
    fetchImplementation: async () => Response.json({
      id: "shp_do_not_persist",
      rates: [easyPostRate({ created_at: null })]
    })
  });
  const [rate] = await provider.getShippingRates({ origin, destination, parcel });
  const snapshot = buildShippingEstimateSnapshot(rate, destination, parcel).value;
  assert.equal(snapshot.provider, "easypost");
  assert.equal(snapshot.rate_id, "rate_easypost_1");
  assert.equal(snapshot.generated_at, fixedNow.toISOString());
  assert.deepEqual(Object.keys(snapshot.destination), [
    "city", "state_region", "postal_code", "country"
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("shp_do_not_persist"), false);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes(destination.address_line1), false);
});
