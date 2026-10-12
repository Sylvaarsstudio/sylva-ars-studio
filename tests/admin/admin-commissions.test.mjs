import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  CONTRACT_ELIGIBILITY_API_PATH,
  buildCreatePayload,
  buildDeliveryCreatePayload,
  buildDeliveryUpdatePayload,
  buildEditPayload,
  buildPaymentPayload,
  calculateFinancialPreview,
  createApp,
  describeCommissionEvent,
  describeDocument,
  formatCurrency,
  inferSalesTaxRate,
  paymentMethodLabels,
  renderCommissionDocumentsMarkup,
  renderCommissionCommunicationsMarkup,
  renderCommissionEventsMarkup,
  renderCommissionTimelineMarkup,
  renderNextActionMarkup,
  renderObligationsMarkup,
  renderDeliveryActionsMarkup,
  renderDeliveryMarkup,
  renderProductionMarkup,
  renderDetailMarkup,
  renderListMarkup,
  renderOriginInquiryOptions,
  renderPaymentsMarkup,
  renderProvenanceMarkup,
  renderStatusOptions,
  statusTransitions
} = require("../../web/js/admin-commissions.js");

const formFields = [
  "client_id",
  "origin_inquiry_id",
  "title",
  "description",
  "medium",
  "width",
  "height",
  "price",
  "sales_tax_rate",
  "shipping",
  "estimated_completion",
  "status",
  "payment_type",
  "amount",
  "sales_tax",
  "payment_method",
  "payment_date",
  "external_reference",
  "notes",
  "delivery_method",
  "recipient_name",
  "address_line1",
  "address_line2",
  "city",
  "state_region",
  "postal_code",
  "country",
  "carrier",
  "service_level",
  "tracking_number",
  "actual_shipping_cost",
  "protection_cost"
];

function createClassList() {
  const values = new Set();

  return {
    add(value) {
      values.add(value);
    },
    remove(value) {
      values.delete(value);
    },
    contains(value) {
      return values.has(value);
    }
  };
}

function createElement() {
  const listeners = new Map();

  return {
    textContent: "",
    innerHTML: "",
    hidden: false,
    value: "",
    classList: createClassList(),
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
}

function createFormElement() {
  const form = createElement();
  const inputs = Object.fromEntries(
    formFields.map((field) => [field, createElement()])
  );
  form.elements = {
    namedItem(name) {
      return inputs[name];
    }
  };
  form.inputs = inputs;
  form.reset = () => {
    Object.values(inputs).forEach((input) => {
      input.value = "";
    });
  };
  return form;
}

function createDocument() {
  const form = createFormElement();
  const editForm = createFormElement();
  const statusForm = createFormElement();
  const paymentForm = createFormElement();
  const deliveryCreateForm = createFormElement();
  const deliveryEditForm = createFormElement();
  paymentForm.hidden = true;
  deliveryCreateForm.hidden = true;
  deliveryEditForm.hidden = true;
  const elements = {
    "#commission-count": createElement(),
    "#commission-index-toolbar": createElement(),
    "#commission-workspace": createElement(),
    "#commission-list-panel": createElement(),
    "#commission-list": createElement(),
    "#commission-list-status": createElement(),
    "#new-commission": createElement(),
    "#commission-detail": createElement(),
    "#commission-detail-fields": createElement(),
    "#commission-detail-status": createElement(),
    "#close-commission-detail": createElement(),
    "#edit-commission": createElement(),
    "#change-commission-status": createElement(),
    "#commission-payments": createElement(),
    "#payment-list": createElement(),
    "#payment-status": createElement(),
    "#payment-receipt-action": createElement(),
    "#payment-guidance": createElement(),
    "#record-payment": createElement(),
    "#payment-form": paymentForm,
    "#cancel-payment": createElement(),
    "#commission-document-list": createElement(),
    "#commission-documents-status": createElement(),
    "#commission-communications-list": createElement(),
    "#commission-communications-status": createElement(),
    "#create-communication": createElement(),
    "#new-communication-draft": createElement(),
    "#record-manual-communication": createElement(),
    "#quotation-list": createElement(),
    "#quotation-status": createElement(),
    "#prepare-quotation": createElement(),
    "#prepare-contract": createElement(),
    "#contract-eligibility-status": createElement(),
    "#commission-activity-list": createElement(),
    "#commission-activity-status": createElement(),
    "#commission-timeline-list": createElement(),
    "#commission-timeline-status": createElement(),
    "#commission-production-detail": createElement(),
    "#commission-production-status": createElement(),
    "#commission-next-action-detail": createElement(),
    "#commission-next-action-status": createElement(),
    "#commission-obligations-detail": createElement(),
    "#commission-obligations-status": createElement(),
    "#commission-delivery-detail": createElement(),
    "#commission-delivery-status": createElement(),
    "#commission-delivery-actions": createElement(),
    "#create-delivery": createElement(),
    "#edit-delivery": createElement(),
    "#delivery-create-form": deliveryCreateForm,
    "#cancel-delivery-create": createElement(),
    "#delivery-shipping-fields": createElement(),
    "#delivery-edit-form": deliveryEditForm,
    "#cancel-delivery-edit": createElement(),
    "#delivery-actual-cost-field": createElement(),
    "#delivery-protection-cost-field": createElement(),
    "#delivery-cancel-confirmation": createElement(),
    "#confirm-delivery-cancel": createElement(),
    "#keep-delivery": createElement(),
    "#delivery-scheduled-at": createElement(),
    "#commission-status-form": statusForm,
    "#cancel-commission-status": createElement(),
    "#commission-status-confirmation": createElement(),
    "#commission-status-confirmation-text": createElement(),
    "#confirm-commission-status": createElement(),
    "#cancel-commission-status-confirmation": createElement(),
    "#commission-edit-form": editForm,
    "#edit-sales-tax-preview": createElement(),
    "#edit-required-deposit-preview": createElement(),
    "#edit-remaining-after-deposit-preview": createElement(),
    "#cancel-commission-edit": createElement(),
    "#commission-create": createElement(),
    "#commission-form": form,
    "#commission-create-status": createElement(),
    "#sales-tax-preview": createElement(),
    "#required-deposit-preview": createElement(),
    "#remaining-after-deposit-preview": createElement(),
    "#cancel-commission": createElement()
  };
  elements["#commission-detail"].hidden = true;
  elements["#commission-edit-form"].hidden = true;
  elements["#commission-status-form"].hidden = true;
  elements["#commission-status-confirmation"].hidden = true;
  elements["#delivery-cancel-confirmation"].hidden = true;
  elements["#commission-create"].hidden = true;

  return {
    elements,
    inputs: form.inputs,
    editInputs: editForm.inputs,
    paymentInputs: paymentForm.inputs,
    deliveryCreateInputs: deliveryCreateForm.inputs,
    deliveryEditInputs: deliveryEditForm.inputs,
    statusInputs: statusForm.inputs,
    querySelector(selector) {
      return elements[selector];
    }
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    async json() {
      return body;
    }
  };
}

const sampleClient = {
  id: "1",
  full_name: "Test Client",
  email: "test@example.invalid"
};

const sampleCommission = {
  id: "10",
  commission_number: "SAS-COM-2026-0001",
  client_id: "1",
  client_name: "Test Client",
  client_email: "test@example.invalid",
  title: "Test Commission",
  description: "A test commission.",
  medium: "Oil",
  width: "20.00",
  height: "24.00",
  price: "100.00",
  deposit_amount: "0.00",
  amount_paid: "0.00",
  sales_tax: "6.00",
  shipping: "10.00",
  balance: "116.00",
  status: "draft",
  estimated_completion: null,
  created_at: "2026-01-01T10:00:00Z",
  inquiries: []
};

function fillValidForm(documentObject) {
  Object.assign(documentObject.inputs.client_id, { value: "1" });
  Object.assign(documentObject.inputs.title, { value: " Test Commission " });
  Object.assign(documentObject.inputs.description, { value: " A test commission. " });
  Object.assign(documentObject.inputs.medium, { value: " Oil " });
  Object.assign(documentObject.inputs.width, { value: "20" });
  Object.assign(documentObject.inputs.height, { value: "24" });
  Object.assign(documentObject.inputs.price, { value: "100" });
  Object.assign(documentObject.inputs.sales_tax_rate, { value: "0.06" });
  Object.assign(documentObject.inputs.shipping, { value: "10" });
  Object.assign(documentObject.inputs.estimated_completion, { value: "" });
}

test("admin commissions renders the list and counter", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({
      success: true,
      total: 1,
      commissions: [sampleCommission]
    })
  );

  await app.loadList();

  assert.equal(documentObject.elements["#commission-count"].textContent, "1");
  assert.match(documentObject.elements["#commission-list"].innerHTML, /SAS-COM-2026-0001/);
  assert.match(documentObject.elements["#commission-list"].innerHTML, /Test Client/);
  assert.equal(documentObject.elements["#commission-list-panel"].hidden, false);
  assert.equal(documentObject.elements["#commission-detail"].hidden, true);
});

test("admin commission detail opens", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );

  await app.openDetail(sampleCommission.id);

  assert.equal(documentObject.elements["#commission-detail"].hidden, false);
  assert.equal(documentObject.elements["#commission-index-toolbar"].hidden, true);
  assert.equal(documentObject.elements["#commission-list-panel"].hidden, true);
  assert.equal(
    documentObject.elements["#commission-workspace"].classList.contains("is-detail-mode"),
    true
  );
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Test Commission/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Oil/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /commission-status-badge/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Draft/);
});

test("Back to Commissions restores the list without another request", async () => {
  const documentObject = createDocument();
  let calls = 0;
  const app = createApp(documentObject, async (url) => {
    calls += 1;
    return commissionDetailFetch()(url);
  });

  await app.openDetail(sampleCommission.id);
  const callsAfterOpen = calls;
  app.showCommissionIndex();

  assert.equal(documentObject.elements["#commission-detail"].hidden, true);
  assert.equal(documentObject.elements["#commission-index-toolbar"].hidden, false);
  assert.equal(documentObject.elements["#commission-list-panel"].hidden, false);
  assert.equal(
    documentObject.elements["#commission-workspace"].classList.contains("is-detail-mode"),
    false
  );
  assert.equal(calls, callsAfterOpen);
});

test("admin commission status controls expose no document actions", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="change-commission-status">Change Status</);
  assert.match(html, /id="commission-status-form"/);
  assert.doesNotMatch(html, /name="document/);
});

