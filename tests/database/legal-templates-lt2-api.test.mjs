import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler
} from "../../netlify/functions/admin-legal-templates.mjs";
import {
  COOKIE_NAME,
  createAdminSessionToken,
  randomToken,
  SESSION_LENGTH_SECONDS
} from "../../netlify/shared/admin-session.mjs";
import { createStoredAdminSession } from "../../netlify/shared/admin-session-store.mjs";
import { importLegacyTemplates } from "../../scripts/import-legacy-legal-templates.mjs";

const sessionSecret = "lt2-api-session-secret-with-sufficient-entropy";
const apiUrl = "https://studio.example/admin/api/legal-templates";

let database;
let db;
let handler;
let ownerCookie;
let viewerCookie;
let commissionTemplateId;

function environment(name) {
  return {
    ADMIN_SESSION_SECRET: sessionSecret,
    ADMIN_OIDC_CLIENT_ID: "lt2-client.apps.googleusercontent.com",
    ADMIN_LEGACY_LOGIN_ENABLED: "false"
  }[name];
}

async function issueSession(adminUserId, externalSubject) {
  const now = new Date();
  const sessionId = randomToken(24);
  const token = await createAdminSessionToken({
    provider: "google",
    externalSubject,
    sessionId
  }, sessionSecret, { now: () => now });
  await createStoredAdminSession(db, {
    adminUserId,
    sessionIdentifier: sessionId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_LENGTH_SECONDS * 1000),
    userAgent: "LT-2 API Test"
  });
  return `${COOKIE_NAME}=${token}`;
}

function request(path = "", { method = "GET", cookie = ownerCookie } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  return handler(new Request(`${apiUrl}${path}`, { method, headers }));
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const admins = (await db.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, display_name, role, status
     ) VALUES
       ('google', 'lt2-api-owner', 'lt2-api-owner@example.invalid', 'LT-2 Owner', 'owner_admin', 'active'),
       ('google', 'lt2-api-viewer', 'lt2-api-viewer@example.invalid', 'LT-2 Viewer', 'viewer', 'active')
     RETURNING id, external_subject`
  )).rows;
  const owner = admins.find((row) => row.external_subject === "lt2-api-owner");
  const viewer = admins.find((row) => row.external_subject === "lt2-api-viewer");
  await importLegacyTemplates(db, {
    actorAdminUserId: owner.id,
    projectRoot: process.cwd()
  });
  commissionTemplateId = (await db.pool.query(
    "SELECT id FROM legal_templates WHERE template_key = 'commission-agreement'"
  )).rows[0].id;

  const clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('API Client', 'lt2-api-client@example.invalid') RETURNING id"
  )).rows[0].id;
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (commission_number, client_id, title, description, medium, price)
     VALUES ('SAS-COM-2026-9202', $1, 'API Work', 'Legacy Contract', 'Oil', 500)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version,
       file_location, document_snapshot
     ) VALUES (
       $1, 'contract', 'SAS-CON-2026-9202', 1, '/admin/contracts/9202.html',
       '{"contract":{"subtype":"commission_agreement","status":"issued"}}'::jsonb
     )`,
    [commissionId]
  );

  ownerCookie = await issueSession(owner.id, owner.external_subject);
  viewerCookie = await issueSession(viewer.id, viewer.external_subject);
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader: environment
  });
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("LT-2 exposes only the four read routes", () => {
  assert.deepEqual(config.path, [
    "/admin/api/legal-templates",
    "/admin/api/legal-templates/inventory",
    "/admin/api/legal-templates/:id",
    "/admin/api/legal-templates/:id/history"
  ]);
});

test("every Legal Templates route is protected by Admin authentication", async () => {
  for (const path of ["", "/inventory", `/${commissionTemplateId}`, `/${commissionTemplateId}/history`]) {
    assert.equal((await request(path, { cookie: "" })).status, 401, path);
  }
});

test("Owner and Viewer receive the same read-only registry", async () => {
  const ownerResponse = await request();
  const viewerResponse = await request("", { cookie: viewerCookie });
  assert.equal(ownerResponse.status, 200);
  assert.equal(viewerResponse.status, 200);
  assert.deepEqual(await viewerResponse.json(), await ownerResponse.json());
});

