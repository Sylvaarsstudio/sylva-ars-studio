import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { createHandler as createAdminEdgeHandler } from "../../netlify/edge-functions/admin-auth.js";
import {
  COOKIE_NAME,
  createAdminSessionToken
} from "../../netlify/shared/admin-session.mjs";

const require = createRequire(import.meta.url);
const {
  documentDefinitions,
  generatePublicDocumentViews,
  renderPublicDocument
} = require("../../scripts/generate-public-document-views.js");
const {
  documentsPath,
  getProtectedTemplateUrl,
  isExpectedTemplateUrl,
  sessionExpiredMessage,
  templateDefinitions
} = require("../../web/js/admin.js");

const protectedDirectory = "web/admin/document-templates";
const publicDirectory = "web/documents";
const expectedSessionMessage =
  "Your Admin session expired. Sign in again before loading or creating this document.";

function read(filename) {
  return readFileSync(filename, "utf8");
}

function extractMain(html) {
  const start = html.search(/<main\b/i);
  const closingMatch = /<\/main\s*>/i.exec(html.slice(start));
  assert.notEqual(start, -1, "expected a <main> element");
  assert.ok(closingMatch, "expected a closing </main> element");
  return html.slice(start, start + closingMatch.index + closingMatch[0].length);
}

function dataFields(html) {
  return Array.from(html.matchAll(/\bdata-field=["']([^"']+)["']/g), (match) => match[1]);
}

test("the four exact protected-to-public mappings exist", () => {
  assert.deepEqual(
    documentDefinitions.map(({ filename }) => filename),
    [
      "artwork-sales-agreement.html",
      "commission-agreement.html",
      "invoice-template.html",
      "coa-template.html"
    ]
  );

  for (const { filename } of documentDefinitions) {
    assert.ok(read(path.join(protectedDirectory, filename)));
    assert.ok(read(path.join(publicDirectory, filename)));
  }
});