test("admin commission status options include only allowed transitions", () => {
  assert.deepEqual(statusTransitions, {
    draft: ["quoted", "cancelled"],
    quoted: ["draft", "approved", "cancelled"],
    approved: ["quoted", "in_progress", "cancelled"],
    in_progress: ["approved", "completed", "cancelled"],
    completed: ["in_progress"],
    cancelled: ["draft"]
  });
  assert.match(renderStatusOptions("draft"), /Quoted/);
  assert.match(renderStatusOptions("draft"), /Cancelled/);
  assert.doesNotMatch(renderStatusOptions("draft"), /Completed/);
  assert.match(renderStatusOptions("quoted"), /Approved/);
  assert.equal(
    renderStatusOptions("completed"),
    '<option value="in_progress">In Progress</option>'
  );
  assert.equal(
    renderStatusOptions("cancelled"),
    '<option value="draft">Draft</option>'
  );
});

test("admin commission Change Status opens valid choices", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );

  await app.openDetail(sampleCommission.id);
  app.openStatus();

  assert.equal(documentObject.elements["#commission-status-form"].hidden, false);
  assert.equal(documentObject.statusInputs.status.value, "quoted");
  assert.match(documentObject.statusInputs.status.innerHTML, /Quoted/);
  assert.match(documentObject.statusInputs.status.innerHTML, /Cancelled/);
  assert.doesNotMatch(documentObject.statusInputs.status.innerHTML, /Completed/);
});

test("admin commission status confirmation can be cancelled without a request", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ success: true, commission: sampleCommission });
  });

  await app.openDetail(sampleCommission.id);
  app.openStatus();
  documentObject.statusInputs.status.value = "quoted";
  app.prepareStatusConfirmation();

  assert.equal(
    documentObject.elements["#commission-status-confirmation-text"].textContent,
    "Change commission status from DRAFT to QUOTED?"
  );
  assert.equal(documentObject.elements["#commission-status-confirmation"].hidden, false);
  app.cancelStatusConfirmation();
  assert.equal(documentObject.elements["#commission-status-confirmation"].hidden, true);
  assert.equal(documentObject.elements["#commission-status-form"].hidden, false);
  assert.equal(calls.length, 12);
});

test("Commission detail offers Contract preparation only when canonical eligibility passes", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url) => {
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) {
      return jsonResponse({
        success: true,
        eligible: true,
        message: "Accepted quotation is eligible for Contract preparation.",
        quotation: { id: "9", quotation_number: "SAS-QUO-2026-0001", version: 1 }
      });
    }
    if (url.includes("/payments")) return jsonResponse({ success: true, commission: sampleCommission, payments: [] });
    if (url.startsWith("/admin/api/documents")) return jsonResponse({ success: true, documents: [] });
    if (url.endsWith("/quotations")) return jsonResponse({ success: true, quotations: [] });
    return jsonResponse({ success: true, commission: sampleCommission });
  });

  await app.openDetail(sampleCommission.id);

  assert.equal(documentObject.elements["#prepare-contract"].hidden, false);
  assert.equal(documentObject.elements["#prepare-contract"].href, "create-contract.html?commission_id=10");
  assert.match(documentObject.elements["#contract-eligibility-status"].textContent, /eligible/i);
});

test("Commission detail keeps Contract preparation blocked with the backend reason", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url) => {
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) {
      return jsonResponse({ success: true, eligible: false, reason: "no_accepted_quotation", message: "An accepted quotation is required." });
    }
    if (url.includes("/payments")) return jsonResponse({ success: true, commission: sampleCommission, payments: [] });
    if (url.startsWith("/admin/api/documents")) return jsonResponse({ success: true, documents: [] });
    if (url.endsWith("/quotations")) return jsonResponse({ success: true, quotations: [] });
    return jsonResponse({ success: true, commission: sampleCommission });
  });

  await app.openDetail(sampleCommission.id);

  assert.equal(documentObject.elements["#prepare-contract"].hidden, true);
  assert.equal(documentObject.elements["#contract-eligibility-status"].textContent, "An accepted quotation is required.");
});

test("Commission detail includes the Activity History section and glossary help", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-activity"/);
  assert.match(html, /id="commission-activity-list"/);
  assert.match(html, /data-glossary-key="activity_history"/);
});

test("Commission detail distinguishes Timeline milestones from Activity audit history", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-timeline"/);
  assert.match(html, /id="commission-timeline-list"/);
  assert.match(html, /data-glossary-key="commission_timeline"/);
  assert.match(html, /Timeline[\s\S]*Activity \/ History remains the audit trail/);
});

test("Commission detail includes read-only canonical Production without operational CTAs", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-production"/);
  assert.match(html, /id="commission-production-detail"/);
  assert.match(html, /data-glossary-key="production\.canonical"/);
  assert.doesNotMatch(html, />Reserve Production</);
  assert.doesNotMatch(html, />Start Production</);
});

test("Commission detail includes the derived Next Action card and glossary help", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-next-action"/);
  assert.match(html, /id="commission-next-action-detail"/);
  assert.match(html, /data-glossary-key="next_action"/);
});

test("Commission detail includes read-only canonical Financial Obligations", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-obligations"/);
  assert.match(html, /id="commission-obligations-detail"/);
  assert.match(html, /data-glossary-key="financial_obligation"/);
  assert.doesNotMatch(html, />Create Charge</);
  assert.doesNotMatch(html, />Allocate Payment</);
  assert.doesNotMatch(html, />Waive</);
  assert.doesNotMatch(html, />Void</);
});

test("Financial Obligations renderer distinguishes empty canonical state from legacy totals", () => {
  const markup = renderObligationsMarkup({ initialized: false, obligations: [] });
  assert.match(markup, /No canonical obligations yet\./);
  assert.match(markup, /Legacy financial totals remain available for compatibility but are not canonical obligations\./);
});

test("Financial Obligations renderer shows canonical amounts without mutation actions", () => {
  const markup = renderObligationsMarkup({
    initialized: true,
    obligations: [{
      id: "5",
      obligation_type: "modification_charge",
      obligation_status: "open",
      amount: "125.00",
      allocated_amount: "25.00",
      outstanding_amount: "100.00",
      due_at: null,
      source_type: "quotation",
      source_id: "17"
    }]
  });
  assert.match(markup, /Modification Charge/);
  assert.match(markup, /\$125\.00/);
  assert.match(markup, /\$25\.00/);
  assert.match(markup, /\$100\.00/);
  assert.match(markup, /Quotation 17/);
  assert.doesNotMatch(markup, /<button|<form/);
});

test("Commission detail loads Financial Obligations from its protected read endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/obligations")) {
      return jsonResponse({
        success: true,
        initialized: false,
        obligations: []
      });
    }
    return commissionDetailFetch()(url);
  });

  await app.openDetail(sampleCommission.id);

  assert.ok(calls.includes(`/admin/api/commissions/${sampleCommission.id}/obligations`));
  assert.match(documentObject.elements["#commission-obligations-detail"].innerHTML, /No canonical obligations yet/);
});

test("Commission detail includes the canonical Delivery workflow without Storage controls", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-delivery"/);
  assert.match(html, /id="commission-delivery-detail"/);
  assert.match(html, /data-glossary-key="delivery"/);
  assert.match(html, />Create Delivery</);
  assert.match(html, /id="delivery-create-form"/);
  assert.match(html, /id="delivery-edit-form"/);
  assert.match(html, /id="delivery-cancel-confirmation"/);
  assert.doesNotMatch(html, /Mark Abandoned|Dispose Artwork|Sell Artwork/);
});

test("Delivery renderer provides the approved empty canonical state without inference", () => {
  const markup = renderDeliveryMarkup({ initialized: false, delivery: null });
  assert.match(markup, /No canonical delivery record yet\./);
  assert.match(markup, /No fulfillment has been inferred/);
  assert.match(markup, /Shipping Charge/);
});

test("Delivery renderer shows populated historical fulfillment data read-only", () => {
  const markup = renderDeliveryMarkup({
    initialized: true,
    delivery: {
      id: "7",
      delivery_method: "shipping",
      delivery_status: "shipped",
      recipient_name: "Delivery Recipient",
      address_line1: "100 Test Avenue",
      address_line2: null,
      city: "Pittsburgh",
      state_region: "PA",
      postal_code: "15222",
      country: "US",
      carrier: "Test Carrier",
      service_level: "Ground",
      tracking_number: "TRACK-001",
      actual_shipping_cost: "42.50",
      protection_cost: "8.00",
      ready_at: "2026-10-11T14:00:00Z",
      scheduled_at: null,
      shipped_at: "2026-10-11T16:00:00Z",
      delivered_at: null,
      picked_up_at: null,
      storage_start_at: null
    }
  });
  assert.match(markup, /Shipping/);
  assert.match(markup, /Shipped/);
  assert.match(markup, /Delivery Recipient/);
  assert.match(markup, /100 Test Avenue, Pittsburgh, PA, 15222, US/);
  assert.match(markup, /Test Carrier · Ground/);
  assert.match(markup, /TRACK-001/);
  assert.match(markup, /\$42\.50/);
  assert.match(markup, /\$8\.00/);
  assert.match(markup, /Shipping Charge is the commercial amount billed to the Client/);
  assert.match(markup, /Actual Shipping Cost is the fulfillment cost to SAS/);
  assert.doesNotMatch(markup, /<form|<button[^>]+data-delivery-action/);
});

test("Delivery renderer presents Storage timing, fee, notices, and legal-review eligibility", () => {
  const markup = renderDeliveryMarkup({
    initialized: true,
    delivery: {
      id: "8",
      delivery_method: "pickup",
      delivery_status: "in_storage",
      recipient_name: "Storage Recipient",
      storage_start_at: "2026-10-11T18:30:00Z",
      storage_notice_at: "2026-11-15T19:30:00Z",
      final_notice_at: "2026-11-18T19:30:00Z",
      storage_state: {
        free_storage_ends_at: "2026-11-10T19:30:00Z",
        billable_weeks: 2,
        estimated_storage_fee: "20.00",
        abandonment_eligible_at: "2027-05-17T18:30:00Z",
        abandonment_eligible: true
      }
    }
  });
  for (const text of [
    "Storage Started", "Free Storage Ends", "Billable Weeks",
    "Current Storage Fee", "Storage Notice", "Final Written Notice",
    "Abandonment Review Eligible Date", "Eligible for legal review"
  ]) assert.match(markup, new RegExp(text));
  assert.match(markup, /\$20\.00/);
  assert.doesNotMatch(markup, /Mark Abandoned|Dispose Artwork|Sell Artwork/);
});

