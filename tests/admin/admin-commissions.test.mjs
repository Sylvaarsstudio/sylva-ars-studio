import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildCreatePayload,
  buildEditPayload,
  buildPaymentPayload,
  calculateFinancialPreview,
  createApp,
  formatCurrency,
  inferSalesTaxRate,
  paymentMethodLabels,
  renderDetailMarkup,
  renderListMarkup,
  renderPaymentsMarkup,
  renderStatusOptions,
  statusTransitions
} = require("../../web/js/admin-commissions.js");

const formFields = [
  "client_id",
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
  "notes"
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
  paymentForm.hidden = true;
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
    "#record-payment": createElement(),
    "#payment-form": paymentForm,
    "#cancel-payment": createElement(),
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
  elements["#commission-create"].hidden = true;

  return {
    elements,
    inputs: form.inputs,
    editInputs: editForm.inputs,
    paymentInputs: paymentForm.inputs,
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
  created_at: "2026-01-01T10:00:00Z"
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
  assert.equal(calls.length, 2);
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
  assert.match(html, /<h2>Payments<\/h2>/);
  assert.match(html, /id="record-payment">Record Payment</);
  assert.match(html, /id="payment-list"/);
});

test("Payment form exposes only the three approved types and no status", () => {
  const html = readFileSync(
    new URL("../../web/admin/commissions.html", import.meta.url),
    "utf8"
  );
  const form = html.match(/<form[^>]+id="payment-form"[\s\S]*?<\/form>/)[0];

  assert.match(form, /value="deposit">Deposit</);
  assert.match(form, /value="installment">Installment</);
  assert.match(form, /value="balance">Balance</);
  assert.doesNotMatch(form, /value="refund"|value="adjustment"/);
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
  assert.equal(documentObject.paymentInputs.sales_tax.value, "0");
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
  assert.equal(documentObject.elements["#payment-form"].hidden, true);
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
