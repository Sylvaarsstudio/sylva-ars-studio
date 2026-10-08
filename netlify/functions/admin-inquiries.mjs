import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/inquiries";
const allowedStatuses = new Set([
  "new",
  "reviewing",
  "replied",
  "accepted",
  "declined",
  "closed"
]);
const allowedFormTypes = new Set([
  "contact",
  "artwork_inquiry",
  "commission_request",
  "collaboration"
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeFilter(value) {
  return value && value !== "all" ? value : null;
}

function getInquiryId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (normalizedPath === API_PATH) {
    return null;
  }

  if (!normalizedPath.startsWith(`${API_PATH}/`)) {
    return undefined;
  }

  const encodedId = normalizedPath.slice(API_PATH.length + 1);

  if (!encodedId || encodedId.includes("/")) {
    return undefined;
  }

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return undefined;
  }
}

async function listInquiries(db, filters = {}) {
  const status = normalizeFilter(filters.status);
  const formType = normalizeFilter(filters.formType);
  const result = await db.pool.query(
    `SELECT id, created_at, form_type, client_name, client_email, status
     FROM inquiries
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR form_type = $2)
     ORDER BY created_at DESC`,
    [status, formType]
  );

  return result.rows;
}

async function getInquiry(db, id) {
  const result = await db.pool.query(
    `SELECT
       id,
       form_type,
       client_name,
       client_email,
       client_phone,
       artwork_title,
       artwork_subject,
       artwork_size,
       budget_range,
       estimated_date,
       occasion,
       shipping_location,
       preferred_contact_method,
       reference_notes,
       organization_project,
       collaboration_type,
       message,
       status,
       created_at,
       updated_at
     FROM inquiries
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

async function updateInquiryStatus(db, id, status) {
  const result = await db.pool.query(
    `UPDATE inquiries
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, status, updated_at`,
    [status, id]
  );

  return result.rows[0] || null;
}

function logFailure(action, error, details = {}) {
  console.error("Admin inquiry request failed.", {
    action,
    ...details,
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
      logFailure("authenticate", new Error("Missing admin configuration."));
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
    const inquiryId = getInquiryId(url.pathname);

    if (inquiryId === undefined) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (inquiryId === null) {
      if (request.method !== "GET") {
        return jsonResponse(405, {
          success: false,
          message: "Method not allowed. Use GET."
        });
      }

      const status = normalizeFilter(url.searchParams.get("status"));
      const formType = normalizeFilter(url.searchParams.get("form_type"));

      if (status && !allowedStatuses.has(status)) {
        return jsonResponse(400, {
          success: false,
          message: "Unsupported status filter."
        });
      }

      if (formType && !allowedFormTypes.has(formType)) {
        return jsonResponse(400, {
          success: false,
          message: "Unsupported form_type filter."
        });
      }

      try {
        const inquiries = await listInquiries(databaseFactory(), {
          status,
          formType
        });

        return jsonResponse(200, {
          success: true,
          total: inquiries.length,
          inquiries
        });
      } catch (error) {
        logFailure("list", error, { status, form_type: formType });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load inquiries."
        });
      }
    }

    if (!uuidPattern.test(inquiryId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid inquiry id."
      });
    }

    if (request.method === "GET") {
      try {
        const inquiry = await getInquiry(databaseFactory(), inquiryId);

        if (!inquiry) {
          return jsonResponse(404, {
            success: false,
            message: "Inquiry not found."
          });
        }

        return jsonResponse(200, {
          success: true,
          inquiry
        });
      } catch (error) {
        logFailure("detail", error, { inquiry_id: inquiryId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load the inquiry."
        });
      }
    }

    if (request.method === "PATCH") {
      const body = await parseJsonBody(request);
      const keys = body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body)
        : [];

      if (keys.length !== 1 || keys[0] !== "status") {
        return jsonResponse(400, {
          success: false,
          message: "Request body must contain only status."
        });
      }

      if (!allowedStatuses.has(body.status)) {
        return jsonResponse(400, {
          success: false,
          message: "Unsupported status."
        });
      }

      try {
        const inquiry = await updateInquiryStatus(
          databaseFactory(),
          inquiryId,
          body.status
        );

        if (!inquiry) {
          return jsonResponse(404, {
            success: false,
            message: "Inquiry not found."
          });
        }

        return jsonResponse(200, {
          success: true,
          inquiry
        });
      } catch (error) {
        logFailure("update_status", error, {
          inquiry_id: inquiryId,
          status: body.status
        });
        return jsonResponse(500, {
          success: false,
          message: "Unable to update inquiry status."
        });
      }
    }

    return jsonResponse(405, {
      success: false,
      message: "Method not allowed. Use GET or PATCH."
    });
  };
}

export const config = {
  path: ["/admin/api/inquiries", "/admin/api/inquiries/:id"]
};

export {
  allowedFormTypes,
  allowedStatuses,
  createHandler,
  getInquiry,
  listInquiries,
  updateInquiryStatus
};

export default createHandler();