test("Commission detail loads Delivery from its protected read endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/delivery")) {
      return jsonResponse({ success: true, initialized: false, delivery: null });
    }
    return commissionDetailFetch()(url);
  });

  await app.openDetail(sampleCommission.id);

  assert.ok(calls.includes(`/admin/api/commissions/${sampleCommission.id}/delivery`));
  assert.match(documentObject.elements["#commission-delivery-detail"].innerHTML, /No canonical delivery record yet/);
});

test("Delivery release eligibility controls creation without hiding the canonical reason", async () => {
  const blockedDocument = createDocument();
  const blockedApp = createApp(blockedDocument, async (url) => {
    if (url.endsWith("/delivery")) {
      return jsonResponse({
        success: true,
        initialized: false,
        delivery: null,
        release_eligibility: {
          eligible: false,
          reason: "canonical_financial_clearance_unavailable",
          message: "Canonical financial clearance is unavailable because no Financial Obligations exist."
        }
      });
    }
    return commissionDetailFetch()(url);
  });
  await blockedApp.openDetail(sampleCommission.id);
  assert.equal(blockedDocument.elements["#create-delivery"].hidden, true);
  assert.match(
    blockedDocument.elements["#commission-delivery-detail"].innerHTML,
    /Canonical financial clearance is unavailable/
  );

  const eligibleDocument = createDocument();
  const eligibleApp = createApp(eligibleDocument, async (url) => {
    if (url.endsWith("/delivery")) {
      return jsonResponse({
        success: true,
        initialized: false,
        delivery: null,
        release_eligibility: { eligible: true, reason: null, message: "Release requirements satisfied." }
      });
    }
    return commissionDetailFetch()(url);
  });
  await eligibleApp.openDetail(sampleCommission.id);
  assert.equal(eligibleDocument.elements["#create-delivery"].hidden, false);
});

test("Delivery action renderer is method-specific, Storage-aware, and terminal-safe", () => {
  const shippingReady = renderDeliveryActionsMarkup({
    delivery_method: "shipping",
    delivery_status: "ready"
  });
  assert.match(shippingReady, /data-delivery-transition="shipped"/);
  assert.match(shippingReady, /data-delivery-transition="cancelled"/);
  assert.match(shippingReady, /data-delivery-storage-action="storage"/);
  assert.doesNotMatch(shippingReady, /scheduled|picked_up/i);

  const pickupReady = renderDeliveryActionsMarkup({
    delivery_method: "pickup",
    delivery_status: "ready"
  });
  assert.match(pickupReady, /data-delivery-transition="scheduled"/);
  assert.match(pickupReady, /data-delivery-transition="picked_up"/);
  assert.match(pickupReady, /id="delivery-scheduled-at"/);
  assert.match(pickupReady, /data-delivery-storage-action="storage"/);
  assert.doesNotMatch(pickupReady, /shipped/i);

  const inStorage = renderDeliveryActionsMarkup({
    delivery_method: "pickup",
    delivery_status: "in_storage",
    storage_notice_at: null,
    final_notice_at: null
  });
  assert.match(inStorage, /Record Storage Notice/);
  assert.match(inStorage, /Record Final Written Notice/);
  assert.match(inStorage, /data-delivery-transition="scheduled"/);
  assert.match(inStorage, /data-delivery-transition="picked_up"/);
  assert.doesNotMatch(inStorage, /Mark Abandoned|Dispose Artwork|Sell Artwork/);

  assert.match(renderDeliveryActionsMarkup({
    delivery_method: "shipping",
    delivery_status: "delivered"
  }), /terminal and read-only/);
});

test("Delivery creation shows shipping destination fields only for shipping", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, commissionDetailFetch());
  await app.openDetail(sampleCommission.id);
  documentObject.deliveryCreateInputs.delivery_method.value = "pickup";
  app.openDeliveryCreate();
  assert.equal(documentObject.elements["#delivery-shipping-fields"].hidden, true);
  documentObject.deliveryCreateInputs.delivery_method.value = "shipping";
  app.openDeliveryCreate();
  assert.equal(documentObject.elements["#delivery-shipping-fields"].hidden, false);
});

test("Delivery payload builders preserve snapshots and isolate actual shipping costs", () => {
  const documentObject = createDocument();
  Object.assign(documentObject.deliveryCreateInputs.delivery_method, { value: "shipping" });
  Object.assign(documentObject.deliveryCreateInputs.recipient_name, { value: " Recipient " });
  Object.assign(documentObject.deliveryCreateInputs.address_line1, { value: " 100 Test Avenue " });
  Object.assign(documentObject.deliveryCreateInputs.city, { value: " Pittsburgh " });
  Object.assign(documentObject.deliveryCreateInputs.state_region, { value: " PA " });
  Object.assign(documentObject.deliveryCreateInputs.postal_code, { value: " 15222 " });
  Object.assign(documentObject.deliveryCreateInputs.country, { value: " US " });
  const created = buildDeliveryCreatePayload(documentObject.elements["#delivery-create-form"]);
  assert.equal(created.recipient_name, "Recipient");
  assert.equal(created.address_line1, "100 Test Avenue");
  assert.equal(created.city, "Pittsburgh");
  assert.equal("actual_shipping_cost" in created, false);
  assert.equal("delivery_status" in created, false);

  documentObject.deliveryEditInputs.actual_shipping_cost.value = "42.50";
  documentObject.deliveryEditInputs.protection_cost.value = "8";
  const updated = buildDeliveryUpdatePayload(
    documentObject.elements["#delivery-edit-form"],
    "shipping"
  );
  assert.equal(updated.actual_shipping_cost, "42.50");
  assert.equal(updated.protection_cost, "8");
  assert.equal("delivery_method" in updated, false);
  assert.equal("delivery_status" in updated, false);
});

test("Admin Delivery create and transition use the protected workflow endpoints", async () => {
  const documentObject = createDocument();
  const calls = [];
  const pendingDelivery = {
    id: "70",
    commission_id: sampleCommission.id,
    ...Object.fromEntries([
      "address_line2", "scheduled_at", "shipped_at", "delivered_at",
      "picked_up_at", "storage_start_at", "actual_shipping_cost", "protection_cost"
    ].map((field) => [field, null])),
    delivery_method: "shipping",
    delivery_status: "pending",
    recipient_name: "Recipient",
    address_line1: "100 Test Avenue",
    city: "Pittsburgh",
    state_region: "PA",
    postal_code: "15222",
    country: "US",
    carrier: "Carrier",
    service_level: null,
    tracking_number: null,
    ready_at: null,
    notes: null
  };
  const app = createApp(documentObject, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/delivery") && !options.method) {
      return jsonResponse({
        success: true,
        initialized: false,
        delivery: null,
        release_eligibility: { eligible: true, reason: null, message: "Eligible." }
      });
    }
    if (url.endsWith("/delivery") && options.method === "POST") {
      return jsonResponse({ success: true, delivery: pendingDelivery }, 201);
    }
    if (url.endsWith("/delivery/transition")) {
      return jsonResponse({
        success: true,
        delivery: {
          ...pendingDelivery,
          delivery_status: "ready",
          ready_at: "2026-10-11T18:30:00Z"
        }
      });
    }
    return commissionDetailFetch()(url);
  });
  await app.openDetail(sampleCommission.id);
  Object.assign(documentObject.deliveryCreateInputs.delivery_method, { value: "shipping" });
  Object.assign(documentObject.deliveryCreateInputs.recipient_name, { value: "Recipient" });
  Object.assign(documentObject.deliveryCreateInputs.address_line1, { value: "100 Test Avenue" });
  Object.assign(documentObject.deliveryCreateInputs.city, { value: "Pittsburgh" });
  Object.assign(documentObject.deliveryCreateInputs.state_region, { value: "PA" });
  Object.assign(documentObject.deliveryCreateInputs.postal_code, { value: "15222" });
  Object.assign(documentObject.deliveryCreateInputs.country, { value: "US" });
  Object.assign(documentObject.deliveryCreateInputs.carrier, { value: "Carrier" });
  assert.equal((await app.submitDeliveryCreate({ preventDefault() {} })).delivery_status, "pending");
  assert.equal((await app.transitionDelivery("ready")).delivery_status, "ready");
  const createCall = calls.find((call) => call.url.endsWith("/delivery") && call.options.method === "POST");
  const transitionCall = calls.find((call) => call.url.endsWith("/delivery/transition"));
  assert.ok(createCall);
  assert.deepEqual(JSON.parse(transitionCall.options.body), { next_status: "ready" });
  assert.match(documentObject.elements["#commission-delivery-detail"].innerHTML, /Ready/);
});

test("Admin Storage actions use explicit endpoints and refresh obligations and Activity", async () => {
  const documentObject = createDocument();
  const calls = [];
  const readyDelivery = {
    id: "72",
    commission_id: sampleCommission.id,
    delivery_method: "pickup",
    delivery_status: "ready",
    recipient_name: "Recipient",
    storage_start_at: null,
    storage_notice_at: null,
    final_notice_at: null
  };
  const storedDelivery = {
    ...readyDelivery,
    delivery_status: "in_storage",
    storage_start_at: "2026-10-11T18:30:00Z",
    storage_fee_start_at: "2026-11-10T19:30:00Z",
    storage_state: {
      free_storage_ends_at: "2026-11-10T19:30:00Z",
      billable_weeks: 0,
      estimated_storage_fee: "0.00",
      abandonment_eligible_at: null,
      abandonment_eligible: false
    }
  };
  const app = createApp(documentObject, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/delivery") && !options.method) {
      return jsonResponse({ success: true, initialized: true, delivery: readyDelivery });
    }
    if (url.endsWith("/delivery/storage")) {
      return jsonResponse({ success: true, created: true, delivery: storedDelivery });
    }
    if (url.endsWith("/delivery/storage-notice")) {
      return jsonResponse({
        success: true,
        created: true,
        delivery: { ...storedDelivery, storage_notice_at: "2026-10-12T18:30:00Z" }
      });
    }
    return commissionDetailFetch()(url);
  });
  await app.openDetail(sampleCommission.id);
  assert.equal((await app.performDeliveryStorageAction("storage")).delivery_status, "in_storage");
  assert.ok(calls.some((call) => call.url.endsWith("/delivery/storage") && call.options.method === "POST"));
  await app.performDeliveryStorageAction("storage-notice");
  assert.ok(calls.some((call) => call.url.endsWith("/delivery/storage-notice") && call.options.method === "POST"));
  assert.ok(calls.some((call) => call.url.endsWith("/obligations")));
  assert.ok(calls.some((call) => call.url.endsWith("/events")));
  assert.doesNotMatch(documentObject.elements["#commission-delivery-actions"].innerHTML, /Mark Abandoned/);
});

