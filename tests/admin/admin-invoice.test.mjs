import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createApp,
  renderInvoiceMarkup,
  renderPaymentHistory
} = require("../../web/js/admin-invoice.js");

const snapshot = {
  schema_version: 1,
  invoice: {
    number: "SAS-INV-2026-0001",
    version: 1,
    invoice_date: "2026-10-09",
    financial_status: "PAID"
  },
  client: {
    name: "Invoice Client",
    email: "invoice@example.invalid",
    phone: null,
    address_line_1: "10 Studio Lane",
    address_line_2: null,
    city: "York",
    state: "PA",
    postal_code: "17402",
    country: "United States"
  },
  commission: {
    id: "10",
    number: "SAS-COM-2026-0001",
    title: "Final Commission",
    description: "A commissioned artwork.",
    medium: "Oil on canvas",
    width: "20.00",
    height: "24.00"
  },
  financial: {
    price: "500.00",
    sales_tax: "30.00",
    shipping: "60.00",
    total: "590.00",
    amount_paid: "590.00",
    balance: "0.00"
  },
  payments: [
    {
      payment_type: "deposit",
      amount: "250.00",
      sales_tax: "0.00",
      payment_method: "card",
      payment_date: "2026-09-01",
      external_reference: "deposit-ref",
      receipt_number: "SAS-REC-2026-0001"
    },
    {
      payment_type: "balance",
      amount: "340.00",
      sales_tax: "30.00",
      payment_method: "bank_transfer",
      payment_date: "2026-10-09",
      external_reference: null,
      receipt_number: null
    }
  ],
  studio: {
    name: "Sylva Ars Studio LLC",
    address_line_1: "204 St Charles Way, Unit E #362",
    address_line_2: "York, PA 17402",
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
    classList: { add() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    listeners
  };
}

function documentHarness() {
  const elements = {
    "#invoice-status": element(),
    "#final-invoice": element(),
    "#print-invoice": element(),
    "#back-to-commission": element()
  };
  elements["#final-invoice"].hidden = true;
  return { elements, querySelector(selector) { return elements[selector]; } };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

test("invoice page loads the approved protected assets", () => {
  const html = readFileSync("web/admin/invoice.html", "utf8");
  assert.match(html, /id="final-invoice"/);
  assert.match(html, /id="print-invoice"[^>]*>Print \/ Save PDF/);
  assert.match(html, /id="back-to-commission"[^>]*href="\/admin\/commissions\.html"/);
  assert.match(html, /admin-invoice\.js/);
  assert.match(html, /invoice\.css/);
});

test("invoice number and PAID status render", () => {
  const markup = renderInvoiceMarkup(snapshot);
  assert.match(markup, /SAS-INV-2026-0001/);
  assert.match(markup, /FINAL INVOICE/);
  assert.match(markup, /PAID/);
});

test("client snapshot renders", () => {
  const markup = renderInvoiceMarkup(snapshot);
  assert.match(markup, /Invoice Client/);
  assert.match(markup, /invoice@example\.invalid/);
  assert.match(markup, /10 Studio Lane/);
});

test("commission snapshot renders", () => {
  const markup = renderInvoiceMarkup(snapshot);
  assert.match(markup, /SAS-COM-2026-0001/);
  assert.match(markup, /Final Commission/);
  assert.match(markup, /Oil on canvas/);
  assert.match(markup, /20\.00 × 24\.00 in/);
});

test("financial summary renders subtotal tax shipping and total", () => {
  const markup = renderInvoiceMarkup(snapshot);
  assert.match(markup, /Subtotal[\s\S]*\$500\.00/);
  assert.match(markup, /Sales Tax[\s\S]*\$30\.00/);
  assert.match(markup, /Shipping[\s\S]*\$60\.00/);
  assert.match(markup, /Total[\s\S]*\$590\.00/);
});

test("payment history renders all completed payments", () => {
  const markup = renderPaymentHistory(snapshot.payments);
  assert.match(markup, /Deposit/);
  assert.match(markup, /Balance/);
  assert.match(markup, /\$250\.00/);
  assert.match(markup, /\$340\.00/);
});

test("prior receipt number renders in payment history", () => {
  assert.match(renderPaymentHistory(snapshot.payments), /SAS-REC-2026-0001/);
});

test("balance due renders as zero", () => {
  assert.match(renderInvoiceMarkup(snapshot), /Balance Due[\s\S]*\$0\.00/);
});

test("invoice page loads its document id from the query", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    return response({
      success: true,
      invoice: {
        id: "70",
        document_number: "SAS-INV-2026-0001",
        version: 1,
        snapshot
      }
    });
  }, { search: "?document=70" }, () => {});
  const invoice = await app.load();
  assert.deepEqual(calls, ["/admin/api/documents/invoices/70"]);
  assert.equal(invoice.id, "70");
  assert.equal(documentObject.elements["#final-invoice"].hidden, false);
});

test("invalid invoice id is rejected without a request", async () => {
  const documentObject = documentHarness();
  let calls = 0;
  const app = createApp(documentObject, async () => {
    calls += 1;
    return response({});
  }, { search: "?document=invalid" }, () => {});
  assert.equal(await app.load(), null);
  assert.equal(calls, 0);
  assert.equal(documentObject.elements["#invoice-status"].textContent, "Invalid invoice reference.");
});

test("Print button calls window.print", () => {
  const documentObject = documentHarness();
  let printCalls = 0;
  const app = createApp(documentObject, async () => response({}), { search: "?document=70" }, () => {
    printCalls += 1;
  });
  app.bindEvents();
  documentObject.elements["#print-invoice"].listeners.get("click")();
  assert.equal(printCalls, 1);
});

test("Back to Commission remains a direct protected link", () => {
  assert.match(readFileSync("web/admin/invoice.html", "utf8"), /href="\/admin\/commissions\.html"/);
});

test("print CSS uses Letter and hides invoice actions", () => {
  const css = readFileSync("web/css/invoice.css", "utf8");
  assert.match(css, /@page\s*{[\s\S]*size:\s*Letter/);
  assert.match(css, /@media print[\s\S]*\.invoice-actions[\s\S]*display:\s*none/);
});
