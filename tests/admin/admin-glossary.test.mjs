import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createGlossaryPage,
  createHelpController,
  createRegistry,
  filterEntries,
  getEntry,
  glossaryEntries,
  glossaryRegistry,
  renderGlossary
} = require("../../web/js/admin-glossary.js");

const requiredKeys = [
  "commission.draft", "commission.active", "commission.on_hold", "commission.cancelled", "commission.closed",
  "quotation", "quotation.draft", "quotation.issued", "quotation.sent", "quotation.accepted", "quotation.declined", "quotation.expired", "quotation.superseded", "quotation.withdrawn",
  "contract.draft", "contract.issued", "contract.accepted", "contract.superseded", "contract.withdrawn", "contract.terminated",
  "production.status", "production.canonical", "production.not_started", "production.reserved", "production.in_progress", "production.awaiting_client_review", "production.revision_in_progress", "production.final_presented", "production.final_accepted", "production.paused", "production.completed", "production.cancelled",
  "next_action", "derived_state", "action_required", "waiting", "blocked", "data_integrity_review",
  "financial.unpaid", "financial.partially_paid", "financial.paid", "financial.refund_due", "financial.partially_refunded", "financial.refunded",
  "delivery.pending", "delivery.ready", "delivery.scheduled", "delivery.shipped", "delivery.delivered", "delivery.picked_up", "delivery.in_storage", "delivery.cancelled",
  "delivery", "fulfillment", "delivery_method", "delivery_status", "pickup", "shipping", "actual_shipping_cost", "protection_cost", "tracking_number", "actual_fulfillment_cost", "release_eligibility",
  "provenance.origin", "provenance.supporting",
  "required_deposit", "deposit_received", "outstanding_balance", "payment", "receipt", "final_invoice", "document", "commission_number", "quotation_version", "contract_version", "snapshot", "special_terms", "shipping_charge", "shipping_estimate", "shipping_rate", "shipping_origin", "shipping_destination", "parcel_profile", "carrier", "service_level", "estimated_transit_time", "rate_provider", "sales_tax_rate", "expires_at", "request_id"
  , "acceptance", "electronic_acceptance", "admin_recorded_acceptance", "acceptance_method", "accepted_at", "snapshot_hash", "immutable_acceptance",
  "accepted_quotation", "contract_source_quotation", "contract_eligibility", "quotation_acceptance", "terms_version", "contract_draft", "contract_issuance"
  , "commission_event", "audit_trail", "event_type", "event_source", "append_only", "activity_history"
  , "financial_obligation", "charge", "payment_allocation", "allocated_amount", "outstanding_amount", "satisfied_obligation", "waived_obligation", "voided_obligation"
  , "storage_period", "free_storage", "storage_fee", "billable_week", "storage_notice", "final_written_notice", "abandonment_eligibility", "abandonment_review"
  , "calendar", "commission_timeline", "milestone", "upcoming", "overdue", "inspection_window", "estimated_completion", "calendar_entry", "derived_calendar_entry"
  , "communication", "communication_channel", "communication_type", "communication_status", "draft_communication", "manual_communication", "body_snapshot", "recipient_snapshot", "communication.ready", "communication.queued", "communication.sent", "communication.delivered", "communication.bounced", "communication.failed"
  , "communication_template", "template_version", "template_variable", "template_context", "template_preview", "review_before_send", "ready_for_sending", "generated_draft"
  , "send_communication", "sending_engine", "email_provider", "provider_message_id", "send_failure", "idempotent_send"
  , "reconciliation", "queued_stale", "confirmed_sent", "confirmed_not_sent", "inconclusive", "manual_reconciliation", "duplicate_send_risk"
  , "safe_automation", "automatic_communication", "inquiry_confirmation", "automation_trigger", "automation_policy", "auto_send", "review_required", "automation_pending"
];

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.style = {};
    this.listeners = new Map();
    this.focusCount = 0;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(child) {
    this.children.push(child);
  }

  closest(selector) {
    if (selector === "[data-glossary-key]" && this.getAttribute("data-glossary-key")) return this;
    if (selector === "[data-admin-help-close]" && this.getAttribute("data-admin-help-close")) return this;
    return null;
  }

  contains(target) {
    return target === this || this.children.includes(target);
  }

  focus() {
    this.focusCount += 1;
  }

  getBoundingClientRect() {
    return { left: 40, bottom: 80 };
  }
}

function createHelpDocument(keys) {
  const triggers = keys.map((key) => {
    const trigger = new FakeElement();
    trigger.setAttribute("data-glossary-key", key);
    return trigger;
  });
  const body = new FakeElement();
  const listeners = new Map();

  return {
    body,
    triggers,
    createElement() {
      return new FakeElement();
    },
    querySelectorAll(selector) {
      return selector === "[data-glossary-key]" ? triggers : [];
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event);
    }
  };
}

test("master registry contains every approved initial glossary key", () => {
  assert.equal(glossaryRegistry.size, glossaryEntries.length);
  for (const key of requiredKeys) assert.ok(getEntry(key), key);
});

test("every glossary entry contains the required structured fields", () => {
  for (const item of glossaryEntries) {
    for (const field of ["key", "term", "domain", "definition", "why_it_matters", "not_the_same_as"]) {
      assert.equal(typeof item[field], "string", `${item.key}.${field}`);
      assert.ok(item[field].trim(), `${item.key}.${field}`);
    }
  }
});

