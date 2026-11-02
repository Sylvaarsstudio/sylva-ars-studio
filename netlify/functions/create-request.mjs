import { randomUUID } from "node:crypto";
import { getDatabase } from "@netlify/database";

import { attemptAutomaticCommunicationSend } from "../shared/communication-automations.mjs";
import { getCommunicationAutomationRule } from "../shared/communication-automation-policy.mjs";
import { getCommunicationTemplate, renderCommunicationTemplate } from "../shared/communication-templates.mjs";
import { createGmailEmailProvider } from "../shared/email-provider.mjs";

const allowedFormTypes = new Set([
  "contact",
  "artwork_inquiry",
  "commission_request",
  "collaboration"
]);

const allowedEstimatedDates = new Set([
  "flexible",
  "within_1_month",
  "within_2_months",
  "within_3_months"
]);

const allowedOccasions = new Set([
  "birthday",
  "valentines_day",
  "mothers_day",
  "fathers_day",
  "graduation",
  "wedding_anniversary",
  "halloween",
  "thanksgiving",
  "christmas_holiday",
  "national_holiday",
  "other"
]);

const optionalTextFields = [
  "client_phone",
  "artwork_title",
  "artwork_subject",
  "artwork_size",
  "budget_range",
  "shipping_location",
  "preferred_contact_method",
  "reference_notes",
  "organization_project",
  "collaboration_type"
];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientNameControlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const maxClientNameLength = 100;
const maxTurnstileTokenLength = 2048;
const turnstileAction = "sylva_public_inquiry";
const turnstileVerificationUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const defaultPublicSendLimit = 20;
const defaultPublicSendWindowMs = 60 * 60 * 1000;
const publicSendCeilingLock = "sylva-public-inquiry-send-ceiling";

function jsonResponse(statusCode, body, headers = {}) {
  return Response.json(body, { status: statusCode, headers });
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toSnakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function normalizeRequiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeClientName(value) {
  if (typeof value !== "string") {
    return { value: "", error: "Missing required field: client_name." };
  }

  if (clientNameControlCharacterPattern.test(value)) {
    return { value: "", error: "client_name contains unsupported control characters." };
  }

  const normalized = value.trim();
  if (!normalized) {
    return { value: "", error: "Missing required field: client_name." };
  }

  if (Array.from(normalized).length > maxClientNameLength) {
    return { value: "", error: `client_name must be ${maxClientNameLength} characters or fewer.` };
  }

  return { value: normalized, error: "" };
}

function normalizePayload(data) {
  const source = {};

  for (const [key, value] of Object.entries(data)) {
    source[toSnakeCase(key)] = value;
  }

  const clientName = normalizeClientName(source.client_name);
  const payload = {
    form_type: normalizeRequiredText(source.form_type),
    client_name: clientName.value,
    client_name_error: clientName.error,
    client_email: normalizeRequiredText(source.client_email),
    message: normalizeRequiredText(source.message),
    request_id: normalizeOptionalText(source.request_id),
    turnstile_token: normalizeOptionalText(source.turnstile_token),
    estimated_date: normalizeOptionalText(source.estimated_date),
    occasion: normalizeOptionalText(source.occasion)
  };

  for (const field of optionalTextFields) {
    payload[field] = normalizeOptionalText(source[field]);
  }

  if (payload.occasion === "none") {
    payload.occasion = null;
  }

  return payload;
}

function validateRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Request body must be valid JSON.";
  }

  if (!hasText(data.form_type)) {
    return "Missing required field: form_type.";
  }

  if (!allowedFormTypes.has(data.form_type)) {
    return "Unsupported form_type.";
  }

  if (data.client_name_error) {
    return data.client_name_error;
  }

  if (!hasText(data.client_email)) {
    return "Missing required field: client_email.";
  }

  if (!hasText(data.message)) {
    return "Missing required field: message.";
  }

  if (data.request_id !== null && !uuidPattern.test(data.request_id)) {
    return "Unsupported request_id.";
  }

  if (
    data.estimated_date !== null &&
    !allowedEstimatedDates.has(data.estimated_date)
  ) {
    return "Unsupported estimated_date.";
  }

  if (data.occasion !== null && !allowedOccasions.has(data.occasion)) {
    return "Unsupported occasion.";
  }

  return "";
}

function readEnvironmentVariable(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
}

function readTurnstileConfiguration(environmentReader) {
  const siteKey = environmentReader("TURNSTILE_SITE_KEY");
  const secretKey = environmentReader("TURNSTILE_SECRET_KEY");

  if (!hasText(siteKey) || !hasText(secretKey)) {
    return null;
  }

  return { siteKey: siteKey.trim(), secretKey: secretKey.trim() };
}

