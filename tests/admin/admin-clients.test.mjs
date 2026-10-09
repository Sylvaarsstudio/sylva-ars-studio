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
