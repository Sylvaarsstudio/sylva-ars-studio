import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  API_PATH,
  createApp,
  renderSessionsMarkup
} = require("../../web/js/admin-security.js");

function createClassList() {
  const values = new Set();
  return {
    toggle(value, enabled) {
      if (enabled) values.add(value);
      else values.delete(value);
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
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    listeners
  };
}

function createDocument() {
  const elements = {
    "#session-list": createElement(),
    "#session-status": createElement(),
    "#sign-out-other-sessions": createElement()
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
    async json() {
      return body;
    }
  };
}

const sessions = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-11-12T10:00:00.000Z",
    last_seen_at: "2026-11-12T10:10:00.000Z",
    expires_at: "2026-11-12T18:00:00.000Z",
    current_session: true,
    user_agent_summary: "Safari · macOS"
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-11-12T11:00:00.000Z",
    last_seen_at: "2026-11-12T11:10:00.000Z",
    expires_at: "2026-11-12T19:00:00.000Z",
    current_session: false,
    user_agent_summary: "Safari · iPhone"
  }
];

test("Active Sessions page uses the common Admin shell and Owner-only navigation", async () => {
  const html = await readFile("web/admin/security.html", "utf8");
  assert.match(html, /Active Sessions/);
  assert.match(html, /id="session-list"/);
  assert.match(html, /id="sign-out-other-sessions"/);
  assert.match(html, /admin-access\.js/);
  assert.match(html, /admin-security\.js/);
  assert.doesNotMatch(html, /token|hash|Google claims|IP address/i);
});

test("session UI renders only safe inventory fields and protects the current session", () => {
  const markup = renderSessionsMarkup(sessions);
  assert.match(markup, /Safari · macOS/);
  assert.match(markup, /Current session/);
  assert.match(markup, /Use normal Log out/);
  assert.match(markup, /data-revoke-session="00000000-0000-4000-8000-000000000002"/);
  assert.equal((markup.match(/>Revoke</g) || []).length, 1);
  assert.doesNotMatch(
    markup,
    /token|hash|claims?|external subject|ip address|geolocation/i
  );
});

test("session UI loads, revokes one session, and signs out all others through protected APIs", async () => {
  const documentObject = createDocument();
  const calls = [];
  const fetchImplementation = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/revoke")) return jsonResponse({ success: true, revoked: true });
    if (url.endsWith("/sign-out-others")) return jsonResponse({ success: true, revoked_count: 1 });
    return jsonResponse({ success: true, sessions });
  };
  const app = createApp(documentObject, fetchImplementation, () => true);

  await app.loadSessions();
  assert.match(documentObject.elements["#session-list"].innerHTML, /Safari · iPhone/);
  assert.equal(documentObject.elements["#sign-out-other-sessions"].hidden, false);

  await app.revokeSession(sessions[1].id);
  await app.signOutOtherSessions();
  assert.deepEqual(
    calls.filter((call) => call.options.method === "POST").map((call) => call.url),
    [
      `${API_PATH}/${sessions[1].id}/revoke`,
      `${API_PATH}/sign-out-others`
    ]
  );
});

test("session UI does not call destructive actions when confirmation is declined", async () => {
  const documentObject = createDocument();
  const calls = [];
  const app = createApp(
    documentObject,
    async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse({ success: true, sessions });
    },
    () => false
  );
  assert.equal(await app.revokeSession(sessions[1].id), false);
  assert.equal(await app.signOutOtherSessions(), false);
  assert.equal(calls.length, 0);
});
