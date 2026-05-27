const COOKIE_NAME = "sylva_admin_session";
const SESSION_LENGTH_SECONDS = 60 * 60 * 8;

async function createSessionToken(password, secret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`sylva-admin:${password}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers
    }
  });
}

function buildSessionCookie(token) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/admin",
    `Max-Age=${SESSION_LENGTH_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function clearSessionCookie() {
  return [
    `${COOKIE_NAME}=`,
    "Path=/admin",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
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
