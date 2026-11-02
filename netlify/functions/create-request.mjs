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
const sharedPublicFields = [
  "form_type",
  "client_name",
  "client_email",
  "message",
  "request_id",
  "turnstile_token"
];
const allowedPublicFieldsByFormType = new Map([
  ["contact", new Set(sharedPublicFields)],
  ["artwork_inquiry", new Set([
    ...sharedPublicFields,
    "client_phone",
    "artwork_title",
    "shipping_location",
    "preferred_contact_method"
  ])],
  ["commission_request", new Set([
    ...sharedPublicFields,
    "client_phone",
    "artwork_subject",
    "artwork_size",
    "budget_range",
    "estimated_date",
    "occasion",
    "shipping_location",
    "reference_notes"
  ])],
  ["collaboration", new Set([
    ...sharedPublicFields,
    "client_phone",
    "organization_project",
    "collaboration_type",
    "estimated_date",
    "occasion"
  ])]
]);
const inquiryFieldLengthLimits = Object.freeze({
  form_type: 18,
  client_name: 100,
  client_email: 254,
  client_phone: 32,
  artwork_title: 200,
  artwork_subject: 500,
  artwork_size: 100,
  budget_range: 100,
  estimated_date: 15,
  occasion: 19,
  shipping_location: 300,
  preferred_contact_method: 50,
  reference_notes: 3000,
  organization_project: 300,
  collaboration_type: 100,
  message: 5000,
  request_id: 36,
  turnstile_token: 2048
});
// Covers all bounded text fields at worst-case UTF-8 size while capping buffering well below 1 MB.
const maxRequestBodyBytes = 48 * 1024;
const maxRequestObjectKeys = 20;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientNameControlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const turnstileAction = "sylva_public_inquiry";
const turnstileVerificationUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const defaultPublicSendLimit = 20;
const defaultPublicSendWindowMs = 60 * 60 * 1000;
const publicSendCeilingLock = "sylva-public-inquiry-send-ceiling";

function jsonResponse(statusCode, body, headers = {}) {
  return Response.json(body, { status: statusCode, headers });
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validationError(code, message) {
  return { code, message };
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/u.test(text[index] || "")) index += 1;
  return index;
}

function scanJsonString(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    if (escaped) {
      escaped = false;
    } else if (text[index] === "\\") {
      escaped = true;
    } else if (text[index] === "\"") {
      return index + 1;
    }
  }
  return text.length;
}

function skipJsonValue(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return index;
    }
  }
  return text.length;
}

function hasDuplicateTopLevelKeys(text) {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") return false;
  index += 1;
  const keys = new Set();

  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (text[index] === "}") return false;

    const keyStart = index;
    const keyEnd = scanJsonString(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    if (keys.has(key)) return true;
    keys.add(key);

    index = skipWhitespace(text, keyEnd);
    index = skipWhitespace(text, index + 1);
    index = skipJsonValue(text, index);
    index = skipWhitespace(text, index);
    if (text[index] === ",") index += 1;
    else return false;
  }

  return false;
}

async function readLimitedJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
    return { outcome: "too_large" };
  }
  if (!request.body) {
    return { outcome: "invalid_json" };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxRequestBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The request is already rejected; cancellation failure must not change the 413 result.
        }
        return { outcome: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { outcome: "invalid_json" };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data = JSON.parse(text);
    if (hasDuplicateTopLevelKeys(text)) {
      return { outcome: "duplicate_fields" };
    }
    return { outcome: "success", data };
  } catch {
    return { outcome: "invalid_json" };
  }
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

  return { value: normalized, error: "" };
}

function normalizePayload(data) {
  const clientName = normalizeClientName(data.client_name);
  const payload = {
    form_type: normalizeRequiredText(data.form_type),
    client_name: clientName.value,
    client_name_error: clientName.error,
    client_email: normalizeRequiredText(data.client_email),
    message: normalizeRequiredText(data.message),
    request_id: normalizeOptionalText(data.request_id),
    turnstile_token: normalizeOptionalText(data.turnstile_token),
    estimated_date: normalizeOptionalText(data.estimated_date),
    occasion: normalizeOptionalText(data.occasion)
  };

  for (const field of optionalTextFields) {
    payload[field] = normalizeOptionalText(data[field]);
  }

  if (payload.occasion === "none") {
    payload.occasion = null;
  }

  return payload;
}

function validatePayloadStructure(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return validationError(
      "inquiry_invalid_structure",
      "Request body must be a JSON object."
    );
  }
  const entries = Object.entries(data);
  if (entries.length > maxRequestObjectKeys) {
    return validationError(
      "inquiry_invalid_structure",
      "Request body contains too many fields."
    );
  }
  if (entries.some(([, value]) => typeof value !== "string")) {
    return validationError(
      "inquiry_invalid_structure",
      "Inquiry fields must contain only text values."
    );
  }
  return null;
}

