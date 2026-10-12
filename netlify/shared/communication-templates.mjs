const REVIEW_POLICY = "review_required";
const idPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const variablePattern = /{{\s*([a-z][a-z0-9_]*)\s*}}/g;

function template(definition) {
  return Object.freeze({
    version: 1,
    channel: "email",
    review_policy: REVIEW_POLICY,
    ...definition,
    required_context: Object.freeze([...definition.required_context])
  });
}

const communicationTemplates = Object.freeze([
  template({
    key: "inquiry_received_confirmation", name: "Inquiry Received Confirmation", communication_type: "inquiry_reply",
    required_context: ["inquiry_id"],
    subject_template: "Your inquiry was received by Sylva Ars Studio",
    body_template: "Dear {{client_name}},\n\nThank you for contacting Sylva Ars Studio. Your inquiry has been received successfully. I’ll review the information you shared and follow up with you directly.\n\nAdrian\nSylva Ars Studio"
  }),
  template({
    key: "inquiry_reply", name: "Inquiry Reply", communication_type: "inquiry_reply",
    required_context: ["inquiry_id"],
    subject_template: "Thank you for contacting Sylva Ars Studio",
    body_template: "Dear {{client_name}},\n\nThank you for contacting Sylva Ars Studio. We have reviewed your inquiry and will follow up with you shortly.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "quotation", name: "Quotation", communication_type: "quotation",
    required_context: ["quotation_id"],
    subject_template: "Quotation {{quotation_number}} for {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nYour quotation {{quotation_number}} (version {{quotation_version}}) for {{commission_title}} is ready for review.\n\nQuotation total: {{quotation_total}}\nRequired deposit: {{required_deposit}}\nEstimated completion: {{estimated_completion}}\n\nPlease refer to the quotation for the complete commercial details.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "quotation_acceptance_confirmation", name: "Quotation Acceptance Confirmation", communication_type: "quotation",
    required_context: ["quotation_id"],
    subject_template: "Quotation {{quotation_number}} acceptance recorded",
    body_template: "Dear {{client_name}},\n\nYour acceptance of quotation {{quotation_number}} (version {{quotation_version}}) for {{commission_title}} has been recorded successfully. I’ll follow up with you directly regarding the next steps.\n\nAdrian\nSylva Ars Studio"
  }),
  template({
    key: "contract", name: "Commission Agreement", communication_type: "contract",
    required_context: ["document_id"],
    subject_template: "Commission Agreement {{document_number}}",
    body_template: "Dear {{client_name}},\n\nCommission Agreement {{document_number}} for {{commission_title}} is ready for your review. Please refer to the agreement for the complete terms.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "payment_request", name: "Payment Request", communication_type: "payment_request",
    required_context: ["commission_id"],
    subject_template: "Payment request for {{commission_number}}",
    body_template: "Dear {{client_name}},\n\nThe required deposit for {{commission_title}} is {{required_deposit}}. Please refer to accepted quotation {{quotation_number}} for the complete commercial details.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "receipt", version: 2, name: "Payment Receipt", communication_type: "receipt",
    required_context: ["document_id"],
    subject_template: "Payment receipt {{document_number}}",
    body_template: "Dear {{client_name}},\n\nPayment receipt {{document_number}} for {{commercial_reference}} is available for your records.\n\nThank you,\nSylva Ars Studio"
  }),
  template({
    key: "final_invoice", name: "Final Invoice", communication_type: "final_invoice",
    required_context: ["document_id"],
    subject_template: "Final invoice {{document_number}}",
    body_template: "Dear {{client_name}},\n\nFinal invoice {{document_number}} for {{commission_number}} is available for your records. Please refer to the invoice for the complete financial details.\n\nThank you,\nSylva Ars Studio"
  }),
  template({
    key: "final_presentation", name: "Final Presentation", communication_type: "final_presentation",
    required_context: ["commission_id"],
    subject_template: "Final presentation — {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nThe final presentation for {{commission_title}} is ready for your review.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "delivery_ready", name: "Delivery Ready", communication_type: "delivery",
    required_context: ["commission_id"],
    subject_template: "{{commission_title}} is ready",
    body_template: "Dear {{client_name}},\n\n{{commission_title}} is ready for {{delivery_method}}. We will coordinate the remaining fulfillment details with you.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "pickup_scheduled", name: "Pickup Scheduled", communication_type: "delivery",
    required_context: ["commission_id"],
    subject_template: "Pickup scheduled for {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nPickup for {{commission_title}} is scheduled for {{pickup_date}}.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "shipping_notice", name: "Shipping Notice", communication_type: "delivery",
    required_context: ["commission_id"],
    subject_template: "Shipping notice for {{commission_title}}",
    body_template: "Dear {{client_name}},\n\n{{commission_title}} has shipped. Tracking number: {{tracking_number}}.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "storage_notice", name: "Storage Notice", communication_type: "storage_notice",
    required_context: ["commission_id"],
    subject_template: "Storage notice for {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nThis is a storage notice for {{commission_title}}. The current recorded storage fee is {{storage_fee}}. Please contact Sylva Ars Studio to coordinate fulfillment.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "final_storage_notice", name: "Final Storage Notice", communication_type: "final_storage_notice",
    required_context: ["commission_id"],
    subject_template: "Final storage notice for {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nA final written storage notice for {{commission_title}} was recorded on {{final_notice_date}}. Please contact Sylva Ars Studio regarding fulfillment and any outstanding storage obligations.\n\nWarmly,\nSylva Ars Studio"
  }),
  template({
    key: "thank_you", name: "Thank You", communication_type: "thank_you",
    required_context: ["commission_id"],
    subject_template: "Thank you — {{commission_title}}",
    body_template: "Dear {{client_name}},\n\nThank you for commissioning {{commission_title}} with Sylva Ars Studio. It has been an honor to create this work for you.\n\nWarmly,\nSylva Ars Studio"
  })
]);

