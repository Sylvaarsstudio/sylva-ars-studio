const COOKIE_NAME = "sylva_admin_session";
const OIDC_FLOW_COOKIE_NAME = "sylva_admin_oidc_flow";
const SESSION_LENGTH_SECONDS = 60 * 60 * 8;
const OIDC_FLOW_LENGTH_SECONDS = 60 * 10;
const tokenVersion = 1;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function createSignedPayloadToken(payload, secret) {
  if (!secret) throw new Error("Admin session signing secret is required.");
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    new TextEncoder().encode(encodedPayload)
  );
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifySignedPayloadToken(token, secret) {
  if (!secret || typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const payloadBytes = decodeBase64Url(parts[0]);
    const signatureBytes = decodeBase64Url(parts[1]);
    if (
      encodeBase64Url(payloadBytes) !== parts[0]
      || encodeBase64Url(signatureBytes) !== parts[1]
    ) return null;
    const verified = await crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secret),
      signatureBytes,
      new TextEncoder().encode(parts[0])
    );
    if (!verified) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  } catch {
    return null;
  }
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

async function createAdminSessionToken({ provider, externalSubject }, secret, {
  now = () => new Date()
} = {}) {
  if (!provider || !externalSubject) {
    throw new Error("Admin identity provider and subject are required.");
  }
  const issuedAt = Math.floor(now().getTime() / 1000);
  return createSignedPayloadToken({
    v: tokenVersion,
    sid: randomToken(24),
    provider,
    sub: externalSubject,
    iat: issuedAt,
    exp: issuedAt + SESSION_LENGTH_SECONDS
  }, secret);
}

async function verifyAdminSessionToken(token, secret, {
  now = () => new Date()
} = {}) {
  const payload = await verifySignedPayloadToken(token, secret);
  const currentTime = Math.floor(now().getTime() / 1000);
  if (
    payload?.v !== tokenVersion
    || typeof payload.sid !== "string"
    || payload.sid.length < 20
    || typeof payload.provider !== "string"
    || !["google", "legacy"].includes(payload.provider)
    || typeof payload.sub !== "string"
    || !payload.sub
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || payload.iat > currentTime + 60
    || payload.exp <= currentTime
    || payload.exp - payload.iat !== SESSION_LENGTH_SECONDS
  ) return null;
  return payload;
}

async function createOidcFlowToken({ state, nonce, codeVerifier, redirectTo }, secret, {
  now = () => new Date()
} = {}) {
  const issuedAt = Math.floor(now().getTime() / 1000);
  return createSignedPayloadToken({
    v: tokenVersion,
    purpose: "admin_oidc_flow",
    state,
    nonce,
    code_verifier: codeVerifier,
    redirect_to: redirectTo,
    iat: issuedAt,
    exp: issuedAt + OIDC_FLOW_LENGTH_SECONDS
  }, secret);
}

async function verifyOidcFlowToken(token, secret, {
  now = () => new Date()
} = {}) {
  const payload = await verifySignedPayloadToken(token, secret);
  const currentTime = Math.floor(now().getTime() / 1000);
  if (
    payload?.v !== tokenVersion
    || payload.purpose !== "admin_oidc_flow"
    || typeof payload.state !== "string"
    || payload.state.length < 20
    || typeof payload.nonce !== "string"
    || payload.nonce.length < 20
    || typeof payload.code_verifier !== "string"
    || payload.code_verifier.length < 43
    || typeof payload.redirect_to !== "string"
    || !payload.redirect_to.startsWith("/admin/")
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || payload.iat > currentTime + 60
    || payload.exp <= currentTime
    || payload.exp - payload.iat !== OIDC_FLOW_LENGTH_SECONDS
  ) return null;
  return payload;
}

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

function buildCookie(name, value, { path, maxAge }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function buildSessionCookie(token) {
  return buildCookie(COOKIE_NAME, token, {
    path: "/admin",
    maxAge: SESSION_LENGTH_SECONDS
  });
}

function clearSessionCookie() {
  return buildCookie(COOKIE_NAME, "", { path: "/admin", maxAge: 0 });
}

function buildOidcFlowCookie(token) {
  return buildCookie(OIDC_FLOW_COOKIE_NAME, token, {
    path: "/admin-auth/callback",
    maxAge: OIDC_FLOW_LENGTH_SECONDS
  });
}

function clearOidcFlowCookie() {
  return buildCookie(OIDC_FLOW_COOKIE_NAME, "", {
    path: "/admin-auth/callback",
    maxAge: 0
  });
}

export {
  COOKIE_NAME,
  OIDC_FLOW_COOKIE_NAME,
  OIDC_FLOW_LENGTH_SECONDS,
  SESSION_LENGTH_SECONDS,
  buildOidcFlowCookie,
  buildSessionCookie,
  clearOidcFlowCookie,
  clearSessionCookie,
  createAdminSessionToken,
  createOidcFlowToken,
  createSessionToken,
  getCookie,
  hasValidAdminSession,
  randomToken,
  verifyAdminSessionToken,
  verifyOidcFlowToken
};
