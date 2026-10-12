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

function jsonResponse(statusCode, body) {
  return Response.json(body, { status: statusCode });
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

function normalizePayload(data) {
  const source = {};

  for (const [key, value] of Object.entries(data)) {
    source[toSnakeCase(key)] = value;
  }

  const payload = {
    form_type: normalizeRequiredText(source.form_type),
    client_name: normalizeRequiredText(source.client_name),
    client_email: normalizeRequiredText(source.client_email),
    message: normalizeRequiredText(source.message),
    request_id: normalizeOptionalText(source.request_id),
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

  if (!hasText(data.client_name)) {
    return "Missing required field: client_name.";
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

async function insertInquiry(db, data, now = () => new Date()) {
  const prepared = prepareInquiryConfirmationAutomation();
  const result = await db.pool.query(
    `WITH request_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtext($1))
     ),
     canonical_inquiry AS (
       INSERT INTO inquiries (
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
       )
       SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17
       FROM request_lock
       ON CONFLICT (source_submission_id) DO UPDATE
         SET source_submission_id = EXCLUDED.source_submission_id
       RETURNING inquiries.*, (xmax = 0) AS created
     ),
     existing_communication AS MATERIALIZED (
       SELECT c.id, c.automation_source_key
       FROM communications c
       JOIN canonical_inquiry i
         ON c.automation_source_key = 'inquiry-received:' || i.id::text
     ),
     inserted_communication AS (
       INSERT INTO communications (
         inquiry_id, channel, communication_type, communication_status,
         recipient, subject, body_snapshot, ready_at,
         template_key, template_version,
         automation_key, automation_mode, automation_source_key
       )
       SELECT
         i.id, $18, $19, 'ready', i.client_email,
         replace($20, $22, i.client_name),
         replace($21, $22, i.client_name),
         $23::timestamptz, $24, $25, $26, 'auto_send',
         'inquiry-received:' || i.id::text
       FROM canonical_inquiry i
       WHERE NOT EXISTS (SELECT 1 FROM existing_communication)
       ON CONFLICT (automation_source_key)
         WHERE automation_source_key IS NOT NULL
       DO NOTHING
       RETURNING id, automation_source_key
     ),
     canonical_communication AS (
       SELECT id, automation_source_key FROM inserted_communication
       UNION ALL
       SELECT id, automation_source_key FROM existing_communication
       LIMIT 1
     )
     SELECT row_to_json(i) AS inquiry, communication.id AS communication_id
     FROM canonical_inquiry i
     CROSS JOIN canonical_communication communication`,
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
      data.message,
      prepared.template.channel,
      prepared.template.communication_type,
      prepared.rendered.subject,
      prepared.rendered.body,
      inquiryClientNameToken,
      now(),
      prepared.template.key,
      prepared.template.version,
      prepared.policy.key
    ]
  );
  let row = result.rows[0];
  if (!row) {
    const existing = (await db.pool.query(
      "SELECT * FROM inquiries WHERE source_submission_id = $1",
      [data.request_id]
    )).rows[0];
    const communication = existing
      ? (await db.pool.query(
          "SELECT id FROM communications WHERE automation_source_key = $1",
          [`inquiry-received:${existing.id}`]
        )).rows[0]
      : null;
    if (!existing || !communication) {
      throw new Error("Inquiry confirmation outbox was not persisted.");
    }
    row = { inquiry: { ...existing, created: false }, communication_id: communication.id };
  }
  const inquiry = row.inquiry;
  if (!sameInquiryIntent(inquiry, data)) return { outcome: "request_conflict" };
  const created = Boolean(inquiry.created);
  delete inquiry.created;
  return {
    outcome: "success",
    created,
    inquiry,
    communication_id: row.communication_id
  };
}

function createHandler(options = getDatabase) {
  const {
    databaseFactory = getDatabase,
    environmentReader = readEnvironmentVariable,
    emailProvider = null,
    providerFetch = globalThis.fetch?.bind(globalThis),
    now = () => new Date()
  } = typeof options === "function" ? { databaseFactory: options } : options;
  const sendingProvider = emailProvider || createGmailEmailProvider({
    environmentReader,
    fetchImplementation: providerFetch,
    now
  });
  return async function handler(request) {
    if (request.method !== "POST") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use POST."
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

    try {
      data.request_id ||= randomUUID();
      const db = databaseFactory();
      const result = await insertInquiry(db, data, now);
      if (result.outcome === "request_conflict") {
        return jsonResponse(409, { success: false, message: "Request id is already in use." });
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
      console.error("Inquiry database insert failed.", {
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
