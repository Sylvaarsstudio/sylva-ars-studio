import {
  COOKIE_NAME,
  buildSessionCookie,
  clearSessionCookie,
  createSessionToken,
  getCookie
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

export default async function adminAuth(request, context) {
  const url = new URL(request.url);
  const adminPassword = Deno.env.get("ADMIN_PASSWORD");
  const sessionSecret = Deno.env.get("ADMIN_SESSION_SECRET") || adminPassword;

  if (!adminPassword) {
    return new Response("Missing ADMIN_PASSWORD environment variable.", {
      status: 500
    });
  }

  const validToken = await createSessionToken(adminPassword, sessionSecret);

  if (url.pathname === "/admin-logout") {
    return redirect("/admin-login.html", {
      "Set-Cookie": clearSessionCookie()
    });
  }

  if (url.pathname === "/admin-login") {
    if (request.method !== "POST") {
      return redirect("/admin-login.html");
    }

    const body = await request.text();
    const formData = new URLSearchParams(body);
    const password = formData.get("password") || "";
    const requestedRedirect = formData.get("redirect") || "";
    const redirectTo = requestedRedirect.startsWith("/admin/")
      ? requestedRedirect
      : "/admin/dashboard.html";

    if (password === adminPassword) {
      return redirect(redirectTo, {
        "Set-Cookie": buildSessionCookie(validToken)
      });
    }

    return redirect("/admin-login.html?error=1");
  }

  const sessionToken = getCookie(request, COOKIE_NAME);

  if (sessionToken === validToken) {
    return context.next();
  }

  return redirect(`/admin-login.html?redirect=${encodeURIComponent(url.pathname)}`);
}
