import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  PREVIEW_STORAGE_KEY,
  createApp,
  readPreview,
  renderContractMarkup
} = require("../../web/js/admin-contract.js");

const snapshot = {
  contract: {
    document_number: null,
    version: null,
    subtype: "commission_agreement",
    contract_date: "2026-10-09",
    status: "draft"
  },
  quotation: {
    quotation_id: "4", quotation_number: "SAS-QUO-2026-0001", quotation_version: 1,
    quotation_accepted_at: "2026-10-08T16:00:00Z",
    quotation_snapshot_hash: "a".repeat(64), quotation_acceptance_id: "7"
  },
  studio: {
    name: "Sylva Ars Studio LLC",
    address_line_1: "Studio Address",
    address_line_2: "York, PA",
    email: "studio@example.invalid"
  },
  client: {
    client_id: "2",
    full_name: "Contract Client",
    email: "client@example.invalid",
    phone: null,
    address_line_1: "Client Address",
    city: "York",
    state: "PA",
    postal_code: "17402",
    country: "United States"
  },
  commission: { commission_id: "10", commission_number: "SAS-COM-2026-0001" },
  artwork: {
    title: "Contract Commission",
    description: "Database description",
    medium: "Oil",
    width: "20.00",
    height: "24.00",
    dimensions: { width: "20.00", height: "24.00", unit: "in" }
  },
  commercial_terms: {
    price: "400.00",
    sales_tax: "24.00",
    shipping_charge: "20.00",
    total: "444.00",
    required_deposit: "200.00",
    estimated_remaining_after_required_deposit: "244.00",
    estimated_completion: "2027-02-15",
    special_terms: "Accepted special term."
  },
  terms: {
    status: "draft",
    approved: false,
    sections: {
      payment: { title: "Payment", paragraphs: ["DRAFT PLACEHOLDER — Under review."] },
      cancellation: { title: "Cancellation / Refunds", paragraphs: ["DRAFT PLACEHOLDER — Under review."] }
    }
  },
  document_fields: {
    optional_message: "Review only",
    delivery_notes: "Pickup under review"
  },
  signatures: {
    mode: "manual",
    labels: ["Artist Signature", "Date", "Client Signature", "Date"]
  }
};

const preCommissionSnapshot = {
  ...snapshot,
  schema_version: 3,
  commission: undefined,
  commercial: snapshot.commercial_terms,
  commercial_terms: undefined
};

function element() {
  const listeners = new Map();
  return {
    innerHTML: "",
    textContent: "",
    hidden: true,
    classList: { add() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    listeners
  };
}

test("draft renderer prominently marks the contract as not issued", () => {
  const markup = renderContractMarkup(snapshot);
  assert.match(markup, /DRAFT — NOT ISSUED — TERMS UNDER REVIEW/);
  assert.match(markup, /Contract Number[\s\S]*Not issued/);
  assert.match(markup, /Version[\s\S]*Draft/);
  assert.doesNotMatch(markup, /SAS-CON-/);
});

test("draft renderer shows server-derived financial values", () => {
  const markup = renderContractMarkup(snapshot);
  assert.match(markup, /Artwork Price[\s\S]*\$400\.00/);
  assert.match(markup, /Sales Tax[\s\S]*\$24\.00/);
  assert.match(markup, /Shipping[\s\S]*\$20\.00/);
  assert.match(markup, /Required Deposit \(50%\)[\s\S]*\$200\.00/);
  assert.match(markup, /Estimated Remaining After Required Deposit[\s\S]*\$244\.00/);
});

test("draft renderer identifies the accepted source quotation", () => {
  const markup = renderContractMarkup(snapshot);
  assert.match(markup, /Based on Accepted Quotation/);
  assert.match(markup, /data-glossary-key="contract_source_quotation"/);
  assert.match(markup, /SAS-QUO-2026-0001[\s\S]*v1/);
  assert.match(markup, new RegExp("a{64}"));
});

test("pre-Commission draft renders artwork without an empty Commission number", () => {
  const markup = renderContractMarkup(preCommissionSnapshot);
  assert.match(markup, /<h2>Artwork<\/h2>/);
  assert.match(markup, /Contract Commission/);
  assert.doesNotMatch(markup, /Commission Number/);
});

test("draft renderer provides contextual help for terms under review", () => {
  assert.match(renderContractMarkup(snapshot), /data-glossary-key="contract_issuance"/);
});

test("draft renderer includes placeholder sections and separate special fields", () => {
  const markup = renderContractMarkup(snapshot);
  assert.match(markup, /DRAFT PLACEHOLDER — Under review\./);
  assert.match(markup, /Optional Message[\s\S]*Review only/);
  assert.match(markup, /Delivery \/ Pickup Notes[\s\S]*Pickup under review/);
  assert.match(markup, /Accepted Special Terms[\s\S]*Accepted special term/);
});

test("signature structure contains only artist and client manual signatures", () => {
  const markup = renderContractMarkup(snapshot);
  assert.equal((markup.match(/Artist Signature/g) || []).length, 1);
  assert.equal((markup.match(/Client Signature/g) || []).length, 1);
  assert.equal((markup.match(/<p>Date<\/p>/g) || []).length, 2);
  assert.doesNotMatch(markup, /Authorized Signature|Date of Issue/);
});

test("renderer reads the prepared snapshot from session storage", () => {
  const storage = { getItem(key) { return key === PREVIEW_STORAGE_KEY ? JSON.stringify(snapshot) : null; } };
  assert.deepEqual(readPreview(storage), snapshot);
});

test("renderer rejects non-draft snapshots", () => {
  const storage = {
    getItem() {
      return JSON.stringify({ ...snapshot, contract: { ...snapshot.contract, status: "issued" } });
    }
  };
  assert.equal(readPreview(storage), null);
});

test("contract page supports print without any issue action", () => {
  const html = readFileSync("web/admin/contract.html", "utf8");
  assert.match(html, /id="print-contract"[^>]*>Print \/ Save PDF/);
  assert.doesNotMatch(html, /Issue Contract/);
});

test("Print button calls window.print", () => {
  const elements = {
    "#contract-preview-status": element(),
    "#contract-preview": element(),
    "#print-contract": element()
  };
  const documentObject = { querySelector(selector) { return elements[selector]; } };
  const storage = { getItem() { return JSON.stringify(snapshot); } };
  let calls = 0;
  const app = createApp(documentObject, storage, () => { calls += 1; });
  app.bindEvents();
  app.load();
  elements["#print-contract"].listeners.get("click")();
  assert.equal(calls, 1);
});

test("print CSS preserves draft marking while hiding controls", () => {
  const css = readFileSync("web/css/documents.css", "utf8");
  assert.match(css, /@media print[\s\S]*\.contract-preview-actions[\s\S]*display: none/);
  assert.match(css, /\.contract-draft-banner/);
});
