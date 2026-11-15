import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { COMMISSION_AGREEMENT_TERMS } from "../../netlify/shared/contract-terms.mjs";

const migrationName = "20261115000000_legal_templates_lt1_foundation.sql";
const migrationDirectory = new URL("../../netlify/database/migrations/", import.meta.url);
const approvedAt = "2026-11-15T15:00:00.000Z";
const effectiveAt = "2026-11-15T16:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

let database;
let db;
let ownerId;
let clientId;
let commissionId;
let documentSequence = 0;

async function createTemplate(templateKey = `template-${randomUUID()}`) {
  return (await db.pool.query(
    `INSERT INTO legal_templates (
       template_key, name, template_kind, description, created_by_admin_user_id
     ) VALUES ($1, 'Commission Agreement', 'agreement', 'Governed test family', $2)
     RETURNING *`,
    [templateKey, ownerId]
  )).rows[0];
}

async function createVersion(templateId, {
  versionNumber = 1,
  state = "draft",
  contentHash = null
} = {}) {
  const isApproved = state !== "draft";
  const isEffective = ["effective", "superseded", "revoked"].includes(state);
  const isSuperseded = state === "superseded";
  const isRevoked = state === "revoked";
  return (await db.pool.query(
    `INSERT INTO legal_template_versions (
       template_id, version_number, state, content_schema_version,
       structured_content, variable_manifest, content_hash,
       approved_by_admin_user_id, approved_at, effective_at,
       superseded_at, revoked_at, revoked_by_admin_user_id,
       revocation_reason, created_by_admin_user_id
     ) VALUES (
       $1, $2, $3, 1, '{"sections":{}}'::jsonb, '{"variables":[]}'::jsonb, $4,
       $5, $6, $7, $8, $9, $10, $11, $12
     ) RETURNING *`,
    [
      templateId,
      versionNumber,
      state,
      contentHash,
      isApproved ? ownerId : null,
      isApproved ? approvedAt : null,
      isEffective ? effectiveAt : null,
      isSuperseded ? "2026-11-15T17:00:00.000Z" : null,
      isRevoked ? "2026-11-15T17:00:00.000Z" : null,
      isRevoked ? ownerId : null,
      isRevoked ? "Withdrawn by legal review." : null,
      ownerId
    ]
  )).rows[0];
}

async function createDocument({
  documentType = "coa",
  documentSnapshot = null,
  issuedAt = null,
  finalizedAt = null
} = {}) {
  documentSequence += 1;
  return (await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version,
       file_location, document_snapshot, issued_at, finalized_at
     ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      commissionId,
      documentType,
      `SAS-${documentType.toUpperCase()}-LT1-${String(documentSequence).padStart(4, "0")}`,
      `/lt1/${documentSequence}`,
      documentSnapshot === null ? null : JSON.stringify(documentSnapshot),
      issuedAt,
      finalizedAt
    ]
  )).rows[0];
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
});

