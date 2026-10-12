import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  CONTRACT_ELIGIBILITY_API_PATH,
  SHIPPING_ESTIMATE_API_PATH,
  buildAcceptancePayload,
  buildPayload,
  buildShippingEstimateRequest,
  buildShippingEstimateSnapshot,
  calculatePreview,
  canRecordAcceptance,
  createApp,
  renderAcceptanceRecord,
  renderShippingRates,
  renderSnapshot,
  renderSummary
} = require("../../web/js/admin-quotation.js");
const { renderQuotationsMarkup } = require("../../web/js/admin-commissions.js");

function element() {
  const listeners = new Map();
  return {
    hidden: false, innerHTML: "", textContent: "", value: "", href: "", checked: false,
    classList: { add() {}, remove() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    listeners
  };
}

function documentFixture() {
  const fields = Object.fromEntries([
    "price", "sales_tax_rate", "shipping_charge", "estimated_completion", "special_terms",
    "shipping_recipient_name", "shipping_address_line1", "shipping_address_line2",
    "shipping_city", "shipping_state_region", "shipping_postal_code", "shipping_country",
    "parcel_length", "parcel_width", "parcel_height", "dimension_unit",
    "parcel_weight", "weight_unit"
  ].map((key) => [key, element()]));
  const acceptanceFields = Object.fromEntries(["client_name_entered", "client_email", "accepted_by_client_confirmation"].map((key) => [key, element()]));
  const form = element();
  form.elements = { namedItem(name) { return fields[name]; } };
  const acceptanceForm = element();
  acceptanceForm.elements = { namedItem(name) { return acceptanceFields[name]; } };
  const elements = {
    "#quotation-page-status": element(), "#quotation-panel": element(),
    "#quotation-summary": element(), "#quotation-form": form,
    "#quotation-tax-preview": element(), "#quotation-deposit-preview": element(),
    "#quotation-total-preview": element(), "#issue-quotation": element(),
    "#mark-quotation-sent": element(), "#new-quotation-version": element(),
    "#withdraw-quotation": element(), "#record-quotation-acceptance": element(),
    "#quotation-acceptance-panel": element(), "#quotation-acceptance-summary": element(),
    "#quotation-acceptance-form": acceptanceForm, "#cancel-quotation-acceptance": element(),
    "#quotation-acceptance-record": element(), "#quotation-preview": element(),
    "#quotation-contract-action": element(), "#quotation-contract-status": element(),
    "#quotation-prepare-contract": element(), "#get-shipping-estimate": element(),
    "#shipping-estimate-status": element(), "#shipping-estimate-results": element()
  };
  return { elements, fields, acceptanceFields, querySelector(selector) { return elements[selector]; } };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, async json() { return body; } };
}

const draft = {
  id: "9", quotation_number: "SAS-QUO-2026-0001", version: 1,
  commission_id: "10",
  quotation_status: "draft", commission_number: "SAS-COM-2026-0001",
  commission_title: "Portrait", client_name: "Client", price: "400.00",
  sales_tax_rate: "0.0600", sales_tax: "24.00", shipping_charge: "20.00",
  required_deposit: "200.00", estimated_completion: null, special_terms: null
  , shipping_estimate_snapshot: null
};

const issued = {
  ...draft, quotation_status: "issued", issued_at: "2026-10-11T16:00:00Z",
  expires_at: "2099-11-10T16:00:00Z", snapshot_hash: "a".repeat(64),
  client_email: "client@example.invalid",
  quotation_snapshot: {
    issued_at: "2026-10-11T16:00:00Z", expires_at: "2099-11-10T16:00:00Z",
    commercial: { price: "400.00", sales_tax_rate: "0.0600", sales_tax: "24.00", shipping_charge: "20.00", required_deposit: "200.00", total: "444.00", special_terms: null }
  }
};

