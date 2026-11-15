import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  ELIGIBILITY_API_PATH,
  PREPARE_API_PATH,
  applyDocumentFields,
  buildPreviewUrl,
  consumePreviewFields,
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
    value: "",
    href: "",
    hidden: false,
    classList: { add() {}, remove() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeAttribute(name) { if (name === "href") this.href = ""; },
    listeners
  };
}

function documentHarness() {
  const inputs = {
    quotation_id: element(),
    quotation_reference: element(),
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
    "#contract-eligibility-status": element(),
    "#contract-source-quotation-field": element(),
    "#legacy-contract-commission-field": element()
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
  assert.match(html, /Contract terms are under review and issuance is not enabled\./);
  assert.match(html, /data-glossary-key="contract_issuance"/);
  assert.match(html, />Prepare Preview</);
  assert.match(html, /id="prepare-contract-form"[^>]*autocomplete="off"/);
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
  }, { search: "?commission_id=7" });
  await app.loadCommissions();
  assert.deepEqual(calls, ["/admin/api/commissions", `${ELIGIBILITY_API_PATH}?commission_id=7`]);
  assert.equal(documentObject.inputs.commission_id.value, "7");
  assert.match(documentObject.inputs.commission_id.innerHTML, /SAS-COM-2026-0007/);
});

test("accepted Quotation deep link loads canonical pre-Commission eligibility", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    return response({
      eligible: true,
      message: "Contract draft preparation is available.",
      quotation: { id: "9", quotation_number: "SAS-QUO-2026-0001", version: 1 }
    });
  }, { search: "?quotation_id=9" });
  await app.loadCommissions();
  assert.deepEqual(calls, [`${ELIGIBILITY_API_PATH}?quotation_id=9`]);
  assert.equal(documentObject.inputs.quotation_id.value, "9");
  assert.equal(documentObject.inputs.quotation_reference.value, "SAS-QUO-2026-0001 · v1");
  assert.equal(documentObject.elements["#legacy-contract-commission-field"].hidden, true);
});

test("pre-Commission summary does not render a fabricated Commission number", () => {
  const markup = renderPreparationSummary(preCommissionSnapshot);
  assert.match(markup, /Contract Commission/);
  assert.match(markup, /\$400\.00/);
  assert.match(markup, /\$200\.00/);
  assert.doesNotMatch(markup, /SAS-COM-/);
});

test("prepare flow keeps only a non-sensitive preview descriptor in memory", async () => {
  const documentObject = documentHarness();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url === "/admin/api/commissions") {
      return response({ commissions: [] });
    }
    return response({ snapshot, message: "Contract terms are still under review." });
  }, { search: "" });
  documentObject.inputs.commission_id.value = "7";
  documentObject.inputs.contract_date.value = "2026-10-09";
  documentObject.inputs.optional_message.value = "Review message";
  await app.prepare({ preventDefault() {} });

  assert.equal(calls[0], `${PREPARE_API_PATH}?commission_id=7&contract_date=2026-10-09`);
  assert.equal(documentObject.elements["#open-contract-preview"].hidden, false);
  assert.equal(
    documentObject.elements["#open-contract-preview"].href,
    "/admin/contract.html?preview=1&commission_id=7&contract_date=2026-10-09"
  );
});

test("preview URL contains only an opaque source id, date, and one-time reference", () => {
  const url = buildPreviewUrl({
    quotationId: "9",
    contractDate: "2026-10-09",
    previewReference: "00000000-0000-4000-8000-000000000009",
    optional_message: "Never put this in the URL",
    delivery_notes: "Or this"
  });
  assert.equal(
    url,
    "/admin/contract.html?preview=1&quotation_id=9&contract_date=2026-10-09&draft_ref=00000000-0000-4000-8000-000000000009"
  );
  assert.doesNotMatch(url, /Never|Or this|optional|delivery/);
});

test("unsaved document fields are handed off once in memory and then cleared", async () => {
  const documentObject = documentHarness();
  const opened = [];
  const app = createApp(documentObject, async () => response({
    snapshot,
    message: "Contract terms are still under review."
  }), { search: "" }, (url, target) => {
    opened.push({ url, target });
    return {};
  });
  documentObject.inputs.quotation_id.value = "9";
  documentObject.inputs.contract_date.value = "2026-10-09";
  documentObject.inputs.optional_message.value = "Review message";
  documentObject.inputs.delivery_notes.value = "Pickup details";
  await app.prepare({ preventDefault() {} });

  const openedPreview = app.openPreview({ preventDefault() {} });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].target, "_blank");
  assert.doesNotMatch(opened[0].url, /Review message|Pickup details/);
  assert.deepEqual(consumePreviewFields(openedPreview.reference), {
    optional_message: "Review message",
    delivery_notes: "Pickup details"
  });
  assert.equal(consumePreviewFields(openedPreview.reference), null);
  assert.equal(documentObject.inputs.optional_message.value, "");
  assert.equal(documentObject.inputs.delivery_notes.value, "");
  assert.equal(documentObject.elements["#open-contract-preview"].hidden, true);
});

test("navigation cleanup discards an unused one-time preview handoff", async () => {
  const documentObject = documentHarness();
  const lifecycleListeners = new Map();
  const lifecycle = {
    addEventListener(type, listener) { lifecycleListeners.set(type, listener); }
  };
  const app = createApp(documentObject, async () => response({ snapshot, message: "Prepared." }),
    { search: "" }, () => ({}), lifecycle);
  app.bindEvents();
  documentObject.inputs.commission_id.value = "7";
  documentObject.inputs.contract_date.value = "2026-10-09";
  documentObject.inputs.optional_message.value = "Temporary";
  await app.prepare({ preventDefault() {} });
  const openedPreview = app.openPreview({ preventDefault() {} });

  lifecycleListeners.get("pagehide")();
  assert.equal(consumePreviewFields(openedPreview.reference), null);
  assert.equal(documentObject.inputs.optional_message.value, "");
});

test("contract preparation scripts never write browser storage", () => {
  const source = readFileSync("web/js/admin-create-contract.js", "utf8");
  assert.doesNotMatch(source, /sessionStorage|localStorage|indexedDB|\.setItem\s*\(/);
});
