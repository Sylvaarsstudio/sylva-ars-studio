const { getDatabase } = require("@netlify/database");

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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(body) {
  if (!body) {
    return null;
  }

  try {
    return JSON.parse(body);
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

async function insertInquiry(db, data) {
  const inserted = await db.pool.query(
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
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17
     )
     RETURNING id, status, created_at`,
    [
      null,
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
  );

  return inserted.rows[0];
}

function createHandler(databaseFactory = getDatabase) {
  return async function handler(event) {
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use POST."
      });
    }

    const rawData = parseJsonBody(event.body);
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
      const inquiry = await insertInquiry(databaseFactory(), data);

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

exports.createHandler = createHandler;
exports.handler = createHandler();
exports.insertInquiry = insertInquiry;
