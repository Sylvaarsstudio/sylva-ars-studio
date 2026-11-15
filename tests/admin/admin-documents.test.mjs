import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  API_PATH,
  LEGACY_INVENTORY_API_PATH,
  LEGAL_TEMPLATES_API_PATH,
  buildDocumentsUrl,
  createApp,
  describeDocument,
  documentTypeLabels,
  renderLegacyInventoryMarkup,
  renderLegalTemplateDetailMarkup,
  renderLegalTemplatesMarkup,
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
  const attributes = new Map();
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    classList: createClassList(),
    listeners,
    attributes,
    addEventListener(type, listener) { listeners.set(type, listener); },
    setAttribute(name, value) { attributes.set(name, value); }
  };
}

function createDocument() {
  const elements = {
    "#document-count": createElement(),
    "#document-list": createElement(),
    "#document-list-status": createElement(),
    "#document-commission-filter": createElement(),
    "#document-type-filter": createElement(),
    "#issued-documents-tab": createElement(),
    "#legal-templates-tab": createElement(),
    "#issued-documents-view": createElement(),
    "#legal-templates-view": createElement(),
    "#legal-template-count": createElement(),
    "#legal-template-list": createElement(),
    "#legal-template-list-status": createElement(),
    "#legal-template-detail": createElement(),
    "#legal-template-detail-status": createElement(),
    "#legal-template-detail-content": createElement(),
    "#legacy-inventory-list": createElement(),
    "#legacy-inventory-status": createElement()
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

const sampleTemplate = {
  id: "12",
  template_key: "commission-agreement",
  name: "Commission Agreement",
  template_kind: "agreement",
  description: "Legacy inventory",
  lifecycle_status: "active",
  version_count: 3,
  approved_version_count: 0,
  effective_version: null,
  latest_draft: {
    id: "21",
    version_number: 3,
    version_label: "legacy public HTML reference",
    state: "draft",
    source_role: "legacy_reference"
  },
  publication_state: "not_published",
  source_conflict: true,
  warnings: ["No Effective Version", "Source Conflict", "Contract Issuance Locked"],
  contract_issuance_locked: true,
  versions: [
    {
      id: "21",
      version_number: 3,
      version_label: "legacy public HTML reference",
      state: "draft",
      source_role: "legacy_reference",
      source_label: "Public Commission Agreement HTML",
      source_type: "public_html_reference",
      source_path: "web/documents/commission-agreement.html",
      current_usage: "current_static_public_display",
      content_hash: "a".repeat(64),
      legal_review_notes: "Inventory only; legal approval is not established.",
      structural_summary: { section_count: 11, heading_count: 10, data_field_count: 11 },
      comparison: {
        equivalence_status: "not_established",
        warning: "Substantive equivalence has not been established."
      },
      created_at: "2026-11-15T15:00:00Z"
    }
  ],
  audit_events: [
    {
      event_type: "legacy_source_hash_recorded",
      template_version_id: "21",
      event_context: { source_identity: "commission-agreement:public-static-html" },
      content_hash: "a".repeat(64),
      occurred_at: "2026-11-15T15:00:00Z"
    }
  ],
  related_documents: [],
  legacy_unmapped_documents: [
    {
      document_number: "SAS-CON-2026-0001",
      file_location: "/admin/contracts/1.html",
      provenance_status: "legacy_unmapped"
    }
  ]
};

test("Documents page renders its heading, table, filters, and script", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /<h1>Documents<\/h1>/);
  assert.match(html, /id="document-list"/);
  assert.match(html, /id="document-commission-filter"/);
  assert.match(html, /id="document-type-filter"/);
  assert.match(html, /admin-documents\.js/);
});

