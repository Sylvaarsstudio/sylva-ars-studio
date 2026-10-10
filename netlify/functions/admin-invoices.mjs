import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH_PATTERN = /^\/admin\/api\/documents\/invoices\/([^/]+)\/?$/;
const invoiceIdPattern = /^[1-9][0-9]*$/;

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

function getInvoiceId(pathname) {
  const match = pathname.match(API_PATH_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

async function getInvoice(db, invoiceId) {
  const result = await db.pool.query(
    `SELECT id, document_number, version, created_at, document_snapshot
     FROM documents
     WHERE id = $1
       AND document_type = 'invoice'`,
    [invoiceId]
  );

  return result.rows[0] || null;
}

function logFailure(error, invoiceId) {
  console.error("Admin invoice request failed.", {
    invoice_id: invoiceId,
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

    const invoiceId = getInvoiceId(new URL(request.url).pathname);

    if (invoiceId === null) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (invoiceId === undefined || !invoiceIdPattern.test(invoiceId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid invoice id."
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET."
      });
    }

    try {
      const invoice = await getInvoice(databaseFactory(), invoiceId);

      if (!invoice) {
        return jsonResponse(404, {
          success: false,
          message: "Invoice not found."
        });
      }

      return jsonResponse(200, {
        success: true,
        invoice: {
          id: invoice.id,
          document_number: invoice.document_number,
          version: invoice.version,
          created_at: invoice.created_at,
          snapshot: invoice.document_snapshot
        }
      });
    } catch (error) {
      logFailure(error, invoiceId);
      return jsonResponse(500, {
        success: false,
        message: "Unable to load invoice."
      });
    }
  };
}

export const config = {
  path: "/admin/api/documents/invoices/:id"
};

export { createHandler, getInvoice, getInvoiceId };

export default createHandler();
