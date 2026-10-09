import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildListUrl,
  createApp,
  renderDetailMarkup,
  renderListMarkup
} = require("../../web/js/admin-inquiries.js");

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

function createElement(value = "") {
  const listeners = new Map();

  return {
    value,
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
    "#inquiry-count": createElement(),
    "#inquiry-status-filter": createElement("all"),
    "#inquiry-form-type-filter": createElement("all"),
    "#inquiry-list": createElement(),
    "#inquiry-list-status": createElement(),
    "#inquiry-detail": createElement(),
    "#inquiry-detail-fields": createElement(),
    "#inquiry-detail-status": createElement(),
    "#inquiry-status-form": createElement(),
    "#inquiry-status": createElement("new"),
    "#convert-inquiry-client": createElement(),
    "#close-inquiry-detail": createElement()
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

const sampleInquiry = {
  id: "00000000-0000-4000-8000-000000000001",
  form_type: "artwork_inquiry",
  client_name: "Test Client",
  client_email: "test@example.invalid",
  client_phone: null,
  artwork_title: "Still Here",
  message: "Test message",
  status: "new",
  created_at: "2026-01-01T10:00:00Z",
  updated_at: "2026-01-01T10:00:00Z"
};

test("admin inquiries renders the list", () => {
  const markup = renderListMarkup([sampleInquiry]);

  assert.match(markup, /Artwork Inquiry/);
  assert.match(markup, /Test Client/);
  assert.match(markup, /test@example\.invalid/);
  assert.match(markup, /00000000-0000-4000-8000-000000000001/);
});

test("admin inquiry filters build the expected API URL", () => {
  assert.equal(
    buildListUrl("reviewing", "commission_request"),
    "/admin/api/inquiries?status=reviewing&form_type=commission_request"
  );
  assert.equal(buildListUrl("all", "all"), "/admin/api/inquiries");
});

test("admin inquiry detail omits NULL fields", () => {
  const markup = renderDetailMarkup(sampleInquiry);

  assert.match(markup, /Artwork Title/);
  assert.match(markup, /Still Here/);
  assert.doesNotMatch(markup, /Client Phone/);
  assert.doesNotMatch(markup, /Shipping Location/);
});

test("admin inquiry app loads list and opens detail", async () => {
  const documentObject = createDocument();
  const calls = [];
  const fetchImplementation = async (url) => {
    calls.push(url);

    if (url.endsWith(sampleInquiry.id)) {
      return jsonResponse({ success: true, inquiry: sampleInquiry });
    }

    return jsonResponse({ success: true, total: 1, inquiries: [sampleInquiry] });
  };
  const app = createApp(documentObject, fetchImplementation);

  await app.loadList();
  await app.openDetail(sampleInquiry.id);

  assert.equal(documentObject.elements["#inquiry-count"].textContent, "1");
  assert.match(documentObject.elements["#inquiry-list"].innerHTML, /Test Client/);
  assert.match(documentObject.elements["#inquiry-detail-fields"].innerHTML, /Still Here/);
  assert.equal(documentObject.elements["#inquiry-detail"].hidden, false);
  assert.deepEqual(calls, [
    "/admin/api/inquiries",
    `/admin/api/inquiries/${sampleInquiry.id}`
  ]);
});

test("admin inquiry status update calls the protected endpoint", async () => {
  const documentObject = createDocument();
  const calls = [];
  const fetchImplementation = async (url, options = {}) => {
    calls.push({ url, options });

    if (options.method === "PATCH") {
      return jsonResponse({
        success: true,
        inquiry: { id: sampleInquiry.id, status: "reviewing" }
      });
    }

    if (url.endsWith(sampleInquiry.id)) {
      return jsonResponse({ success: true, inquiry: sampleInquiry });
    }

    return jsonResponse({ success: true, total: 1, inquiries: [sampleInquiry] });
  };
  const app = createApp(documentObject, fetchImplementation);

  await app.openDetail(sampleInquiry.id);
  documentObject.elements["#inquiry-status"].value = "reviewing";
  await app.updateStatus();

  const updateCall = calls.find((call) => call.options.method === "PATCH");
  assert.equal(updateCall.url, `/admin/api/inquiries/${sampleInquiry.id}`);
  assert.deepEqual(JSON.parse(updateCall.options.body), { status: "reviewing" });
  assert.equal(
    documentObject.elements["#inquiry-detail-status"].textContent,
    "Status updated."
  );
});

test("admin inquiry app displays API errors clearly", async () => {
  const documentObject = createDocument();
  const app = createApp(
    documentObject,
    async () => jsonResponse({ message: "Unable to load inquiries." }, 500)
  );

  await app.loadList();

  assert.equal(
    documentObject.elements["#inquiry-list-status"].textContent,
    "Unable to load inquiries."
  );
  assert.equal(
    documentObject.elements["#inquiry-list-status"].classList.contains("is-error"),
    true
  );
});

test("admin inquiry conversion button is hidden unless status is accepted", async () => {
  const documentObject = createDocument();
  const acceptedInquiry = { ...sampleInquiry, status: "accepted" };
  let inquiry = sampleInquiry;
  const app = createApp(
    documentObject,
    async () => jsonResponse({ success: true, inquiry })
  );

  await app.openDetail(sampleInquiry.id);
  assert.equal(
    documentObject.elements["#convert-inquiry-client"].hidden,
    true
  );

  inquiry = acceptedInquiry;
  await app.openDetail(sampleInquiry.id);
  assert.equal(
    documentObject.elements["#convert-inquiry-client"].hidden,
    false
  );
});

test("admin inquiry conversion click calls the protected endpoint", async () => {
  const documentObject = createDocument();
  const acceptedInquiry = { ...sampleInquiry, status: "accepted" };
  const calls = [];
  const app = createApp(
    documentObject,
    async (url, options = {}) => {
      calls.push({ url, options });

      if (options.method === "POST") {
        return jsonResponse({
          success: true,
          inquiry_id: acceptedInquiry.id,
          client_id: "1",
          created: true
        });
      }

      return jsonResponse({ success: true, inquiry: acceptedInquiry });
    },
    () => true
  );

  app.bindEvents();
  await app.openDetail(acceptedInquiry.id);
  await documentObject.elements["#convert-inquiry-client"].listeners.get("click")();

  const conversionCall = calls.find((call) => call.options.method === "POST");
  assert.equal(
    conversionCall.url,
    `/admin/api/inquiries/${acceptedInquiry.id}/convert-client`
  );
});

for (const [created, message] of [
  [true, "Client created."],
  [false, "Existing client linked/found."]
]) {
  test(`admin inquiry conversion reports created=${created}`, async () => {
    const documentObject = createDocument();
    const acceptedInquiry = { ...sampleInquiry, status: "accepted" };
    const app = createApp(
      documentObject,
      async (url, options = {}) => options.method === "POST"
        ? jsonResponse({ success: true, client_id: "1", created })
        : jsonResponse({ success: true, inquiry: acceptedInquiry }),
      () => true
    );

    await app.openDetail(acceptedInquiry.id);
    await app.convertToClient();

    assert.equal(
      documentObject.elements["#inquiry-detail-status"].textContent,
      message
    );
  });
}

test("admin inquiry conversion displays API errors clearly", async () => {
  const documentObject = createDocument();
  const acceptedInquiry = { ...sampleInquiry, status: "accepted" };
  const app = createApp(
    documentObject,
    async (url, options = {}) => options.method === "POST"
      ? jsonResponse({ message: "Unable to convert inquiry to client." }, 500)
      : jsonResponse({ success: true, inquiry: acceptedInquiry }),
    () => true
  );

  await app.openDetail(acceptedInquiry.id);
  await app.convertToClient();

  assert.equal(
    documentObject.elements["#inquiry-detail-status"].textContent,
    "Unable to convert inquiry to client."
  );
  assert.equal(
    documentObject.elements["#inquiry-detail-status"].classList.contains("is-error"),
    true
  );
});
