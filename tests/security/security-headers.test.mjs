import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  CONTENT_SECURITY_POLICY_REPORT_ONLY,
  SECURITY_HEADERS,
  createHandler
} from "../../netlify/edge-functions/security-headers.js";

test("global edge middleware applies the baseline without changing the response", async () => {
  const downstream = new Response(JSON.stringify({ success: true }), {
    status: 202,
    statusText: "Accepted",
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Set-Cookie": "session=opaque; Secure; HttpOnly; SameSite=Lax"
    }
  });
  const response = await createHandler()(new Request("https://studio.example/api/inquiries"), {
    next: async () => downstream
  });

  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(
    response.headers.get("Set-Cookie"),
    "session=opaque; Secure; HttpOnly; SameSite=Lax"
  );
  assert.deepEqual(await response.json(), { success: true });

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
});

test("global edge middleware preserves Admin redirects", async () => {
  const downstream = new Response(null, {
    status: 302,
    headers: {
      Location: "/admin-login.html?redirect=%2Fadmin%2F"
    }
  });
  const response = await createHandler()(new Request("https://studio.example/admin/"), {
    next: async () => downstream
  });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "/admin-login.html?redirect=%2Fadmin%2F"
  );
  assert.equal(response.headers.get("X-Frame-Options"), "SAMEORIGIN");
});

test("CSP is report-only, origin-specific, and contains no broad execution allowance", () => {
  assert.equal(
    SECURITY_HEADERS["Content-Security-Policy-Report-Only"],
    CONTENT_SECURITY_POLICY_REPORT_ONLY
  );
  assert.equal(SECURITY_HEADERS["Content-Security-Policy"], undefined);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /script-src-attr 'none'/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /https:\/\/challenges\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /https:\/\/cdnjs\.cloudflare\.com/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_REPORT_ONLY, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_REPORT_ONLY, /(?:^|\s)\*(?:\s|;|$)/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_REPORT_ONLY, /accounts\.google|googleapis|gmail/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_REPORT_ONLY, /report-uri|report-to/);
});

test("the only executable inline script is pinned by its exact CSP hash", async () => {
  const adminLogin = await readFile("web/admin-login.html", "utf8");
  const executableBlocks = Array.from(
    adminLogin.matchAll(/<script(?![^>]*\b(?:src|type)=)[^>]*>([\s\S]*?)<\/script>/gi),
    (match) => match[1]
  );

  assert.equal(executableBlocks.length, 1);
  const hash = createHash("sha256").update(executableBlocks[0]).digest("base64");
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, new RegExp(`'sha256-${hash}'`));
});

test("browser resource origins remain covered without adding server-only providers", async () => {
  const [contact, inquiryForms, adminAuth, emailProvider, shippingProvider] = await Promise.all([
    readFile("web/contact.html", "utf8"),
    readFile("web/js/inquiry-forms.js", "utf8"),
    readFile("netlify/functions/admin-auth.mjs", "utf8"),
    readFile("netlify/shared/email-provider.mjs", "utf8"),
    readFile("netlify/shared/easypost-rate-provider.mjs", "utf8")
  ]);

  assert.doesNotMatch(contact, /https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(inquiryForms, /https:\/\/challenges\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /style-src 'self' https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /font-src 'self' https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(CONTENT_SECURITY_POLICY_REPORT_ONLY, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);

  assert.match(adminAuth, /accounts\.google\.com/);
  assert.match(emailProvider, /gmail\.googleapis\.com/);
  assert.match(shippingProvider, /api\.easypost\.com/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY_REPORT_ONLY, /accounts\.google|googleapis|easypost/);
});

test("Netlify runs the global header wrapper before the Admin authorization gate", async () => {
  const config = await readFile("netlify.toml", "utf8");
  const securityDeclaration = config.indexOf('function = "security-headers"');
  const adminDeclaration = config.indexOf('function = "admin-auth"');

  assert.notEqual(securityDeclaration, -1);
  assert.notEqual(adminDeclaration, -1);
  assert.ok(securityDeclaration < adminDeclaration);
  assert.match(
    config,
    /\[\[edge_functions\]\]\s+path = "\/\*"\s+function = "security-headers"/
  );
});

test("HSTS preserves the existing apex-only production posture", () => {
  assert.equal(SECURITY_HEADERS["Strict-Transport-Security"], "max-age=31536000");
  assert.doesNotMatch(SECURITY_HEADERS["Strict-Transport-Security"], /includeSubDomains|preload/i);
});
