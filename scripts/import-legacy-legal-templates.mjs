import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDatabase } from "@netlify/database";

import { COMMISSION_AGREEMENT_TERMS } from "../netlify/shared/contract-terms.mjs";
import {
  LEGACY_TEMPLATE_FAMILIES
} from "../netlify/shared/legal-template-legacy-inventory.mjs";

const IMPORT_KEY = "lt2-legacy-inventory-v1";
const IMPORT_LOCK_KEY = "sylva-ars-lt2-legacy-inventory-v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length || 0;
}

function summarizeHtml(value) {
  const dataFields = Array.from(
    value.matchAll(/\bdata-field=["']([^"']+)["']/gi),
    (match) => match[1]
  );
  return {
    section_count: countMatches(value, /<section\b/gi),
    heading_count: countMatches(value, /<h[1-6]\b/gi),
    data_field_count: dataFields.length,
    data_fields: [...new Set(dataFields)].sort()
  };
}

function summarizeTerms(terms) {
  const sectionKeys = Object.keys(terms.sections || {});
  return {
    section_count: sectionKeys.length,
    section_keys: sectionKeys,
    declared_status: terms.status || null,
    declared_version: terms.version || null,
    declared_approved: terms.approved === true
  };
}

async function loadLegacyTemplateFamilies(projectRoot = process.cwd()) {
  const families = [];

  for (const family of LEGACY_TEMPLATE_FAMILIES) {
    const sources = [];
    for (const source of family.sources) {
      const sourceContent = await readFile(path.join(projectRoot, source.sourcePath), "utf8");
      const actualHash = sha256(sourceContent);
      if (actualHash !== source.sourceHash) {
        throw new Error(
          `Legacy source hash mismatch for ${source.sourcePath}: expected ${source.sourceHash}, received ${actualHash}.`
        );
      }

      const content = source.contentFormat === "structured_terms"
        ? { format: source.contentFormat, value: structuredClone(COMMISSION_AGREEMENT_TERMS) }
        : { format: source.contentFormat, raw: sourceContent };
      const structuralSummary = source.contentFormat === "structured_terms"
        ? summarizeTerms(COMMISSION_AGREEMENT_TERMS)
        : summarizeHtml(sourceContent);

      sources.push({
        ...source,
        structuredContent: {
          lt2_inventory_schema_version: 1,
          source: {
            identity: source.sourceIdentity,
            label: source.sourceLabel,
            type: source.sourceType,
            path: source.sourcePath,
            role: source.sourceRole,
            current_usage: source.currentUsage,
            hash_algorithm: "sha256",
            sha256: source.sourceHash
          },
          structural_summary: structuralSummary,
          comparison: family.comparison,
          content
        }
      });
    }

    families.push({ ...family, sources });
  }

  return families;
}

async function resolveImportActor(db, requestedExternalSubject = null) {
  const values = [];
  const subjectClause = requestedExternalSubject
    ? `AND external_subject = $${values.push(requestedExternalSubject)}`
    : "";
  const result = await db.pool.query(
    `SELECT id, external_subject, role
     FROM admin_users
     WHERE status = 'active'
       AND role = 'owner_admin'
       ${subjectClause}
     ORDER BY id`,
    values
  );

  if (result.rows.length !== 1) {
    const qualifier = requestedExternalSubject
      ? ` with external subject ${requestedExternalSubject}`
      : "";
    throw new Error(
      `LT-2 import requires exactly one active Owner Admin${qualifier}; found ${result.rows.length}.`
    );
  }

  return result.rows[0];
}

async function ensureAuditEvent(client, {
  actorAdminUserId,
  eventType,
  templateId,
  templateVersionId = null,
  contentHash = null,
  eventContext,
  reason
}) {
  const existing = await client.query(
    `SELECT id
     FROM legal_audit_events
     WHERE event_type = $1
       AND template_id = $2
       AND template_version_id IS NOT DISTINCT FROM $3::bigint
       AND content_hash IS NOT DISTINCT FROM $4
       AND event_context ->> 'import_key' = $5
     LIMIT 1`,
    [eventType, templateId, templateVersionId, contentHash, IMPORT_KEY]
  );
  if (existing.rowCount > 0) return false;

  await client.query(
    `INSERT INTO legal_audit_events (
       event_type, actor_admin_user_id, actor_role_snapshot,
       template_id, template_version_id, previous_state, new_state,
       event_context, content_hash, reason
     ) VALUES (
       $1, $2, 'owner_admin', $3, $4, NULL, $5::jsonb, $6::jsonb, $7, $8
     )`,
    [
      eventType,
      actorAdminUserId,
      templateId,
      templateVersionId,
      JSON.stringify(templateVersionId ? { state: "draft" } : { lifecycle_status: "active" }),
      JSON.stringify({
        import_key: IMPORT_KEY,
        system_operation: true,
        ...eventContext
      }),
      contentHash,
      reason
    ]
  );
  return true;
}

function assertTemplateMatches(row, family) {
  if (
    row.name !== family.name
    || row.template_kind !== family.templateKind
    || row.lifecycle_status !== "active"
  ) {
    throw new Error(`Existing Legal Template ${family.templateKey} does not match the LT-2 inventory definition.`);
  }
}

