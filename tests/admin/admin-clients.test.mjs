import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createApp,
  renderDetailMarkup,
  renderListMarkup
} = require("../../web/js/admin-clients.js");

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
    classList: createClassList(),
    listeners,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
}

const editableFields = [
  "full_name",
  "email",
  "phone",
  "address_line_1",
  "address_line_2",
  "city",
  "state",
  "postal_code",
  "country"
];

function createFormElement() {
  const form = createElement();
  const inputs = Object.fromEntries(
    editableFields.map((field) => [field, { value: "" }])
  );
  form.elements = {
    namedItem(name) {
      return inputs[name];
    }
  };
  form.inputs = inputs;
  return form;
}

function createDocument() {
  const editForm = createFormElement();
  const elements = {
    "#client-count": createElement(),
    "#client-list": createElement(),
    "#client-list-status": createElement(),
    "#client-detail": createElement(),
    "#client-detail-fields": createElement(),
    "#client-detail-actions": createElement(),
    "#client-detail-status": createElement(),
    "#edit-client": createElement(),
    "#client-edit-form": editForm,
    "#cancel-client-edit": createElement(),
    "#close-client-detail": createElement()
  };

  return {
    elements,
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
  email: "test@example.invalid",
  phone: null,
  address_line_1: null,
  address_line_2: null,
  city: null,
  state: null,
  postal_code: null,
  country: null,
  created_at: "2026-01-01T10:00:00Z"
};

test("admin clients renders the list and counter", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, total: 1, clients: [sampleClient] })
  );

  await app.loadList();

  assert.equal(documentObject.elements["#client-count"].textContent, "1");
  assert.match(documentObject.elements["#client-list"].innerHTML, /Test Client/);
  assert.match(documentObject.elements["#client-list"].innerHTML, /test@example\.invalid/);
});

test("admin clients list renders readable client information", () => {
  const markup = renderListMarkup([sampleClient]);

  assert.match(markup, /data-client-id="1"/);
  assert.match(markup, /Test Client/);
  assert.match(markup, /Jan 1, 2026/);
});

test("admin client detail opens correctly", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    return jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);

  assert.equal(documentObject.elements["#client-detail"].hidden, false);
  assert.match(documentObject.elements["#client-detail-fields"].innerHTML, /Full Name/);
  assert.match(documentObject.elements["#client-detail-fields"].innerHTML, /Test Client/);
  assert.deepEqual(calls, ["/admin/api/clients/1"]);
});

test("admin client detail omits NULL phone", () => {
  const markup = renderDetailMarkup(sampleClient);

  assert.doesNotMatch(markup, /Phone/);
  assert.match(markup, /Full Name/);
  assert.match(markup, /Created/);
});

test("admin client detail displays a complete structured address", () => {
  const markup = renderDetailMarkup({
    ...sampleClient,
    address_line_1: "123 Studio Way",
    address_line_2: "Suite 4",
    city: "York",
    state: "PA",
    postal_code: "17401",
    country: "United States"
  });

  assert.match(markup, /Address Line 1/);
  assert.match(markup, /123 Studio Way/);
  assert.match(markup, /Address Line 2/);
  assert.match(markup, /Suite 4/);
  assert.match(markup, /City/);
  assert.match(markup, /York/);
  assert.match(markup, /State/);
  assert.match(markup, /PA/);
  assert.match(markup, /Postal Code/);
  assert.match(markup, /17401/);
  assert.match(markup, /Country/);
  assert.match(markup, /United States/);
});

test("admin client detail omits a NULL second address line", () => {
  const markup = renderDetailMarkup({
    ...sampleClient,
    address_line_1: "123 Studio Way",
    city: "York",
    state: "PA",
    postal_code: "17401",
    country: "United States"
  });

  assert.match(markup, /Address Line 1/);
  assert.doesNotMatch(markup, /Address Line 2/);
});

