const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "font-src 'self' https://cdnjs.cloudflare.com",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "frame-src 'self' https://challenges.cloudflare.com",
  "img-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com 'sha256-VztvFvtZkwdqKX67kAa2H8qpggaUSFpAzou9u5KSBrE='",
  "script-src-attr 'none'",
  "style-src 'self' https://cdnjs.cloudflare.com"
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy-Report-Only": CONTENT_SECURITY_POLICY_REPORT_ONLY,
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN"
});

function createHandler() {
  return async function securityHeaders(_request, context) {
    const response = await context.next();
    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  };
}

export {
  CONTENT_SECURITY_POLICY_REPORT_ONLY,
  SECURITY_HEADERS,
  createHandler
};
export default createHandler();
