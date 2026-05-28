const allowedFormTypes = new Set([
  "contact",
  "artwork-inquiry",
  "commission-request",
  "collaboration"
]);

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

function validateRequest(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Request body must be valid JSON.";
  }

  if (!hasText(data.formType)) {
    return "Missing required field: formType.";
  }

  if (!allowedFormTypes.has(data.formType.trim())) {
    return "Unsupported formType.";
  }

  if (!hasText(data.clientName)) {
    return "Missing required field: clientName.";
  }

  if (!hasText(data.clientEmail)) {
    return "Missing required field: clientEmail.";
  }

  return "";
}

function normalizeRequest(data, requestId) {
  return {
    requestId,
    receivedAt: new Date().toISOString(),
    formType: String(data.formType).trim(),
    clientName: String(data.clientName).trim(),
    clientEmail: String(data.clientEmail).trim(),
    clientPhone: data.clientPhone ? String(data.clientPhone).trim() : "",
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

  const data = parseJsonBody(event.body);
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
    requestId
  });
};
