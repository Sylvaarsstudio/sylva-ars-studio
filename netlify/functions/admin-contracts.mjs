import { getDatabase } from "@netlify/database";

import businessInformation from "../../web/js/business-info.js";
import { hasValidAdminSession } from "../shared/admin-session.mjs";
import {
  eligibilityMessage,
  resolveAcceptedQuotation
} from "../shared/contract-eligibility.mjs";
import {
  COMMISSION_AGREEMENT_TERMS,
  cloneContractTerms
} from "../shared/contract-terms.mjs";

const PREPARE_PATH = "/admin/api/contracts/prepare";
const ELIGIBILITY_PATH = "/admin/api/contracts/eligibility";
const ISSUE_PATH = "/admin/api/documents/contracts";
const commissionIdPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const eligibleStatuses = new Set(["quoted", "approved"]);
const contractNumberLockNamespace = 20261020;
const contractSubtype = "commission_agreement";
const requiredDepositRate = "0.50";
const issuanceLockedMessage =
  "Contract terms are still under review and contract issuance is not enabled.";
const createFields = new Set([
  "request_id",
  "commission_id",
  "subtype",
  "contract_date",
  "optional_message",
  "delivery_notes"
]);

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name);
  }

  return process.env[name];
}

function getCalendarDateInTimeZone(date, timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(value) {
  if (!datePattern.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function formatCents(value) {
  return (value / 100).toFixed(2);
}

function calculateContractFinancials(commission) {
  const priceCents = toCents(commission.price);
  const salesTaxCents = toCents(commission.sales_tax);
  const shippingCents = toCents(commission.shipping);
  const requiredDepositCents = Math.round(priceCents * 0.5);
  const totalCents = priceCents + salesTaxCents + shippingCents;

  return {
    price: formatCents(priceCents),
    required_deposit_rate: requiredDepositRate,
    required_deposit: formatCents(requiredDepositCents),
    sales_tax: formatCents(salesTaxCents),
    shipping: formatCents(shippingCents),
    total: formatCents(totalCents),
    estimated_remaining_after_required_deposit: formatCents(
      totalCents - requiredDepositCents
    )
  };
}

function normalizeDocumentFields(data = {}) {
  return {
    optional_message: typeof data.optional_message === "string"
      ? data.optional_message.trim()
      : "",
    delivery_notes: typeof data.delivery_notes === "string"
      ? data.delivery_notes.trim()
      : ""
  };
}

function buildContractSnapshot({
  source,
  commission,
  contractDate,
  terms,
  documentFields = {},
  number = null,
  version = null,
  issuedAt = null,
  supersedesDocumentId = null,
  status = "draft"
}) {
  if (!source) {
    return buildLegacyContractSnapshot({
      commission, contractDate, terms, documentFields, number,
      version, issuedAt, supersedesDocumentId, status
    });
  }
  const quotationSnapshot = source.quotation.quotation_snapshot;
  const quotedClient = quotationSnapshot.client;
  const quotedCommission = quotationSnapshot.commission;
  const commercial = quotationSnapshot.commercial;
  const totalCents = toCents(commercial.total);
  const requiredDepositCents = toCents(commercial.required_deposit);

  return {
    schema_version: 2,
    contract: {
      document_number: number,
      version,
      subtype: contractSubtype,
      contract_date: contractDate,
      issued_at: issuedAt,
      terms_version: terms.version,
      supersedes_document_id: supersedesDocumentId,
      status
    },
    studio: {
      name: businessInformation.name,
      address_line_1: businessInformation.addressLine1,
      address_line_2: businessInformation.addressLine2,
      email: businessInformation.email,
      phone: businessInformation.phone,
      website: businessInformation.website
    },
    client: {
      client_id: String(source.commission.client_id),
      full_name: quotedClient.full_name,
      email: quotedClient.email,
      phone: quotedClient.phone || null
    },
    commission: {
      commission_id: String(source.quotation.commission_id),
      commission_number: quotedCommission.commission_number
    },
    quotation: {
      quotation_id: String(source.quotation.id),
      quotation_number: source.quotation.quotation_number,
      quotation_version: Number(source.quotation.version),
      quotation_snapshot_hash: source.quotation.snapshot_hash,
      quotation_accepted_at: source.acceptance.accepted_at,
      quotation_acceptance_id: String(source.acceptance.id)
    },
    artwork: {
      title: quotedCommission.title,
      description: quotedCommission.description,
      medium: quotedCommission.medium,
      dimensions: structuredClone(quotedCommission.dimensions)
    },
    commercial_terms: {
      price: commercial.price,
      sales_tax_rate: commercial.sales_tax_rate,
      sales_tax: commercial.sales_tax,
      shipping_charge: commercial.shipping_charge,
      required_deposit_rate: commercial.required_deposit_rate,
      required_deposit: commercial.required_deposit,
      total: commercial.total,
      estimated_remaining_after_required_deposit: formatCents(totalCents - requiredDepositCents),
      estimated_completion: commercial.estimated_completion,
      special_terms: commercial.special_terms || null
    },
    terms: cloneContractTerms(terms),
    document_fields: normalizeDocumentFields(documentFields),
    signatures: {
      mode: "manual",
      labels: ["Artist Signature", "Date", "Client Signature", "Date"]
    }
  };
}

function buildLegacyContractSnapshot({
  commission,
  contractDate,
  terms,
  documentFields = {},
  number = null,
  version = null,
  issuedAt = null,
  supersedesDocumentId = null,
  status = "draft"
}) {
  return {
    schema_version: 1,
    contract: {
      number,
      version,
      subtype: contractSubtype,
      contract_date: contractDate,
      issued_at: issuedAt,
      terms_version: terms.version,
      supersedes_document_id: supersedesDocumentId,
      status
    },
    studio: {
      name: businessInformation.name,
      address_line_1: businessInformation.addressLine1,
      address_line_2: businessInformation.addressLine2,
      email: businessInformation.email,
      phone: businessInformation.phone,
      website: businessInformation.website
    },
    client: {
      id: commission.client_id,
      name: commission.client_name,
      email: commission.client_email,
      phone: commission.client_phone,
      address_line_1: commission.address_line_1,
      address_line_2: commission.address_line_2,
      city: commission.city,
      state: commission.state,
      postal_code: commission.postal_code,
      country: commission.country
    },
    commission: {
      id: commission.id,
      number: commission.commission_number,
      title: commission.title,
      description: commission.description,
      medium: commission.medium,
      width: commission.width,
      height: commission.height,
      estimated_completion: commission.estimated_completion,
      status_at_issue: commission.status
    },
    financial: calculateContractFinancials(commission),
    terms: cloneContractTerms(terms),
    document_fields: normalizeDocumentFields(documentFields),
    signatures: {
      mode: "manual",
      labels: ["Artist Signature", "Date", "Client Signature", "Date"]
    }
  };
}

async function getCommissionContext(db, commissionId) {
  const result = await db.pool.query(
    `SELECT
       c.id,
       c.commission_number,
       c.client_id,
       c.title,
       c.description,
       c.medium,
       c.width,
       c.height,
       c.price,
       c.deposit_amount,
       c.amount_paid,
       c.sales_tax,
       c.shipping,
       c.estimated_completion,
       c.status,
       cl.full_name AS client_name,
       cl.email AS client_email,
       cl.phone AS client_phone,
       cl.address_line_1,
       cl.address_line_2,
       cl.city,
       cl.state,
       cl.postal_code,
       cl.country
     FROM commissions c
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.id = $1`,
    [commissionId]
  );

  return result.rows[0] || null;
}

function normalizePrepare(searchParams, now = new Date()) {
  const commissionId = searchParams.get("commission_id") || "";
  const requestedDate = searchParams.get("contract_date");
  const contractDate = requestedDate || getCalendarDateInTimeZone(now);

  if (!commissionIdPattern.test(commissionId)) {
    return { error: "Invalid commission id." };
  }

  if (!isValidDate(contractDate)) {
    return { error: "Invalid contract date." };
  }

  return { commissionId, contractDate };
}

function normalizeCreate(data = {}) {
  const unexpectedFields = Object.keys(data).filter((field) => !createFields.has(field));

  if (unexpectedFields.length) {
    return { error: "Request contains unsupported fields." };
  }

  if (typeof data.request_id !== "string" || !uuidPattern.test(data.request_id.trim())) {
    return { error: "Request id must be a valid UUID." };
  }

  if (!commissionIdPattern.test(String(data.commission_id || ""))) {
    return { error: "Invalid commission id." };
  }

  if (data.subtype !== contractSubtype) {
    return { error: "Unsupported contract subtype." };
  }

  if (typeof data.contract_date !== "string" || !isValidDate(data.contract_date)) {
    return { error: "Invalid contract date." };
  }

  return {
    value: {
      request_id: data.request_id.trim().toLowerCase(),
      commission_id: String(data.commission_id),
      subtype: contractSubtype,
      contract_date: data.contract_date,
      ...normalizeDocumentFields(data)
    }
  };
}

async function getNextContractNumber(connection, year) {
  await connection.query(
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
    [contractNumberLockNamespace, year]
  );
  const result = await connection.query(
    `SELECT COALESCE(MAX(split_part(document_number, '-', 4)::integer), 0) + 1 AS next_number
     FROM documents
     WHERE document_type = 'contract'
       AND document_number LIKE $1`,
    [`SAS-CON-${year}-%`]
  );

  return `SAS-CON-${year}-${String(result.rows[0].next_number).padStart(4, "0")}`;
}

function getNextContractVersion(currentVersion) {
  const normalized = Number(currentVersion);
  return Number.isInteger(normalized) && normalized > 0 ? normalized + 1 : 1;
}

function sameContractIntent(document, data) {
  const snapshot = document.document_snapshot;
  const documentFields = snapshot?.document_fields || {};

  return String(document.commission_id) === String(data.commission_id)
    && snapshot?.contract?.subtype === data.subtype
    && snapshot?.contract?.contract_date === data.contract_date
    && documentFields.optional_message === data.optional_message
    && documentFields.delivery_notes === data.delivery_notes;
}

async function createContract(db, data, terms, now = () => new Date()) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-contract-family'), hashtext($1::text))",
      [`${data.commission_id}:${data.subtype}`]
    );
    const existingRequest = (await connection.query(
      `SELECT id, commission_id, document_number, version, file_location, document_snapshot
       FROM documents
       WHERE request_id = $1`,
      [data.request_id]
    )).rows[0];

    if (existingRequest) {
      await connection.query("COMMIT");
      return sameContractIntent(existingRequest, data)
        ? { outcome: "success", created: false, document: existingRequest }
        : { outcome: "request_id_conflict" };
    }

    const source = await resolveAcceptedQuotation(connection, data.commission_id, now(), { lock: true });

    if (source.outcome === "not_found") {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    if (source.outcome === "contract_conflict") {
      await connection.query("ROLLBACK");
      return { outcome: "duplicate_family", document: source.existingContract };
    }

    if (source.outcome !== "eligible") {
      await connection.query("ROLLBACK");
      return { outcome: "ineligible", reason: source.outcome };
    }

    const existingFamily = (await connection.query(
      `SELECT id, document_number, version, file_location
       FROM documents
       WHERE commission_id = $1
         AND document_type = 'contract'
         AND quotation_id = $3
         AND document_snapshot -> 'contract' ->> 'subtype' = $2
       ORDER BY version DESC, id DESC
       LIMIT 1`,
      [data.commission_id, data.subtype, source.quotation.id]
    )).rows[0];

    if (existingFamily) {
      await connection.query("ROLLBACK");
      return { outcome: "duplicate_family", document: existingFamily };
    }

    const year = Number(data.contract_date.slice(0, 4));
    const documentNumber = await getNextContractNumber(connection, year);
    const issuedAt = now().toISOString();
    const snapshot = buildContractSnapshot({
      source,
      contractDate: data.contract_date,
      terms,
      documentFields: data,
      number: documentNumber,
      version: 1,
      issuedAt,
      status: "issued"
    });
    const inserted = (await connection.query(
      `INSERT INTO documents (
         commission_id, document_type, document_number, version,
         file_location, document_snapshot, request_id, quotation_id
       )
       VALUES ($1, 'contract', $2, 1, '/admin/contract.html', $3::jsonb, $4, $5)
       RETURNING id, commission_id, document_number, version, file_location, document_snapshot, quotation_id`,
      [data.commission_id, documentNumber, JSON.stringify(snapshot), data.request_id, source.quotation.id]
    )).rows[0];
    const fileLocation = `/admin/contract.html?document=${inserted.id}`;
    const document = (await connection.query(
      `UPDATE documents
       SET file_location = $1
       WHERE id = $2
       RETURNING id, commission_id, document_number, version, file_location, document_snapshot, quotation_id`,
      [fileLocation, inserted.id]
    )).rows[0];

    await connection.query("COMMIT");
    return { outcome: "success", created: true, document };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function logFailure(action, error, details = {}) {
  console.error("Admin contract request failed.", {
    action,
    ...details,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  termsDefinition = COMMISSION_AGREEMENT_TERMS,
  now = () => new Date()
} = {}) {
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;

    if (!adminPassword) {
      return jsonResponse(500, { success: false, message: "Admin authentication is not configured." });
    }

    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, { success: false, message: "Unauthorized." });
    }

    const url = new URL(request.url);
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";

    if (normalizedPath === PREPARE_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }

      const normalized = normalizePrepare(url.searchParams, now());

      if (normalized.error) {
        return jsonResponse(400, { success: false, message: normalized.error });
      }

      try {
        const source = await resolveAcceptedQuotation(
          databaseFactory(),
          normalized.commissionId,
          now()
        );

        if (source.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }

        if (source.outcome !== "eligible") {
          return jsonResponse(409, {
            success: false,
            message: eligibilityMessage(source.outcome),
            reason: source.outcome
          });
        }

        const snapshot = buildContractSnapshot({
          source,
          contractDate: normalized.contractDate,
          terms: termsDefinition
        });

        return jsonResponse(200, {
          success: true,
          issuance_enabled: termsDefinition.approved === true,
          message: issuanceLockedMessage,
          snapshot
        });
      } catch (error) {
        logFailure("prepare", error, { commission_id: normalized.commissionId });
        return jsonResponse(500, { success: false, message: "Unable to prepare contract." });
      }
    }

    if (normalizedPath === ELIGIBILITY_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }

      const commissionId = url.searchParams.get("commission_id") || "";
      if (!commissionIdPattern.test(commissionId)) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }

      try {
        const result = await resolveAcceptedQuotation(databaseFactory(), commissionId, now());
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        const eligible = result.outcome === "eligible";
        return jsonResponse(200, {
          success: true,
          eligible,
          reason: eligible ? null : result.outcome,
          message: eligible
            ? "Contract draft preparation is available."
            : eligibilityMessage(result.outcome),
          quotation: eligible ? {
            id: result.quotation.id,
            quotation_number: result.quotation.quotation_number,
            version: result.quotation.version,
            accepted_at: result.acceptance.accepted_at
          } : null
        });
      } catch (error) {
        logFailure("eligibility", error, { commission_id: commissionId });
        return jsonResponse(500, { success: false, message: "Unable to verify contract eligibility." });
      }
    }

    if (normalizedPath === ISSUE_PATH) {
      if (request.method !== "POST") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
      }

      if (termsDefinition.approved !== true) {
        return jsonResponse(423, { success: false, message: issuanceLockedMessage });
      }

      let data;

      try {
        data = await request.json();
      } catch {
        return jsonResponse(400, { success: false, message: "Request body must be valid JSON." });
      }

      const normalized = normalizeCreate(data);

      if (normalized.error) {
        return jsonResponse(400, { success: false, message: normalized.error });
      }

      try {
        const result = await createContract(databaseFactory(), normalized.value, termsDefinition, now);

        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }

        if (result.outcome === "ineligible") {
          return jsonResponse(409, {
            success: false,
            message: eligibilityMessage(result.reason),
            reason: result.reason
          });
        }

        if (result.outcome === "request_id_conflict") {
          return jsonResponse(409, { success: false, message: "Request id is already used for another contract intent." });
        }

        if (result.outcome === "duplicate_family") {
          return jsonResponse(409, {
            success: false,
            message: "A contract already exists for this commission.",
            document: result.document
          });
        }

        return jsonResponse(result.created ? 201 : 200, {
          success: true,
          created: result.created,
          document: result.document
        });
      } catch (error) {
        logFailure("issue", error);
        return jsonResponse(500, { success: false, message: "Unable to issue contract." });
      }
    }

    return jsonResponse(404, { success: false, message: "Admin endpoint not found." });
  };
}

export const config = {
  path: [
    "/admin/api/contracts/prepare",
    "/admin/api/contracts/eligibility",
    "/admin/api/documents/contracts"
  ]
};

export {
  PREPARE_PATH,
  ELIGIBILITY_PATH,
  ISSUE_PATH,
  buildContractSnapshot,
  buildLegacyContractSnapshot,
  calculateContractFinancials,
  contractNumberLockNamespace,
  contractSubtype,
  createContract,
  createHandler,
  eligibleStatuses,
  getCalendarDateInTimeZone,
  getCommissionContext,
  getNextContractNumber,
  getNextContractVersion,
  eligibilityMessage,
  issuanceLockedMessage,
  normalizeCreate,
  normalizePrepare,
  resolveAcceptedQuotation
};

export default createHandler();
