import {
  COOKIE_NAME,
  createSessionToken,
  getCookie,
  verifyAdminSessionToken
} from "../shared/admin-session.mjs";

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers
    }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  if (globalThis.Deno?.env?.get) return globalThis.Deno.env.get(name);
  return globalThis.process?.env?.[name];
}

function isLegacyAdminEnabled(environmentReader) {
  const configured = environmentReader("ADMIN_LEGACY_LOGIN_ENABLED");
  if (configured === "true") return true;
  if (configured === "false") return false;
  return !environmentReader("ADMIN_OIDC_CLIENT_ID");
}

function createHandler({ environmentReader = readEnvironmentVariable } = {}) {
  return async function adminAuth(request, context) {
    const url = new URL(request.url);
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET");
    if (!sessionSecret) {
      return new Response("Admin authentication is not configured.", { status: 500 });
    }

    const sessionToken = getCookie(request, COOKIE_NAME);
    const signedSession = await verifyAdminSessionToken(sessionToken, sessionSecret);
    if (signedSession?.provider === "google") return context.next();

    if (isLegacyAdminEnabled(environmentReader)) {
      if (signedSession?.provider === "legacy") return context.next();
      const adminPassword = environmentReader("ADMIN_PASSWORD");
      if (adminPassword) {
        const oldToken = await createSessionToken(adminPassword, sessionSecret);
        if (sessionToken === oldToken) return context.next();
      }
    }

    const requestedPath = `${url.pathname}${url.search}`;
    return redirect(`/admin-login.html?redirect=${encodeURIComponent(requestedPath)}`);
  };
}

export { createHandler, readEnvironmentVariable };
export default createHandler();