beforeEach(async () => {
  await db.pool.query(
    `TRUNCATE
       legal_audit_events,
       document_packet_items,
       document_assignments,
       document_assets,
       legal_template_publications,
       legal_template_assets,
       documents,
       legal_template_versions,
       legal_templates
     RESTART IDENTITY CASCADE`
  );
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM clients");
  await db.pool.query("DELETE FROM admin_users");

  const admins = await db.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, display_name, role, status
     ) VALUES (
       'google', 'lt1-owner', 'lt1-owner@example.invalid',
       'LT-1 Owner', 'owner_admin', 'active'
     )
     RETURNING id, external_subject`
  );
  ownerId = admins.rows.find((row) => row.external_subject === "lt1-owner").id;

  clientId = (await db.pool.query(
    `INSERT INTO clients (full_name, email)
     VALUES ('LT-1 Client', 'lt1-client@example.invalid') RETURNING id`
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ('SAS-COM-2026-9901', $1, 'LT-1 Work', 'Schema fixture', 'Oil', 100)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("LT-1 applies on a fresh database with nullable additive Document provenance", async () => {
  const tables = await db.pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'legal_templates', 'legal_template_versions', 'legal_template_assets',
         'legal_template_publications', 'document_assets', 'document_assignments',
         'document_packet_items', 'legal_audit_events'
       )
     ORDER BY table_name`
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    "document_assets",
    "document_assignments",
    "document_packet_items",
    "legal_audit_events",
    "legal_template_assets",
    "legal_template_publications",
    "legal_template_versions",
    "legal_templates"
  ]);

  const columns = await db.pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'documents'
       AND column_name IN (
         'legal_template_id', 'legal_template_version_id', 'document_origin',
         'snapshot_hash', 'issued_by_admin_user_id', 'issued_at', 'finalized_at'
       )`
  );
  assert.equal(columns.rows.length, 7);
  assert.equal(columns.rows.every((row) => row.is_nullable === "YES"), true);

  const relationshipColumns = await db.pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_name IN ('document_assignments', 'legal_audit_events')`
  );
  const namesByTable = Object.groupBy(
    relationshipColumns.rows,
    (row) => row.table_name
  );
  assert.equal(
    namesByTable.document_assignments.some((row) => row.column_name === "artwork_id"),
    false
  );
  assert.equal(
    namesByTable.legal_audit_events.some((row) => row.column_name === "asset_id"),
    false
  );
  assert.equal(
    namesByTable.legal_audit_events.some((row) => row.column_name === "event_context"),
    true
  );

  const source = await readFile(new URL(migrationName, migrationDirectory), "utf8");
  assert.doesNotMatch(source, /\b(?:aws|guardduty|cloudflare|r2)\b/i);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+legal_templates/i);
  assert.doesNotMatch(source, /UPDATE\s+documents/i);
});

test("Legal Template keys are unique and become immutable after the first version", async () => {
  const template = await createTemplate("commission-agreement");
  await assert.rejects(
    createTemplate("commission-agreement"),
    (error) => error.code === "23505"
  );

  await db.pool.query(
    "UPDATE legal_templates SET template_key = 'commission-agreement-v2' WHERE id = $1",
    [template.id]
  );
  await createVersion(template.id);
  await assert.rejects(
    db.pool.query(
      "UPDATE legal_templates SET template_key = 'commission-agreement-v3' WHERE id = $1",
      [template.id]
    ),
    /immutable after its first version/i
  );
  await assert.rejects(
    db.pool.query("DELETE FROM legal_templates WHERE id = $1", [template.id]),
    (error) => error.code === "23503"
  );
});

test("version numbers are unique and only one version per Template may be Effective", async () => {
  const template = await createTemplate();
  await createVersion(template.id, { versionNumber: 1 });
  await assert.rejects(
    createVersion(template.id, { versionNumber: 1 }),
    (error) => error.code === "23505"
  );

  await createVersion(template.id, { versionNumber: 2, state: "effective" });
  await assert.rejects(
    createVersion(template.id, { versionNumber: 3, state: "effective" }),
    (error) => error.code === "23505"
  );
});