function assertVersionMatches(row, source) {
  const sourceIdentity = row.structured_content?.source?.identity;
  if (
    row.state !== "draft"
    || row.content_hash !== source.sourceHash
    || sourceIdentity !== source.sourceIdentity
  ) {
    throw new Error(
      `Existing ${source.sourceIdentity} version conflicts with the deterministic LT-2 inventory definition.`
    );
  }
}

async function importLegacyTemplates(db, {
  actorAdminUserId,
  projectRoot = process.cwd()
}) {
  if (!actorAdminUserId) throw new Error("actorAdminUserId is required for the LT-2 import.");
  const families = await loadLegacyTemplateFamilies(projectRoot);
  const client = await db.pool.connect();
  const summary = {
    templates_created: 0,
    versions_created: 0,
    audit_events_created: 0,
    templates_total: 0,
    versions_total: 0
  };

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [IMPORT_LOCK_KEY]);
    const actor = await client.query(
      `SELECT id FROM admin_users
       WHERE id = $1 AND role = 'owner_admin' AND status = 'active'`,
      [actorAdminUserId]
    );
    if (actor.rowCount !== 1) {
      throw new Error("LT-2 import actor must be an active Owner Admin.");
    }

    for (const family of families) {
      let template = (await client.query(
        `SELECT id, name, template_kind, lifecycle_status
         FROM legal_templates WHERE template_key = $1`,
        [family.templateKey]
      )).rows[0];

      if (!template) {
        template = (await client.query(
          `INSERT INTO legal_templates (
             template_key, name, template_kind, description, created_by_admin_user_id
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, template_kind, lifecycle_status`,
          [
            family.templateKey,
            family.name,
            family.templateKind,
            family.description,
            actorAdminUserId
          ]
        )).rows[0];
        summary.templates_created += 1;
      }
      assertTemplateMatches(template, family);
      summary.templates_total += 1;

      if (await ensureAuditEvent(client, {
        actorAdminUserId,
        eventType: "template_created_from_legacy",
        templateId: template.id,
        eventContext: { template_key: family.templateKey },
        reason: "LT-2 deterministic legacy inventory import."
      })) summary.audit_events_created += 1;

      for (const source of family.sources) {
        const identityRows = await client.query(
          `SELECT id, version_number, state, content_hash, structured_content
           FROM legal_template_versions
           WHERE template_id = $1
             AND structured_content -> 'source' ->> 'identity' = $2`,
          [template.id, source.sourceIdentity]
        );
        if (identityRows.rowCount > 1) {
          throw new Error(`Duplicate legacy source identity found: ${source.sourceIdentity}.`);
        }

        let version = identityRows.rows[0];
        if (version && version.version_number !== source.versionNumber) {
          throw new Error(`Legacy source identity ${source.sourceIdentity} has an unexpected version number.`);
        }
        if (!version) {
          version = (await client.query(
            `SELECT id, version_number, state, content_hash, structured_content
             FROM legal_template_versions
             WHERE template_id = $1 AND version_number = $2`,
            [template.id, source.versionNumber]
          )).rows[0];
        }

        if (!version) {
          version = (await client.query(
            `INSERT INTO legal_template_versions (
               template_id, version_number, state, content_schema_version,
               structured_content, variable_manifest, content_hash,
               version_label, review_source, legal_review_notes,
               created_by_admin_user_id
             ) VALUES (
               $1, $2, 'draft', 1, $3::jsonb, '{"variables":[]}'::jsonb,
               $4, $5, $6, $7, $8
             )
             RETURNING id, version_number, state, content_hash, structured_content`,
            [
              template.id,
              source.versionNumber,
              JSON.stringify(source.structuredContent),
              source.sourceHash,
              source.versionLabel,
              `legacy_import:${source.sourcePath}`,
              source.reviewNotes,
              actorAdminUserId
            ]
          )).rows[0];
          summary.versions_created += 1;
        }
        assertVersionMatches(version, source);
        summary.versions_total += 1;

        const eventContext = {
          template_key: family.templateKey,
          source_identity: source.sourceIdentity,
          source_path: source.sourcePath,
          source_type: source.sourceType,
          source_role: source.sourceRole,
          equivalence_status: family.comparison.equivalence_status
        };
        if (await ensureAuditEvent(client, {
          actorAdminUserId,
          eventType: "version_imported_from_legacy",
          templateId: template.id,
          templateVersionId: version.id,
          contentHash: source.sourceHash,
          eventContext,
          reason: "Draft legacy source imported for read-only LT-2 inventory."
        })) summary.audit_events_created += 1;
        if (await ensureAuditEvent(client, {
          actorAdminUserId,
          eventType: "legacy_source_hash_recorded",
          templateId: template.id,
          templateVersionId: version.id,
          contentHash: source.sourceHash,
          eventContext,
          reason: "SHA-256 recorded for deterministic LT-2 source provenance."
        })) summary.audit_events_created += 1;
      }
    }

    await client.query("COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  const db = getDatabase();
  try {
    const actor = await resolveImportActor(db, process.env.LT2_IMPORT_ACTOR_SUBJECT || null);
    const result = await importLegacyTemplates(db, {
      actorAdminUserId: actor.id,
      projectRoot: process.cwd()
    });
    console.log(JSON.stringify({ success: true, actor_subject: actor.external_subject, ...result }, null, 2));
  } finally {
    await db.pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export {
  IMPORT_KEY,
  importLegacyTemplates,
  loadLegacyTemplateFamilies,
  resolveImportActor,
  sha256,
  summarizeHtml,
  summarizeTerms
};