test("Delivery cancellation requires explicit confirmation before its transition request", async () => {
  const documentObject = createDocument();
  let transitionCalls = 0;
  const delivery = {
    id: "71",
    commission_id: sampleCommission.id,
    delivery_method: "pickup",
    delivery_status: "ready",
    recipient_name: "Recipient"
  };
  const app = createApp(documentObject, async (url, options = {}) => {
    if (url.endsWith("/delivery") && !options.method) {
      return jsonResponse({ success: true, initialized: true, delivery });
    }
    if (url.endsWith("/delivery/transition")) {
      transitionCalls += 1;
      return jsonResponse({
        success: true,
        delivery: { ...delivery, delivery_status: "cancelled" }
      });
    }
    return commissionDetailFetch()(url);
  });
  await app.openDetail(sampleCommission.id);
  assert.equal(await app.transitionDelivery("cancelled"), null);
  assert.equal(transitionCalls, 0);
  assert.equal(documentObject.elements["#delivery-cancel-confirmation"].hidden, false);
  const cancelled = await app.confirmDeliveryCancellation();
  assert.equal(cancelled.delivery_status, "cancelled");
  assert.equal(transitionCalls, 1);
  assert.match(documentObject.elements["#commission-delivery-status"].textContent, /Commission was not cancelled/);
});

test("Activity renderer presents Delivery workflow events without raw payload", () => {
  const events = [
    {
      id: "1",
      event_type: "delivery_created",
      occurred_at: "2026-10-11T18:00:00Z",
      payload: { delivery_method: "shipping", recipient_name: "Private Name" }
    },
    {
      id: "2",
      event_type: "delivery_shipped",
      occurred_at: "2026-10-11T19:00:00Z",
      payload: { tracking_number: "PRIVATE-TRACKING" }
    }
  ];
  const markup = renderCommissionEventsMarkup(events);
  assert.match(markup, /Artwork shipped/);
  assert.match(markup, /Shipping delivery created/);
  assert.doesNotMatch(markup, /Private Name|PRIVATE-TRACKING|tracking_number|recipient_name/);
});

test("Activity renderer presents Storage events without exposing raw metadata", () => {
  const markup = renderCommissionEventsMarkup([
    { id: "1", event_type: "delivery_in_storage", occurred_at: "2026-10-11T18:30:00Z", payload: {} },
    { id: "2", event_type: "storage_fee_created", occurred_at: "2026-11-11T19:30:00Z", payload: { amount: "10.00", private_note: "DO NOT SHOW" } },
    { id: "3", event_type: "storage_final_notice_recorded", occurred_at: "2026-11-12T19:30:00Z", payload: { abandonment_eligible_at: "2027-05-11T18:30:00Z" } }
  ]);
  assert.match(markup, /Artwork moved to Storage/);
  assert.match(markup, /Storage Fee created — \$10\.00/);
  assert.match(markup, /Final Written Notice recorded/);
  assert.doesNotMatch(markup, /DO NOT SHOW|private_note|abandonment_eligible_at/);
});

test("Activity renderer presents Communication events without exposing message bodies", () => {
  const markup = renderCommissionEventsMarkup([
    {
      id: 32,
      event_type: "communication_draft_created",
      occurred_at: "2026-10-11T18:00:00Z",
      payload: { communication_type: "quotation", channel: "email", communication_id: "8" }
    },
    {
      id: 33,
      event_type: "manual_communication_recorded",
      occurred_at: "2026-10-11T19:00:00Z",
      payload: { communication_type: "manual_note", channel: "manual", communication_id: "9" }
    },
    {
      id: 34,
      event_type: "communication_generated_from_template",
      occurred_at: "2026-10-11T20:00:00Z",
      payload: { communication_type: "quotation", template_key: "quotation", template_version: 1, communication_id: "10" }
    },
    {
      id: 35,
      event_type: "communication_marked_ready",
      occurred_at: "2026-10-11T21:00:00Z",
      payload: { communication_type: "quotation", template_key: "quotation", template_version: 1, communication_id: "10" }
    },
    {
      id: 36,
      event_type: "communication_queued",
      occurred_at: "2026-10-11T21:01:00Z",
      payload: { communication_type: "quotation", channel: "email", communication_id: "10" }
    },
    {
      id: 37,
      event_type: "communication_sent",
      occurred_at: "2026-10-11T21:02:00Z",
      payload: { communication_type: "quotation", channel: "email", provider: "fake", communication_id: "10" }
    },
    {
      id: 38,
      event_type: "communication_failed",
      occurred_at: "2026-10-11T21:03:00Z",
      payload: { communication_type: "receipt", channel: "email", error_code: "provider_unavailable", communication_id: "11" }
    },
    {
      id: 39,
      event_type: "communication_reconciliation_inconclusive",
      occurred_at: "2026-10-11T21:04:00Z",
      payload: { communication_id: "12", provider: "gmail", result: "inconclusive", recipient: "PRIVATE" }
    },
    {
      id: 40,
      event_type: "communication_marked_sent_manually",
      occurred_at: "2026-10-11T21:05:00Z",
      payload: { communication_id: "12", provider: "manual", result: "confirmed_sent", body: "PRIVATE BODY" }
    }
  ]);
  assert.match(markup, /Quotation draft created/);
  assert.match(markup, /Manual Note recorded/);
  assert.match(markup, /Quotation draft generated from Quotation/);
  assert.match(markup, /Quotation reviewed and marked ready/);
  assert.match(markup, /Quotation claimed for sending/);
  assert.match(markup, /Quotation sent via Fake/);
  assert.match(markup, /Receipt send failed — Provider Unavailable/);
  assert.match(markup, /Communication reconciliation requires manual review/);
  assert.match(markup, /Communication marked Sent after external verification/);
  assert.doesNotMatch(markup, /PRIVATE|body_snapshot|recipient|subject|provider_message_id/);
});

test("Next Action renderer links only an allowed action state", () => {
  const actionMarkup = renderNextActionMarkup({
    code: "continue_quotation",
    state: "action",
    label: "Continue Quotation",
    reason: "A draft is available.",
    target: { label: "Continue Quotation", href: "/admin/quotation.html?id=7" }
  });
  const waitingMarkup = renderNextActionMarkup({
    code: "await_quotation_acceptance",
    state: "waiting",
    label: "Await Quotation Acceptance",
    reason: "The sent Quotation remains valid.",
    target: { label: "Unsafe", href: "/admin/unsafe" }
  });
  const blockedMarkup = renderNextActionMarkup({
    code: "data_integrity_review",
    state: "blocked",
    label: "Data integrity review required",
    reason: "Canonical records are ambiguous.",
    target: null
  });

  assert.match(actionMarkup, /href="\/admin\/quotation\.html\?id=7"/);
  assert.match(actionMarkup, /Continue Quotation/);
  assert.doesNotMatch(waitingMarkup, /href=/);
  assert.match(waitingMarkup, /Waiting/);
  assert.doesNotMatch(blockedMarkup, /href=/);
  assert.match(blockedMarkup, /Blocked/);
});

test("Commission detail loads Next Action from its protected endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/next-action")) {
      return jsonResponse({
        success: true,
        commission_id: "10",
        next_action: {
          code: "prepare_quotation",
          state: "action",
          label: "Prepare Quotation",
          reason: "This Commission has no Quotation yet.",
          target: {
            label: "Prepare Quotation",
            href: "/admin/quotation.html?commission_id=10"
          }
        }
      });
    }
    return commissionDetailFetch()(url);
  });

  await app.openDetail(sampleCommission.id);

  assert.ok(calls.includes(`/admin/api/commissions/${sampleCommission.id}/next-action`));
  assert.match(documentObject.elements["#commission-next-action-detail"].innerHTML, /Prepare Quotation/);
  assert.match(documentObject.elements["#commission-next-action-detail"].innerHTML, /data-next-action-state="action"/);
});

test("Production renderer distinguishes legacy uninitialized state without inference", () => {
  const markup = renderProductionMarkup({ initialized: false });
  assert.match(markup, /Not initialized/);
  assert.match(markup, /No status has been inferred from Legacy Commission Status/);
  assert.doesNotMatch(markup, /commission-status-badge">Not Started/);
});

test("Production renderer displays canonical status, milestones, and contextual help", () => {
  const markup = renderProductionMarkup({
    initialized: true,
    production_status: "paused",
    paused_from_status: "in_progress",
    started_at: "2026-10-11T14:00:00Z",
    paused_at: "2026-10-11T16:00:00Z",
    created_at: "2026-10-11T12:00:00Z",
    updated_at: "2026-10-11T16:00:00Z"
  });
  assert.match(markup, /Paused/);
  assert.match(markup, /Paused From/);
  assert.match(markup, /In Progress/);
  assert.match(markup, /data-glossary-key="production\.paused"/);
  assert.match(markup, /Canonical Production is tracked independently/);
});

test("Commission detail loads canonical Production from its protected endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/production")) {
      return jsonResponse({
        success: true,
        production: {
          initialized: true,
          production_status: "not_started",
          created_at: "2026-10-11T12:00:00Z",
          updated_at: "2026-10-11T12:00:00Z"
        }
      });
    }
    return commissionDetailFetch()(url);
  });

  await app.openDetail(sampleCommission.id);

  assert.ok(calls.includes(`/admin/api/commissions/${sampleCommission.id}/production`));
  assert.match(documentObject.elements["#commission-production-detail"].innerHTML, /Not Started/);
});

