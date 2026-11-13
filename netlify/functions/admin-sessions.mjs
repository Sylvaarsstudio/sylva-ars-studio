import { getDatabase } from "@netlify/database";

import {
  authorizeAdminRequest,
  readEnvironmentVariable
} from "../shared/admin-authorization.mjs";
import {
  listActiveAdminSessions,
  revokeOtherAdminSessions,
  revokeOwnAdminSession
} from "../shared/admin-session-store.mjs";

const API_PATH = "/admin/api/sessions";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function forbidden() {
  return jsonResponse(403, {
    success: false,
    code: "admin_forbidden",
    message: "Owner access is required."
  });
}

function parseRoute(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === API_PATH) return { action: "list" };
  if (normalized === `${API_PATH}/sign-out-others`) {
    return { action: "sign_out_others" };
  }
  const match = normalized.match(new RegExp(`^${API_PATH}/([^/]+)/revoke$`));
  if (match) return { action: "revoke", id: match[1] };
  return null;
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date(),
  logger = (...arguments_) => console.error(...arguments_)
} = {}) {
  return async function handler(request) {
    const authorization = await authorizeAdminRequest(request, {
      databaseFactory,
      environmentReader,
      now
    });
    if (!authorization.ok) return authorization.response;
    if (authorization.identity.role !== "owner_admin") return forbidden();
    if (!authorization.sessionRecord) {
      return jsonResponse(401, {
        success: false,
        code: "admin_unauthorized",
        message: "Unauthorized."
      });
    }

    const route = parseRoute(new URL(request.url).pathname);
    if (!route) {
      return jsonResponse(404, {
        success: false,
        code: "session_endpoint_not_found",
        message: "Session endpoint not found."
      });
    }

    try {
      const database = databaseFactory();
      const currentSessionId = authorization.sessionRecord.id;
      const adminUserId = authorization.identity.id;

      if (route.action === "list") {
        if (request.method !== "GET") {
          return jsonResponse(405, {
            success: false,
            code: "method_not_allowed",
            message: "Method not allowed. Use GET."
          });
        }
        const sessions = await listActiveAdminSessions(database, {
          adminUserId,
          currentSessionId,
          now: now()
        });
        return jsonResponse(200, { success: true, sessions });
      }

      if (request.method !== "POST") {
        return jsonResponse(405, {
          success: false,
          code: "method_not_allowed",
          message: "Method not allowed. Use POST."
        });
      }

      if (route.action === "revoke") {
        if (!uuidPattern.test(route.id)) {
          return jsonResponse(400, {
            success: false,
            code: "invalid_session_id",
            message: "Invalid session id."
          });
        }
        const result = await revokeOwnAdminSession(database, {
          adminUserId,
          currentSessionId,
          targetSessionId: route.id,
          now: now()
        });
        if (result.outcome === "not_found") {
          return jsonResponse(404, {
            success: false,
            code: "session_not_found",
            message: "Session not found."
          });
        }
        if (result.outcome === "current_session") {
          return jsonResponse(409, {
            success: false,
            code: "current_session_requires_logout",
            message: "Use normal logout for the current session."
          });
        }
        return jsonResponse(200, {
          success: true,
          session_id: result.session.id,
          revoked: true
        });
      }

      const revokedIds = await revokeOtherAdminSessions(database, {
        adminUserId,
        currentSessionId,
        now: now()
      });
      return jsonResponse(200, {
        success: true,
        revoked_count: revokedIds.length
      });
    } catch (error) {
      logger("admin_session_api_error", {
        error_type: error?.name || "Error",
        error_code: error?.code || "unknown"
      });
      return jsonResponse(500, {
        success: false,
        code: "admin_session_operation_failed",
        message: "The session operation could not be completed."
      });
    }
  };
}

export const config = {
  path: [
    "/admin/api/sessions",
    "/admin/api/sessions/:id/revoke",
    "/admin/api/sessions/sign-out-others"
  ]
};

export { API_PATH, createHandler, parseRoute };
export default createHandler();
