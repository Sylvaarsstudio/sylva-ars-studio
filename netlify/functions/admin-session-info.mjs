import { getDatabase } from "@netlify/database";

import {
  authorizeAdminRequest,
  readEnvironmentVariable
} from "../shared/admin-authorization.mjs";

const API_PATH = "/admin/api/session";

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date()
} = {}) {
  return async function handler(request) {
    if (request.method !== "GET") {
      return Response.json({
        success: false,
        code: "method_not_allowed",
        message: "Method not allowed. Use GET."
      }, { status: 405, headers: { "Cache-Control": "no-store" } });
    }
    const authorization = await authorizeAdminRequest(request, {
      databaseFactory,
      environmentReader,
      now
    });
    if (!authorization.ok) return authorization.response;
    const identity = authorization.identity;
    return Response.json({
      success: true,
      identity: {
        display_name: identity.display_name,
        email: identity.email,
        role: identity.role,
        read_only: identity.role === "viewer",
        legacy: identity.legacy === true
      }
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  };
}

export const config = { path: API_PATH };
export { API_PATH, createHandler };
export default createHandler();
