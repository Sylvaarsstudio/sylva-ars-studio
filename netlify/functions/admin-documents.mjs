import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/documents";
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const allowedDocumentTypes = new Set(["contract", "invoice", "coa", "receipt"]);

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name);
  }

  return process.env[name];
}

function normalizeFilters(searchParams) {
  const commissionId = searchParams.get("commission_id");
  const documentType = searchParams.get("document_type");

  if (commissionId !== null && !positiveIntegerPattern.test(commissionId)) {
    return { error: "Invalid commission id." };
  }

  if (documentType !== null && !allowedDocumentTypes.has(documentType)) {
    return { error: "Invalid document type." };
  }

  return {
    filters: {
      commissionId,
      documentType
    }
  };
}

async function listDocuments(db, { commissionId = null, documentType = null } = {}) {
  const conditions = [];
  const values = [];

  if (commissionId !== null) {
    values.push(commissionId);
    conditions.push(`d.commission_id = $${values.length}`);
  }

  if (documentType !== null) {
    values.push(documentType);
    conditions.push(`d.document_type = $${values.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.pool.query(
    `SELECT
       d.id,
       d.document_number,
       d.document_type,
       d.version,
       d.created_at,
       d.file_location,
       c.id AS commission_id,
       c.commission_number,
       c.title AS commission_title,
       cl.id AS client_id,
       cl.full_name AS client_full_name,
       p.id AS payment_id,
       p.payment_type,
       p.payment_date
     FROM documents d
     JOIN commissions c ON c.id = d.commission_id
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN payments p ON p.id = d.payment_id
     ${whereClause}
     ORDER BY d.created_at DESC, d.id DESC`,
    values
  );

  return result.rows.map((row) => ({
    id: row.id,
    document_number: row.document_number,
    document_type: row.document_type,
    version: row.version,
    created_at: row.created_at,
    file_location: row.file_location,
    commission: {
      id: row.commission_id,
      commission_number: row.commission_number,
      title: row.commission_title
    },
    client: {
      id: row.client_id,
      full_name: row.client_full_name
    },
    payment: row.payment_id === null ? null : {
      id: row.payment_id,
      payment_type: row.payment_type,
      payment_date: row.payment_date
    }
  }));
}

function logFailure(error) {
  console.error("Admin documents request failed.", {
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable
} = {}) {
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;

    if (!adminPassword) {
      return jsonResponse(500, {
        success: false,
        message: "Admin authentication is not configured."
      });
    }

    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, {
        success: false,
        message: "Unauthorized."
      });
    }

    const url = new URL(request.url);
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";

    if (normalizedPath !== API_PATH) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET."
      });
    }

    const normalized = normalizeFilters(url.searchParams);

    if (normalized.error) {
      return jsonResponse(400, {
        success: false,
        message: normalized.error
      });
    }

    try {
      const documents = await listDocuments(databaseFactory(), normalized.filters);

      return jsonResponse(200, {
        success: true,
        total: documents.length,
        documents
      });
    } catch (error) {
      logFailure(error);
      return jsonResponse(500, {
        success: false,
        message: "Unable to load documents."
      });
    }
  };
}

export const config = {
  path: "/admin/api/documents"
};

export { createHandler, listDocuments, normalizeFilters };

export default createHandler();
