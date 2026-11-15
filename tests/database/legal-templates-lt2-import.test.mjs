import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { COMMISSION_AGREEMENT_TERMS } from "../../netlify/shared/contract-terms.mjs";
import {
  LEGACY_TEMPLATE_FAMILIES,
  OPERATIONAL_LEGACY_SOURCES,
  SOURCE_HASHES
} from "../../netlify/shared/legal-template-legacy-inventory.mjs";
import {
  importLegacyTemplates,
  loadLegacyTemplateFamilies,
  resolveImportActor,
  sha256
} from "../../scripts/import-legacy-legal-templates.mjs";

let database;
let db;
let ownerId;
let firstImport;
let secondImport;
let documentsBefore;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });

  ownerId = (await db.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, display_name, role, status
     ) VALUES (
       'google', 'lt2-import-owner', 'lt2-owner@example.invalid',
       'LT-2 Import Owner', 'owner_admin', 'active'
     ) RETURNING id`
  )).rows[0].id;
  const clientId = (await db.pool.query(
    `INSERT INTO clients (full_name, email)
     VALUES ('LT-2 Client', 'lt2-client@example.invalid') RETURNING id`
  )).rows[0].id;
  const commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES (
       'SAS-COM-2026-9201', $1, 'LT-2 Existing', 'Legacy provenance fixture', 'Oil', 400
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version,
       file_location, document_snapshot, created_at
     ) VALUES
       ($1, 'contract', 'SAS-CON-2026-9201', 1, '/admin/contracts/9201.html',
        '{"contract":{"subtype":"commission_agreement","status":"issued"}}'::jsonb,
        '2026-11-01T12:00:00Z'),
       ($1, 'coa', 'SAS-COA-2026-9201', 1, '/admin/coa/9201.html', NULL,
        '2026-11-01T12:05:00Z')`,
    [commissionId]
  );
  documentsBefore = (await db.pool.query("SELECT * FROM documents ORDER BY id")).rows;

  firstImport = await importLegacyTemplates(db, {
    actorAdminUserId: ownerId,
    projectRoot: process.cwd()
  });
  secondImport = await importLegacyTemplates(db, {
    actorAdminUserId: ownerId,
    projectRoot: process.cwd()
  });
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("LT-2 source hashes are pinned to the exact legacy files", async () => {
  const paths = [
    ["netlify/shared/contract-terms.mjs", SOURCE_HASHES.commissionCode],
    ["web/admin/document-templates/commission-agreement.html", SOURCE_HASHES.commissionAdminHtml],
    ["web/documents/commission-agreement.html", SOURCE_HASHES.commissionPublicHtml],
    ["web/admin/document-templates/artwork-sales-agreement.html", SOURCE_HASHES.artworkSalesAdminHtml],
    ["web/documents/artwork-sales-agreement.html", SOURCE_HASHES.artworkSalesPublicHtml],
    ["web/admin/document-templates/invoice-template.html", SOURCE_HASHES.invoiceAdminHtml],
    ["web/admin/document-templates/coa-template.html", SOURCE_HASHES.coaAdminHtml],
    ["web/admin/generate-documents.html", SOURCE_HASHES.legacyGeneratorHtml],
    ["web/js/admin.js", SOURCE_HASHES.legacyGeneratorScript],
    ["scripts/generate-public-document-views.js", SOURCE_HASHES.publicViewGenerator]
  ];
  for (const [filename, expectedHash] of paths) {
    assert.equal(sha256(await readFile(path.resolve(filename))), expectedHash, filename);
  }
});

test("explicit importer creates exactly the two intended LT-2 inventory families", async () => {
  const templates = await db.pool.query(
    "SELECT template_key, name, template_kind FROM legal_templates ORDER BY template_key"
  );
  assert.deepEqual(templates.rows, [
    {
      template_key: "artwork-sales-agreement",
      name: "Artwork Sales Agreement",
      template_kind: "agreement"
    },
    {
      template_key: "commission-agreement",
      name: "Commission Agreement",
      template_kind: "agreement"
    }
  ]);
  assert.equal(firstImport.templates_created, 2);
  assert.equal(firstImport.versions_created, 5);
});

test("every imported version remains Draft with no approval or effectivity", async () => {
  const versions = await db.pool.query(
    `SELECT state, approved_by_admin_user_id, approved_at, effective_at,
            revoked_at, superseded_at
     FROM legal_template_versions`
  );
  assert.equal(versions.rows.length, 5);
  for (const version of versions.rows) {
    assert.equal(version.state, "draft");
    for (const field of [
      "approved_by_admin_user_id", "approved_at", "effective_at",
      "revoked_at", "superseded_at"
    ]) assert.equal(version[field], null, field);
  }
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM legal_template_publications")).rows[0].count, 0);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM legal_template_assets")).rows[0].count, 0);
});