async function verifyTurnstileProof({
  token,
  secretKey,
  request,
  context,
  requestId,
  fetchImplementation
}) {
  if (!hasText(token) || token.length > maxTurnstileTokenLength) {
    return { outcome: "invalid" };
  }

  if (typeof fetchImplementation !== "function") {
    return { outcome: "unavailable" };
  }

  const verificationRequest = {
    secret: secretKey,
    response: token,
    idempotency_key: requestId
  };
  if (hasText(context?.ip)) {
    verificationRequest.remoteip = context.ip;
  }

  try {
    const response = await fetchImplementation(turnstileVerificationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verificationRequest),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return { outcome: "unavailable" };
    }

    const result = await response.json();
    const expectedHostname = new URL(request.url).hostname;
    if (
      result?.success !== true
      || result.action !== turnstileAction
      || result.hostname !== expectedHostname
    ) {
      return { outcome: "invalid" };
    }

    return { outcome: "valid" };
  } catch {
    return { outcome: "unavailable" };
  }
}

function sameInquiryIntent(existing, data) {
  return existing.form_type === data.form_type
    && existing.client_name === data.client_name
    && existing.client_email === data.client_email
    && existing.message === data.message;
}

const inquiryClientNameToken = "__SAS_INQUIRY_CLIENT_NAME__";

function prepareInquiryConfirmationAutomation() {
  const policy = getCommunicationAutomationRule("inquiry_received_confirmation");
  const template = getCommunicationTemplate(policy?.template_key);
  const rendered = renderCommunicationTemplate(template, {
    client_name: inquiryClientNameToken
  });
  if (!policy?.enabled || policy.mode !== "auto_send" || !template || rendered.error) {
    throw new Error("Inquiry confirmation automation policy is invalid.");
  }
  return { policy, template, rendered };
}

async function findExistingInquiryResult(client, data) {
  const existing = (await client.query(
    "SELECT * FROM inquiries WHERE source_submission_id = $1",
    [data.request_id]
  )).rows[0];
  if (!existing) {
    return null;
  }

  const communication = (await client.query(
    "SELECT id FROM communications WHERE automation_source_key = $1",
    [`inquiry-received:${existing.id}`]
  )).rows[0];
  if (!communication) {
    throw new Error("Inquiry confirmation outbox was not persisted.");
  }

  if (!sameInquiryIntent(existing, data)) {
    return { outcome: "request_conflict" };
  }
  return {
    outcome: "success",
    created: false,
    inquiry: existing,
    communication_id: communication.id
  };
}

async function insertInquiry(db, data, now = () => new Date(), options = {}) {
  const {
    sendLimit = defaultPublicSendLimit,
    sendWindowMs = defaultPublicSendWindowMs
  } = options;
  const prepared = prepareInquiryConfirmationAutomation();
  const submittedAt = now();
  const windowStart = new Date(submittedAt.getTime() - sendWindowMs);
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [publicSendCeilingLock]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [data.request_id]);

    const existingResult = await findExistingInquiryResult(client, data);
    if (existingResult) {
      await client.query("COMMIT");
      return existingResult;
    }

    const recentSendCount = (await client.query(
      `SELECT count(*)::integer AS count
       FROM communications
       WHERE automation_key = $1
         AND ready_at >= $2`,
      [prepared.policy.key, windowStart]
    )).rows[0]?.count || 0;
    if (recentSendCount >= sendLimit) {
      const retryResult = await findExistingInquiryResult(client, data);
      if (retryResult) {
        await client.query("COMMIT");
        return retryResult;
      }
      await client.query("ROLLBACK");
      return { outcome: "send_ceiling_reached" };
    }

    const inquiry = (await client.query(
      `INSERT INTO inquiries (
       source_submission_id,
       form_type,
       client_name,
       client_email,
       client_phone,
       artwork_title,
       artwork_subject,
       artwork_size,
       budget_range,
       estimated_date,
       occasion,
       shipping_location,
       preferred_contact_method,
       reference_notes,
       organization_project,
       collaboration_type,
       message
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17
       )
       ON CONFLICT (source_submission_id) DO NOTHING
       RETURNING *`,
      [
        data.request_id,
        data.form_type,
        data.client_name,
        data.client_email,
        data.client_phone,
        data.artwork_title,
        data.artwork_subject,
        data.artwork_size,
        data.budget_range,
        data.estimated_date,
        data.occasion,
        data.shipping_location,
        data.preferred_contact_method,
        data.reference_notes,
        data.organization_project,
        data.collaboration_type,
        data.message
      ]
    )).rows[0];

    if (!inquiry) {
      const retryResult = await findExistingInquiryResult(client, data);
      if (!retryResult) {
        throw new Error("Concurrent Inquiry was not persisted.");
      }
      await client.query("COMMIT");
      return retryResult;
    }

    const communication = (await client.query(
      `INSERT INTO communications (
         inquiry_id, channel, communication_type, communication_status,
         recipient, subject, body_snapshot, ready_at,
         template_key, template_version,
         automation_key, automation_mode, automation_source_key
       ) VALUES (
         $1, $2, $3, 'ready', $4,
         replace($5, $7, $8),
         replace($6, $7, $8),
         $9::timestamptz, $10, $11, $12, 'auto_send', $13
       )
       RETURNING id`,
      [
        inquiry.id,
        prepared.template.channel,
        prepared.template.communication_type,
        inquiry.client_email,
        prepared.rendered.subject,
        prepared.rendered.body,
        inquiryClientNameToken,
        inquiry.client_name,
        submittedAt,
        prepared.template.key,
        prepared.template.version,
        prepared.policy.key,
        `inquiry-received:${inquiry.id}`
      ]
    )).rows[0];

    await client.query("COMMIT");
    return {
      outcome: "success",
      created: true,
      inquiry,
      communication_id: communication.id
    };
  } catch (error) {
    const contentionFailedClosed = error?.code === "40001" || error?.code === "40P01";
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    if (contentionFailedClosed) {
      return { outcome: "send_ceiling_reached" };
    }
    throw error;
  } finally {
    client.release();
  }
}

