import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/clients";
const clientIdPattern = /^[1-9][0-9]*$/;

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

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET."
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
  listClients
};

export default createHandler();
