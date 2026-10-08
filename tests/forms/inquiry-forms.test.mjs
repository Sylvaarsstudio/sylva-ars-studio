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

  return {
    fields: {
      "form-name": "contact",
      form_type: "contact",
      client_name: "Test Client",
      client_email: "test@example.invalid",
      message: "Test message"
    },
    listeners,
    reportValidity: () => true,
    reset() {},
    append(element) {
      this.statusElement = element;
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

    if (url === "/.netlify/functions/create-request") {
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
      }
    }
  });

  assert.equal(selectedFormsWith, "form.contact-form");
  assert.equal(initializedForm.listeners.has("submit"), true);
  assert.equal(ignoredForm.listeners.has("submit"), false);

  let defaultPrevented = false;
  await initializedForm.listeners.get("submit")({
    preventDefault() {
      defaultPrevented = true;
    }
  });

  assert.equal(defaultPrevented, true);
  assert.equal(fetchCalls[0].url, "/.netlify/functions/create-request");
  assert.equal(fetchCalls[0].options.method, "POST");
  assert.equal(fetchCalls[1].url, "/contact");
});
