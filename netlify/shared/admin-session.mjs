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

async function hasValidAdminSession(request, password, secret = password) {
  if (!password) {
    return false;
  }

  const expectedToken = await createSessionToken(password, secret || password);
  return getCookie(request, COOKIE_NAME) === expectedToken;
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

export {
  COOKIE_NAME,
  SESSION_LENGTH_SECONDS,
  buildSessionCookie,
  clearSessionCookie,
  createSessionToken,
  getCookie,
  hasValidAdminSession
};