test("Activity renderer orders newest first and renders known events without raw payload", () => {
  const markup = renderCommissionEventsMarkup([
    {
      id: "1", event_type: "quotation_issued", occurred_at: "2026-10-11T14:00:00Z",
      payload: { quotation_number: "SAS-QUO-2026-0004", version: 1, client_email: "hidden@example.invalid" }
    },
    {
      id: "2", event_type: "payment_recorded", occurred_at: "2026-10-11T15:00:00Z",
      payload: { payment_type: "deposit", amount: "200.00" }
    }
  ]);
  assert.ok(markup.indexOf("Deposit recorded") < markup.indexOf("SAS-QUO-2026-0004 v1 issued"));
  assert.doesNotMatch(markup, /hidden@example\.invalid|client_email|\{&quot;/);
});

test("Activity renderer has a safe unknown-event fallback and empty state", () => {
  assert.equal(describeCommissionEvent({ event_type: "future_verified_fact", payload: {} }), "Future Verified Fact");
  assert.match(renderCommissionEventsMarkup([]), /No activity recorded yet/);
});

test("Activity renderer presents canonical Production events without raw status payload", () => {
  assert.equal(
    describeCommissionEvent({
      event_type: "production_resumed",
      payload: { previous_status: "paused", new_status: "revision_in_progress" }
    }),
    "Production resumed — Revision In Progress"
  );
});

test("Commission detail loads Activity from the protected read endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/events")) return jsonResponse({ success: true, events: [{ id: "1", event_type: "commission_status_changed", occurred_at: "2026-10-11T16:00:00Z", payload: { previous_status: "draft", new_status: "quoted" } }] });
    if (url.includes("/payments")) return jsonResponse({ success: true, commission: sampleCommission, payments: [] });
    if (url.startsWith("/admin/api/documents")) return jsonResponse({ success: true, documents: [] });
    if (url.endsWith("/quotations")) return jsonResponse({ success: true, quotations: [] });
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) return jsonResponse({ success: true, eligible: false, message: "Unavailable." });
    return jsonResponse({ success: true, commission: sampleCommission });
  });
  await app.openDetail(sampleCommission.id);
  assert.ok(calls.includes("/admin/api/commissions/10/events"));
  assert.match(documentObject.elements["#commission-activity-list"].innerHTML, /Draft to Quoted/);
});

test("Timeline renderer orders milestones and shows domain and derived temporal state", () => {
  const markup = renderCommissionTimelineMarkup([
    { type: "estimated_completion", title: "Estimated completion", domain: "production", status: "upcoming", starts_at: "2026-11-15T05:00:00Z", all_day: true },
    { type: "commission_created", title: "Commission created", domain: "commission", status: "historical", starts_at: "2026-10-01T14:00:00Z", all_day: false }
  ]);
  assert.ok(markup.indexOf("Commission created") < markup.indexOf("Estimated completion"));
  assert.match(markup, /Production · Upcoming/);
  assert.match(renderCommissionTimelineMarkup([]), /No timeline milestones available/);
});

test("Commission detail loads Timeline from its protected read endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.endsWith("/timeline")) return jsonResponse({ success: true, entries: [{ type: "commission_created", title: "Commission created", domain: "commission", status: "historical", starts_at: "2026-01-01T10:00:00Z", all_day: false }] });
    if (url.includes("/payments")) return jsonResponse({ success: true, commission: sampleCommission, payments: [] });
    if (url.startsWith("/admin/api/documents")) return jsonResponse({ success: true, documents: [] });
    if (url.endsWith("/quotations")) return jsonResponse({ success: true, quotations: [] });
    if (url.startsWith(CONTRACT_ELIGIBILITY_API_PATH)) return jsonResponse({ success: true, eligible: false, message: "Unavailable." });
    return jsonResponse({ success: true, commission: sampleCommission });
  });
  await app.openDetail(sampleCommission.id);
  assert.ok(calls.includes("/admin/api/commissions/10/timeline"));
  assert.match(documentObject.elements["#commission-timeline-list"].innerHTML, /Commission created/);
});

test("Commission detail includes its Documents section", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /id="commission-documents"/);
  assert.match(html, /<h2>Documents[\s\S]*?<\/h2>/);
});

test("Commission detail includes recent Communications and no sending controls", () => {
  const html = readFileSync(new URL("../../web/admin/commissions.html", import.meta.url), "utf8");
  const markup = renderCommissionCommunicationsMarkup([{
    id: "7", recipient: "client@example.invalid", communication_type: "quotation",
    channel: "email", communication_status: "draft", created_at: "2026-10-11T12:00:00Z"
  }]);
  assert.match(html, /id="commission-communications"/);
  assert.match(html, /New Draft/);
  assert.match(html, /Create Communication/);
  assert.match(html, /Record Manual Communication/);
  assert.match(html, /data-glossary-key="communication"/);
  assert.match(markup, /client@example\.invalid/);
  assert.match(markup, /communications\.html\?communication_id=7/);
  assert.match(renderCommissionCommunicationsMarkup([]), /No communications recorded/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Send|Queue|Retry)\s*<\/button>/i);
});

test("Commission detail requests documents through the shared filtered endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    if (url.includes("/payments")) return jsonResponse({ payments: [] });
    if (url.startsWith("/admin/api/documents")) return jsonResponse({ documents: [] });
    return jsonResponse({ commission: sampleCommission });
  });
  await app.openDetail(sampleCommission.id);
  assert.ok(calls.includes("/admin/api/documents?commission_id=10"));
});

test("Commission documents renderer shows only supplied commission documents", () => {
  const markup = renderCommissionDocumentsMarkup([{
    document_number: "SAS-REC-2026-0010",
    document_type: "receipt",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/receipts/10.html",
    payment: null
  }]);
  assert.match(markup, /SAS-REC-2026-0010/);
  assert.doesNotMatch(markup, /SAS-REC-2026-0011/);
});

test("Commission document View opens the stored file location", () => {
  const markup = renderCommissionDocumentsMarkup([{
    document_number: "SAS-INV-2026-0010",
    document_type: "invoice",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/documents/invoice-10.pdf",
    payment: null
  }]);
  assert.match(markup, /href="\/documents\/invoice-10\.pdf"/);
  assert.match(markup, /target="_blank"[^>]*rel="noopener"/);
});

test("Commission documents show receipts", () => {
  const markup = renderCommissionDocumentsMarkup([{
    document_number: "SAS-REC-2026-0010",
    document_type: "receipt",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/receipts/10.html",
    payment: null
  }]);
  assert.match(markup, />Receipt</);
});

test("Commission documents show the payment association", () => {
  const markup = renderCommissionDocumentsMarkup([{
    document_number: "SAS-REC-2026-0010",
    document_type: "receipt",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/receipts/10.html",
    payment: { payment_type: "balance" }
  }]);
  assert.match(markup, />Balance</);
});

test("Commission documents show the derived final invoice payment association", () => {
  const markup = renderCommissionDocumentsMarkup([{
    document_number: "SAS-INV-2026-0010",
    document_type: "invoice",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/invoice.html?document=10",
    payment: { id: null, payment_type: "balance", payment_date: "2026-10-09" }
  }]);

  assert.match(markup, />Balance<\/td>/);
  assert.doesNotMatch(markup, /Final Invoice — Paid in full<\/td>[\s\S]*<td>—<\/td>/);
});

test("Commission documents use the approved empty state", () => {
  assert.match(renderCommissionDocumentsMarkup([]), /No documents for this commission\./);
});

test("Commission Documents derives and displays friendly descriptions", () => {
  const depositReceipt = {
    id: "5",
    document_number: "SAS-REC-2026-0003",
    document_type: "receipt",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/payment-receipt.html?receipt=5",
    payment: { id: "8", payment_type: "deposit", payment_date: "2026-10-09" }
  };
  const invoice = {
    ...depositReceipt,
    id: "6",
    document_number: "SAS-INV-2026-0001",
    document_type: "invoice",
    file_location: "/admin/invoice.html?document=6",
    payment: null
  };
  const markup = renderCommissionDocumentsMarkup([depositReceipt, invoice]);

  assert.equal(describeDocument(depositReceipt), "Deposit Receipt");
  assert.equal(describeDocument(invoice), "Final Invoice — Paid in full");
  assert.match(markup, /Deposit Receipt/);
  assert.match(markup, /Final Invoice — Paid in full/);
  assert.match(
    readFileSync("web/admin/commissions.html", "utf8"),
    /<th scope="col">Description<\/th>/
  );
});

test("Commission Documents supports future Commission Agreement metadata", () => {
  const contract = {
    id: "9",
    document_number: "SAS-CON-2026-0001",
    document_type: "contract",
    contract_subtype: "commission_agreement",
    version: 1,
    created_at: "2026-10-09T10:00:00Z",
    file_location: "/admin/contract.html?document=9",
    payment: null
  };
  const markup = renderCommissionDocumentsMarkup([contract]);
  assert.equal(describeDocument(contract), "Commission Agreement");
  assert.match(markup, /Commission Agreement/);
  assert.match(markup, /<td>—<\/td>/);
});

test("Documents failure does not break Payments or Commission Detail", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url) => {
    if (url.startsWith("/admin/api/documents")) {
      return jsonResponse({ message: "failure" }, 500);
    }
    if (url.includes("/payments")) {
      return jsonResponse({ payments: [] });
    }
    return jsonResponse({ commission: sampleCommission });
  });
  const result = await app.openDetail(sampleCommission.id);
  assert.equal(result.id, sampleCommission.id);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Test Commission/);
  assert.match(documentObject.elements["#payment-list"].innerHTML, /No payments recorded\./);
  assert.equal(documentObject.elements["#commission-documents-status"].textContent, "Unable to load documents.");
});

test("admin commission edit opens with current values preloaded", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );

  await app.openDetail(sampleCommission.id);
  app.openEdit();

  assert.equal(documentObject.elements["#commission-edit-form"].hidden, false);
  assert.equal(documentObject.elements["#commission-detail-fields"].hidden, true);
  assert.equal(documentObject.editInputs.title.value, "Test Commission");
  assert.equal(documentObject.editInputs.description.value, "A test commission.");
  assert.equal(documentObject.editInputs.medium.value, "Oil");
  assert.equal(documentObject.editInputs.price.value, "100.00");
  assert.equal(documentObject.editInputs.sales_tax_rate.value, "0.06");
});

test("admin commission edit cancel restores read-only detail", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );

  await app.openDetail(sampleCommission.id);
  app.openEdit();
  documentObject.editInputs.title.value = "Unsaved";
  app.cancelEdit();

  assert.equal(documentObject.elements["#commission-edit-form"].hidden, true);
  assert.equal(documentObject.elements["#commission-detail-fields"].hidden, false);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Test Commission/);
});

test("admin commission form opens", () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({}));

  app.openCreate();

  assert.equal(documentObject.elements["#commission-create"].hidden, false);
  assert.equal(documentObject.elements["#commission-detail"].hidden, true);
  assert.equal(documentObject.inputs.sales_tax_rate.value, "0.06");
  assert.equal(documentObject.inputs.shipping.value, "0");
});

