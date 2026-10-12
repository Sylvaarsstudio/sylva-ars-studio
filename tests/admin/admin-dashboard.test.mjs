import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Admin Dashboard preserves the canonical navigation order and Commission language", () => {
  const html = readFileSync("web/admin/dashboard.html", "utf8");
  const labels = [...html.matchAll(/<a[^>]+class="admin-card"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/g)]
    .map((match) => match[1]);

  assert.deepEqual(labels, [
    "Inquiries",
    "Clients",
    "Quotations",
    "Commissions",
    "Calendar",
    "Communications",
    "Documents",
    "Glossary",
    "View Collection"
  ]);
  assert.match(html, /Review and manage active studio commissions\./);
  assert.doesNotMatch(html, /Create and review studio commissions\./);
});
