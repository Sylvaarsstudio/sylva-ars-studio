import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH_PATTERN = /^\/admin\/api\/receipts\/([^/]+)\/?$/;
const receiptIdPattern = /^[1-9][0-9]*$/;

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

function getReceiptId(pathname) {
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

async function getReceipt(db, receiptId) {
  const result = await db.pool.query(
    `SELECT id, document_number, version, created_at, receipt_snapshot
     FROM documents
     WHERE id = $1
       AND document_type = 'receipt'`,
    [receiptId]
  );

  return result.rows[0] || null;
}

function logFailure(error, receiptId) {
  console.error("Admin receipt request failed.", {
    receipt_id: receiptId,
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

    const receiptId = getReceiptId(new URL(request.url).pathname);

    if (receiptId === null) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (receiptId === undefined || !receiptIdPattern.test(receiptId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid receipt id."
      });
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET."
      });
    }

    try {
      const receipt = await getReceipt(databaseFactory(), receiptId);

      if (!receipt) {
        return jsonResponse(404, {
          success: false,
          message: "Receipt not found."
        });
      }

      return jsonResponse(200, {
        success: true,
        receipt: {
          id: receipt.id,
          document_number: receipt.document_number,
          version: receipt.version,
          created_at: receipt.created_at,
          snapshot: receipt.receipt_snapshot
        }
      });
    } catch (error) {
      logFailure(error, receiptId);
      return jsonResponse(500, {
        success: false,
        message: "Unable to load receipt."
      });
    }
  };
}

export const config = {
  path: "/admin/api/receipts/:id"
};

export { createHandler, getReceipt, getReceiptId };

export default createHandler();