test("admin commission form uses the approved medium and tax selects", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const commissionForms = [
    html.match(/<form[^>]+id="commission-edit-form"[\s\S]*?<\/form>/)[0],
    html.match(/<form class="admin-form" id="commission-form"[\s\S]*?<\/form>/)[0]
  ].join("\n");

  assert.match(html, /<select name="medium" required>/);
  for (const medium of ["Acrylic", "Watercolor", "Oil", "Drawing"]) {
    assert.match(html, new RegExp(`<option value="${medium}">${medium}</option>`));
  }
  assert.doesNotMatch(html, /<input[^>]+name="medium"/);
  assert.match(html, /<select name="sales_tax_rate" required>/);
  assert.equal(
    (html.match(/value="0\.00">Outside Pennsylvania — PA sales tax not applicable — 0%/g) || []).length,
    2
  );
  assert.equal(
    (html.match(/value="0\.06" selected>Pennsylvania — 6%/g) || []).length,
    2
  );
  assert.match(html, /value="0\.07">Allegheny County — 7%/);
  assert.match(html, /value="0\.08">Philadelphia — 8%/);
  assert.doesNotMatch(commissionForms, /name="sales_tax"/);
  assert.match(html, /Required Deposit \(50%\)/);
  assert.match(html, /Estimated Remaining After Deposit/);
  assert.match(html, /id="commission-edit-form"/);
  assert.equal((html.match(/<select name="medium" required>/g) || []).length, 2);
  assert.equal((html.match(/<select name="sales_tax_rate" required>/g) || []).length, 2);
});

test("admin commission edit exposes no protected inputs", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const editForm = html.match(/<form[^>]+id="commission-edit-form"[\s\S]*?<\/form>/)[0];

  for (const field of [
    "id",
    "commission_number",
    "client_id",
    "deposit_amount",
    "balance",
    "status",
    "created_at",
    "sales_tax"
  ]) {
    assert.doesNotMatch(editForm, new RegExp(`name="${field}"`));
  }
});

test("admin commission client selector loads names and emails", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, clients: [sampleClient] })
  );

  await app.loadClients();

  const markup = documentObject.inputs.client_id.innerHTML;
  assert.match(markup, /value="1"/);
  assert.match(markup, /Test Client/);
  assert.match(markup, /test@example\.invalid/);
});

test("origin inquiry selector shows only inquiries matching the selected client email", () => {
  const markup = renderOriginInquiryOptions([
    {
      id: "11111111-1111-4111-8111-111111111111",
      form_type: "commission_request",
      status: "accepted",
      client_email: " TEST@example.invalid ",
      created_at: "2026-10-10T10:00:00Z"
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      form_type: "contact",
      status: "new",
      client_email: "other@example.invalid",
      created_at: "2026-10-11T10:00:00Z"
    }
  ], "test@example.invalid");

  assert.match(markup, /11111111-1111-4111-8111-111111111111/);
  assert.match(markup, /Commission Request/);
  assert.doesNotMatch(markup, /22222222-2222-4222-8222-222222222222/);
});

test("admin commission creation includes an optional origin inquiry id", () => {
  const documentObject = createDocument();
  fillValidForm(documentObject);
  documentObject.inputs.origin_inquiry_id.value =
    "11111111-1111-4111-8111-111111111111";

  const payload = buildCreatePayload(documentObject.elements["#commission-form"]);

  assert.equal(
    payload.origin_inquiry_id,
    "11111111-1111-4111-8111-111111111111"
  );
});

test("commission detail renders linked inquiry provenance", () => {
  const inquiries = [{
    id: "11111111-1111-4111-8111-111111111111",
    form_type: "commission_request",
    status: "accepted",
    client_name: "Test Client",
    client_email: "test@example.invalid",
    relationship_type: "origin",
    created_at: "2026-10-10T10:00:00Z"
  }];
  const markup = renderDetailMarkup({ ...sampleCommission, inquiries });

  assert.match(markup, /Source \/ Inquiries/);
  assert.match(markup, /Origin/);
  assert.match(markup, /Commission Request/);
  assert.match(markup, /11111111-1111-4111-8111-111111111111/);
  assert.match(renderProvenanceMarkup([]), /No linked inquiries/);
});

for (const field of ["client_id", "title", "description", "medium", "price"]) {
  test(`admin commission form rejects an empty ${field}`, () => {
    const documentObject = createDocument();
    fillValidForm(documentObject);
    documentObject.inputs[field].value = "   ";

    assert.throws(
      () => buildCreatePayload(documentObject.elements["#commission-form"]),
      /required/
    );
  });
}

test("admin commission creation sends normalized values", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ success: true, commission: sampleCommission }, 201);
  });
  fillValidForm(documentObject);

  await app.submitCreate();

  const payload = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, "/admin/api/commissions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(payload.client_id, "1");
  assert.equal(payload.title, "Test Commission");
  assert.equal(payload.price, 100);
  assert.equal(payload.sales_tax_rate, "0.06");
  assert.equal(Object.hasOwn(payload, "sales_tax"), false);
  assert.equal(payload.estimated_completion, null);
});

test("admin commission edit payload contains only approved fields", () => {
  const documentObject = createDocument();
  fillValidForm({ inputs: documentObject.editInputs });
  const payload = buildEditPayload(documentObject.elements["#commission-edit-form"]);

  assert.deepEqual(Object.keys(payload), [
    "title",
    "description",
    "medium",
    "width",
    "height",
    "price",
    "sales_tax_rate",
    "shipping",
    "estimated_completion"
  ]);
  assert.equal(Object.hasOwn(payload, "client_id"), false);
  assert.equal(Object.hasOwn(payload, "sales_tax"), false);
});

test("admin commission financial preview calculates the required deposit", () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({}));
  documentObject.inputs.price.value = "400";
  documentObject.inputs.sales_tax_rate.value = "0.06";
  documentObject.inputs.shipping.value = "20";

  const preview = app.updateFinancialPreview();

  assert.deepEqual(preview, {
    salesTaxCents: 2400,
    requiredDepositCents: 20000,
    estimatedRemainingCents: 24400
  });
  assert.equal(documentObject.elements["#sales-tax-preview"].textContent, "$24.00");
  assert.equal(documentObject.elements["#required-deposit-preview"].textContent, "$200.00");
  assert.equal(
    documentObject.elements["#remaining-after-deposit-preview"].textContent,
    "$244.00"
  );
});

test("admin commission zero-tax preview preserves deposit and shipping", () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({}));
  documentObject.inputs.price.value = "400";
  documentObject.inputs.sales_tax_rate.value = "0.00";
  documentObject.inputs.shipping.value = "20";

  const preview = app.updateFinancialPreview();

  assert.deepEqual(preview, {
    salesTaxCents: 0,
    requiredDepositCents: 20000,
    estimatedRemainingCents: 22000
  });
  assert.equal(documentObject.elements["#sales-tax-preview"].textContent, "$0.00");
  assert.equal(documentObject.elements["#required-deposit-preview"].textContent, "$200.00");
  assert.equal(
    documentObject.elements["#remaining-after-deposit-preview"].textContent,
    "$220.00"
  );
});

test("admin commission required deposit changes only with price", () => {
  const original = calculateFinancialPreview({
    price: "400",
    salesTaxRate: "0.06",
    shipping: "20"
  });
  const differentTaxAndShipping = calculateFinancialPreview({
    price: "400",
    salesTaxRate: "0.08",
    shipping: "50"
  });
  const differentPrice = calculateFinancialPreview({
    price: "600",
    salesTaxRate: "0.08",
    shipping: "50"
  });

  assert.equal(original.requiredDepositCents, 20000);
  assert.equal(differentTaxAndShipping.requiredDepositCents, 20000);
  assert.equal(differentPrice.requiredDepositCents, 30000);
  assert.equal(original.estimatedRemainingCents, 24400);
  assert.equal(differentTaxAndShipping.estimatedRemainingCents, 28200);
});

test("admin commission edit preview recalculates deposit and remaining", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );
  await app.openDetail(sampleCommission.id);
  app.openEdit();
  documentObject.editInputs.price.value = "500";
  documentObject.editInputs.sales_tax_rate.value = "0.08";
  documentObject.editInputs.shipping.value = "20";

  const preview = app.updateEditFinancialPreview();

  assert.equal(preview.requiredDepositCents, 25000);
  assert.equal(preview.estimatedRemainingCents, 31000);
  assert.equal(
    documentObject.elements["#edit-required-deposit-preview"].textContent,
    "$250.00"
  );
  assert.equal(
    documentObject.elements["#edit-remaining-after-deposit-preview"].textContent,
    "$310.00"
  );
});

test("admin commission infers the controlled tax rate from stored tax", () => {
  assert.equal(inferSalesTaxRate("400.00", "0.00"), "0.00");
  assert.equal(inferSalesTaxRate("400.00", "24.00"), "0.06");
  assert.equal(inferSalesTaxRate("400.00", "28.00"), "0.07");
  assert.equal(inferSalesTaxRate("400.00", "32.00"), "0.08");
  assert.equal(inferSalesTaxRate("0.00", "0.00"), "0.06");
});

test("admin commission detail separates required and received deposits", () => {
  const markup = renderDetailMarkup({
    ...sampleCommission,
    price: "400.00",
    deposit_amount: "0.00"
  });

  assert.match(markup, /Required Deposit \(50%\)/);
  assert.match(markup, /\$200\.00/);
  assert.match(markup, /Deposit Amount/);
  assert.match(markup, /\$0\.00/);
});

test("admin commission creation updates the list and detail", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission }, 201)
  );
  fillValidForm(documentObject);

  await app.submitCreate();

  assert.equal(documentObject.elements["#commission-count"].textContent, "1");
  assert.match(documentObject.elements["#commission-list"].innerHTML, /SAS-COM-2026-0001/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Test Commission/);
  assert.equal(documentObject.elements["#commission-detail-status"].textContent, "Commission created.");
});

test("admin commission edit uses PATCH and updates list and detail", async () => {
  const documentObject = createDocument();
  const calls = [];
  const updated = {
    ...sampleCommission,
    title: "Updated Commission",
    price: "500.00",
    sales_tax: "35.00",
    balance: "545.00"
  };
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });

    if (url === "/admin/api/commissions") {
      return jsonResponse({ success: true, total: 1, commissions: [sampleCommission] });
    }

    if (!options) {
      return jsonResponse({ success: true, commission: sampleCommission });
    }

    return jsonResponse({ success: true, commission: updated });
  });

  await app.loadList();
  await app.openDetail(sampleCommission.id);
  app.openEdit();
  documentObject.editInputs.title.value = "Updated Commission";
  documentObject.editInputs.price.value = "500";
  documentObject.editInputs.sales_tax_rate.value = "0.07";
  await app.submitEdit();

  const patchCall = calls.find((call) => call.options?.method === "PATCH");
  assert.equal(patchCall.url, "/admin/api/commissions/10");
  assert.equal(JSON.parse(patchCall.options.body).title, "Updated Commission");
  assert.match(documentObject.elements["#commission-list"].innerHTML, /Updated Commission/);
  assert.match(documentObject.elements["#commission-list"].innerHTML, /\$500\.00/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Updated Commission/);
  assert.equal(documentObject.elements["#commission-detail-status"].textContent, "Commission updated.");
});

