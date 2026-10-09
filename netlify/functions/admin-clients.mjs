import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/clients";
const clientIdPattern = /^[1-9][0-9]*$/;
const editableFields = [
  "full_name",
  "email",
  "phone",
  "address_line_1",
  "address_line_2",
  "city",
  "state",
  "postal_code",
  "country"
];
const optionalFields = editableFields.slice(2);

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

function getClientId(pathname) {
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

async function listClients(db) {
  const result = await db.pool.query(
    `SELECT id, full_name, email, phone, created_at
     FROM clients
     ORDER BY created_at DESC`
  );

  return result.rows;
}

async function getClient(db, id) {
  const result = await db.pool.query(
    `SELECT
       id,
       full_name,
       email,
       phone,
       address_line_1,
       address_line_2,
       city,
       state,
       postal_code,
       country,
       created_at
     FROM clients
     WHERE id = $1`,
    [id]
  );

  return result.rows[0] || null;
}

function normalizeClientUpdate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  if (Object.keys(data).some((field) => !editableFields.includes(field))) {
    return { error: "Request body contains unsupported fields." };
  }

  if (typeof data.full_name !== "string" || !data.full_name.trim()) {
    return { error: "Full name is required." };
  }

  if (typeof data.email !== "string" || !data.email.trim()) {
    return { error: "Email is required." };
  }

  const client = {
    full_name: data.full_name.trim(),
    email: data.email.trim()
  };

  for (const field of optionalFields) {
    const value = data[field];

    if (value !== null && value !== undefined && typeof value !== "string") {
      return { error: `${field} must be text or null.` };
    }

    client[field] = value === null || value === undefined
      ? null
      : value.trim() || null;
  }

  return { client };
}

async function updateClient(db, id, client) {
  const result = await db.pool.query(
    `UPDATE clients
     SET
       full_name = $1,
       email = $2,
       phone = $3,
       address_line_1 = $4,
       address_line_2 = $5,
       city = $6,
       state = $7,
       postal_code = $8,
       country = $9
     WHERE id = $10
     RETURNING
       id,
       full_name,
       email,
       phone,
       address_line_1,
       address_line_2,
       city,
       state,
       postal_code,
       country,
       created_at`,
    [
      client.full_name,
      client.email,
      client.phone,
      client.address_line_1,
      client.address_line_2,
      client.city,
      client.state,
      client.postal_code,
      client.country,
      id
    ]
  );

  return result.rows[0] || null;
}

function logFailure(action, error, details = {}) {
  console.error("Admin client request failed.", {
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

    const clientId = getClientId(new URL(request.url).pathname);

    if (clientId === undefined) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (clientId === null) {
      if (request.method !== "GET") {
        return jsonResponse(405, {
          success: false,
          message: "Method not allowed. Use GET."
        });
      }

      try {
        const clients = await listClients(databaseFactory());

        return jsonResponse(200, {
          success: true,
          total: clients.length,
          clients
        });
      } catch (error) {
        logFailure("list", error);
        return jsonResponse(500, {
          success: false,
          message: "Unable to load clients."
        });
      }
    }

    if (!clientIdPattern.test(clientId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid client id."
      });
    }

    if (request.method === "PATCH") {
      let data;

      try {
        data = await request.json();
      } catch {
        return jsonResponse(400, {
          success: false,
          message: "Invalid JSON body."
        });
      }

      const normalized = normalizeClientUpdate(data);

      if (normalized.error) {
        return jsonResponse(400, {
          success: false,
          message: normalized.error
        });
      }

      try {
        const client = await updateClient(databaseFactory(), clientId, normalized.client);

        if (!client) {
          return jsonResponse(404, {
            success: false,
            message: "Client not found."
          });
        }

        return jsonResponse(200, {
          success: true,
          client
        });
      } catch (error) {
        if (error?.code === "23505") {
          logFailure("update_conflict", error, { client_id: clientId });
          return jsonResponse(409, {
            success: false,
            message: "Email already belongs to another client."
          });
        }

        logFailure("update", error, { client_id: clientId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to update client."
        });
      }
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET or PATCH."
      });
    }

    try {
      const client = await getClient(databaseFactory(), clientId);

      if (!client) {
        return jsonResponse(404, {
          success: false,
          message: "Client not found."
        });
      }

      return jsonResponse(200, {
        success: true,
        client
      });
    } catch (error) {
      logFailure("detail", error, { client_id: clientId });
      return jsonResponse(500, {
        success: false,
        message: "Unable to load the client."
      });
    }
  };
}

export const config = {
  path: ["/admin/api/clients", "/admin/api/clients/:id"]
};

export {
  createHandler,
  getClient,
  listClients,
  normalizeClientUpdate,
  updateClient
};

export default createHandler();
