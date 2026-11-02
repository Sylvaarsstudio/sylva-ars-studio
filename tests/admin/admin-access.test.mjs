import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import access from "../../web/js/admin-access.js";

test("admin role labels distinguish owner, viewer, and temporary legacy access", () => {
  assert.equal(access.identityLabel({ role: "owner_admin", display_name: "Owner" }), "Owner · Owner Admin");
  assert.equal(access.identityLabel({ role: "viewer", email: "viewer@example.invalid" }), "viewer@example.invalid · Viewer · read only");
  assert.equal(access.identityLabel({ role: "owner_admin", legacy: true }), "Migration owner · temporary legacy session");
});

test("viewer control map covers each mutable admin workflow", () => {
  const selectors = access.writeSelectors.join(" ");
  for (const required of [
    "#client-create-form", "#client-edit-form", "#commission-edit-form",
    "#commission-status-form", "#payment-form", "#delivery-create-form",
    "[data-delivery-transition]", "#communication-create-form", "#send-communication",
    "#inquiry-status-form", "#convert-inquiry-client", "#quotation-form",
    "#quotation-acceptance-form", "#prepare-contract-form", "#document-form"
  ]) assert.match(selectors, new RegExp(required.replace(/[\[\].]/g, "\\$&")));
});

test("every admin page loads the common identity and viewer UX", async () => {
  const pages = [
    "calendar", "clients", "commissions", "communications", "contract",
    "create-client", "create-contract", "dashboard", "documents",
    "generate-documents", "glossary", "inquiries", "invoice",
    "payment-receipt", "quotation", "quotations"
  ];
  for (const page of pages) {
    const html = await readFile(`web/admin/${page}.html`, "utf8");
    assert.match(html, /<script src="\.\.\/js\/admin-access\.js"><\/script>/, page);
  }
});

test("login presents Google Workspace first and legacy only as an explicit migration path", async () => {
  const html = await readFile("web/admin-login.html", "utf8");
  assert.match(html, /Continue with Google Workspace/);
  assert.match(html, /Temporary migration access/);
  assert.match(html, /id="legacy-login" hidden/);
});