test("admin commission edit displays the approved API error", async () => {
  const documentObject = createDocument();
  let call = 0;
  const app = createApp(documentObject, async () => {
    call += 1;
    return call === 1
      ? jsonResponse({ success: true, commission: sampleCommission })
      : jsonResponse({ message: "Database error." }, 500);
  });

  await app.openDetail(sampleCommission.id);
  app.openEdit();
  await app.submitEdit();

  assert.equal(
    documentObject.elements["#commission-detail-status"].textContent,
    "Unable to update commission."
  );
  assert.equal(
    documentObject.elements["#commission-detail-status"].classList.contains("is-error"),
    true
  );
});

test("admin commission status confirmation uses PATCH and updates UI", async () => {
  const documentObject = createDocument();
  const calls = [];
  const updated = {
    ...sampleCommission,
    status: "quoted"
  };
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });

    if (url === "/admin/api/commissions") {
      return jsonResponse({ success: true, total: 1, commissions: [sampleCommission] });
    }

    if (!options) {
      return jsonResponse({ success: true, commission: sampleCommission });
    }

    return jsonResponse({ success: true, commission: updated });
  });

  await app.loadList();
  await app.openDetail(sampleCommission.id);
  app.openStatus();
  documentObject.statusInputs.status.value = "quoted";
  app.prepareStatusConfirmation();
  await app.submitStatus();

  const patchCall = calls.find((call) => call.options?.method === "PATCH");
  assert.equal(patchCall.url, "/admin/api/commissions/10/status");
  assert.deepEqual(JSON.parse(patchCall.options.body), { status: "quoted" });
  assert.match(documentObject.elements["#commission-list"].innerHTML, /Quoted/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Quoted/);
  assert.equal(
    documentObject.elements["#commission-detail-status"].textContent,
    "Commission status updated."
  );
});

test("admin commission status update displays API errors", async () => {
  const documentObject = createDocument();
  let call = 0;
  const app = createApp(documentObject, async () => {
    call += 1;
    return call === 1
      ? jsonResponse({ success: true, commission: sampleCommission })
      : jsonResponse({ message: "Transition rejected." }, 409);
  });

  await app.openDetail(sampleCommission.id);
  app.openStatus();
  documentObject.statusInputs.status.value = "quoted";
  app.prepareStatusConfirmation();
  await app.submitStatus();

  assert.equal(
    documentObject.elements["#commission-detail-status"].textContent,
    "Unable to update commission status."
  );
  assert.equal(
    documentObject.elements["#commission-detail-status"].classList.contains("is-error"),
    true
  );
});

test("admin commissions format monetary values as USD", () => {
  assert.equal(formatCurrency("116.00"), "$116.00");
  assert.match(renderListMarkup([sampleCommission]), /\$100\.00/);
  assert.match(renderDetailMarkup(sampleCommission), /\$116\.00/);
});

test("admin commission detail omits NULL optional fields", () => {
  const markup = renderDetailMarkup({
    ...sampleCommission,
    width: null,
    height: null,
    estimated_completion: null
  });

  assert.doesNotMatch(markup, /Width \(in\)/);
  assert.doesNotMatch(markup, /Height \(in\)/);
  assert.doesNotMatch(markup, /Estimated Completion/);
});

test("admin commissions display API errors clearly", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ message: "Unable to load commissions." }, 500)
  );

  await app.loadList();

  assert.equal(
    documentObject.elements["#commission-list-status"].textContent,
    "Unable to load commissions."
  );
  assert.equal(
    documentObject.elements["#commission-list-status"].classList.contains("is-error"),
    true
  );
});

const samplePayment = {
  id: "50",
  commission_id: "10",
  payment_type: "deposit",
  amount: "25.00",
  sales_tax: "1.50",
  payment_method: "card",
  payment_date: "2026-10-09",
  status: "completed",
  external_reference: "reference-50",
  notes: "Initial payment",
  created_at: "2026-10-09T15:00:00Z"
};

function commissionDetailFetch(paymentResponse = []) {
  return async (url) => url.endsWith("/payments")
    ? jsonResponse({
        success: true,
        commission: sampleCommission,
        payments: paymentResponse
      })
    : jsonResponse({ success: true, commission: sampleCommission });
}

function fillPaymentForm(documentObject) {
  documentObject.paymentInputs.payment_type.value = "deposit";
  documentObject.paymentInputs.amount.value = "25.00";
  documentObject.paymentInputs.sales_tax.value = "1.50";
  documentObject.paymentInputs.payment_method.value = "card";
  documentObject.paymentInputs.payment_date.value = "2026-10-09";
  documentObject.paymentInputs.external_reference.value = " reference-50 ";
  documentObject.paymentInputs.notes.value = " Initial payment ";
}

test("Payments section and Record Payment form are present", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="commission-payments"/);
  assert.match(html, /<h2>Payments[\s\S]*?<\/h2>/);
  assert.match(html, /id="record-payment">Record Payment</);
  assert.match(html, /id="payment-list"/);
});

test("Payment form exposes only Deposit and Balance and no status", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const form = html.match(/<form[^>]+id="payment-form"[\s\S]*?<\/form>/)[0];

  assert.match(form, /value="deposit">Deposit</);
  assert.match(form, /value="balance">Balance</);
  assert.doesNotMatch(form, /value="installment"|value="refund"|value="adjustment"/);
  assert.equal((form.match(/<option value="(?:deposit|balance)">/g) || []).length, 2);
  assert.doesNotMatch(form, /name="status"/);
});

test("Payment Method is a controlled select with the exact approved choices", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const form = html.match(/<form[^>]+id="payment-form"[\s\S]*?<\/form>/)[0];
  const methodSelect = form.match(/<select name="payment_method">[\s\S]*?<\/select>/)[0];
  const expectedOptions = [
    ["cash", "Cash"],
    ["card", "Credit / Debit Card"],
    ["bank_transfer", "Bank Transfer"],
    ["check", "Check"],
    ["zelle", "Zelle"],
    ["paypal", "PayPal"]
  ];

  assert.deepEqual(paymentMethodLabels, Object.fromEntries(expectedOptions));
  assert.match(methodSelect, /<option value="">Select payment method<\/option>/);
  for (const [value, label] of expectedOptions) {
    assert.equal(
      (methodSelect.match(new RegExp(`<option value="${value}">${label.replace("/", "\\/")}<\\/option>`, "g")) || []).length,
      1
    );
  }
  assert.equal((methodSelect.match(/<option /g) || []).length, 7);
  assert.doesNotMatch(form, /<input[^>]+name="payment_method"/);
});

test("commission forms stay hidden until their actions are selected", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="commission-edit-form" hidden/);
  assert.match(html, /id="commission-status-form" hidden/);
  assert.match(html, /id="payment-form" hidden/);
  assert.match(html, /id="close-commission-detail">← Back to Commissions<\/button>/);
});

test("commission layout CSS is scoped, compact, and responsive", () => {
  const css = readFileSync(
    new URL("../../web/css/admin.css", import.meta.url),
    "utf8"
  );

  assert.match(css, /\.admin-commissions-page \.commission-detail-card/);
  assert.match(css, /max-width: 1160px/);
  assert.match(css, /\.admin-commissions-page \.commission-summary-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.admin-commissions-page \.commission-compact-form[\s\S]*grid-template-columns: 1fr/);
});

test("Payment history renders all approved fields including sales tax portion", () => {
  const markup = renderPaymentsMarkup([samplePayment]);

  assert.match(markup, /Oct 9, 2026/);
  assert.match(markup, /Deposit/);
  assert.match(markup, /\$25\.00/);
  assert.match(markup, /\$1\.50/);
  assert.match(markup, /Credit \/ Debit Card/);
  assert.doesNotMatch(markup, />card</);
  assert.match(markup, /Completed/);
  assert.match(markup, /reference-50/);
  assert.match(markup, /Initial payment/);
});

test("Payment history shows View Receipt only when a receipt exists", () => {
  const receiptPayment = {
    ...samplePayment,
    receipt: {
      id: "70",
      document_number: "SAS-REC-2026-0001",
      file_location: "/admin/payment-receipt.html?receipt=70"
    }
  };

  assert.match(renderPaymentsMarkup([receiptPayment]), /View Receipt/);
  assert.match(renderPaymentsMarkup([receiptPayment]), /receipt=70/);
  assert.doesNotMatch(renderPaymentsMarkup([samplePayment]), /View Receipt/);
});

test("Payment history shows View Final Invoice for the final payment document", () => {
  const finalPayment = {
    ...samplePayment,
    payment_type: "balance",
    document: {
      id: "80",
      document_type: "invoice",
      document_number: "SAS-INV-2026-0001",
      file_location: "/admin/invoice.html?document=80"
    },
    receipt: null
  };
  const markup = renderPaymentsMarkup([finalPayment]);

  assert.match(markup, /View Final Invoice/);
  assert.match(markup, /invoice\.html\?document=80/);
  assert.doesNotMatch(markup, /View Receipt/);
});

test("Payment history labels its action column Document", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /<th scope="col">Document<\/th>/);
});

test("Payment history shows an empty state without broken values", () => {
  assert.match(renderPaymentsMarkup([]), /No payments recorded/);
  assert.doesNotMatch(renderPaymentsMarkup([]), /undefined|null/);
});

