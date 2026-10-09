import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildCreatePayload,
  buildEditPayload,
  calculateFinancialPreview,
  createApp,
  formatCurrency,
  inferSalesTaxRate,
  renderDetailMarkup,
  renderListMarkup
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
  "estimated_completion"
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
  const elements = {
    "#commission-count": createElement(),
    "#commission-list": createElement(),
    "#commission-list-status": createElement(),
    "#new-commission": createElement(),
    "#commission-detail": createElement(),
    "#commission-detail-fields": createElement(),
    "#commission-detail-status": createElement(),
    "#close-commission-detail": createElement(),
    "#edit-commission": createElement(),
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

  return {
    elements,
    inputs: form.inputs,
    editInputs: editForm.inputs,
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
});

test("admin commission detail opens", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, commission: sampleCommission })
  );

  await app.openDetail(sampleCommission.id);

  assert.equal(documentObject.elements["#commission-detail"].hidden, false);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Test Commission/);
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Oil/);
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
  assert.doesNotMatch(html, /name="sales_tax"/);
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
  const editForm = html.match(/<form class="admin-form" id="commission-edit-form"[\s\S]*?<\/form>/)[0];

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