test("protected templates differ from the previous clean sources only by one root base", () => {
  for (const { filename } of documentDefinitions) {
    const previous = execFileSync("git", ["show", `HEAD:web/documents/${filename}`], {
      encoding: "utf8"
    });
    const current = read(path.join(protectedDirectory, filename));
    const baseElements = current.match(/<base\s+href=["']\/["']\s*>/gi) || [];
    assert.equal(baseElements.length, 1, `${filename} must contain one root base`);
    assert.equal(
      current.replace(/^[ \t]*<base\s+href=["']\/["']\s*>[ \t]*\r?\n/im, ""),
      previous,
      `${filename} changed beyond route normalization`
    );
  }
});

test("public views retain byte-identical main content and data-field order", () => {
  for (const { filename } of documentDefinitions) {
    const canonicalMain = extractMain(read(path.join(protectedDirectory, filename)));
    const publicMain = extractMain(read(path.join(publicDirectory, filename)));
    assert.equal(publicMain, canonicalMain, `${filename} main must remain identical`);
    assert.deepEqual(dataFields(publicMain), dataFields(canonicalMain));
  }
});

test("public notices are exact, accessible, outside main, and immediately before it", () => {
  for (const definition of documentDefinitions) {
    const html = read(path.join(publicDirectory, definition.filename));
    const notice = [
      '<aside class="public-document-status" aria-label="Document status">',
      `    <p>${definition.notice}</p>`,
      "  </aside>"
    ].join("\n");
    assert.equal((html.match(/aria-label="Document status"/g) || []).length, 1);
    assert.ok(html.indexOf(notice) < html.search(/<main\b/i));
    assert.match(html, new RegExp(`${notice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n\\s*<main\\b`));
    assert.doesNotMatch(extractMain(html), /public-document-status|Document status/);
  }
});

test("protected templates contain no public notice or public status stylesheet", () => {
  for (const { filename } of documentDefinitions) {
    const html = read(path.join(protectedDirectory, filename));
    assert.doesNotMatch(html, /public-document-status|Document status|Under legal review|Not an issued document/);
  }
});

test("public status styling is responsive and completely hidden in print", () => {
  const css = read("web/css/public-document-status.css");
  assert.match(css, /@media\s*\(max-width:\s*600px\)/);
  assert.match(css, /@media\s+print\s*{[\s\S]*?\.public-document-status\s*{[\s\S]*?display:\s*none\s*!important;/);
});

test("generation is deterministic and its checked-in outputs are current", () => {
  for (const definition of documentDefinitions) {
    const source = read(path.join(protectedDirectory, definition.filename));
    const first = renderPublicDocument(source, definition);
    const second = renderPublicDocument(source, definition);
    assert.equal(first, second);
    assert.equal(first, read(path.join(publicDirectory, definition.filename)));
  }
});

test("generation validates every source before writing any public output", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "sas-public-documents-"));
  const sources = path.join(temporaryRoot, "sources");
  const outputs = path.join(temporaryRoot, "outputs");
  mkdirSync(sources);
  mkdirSync(outputs);
  writeFileSync(path.join(outputs, "sentinel.txt"), "unchanged", "utf8");

  try {
    for (const definition of documentDefinitions.slice(0, -1)) {
      writeFileSync(
        path.join(sources, definition.filename),
        read(path.join(protectedDirectory, definition.filename)),
        "utf8"
      );
    }
    writeFileSync(
      path.join(sources, documentDefinitions.at(-1).filename),
      "<!doctype html><html><head></head><body>missing main</body></html>",
      "utf8"
    );

    assert.throws(
      () => generatePublicDocumentViews({ sourceDirectory: sources, outputDirectory: outputs }),
      /expected <main/
    );
    assert.deepEqual(readdirSync(outputs), ["sentinel.txt"]);
    assert.equal(read(path.join(outputs, "sentinel.txt")), "unchanged");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("generator rejects missing html, head, body, or expected main", () => {
  const definition = documentDefinitions[0];
  const invalidSources = [
    "<head></head><body><main class=\"document\"></main></body>",
    "<html><body><main class=\"document\"></main></body></html>",
    "<html><head></head><main class=\"document\"></main></html>",
    "<html><head></head><body></body></html>"
  ];
  for (const source of invalidSources) {
    assert.throws(() => renderPublicDocument(source, definition));
  }
});

test("legacy Admin generator references protected templates exclusively", () => {
  const html = read("web/admin/generate-documents.html");
  const script = read("web/js/admin.js");
  assert.equal(documentsPath, "/admin/document-templates/");
  assert.match(html, /src="\/admin\/document-templates\/invoice-template\.html"/);
  assert.doesNotMatch(`${html}\n${script}`, /(?:\.\.\/|\/)documents\/(?:invoice-template|coa-template|artwork-sales-agreement|commission-agreement)\.html/);
  assert.deepEqual(Object.keys(templateDefinitions), [
    "invoice-template.html",
    "coa-template.html",
    "artwork-sales-agreement.html",
    "commission-agreement.html"
  ]);
});

test("protected template URL checks reject login, public, different, and queried URLs", () => {
  const base = "https://sylvaarsstudio.com/admin/generate-documents.html";
  const filename = "invoice-template.html";
  assert.equal(
    getProtectedTemplateUrl(filename, base).href,
    "https://sylvaarsstudio.com/admin/document-templates/invoice-template.html"
  );
  assert.equal(isExpectedTemplateUrl(getProtectedTemplateUrl(filename, base), filename, base), true);
  assert.equal(isExpectedTemplateUrl("https://sylvaarsstudio.com/admin-login.html", filename, base), false);
  assert.equal(isExpectedTemplateUrl("https://sylvaarsstudio.com/documents/invoice-template.html", filename, base), false);
  assert.equal(isExpectedTemplateUrl("https://sylvaarsstudio.com/admin/document-templates/coa-template.html", filename, base), false);
  assert.equal(isExpectedTemplateUrl("https://sylvaarsstudio.com/admin/document-templates/invoice-template.html?stale=1", filename, base), false);
});

test("Admin preview and export fail closed and refetch without cache", () => {
  const script = read("web/js/admin.js");
  assert.equal(sessionExpiredMessage, expectedSessionMessage);
  assert.match(script, /credentials:\s*"same-origin"/);
  assert.match(script, /cache:\s*"no-store"/);
  assert.match(script, /redirect:\s*"follow"/);
  assert.match(script, /response\.redirected/);
  assert.match(script, /contentType\.toLowerCase\(\)\.includes\("text\/html"\)/);
  assert.match(script, /form\[action\*="admin-login"\]/);
  assert.match(script, /await fetchProtectedTemplateDocument\(template\)/);
  assert.match(script, /parsedDocument\.querySelectorAll\("base"\)/);
  assert.match(script, /new URL\("\/", window\.location\.origin\)/);
  assert.doesNotMatch(script, /cloneNode\s*\(/);
  assert.match(script, /new Blob\(\[printableHtml\]/);
});

function authEnvironment(secret) {
  const values = {
    ADMIN_SESSION_SECRET: secret,
    ADMIN_OIDC_CLIENT_ID: "test-client.apps.googleusercontent.com",
    ADMIN_LEGACY_LOGIN_ENABLED: "false"
  };
  return (name) => values[name];
}

function sessionDatabase(role, expiresAt) {
  return {
    pool: {
      async query(sql) {
        if (/FROM admin_sessions AS sessions/.test(sql)) {
          return {
            rows: [{
              session_id: `${role}-session-row`,
              admin_user_id: `${role}-user`,
              session_created_at: new Date("2026-11-14T12:00:00.000Z"),
              last_seen_at: new Date("2026-11-14T12:00:00.000Z"),
              session_expires_at: expiresAt,
              user_agent_summary: "Test Browser",
              id: `${role}-user`,
              identity_provider: "google",
              external_subject: `${role}-subject`,
              email: `${role}@example.invalid`,
              display_name: `Test ${role}`,
              role,
              status: "active",
              last_login_at: new Date("2026-11-14T12:00:00.000Z"),
              created_at: new Date("2026-11-14T12:00:00.000Z"),
              updated_at: new Date("2026-11-14T12:00:00.000Z")
            }]
          };
        }
        if (/UPDATE admin_sessions/.test(sql)) return { rows: [] };
        throw new Error("Unexpected session query.");
      }
    }
  };
}

test("Owner and Viewer may read protected templates with private no-store responses", async () => {
  const secret = "public-document-separation-test-session-secret";
  const now = new Date("2026-11-14T13:00:00.000Z");
  for (const role of ["owner_admin", "viewer"]) {
    const token = await createAdminSessionToken({
      provider: "google",
      externalSubject: `${role}-subject`,
      sessionId: `${role}-unique-session-identifier-0001`
    }, secret, { now: () => now });
    const edge = createAdminEdgeHandler({
      databaseFactory: () => sessionDatabase(role, new Date("2026-11-14T20:00:00.000Z")),
      environmentReader: authEnvironment(secret),
      now: () => now
    });
    let nextCalls = 0;
    const response = await edge(new Request(
      "https://sylvaarsstudio.com/admin/document-templates/invoice-template.html",
      { headers: { Cookie: `${COOKIE_NAME}=${token}` } }
    ), {
      next() {
        nextCalls += 1;
        return new Response("template", {
          headers: { "Cache-Control": "public, max-age=3600", "Content-Type": "text/html" }
        });
      }
    });
    assert.equal(response.status, 200);
    assert.equal(nextCalls, 1);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("unauthenticated protected templates redirect with private no-store", async () => {
  const secret = "public-document-separation-test-session-secret";
  const edge = createAdminEdgeHandler({
    databaseFactory: () => { throw new Error("database must not be needed"); },
    environmentReader: authEnvironment(secret),
    now: () => new Date("2026-11-14T13:00:00.000Z")
  });
  const response = await edge(
    new Request("https://sylvaarsstudio.com/admin/document-templates/invoice-template.html"),
    { next: () => new Response("must not run") }
  );
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^\/admin-login\.html\?redirect=/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