function validateAllowedFields(data) {
  if (
    typeof data.form_type === "string"
    && Array.from(data.form_type.trim()).length > inquiryFieldLengthLimits.form_type
  ) {
    return validationError(
      "inquiry_field_too_long",
      "form_type is longer than the supported limit."
    );
  }
  if (!hasText(data.form_type) || !allowedFormTypes.has(data.form_type.trim())) {
    return validationError("inquiry_invalid_fields", "Unsupported form_type.");
  }
  const allowedFields = allowedPublicFieldsByFormType.get(data.form_type.trim());
  const unsupportedFields = Object.keys(data).filter((field) => !allowedFields.has(field));
  if (unsupportedFields.length > 0) {
    return validationError(
      "inquiry_invalid_fields",
      "Request contains unsupported fields for this form type."
    );
  }
  return null;
}

function validateFieldLengths(data) {
  for (const [field, limit] of Object.entries(inquiryFieldLengthLimits)) {
    const value = data[field];
    if (value !== null && value !== undefined && Array.from(value).length > limit) {
      return validationError(
        "inquiry_field_too_long",
        `${field} is longer than the supported limit.`
      );
    }
  }
  return null;
}

function isValidEmail(value) {
  if (
    !hasText(value)
    || /\s/u.test(value)
    || clientNameControlCharacterPattern.test(value)
    || /[()<>\[\]:;,\\"]/u.test(value)
  ) return false;
  const firstAt = value.indexOf("@");
  if (firstAt <= 0 || firstAt !== value.lastIndexOf("@")) return false;
  const localPart = value.slice(0, firstAt);
  const domain = value.slice(firstAt + 1);
  if (!domain || Array.from(localPart).length > 64 || Array.from(domain).length > 253) {
    return false;
  }
  if (localPart.startsWith(".") || localPart.endsWith(".") || localPart.includes("..")) {
    return false;
  }
  return domain.split(".").every((label) => (
    label.length > 0
    && Array.from(label).length <= 63
    && !label.startsWith("-")
    && !label.endsWith("-")
  ));
}

function validateRequest(data) {
  const lengthError = validateFieldLengths(data);
  if (lengthError) return lengthError;

  if (!hasText(data.form_type)) {
    return validationError("inquiry_invalid_fields", "Missing required field: form_type.");
  }
  if (!allowedFormTypes.has(data.form_type)) {
    return validationError("inquiry_invalid_fields", "Unsupported form_type.");
  }
  if (data.client_name_error) {
    return validationError("inquiry_invalid_fields", data.client_name_error);
  }
  if (!hasText(data.client_email)) {
    return validationError("inquiry_invalid_fields", "Missing required field: client_email.");
  }
  if (!isValidEmail(data.client_email)) {
    return validationError("inquiry_invalid_fields", "client_email is invalid.");
  }
  if (!hasText(data.message)) {
    return validationError("inquiry_invalid_fields", "Missing required field: message.");
  }
  if (data.request_id !== null && !uuidPattern.test(data.request_id)) {
    return validationError("inquiry_invalid_fields", "Unsupported request_id.");
  }
  if (
    data.estimated_date !== null &&
    !allowedEstimatedDates.has(data.estimated_date)
  ) {
    return validationError("inquiry_invalid_fields", "Unsupported estimated_date.");
  }
  if (data.occasion !== null && !allowedOccasions.has(data.occasion)) {
    return validationError("inquiry_invalid_fields", "Unsupported occasion.");
  }
  return null;
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
  if (!hasText(token) || Array.from(token).length > inquiryFieldLengthLimits.turnstile_token) {
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

    const parsedBody = await readLimitedJsonBody(request);
    if (parsedBody.outcome === "too_large") {
      return jsonResponse(413, {
        success: false,
        code: "inquiry_payload_too_large",
        message: "Inquiry payload is too large."
      });
    }
    if (parsedBody.outcome === "invalid_json") {
      return jsonResponse(400, {
        success: false,
        code: "inquiry_invalid_json",
        message: "Request body must contain valid JSON."
      });
    }
    if (parsedBody.outcome === "duplicate_fields") {
      return jsonResponse(400, {
        success: false,
        code: "inquiry_invalid_fields",
        message: "Request contains duplicate fields."
      });
    }

    const rawData = parsedBody.data;
    const structureError = validatePayloadStructure(rawData);
    if (structureError) {
      return jsonResponse(400, { success: false, ...structureError });
    }
    const allowedFieldsError = validateAllowedFields(rawData);
    if (allowedFieldsError) {
      return jsonResponse(400, { success: false, ...allowedFieldsError });
    }

    const data = normalizePayload(rawData);
    const validationError = validateRequest(data);

    if (validationError) {
      return jsonResponse(400, {
        success: false,
        ...validationError
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

export {
  createHandler,
  inquiryFieldLengthLimits,
  insertInquiry,
  maxRequestBodyBytes
};
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