test("version state timestamps and lifecycle transitions are consistent", async () => {
  const template = await createTemplate();
  await assert.rejects(db.pool.query(
    `INSERT INTO legal_template_versions (
       template_id, version_number, state, created_by_admin_user_id
     ) VALUES ($1, 1, 'approved', $2)`,
    [template.id, ownerId]
  ), (error) => error.code === "23514");

  await assert.rejects(db.pool.query(
    `INSERT INTO legal_template_versions (
       template_id, version_number, state, approved_by_admin_user_id,
       approved_at, created_by_admin_user_id
     ) VALUES ($1, 2, 'effective', $2, $3, $2)`,
    [template.id, ownerId, approvedAt]
  ), (error) => error.code === "23514");

  const approved = await createVersion(template.id, { versionNumber: 3, state: "approved" });
  await assert.rejects(db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'draft', approved_by_admin_user_id = NULL, approved_at = NULL
     WHERE id = $1`,
    [approved.id]
  ), /invalid legal template version lifecycle transition/i);

  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'effective', effective_at = $2
     WHERE id = $1`,
    [approved.id, effectiveAt]
  );
  await assert.rejects(db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'revoked', revoked_at = $2,
         revoked_by_admin_user_id = $3, revocation_reason = NULL
     WHERE id = $1`,
    [approved.id, "2026-11-15T17:00:00.000Z", ownerId]
  ), (error) => error.code === "23514");
});

test("Draft content is mutable and approval makes governed content immutable", async () => {
  const template = await createTemplate();
  const version = await createVersion(template.id, { contentHash: hashA });
  await db.pool.query(
    `UPDATE legal_template_versions
     SET structured_content = '{"sections":{"payment":"draft"}}'::jsonb,
         draft_revision = 2, content_hash = $2
     WHERE id = $1`,
    [version.id, hashB]
  );
  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'approved', approved_by_admin_user_id = $2, approved_at = $3
     WHERE id = $1`,
    [version.id, ownerId, approvedAt]
  );

  await assert.rejects(db.pool.query(
    `UPDATE legal_template_versions
     SET structured_content = '{"sections":{"payment":"changed"}}'::jsonb
     WHERE id = $1`,
    [version.id]
  ), /content is immutable/i);
  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'effective', effective_at = $2
     WHERE id = $1`,
    [version.id, effectiveAt]
  );
  await assert.rejects(db.pool.query(
    "UPDATE legal_template_versions SET content_hash = $2 WHERE id = $1",
    [version.id, hashA]
  ), /content is immutable/i);
  await assert.rejects(
    db.pool.query("DELETE FROM legal_template_versions WHERE id = $1", [version.id]),
    /cannot be deleted/i
  );
});

test("assets may change in Draft and are frozen at approval", async () => {
  const template = await createTemplate();
  const version = await createVersion(template.id);
  const asset = (await db.pool.query(
    `INSERT INTO legal_template_assets (
       template_version_id, asset_role, storage_key, original_filename,
       mime_type, byte_size, sha256, uploaded_by_admin_user_id
     ) VALUES ($1, 'reference_pdf', 'private/key.pdf', 'terms.pdf',
       'application/pdf', 1024, $2, $3) RETURNING id`,
    [version.id, hashA, ownerId]
  )).rows[0];
  await db.pool.query(
    "UPDATE legal_template_assets SET scan_status = 'clean' WHERE id = $1",
    [asset.id]
  );
  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'approved', approved_by_admin_user_id = $2, approved_at = $3
     WHERE id = $1`,
    [version.id, ownerId, approvedAt]
  );

  await assert.rejects(
    db.pool.query(
      "UPDATE legal_template_assets SET original_filename = 'replacement.pdf' WHERE id = $1",
      [asset.id]
    ),
    /assets for approved legal template versions are immutable/i
  );
  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'effective', effective_at = $2
     WHERE id = $1`,
    [version.id, effectiveAt]
  );
  await assert.rejects(
    db.pool.query("DELETE FROM legal_template_assets WHERE id = $1", [asset.id]),
    /assets for approved legal template versions are immutable/i
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO legal_template_assets (
       template_version_id, asset_role, storage_key, original_filename,
       mime_type, byte_size, sha256, uploaded_by_admin_user_id
     ) VALUES ($1, 'replacement', 'private/replacement.pdf', 'replacement.pdf',
       'application/pdf', 2048, $2, $3)`,
    [version.id, hashB, ownerId]
  ), /assets for approved legal template versions are immutable/i);
});

