import { getDatabase } from "@netlify/database";

import { authorizeAdminRequest } from "../shared/admin-authorization.mjs";
import { COMMISSION_AGREEMENT_TERMS } from "../shared/contract-terms.mjs";
import { OPERATIONAL_LEGACY_SOURCES } from "../shared/legal-template-legacy-inventory.mjs";

const API_PATH = "/admin/api/legal-templates";
const positiveIntegerPattern = /^[1-9][0-9]*$/;

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  return process.env[name];
}

function parseRoute(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === API_PATH) return { kind: "list" };
  if (normalizedPath === `${API_PATH}/inventory`) return { kind: "inventory" };

  const historyMatch = normalizedPath.match(/^\/admin\/api\/legal-templates\/([^/]+)\/history$/);
  if (historyMatch) {
    return positiveIntegerPattern.test(historyMatch[1])
      ? { kind: "history", templateId: historyMatch[1] }
      : { kind: "invalid_id" };
  }
  const detailMatch = normalizedPath.match(/^\/admin\/api\/legal-templates\/([^/]+)$/);
  if (detailMatch) {
    return positiveIntegerPattern.test(detailMatch[1])
      ? { kind: "detail", templateId: detailMatch[1] }
      : { kind: "invalid_id" };
  }
  return { kind: "not_found" };
}

function warningsForTemplate(row) {
  const warnings = [];
  if (!row.effective_version) warnings.push("No Effective Version");
  if (row.source_conflict) warnings.push("Source Conflict");
  if (row.template_key === "commission-agreement" && !COMMISSION_AGREEMENT_TERMS.approved) {
    warnings.push("Contract Issuance Locked");
  }
  return warnings;
}

function mapTemplateSummary(row) {
  return {
    id: row.id,
    template_key: row.template_key,
    name: row.name,
    template_kind: row.template_kind,
    description: row.description,
    lifecycle_status: row.lifecycle_status,
    created_at: row.created_at,
    version_count: row.version_count,
    approved_version_count: row.approved_version_count,
    effective_version: row.effective_version,
    latest_draft: row.latest_draft,
    publication_state: row.publication_state,
    source_conflict: row.source_conflict,
    warnings: warningsForTemplate(row),
    contract_issuance_locked:
      row.template_key === "commission-agreement" && !COMMISSION_AGREEMENT_TERMS.approved
  };
}

async function listLegalTemplates(db, { templateId = null } = {}) {
  const values = templateId === null ? [] : [templateId];
  const whereClause = templateId === null ? "" : "WHERE t.id = $1";
  const result = await db.pool.query(
    `SELECT
       t.id,
       t.template_key,
       t.name,
       t.template_kind,
       t.description,
       t.lifecycle_status,
       t.created_at,
       (SELECT count(*)::integer
        FROM legal_template_versions v
        WHERE v.template_id = t.id) AS version_count,
       (SELECT count(*)::integer
        FROM legal_template_versions v
        WHERE v.template_id = t.id AND v.state IN ('approved', 'effective', 'superseded', 'revoked'))
         AS approved_version_count,
       (SELECT jsonb_build_object(
          'id', v.id,
          'version_number', v.version_number,
          'version_label', v.version_label,
          'state', v.state,
          'content_hash', v.content_hash
        )
        FROM legal_template_versions v
        WHERE v.template_id = t.id AND v.state = 'effective'
        ORDER BY v.version_number DESC LIMIT 1) AS effective_version,
       (SELECT jsonb_build_object(
          'id', v.id,
          'version_number', v.version_number,
          'version_label', v.version_label,
          'state', v.state,
          'content_hash', v.content_hash,
          'source_role', v.structured_content -> 'source' ->> 'role'
        )
        FROM legal_template_versions v
        WHERE v.template_id = t.id AND v.state = 'draft'
        ORDER BY v.version_number DESC LIMIT 1) AS latest_draft,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM legal_template_publications p
           JOIN legal_template_versions pv ON pv.id = p.template_version_id
           WHERE pv.template_id = t.id AND p.unpublished_at IS NULL
         ) THEN 'published'
         WHEN EXISTS (
           SELECT 1 FROM legal_template_publications p
           JOIN legal_template_versions pv ON pv.id = p.template_version_id
           WHERE pv.template_id = t.id
         ) THEN 'unpublished'
         ELSE 'not_published'
       END AS publication_state,
       EXISTS (
         SELECT 1 FROM legal_template_versions v
         WHERE v.template_id = t.id
           AND v.structured_content -> 'comparison' ->> 'equivalence_status' = 'not_established'
       ) AS source_conflict
     FROM legal_templates t
     ${whereClause}
     ORDER BY t.name, t.id`,
    values
  );
  return result.rows.map(mapTemplateSummary);
}

async function getVersionHistory(db, templateId) {
  const result = await db.pool.query(
    `SELECT
       v.id,
       v.version_number,
       v.version_label,
       v.state,
       v.draft_revision,
       v.content_hash,
       v.review_source,
       v.legal_review_notes,
       v.created_at,
       v.approved_at,
       v.effective_at,
       v.structured_content -> 'source' ->> 'identity' AS source_identity,
       v.structured_content -> 'source' ->> 'label' AS source_label,
       v.structured_content -> 'source' ->> 'type' AS source_type,
       v.structured_content -> 'source' ->> 'path' AS source_path,
       v.structured_content -> 'source' ->> 'role' AS source_role,
       v.structured_content -> 'source' ->> 'current_usage' AS current_usage,
       v.structured_content -> 'structural_summary' AS structural_summary,
       v.structured_content -> 'comparison' AS comparison
     FROM legal_template_versions v
     WHERE v.template_id = $1
     ORDER BY v.version_number DESC, v.id DESC`,
    [templateId]
  );
  return result.rows;
}