test("admin client detail omits all empty address fields", () => {
  const markup = renderDetailMarkup(sampleClient);

  assert.doesNotMatch(markup, /Address Line 1/);
  assert.doesNotMatch(markup, /Address Line 2/);
  assert.doesNotMatch(markup, /City/);
  assert.doesNotMatch(markup, /State/);
  assert.doesNotMatch(markup, /Postal Code/);
  assert.doesNotMatch(markup, /Country/);
});

test("admin clients list remains unchanged by address fields", () => {
  const markup = renderListMarkup([{
    ...sampleClient,
    address_line_1: "123 Studio Way",
    city: "York",
    state: "PA",
    postal_code: "17401",
    country: "United States"
  }]);

  assert.match(markup, /Test Client/);
  assert.doesNotMatch(markup, /123 Studio Way/);
  assert.doesNotMatch(markup, /York/);
  assert.doesNotMatch(markup, /17401/);
  assert.doesNotMatch(markup, /United States/);
});

test("admin client edit opens with current values preloaded", async () => {
  const documentObject = createDocument();
  const client = {
    ...sampleClient,
    phone: "555-0100",
    address_line_1: "123 Studio Way",
    city: "York",
    country: "United States"
  };
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, client })
  );

  await app.openDetail(client.id);
  app.beginEdit();

  assert.equal(documentObject.elements["#client-edit-form"].hidden, false);
  assert.equal(documentObject.elements["#client-detail-fields"].hidden, true);
  assert.equal(documentObject.editInputs.full_name.value, "Test Client");
  assert.equal(documentObject.editInputs.email.value, "test@example.invalid");
  assert.equal(documentObject.editInputs.phone.value, "555-0100");
  assert.equal(documentObject.editInputs.address_line_1.value, "123 Studio Way");
  assert.equal(documentObject.editInputs.city.value, "York");
  assert.equal(documentObject.editInputs.country.value, "United States");
});

test("admin client edit renders NULL fields as empty inputs", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, client: sampleClient })
  );

  await app.openDetail(sampleClient.id);
  app.beginEdit();

  assert.equal(documentObject.editInputs.phone.value, "");
  assert.equal(documentObject.editInputs.address_line_1.value, "");
  assert.equal(documentObject.editInputs.address_line_2.value, "");
  assert.equal(documentObject.editInputs.city.value, "");
  assert.equal(documentObject.editInputs.state.value, "");
  assert.equal(documentObject.editInputs.postal_code.value, "");
  assert.equal(documentObject.editInputs.country.value, "");
});

test("admin client edit cancel restores read-only detail without saving", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);
  app.beginEdit();
  documentObject.editInputs.full_name.value = "Unsaved Name";
  app.cancelEdit();

  assert.equal(documentObject.elements["#client-edit-form"].hidden, true);
  assert.equal(documentObject.elements["#client-detail-fields"].hidden, false);
  assert.equal(documentObject.editInputs.full_name.value, "Test Client");
  assert.equal(calls.length, 1);
});