function createHandler(options = getDatabase) {
  const {
    databaseFactory = getDatabase,
    environmentReader = readEnvironmentVariable,
    emailProvider = null,
    providerFetch = globalThis.fetch?.bind(globalThis),
    turnstileFetch = globalThis.fetch?.bind(globalThis),
    turnstileVerifier = verifyTurnstileProof,
    publicSendLimit = defaultPublicSendLimit,
    publicSendWindowMs = defaultPublicSendWindowMs,
    now = () => new Date()
  } = typeof options === "function" ? { databaseFactory: options } : options;
  const sendingProvider = emailProvider || createGmailEmailProvider({
    environmentReader,
    fetchImplementation: providerFetch,
    now
  });
  return async function handler(request, context = {}) {
    const turnstileConfiguration = readTurnstileConfiguration(environmentReader);

    if (request.method === "GET") {
      if (!turnstileConfiguration) {
        return jsonResponse(503, {
          success: false,
          code: "inquiry_verification_unavailable",
          message: "Inquiry verification is temporarily unavailable."
        }, { "Cache-Control": "no-store" });
      }
      return jsonResponse(200, {
        success: true,
        provider: "turnstile",
        site_key: turnstileConfiguration.siteKey,
        action: turnstileAction
      }, { "Cache-Control": "no-store" });
    }

    if (request.method !== "POST") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET or POST."
      });
    }

    const rawData = await parseJsonBody(request);
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? normalizePayload(rawData)
      : rawData;
    const validationError = validateRequest(data);

    if (validationError) {
      return jsonResponse(400, {
        success: false,
        message: validationError
      });
    }

    if (!turnstileConfiguration) {
      return jsonResponse(503, {
        success: false,
        code: "inquiry_verification_unavailable",
        message: "Inquiry verification is temporarily unavailable."
      });
    }

    if (!hasText(data.turnstile_token)) {
      return jsonResponse(400, {
        success: false,
        code: "inquiry_verification_required",
        message: "Complete the inquiry verification before submitting."
      });
    }

    try {
      data.request_id ||= randomUUID();
      const verification = await turnstileVerifier({
        token: data.turnstile_token,
        secretKey: turnstileConfiguration.secretKey,
        request,
        context,
        requestId: data.request_id,
        fetchImplementation: turnstileFetch
      });
      if (verification.outcome === "unavailable") {
        return jsonResponse(503, {
          success: false,
          code: "inquiry_verification_unavailable",
          message: "Inquiry verification is temporarily unavailable."
        });
      }
      if (verification.outcome !== "valid") {
        return jsonResponse(403, {
          success: false,
          code: "inquiry_verification_failed",
          message: "Inquiry verification failed. Please try again."
        });
      }

      const db = databaseFactory();
      const result = await insertInquiry(db, data, now, {
        sendLimit: publicSendLimit,
        sendWindowMs: publicSendWindowMs
      });
      if (result.outcome === "request_conflict") {
        return jsonResponse(409, { success: false, message: "Request id is already in use." });
      }
      if (result.outcome === "send_ceiling_reached") {
        return jsonResponse(429, {
          success: false,
          code: "inquiry_rate_limited",
          message: "Too many inquiries are being processed. Please try again later."
        });
      }
      await attemptAutomaticCommunicationSend(db, result.communication_id, sendingProvider, now);
      const inquiry = result.inquiry;

      return jsonResponse(200, {
        success: true,
        message: "Request received",
        id: inquiry.id,
        request_id: inquiry.id,
        status: inquiry.status,
        created_at: inquiry.created_at
      });
    } catch (error) {
      console.error("Inquiry request failed.", {
        form_type: data.form_type,
        error_type: error?.name || "Error",
        error_code: error?.code || "unknown"
      });

      return jsonResponse(500, {
        success: false,
        message: "Unable to save request."
      });
    }
  };
}

export { createHandler, insertInquiry };
export default createHandler();

export const config = {
  path: "/api/inquiries",
  rateLimit: {
    action: "rate_limit",
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
};