test("quotation page loads shared Admin and glossary infrastructure", () => {
  const html = readFileSync("web/admin/quotation.html", "utf8");
  assert.match(html, /\.\.\/css\/admin\.css/);
  assert.match(html, /\.\.\/js\/admin-glossary\.js/);
  for (const key of ["quotation", "sales_tax_rate", "shipping_charge", "special_terms", "required_deposit"]) {
    assert.match(html, new RegExp(`data-glossary-key="${key}"`));
  }
  assert.match(html, /id="record-quotation-acceptance"/);
  assert.match(html, /name="accepted_by_client_confirmation" required/);
  assert.match(html, /data-glossary-key="acceptance"/);
  assert.match(html, /id="shipping-estimate-section"/);
  assert.match(html, /id="get-shipping-estimate">Get Estimate</);
  assert.match(html, /data-glossary-key="shipping_estimate"/);
  for (const name of [
    "shipping_address_line1", "shipping_city", "shipping_state_region",
    "shipping_postal_code", "shipping_country", "parcel_length",
    "parcel_width", "parcel_height", "parcel_weight"
  ]) assert.match(html, new RegExp(`name="${name}"[^>]*required`));
});

test("quotation preview calculates tax, required deposit, and total", () => {
  assert.deepEqual(calculatePreview({ price: "400", salesTaxRate: "0.06", shippingCharge: "20" }), {
    salesTax: 24, requiredDeposit: 200, total: 444
  });
});

test("required deposit ignores tax and shipping", () => {
  assert.equal(calculatePreview({ price: "400", salesTaxRate: "0.08", shippingCharge: "999" }).requiredDeposit, 200);
});

test("draft payload contains only editable commercial fields", () => {
  const fixture = documentFixture();
  Object.assign(fixture.fields.price, { value: "400" });
  Object.assign(fixture.fields.sales_tax_rate, { value: "0.06" });
  Object.assign(fixture.fields.shipping_charge, { value: "20" });
  Object.assign(fixture.fields.estimated_completion, { value: "2027-02-15" });
  Object.assign(fixture.fields.special_terms, { value: " Studio term " });
  assert.deepEqual(Object.keys(buildPayload(fixture.elements["#quotation-form"])), [
    "price", "sales_tax_rate", "shipping_charge", "estimated_completion",
    "special_terms", "shipping_estimate_snapshot"
  ]);
});

test("shipping estimate request keeps destination and parcel separate from commercial fields", () => {
  const fixture = documentFixture();
  Object.assign(fixture.fields.shipping_recipient_name, { value: " Recipient " });
  Object.assign(fixture.fields.shipping_address_line1, { value: " 100 Test Avenue " });
  Object.assign(fixture.fields.shipping_city, { value: " Pittsburgh " });
  Object.assign(fixture.fields.shipping_state_region, { value: " PA " });
  Object.assign(fixture.fields.shipping_postal_code, { value: " 15222 " });
  Object.assign(fixture.fields.shipping_country, { value: " US " });
  Object.assign(fixture.fields.parcel_length, { value: "24" });
  Object.assign(fixture.fields.parcel_width, { value: "20" });
  Object.assign(fixture.fields.parcel_height, { value: "4" });
  Object.assign(fixture.fields.dimension_unit, { value: "in" });
  Object.assign(fixture.fields.parcel_weight, { value: "12" });
  Object.assign(fixture.fields.weight_unit, { value: "lb" });
  assert.deepEqual(buildShippingEstimateRequest(fixture.elements["#quotation-form"]), {
    destination: {
      recipient_name: "Recipient",
      address_line1: "100 Test Avenue",
      address_line2: null,
      city: "Pittsburgh",
      state_region: "PA",
      postal_code: "15222",
      country: "US"
    },
    parcel: {
      length: "24", width: "20", height: "4",
      dimension_unit: "in", weight: "12", weight_unit: "lb"
    }
  });
});

test("rate renderer is provider-agnostic and exposes an explicit Shipping Charge action", () => {
  const html = renderShippingRates({
    rates: [{
      provider: "fixture-provider", carrier: "Fixture Carrier", service: "Ground",
      amount: "35.00", currency: "USD", estimated_days: 4,
      rate_id: "rate-1", generated_at: "2026-10-11T16:00:00.000Z", expires_at: null
    }]
  });
  assert.match(html, /Fixture Carrier/);
  assert.match(html, /Ground/);
  assert.match(html, /\$35\.00/);
  assert.match(html, /4 days/);
  assert.match(html, />Use as Shipping Charge</);
  assert.doesNotMatch(html, /If UPS|If FedEx|If USPS/);
});

