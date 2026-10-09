import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createApp,
  paymentMethodLabels,
  renderReceiptMarkup
} = require("../../web/js/admin-payment-receipt.js");

const snapshot = {
  receipt: {
    number: "SAS-REC-2026-0001",
    issued_at: "2026-10-09T15:00:00.000Z"
  },
  payment: {
    id: "50",
    type: "balance",
    amount: "340.00",
    sales_tax: "30.00",
    method: "card",
    payment_date: "2026-10-09",
    external_reference: null,
    notes: null,
    balance_after_payment: "0.00"
  },
  commission: {
    id: "10",
    number: "SAS-COM-2026-0001",
    title: "Test Commission",
    price: "500.00",
    sales_tax: "30.00",
    shipping: "60.00",
    total: "590.00"
  },
  client: {
    name: "Test Client",
    email: "test@example.invalid",
    phone: null,
    address_line_1: "10 Studio Lane",
    address_line_2: null,
    city: "York",
    state: "PA",
    postal_code: "17402",
    country: "United States"
  },
  studio: {
    name: "Sylva Ars Studio LLC",
    email: "contact@sylvaarsstudio.com",
    phone: "+1 (717) 220-5592",
    website: "sylvaarsstudio.com"
  }
};

function element() {
  const listeners = new Map();
  return {
    textContent: "",
    innerHTML: "",
    hidden: false,
    classList: {
      values: new Set(),
      add(value) {
        this.values.add(value);
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    listeners
  };
}

function documentHarness() {
  const elements = {
    "#receipt-status": element(),
    "#payment-receipt": element(),
    "#print-receipt": element(),
    "#back-to-commission": element()
  };
  elements["#payment-receipt"].hidden = true;

  return {
    elements,
    querySelector(selector) {
      return elements[selector];
    }
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    redirected: false,
    async json() {
      return body;
    }
  };
}

test("receipt page contains the protected receipt UI and assets", () => {
  const html = readFileSync(
    new URL("../../web/admin/payment-receipt.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="payment-receipt"/);
  assert.match(html, /id="print-receipt"[^>]*>Print \/ Save PDF/);
  assert.match(html, /id="back-to-commission"[^>]*href="\/admin\/commissions\.html"/);
  assert.match(html, /admin-payment-receipt\.js/);
  assert.match(html, /payment-receipt\.css/);
});

test("receipt renders number client commission and financial data", () => {
  const markup = renderReceiptMarkup(snapshot);

  assert.match(markup, /SAS-REC-2026-0001/);
  assert.match(markup, /Test Client/);
  assert.match(markup, /test@example\.invalid/);
  assert.match(markup, /SAS-COM-2026-0001/);
  assert.match(markup, /Test Commission/);
  assert.match(markup, /Amount Received[\s\S]*\$340\.00/);
  assert.match(markup, /Sales Tax Portion[\s\S]*\$30\.00/);
  assert.match(markup, /Commission Total[\s\S]*\$590\.00/);
  assert.match(markup, /Balance After Payment[\s\S]*\$0\.00/);
});

test("payment method uses its friendly label", () => {
  assert.equal(paymentMethodLabels.card, "Credit / Debit Card");
  assert.match(renderReceiptMarkup(snapshot), /Credit \/ Debit Card/);
});

test("optional NULL fields do not create empty receipt rows", () => {
  const markup = renderReceiptMarkup(snapshot);

  assert.doesNotMatch(markup, /External Reference/);
  assert.doesNotMatch(markup, /Notes/);
  assert.doesNotMatch(markup, /undefined|null/);
  assert.doesNotMatch(markup, /address_line_2/);
});

test("structured address renders without an empty second line", () => {
  const markup = renderReceiptMarkup(snapshot);

  assert.match(markup, /10 Studio Lane/);
  assert.match(markup, /York, PA 17402/);
  assert.match(markup, /United States/);
});

test("receipt page loads its id from the query and calls the receipt endpoint", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const app = createApp(
    documentObject,
    async (url) => {
      calls.push(url);
      return response({
        success: true,
        receipt: {
          id: "70",
          document_number: "SAS-REC-2026-0001",
          version: 1,
          created_at: "2026-10-09T15:00:00Z",
          snapshot
        }
      });
    },
    { search: "?receipt=70" },
    () => {}
  );

  const receipt = await app.load();

  assert.deepEqual(calls, ["/admin/api/receipts/70"]);
  assert.equal(receipt.id, "70");
  assert.equal(documentObject.elements["#payment-receipt"].hidden, false);
  assert.match(documentObject.elements["#payment-receipt"].innerHTML, /SAS-REC-2026-0001/);
});

test("invalid receipt id is rejected without a request", async () => {
  const documentObject = documentHarness();
  let calls = 0;
  const app = createApp(
    documentObject,
    async () => {
      calls += 1;
      return response({});
    },
    { search: "?receipt=not-an-id" },
    () => {}
  );

  assert.equal(await app.load(), null);
  assert.equal(calls, 0);
  assert.equal(documentObject.elements["#receipt-status"].textContent, "Invalid receipt reference.");
});

test("Print button calls window.print", () => {
  const documentObject = documentHarness();
  let printCalls = 0;
  const app = createApp(
    documentObject,
    async () => response({}),
    { search: "?receipt=70" },
    () => {
      printCalls += 1;
    }
  );
  app.bindEvents();

  documentObject.elements["#print-receipt"].listeners.get("click")();
  assert.equal(printCalls, 1);
});

test("print CSS uses Letter and hides admin actions", () => {
  const css = readFileSync(
    new URL("../../web/css/payment-receipt.css", import.meta.url),
    "utf8"
  );

  assert.match(css, /@page\s*{[\s\S]*size: Letter/);
  assert.match(css, /@media print[\s\S]*\.receipt-actions[\s\S]*display: none !important/);
  assert.match(css, /@media print[\s\S]*overflow|@media print[\s\S]*break-inside: avoid/);
});
