import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createApp,
  renderListMarkup
} = require("../../web/js/admin-quotations.js");

function element(value = "") {
  const listeners = new Map();
  return {
    innerHTML: "",
    textContent: "",
    value,
    addEventListener(type, listener) { listeners.set(type, listener); },
    listeners
  };
}

test("RC2.1 Admin exposes Client creation and Client-owned Quotation entry points", () => {
  const clients = readFileSync("web/admin/clients.html", "utf8");
  const inquiries = readFileSync("web/admin/inquiries.html", "utf8");
  assert.match(clients, /id="new-client"[^>]*>New Client</);
  assert.match(clients, /id="client-create-form"/);
  assert.match(clients, /id="new-client-quotation"[^>]*>New Quotation</);
  assert.match(clients, /id="client-quotations"/);
  assert.match(inquiries, /id="create-inquiry-quotation"/);
});

test("RC2.1 Admin removes direct Commission creation and Commission-first Quotation actions", () => {
  const commissions = readFileSync("web/admin/commissions.html", "utf8");
  assert.doesNotMatch(commissions, /id="new-commission"|id="commission-form"|Prepare Quotation/);
  assert.match(commissions, /href="quotations\.html"[^>]*>Quotations</);
});

test("global Quotations index renders pre-Commission records and safe View links", () => {
  const markup = renderListMarkup([{
    id: 19,
    client_name: "Studio Client",
    quotation_number: "SAS-QUO-2026-0019",
    version: 2,
    quotation_status: "accepted",
    price: "400.00",
    sales_tax: "24.00",
    shipping_charge: "20.00",
    issued_at: "2026-10-12T14:00:00Z",
    expires_at: "2026-11-11T15:00:00Z"
  }]);
  assert.match(markup, /Studio Client/);
  assert.match(markup, /SAS-QUO-2026-0019/);
  assert.match(markup, /accepted/);
  assert.match(markup, /quotation\.html\?id=19/);
});

test("global Quotations index applies the controlled status filter", async () => {
  const list = element();
  const status = element("accepted");
  const notice = element();
  const documentObject = {
    querySelector(selector) {
      return {
        "#quotation-list": list,
        "#quotation-status-filter": status,
        "#quotation-list-status": notice
      }[selector];
    }
  };
  const calls = [];
  const app = createApp(documentObject, async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() { return { success: true, quotations: [] }; }
    };
  });
  app.bindEvents();
  await app.load();
  assert.deepEqual(calls, ["/admin/api/quotations?status=accepted"]);
  assert.match(list.innerHTML, /No quotations match this filter/);
});