test("provider-not-configured response is presented as an explicit state", async () => {
  const fixture = documentFixture();
  const app = createApp(fixture, async (url) => {
    if (url === SHIPPING_ESTIMATE_API_PATH) {
      return response({
        success: false,
        code: "rate_provider_not_configured",
        message: "Live shipping rates are not configured yet."
      }, 503);
    }
    return response({ success: true, quotation: draft });
  }, { search: "?id=9" });
  await app.load();
  await app.getShippingEstimate();
  assert.equal(
    fixture.elements["#shipping-estimate-status"].textContent,
    "Live shipping rates are not configured yet."
  );
  assert.equal(fixture.elements["#shipping-estimate-results"].innerHTML, "");
});

test("estimate selection changes Shipping Charge only through the explicit Admin action", async () => {
  const fixture = documentFixture();
  const calls = [];
  const rate = {
    provider: "fixture-provider", carrier: "Fixture Carrier", service: "Ground",
    amount: "35.00", currency: "USD", estimated_days: 4,
    rate_id: "rate-1", generated_at: "2026-10-11T16:00:00.000Z", expires_at: null
  };
  const destination = {
    recipient_name: "Recipient", address_line1: "100 Private Avenue",
    address_line2: null, city: "Pittsburgh", state_region: "PA",
    postal_code: "15222", country: "US"
  };
  const parcel = {
    length: 24, width: 20, height: 4,
    dimension_unit: "in", weight: 12, weight_unit: "lb"
  };
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url === SHIPPING_ESTIMATE_API_PATH) {
      return response({ success: true, rates: [rate], destination, parcel });
    }
    if (url === "/admin/api/quotations/9" && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      return response({
        success: true,
        quotation: {
          ...draft,
          shipping_charge: payload.shipping_charge,
          shipping_estimate_snapshot: payload.shipping_estimate_snapshot
        }
      });
    }
    return response({ success: true, quotation: draft });
  }, { search: "?id=9" });
  await app.load();
  assert.equal(fixture.fields.shipping_charge.value, "20.00");
  await app.getShippingEstimate();
  assert.equal(fixture.fields.shipping_charge.value, "20.00");
  const snapshot = app.useShippingRate(0);
  assert.equal(fixture.fields.shipping_charge.value, "35.00");
  assert.equal(snapshot.estimated_amount, "35.00");
  assert.equal(snapshot.destination.city, "Pittsburgh");
  assert.equal("address_line1" in snapshot.destination, false);
  assert.equal("recipient_name" in snapshot.destination, false);
  await app.save({ preventDefault() {} });
  const savedPayload = JSON.parse(calls.find(
    (call) => call.url === "/admin/api/quotations/9" && call.options.method === "PATCH"
  ).options.body);
  assert.equal(savedPayload.shipping_charge, "35.00");
  assert.deepEqual(savedPayload.shipping_estimate_snapshot, snapshot);
  assert.equal(calculatePreview({
    price: "400", salesTaxRate: "0.06", shippingCharge: "35"
  }).requiredDeposit, 200);
});

test("client snapshot builder stores only the approved normalized estimate fields", () => {
  const snapshot = buildShippingEstimateSnapshot(
    {
      provider: "fixture-provider", carrier: "Fixture Carrier", service: "Ground",
      amount: "35.00", currency: "USD", estimated_days: 4,
      rate_id: "rate-1", generated_at: "2026-10-11T16:00:00.000Z"
    },
    {
      recipient_name: "Private Recipient", address_line1: "100 Private Avenue",
      city: "Pittsburgh", state_region: "PA", postal_code: "15222", country: "US"
    },
    {
      length: 24, width: 20, height: 4,
      dimension_unit: "in", weight: 12, weight_unit: "lb"
    }
  );
  assert.deepEqual(Object.keys(snapshot.destination), [
    "city", "state_region", "postal_code", "country"
  ]);
});

test("Commission detail supports zero quotations", () => {
  assert.match(renderQuotationsMarkup([]), /No quotations for this commission/);
});