test("canonical publication requires an Effective version and history closes without deletion", async () => {
  const template = await createTemplate();
  const draft = await createVersion(template.id, { versionNumber: 1 });
  await db.pool.query(
    `INSERT INTO legal_template_publications (
       template_version_id, public_slug, publication_mode, published_by_admin_user_id
     ) VALUES ($1, 'commission-preview', 'public_preview', $2)`,
    [draft.id, ownerId]
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO legal_template_publications (
       template_version_id, public_slug, publication_mode, published_by_admin_user_id
     ) VALUES ($1, 'commission-canonical', 'public_canonical', $2)`,
    [draft.id, ownerId]
  ), /requires an effective legal template version/i);

  const effective = await createVersion(template.id, { versionNumber: 2, state: "effective" });
  const publication = (await db.pool.query(
    `INSERT INTO legal_template_publications (
       template_version_id, public_slug, publication_mode, published_by_admin_user_id
     ) VALUES ($1, 'commission-agreement', 'public_canonical', $2) RETURNING id`,
    [effective.id, ownerId]
  )).rows[0];
  await assert.rejects(db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'superseded', superseded_at = '2026-11-15T17:00:00.000Z'
     WHERE id = $1`,
    [effective.id]
  ), /close active canonical publications/i);

  await db.pool.query(
    `UPDATE legal_template_publications
     SET unpublished_at = published_at + INTERVAL '1 second',
         unpublished_by_admin_user_id = $2, reason = 'Superseded.'
     WHERE id = $1`,
    [publication.id, ownerId]
  );
  await db.pool.query(
    `UPDATE legal_template_versions
     SET state = 'superseded', superseded_at = '2026-11-15T17:00:00.000Z'
     WHERE id = $1`,
    [effective.id]
  );
  await assert.rejects(
    db.pool.query("DELETE FROM legal_template_publications WHERE id = $1", [publication.id]),
    /history cannot be deleted/i
  );
});

test("Legal audit events are append-only and keep asset references unambiguous in event_context", async () => {
  const template = await createTemplate();
  const version = await createVersion(template.id);
  const event = (await db.pool.query(
    `INSERT INTO legal_audit_events (
       event_type, actor_admin_user_id, actor_role_snapshot,
       template_id, template_version_id, previous_state, new_state,
       event_context, content_hash, request_id, reason
     ) VALUES (
       'legal_template_version_created', $1, 'owner_admin', $2, $3,
       NULL, '{"state":"draft"}'::jsonb,
       '{"asset_table":"legal_template_assets","asset_id":"12"}'::jsonb,
       $4, $5, 'Initial governed draft.'
     ) RETURNING id`,
    [ownerId, template.id, version.id, hashA, randomUUID()]
  )).rows[0];

  await assert.rejects(
    db.pool.query("UPDATE legal_audit_events SET reason = 'changed' WHERE id = $1", [event.id]),
    /append-only/i
  );
  await assert.rejects(
    db.pool.query("DELETE FROM legal_audit_events WHERE id = $1", [event.id]),
    /append-only/i
  );
});

test("Document provenance uses a composite FK so Template and version cannot disagree", async () => {
  const firstTemplate = await createTemplate();
  const firstVersion = await createVersion(firstTemplate.id);
  const secondTemplate = await createTemplate();
  await createVersion(secondTemplate.id);

  const document = await createDocument();
  await db.pool.query(
    `UPDATE documents
     SET document_origin = 'template', legal_template_id = $2,
         legal_template_version_id = $3, snapshot_hash = $4,
         issued_by_admin_user_id = $5
     WHERE id = $1`,
    [document.id, firstTemplate.id, firstVersion.id, hashA, ownerId]
  );
  await assert.rejects(db.pool.query(
    `UPDATE documents
     SET legal_template_id = $2, legal_template_version_id = $3
     WHERE id = $1`,
    [document.id, secondTemplate.id, firstVersion.id]
  ), (error) => error.code === "23503");

  const existingStyle = await createDocument();
  assert.equal(existingStyle.document_origin, null);
  assert.equal(existingStyle.legal_template_id, null);
  await assert.rejects(db.pool.query(
    `UPDATE documents
     SET document_origin = 'template', legal_template_version_id = $2
     WHERE id = $1`,
    [existingStyle.id, firstVersion.id]
  ), (error) => error.code === "23514");
});

