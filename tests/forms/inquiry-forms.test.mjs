import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const scriptPath = new URL("../../web/js/inquiry-forms.js", import.meta.url);

class FakeFormData {
  constructor(form) {
    this.entries = Object.entries(form.fields);
  }

  forEach(callback) {
    this.entries.forEach(([key, value]) => callback(value, key));
  }

  get(name) {
    return this.entries.find(([key]) => key === name)?.[1] ?? null;
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }
}

function createForm({ hasFormType }) {
  const listeners = new Map();
  const button = { dataset: {}, disabled: false, textContent: "Send Inquiry" };
  const controls = [
    { name: "client_name", maxLength: -1 },
    { name: "client_email", maxLength: -1 },
    { name: "message", maxLength: -1 }
  ];

  return {
    fields: {
      "form-name": "contact",
      form_type: "contact",
      client_name: "Test Client",
      client_email: "test@example.invalid",
      message: "Test message"
    },
    controls,
    listeners,
    reportValidity: () => true,
    reset() {},
    append(element) {
      if (element.className?.startsWith("form-status")) {
        this.statusElement = element;
      } else {
        this.verificationElement = element;
      }
    },
    querySelector(selector) {
      if (selector === 'input[name="form_type"]') {
        return hasFormType ? {} : null;
      }

      if (selector === 'button[type="submit"]') {
        return button;
      }

      if (selector === ".form-status") {
        return this.statusElement || null;
      }

      return null;
    },
    querySelectorAll(selector) {
      return selector === "input[name], textarea[name]" ? controls : [];
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
}

test("initializes production forms without data-netlify", async () => {
  const source = await readFile(scriptPath, "utf8");
  const initializedForm = createForm({ hasFormType: true });
  const ignoredForm = createForm({ hasFormType: false });
  const fetchCalls = [];
  let selectedFormsWith = "";

  const document = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      selectedFormsWith = selector;
      return [initializedForm, ignoredForm];
    },
    createElement() {
      return {
        className: "",
        textContent: "",
        setAttribute() {}
      };
    }
  };

  const fetch = async (url, options) => {
    fetchCalls.push({ url, options });

    if (url === "/api/inquiries" && options.method === "GET") {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            provider: "turnstile",
            site_key: "test-site-key",
            action: "sylva_public_inquiry"
          };
        }
      };
    }

    if (url === "/api/inquiries" && options.method === "POST") {
      return {
        ok: true,
        async json() {
          return {
            success: true,
            request_id: "00000000-0000-4000-8000-000000000001"
          };
        }
      };
    }

    return { ok: true };
  };

  vm.runInNewContext(source, {
    console,
    document,
    fetch,
    FormData: FakeFormData,
    URLSearchParams,
    window: {
      location: {
        pathname: "/contact",
        search: ""
      },
      turnstile: {
        render(_container, options) {
          options.callback("test-turnstile-token");
          return "test-widget";
        },
        reset() {}
      }
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(selectedFormsWith, "form.contact-form");
  assert.equal(initializedForm.listeners.has("submit"), true);
  assert.equal(ignoredForm.listeners.has("submit"), false);
  assert.deepEqual(
    initializedForm.controls.map(({ name, maxLength }) => [name, maxLength]),
    [["client_name", 100], ["client_email", 254], ["message", 5000]]
  );

  let defaultPrevented = false;
  await initializedForm.listeners.get("submit")({
    preventDefault() {
      defaultPrevented = true;
    }
  });

  assert.equal(defaultPrevented, true);
  assert.equal(fetchCalls[0].url, "/api/inquiries");
  assert.equal(fetchCalls[0].options.method, "GET");
  assert.equal(fetchCalls[1].url, "/api/inquiries");
  assert.equal(fetchCalls[1].options.method, "POST");
  assert.equal(
    JSON.parse(fetchCalls[1].options.body).turnstile_token,
    "test-turnstile-token"
  );
  assert.equal(
    Object.hasOwn(JSON.parse(fetchCalls[1].options.body), "client_phone"),
    false
  );
  assert.equal(fetchCalls[2].url, "/contact");
});