test("Commission code and HTML sources remain separate with equivalence not established", async () => {
  const result = await db.pool.query(
    `SELECT v.version_number, v.content_hash,
            v.structured_content -> 'source' ->> 'identity' AS source_identity,
            v.structured_content -> 'source' ->> 'role' AS source_role,
            v.structured_content -> 'comparison' ->> 'equivalence_status' AS equivalence_status
     FROM legal_template_versions v
     JOIN legal_templates t ON t.id = v.template_id
     WHERE t.template_key = 'commission-agreement'
     ORDER BY v.version_number`
  );
  assert.deepEqual(result.rows.map((row) => row.source_identity), [
    "commission-agreement:code-defined:draft-1",
    "commission-agreement:protected-admin-html",
    "commission-agreement:public-static-html"
  ]);
  assert.equal(new Set(result.rows.map((row) => row.content_hash)).size, 3);
  assert.equal(result.rows.every((row) => row.equivalence_status === "not_established"), true);
  assert.deepEqual(result.rows.map((row) => row.source_role), [
    "legacy_candidate", "legacy_candidate", "legacy_reference"
  ]);
  assert.equal(COMMISSION_AGREEMENT_TERMS.approved, false);
});

test("Artwork Sales Agreement is a separate Draft candidate plus public reference", async () => {
  const result = await db.pool.query(
    `SELECT v.version_number, v.state,
            v.structured_content -> 'source' ->> 'role' AS source_role
     FROM legal_template_versions v
     JOIN legal_templates t ON t.id = v.template_id
     WHERE t.template_key = 'artwork-sales-agreement'
     ORDER BY v.version_number`
  );
  assert.deepEqual(result.rows, [
    { version_number: 1, state: "draft", source_role: "legacy_candidate" },
    { version_number: 2, state: "draft", source_role: "legacy_reference" }
  ]);
});

test("Invoice and COA remain not-governed operational inventory only", async () => {
  assert.deepEqual(
    OPERATIONAL_LEGACY_SOURCES.slice(0, 2).map((source) => source.source_key),
    ["admin-invoice-template", "admin-coa-template"]
  );
  assert.equal(OPERATIONAL_LEGACY_SOURCES.every((source) => source.governance_status === "not_governed"), true);
  const keys = (await db.pool.query("SELECT template_key FROM legal_templates")).rows.map((row) => row.template_key);
  assert.equal(keys.includes("invoice"), false);
  assert.equal(keys.includes("coa"), false);
});

test("existing Documents remain byte-for-byte equivalent at the row level and unmapped", async () => {
  const documentsAfter = (await db.pool.query("SELECT * FROM documents ORDER BY id")).rows;
  assert.deepEqual(documentsAfter, documentsBefore);
  assert.equal(documentsAfter.every((row) => row.legal_template_id === null), true);
  assert.equal(documentsAfter.every((row) => row.legal_template_version_id === null), true);
  assert.equal(documentsAfter.every((row) => row.document_origin === null), true);
});

test("append-only import events contain provenance metadata but no legal content", async () => {
  const events = await db.pool.query(
    `SELECT event_type, event_context, content_hash
     FROM legal_audit_events ORDER BY id`
  );
  assert.equal(events.rows.length, 12);
  assert.deepEqual(
    Object.fromEntries([
      "template_created_from_legacy",
      "version_imported_from_legacy",
      "legacy_source_hash_recorded"
    ].map((eventType) => [
      eventType,
      events.rows.filter((row) => row.event_type === eventType).length
    ])),
    {
      template_created_from_legacy: 2,
      version_imported_from_legacy: 5,
      legacy_source_hash_recorded: 5
    }
  );
  const payload = JSON.stringify(events.rows);
  assert.doesNotMatch(payload, /non-refundable deposit|Copyright and Usage Rights/);
  assert.equal(events.rows.every((row) => row.event_context.system_operation === true), true);
});

test("rerunning the deterministic import creates no duplicates", async () => {
  assert.deepEqual(secondImport, {
    templates_created: 0,
    versions_created: 0,
    audit_events_created: 0,
    templates_total: 2,
    versions_total: 5
  });
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM legal_templates")).rows[0].count, 2);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM legal_template_versions")).rows[0].count, 5);
  assert.equal((await db.pool.query("SELECT count(*)::integer AS count FROM legal_audit_events")).rows[0].count, 12);
});

test("source loader exposes deterministic structural summaries", async () => {
  const families = await loadLegacyTemplateFamilies(process.cwd());
  const commission = families.find((family) => family.templateKey === "commission-agreement");
  assert.equal(commission.sources[0].structuredContent.structural_summary.section_count, 5);
  assert.equal(commission.sources[1].structuredContent.structural_summary.section_count, 11);
  assert.equal(commission.sources[2].structuredContent.structural_summary.data_field_count, 11);
  assert.equal(LEGACY_TEMPLATE_FAMILIES.length, 2);
});

test("actor resolution is explicit and restricted to the active Owner Admin", async () => {
  const actor = await resolveImportActor(db, "lt2-import-owner");
  assert.equal(String(actor.id), String(ownerId));
  await assert.rejects(resolveImportActor(db, "missing-owner"), /exactly one active Owner Admin/i);
});
