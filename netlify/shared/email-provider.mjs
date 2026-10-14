const emailProviderErrorCodes = Object.freeze([
  "provider_not_configured",
  "provider_authentication_failed",
  "provider_rate_limit",
  "provider_unavailable",
  "provider_rejected",
  "send_timeout",
  "send_error"
]);
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const gmailEnvironmentKeys = Object.freeze([
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_SENDER_EMAIL"
]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class EmailProviderError extends Error {
  constructor(code, message = "Email provider request failed.") {
    super(message);
    this.name = "EmailProviderError";
    this.code = emailProviderErrorCodes.includes(code) ? code : "send_error";
  }
}

function normalizeEmailProviderError(error) {
  if (error instanceof EmailProviderError) return error;
  const code = emailProviderErrorCodes.includes(error?.code) ? error.code : "send_error";
  return new EmailProviderError(code);
}

function validateEmailProviderResult(result) {
  const provider = typeof result?.provider === "string" ? result.provider.trim() : "";
  const providerMessageId = typeof result?.provider_message_id === "string"
    ? result.provider_message_id.trim()
    : "";
  const acceptedAt = new Date(result?.accepted_at);
  if (!provider || !providerMessageId || Number.isNaN(acceptedAt.getTime())) {
    throw new EmailProviderError("send_error", "Email provider returned an invalid response.");
  }
  return {
    provider,
    provider_message_id: providerMessageId,
    accepted_at: acceptedAt
  };
}

function createUnconfiguredEmailProvider() {
  return Object.freeze({
    configured: false,
    async sendEmail() {
      throw new EmailProviderError("provider_not_configured", "No live email provider is configured.");
    },
    async reconcileEmail() {
      return {
        provider: null,
        result: "inconclusive",
        code: "provider_not_configured"
      };
    }
  });
}

function readGmailConfiguration(environmentReader) {
  const configuration = Object.fromEntries(gmailEnvironmentKeys.map((key) => {
    const value = environmentReader?.(key);
    return [key, typeof value === "string" ? value.trim() : ""];
  }));
  return gmailEnvironmentKeys.every((key) => configuration[key]) ? configuration : null;
}

function isGmailProviderConfigured(environmentReader) {
  return Boolean(readGmailConfiguration(environmentReader));
}

function assertSafeHeader(value, field, { email = false } = {}) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new EmailProviderError("provider_rejected", `${field} is not a safe email header.`);
  }
  const normalized = value.trim();
  if (email && !emailPattern.test(normalized)) {
    throw new EmailProviderError("provider_rejected", `${field} is not a valid email address.`);
  }
  return normalized;
}