test("admin client save sends the approved PATCH payload", async () => {
  const documentObject = createDocument();
  const calls = [];
  const updatedClient = {
    ...sampleClient,
    full_name: "Updated Client",
    phone: "555-0199"
  };
  const app = createApp(documentObject, async (url, options) => {
    calls.push({ url, options });

    if (options?.method === "PATCH") {
      return jsonResponse({ success: true, client: updatedClient });
    }

    return jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);
  app.beginEdit();
  documentObject.editInputs.full_name.value = "  Updated Client  ";
  documentObject.editInputs.phone.value = "  555-0199  ";
  await app.saveChanges();

  const patchCall = calls.find(({ options }) => options?.method === "PATCH");
  const payload = JSON.parse(patchCall.options.body);
  assert.equal(patchCall.url, "/admin/api/clients/1");
  assert.equal(patchCall.options.headers["Content-Type"], "application/json");
  assert.equal(payload.full_name, "Updated Client");
  assert.equal(payload.phone, "555-0199");
  assert.equal(payload.address_line_1, null);
});

test("admin client save updates the detail immediately", async () => {
  const documentObject = createDocument();
  const updatedClient = {
    ...sampleClient,
    full_name: "Updated Client"
  };
  const app = createApp(documentObject, async (url, options) => {
    return options?.method === "PATCH"
      ? jsonResponse({ success: true, client: updatedClient })
      : jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);
  app.beginEdit();
  documentObject.editInputs.full_name.value = "Updated Client";
  await app.saveChanges();

  assert.match(documentObject.elements["#client-detail-fields"].innerHTML, /Updated Client/);
  assert.equal(documentObject.elements["#client-edit-form"].hidden, true);
  assert.equal(documentObject.elements["#client-detail-status"].textContent, "Client updated.");
});

test("admin client save updates the existing list row", async () => {
  const documentObject = createDocument();
  const updatedClient = {
    ...sampleClient,
    full_name: "Updated Client",
    email: "updated@example.invalid",
    phone: "555-0199"
  };
  const app = createApp(documentObject, async (url, options) => {
    if (options?.method === "PATCH") {
      return jsonResponse({ success: true, client: updatedClient });
    }

    if (url === "/admin/api/clients") {
      return jsonResponse({ success: true, total: 1, clients: [sampleClient] });
    }

    return jsonResponse({ success: true, client: sampleClient });
  });

  await app.loadList();
  await app.openDetail(sampleClient.id);
  app.beginEdit();
  documentObject.editInputs.full_name.value = "Updated Client";
  documentObject.editInputs.email.value = "updated@example.invalid";
  documentObject.editInputs.phone.value = "555-0199";
  await app.saveChanges();

  const listMarkup = documentObject.elements["#client-list"].innerHTML;
  assert.match(listMarkup, /Updated Client/);
  assert.match(listMarkup, /updated@example\.invalid/);
  assert.match(listMarkup, /555-0199/);
  assert.doesNotMatch(listMarkup, />Test Client</);
});

test("admin client edit displays a duplicate email conflict", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url, options) => {
    return options?.method === "PATCH"
      ? jsonResponse({ message: "Email already belongs to another client." }, 409)
      : jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);
  app.beginEdit();
  await app.saveChanges();

  assert.equal(
    documentObject.elements["#client-detail-status"].textContent,
    "Email already belongs to another client."
  );
});

test("admin client edit displays a general update error", async () => {
  const documentObject = createDocument();
  const app = createApp(documentObject, async (url, options) => {
    return options?.method === "PATCH"
      ? jsonResponse({ message: "Internal detail" }, 500)
      : jsonResponse({ success: true, client: sampleClient });
  });

  await app.openDetail(sampleClient.id);
  app.beginEdit();
  await app.saveChanges();

  assert.equal(
    documentObject.elements["#client-detail-status"].textContent,
    "Unable to update client."
  );
});

for (const field of ["full_name", "email"]) {
  test(`admin client edit rejects an empty ${field} before PATCH`, async () => {
    const documentObject = createDocument();
    const calls = [];
    const app = createApp(documentObject, async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ success: true, client: sampleClient });
    });

    await app.openDetail(sampleClient.id);
    app.beginEdit();
    documentObject.editInputs[field].value = "   ";
    await app.saveChanges();

    assert.equal(calls.some(({ options }) => options?.method === "PATCH"), false);
    assert.equal(
      documentObject.elements["#client-detail-status"].textContent,
      "Full Name and Email are required."
    );
  });
}

test("admin clients displays API errors clearly", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ message: "Unable to load clients." }, 500)
  );

  await app.loadList();

  assert.equal(
    documentObject.elements["#client-list-status"].textContent,
    "Unable to load clients."
  );
  assert.equal(
    documentObject.elements["#client-list-status"].classList.contains("is-error"),
    true
  );
});

test("admin clients displays an empty state", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, total: 0, clients: [] })
  );

  await app.loadList();

  assert.equal(documentObject.elements["#client-count"].textContent, "0");
  assert.match(documentObject.elements["#client-list"].innerHTML, /No clients yet\./);
});
