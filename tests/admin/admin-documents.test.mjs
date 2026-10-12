import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  API_PATH,
  buildDocumentsUrl,
  createApp,
  describeDocument,
  documentTypeLabels,
  renderCommissionOptions,
  renderDocumentsMarkup
} = require("../../web/js/admin-documents.js");

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); }
  };
}

function createElement() {
  const listeners = new Map();
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    classList: createClassList(),
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
}

function createDocument() {
  const elements = {
    "#document-count": createElement(),
    "#document-list": createElement(),
    "#document-list-status": createElement(),
    "#document-commission-filter": createElement(),
    "#document-type-filter": createElement()
  };
  return {
    elements,
    querySelector(selector) { return elements[selector]; }
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

const sampleDocument = {
  id: "3",
  document_number: "SAS-REC-2026-0001",
  document_type: "receipt",
  version: 2,
  created_at: "2026-10-09T10:00:00Z",
  file_location: "/admin/receipts/3.html",
  commission: {
    id: "7",
    commission_number: "SAS-COM-2026-0007",
    title: "Still Here"
  },
  client: { id: "2", full_name: "Studio Client" },
  payment: { id: "11", payment_type: "balance", payment_date: "2026-10-09" }
};

test("Documents page renders its heading, table, filters, and script", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /<h1>Documents<\/h1>/);
  assert.match(html, /id="document-list"/);
  assert.match(html, /id="document-commission-filter"/);
  assert.match(html, /id="document-type-filter"/);
  assert.match(html, /admin-documents\.js/);
});

test("Documents app renders the returned count", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({ documents: [sampleDocument] }));
  await app.loadDocuments();
  assert.equal(documentObject.elements["#document-count"].textContent, "1");
});

test("Commission filter includes All Commissions", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /<option value="">All Commissions<\/option>/);
});

test("Document Type filter includes All Types", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /<option value="">All Types<\/option>/);
});

test("Commission options use commission number and title", () => {
  const markup = renderCommissionOptions([sampleDocument.commission]);
  assert.match(markup, /SAS-COM-2026-0007 — Still Here/);
  assert.match(markup, /value="7"/);
});

test("Document filters produce the approved query", () => {
  assert.equal(buildDocumentsUrl("7", "receipt"), `${API_PATH}?commission_id=7&document_type=receipt`);
});

test("Receipt uses its friendly label", () => assert.equal(documentTypeLabels.receipt, "Receipt"));
test("Invoice uses its friendly label", () => assert.equal(documentTypeLabels.invoice, "Invoice"));
test("Contract uses its friendly label", () => assert.equal(documentTypeLabels.contract, "Contract"));
test("Quotation uses its friendly label", () => assert.equal(documentTypeLabels.quotation, "Quotation"));
test("COA uses its friendly label", () => assert.equal(documentTypeLabels.coa, "COA"));

test("Documents derives friendly descriptions without stored description data", () => {
  assert.equal(describeDocument(sampleDocument), "Payment Receipt");
  assert.equal(
    describeDocument({
      ...sampleDocument,
      payment: { ...sampleDocument.payment, payment_type: "deposit" }
    }),
    "Deposit Receipt"
  );
  assert.equal(
    describeDocument({ ...sampleDocument, document_type: "invoice", payment: null }),
    "Final Invoice — Paid in full"
  );
  assert.equal(
    describeDocument({
      ...sampleDocument,
      document_type: "contract",
      contract_subtype: "commission_agreement",
      payment: null
    }),
    "Commission Agreement"
  );
  assert.equal(
    describeDocument({
      ...sampleDocument,
      document_type: "contract",
      contract_subtype: "artwork_sales_agreement",
      payment: null
    }),
    "Artwork Sales Agreement"
  );
  assert.equal(
    describeDocument({ ...sampleDocument, document_type: "quotation", version: 2, payment: null }),
    "Quotation — Version 2"
  );
});

test("Documents page and rows show Description", () => {
  assert.match(readFileSync("web/admin/documents.html", "utf8"), /<th scope="col">Description<\/th>/);
  assert.match(renderDocumentsMarkup([sampleDocument]), /Payment Receipt/);
});

test("Document versions render as v1 and v2", () => {
  const markup = renderDocumentsMarkup([
    { ...sampleDocument, version: 1 },
    { ...sampleDocument, id: "4", version: 2 }
  ]);
  assert.match(markup, />v1</);
  assert.match(markup, />v2</);
});

test("A document without a payment renders an em dash", () => {
  assert.match(renderDocumentsMarkup([{
    ...sampleDocument,
    document_type: "contract",
    payment: null
  }]), /<td>—<\/td>/);
});

test("A final invoice renders its derived balance payment", () => {
  const markup = renderDocumentsMarkup([{
    ...sampleDocument,
    document_type: "invoice",
    payment: { id: null, payment_type: "balance", payment_date: "2026-10-09" }
  }]);

  assert.match(markup, />Balance<\/td>/);
  assert.doesNotMatch(markup, /Final Invoice — Paid in full<\/td>[\s\S]*<td>—<\/td>/);
});

test("View uses the stored file_location", () => {
  assert.match(renderDocumentsMarkup([sampleDocument]), /href="\/admin\/receipts\/3\.html"/);
});

test("View opens in a protected new tab", () => {
  const markup = renderDocumentsMarkup([sampleDocument]);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener"/);
});

test("Prepare Contract opens the persistent draft flow", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /href="\/admin\/create-contract\.html"[^>]*>Prepare Contract<\/a>/);
  assert.match(html, /Contract terms are still under review\. Contract issuance is not yet enabled\./);
  assert.match(html, /href="\/admin\/generate-documents\.html"[^>]*>Legacy Generator<\/a>/);
});

test("legacy generator remains available with a terms-under-review warning", () => {
  const html = readFileSync("web/admin/generate-documents.html", "utf8");
  assert.match(html, /Legacy contract generator — terms under review\./);
  assert.match(html, /href="\/admin\/create-contract\.html"[^>]*>Prepare a persistent contract draft<\/a>/);
  assert.match(html, /<option value="artwork-sales-agreement\.html">Artwork Sales Agreement<\/option>/);
  assert.match(html, /<option value="commission-agreement\.html">Commission Agreement<\/option>/);
});

test("Documents index exposes no Delete action", () => {
  assert.doesNotMatch(readFileSync("web/admin/documents.html", "utf8"), />Delete</);
});

test("Documents index exposes no Edit action", () => {
  assert.doesNotMatch(readFileSync("web/admin/documents.html", "utf8"), />Edit</);
});

test("Documents index exposes no Create Receipt action", () => {
  assert.doesNotMatch(readFileSync("web/admin/documents.html", "utf8"), />Create Receipt</);
});

test("Documents index has the approved empty state", () => {
  assert.match(renderDocumentsMarkup([]), /No documents found\./);
});

test("Documents app has the approved error state", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({ message: "failure" }, 500));
  await app.loadDocuments();
  assert.equal(documentObject.elements["#document-list-status"].textContent, "Unable to load documents.");
});

test("Dashboard promotes Documents and retains no Generate Documents card", () => {
  const html = readFileSync("web/admin/dashboard.html", "utf8");
  assert.match(html, /href="\/admin\/documents\.html"[^>]*>[\s\S]*?<h2>Documents<\/h2>/);
  assert.doesNotMatch(html, /<h2>Generate Documents<\/h2>/);
});