function encodeHeaderUtf8(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildPlainTextMimeMessage({ from, to, subject, text, idempotency_key, metadata = {} }) {
  const sender = assertSafeHeader(from, "From", { email: true });
  const recipient = assertSafeHeader(to, "To", { email: true });
  const safeSubject = assertSafeHeader(subject, "Subject");
  if (typeof text !== "string" || !text.trim()) {
    throw new EmailProviderError("provider_rejected", "Email text is required.");
  }
  const idempotencyKey = assertSafeHeader(idempotency_key, "X-SAS-Idempotency-Key");
  const communicationId = metadata.communication_id === undefined
    ? null
    : assertSafeHeader(String(metadata.communication_id), "X-SAS-Communication-ID");
  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${encodeHeaderUtf8(safeSubject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: 8bit",
    `X-SAS-Idempotency-Key: ${idempotencyKey}`
  ];
  if (communicationId) headers.push(`X-SAS-Communication-ID: ${communicationId}`);
  return `${headers.join("\r\n")}\r\n\r\n${text}`;
}

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function fetchWithTimeout(fetchImplementation, url, options, timeoutMs) {
  if (typeof fetchImplementation !== "function") {
    throw new EmailProviderError("provider_unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImplementation(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw new EmailProviderError("send_timeout");
    }
    throw new EmailProviderError("provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sanitizeDiagnosticValue(value, sensitiveValues = []) {
  if (typeof value !== "string") return null;
  let sanitized = value;
  for (const sensitiveValue of sensitiveValues) {
    if (typeof sensitiveValue === "string" && sensitiveValue) {
      sanitized = sanitized.split(sensitiveValue).join("[redacted]");
    }
  }
  sanitized = sanitized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 240) : null;
}

function googleErrorDetails(body, fallbackError, sensitiveValues = []) {
  const nestedError = body?.error && typeof body.error === "object" ? body.error : null;
  const rawError = typeof body?.error === "string"
    ? body.error
    : nestedError?.errors?.[0]?.reason || nestedError?.status || fallbackError;
  const googleError = typeof rawError === "string"
    ? rawError.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80)
    : fallbackError;
  const rawMessage = typeof body?.error_description === "string"
    ? body.error_description
    : nestedError?.message;
  return {
    google_error: googleError || fallbackError,
    message: sanitizeDiagnosticValue(rawMessage, sensitiveValues)
  };
}

function logGmailProviderError(logger, details) {
  if (typeof logger !== "function") return;
  try {
    logger("gmail_provider_error", details);
  } catch {
    // Diagnostics must never alter provider behavior.
  }
}

function tokenErrorForStatus(status) {
  if (status === 400 || status === 401) return "provider_authentication_failed";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_unavailable";
  return "send_error";
}

function gmailErrorForStatus(status) {
  if (status === 401) return "provider_authentication_failed";
  if (status === 429) return "provider_rate_limit";
  if (status >= 500) return "provider_unavailable";
  if (status === 400 || status === 403 || status === 404) return "provider_rejected";
  return "send_error";
}

function createGmailEmailProvider({
  environmentReader,
  fetchImplementation = globalThis.fetch?.bind(globalThis),
  timeoutMs = 9000,
  now = () => new Date(),
  logger = (...args) => console.error(...args)
} = {}) {
  return Object.freeze({
    get configured() {
      return isGmailProviderConfigured(environmentReader);
    },
    async sendEmail(message) {
      const configuration = readGmailConfiguration(environmentReader);
      if (!configuration) throw new EmailProviderError("provider_not_configured");

      const mime = buildPlainTextMimeMessage({
        from: configuration.GMAIL_SENDER_EMAIL,
        ...message
      });
      const configurationValues = Object.values(configuration);
      let tokenResponse;
      try {
        tokenResponse = await fetchWithTimeout(fetchImplementation, GMAIL_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: configuration.GMAIL_CLIENT_ID,
            client_secret: configuration.GMAIL_CLIENT_SECRET,
            refresh_token: configuration.GMAIL_REFRESH_TOKEN,
            grant_type: "refresh_token"
          }).toString()
        }, timeoutMs);
      } catch (error) {
        logGmailProviderError(logger, {
          stage: "token_exchange",
          status: null,
          google_error: error?.code || "request_failed",
          message: null
        });
        throw error;
      }
      if (!tokenResponse.ok) {
        const tokenErrorBody = await safeJson(tokenResponse);
        logGmailProviderError(logger, {
          stage: "token_exchange",
          status: tokenResponse.status,
          ...googleErrorDetails(tokenErrorBody, `http_${tokenResponse.status}`, configurationValues)
        });
        throw new EmailProviderError(tokenErrorForStatus(tokenResponse.status));
      }
      const tokenBody = await safeJson(tokenResponse);
      if (typeof tokenBody?.access_token !== "string"
        || !tokenBody.access_token.trim()
        || /[\r\n]/.test(tokenBody.access_token)) {
        logGmailProviderError(logger, {
          stage: "token_exchange",
          status: tokenResponse.status,
          google_error: "malformed_token_response",
          message: null
        });
        throw new EmailProviderError("provider_authentication_failed");
      }
      const accessToken = tokenBody.access_token.trim();

      let sendResponse;
      try {
        sendResponse = await fetchWithTimeout(fetchImplementation, GMAIL_SEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ raw: encodeBase64Url(mime) })
        }, timeoutMs);
      } catch (error) {
        logGmailProviderError(logger, {
          stage: "gmail_send",
          status: null,
          google_error: error?.code || "request_failed",
          message: null
        });
        throw error;
      }
      if (!sendResponse.ok) {
        const sendErrorBody = await safeJson(sendResponse);
        logGmailProviderError(logger, {
          stage: "gmail_send",
          status: sendResponse.status,
          ...googleErrorDetails(
            sendErrorBody,
            `http_${sendResponse.status}`,
            [
              ...configurationValues,
              accessToken,
              message?.to,
              message?.subject,
              message?.text
            ]
          )
        });
        throw new EmailProviderError(gmailErrorForStatus(sendResponse.status));
      }
      const sendBody = await safeJson(sendResponse);
      if (typeof sendBody?.id !== "string" || !sendBody.id.trim()) {
        logGmailProviderError(logger, {
          stage: "gmail_send",
          status: sendResponse.status,
          google_error: "malformed_send_response",
          message: null
        });
        throw new EmailProviderError("send_error");
      }
      return {
        provider: "gmail",
        provider_message_id: sendBody.id.trim(),
        accepted_at: now()
      };
    },
    async reconcileEmail() {
      return {
        provider: "gmail",
        result: "inconclusive",
        code: "reconciliation_not_supported_with_current_scope"
      };
    }
  });
}

export {
  EmailProviderError,
  GMAIL_SEND_URL,
  GMAIL_TOKEN_URL,
  buildPlainTextMimeMessage,
  createGmailEmailProvider,
  createUnconfiguredEmailProvider,
  encodeBase64Url,
  emailProviderErrorCodes,
  gmailEnvironmentKeys,
  isGmailProviderConfigured,
  normalizeEmailProviderError,
  validateEmailProviderResult
};