test("Commission detail renders version, status, totals and view action", () => {
  const html = renderQuotationsMarkup([{ ...draft, issued_at: null, expires_at: null, sent_at: null, is_expired: false }]);
  assert.match(html, /SAS-QUO-2026-0001/);
  assert.match(html, /v1/);
  assert.match(html, /Draft/);
  assert.match(html, /\$444\.00/);
  assert.match(html, /quotation\.html\?id=9/);
});

test("draft loads as editable with only Issue action", async () => {
  const fixture = documentFixture();
  const app = createApp(fixture, async () => response({ success: true, quotation: draft }), { search: "?id=9" });
  await app.load();
  assert.equal(fixture.elements["#quotation-form"].hidden, false);
  assert.equal(fixture.elements["#issue-quotation"].hidden, false);
  assert.equal(fixture.elements["#mark-quotation-sent"].hidden, true);
  assert.equal(fixture.fields.price.value, "400.00");
});

test("Prepare Quotation uses an idempotency key and replaces the URL with its persistent id", async () => {
  const fixture = documentFixture();
  const calls = [];
  const historyCalls = [];
  const app = createApp(
    fixture,
    async (url, options) => { calls.push({ url, options }); return response({ success: true, created: true, quotation: draft }, 201); },
    { search: "?commission_id=10" },
    () => "11111111-1111-4111-8111-111111111111",
    { replaceState(...args) { historyCalls.push(args); } }
  );
  await app.load();
  assert.deepEqual(JSON.parse(calls[0].options.body), { request_id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(historyCalls[0][2], "quotation.html?id=9");
});

test("issued quotation is read-only and rendered only from snapshot", async () => {
  const fixture = documentFixture();
  const app = createApp(fixture, async (url) => response(url.endsWith("/acceptance") ? { success: true, acceptance: null } : { success: true, quotation: issued }), { search: "?id=9" });
  await app.load();
  assert.equal(fixture.elements["#quotation-form"].hidden, true);
  assert.equal(fixture.elements["#mark-quotation-sent"].hidden, false);
  assert.match(fixture.elements["#quotation-preview"].innerHTML, /\$444\.00/);
});

test("quotation actions call the approved Admin endpoints", async () => {
  const fixture = documentFixture();
  const calls = [];
  const app = createApp(fixture, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/acceptance")) return response({ success: true, acceptance: null });
    return response({ success: true, quotation: calls.length === 1 ? draft : issued });
  }, { search: "?id=9", href: "" });
  await app.load();
  await app.action("issue");
  assert.equal(calls[1].url, "/admin/api/quotations/9/issue");
  assert.equal(calls[1].options.method, "POST");
});

test("acceptance is offered only for current issued or sent quotations", () => {
  assert.equal(canRecordAcceptance(issued, new Date("2026-10-12T00:00:00Z")), true);
  assert.equal(canRecordAcceptance({ ...issued, quotation_status: "sent" }, new Date("2026-10-12T00:00:00Z")), true);
  assert.equal(canRecordAcceptance({ ...issued, quotation_status: "accepted" }), false);
  assert.equal(canRecordAcceptance({ ...issued, expires_at: "2026-10-10T00:00:00Z" }), false);
});

test("acceptance payload contains explicit confirmation and controlled method", () => {
  const fixture = documentFixture();
  fixture.acceptanceFields.client_name_entered.value = " Client ";
  fixture.acceptanceFields.client_email.value = " Client@Example.invalid ";
  fixture.acceptanceFields.accepted_by_client_confirmation.checked = true;
  assert.deepEqual(buildAcceptancePayload(
    fixture.elements["#quotation-acceptance-form"],
    "11111111-1111-4111-8111-111111111111"
  ), {
    request_id: "11111111-1111-4111-8111-111111111111",
    acceptance_method: "admin_recorded",
    client_name_entered: "Client",
    client_email: "Client@Example.invalid",
    accepted_by_client_confirmation: true
  });
});

test("record acceptance prefills client identity and posts the approved request", async () => {
  const fixture = documentFixture();
  const calls = [];
  const acceptance = {
    id: "4", accepted_at: "2026-10-12T12:00:00Z", acceptance_method: "admin_recorded",
    client_name_entered: "Client", client_email: "client@example.invalid",
    subject_number: issued.quotation_number, subject_version: 1, snapshot_hash: issued.snapshot_hash
  };
  const app = createApp(fixture, async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) return response({ success: true, eligible: true, message: "Eligible.", quotation: { id: "9" } });
    if (url.endsWith("/acceptance")) return response({ success: true, acceptance: null });
    if (url.endsWith("/accept")) return response({ success: true, acceptance, quotation_status: "accepted" }, 201);
    return response({ success: true, quotation: issued });
  }, { search: "?id=9" }, () => "11111111-1111-4111-8111-111111111111");
  await app.load();
  assert.equal(app.openAcceptance(), true);
  assert.equal(fixture.acceptanceFields.client_name_entered.value, "Client");
  assert.equal(fixture.acceptanceFields.client_email.value, "client@example.invalid");
  fixture.acceptanceFields.accepted_by_client_confirmation.checked = true;
  await app.submitAcceptance({ preventDefault() {} });
  const post = calls.find((call) => call.url.endsWith("/accept"));
  assert.equal(post.options.method, "POST");
  assert.equal(JSON.parse(post.options.body).accepted_by_client_confirmation, true);
  assert.equal(fixture.elements["#record-quotation-acceptance"].hidden, true);
  assert.equal(fixture.elements["#new-quotation-version"].hidden, true);
  assert.equal(fixture.elements["#withdraw-quotation"].hidden, true);
  assert.equal(fixture.elements["#quotation-form"].hidden, true);
  assert.match(fixture.elements["#quotation-acceptance-record"].innerHTML, /Accepted/);
  assert.equal(fixture.elements["#quotation-contract-action"].hidden, false);
  assert.equal(fixture.elements["#quotation-prepare-contract"].href, "create-contract.html?commission_id=10");
});

