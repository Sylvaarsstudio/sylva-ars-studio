const allowedFormTypes = new Set([
  "contact",
  "artwork_inquiry",
  "commission_request",
  "collaboration"
]);

const formTypeAliases = {
  "artwork-inquiry": "artwork_inquiry",
  "commission-request": "commission_request"
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function createRequestId(date = new Date()) {
  const year = date.getUTCFullYear();
  const timestamp = date
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(4);

  return `SSA-REQ-${year}-${timestamp}`;
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

function normalizeFormType(value) {
  const formType = String(value || "").trim();
  return formTypeAliases[formType] || formType;
}

function normalizePayload(data) {
  const payload = {};

  for (const [key, value] of Object.entries(data)) {
    payload[toSnakeCase(key)] =
      typeof value === "string" ? value.trim() : value;
  }

  payload.form_type = normalizeFormType(payload.form_type);
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

  return "";
}

function normalizeRequest(data, requestId) {
  return {
    request_id: requestId,
    received_at: new Date().toISOString(),
    form_type: data.form_type,
    client_name: data.client_name,
    client_email: data.client_email,
    client_phone: data.client_phone || "",
    payload: data
  };
}

exports.handler = async function handler(event) {
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

  const requestId = createRequestId();
  const structuredRequest = normalizeRequest(data, requestId);

  console.log("Sylva Ars Studio request received:", structuredRequest);

  return jsonResponse(200, {
    success: true,
    message: "Request received",
    request_id: requestId
  });
};