test("opening Record Payment creates one request id and opens the form", async () => {
  const documentObject = createDocument();
  let uuidCalls = 0;
  const app = createApp(
    documentObject,
    commissionDetailFetch(),
    () => {
      uuidCalls += 1;
      return "11111111-1111-4111-8111-111111111111";
    }
  );

  await app.openDetail(sampleCommission.id);
  const requestId = app.openPayment();

  assert.equal(requestId, "11111111-1111-4111-8111-111111111111");
  assert.equal(uuidCalls, 1);
  assert.equal(documentObject.elements["#payment-form"].hidden, false);
  assert.equal(documentObject.paymentInputs.payment_type.value, "deposit");
  assert.equal(documentObject.paymentInputs.amount.value, "50.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "0.00");
});

test("Payment Type immediately autofills the editable Deposit and Balance suggestions", async () => {
  const documentObject = createDocument();
  const commission = {
    ...sampleCommission,
    price: "500.00",
    sales_tax: "30.00",
    shipping: "60.00",
    balance: "340.00"
  };
  const app = createApp(documentObject, async (url) => url.endsWith("/payments")
    ? jsonResponse({ success: true, commission, payments: [] })
    : jsonResponse({ success: true, commission }));
  app.bindEvents();

  await app.openDetail(commission.id);
  app.openPayment();
  const paymentTypeChange = documentObject.paymentInputs.payment_type.listeners.get("change");

  assert.equal(documentObject.paymentInputs.amount.value, "250.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "0.00");
  assert.equal(typeof paymentTypeChange, "function");

  documentObject.paymentInputs.payment_type.value = "balance";
  paymentTypeChange();
  assert.equal(documentObject.paymentInputs.amount.value, "340.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "30.00");
  assert.equal(commission.sales_tax, "30.00");
  assert.equal(
    documentObject.elements["#payment-guidance"].textContent,
    "No deposit has been recorded for this commission."
  );
  assert.equal(documentObject.elements["#payment-form"].hidden, false);

  documentObject.paymentInputs.amount.value = "300.00";
  documentObject.paymentInputs.sales_tax.value = "12.34";
  assert.equal(documentObject.paymentInputs.amount.value, "300.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "12.34");

  documentObject.paymentInputs.payment_type.value = "deposit";
  paymentTypeChange();
  assert.equal(documentObject.paymentInputs.amount.value, "250.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "0.00");
  assert.equal(documentObject.elements["#payment-guidance"].textContent, "");
});

test("payment amount and tax suggestions remain editable", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const form = html.match(/<form[^>]+id="payment-form"[\s\S]*?<\/form>/)[0];
  const amountInput = form.match(/<input[^>]+name="amount"[^>]*>/)[0];
  const taxInput = form.match(/<input[^>]+name="sales_tax"[^>]*>/)[0];

  for (const input of [amountInput, taxInput]) {
    assert.doesNotMatch(input, /\sreadonly(?:\s|>|=)/);
    assert.doesNotMatch(input, /\sdisabled(?:\s|>|=)/);
  }
});

test("an existing deposit defaults to Balance and warns without blocking another Deposit", async () => {
  const documentObject = createDocument();
  const commission = {
    ...sampleCommission,
    price: "500.00",
    deposit_amount: "250.00",
    balance: "340.00",
    sales_tax: "30.00"
  };
  const app = createApp(documentObject, async (url) => url.endsWith("/payments")
    ? jsonResponse({ success: true, commission, payments: [] })
    : jsonResponse({ success: true, commission }));
  app.bindEvents();

  await app.openDetail(commission.id);
  app.openPayment();

  assert.equal(documentObject.paymentInputs.payment_type.value, "balance");
  assert.equal(documentObject.paymentInputs.amount.value, "340.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "30.00");

  documentObject.paymentInputs.payment_type.value = "deposit";
  documentObject.paymentInputs.payment_type.listeners.get("change")();

  assert.equal(documentObject.paymentInputs.amount.value, "250.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "0.00");
  assert.equal(
    documentObject.elements["#payment-guidance"].textContent,
    "An initial deposit has already been recorded for this commission."
  );
  assert.equal(documentObject.elements["#payment-form"].hidden, false);
});

test("a zero balance displays Paid in full and keeps Record Payment closed", async () => {
  const documentObject = createDocument();
  const commission = {
    ...sampleCommission,
    deposit_amount: "50.00",
    amount_paid: "116.00",
    balance: "0.00"
  };
  const app = createApp(documentObject, async (url) => url.endsWith("/payments")
    ? jsonResponse({ success: true, commission, payments: [] })
    : jsonResponse({ success: true, commission }));

  await app.openDetail(commission.id);

  assert.equal(documentObject.elements["#payment-status"].textContent, "Paid in full");
  assert.equal(documentObject.elements["#record-payment"].hidden, true);
  assert.equal(app.openPayment(), null);
  assert.equal(documentObject.elements["#payment-form"].hidden, true);
});

test("payment payload contains only approved normalized fields", () => {
  const documentObject = createDocument();
  fillPaymentForm(documentObject);
  const payload = buildPaymentPayload(
    documentObject.elements["#payment-form"],
    "11111111-1111-4111-8111-111111111111"
  );

  assert.deepEqual(Object.keys(payload), [
    "request_id",
    "payment_type",
    "amount",
    "sales_tax",
    "payment_method",
    "payment_date",
    "external_reference",
    "notes"
  ]);
  assert.equal(payload.payment_method, "card");
  assert.equal(payload.external_reference, "reference-50");
  assert.equal(payload.notes, "Initial payment");
  assert.equal(Object.hasOwn(payload, "status"), false);
  assert.equal(Object.hasOwn(payload, "commission_id"), false);
});

test("failed retries reuse the same request id and show the API error", async () => {
  const documentObject = createDocument();
  const postPayloads = [];
  let uuidCalls = 0;
  const app = createApp(documentObject, async (url, options) => {
    if (options?.method === "POST") {
      postPayloads.push(JSON.parse(options.body));
      return jsonResponse({ message: "Payment service unavailable." }, 500);
    }

    return commissionDetailFetch()(url);
  }, () => {
    uuidCalls += 1;
    return "11111111-1111-4111-8111-111111111111";
  });

  await app.openDetail(sampleCommission.id);
  app.openPayment();
  fillPaymentForm(documentObject);
  await app.submitPayment();
  await app.submitPayment();

  assert.equal(uuidCalls, 1);
  assert.equal(postPayloads.length, 2);
  assert.equal(postPayloads[0].request_id, postPayloads[1].request_id);
  assert.equal(
    documentObject.elements["#payment-status"].textContent,
    "Payment service unavailable."
  );
  assert.equal(documentObject.elements["#payment-form"].hidden, false);
});

test("overpayment displays the clear backend message", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url, options) => {
    if (options?.method === "POST") {
      return jsonResponse({
        message: "Payment amount exceeds the commission balance."
      }, 409);
    }

    return commissionDetailFetch()(url);
  }, () => "11111111-1111-4111-8111-111111111111");

  await app.openDetail(sampleCommission.id);
  app.openPayment();
  fillPaymentForm(documentObject);
  await app.submitPayment();

  assert.equal(
    documentObject.elements["#payment-status"].textContent,
    "Payment amount exceeds the commission balance."
  );
});

test("successful payment updates history and all received-payment financials", async () => {
  const documentObject = createDocument();
  const updatedFinancials = {
    id: "10",
    price: "100.00",
    deposit_amount: "25.00",
    amount_paid: "25.00",
    sales_tax: "6.00",
    shipping: "10.00",
    balance: "91.00"
  };
  const app = createApp(documentObject, async (url, options) => {
    if (options?.method === "POST") {
      return jsonResponse({
        success: true,
        created: true,
        payment: samplePayment,
        receipt: {
          id: "70",
          document_number: "SAS-REC-2026-0001",
          file_location: "/admin/payment-receipt.html?receipt=70"
        },
        commission: updatedFinancials
      }, 201);
    }

    return commissionDetailFetch()(url);
  }, () => "11111111-1111-4111-8111-111111111111");

  await app.openDetail(sampleCommission.id);
  app.openPayment();
  fillPaymentForm(documentObject);
  await app.submitPayment();

  const detail = documentObject.elements["#commission-detail-fields"].innerHTML;
  assert.match(documentObject.elements["#payment-list"].innerHTML, /Initial payment/);
  assert.match(detail, /Deposit Amount[\s\S]*\$25\.00/);
  assert.match(detail, /Amount Paid[\s\S]*\$25\.00/);
  assert.match(detail, /Balance[\s\S]*\$91\.00/);
  assert.equal(documentObject.elements["#payment-status"].textContent, "Payment recorded.");
  assert.match(documentObject.elements["#payment-receipt-action"].innerHTML, /View Receipt/);
  assert.match(documentObject.elements["#payment-receipt-action"].innerHTML, /receipt=70/);
  assert.equal(documentObject.elements["#payment-form"].hidden, true);
  assert.equal(documentObject.paymentInputs.payment_type.value, "balance");
  assert.equal(documentObject.paymentInputs.amount.value, "91.00");
  assert.equal(documentObject.paymentInputs.sales_tax.value, "6.00");
  assert.equal(documentObject.paymentInputs.payment_method.value, "");
});

test("success creates a different request id for the next payment", async () => {
  const documentObject = createDocument();
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ];
  const app = createApp(documentObject, async (url, options) => {
    if (options?.method === "POST") {
      return jsonResponse({
        success: true,
        created: true,
        payment: samplePayment,
        commission: {
          ...sampleCommission,
          deposit_amount: "25.00",
          amount_paid: "25.00",
          balance: "91.00"
        }
      }, 201);
    }

    return commissionDetailFetch()(url);
  }, () => ids.shift());

  await app.openDetail(sampleCommission.id);
  const firstId = app.openPayment();
  fillPaymentForm(documentObject);
  await app.submitPayment();
  const secondId = app.openPayment();

  assert.equal(firstId, "11111111-1111-4111-8111-111111111111");
  assert.equal(secondId, "22222222-2222-4222-8222-222222222222");
});

test("commission financial summary clearly shows total and payment fields", () => {
  const markup = renderDetailMarkup({
    ...sampleCommission,
    price: "400.00",
    sales_tax: "24.00",
    shipping: "20.00",
    deposit_amount: "200.00",
    amount_paid: "200.00",
    balance: "244.00"
  });

  assert.match(markup, /class="commission-detail-summary"/);
  assert.match(markup, /class="commission-detail-header"/);
  assert.match(markup, /Test Client/);
  assert.match(markup, /test@example\.invalid/);
  assert.match(markup, /class="commission-description"/);
  assert.match(markup, /A test commission\./);
  assert.match(markup, /class="commission-summary-grid"/);
  assert.match(markup, /class="commission-record-information"/);
  assert.match(markup, /data-field="id"[\s\S]*>10</);
  assert.match(markup, /Total[\s\S]*\$444\.00/);
  assert.match(markup, /Required Deposit \(50%\)[\s\S]*\$200\.00/);
  assert.match(markup, /Deposit Amount[\s\S]*\$200\.00/);
  assert.match(markup, /Amount Paid[\s\S]*\$200\.00/);
  assert.match(markup, /Balance[\s\S]*\$244\.00/);
});
