import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  PREPARE_API_PATH,
  createApp,
  parsePreviewRequest,
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

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

function documentHarness() {
  const elements = {
    "#contract-preview-status": element(),
    "#contract-preview": element(),
    "#print-contract": element()
  };
  return {
    elements,
    querySelector(selector) { return elements[selector]; }
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

test("preview request accepts only opaque source metadata", () => {
  const parsed = parsePreviewRequest(
    "?preview=1&quotation_id=9&contract_date=2026-10-09&draft_ref=00000000-0000-4000-8000-000000000009"
  );
  assert.deepEqual(parsed, {
    apiUrl: `${PREPARE_API_PATH}?quotation_id=9&contract_date=2026-10-09`,
    commissionId: null,
    quotationId: "9",
    contractDate: "2026-10-09",
    previewReference: "00000000-0000-4000-8000-000000000009"
  });
  assert.equal(parsePreviewRequest("?preview=1&contract_date=2026-10-09"), null);
  assert.equal(parsePreviewRequest("?preview=1&commission_id=7&quotation_id=9&contract_date=2026-10-09"), null);
  assert.equal(parsePreviewRequest("?preview=1&quotation_id=9&contract_date=2026-10-09&client_email=client%40example.invalid"), null);
});

test("preview refetches the canonical snapshot and consumes document fields once", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const historyCalls = [];
  const consumed = [];
  const reference = "00000000-0000-4000-8000-000000000009";
  const locationObject = {
    pathname: "/admin/contract.html",
    search: `?preview=1&quotation_id=9&contract_date=2026-10-09&draft_ref=${reference}`
  };
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    return response({ snapshot });
  }, locationObject, {
    replaceState(_state, _title, url) { historyCalls.push(url); }
  }, {
    AdminCreateContract: {
      consumePreviewFields(value) {
        consumed.push(value);
        return { optional_message: "One-time message", delivery_notes: "One-time pickup" };
      }
    }
  }, () => {});

  const prepared = await app.load();
  assert.deepEqual(calls, [`${PREPARE_API_PATH}?quotation_id=9&contract_date=2026-10-09`]);
  assert.deepEqual(consumed, [reference]);
  assert.equal(prepared.document_fields.optional_message, "One-time message");
  assert.match(documentObject.elements["#contract-preview"].innerHTML, /One-time message/);
  assert.deepEqual(historyCalls, [
    "/admin/contract.html?preview=1&quotation_id=9&contract_date=2026-10-09"
  ]);
});

test("refresh without a one-time reference uses only a fresh server response", async () => {
  const documentObject = documentHarness();
  const app = createApp(documentObject, async () => response({
    snapshot: {
      ...snapshot,
      document_fields: { optional_message: "Unexpected cached value", delivery_notes: "Unexpected" }
    }
  }), {
    pathname: "/admin/contract.html",
    search: "?preview=1&commission_id=7&contract_date=2026-10-09"
  }, {}, null, () => {});
  const prepared = await app.load();
  assert.deepEqual(prepared.document_fields, { optional_message: "", delivery_notes: "" });
  assert.doesNotMatch(documentObject.elements["#contract-preview"].innerHTML, /Unexpected/);
});

test("invalid or stale preview requests clear their one-time context", async () => {
  const documentObject = documentHarness();
  const discarded = [];
  let fetchCalls = 0;
  const reference = "00000000-0000-4000-8000-000000000009";
  const app = createApp(documentObject, async () => {
    fetchCalls += 1;
    return response({ snapshot });
  }, {
    pathname: "/admin/contract.html",
    search: `?preview=1&quotation_id=9&contract_date=2026-10-09&draft_ref=${reference}&client_name=PII`
  }, { replaceState() {} }, {
    AdminCreateContract: { discardPreviewFields(value) { discarded.push(value); } }
  }, () => {});
  assert.equal(await app.load(), null);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(discarded, [reference]);
});

test("server rejection discards the one-time context and reference", async () => {
  const documentObject = documentHarness();
  const discarded = [];
  const historyCalls = [];
  const reference = "00000000-0000-4000-8000-000000000009";
  const app = createApp(documentObject, async () => response({
    message: "Contract unavailable — the accepted quotation is no longer valid."
  }, 409), {
    pathname: "/admin/contract.html",
    search: `?preview=1&quotation_id=9&contract_date=2026-10-09&draft_ref=${reference}`
  }, {
    replaceState(_state, _title, url) { historyCalls.push(url); }
  }, {
    AdminCreateContract: { discardPreviewFields(value) { discarded.push(value); } }
  }, () => {});

  assert.equal(await app.load(), null);
  assert.deepEqual(discarded, [reference]);
  assert.deepEqual(historyCalls, [
    "/admin/contract.html?preview=1&quotation_id=9&contract_date=2026-10-09"
  ]);
});

test("contract page supports print without any issue action", () => {
  const html = readFileSync("web/admin/contract.html", "utf8");
  assert.match(html, /id="print-contract"[^>]*>Print \/ Save PDF/);
  assert.doesNotMatch(html, /Issue Contract/);
});

test("Print button calls window.print", () => {
  const documentObject = documentHarness();
  let calls = 0;
  const app = createApp(documentObject, async () => response({ snapshot }), {
    search: "?preview=1&commission_id=7&contract_date=2026-10-09"
  }, {}, null, () => { calls += 1; });
  app.bindEvents();
  documentObject.elements["#print-contract"].listeners.get("click")();
  assert.equal(calls, 1);
});

test("contract preview script never reads or writes browser storage", () => {
  const source = readFileSync("web/js/admin-contract.js", "utf8");
  assert.doesNotMatch(source, /sessionStorage|localStorage|indexedDB|\.(getItem|setItem)\s*\(/);
});

test("print CSS preserves draft marking while hiding controls", () => {
  const css = readFileSync("web/css/documents.css", "utf8");
  assert.match(css, /@media print[\s\S]*\.contract-preview-actions[\s\S]*display: none/);
  assert.match(css, /\.contract-draft-banner/);
});