test("Document assignments require exactly one canonical subject and freeze with the parent", async () => {
  const document = await createDocument();
  await assert.rejects(db.pool.query(
    `INSERT INTO document_assignments (document_id, relationship_role)
     VALUES ($1, 'subject')`,
    [document.id]
  ), (error) => error.code === "23514");
  await assert.rejects(db.pool.query(
    `INSERT INTO document_assignments (
       document_id, relationship_role, client_id, commission_id
     ) VALUES ($1, 'subject', $2, $3)`,
    [document.id, clientId, commissionId]
  ), (error) => error.code === "23514");

  const assignment = (await db.pool.query(
    `INSERT INTO document_assignments (
       document_id, relationship_role, client_id
     ) VALUES ($1, 'client', $2) RETURNING id`,
    [document.id, clientId]
  )).rows[0];
  const nonContract = await createDocument();
  await assert.rejects(db.pool.query(
    `INSERT INTO document_assignments (
       document_id, relationship_role, contract_document_id
     ) VALUES ($1, 'addendum_for', $2)`,
    [document.id, nonContract.id]
  ), /must reference a contract document/i);

  await db.pool.query(
    "UPDATE documents SET finalized_at = NOW() WHERE id = $1",
    [document.id]
  );
  await assert.rejects(
    db.pool.query("DELETE FROM document_assignments WHERE id = $1", [assignment.id]),
    /assignments for issued or finalized documents are immutable/i
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO document_assignments (
       document_id, relationship_role, commission_id
     ) VALUES ($1, 'commission', $2)`,
    [document.id, commissionId]
  ), /assignments for issued or finalized documents are immutable/i);
});

test("packet items enforce root type, order, uniqueness, no self-reference, and issuance locking", async () => {
  const root = await createDocument({ documentType: "contract" });
  const addendumA = await createDocument();
  const addendumB = await createDocument();
  const item = (await db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $2, 'addendum', 1) RETURNING id`,
    [root.id, addendumA.id]
  )).rows[0];

  await assert.rejects(db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $2, 'addendum', 2)`,
    [root.id, addendumA.id]
  ), (error) => error.code === "23505");
  await assert.rejects(db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $2, 'addendum', 1)`,
    [root.id, addendumB.id]
  ), (error) => error.code === "23505");
  await assert.rejects(db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $1, 'main', 3)`,
    [root.id]
  ), (error) => error.code === "23514");
  await assert.rejects(db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $2, 'addendum', 0)`,
    [root.id, addendumB.id]
  ), (error) => error.code === "23514");

  await db.pool.query("UPDATE documents SET issued_at = NOW() WHERE id = $1", [root.id]);
  await assert.rejects(
    db.pool.query("UPDATE document_packet_items SET position = 2 WHERE id = $1", [item.id]),
    /packet structure is immutable/i
  );
  await assert.rejects(
    db.pool.query("DELETE FROM document_packet_items WHERE id = $1", [item.id]),
    /packet structure is immutable/i
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO document_packet_items (
       root_contract_document_id, document_id, packet_role, position
     ) VALUES ($1, $2, 'addendum', 2)`,
    [root.id, addendumB.id]
  ), /packet structure is immutable/i);
});

test("Document asset identity is append-only and lifecycle metadata freezes at finalization", async () => {
  const document = await createDocument();
  const asset = (await db.pool.query(
    `INSERT INTO document_assets (
       document_id, asset_role, storage_key, mime_type,
       byte_size, sha256, scan_status
     ) VALUES ($1, 'rendered_pdf', 'documents/file.pdf',
       'application/pdf', 1000, $2, 'quarantined') RETURNING id`,
    [document.id, hashA]
  )).rows[0];
  await assert.rejects(
    db.pool.query("UPDATE document_assets SET storage_key = 'replacement.pdf' WHERE id = $1", [asset.id]),
    /identity metadata is append-only/i
  );
  await db.pool.query(
    "UPDATE document_assets SET scan_status = 'clean', available_at = NOW() WHERE id = $1",
    [asset.id]
  );
  await assert.rejects(
    db.pool.query("DELETE FROM document_assets WHERE id = $1", [asset.id]),
    /document asset metadata is append-only/i
  );
  await db.pool.query("UPDATE documents SET finalized_at = NOW() WHERE id = $1", [document.id]);
  await assert.rejects(
    db.pool.query("UPDATE document_assets SET scan_status = 'locked' WHERE id = $1", [asset.id]),
    /issued or finalized document/i
  );
  await assert.rejects(db.pool.query(
    `INSERT INTO document_assets (
       document_id, asset_role, storage_key, mime_type, byte_size, sha256
     ) VALUES ($1, 'replacement', 'documents/replacement.pdf',
       'application/pdf', 2000, $2)`,
    [document.id, hashB]
  ), /issued or finalized document/i);
});

test("existing Contract behavior, RBAC vocabulary, and locked terms remain unchanged", async () => {
  const contract = await createDocument({
    documentType: "contract",
    documentSnapshot: { contract: { status: "issued" } }
  });
  assert.equal(contract.document_origin, null);
  assert.equal(contract.legal_template_id, null);
  assert.equal(contract.issued_at, null);
  await assert.rejects(db.pool.query(
    "UPDATE documents SET document_snapshot = '{}'::jsonb WHERE id = $1",
    [contract.id]
  ), /issued contract identity and snapshot are immutable/i);

  await assert.rejects(db.pool.query(
    `INSERT INTO admin_users (
       identity_provider, external_subject, email, role, status
     ) VALUES ('google', 'lt1-editor', 'lt1-editor@example.invalid', 'legal_editor', 'active')`
  ), (error) => error.code === "23514");
  assert.equal(COMMISSION_AGREEMENT_TERMS.approved, false);
});

test("LT-1 applies as an upgrade without changing an existing Document row", async () => {
  const upgradeDatabase = new NetlifyDB({ logger: () => {} });
  const connectionString = await upgradeDatabase.start();
  const upgradeDb = getDatabase({ connectionString });

  try {
    const migrationFiles = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql") && name < migrationName)
      .sort();
    for (const filename of migrationFiles) {
      await upgradeDb.pool.query(
        await readFile(new URL(filename, migrationDirectory), "utf8")
      );
    }

    const existingClient = (await upgradeDb.pool.query(
      `INSERT INTO clients (full_name, email)
       VALUES ('Upgrade Client', 'upgrade@example.invalid') RETURNING id`
    )).rows[0];
    const existingCommission = (await upgradeDb.pool.query(
      `INSERT INTO commissions (
         commission_number, client_id, title, description, medium, price
       ) VALUES ('SAS-COM-2026-9998', $1, 'Existing', 'Before LT-1', 'Oil', 50)
       RETURNING id`,
      [existingClient.id]
    )).rows[0];
    const existingDocument = (await upgradeDb.pool.query(
      `INSERT INTO documents (
         commission_id, document_type, document_number, version, file_location
       ) VALUES ($1, 'coa', 'SAS-COA-2026-9998', 1, '/existing') RETURNING id`,
      [existingCommission.id]
    )).rows[0];

    await upgradeDb.pool.query(
      await readFile(new URL(migrationName, migrationDirectory), "utf8")
    );
    const upgraded = (await upgradeDb.pool.query(
      `SELECT id, document_number, document_snapshot, legal_template_id,
              legal_template_version_id, document_origin, snapshot_hash,
              issued_by_admin_user_id, issued_at, finalized_at
       FROM documents WHERE id = $1`,
      [existingDocument.id]
    )).rows[0];
    assert.equal(upgraded.document_number, "SAS-COA-2026-9998");
    for (const column of [
      "document_snapshot", "legal_template_id", "legal_template_version_id",
      "document_origin", "snapshot_hash", "issued_by_admin_user_id",
      "issued_at", "finalized_at"
    ]) assert.equal(upgraded[column], null, column);
  } finally {
    await upgradeDb.pool.end();
    await upgradeDatabase.stop();
  }
});