const templateRegistry = new Map(communicationTemplates.map((item) => [item.key, item]));

function getCommunicationTemplate(key) {
  return templateRegistry.get(key) || null;
}

function listCommunicationTemplates() {
  return communicationTemplates.map(({ key, version, communication_type, channel, name, required_context, review_policy }) => ({
    key, version, communication_type, channel, name, required_context: [...required_context], review_policy
  }));
}

function requiredVariables(item) {
  const variables = new Set();
  for (const source of [item.subject_template, item.body_template]) {
    for (const match of source.matchAll(variablePattern)) variables.add(match[1]);
  }
  return [...variables];
}

function renderControlledText(source, context) {
  return source.replace(variablePattern, (_, key) => String(context[key]));
}

function renderCommunicationTemplate(item, context) {
  if (!item || !templateRegistry.has(item.key)) return { error: "unknown_template" };
  const missing = requiredVariables(item).filter((key) => {
    const value = context[key];
    return value === null || value === undefined || String(value).trim() === "";
  });
  if (missing.length) return { error: "template_context_incomplete", missing_context: missing };
  return {
    subject: renderControlledText(item.subject_template, context),
    body: renderControlledText(item.body_template, context),
    missing_context: []
  };
}

function normalizeTemplateRequest(data, { requestId = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }
  const allowed = new Set([
    "template_key", "inquiry_id", "client_id", "commission_id",
    "quotation_id", "document_id", ...(requestId ? ["request_id"] : [])
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    return { error: "Request body contains unsupported fields." };
  }
  if (typeof data.template_key !== "string" || !data.template_key.trim()) {
    return { error: "template_key is required." };
  }
  const normalized = { template_key: data.template_key.trim() };
  for (const field of ["client_id", "commission_id", "quotation_id", "document_id"]) {
    const value = data[field];
    if (value === null || value === undefined || value === "") normalized[field] = null;
    else if (!idPattern.test(String(value).trim())) return { error: `${field} is invalid.` };
    else normalized[field] = String(value).trim();
  }
  const inquiryId = data.inquiry_id;
  if (inquiryId === null || inquiryId === undefined || inquiryId === "") normalized.inquiry_id = null;
  else if (!uuidPattern.test(String(inquiryId).trim())) return { error: "inquiry_id is invalid." };
  else normalized.inquiry_id = String(inquiryId).trim().toLowerCase();
  if (requestId) {
    const value = data.request_id;
    if (value === null || value === undefined || value === "") normalized.request_id = null;
    else if (!uuidPattern.test(String(value).trim())) return { error: "request_id must be a valid UUID." };
    else normalized.request_id = String(value).trim().toLowerCase();
  }
  return { request: normalized };
}

function formatCurrency(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : null;
}

function formatDate(value) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const source = String(value || "");
  if (source.includes("T")) {
    const date = new Date(source);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${months[Number(parts.month) - 1]} ${Number(parts.day)}, ${parts.year}`;
  }
  const match = source.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

async function resolveInquiry(db, request) {
  if (!request.inquiry_id) return { missing: ["inquiry_id"] };
  const row = (await db.pool.query(
    "SELECT id, client_name, client_email FROM inquiries WHERE id = $1",
    [request.inquiry_id]
  )).rows[0];
  if (!row) return { missing: ["inquiry_id"] };
  return {
    recipient: row.client_email,
    context: { client_name: row.client_name },
    relationships: { inquiry_id: row.id, client_id: null, commission_id: null, quotation_id: null, document_id: null }
  };
}

async function resolveQuotation(db, request) {
  if (!request.quotation_id) return { missing: ["quotation_id"] };
  const row = (await db.pool.query(
    `SELECT q.id, q.commission_id, q.quotation_status, q.quotation_snapshot,
            c.client_id, cl.full_name, cl.email
     FROM quotations q
     JOIN commissions c ON c.id = q.commission_id
     JOIN clients cl ON cl.id = c.client_id
     WHERE q.id = $1`,
    [request.quotation_id]
  )).rows[0];
  if (!row) return { missing: ["quotation_id"] };
  if (!row.quotation_snapshot || !["issued", "sent", "accepted"].includes(row.quotation_status)) {
    return { missing: ["quotation_snapshot"] };
  }
  const snapshot = row.quotation_snapshot;
  return {
    recipient: row.email,
    context: {
      client_name: row.full_name,
      commission_title: snapshot.commission?.title,
      quotation_number: snapshot.quotation_number,
      quotation_version: snapshot.version,
      quotation_total: formatCurrency(snapshot.commercial?.total),
      required_deposit: formatCurrency(snapshot.commercial?.required_deposit),
      estimated_completion: formatDate(snapshot.commercial?.estimated_completion)
    },
    relationships: {
      inquiry_id: null, client_id: row.client_id, commission_id: row.commission_id,
      quotation_id: row.id, document_id: null
    }
  };
}

async function resolveDocument(db, request, documentType) {
  if (!request.document_id) return { missing: ["document_id"] };
  const row = (await db.pool.query(
    `SELECT d.id, d.document_type, d.document_number, d.document_snapshot,
            d.receipt_snapshot, d.quotation_id, d.commission_id,
            COALESCE(d.client_id, c.client_id) AS client_id,
            c.commission_number, c.title, q.quotation_number,
            cl.full_name, cl.email
     FROM documents d
     LEFT JOIN commissions c ON c.id = d.commission_id
     LEFT JOIN quotations q ON q.id = d.quotation_id
     JOIN clients cl ON cl.id = COALESCE(d.client_id, c.client_id)
     WHERE d.id = $1`,
    [request.document_id]
  )).rows[0];
  if (!row || row.document_type !== documentType) return { missing: ["document_id"] };
  const snapshot = row.document_snapshot || row.receipt_snapshot;
  if (!snapshot) return { missing: ["document_snapshot"] };
  const snapshotTitle = snapshot.artwork?.title || snapshot.commission?.title;
  return {
    recipient: snapshot.client?.email || row.email,
    context: {
      client_name: snapshot.client?.name || snapshot.client?.full_name || row.full_name,
      commission_number: snapshot.commission?.commission_number || row.commission_number,
      commercial_reference: snapshot.commission?.number
        || snapshot.commission?.commission_number
        || snapshot.quotation?.number
        || row.commission_number
        || row.quotation_number,
      commission_title: snapshotTitle,
      document_number: row.document_number
    },
    relationships: {
      inquiry_id: null, client_id: row.client_id, commission_id: row.commission_id,
      quotation_id: row.quotation_id, document_id: row.id
    }
  };
}

async function resolveCommission(db, request, templateKey) {
  if (!request.commission_id) return { missing: ["commission_id"] };
  const row = (await db.pool.query(
    `SELECT c.id, c.client_id, c.commission_number, c.title,
            cl.full_name, cl.email,
            p.production_status, p.final_presented_at,
            d.id AS delivery_id, d.delivery_method, d.delivery_status,
            d.scheduled_at, d.shipped_at, d.tracking_number,
            d.storage_notice_at, d.final_notice_at,
            aq.id AS quotation_id, aq.quotation_snapshot,
            sf.amount AS storage_fee
     FROM commissions c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN commission_production p ON p.commission_id = c.id
     LEFT JOIN deliveries d ON d.commission_id = c.id
     LEFT JOIN LATERAL (
       SELECT q.id, q.quotation_snapshot
       FROM quotations q
       WHERE q.commission_id = c.id AND q.quotation_status = 'accepted'
       ORDER BY q.accepted_at DESC NULLS LAST, q.id DESC LIMIT 1
     ) aq ON TRUE
     LEFT JOIN LATERAL (
       SELECT o.amount
       FROM commission_obligations o
       WHERE o.commission_id = c.id
         AND o.obligation_type = 'storage_fee'
         AND o.obligation_status = 'open'
       ORDER BY o.id DESC LIMIT 1
     ) sf ON TRUE
     WHERE c.id = $1`,
    [request.commission_id]
  )).rows[0];
  if (!row) return { missing: ["commission_id"] };

  const missing = [];
  const accepted = row.quotation_snapshot;
  if (templateKey === "payment_request" && !accepted) missing.push("accepted_quotation_snapshot");
  if (templateKey === "final_presentation" && !row.final_presented_at) missing.push("final_presented_at");
  if (templateKey === "delivery_ready" && row.delivery_status !== "ready") missing.push("delivery_ready");
  if (templateKey === "pickup_scheduled" && !(row.delivery_method === "pickup" && row.delivery_status === "scheduled" && row.scheduled_at)) missing.push("pickup_scheduled");
  if (templateKey === "shipping_notice" && !(row.delivery_method === "shipping" && ["shipped", "delivered"].includes(row.delivery_status) && row.tracking_number)) missing.push("shipping_tracking");
  if (templateKey === "storage_notice" && !row.storage_notice_at) missing.push("storage_notice_at");
  if (templateKey === "storage_notice" && row.storage_fee === null) missing.push("storage_fee");
  if (templateKey === "final_storage_notice" && !row.final_notice_at) missing.push("final_notice_at");
  if (missing.length) return { missing };

  return {
    recipient: row.email,
    context: {
      client_name: row.full_name,
      commission_number: row.commission_number,
      commission_title: row.title,
      quotation_number: accepted?.quotation_number,
      required_deposit: formatCurrency(accepted?.commercial?.required_deposit),
      delivery_method: row.delivery_method === "pickup" ? "pickup" : row.delivery_method === "shipping" ? "shipping" : null,
      pickup_date: formatDate(row.scheduled_at),
      tracking_number: row.tracking_number,
      storage_fee: formatCurrency(row.storage_fee),
      final_notice_date: formatDate(row.final_notice_at)
    },
    relationships: {
      inquiry_id: null, client_id: row.client_id, commission_id: row.id,
      quotation_id: row.quotation_id, document_id: null
    }
  };
}

async function resolveCommunicationTemplate(db, request) {
  const item = getCommunicationTemplate(request.template_key);
  if (!item) return { outcome: "unknown_template" };
  const missingIdentifiers = item.required_context.filter((field) => !request[field]);
  if (missingIdentifiers.length) {
    return { outcome: "template_context_incomplete", template: item, missing_context: missingIdentifiers };
  }

  let resolved;
  if (["inquiry_reply", "inquiry_received_confirmation"].includes(item.key)) resolved = await resolveInquiry(db, request);
  else if (["quotation", "quotation_acceptance_confirmation"].includes(item.key)) resolved = await resolveQuotation(db, request);
  else if (item.key === "contract") resolved = await resolveDocument(db, request, "contract");
  else if (item.key === "receipt") resolved = await resolveDocument(db, request, "receipt");
  else if (item.key === "final_invoice") resolved = await resolveDocument(db, request, "invoice");
  else resolved = await resolveCommission(db, request, item.key);

  if (resolved.missing?.length) {
    return { outcome: "template_context_incomplete", template: item, missing_context: resolved.missing };
  }
  const rendered = renderCommunicationTemplate(item, resolved.context);
  if (rendered.error) {
    return { outcome: rendered.error, template: item, missing_context: rendered.missing_context };
  }
  return {
    outcome: "success",
    template: item,
    recipient: resolved.recipient,
    subject: rendered.subject,
    body: rendered.body,
    relationships: resolved.relationships,
    missing_context: []
  };
}

export {
  REVIEW_POLICY,
  communicationTemplates,
  getCommunicationTemplate,
  listCommunicationTemplates,
  normalizeTemplateRequest,
  renderCommunicationTemplate,
  requiredVariables,
  resolveCommunicationTemplate
};
