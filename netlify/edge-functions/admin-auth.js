import { getDatabase } from "@netlify/database";

import {
  readEnvironmentVariable,
  resolveAdminIdentity
} from "../shared/admin-authorization.mjs";

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers
    }
  });
}

function apiUnauthorized() {
  return Response.json({
    success: false,
    code: "admin_unauthorized",
    message: "Unauthorized."
  }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date()
} = {}) {
  return async function adminAuth(request, context) {
    const url = new URL(request.url);
    const isDocumentTemplate = url.pathname.startsWith("/admin/document-templates/");
    const templateCacheHeaders = { "Cache-Control": "private, no-store" };
    if (url.pathname === "/admin/logout") return context.next();

    let resolved;
    try {
      resolved = await resolveAdminIdentity(request, {
        databaseFactory,
        environmentReader,
        now
      });
    } catch {
      return new Response("Admin authorization could not be completed.", {
        status: 500,
        headers: { "Cache-Control": "no-store" }
      });
    }

    if (!resolved.error) {
      if (
        resolved.identity.role === "viewer"
        && /^\/admin\/security(?:\.html)?\/?$/.test(url.pathname)
      ) {
        return new Response("Forbidden.", {
          status: 403,
          headers: { "Cache-Control": "no-store" }
        });
      }
      const response = await context.next();
      if (!isDocumentTemplate) return response;

      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    if (url.pathname.startsWith("/admin/api/")) return apiUnauthorized();

    const requestedPath = `${url.pathname}${url.search}`;
    return redirect(
      `/admin-login.html?redirect=${encodeURIComponent(requestedPath)}`,
      isDocumentTemplate ? templateCacheHeaders : {}
    );
  };
}

export { createHandler, readEnvironmentVariable };
export default createHandler();