test("list reports Draft inventory, no Effective version, and no publication", async () => {
  const body = await (await request()).json();
  assert.equal(body.total, 2);
  const commission = body.templates.find((template) => template.template_key === "commission-agreement");
  assert.equal(commission.version_count, 3);
  assert.equal(commission.approved_version_count, 0);
  assert.equal(commission.effective_version, null);
  assert.equal(commission.latest_draft.state, "draft");
  assert.equal(commission.publication_state, "not_published");
  assert.deepEqual(commission.warnings, [
    "No Effective Version", "Source Conflict", "Contract Issuance Locked"
  ]);
  assert.equal(commission.contract_issuance_locked, true);
});

test("detail keeps Commission sources separate and exposes safe comparison metadata", async () => {
  const response = await request(`/${commissionTemplateId}`, { cookie: viewerCookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.template.versions.length, 3);
  assert.deepEqual(body.template.versions.map((version) => version.source_role), [
    "legacy_reference", "legacy_candidate", "legacy_candidate"
  ]);
  assert.equal(body.template.versions.every((version) => version.state === "draft"), true);
  assert.equal(body.template.versions.every(
    (version) => version.comparison.equivalence_status === "not_established"
  ), true);
  assert.equal(JSON.stringify(body).includes("structured_content"), false);
  assert.equal(JSON.stringify(body).includes("A non-refundable deposit"), false);
});

test("version history includes hashes, import timestamps, and append-only events", async () => {
  const body = await (await request(`/${commissionTemplateId}/history`)).json();
  assert.equal(body.versions.length, 3);
  assert.equal(body.versions.every((version) => /^[0-9a-f]{64}$/.test(version.content_hash)), true);
  assert.equal(body.versions.every((version) => Boolean(version.created_at)), true);
  assert.equal(body.audit_events.length, 7);
  assert.deepEqual(new Set(body.audit_events.map((event) => event.event_type)), new Set([
    "template_created_from_legacy",
    "version_imported_from_legacy",
    "legacy_source_hash_recorded"
  ]));
});

test("unknown historical provenance is displayed as legacy_unmapped", async () => {
  const body = await (await request(`/${commissionTemplateId}`)).json();
  assert.equal(body.template.related_documents.length, 0);
  assert.equal(body.template.legacy_unmapped_documents.length, 1);
  assert.equal(body.template.legacy_unmapped_documents[0].document_number, "SAS-CON-2026-9202");
  assert.equal(body.template.legacy_unmapped_documents[0].provenance_status, "legacy_unmapped");
});

test("operational inventory keeps Invoice, COA, and generators not governed", async () => {
  const body = await (await request("/inventory", { cookie: viewerCookie })).json();
  assert.equal(body.governance_status, "not_governed");
  assert.deepEqual(body.sources.map((source) => source.source_key), [
    "admin-invoice-template",
    "admin-coa-template",
    "legacy-browser-document-generator",
    "public-document-view-generator"
  ]);
  assert.equal(body.sources.every((source) => source.governance_status === "not_governed"), true);
});

test("no mutation method exists for Owner or Viewer", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await request("", { method })).status, 405, `Owner ${method}`);
    assert.equal((await request("", { method, cookie: viewerCookie })).status, 403, `Viewer ${method}`);
  }
});

test("GET requests never change Template, version, publication, Document, or audit counts", async () => {
  const count = async (table) => Number((await db.pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  const tables = [
    "legal_templates", "legal_template_versions", "legal_template_publications",
    "documents", "legal_audit_events"
  ];
  const beforeCounts = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await count(table)])));
  await request();
  await request(`/${commissionTemplateId}`);
  await request(`/${commissionTemplateId}/history`);
  await request("/inventory");
  const afterCounts = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await count(table)])));
  assert.deepEqual(afterCounts, beforeCounts);
});

test("invalid and unknown Template ids fail safely", async () => {
  assert.equal((await request("/0")).status, 400);
  assert.equal((await request("/999999")).status, 404);
  assert.equal((await request("/999999/history")).status, 404);
  assert.equal((await request("/1/other")).status, 404);
});