test("duplicate glossary keys are rejected", () => {
  assert.throws(
    () => createRegistry([glossaryEntries[0], glossaryEntries[0]]),
    /Duplicate or invalid glossary key/
  );
});

test("unknown glossary keys are handled without opening a popover", () => {
  const documentObject = createHelpDocument(["unknown.key"]);
  const controller = createHelpController(documentObject, { innerWidth: 1000, innerHeight: 800 });
  controller.bind();

  assert.equal(controller.open(documentObject.triggers[0]), false);
  assert.equal(documentObject.triggers[0].getAttribute("aria-expanded"), "false");
  assert.equal(documentObject.body.children.length, 0);
});

test("a glossary trigger opens matching help and updates ARIA", () => {
  const documentObject = createHelpDocument(["commission.active"]);
  const controller = createHelpController(documentObject, { innerWidth: 1000, innerHeight: 800 });
  controller.bind();
  documentObject.dispatch("click", {
    target: documentObject.triggers[0],
    preventDefault() {}
  });
  const popover = documentObject.body.children[0];

  assert.equal(documentObject.triggers[0].getAttribute("aria-expanded"), "true");
  assert.equal(documentObject.triggers[0].getAttribute("aria-controls"), "admin-glossary-popover");
  assert.equal(popover.hidden, false);
  assert.match(popover.innerHTML, /Active/);
  assert.match(popover.innerHTML, /required deposit has been received and verified/);
});

test("only one glossary popover can be active", () => {
  const documentObject = createHelpDocument(["commission.active", "snapshot"]);
  const controller = createHelpController(documentObject, { innerWidth: 1000, innerHeight: 800 });
  controller.bind();
  controller.open(documentObject.triggers[0]);
  controller.open(documentObject.triggers[1]);

  assert.equal(documentObject.body.children.length, 1);
  assert.equal(documentObject.triggers[0].getAttribute("aria-expanded"), "false");
  assert.equal(documentObject.triggers[1].getAttribute("aria-expanded"), "true");
  assert.match(documentObject.body.children[0].innerHTML, /immutable copy/);
});

test("Escape closes help and restores trigger focus", () => {
  const documentObject = createHelpDocument(["snapshot"]);
  const controller = createHelpController(documentObject, { innerWidth: 1000, innerHeight: 800 });
  controller.bind();
  controller.open(documentObject.triggers[0]);
  documentObject.dispatch("keydown", { key: "Escape", preventDefault() {} });

  assert.equal(documentObject.triggers[0].getAttribute("aria-expanded"), "false");
  assert.equal(documentObject.body.children[0].hidden, true);
  assert.equal(documentObject.triggers[0].focusCount, 1);
});

test("an outside click closes the open help", () => {
  const documentObject = createHelpDocument(["payment"]);
  const controller = createHelpController(documentObject, { innerWidth: 1000, innerHeight: 800 });
  controller.bind();
  controller.open(documentObject.triggers[0]);
  documentObject.dispatch("click", { target: new FakeElement() });

  assert.equal(documentObject.triggers[0].getAttribute("aria-expanded"), "false");
  assert.equal(documentObject.body.children[0].hidden, true);
});

test("glossary search filters across term and domain without changing the registry", () => {
  const production = filterEntries("final presented");
  const financial = filterEntries("financial");

  assert.deepEqual(production.map((item) => item.key), ["production.final_presented"]);
  assert.ok(financial.some((item) => item.key === "financial.paid"));
  assert.equal(glossaryRegistry.size, glossaryEntries.length);
});

test("glossary page renders the same master registry and supports direct keys", () => {
  const markup = renderGlossary();
  const html = readFileSync(new URL("../../web/admin/glossary.html", import.meta.url), "utf8");

  assert.match(markup, /data-glossary-entry="commission\.active"/);
  assert.match(markup, /data-glossary-entry="provenance\.supporting"/);
  assert.match(html, /id="admin-glossary-list"/);
  assert.match(html, /src="\.\.\/js\/admin-glossary\.js"/);
});

test("glossary page search and hash focus use the shared entries", () => {
  const search = new FakeElement();
  const list = new FakeElement();
  const count = new FakeElement();
  const target = new FakeElement();
  target.scrollIntoView = () => {};
  const documentObject = {
    querySelector(selector) {
      return {
        "#glossary-search": search,
        "#admin-glossary-list": list,
        "#glossary-count": count,
        '[data-glossary-entry="commission.active"]': target
      }[selector] || null;
    }
  };
  const page = createGlossaryPage(documentObject, { hash: "#commission.active" });
  page.bind();

  assert.equal(count.textContent, String(glossaryEntries.length));
  assert.equal(target.focusCount, 1);
  search.value = "supporting";
  search.listeners.get("input")();
  assert.equal(count.textContent, "1");
  assert.match(list.innerHTML, /provenance\.supporting/);
});

test("strategic Admin pages load the shared help component", () => {
  const commissions = readFileSync("web/admin/commissions.html", "utf8");
  const createContract = readFileSync("web/admin/create-contract.html", "utf8");
  const contract = readFileSync("web/admin/contract.html", "utf8");
  const calendar = readFileSync("web/admin/calendar.html", "utf8");
  const dashboard = readFileSync("web/admin/dashboard.html", "utf8");

  for (const html of [commissions, createContract, contract, calendar]) {
    assert.match(html, /admin-glossary\.css/);
    assert.match(html, /admin-glossary\.js/);
    assert.match(html, /data-glossary-key=/);
  }
  assert.match(dashboard, /href="glossary\.html"/);
  assert.match(dashboard, /href="calendar\.html"/);
});
