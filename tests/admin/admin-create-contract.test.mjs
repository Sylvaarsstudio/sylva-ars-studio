import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  ELIGIBILITY_API_PATH,
  PREPARE_API_PATH,
  PREVIEW_STORAGE_KEY,
  applyDocumentFields,
  createApp,
  getNewYorkDate,
  renderCommissionOptions,
  renderPreparationSummary
} = require("../../web/js/admin-create-contract.js");

const snapshot = {
  contract: {
    document_number: null,
    version: null,
    subtype: "commission_agreement",
    contract_date: "2026-10-09",
    status: "draft"
  },
  quotation: {
    quotation_id: "4", quotation_number: "SAS-QUO-2026-0001",
    quotation_version: 1, quotation_accepted_at: "2026-10-08T16:00:00Z",
    quotation_snapshot_hash: "a".repeat(64), quotation_acceptance_id: "7"
  },
  client: { client_id: "2", full_name: "Contract Client" },
  commission: { commission_id: "10", commission_number: "SAS-COM-2026-0001" },
  artwork: { title: "Contract Commission" },
  commercial_terms: {
    price: "400.00",
    sales_tax: "24.00",
    shipping_charge: "20.00",
    total: "444.00",
    required_deposit: "200.00",
    estimated_remaining_after_required_deposit: "244.00",
    special_terms: "Accepted term."
  },
  terms: {
    approved: false,
    sections: {
      payment: { title: "Payment", paragraphs: ["DRAFT PLACEHOLDER"] }
    }
  },
  document_fields: {
    optional_message: "",
    delivery_notes: ""
  }
};

function element() {
  const listeners = new Map();
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    classList: { add() {}, remove() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    listeners
  };
}

function documentHarness() {
  const inputs = {
    commission_id: element(),
    subtype: element(),
    contract_date: element(),
    optional_message: element(),
    delivery_notes: element(),
  };
  const form = element();
  form.elements = { namedItem(name) { return inputs[name]; } };
  const elements = {
    "#prepare-contract-form": form,
    "#contract-preparation-status": element(),
    "#contract-preparation-summary": element(),
    "#open-contract-preview": element(),
    "#contract-eligibility-status": element()
  };
  return {
    inputs,
    elements,
    querySelector(selector) { return elements[selector]; }
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

test("Prepare Contract page is explicit that issuance is disabled", () => {
  const html = readFileSync("web/admin/create-contract.html", "utf8");
  assert.match(html, /Contract terms are under review\. This document cannot yet be issued\./);
  assert.match(html, /data-glossary-key="contract_issuance"/);
  assert.match(html, />Prepare Preview</);
  assert.doesNotMatch(html, />Issue Contract</);
});

test("commission options rely on canonical eligibility, not legacy status", () => {
  const commissions = [
    { id: "1", status: "draft", commission_number: "DRAFT", title: "Draft" },
    { id: "2", status: "quoted", commission_number: "QUOTED", title: "Quoted" },
    { id: "3", status: "approved", commission_number: "APPROVED", title: "Approved" }
  ];
  const eligibility = new Map([
    ["1", { eligible: true }], ["2", { eligible: false }], ["3", { eligible: false }]
  ]);
  const markup = renderCommissionOptions(commissions, eligibility);
  assert.match(markup, /value="1"[^>]*>DRAFT/);
  assert.match(markup, /value="2" disabled[^>]*>QUOTED/);
  assert.match(markup, /value="3" disabled[^>]*>APPROVED/);
});

test("New York draft date avoids UTC rollover", () => {
  assert.equal(getNewYorkDate(new Date("2026-10-10T01:35:00.000Z")), "2026-10-09");
});

test("document fields are added without changing protected snapshot data", () => {
  const prepared = applyDocumentFields(snapshot, {
    optional_message: "Message",
    delivery_notes: "Pickup"
  });
  assert.equal(prepared.commercial_terms.price, "400.00");
  assert.equal(prepared.client.full_name, "Contract Client");
  assert.deepEqual(prepared.document_fields, { optional_message: "Message", delivery_notes: "Pickup" });
});

test("preparation summary shows draft financial data and no final number", () => {
  const markup = renderPreparationSummary(snapshot);
  assert.match(markup, /DRAFT — NOT ISSUED/);
  assert.match(markup, /Based on Accepted Quotation:[\s\S]*SAS-QUO-2026-0001/);
  assert.match(markup, /Required Deposit \(50%\):<\/strong> \$200\.00/);
  assert.match(markup, /Estimated Remaining After Required Deposit:<\/strong> \$244\.00/);
  assert.doesNotMatch(markup, /SAS-CON-/);
});

test("commission loading checks canonical eligibility and preselects an eligible link target", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url === "/admin/api/commissions") {
      return response({ commissions: [{ id: "7", status: "draft", commission_number: "SAS-COM-2026-0007", title: "Eligible" }] });
    }
    if (url === `${ELIGIBILITY_API_PATH}?commission_id=7`) {
      return response({ eligible: true, message: "Contract draft preparation is available." });
    }
    throw new Error("Unexpected request");
  }, { setItem() {} }, { search: "?commission_id=7" });
  await app.loadCommissions();
  assert.deepEqual(calls, ["/admin/api/commissions", `${ELIGIBILITY_API_PATH}?commission_id=7`]);
  assert.equal(documentObject.inputs.commission_id.value, "7");
  assert.match(documentObject.inputs.commission_id.innerHTML, /SAS-COM-2026-0007/);
});

test("prepare flow calls only the preparation endpoint and stores a draft snapshot", async () => {
  const documentObject = documentHarness();
  const stored = new Map();
  const storage = {
    setItem(key, value) { stored.set(key, value); },
    getItem(key) { return stored.get(key); }
  };
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url === "/admin/api/commissions") {
      return response({ commissions: [] });
    }
    return response({ snapshot, message: "Contract terms are still under review." });
  }, storage);
  documentObject.inputs.commission_id.value = "7";
  documentObject.inputs.contract_date.value = "2026-10-09";
  documentObject.inputs.optional_message.value = "Review message";
  await app.prepare({ preventDefault() {} });

  assert.equal(calls[0], `${PREPARE_API_PATH}?commission_id=7&contract_date=2026-10-09`);
  assert.equal(JSON.parse(storage.getItem(PREVIEW_STORAGE_KEY)).contract.status, "draft");
  assert.equal(documentObject.elements["#open-contract-preview"].hidden, false);
});