test("Documents page provides Issued Documents and Legal Templates read-only views", () => {
  const html = readFileSync("web/admin/documents.html", "utf8");
  assert.match(html, /id="issued-documents-tab"[\s\S]*Issued Documents/);
  assert.match(html, /id="legal-templates-tab"[\s\S]*Legal Templates/);
  assert.match(html, /id="legal-template-list"/);
  assert.match(html, /Operational sources outside Legal Templates/);
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

test("Legal Templates list shows Draft, effectivity, conflict, publication, and inspect metadata", () => {
  const markup = renderLegalTemplatesMarkup([sampleTemplate]);
  assert.match(markup, /Commission Agreement/);
  assert.match(markup, /No Effective Version/);
  assert.match(markup, /Source Conflict/);
  assert.match(markup, /Contract Issuance Locked/);
  assert.match(markup, /Not Published/);
  assert.match(markup, /legacy public HTML reference/);
  assert.match(markup, /data-template-id="12"/);
});

test("Legal Template detail shows safe provenance, hashes, history, and unmapped Documents", () => {
  const markup = renderLegalTemplateDetailMarkup(sampleTemplate);
  assert.match(markup, /Approved versions<\/dt><dd>0/);
  assert.match(markup, /Effective version<\/dt><dd>None/);
  assert.match(markup, /Comparison status:<\/strong> Not Established/);
  assert.match(markup, /web\/documents\/commission-agreement\.html/);
  assert.match(markup, /Current Static Public Display/);
  assert.match(markup, /legal approval is not established/);
  assert.match(markup, new RegExp("a{64}"));
  assert.match(markup, /Legacy Unmapped/);
  assert.match(markup, /SAS-CON-2026-0001/);
  assert.match(markup, /Legacy Source Hash Recorded/);
});

test("Legal Template UI exposes no editing, approval, effectivity, revocation, or publication actions", () => {
  const markup = `${readFileSync("web/admin/documents.html", "utf8")}\n${renderLegalTemplateDetailMarkup(sampleTemplate)}`;
  for (const action of ["Edit", "Approve", "Make Effective", "Revoke", "Publish", "Upload"]) {
    assert.doesNotMatch(markup, new RegExp(`>\\s*${action}\\s*<`, "i"), action);
  }
});

test("operational source inventory identifies Invoice and COA as not governed", () => {
  const markup = renderLegacyInventoryMarkup([
    {
      name: "Admin Invoice template",
      source_type: "operational_html_template",
      source_path: "web/admin/document-templates/invoice-template.html",
      source_hash: "b".repeat(64),
      governance_status: "not_governed",
      treatment: "Operational/private source; not imported."
    },
    {
      name: "Admin COA template",
      source_type: "operational_html_template",
      source_path: "web/admin/document-templates/coa-template.html",
      source_hash: "c".repeat(64),
      governance_status: "not_governed",
      treatment: "Operational/private source; not imported."
    }
  ]);
  assert.match(markup, /Admin Invoice template/);
  assert.match(markup, /Admin COA template/);
  assert.match(markup, /Not Governed/);
});

test("Legal Templates app loads list, inventory, and detail only through GET URLs", async () => {
  const documentObject = createDocument();
  const urls = [];
  const app = createApp(documentObject, async (url) => {
    urls.push(url);
    if (url === LEGAL_TEMPLATES_API_PATH) return jsonResponse({ templates: [sampleTemplate] });
    if (url === LEGACY_INVENTORY_API_PATH) return jsonResponse({ sources: [] });
    if (url === `${LEGAL_TEMPLATES_API_PATH}/12`) return jsonResponse({ template: sampleTemplate });
    return jsonResponse({ message: "unexpected" }, 404);
  });
  await app.showLegalTemplates();
  await app.loadTemplateDetail("12");
  assert.deepEqual(new Set(urls), new Set([
    LEGAL_TEMPLATES_API_PATH,
    LEGACY_INVENTORY_API_PATH,
    `${LEGAL_TEMPLATES_API_PATH}/12`
  ]));
  assert.equal(documentObject.elements["#legal-template-count"].textContent, "1");
  assert.match(documentObject.elements["#legal-template-detail-content"].innerHTML, /Commission Agreement/);
  assert.equal(documentObject.elements["#legal-templates-view"].hidden, false);
});

test("Dashboard promotes Documents and retains no Generate Documents card", () => {
  const html = readFileSync("web/admin/dashboard.html", "utf8");
  assert.match(html, /href="\/admin\/documents\.html"[^>]*>[\s\S]*?<h2>Documents<\/h2>/);
  assert.doesNotMatch(html, /<h2>Generate Documents<\/h2>/);
});
