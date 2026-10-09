import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/inquiries";
const CONVERT_CLIENT_ACTION = "convert-client";
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

function getInquiryRoute(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (normalizedPath === API_PATH) {
    return { action: null, id: null };
  }

  if (!normalizedPath.startsWith(`${API_PATH}/`)) {
    return undefined;
  }

  const pathParts = normalizedPath.slice(API_PATH.length + 1).split("/");

  if (
    !pathParts[0]
    || pathParts.length > 2
    || (pathParts.length === 2 && pathParts[1] !== CONVERT_CLIENT_ACTION)
  ) {
    return undefined;
  }

  try {
    return {
      action: pathParts[1] || null,
      id: decodeURIComponent(pathParts[0])
    };
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

async function convertInquiryToClient(db, id) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    const inquiryResult = await connection.query(
      `SELECT id, status, client_name, client_email, client_phone
       FROM inquiries
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const inquiry = inquiryResult.rows[0];

    if (!inquiry) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    if (inquiry.status !== "accepted") {
      await connection.query("ROLLBACK");
      return { outcome: "not_accepted" };
    }

    const existingResult = await connection.query(
      `SELECT id
       FROM clients
       WHERE lower(btrim(email)) = lower(btrim($1))
       LIMIT 1`,
      [inquiry.client_email]
    );
    const existingClient = existingResult.rows[0];

    if (existingClient) {
      await connection.query("COMMIT");
      return {
        clientId: existingClient.id,
        created: false,
        outcome: "success"
      };
    }

    const insertedResult = await connection.query(
      `INSERT INTO clients (full_name, email, phone)
       VALUES (btrim($1), btrim($2), NULLIF(btrim($3), ''))
       ON CONFLICT (lower(email)) DO NOTHING
       RETURNING id`,
      [inquiry.client_name, inquiry.client_email, inquiry.client_phone]
    );
    let client = insertedResult.rows[0];
    let created = Boolean(client);

    if (!client) {
      const concurrentResult = await connection.query(
        `SELECT id
         FROM clients
         WHERE lower(btrim(email)) = lower(btrim($1))
         LIMIT 1`,
        [inquiry.client_email]
      );
      client = concurrentResult.rows[0];
      created = false;
    }

    if (!client) {
      throw new Error("Client conversion did not return a client id.");
    }

    await connection.query("COMMIT");
    return {
      clientId: client.id,
      created,
      outcome: "success"
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
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
    const inquiryRoute = getInquiryRoute(url.pathname);

    if (inquiryRoute === undefined) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    const { action, id: inquiryId } = inquiryRoute;

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

    if (action === CONVERT_CLIENT_ACTION) {
      if (request.method !== "POST") {
        return jsonResponse(405, {
          success: false,
          message: "Method not allowed. Use POST."
        });
      }

      try {
        const result = await convertInquiryToClient(databaseFactory(), inquiryId);

        if (result.outcome === "not_found") {
          return jsonResponse(404, {
            success: false,
            message: "Inquiry not found."
          });
        }

        if (result.outcome === "not_accepted") {
          return jsonResponse(400, {
            success: false,
            message: "Only accepted inquiries can be converted to clients."
          });
        }

        return jsonResponse(200, {
          success: true,
          inquiry_id: inquiryId,
          client_id: result.clientId,
          created: result.created
        });
      } catch (error) {
        logFailure("convert_client", error, { inquiry_id: inquiryId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to convert inquiry to client."
        });
      }
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
  path: [
    "/admin/api/inquiries",
    "/admin/api/inquiries/:id",
    "/admin/api/inquiries/:id/convert-client"
  ]
};

export {
  allowedFormTypes,
  allowedStatuses,
  convertInquiryToClient,
  createHandler,
  getInquiry,
  listInquiries,
  updateInquiryStatus
};

export default createHandler();
