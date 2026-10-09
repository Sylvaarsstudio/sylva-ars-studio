import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildCreatePayload,
  createApp,
  formatCurrency,
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
  "sales_tax",
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
  const elements = {
    "#commission-count": createElement(),
    "#commission-list": createElement(),
    "#commission-list-status": createElement(),
    "#new-commission": createElement(),
    "#commission-detail": createElement(),
    "#commission-detail-fields": createElement(),
    "#commission-detail-status": createElement(),
    "#close-commission-detail": createElement(),
    "#commission-create": createElement(),
    "#commission-form": form,
    "#commission-create-status": createElement(),
    "#cancel-commission": createElement()
  };

  return {
    elements,
    inputs: form.inputs,
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
  medium: "Oil on canvas",
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
  Object.assign(documentObject.inputs.medium, { value: " Oil on canvas " });
  Object.assign(documentObject.inputs.width, { value: "20" });
  Object.assign(documentObject.inputs.height, { value: "24" });
  Object.assign(documentObject.inputs.price, { value: "100" });
  Object.assign(documentObject.inputs.sales_tax, { value: "6" });
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
  assert.match(documentObject.elements["#commission-detail-fields"].innerHTML, /Oil on canvas/);
});

test("admin commission form opens", () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async () => jsonResponse({}));

  app.openCreate();

  assert.equal(documentObject.elements["#commission-create"].hidden, false);
  assert.equal(documentObject.elements["#commission-detail"].hidden, true);
  assert.equal(documentObject.inputs.sales_tax.value, "0");
  assert.equal(documentObject.inputs.shipping.value, "0");
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
  assert.equal(payload.estimated_completion, null);
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
