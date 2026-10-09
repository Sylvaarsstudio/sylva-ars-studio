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

function createDocument() {
  const elements = {
    "#client-count": createElement(),
    "#client-list": createElement(),
    "#client-list-status": createElement(),
    "#client-detail": createElement(),
    "#client-detail-fields": createElement(),
    "#client-detail-status": createElement(),
    "#close-client-detail": createElement()
  };

  return {
    elements,
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