async function getAuditHistory(db, templateId) {
  const result = await db.pool.query(
    `SELECT
       e.id,
       e.event_type,
       e.actor_role_snapshot,
       e.occurred_at,
       e.template_version_id,
       e.new_state,
       e.event_context,
       e.content_hash,
       e.reason
     FROM legal_audit_events e
     WHERE e.template_id = $1
     ORDER BY e.occurred_at DESC, e.id DESC`,
    [templateId]
  );
  return result.rows;
}

async function getDocumentProvenance(db, templateId, templateKey) {
  const relatedResult = await db.pool.query(
    `SELECT d.id, d.document_number, d.document_type, d.version, d.created_at,
            d.file_location, d.legal_template_version_id,
            'template_provenance_proven'::text AS provenance_status
     FROM documents d
     WHERE d.legal_template_id = $1
     ORDER BY d.created_at DESC, d.id DESC`,
    [templateId]
  );
  const subtype = templateKey.replaceAll("-", "_");
  const unmappedResult = await db.pool.query(
    `SELECT d.id, d.document_number, d.document_type, d.version, d.created_at,
            d.file_location, 'legacy_unmapped'::text AS provenance_status
     FROM documents d
     WHERE d.legal_template_id IS NULL
       AND d.legal_template_version_id IS NULL
       AND d.document_origin IS NULL
       AND d.document_type = 'contract'
       AND d.document_snapshot -> 'contract' ->> 'subtype' = $1
     ORDER BY d.created_at DESC, d.id DESC`,
    [subtype]
  );
  return {
    related_documents: relatedResult.rows,
    legacy_unmapped_documents: unmappedResult.rows
  };
}

async function getTemplateDetail(db, templateId) {
  const templates = await listLegalTemplates(db, { templateId });
  if (!templates[0]) return null;
  const template = templates[0];
  const [versions, auditEvents, provenance, publications] = await Promise.all([
    getVersionHistory(db, templateId),
    getAuditHistory(db, templateId),
    getDocumentProvenance(db, templateId, template.template_key),
    db.pool.query(
      `SELECT p.id, p.template_version_id, p.public_slug, p.publication_mode,
              p.published_at, p.unpublished_at
       FROM legal_template_publications p
       JOIN legal_template_versions v ON v.id = p.template_version_id
       WHERE v.template_id = $1
       ORDER BY p.published_at DESC, p.id DESC`,
      [templateId]
    )
  ]);
  return {
    ...template,
    versions,
    audit_events: auditEvents,
    publications: publications.rows,
    ...provenance
  };
}

function logFailure(operation, error) {
  console.error("Admin Legal Templates request failed.", {
    operation,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable
} = {}) {
  return async function handler(request) {
    const authorization = await authorizeAdminRequest(request, { databaseFactory, environmentReader });
    if (!authorization.ok) return authorization.response;

    const route = parseRoute(new URL(request.url).pathname);
    if (route.kind === "not_found") {
      return jsonResponse(404, { success: false, message: "Admin endpoint not found." });
    }
    if (route.kind === "invalid_id") {
      return jsonResponse(400, { success: false, message: "Invalid Legal Template id." });
    }
    if (request.method !== "GET") {
      return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
    }

    try {
      const db = databaseFactory();
      if (route.kind === "list") {
        const templates = await listLegalTemplates(db);
        return jsonResponse(200, { success: true, total: templates.length, templates });
      }
      if (route.kind === "inventory") {
        return jsonResponse(200, {
          success: true,
          governance_status: "not_governed",
          sources: OPERATIONAL_LEGACY_SOURCES
        });
      }
      if (route.kind === "history") {
        const templates = await listLegalTemplates(db, { templateId: route.templateId });
        if (!templates[0]) {
          return jsonResponse(404, { success: false, message: "Legal Template not found." });
        }
        const [versions, auditEvents] = await Promise.all([
          getVersionHistory(db, route.templateId),
          getAuditHistory(db, route.templateId)
        ]);
        return jsonResponse(200, {
          success: true,
          template: templates[0],
          versions,
          audit_events: auditEvents
        });
      }

      const template = await getTemplateDetail(db, route.templateId);
      if (!template) {
        return jsonResponse(404, { success: false, message: "Legal Template not found." });
      }
      return jsonResponse(200, { success: true, template });
    } catch (error) {
      logFailure(route.kind, error);
      return jsonResponse(500, {
        success: false,
        message: "Unable to load Legal Templates."
      });
    }
  };
}

export const config = {
  path: [
    "/admin/api/legal-templates",
    "/admin/api/legal-templates/inventory",
    "/admin/api/legal-templates/:id",
    "/admin/api/legal-templates/:id/history"
  ]
};

export {
  API_PATH,
  createHandler,
  getAuditHistory,
  getDocumentProvenance,
  getTemplateDetail,
  getVersionHistory,
  listLegalTemplates,
  mapTemplateSummary,
  parseRoute,
  warningsForTemplate
};

export default createHandler();