test("an accepted quotation exposes Contract preparation only after backend eligibility", async () => {
  const fixture = documentFixture();
  const accepted = { ...issued, quotation_status: "accepted" };
  const acceptance = {
    id: "4", accepted_at: "2026-10-12T12:00:00Z", acceptance_method: "admin_recorded",
    client_name_entered: "Client", client_email: "client@example.invalid",
    subject_number: accepted.quotation_number, subject_version: 1, snapshot_hash: accepted.snapshot_hash
  };
  const app = createApp(fixture, async (url) => {
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) return response({ success: true, eligible: true, message: "Eligible.", quotation: { id: "9" } });
    if (url.endsWith("/acceptance")) return response({ success: true, acceptance });
    return response({ success: true, quotation: accepted });
  }, { search: "?id=9" });

  await app.load();

  assert.equal(fixture.elements["#quotation-contract-action"].hidden, false);
  assert.equal(fixture.elements["#quotation-prepare-contract"].href, "create-contract.html?commission_id=10");
  assert.equal(fixture.elements["#quotation-contract-status"].textContent, "Eligible.");
});

test("accepted metadata renders immutable subject evidence", () => {
  const html = renderAcceptanceRecord({
    accepted_at: "2026-10-12T12:00:00Z", acceptance_method: "admin_recorded",
    client_name_entered: "Client", client_email: "client@example.invalid",
    subject_number: "SAS-QUO-2026-0001", subject_version: 1, snapshot_hash: "a".repeat(64)
  });
  assert.match(html, /SAS-QUO-2026-0001/);
  assert.match(html, /admin_recorded/);
  assert.match(html, new RegExp("a{64}"));
});

test("snapshot renderer includes issued commercial truth", () => {
  const html = renderSnapshot({
    issued_at: "2026-10-11T16:00:00Z", expires_at: "2026-11-10T16:00:00Z",
    commercial: { price: "400", sales_tax_rate: "0.06", sales_tax: "24", shipping_charge: "20", required_deposit: "200", total: "444", special_terms: "One revision." }
  });
  assert.match(html, /Issued Commercial Snapshot/);
  assert.match(html, /One revision/);
  assert.match(html, /\$200\.00/);
});

test("summary exposes expired indicator without changing status", () => {
  assert.match(renderSummary({ ...draft, quotation_status: "sent", is_expired: true }), /Expired by date/);
});
