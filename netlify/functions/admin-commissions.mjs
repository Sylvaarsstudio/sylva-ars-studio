import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import {
  createCommissionDelivery,
  enterCommissionStorage,
  evaluateDeliveryReleaseEligibility,
  normalizeDeliveryCreate,
  normalizeDeliveryTransition,
  normalizeDeliveryUpdate,
  recordStorageNotice,
  readCommissionDelivery,
  transitionCommissionDelivery,
  updateCommissionDelivery
} from "../shared/commission-delivery.mjs";
import { appendCommissionEvent } from "../shared/commission-events.mjs";
import { readCommissionNextAction } from "../shared/commission-next-action.mjs";
import { readCommissionObligations } from "../shared/commission-obligations.mjs";
import {
  initializeCommissionProduction,
  readCommissionProduction
} from "../shared/commission-production.mjs";

const API_PATH = "/admin/api/commissions";
const commissionIdPattern = /^[1-9][0-9]*$/;
const inquiryIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commissionNumberLockNamespace = 20260910;
const allowedMediums = new Set([
  "Acrylic",
  "Watercolor",
  "Oil",
  "Drawing"
]);
const allowedSalesTaxRates = new Map([
  ["0.00", 0],
  ["0.06", 6],
  ["0.07", 7],
  ["0.08", 8]
]);
const allowedCommissionStatuses = new Set([
  "draft",
  "quoted",
  "approved",
  "in_progress",
  "completed",
  "cancelled"
]);
const commissionStatusTransitions = new Map([
  ["draft", new Set(["quoted", "cancelled"])],
  ["quoted", new Set(["draft", "approved", "cancelled"])],
  ["approved", new Set(["quoted", "in_progress", "cancelled"])],
  ["in_progress", new Set(["approved", "completed", "cancelled"])],
  ["completed", new Set(["in_progress"])],
  ["cancelled", new Set(["draft"])]
]);
const createFields = new Set([
  "client_id",
  "title",
  "description",
  "medium",
  "width",
  "height",
  "price",
  "sales_tax_rate",
  "shipping",
  "estimated_completion",
  "origin_inquiry_id"
]);
const editFields = new Set([
  "title",
  "description",
  "medium",
  "width",
  "height",
  "price",
  "sales_tax_rate",
  "shipping",
  "estimated_completion"
]);

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name);
  }

  return process.env[name];
}

function getCommissionId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (normalizedPath === API_PATH) {
    return null;
  }

  if (!normalizedPath.startsWith(`${API_PATH}/`)) {
    return undefined;
  }

  const encodedId = normalizedPath.slice(API_PATH.length + 1);

  if (!encodedId || encodedId.includes("/")) {
    return undefined;
  }

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return undefined;
  }
}

function getCommissionStatusId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  if (!normalizedPath.startsWith(`${API_PATH}/`)) {
    return null;
  }

  const segments = normalizedPath.slice(API_PATH.length + 1).split("/");

  if (segments.length !== 2 || segments[1] !== "status" || !segments[0]) {
    return null;
  }

  try {
    return decodeURIComponent(segments[0]);
  } catch {
    return undefined;
  }
}

function getCommissionEventsId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(/^\/admin\/api\/commissions\/([^/]+)\/events$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionProductionId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(/^\/admin\/api\/commissions\/([^/]+)\/production$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionNextActionId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(/^\/admin\/api\/commissions\/([^/]+)\/next-action$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionObligationsId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(/^\/admin\/api\/commissions\/([^/]+)\/obligations$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionDeliveryId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(/^\/admin\/api\/commissions\/([^/]+)\/delivery$/);

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionDeliveryTransitionId(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(
    /^\/admin\/api\/commissions\/([^/]+)\/delivery\/transition$/
  );

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function getCommissionDeliveryStorageAction(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  const match = normalizedPath.match(
    /^\/admin\/api\/commissions\/([^/]+)\/delivery\/(storage|storage-notice|final-notice)$/
  );
  if (!match) return null;
  try {
    return { commissionId: decodeURIComponent(match[1]), action: match[2] };
  } catch {
    return { commissionId: undefined, action: match[2] };
  }
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeRequiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    return { error: `${label} is required.` };
  }

  return { value: value.trim() };
}

function normalizeNumber(value, options = {}) {
  const normalized = typeof value === "string" ? value.trim() : value;

  if (normalized === null || normalized === undefined || normalized === "") {
    return options.required
      ? { error: `${options.label} is required.` }
      : { value: options.defaultValue ?? null };
  }

  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    return { error: `${options.label} must be a valid number.` };
  }

  if (options.positive ? number <= 0 : number < 0) {
    return {
      error: options.positive
        ? `${options.label} must be greater than 0.`
        : `${options.label} must be 0 or greater.`
    };
  }

  return { value: number };
}

function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function normalizeMoney(value, label) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");

  if (!normalized) {
    return { error: `${label} is required.` };
  }

  if (normalized.startsWith("-")) {
    return { error: `${label} must be 0 or greater.` };
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { error: `${label} must be a valid monetary amount.` };
  }

  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));

  if (!Number.isSafeInteger(cents) || cents > 999999999999) {
    return { error: `${label} is outside the supported range.` };
  }

  return {
    cents,
    value: formatCents(cents)
  };
}

function normalizeSalesTaxRate(value) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");

  if (!normalized) {
    return { error: "Sales tax rate is required." };
  }

  const percent = allowedSalesTaxRates.get(normalized);

  if (percent === undefined) {
    return { error: "Sales tax rate is unsupported." };
  }

  return { percent };
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: "Estimated completion must be a valid date." };
  }

  const normalized = value.trim();
  const date = new Date(`${normalized}T00:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== normalized
  ) {
    return { error: "Estimated completion must be a valid date." };
  }

  return { value: normalized };
}

function normalizeCommissionCreate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  if (Object.keys(data).some((field) => !createFields.has(field))) {
    return { error: "Request body contains unsupported fields." };
  }

  const clientId = typeof data.client_id === "string"
    ? data.client_id.trim()
    : String(data.client_id ?? "");

  if (!commissionIdPattern.test(clientId)) {
    return { error: "Client is required." };
  }

  const title = normalizeRequiredText(data.title, "Title");
  const description = normalizeRequiredText(data.description, "Description");
  const medium = normalizeRequiredText(data.medium, "Medium");
  const width = normalizeNumber(data.width, { label: "Width", positive: true });
  const height = normalizeNumber(data.height, { label: "Height", positive: true });
  const price = normalizeMoney(data.price, "Price");
  const salesTaxRate = normalizeSalesTaxRate(data.sales_tax_rate);
  const shipping = normalizeNumber(data.shipping, {
    label: "Shipping",
    defaultValue: 0
  });
  const estimatedCompletion = normalizeDate(data.estimated_completion);
  const originInquiryId = typeof data.origin_inquiry_id === "string"
    ? data.origin_inquiry_id.trim()
    : data.origin_inquiry_id;
  const firstError = [
    title,
    description,
    medium,
    width,
    height,
    price,
    salesTaxRate,
    shipping,
    estimatedCompletion
  ].find((result) => result.error);

  if (firstError) {
    return { error: firstError.error };
  }

  if (!allowedMediums.has(medium.value)) {
    return { error: "Medium is unsupported." };
  }

  if (
    originInquiryId !== null
    && originInquiryId !== undefined
    && originInquiryId !== ""
    && !inquiryIdPattern.test(originInquiryId)
  ) {
    return { error: "Origin inquiry id is invalid." };
  }

  const salesTaxCents = Math.round(price.cents * salesTaxRate.percent / 100);

  return {
    commission: {
      client_id: clientId,
      title: title.value,
      description: description.value,
      medium: medium.value,
      width: width.value,
      height: height.value,
      price: price.value,
      sales_tax: formatCents(salesTaxCents),
      shipping: shipping.value,
      estimated_completion: estimatedCompletion.value,
      origin_inquiry_id: originInquiryId || null
    }
  };
}

function normalizeCommissionEdit(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  if (Object.keys(data).some((field) => !editFields.has(field))) {
    return { error: "Request body contains unsupported fields." };
  }

  const title = normalizeRequiredText(data.title, "Title");
  const description = normalizeRequiredText(data.description, "Description");
  const medium = normalizeRequiredText(data.medium, "Medium");
  const width = normalizeNumber(data.width, { label: "Width", positive: true });
  const height = normalizeNumber(data.height, { label: "Height", positive: true });
  const price = normalizeMoney(data.price, "Price");
  const salesTaxRate = normalizeSalesTaxRate(data.sales_tax_rate);
  const shipping = normalizeNumber(data.shipping, {
    label: "Shipping",
    defaultValue: 0
  });
  const estimatedCompletion = normalizeDate(data.estimated_completion);
  const firstError = [
    title,
    description,
    medium,
    width,
    height,
    price,
    salesTaxRate,
    shipping,
    estimatedCompletion
  ].find((result) => result.error);

  if (firstError) {
    return { error: firstError.error };
  }

  if (!allowedMediums.has(medium.value)) {
    return { error: "Medium is unsupported." };
  }

  const salesTaxCents = Math.round(price.cents * salesTaxRate.percent / 100);

  return {
    commission: {
      title: title.value,
      description: description.value,
      medium: medium.value,
      width: width.value,
      height: height.value,
      price: price.value,
      sales_tax: formatCents(salesTaxCents),
      shipping: shipping.value,
      estimated_completion: estimatedCompletion.value
    }
  };
}

function normalizeCommissionStatus(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  const fields = Object.keys(data);

  if (fields.length !== 1 || fields[0] !== "status") {
    return { error: "Request body must contain only status." };
  }

  if (typeof data.status !== "string" || !allowedCommissionStatuses.has(data.status)) {
    return { error: "Status is invalid." };
  }

  return { status: data.status };
}

async function listCommissions(db) {
  const result = await db.pool.query(
    `SELECT
       c.id,
       c.commission_number,
       c.title,
       c.status,
       lifecycle.lifecycle_status,
       lifecycle.activated_at,
       c.price,
       c.balance,
       c.source_quotation_id,
       q.quotation_number AS source_quotation_number,
       q.version AS source_quotation_version,
       c.created_at,
       cl.id AS client_id,
       cl.full_name AS client_name,
       cl.email AS client_email
     FROM commissions AS c
     JOIN clients AS cl ON cl.id = c.client_id
     LEFT JOIN quotations AS q ON q.id = c.source_quotation_id
     LEFT JOIN commission_lifecycle AS lifecycle ON lifecycle.commission_id = c.id
     ORDER BY c.created_at DESC`
  );

  return result.rows;
}

async function getCommission(db, id) {
  const result = await db.pool.query(
    `SELECT
       c.id,
       c.commission_number,
       c.client_id,
       cl.full_name AS client_name,
       cl.email AS client_email,
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
       c.balance,
       c.status,
       lifecycle.lifecycle_status,
       lifecycle.activated_at,
       lifecycle.activation_source,
       c.estimated_completion,
       c.created_at,
       c.source_quotation_id,
       q.quotation_number AS source_quotation_number,
       q.version AS source_quotation_version,
       contract.id AS contract_document_id,
       contract.document_number AS contract_document_number,
       contract.created_at AS contract_created_at
     FROM commissions AS c
     JOIN clients AS cl ON cl.id = c.client_id
     LEFT JOIN quotations AS q ON q.id = c.source_quotation_id
     LEFT JOIN commission_lifecycle AS lifecycle ON lifecycle.commission_id = c.id
     LEFT JOIN LATERAL (
       SELECT document.id, document.document_number, document.created_at
       FROM documents AS document
       WHERE document.commission_id = c.id
         AND document.document_type = 'contract'
       ORDER BY document.created_at DESC, document.id DESC
       LIMIT 1
     ) AS contract ON TRUE
     WHERE c.id = $1`,
    [id]
  );

  const commission = result.rows[0];

  if (!commission) {
    return null;
  }

  commission.inquiries = await getCommissionInquiries(db.pool, id);
  return commission;
}

async function getCommissionInquiries(queryable, commissionId) {
  const result = await queryable.query(
    `SELECT
       i.id,
       i.form_type,
       i.status,
       i.client_name,
       i.client_email,
       i.created_at,
       ci.relationship_type
     FROM commission_inquiries AS ci
     JOIN inquiries AS i ON i.id = ci.inquiry_id
     WHERE ci.commission_id = $1
     ORDER BY ci.created_at ASC, i.created_at ASC`,
    [commissionId]
  );

  return result.rows;
}

async function createCommission(db, data, year = new Date().getUTCFullYear()) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    const clientResult = await connection.query(
      `SELECT id, full_name, email
       FROM clients
       WHERE id = $1`,
      [data.client_id]
    );
    const client = clientResult.rows[0];

    if (!client) {
      await connection.query("ROLLBACK");
      return { outcome: "client_not_found" };
    }

    if (data.origin_inquiry_id) {
      const inquiryResult = await connection.query(
        `SELECT
           id,
           lower(btrim(client_email)) = lower(btrim($2)) AS client_matches
         FROM inquiries
         WHERE id = $1`,
        [data.origin_inquiry_id, client.email]
      );
      const inquiry = inquiryResult.rows[0];

      if (!inquiry) {
        await connection.query("ROLLBACK");
        return { outcome: "inquiry_not_found" };
      }

      if (!inquiry.client_matches) {
        await connection.query("ROLLBACK");
        return { outcome: "inquiry_client_mismatch" };
      }
    }

    await connection.query(
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [commissionNumberLockNamespace, year]
    );
    const sequenceResult = await connection.query(
      `SELECT COALESCE(MAX(split_part(commission_number, '-', 4)::integer), 0) + 1 AS next_number
       FROM commissions
       WHERE commission_number LIKE $1`,
      [`SAS-COM-${year}-%`]
    );
    const nextNumber = Number(sequenceResult.rows[0].next_number);
    const commissionNumber = `SAS-COM-${year}-${String(nextNumber).padStart(4, "0")}`;
    const insertedResult = await connection.query(
      `INSERT INTO commissions (
         commission_number,
         client_id,
         title,
         description,
         medium,
         width,
         height,
         price,
         deposit_amount,
         sales_tax,
         shipping,
         status,
         estimated_completion
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, 'draft', $11)
       RETURNING id`,
      [
        commissionNumber,
        data.client_id,
        data.title,
        data.description,
        data.medium,
        data.width,
        data.height,
        data.price,
        data.sales_tax,
        data.shipping,
        data.estimated_completion
      ]
    );

    await initializeCommissionProduction(
      connection,
      insertedResult.rows[0].id,
      new Date()
    );

    if (data.origin_inquiry_id) {
      await connection.query(
        `INSERT INTO commission_inquiries (
           commission_id,
           inquiry_id,
           relationship_type
         )
         VALUES ($1, $2, 'origin')`,
        [insertedResult.rows[0].id, data.origin_inquiry_id]
      );
      await appendCommissionEvent(connection, {
        commissionId: insertedResult.rows[0].id,
        eventType: "inquiry_linked",
        actorType: "admin",
        sourceType: "inquiry",
        sourceId: data.origin_inquiry_id,
        payload: { relationship_type: "origin" }
      });
    }

    const inquiries = await getCommissionInquiries(
      connection,
      insertedResult.rows[0].id
    );
    const commissionResult = await connection.query(
      `SELECT
         c.id,
         c.commission_number,
         c.client_id,
         $2::text AS client_name,
         $3::text AS client_email,
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
         c.balance,
         c.status,
         c.estimated_completion,
         c.created_at
       FROM commissions AS c
       WHERE c.id = $1`,
      [insertedResult.rows[0].id, client.full_name, client.email]
    );

    await connection.query("COMMIT");
    return {
      outcome: "success",
      commission: {
        ...commissionResult.rows[0],
        inquiries
      }
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function updateCommission(db, id, data) {
  const result = await db.pool.query(
    `UPDATE commissions
     SET
       title = $1,
       description = $2,
       medium = $3,
       width = $4,
       height = $5,
       price = $6,
       sales_tax = $7,
       shipping = $8,
       estimated_completion = $9
     WHERE id = $10
     RETURNING
       id,
       commission_number,
       client_id,
       title,
       description,
       medium,
       width,
       height,
       price,
       deposit_amount,
       amount_paid,
       sales_tax,
       shipping,
       balance,
       status,
       estimated_completion,
       created_at`,
    [
      data.title,
      data.description,
      data.medium,
      data.width,
      data.height,
      data.price,
      data.sales_tax,
      data.shipping,
      data.estimated_completion,
      id
    ]
  );

  return result.rows[0] || null;
}

async function updateCommissionStatus(db, id, status) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    const currentResult = await connection.query(
      `SELECT status
       FROM commissions
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );
    const current = currentResult.rows[0];

    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    if (!commissionStatusTransitions.get(current.status)?.has(status)) {
      await connection.query("ROLLBACK");
      return {
        outcome: "invalid_transition",
        current_status: current.status
      };
    }

    const result = await connection.query(
      `UPDATE commissions
       SET status = $1
       WHERE id = $2
       RETURNING
         id,
         commission_number,
         client_id,
         title,
         description,
         medium,
         width,
         height,
         price,
         deposit_amount,
         amount_paid,
         sales_tax,
         shipping,
         balance,
         status,
         estimated_completion,
         created_at`,
      [status, id]
    );

    await appendCommissionEvent(connection, {
      commissionId: id,
      eventType: "commission_status_changed",
      actorType: "admin",
      sourceType: "commission",
      sourceId: id,
      payload: {
        previous_status: current.status,
        new_status: status
      }
    });

    await connection.query("COMMIT");
    return {
      outcome: "success",
      commission: result.rows[0]
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function listCommissionEvents(db, commissionId) {
  const commission = await db.pool.query(
    "SELECT id FROM commissions WHERE id = $1",
    [commissionId]
  );
  if (!commission.rows[0]) return null;

  const result = await db.pool.query(
    `SELECT id, event_type, occurred_at, actor_type,
            source_type, source_id, payload
     FROM commission_events
     WHERE commission_id = $1
     ORDER BY occurred_at DESC, id DESC`,
    [commissionId]
  );

  return result.rows;
}

function logFailure(action, error, details = {}) {
  console.error("Admin commission request failed.", {
    action,
    ...details,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date()
} = {}) {
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;

    if (!adminPassword) {
      logFailure("authenticate", new Error("Missing admin configuration."));
      return jsonResponse(500, {
        success: false,
        message: "Admin authentication is not configured."
      });
    }

    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, {
        success: false,
        message: "Unauthorized."
      });
    }

    const pathname = new URL(request.url).pathname;
    const deliveryStorageAction = getCommissionDeliveryStorageAction(pathname);

    if (deliveryStorageAction !== null) {
      const { commissionId, action } = deliveryStorageAction;
      if (commissionId === undefined || !commissionIdPattern.test(commissionId)) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "POST") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
      }
      const requestNow = now();
      try {
        const result = action === "storage"
          ? await enterCommissionStorage(databaseFactory(), commissionId, {
              now: () => requestNow
            })
          : await recordStorageNotice(databaseFactory(), commissionId, {
              now: () => requestNow,
              final: action === "final-notice"
            });
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        if (result.outcome === "not_initialized") {
          return jsonResponse(404, { success: false, message: "Delivery is not initialized." });
        }
        if (["invalid_transition", "not_in_storage", "conflict"].includes(result.outcome)) {
          return jsonResponse(409, {
            success: false,
            message: action === "storage"
              ? "This Delivery cannot enter Storage from its current status."
              : "This notice can only be recorded once while the Delivery is in Storage."
          });
        }
        return jsonResponse(200, {
          success: true,
          created: result.outcome === "success",
          delivery: result.delivery
        });
      } catch (error) {
        logFailure(`delivery_${action}`, error, { commission_id: commissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to complete the Storage action."
        });
      }
    }

    const deliveryTransitionCommissionId = getCommissionDeliveryTransitionId(pathname);

    if (deliveryTransitionCommissionId !== null) {
      if (
        deliveryTransitionCommissionId === undefined
        || !commissionIdPattern.test(deliveryTransitionCommissionId)
      ) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "POST") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
      }
      const requestNow = now();
      const normalized = normalizeDeliveryTransition(await parseJsonBody(request), requestNow);
      if (normalized.error) {
        return jsonResponse(400, { success: false, message: normalized.error });
      }
      try {
        const result = await transitionCommissionDelivery(
          databaseFactory(),
          deliveryTransitionCommissionId,
          normalized.transition,
          { now: () => requestNow }
        );
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        if (result.outcome === "not_initialized") {
          return jsonResponse(404, { success: false, message: "Delivery is not initialized." });
        }
        if (result.outcome === "terminal") {
          return jsonResponse(409, { success: false, message: "Terminal Delivery records cannot be changed." });
        }
        if (result.outcome !== "success") {
          const messages = {
            shipping_destination_incomplete: "Recipient and complete destination are required before shipping.",
            carrier_required: "Carrier is required before shipping.",
            canonical_obligations_outstanding: "Every canonical Financial Obligation must be satisfied, waived, or voided before artwork release.",
            invalid_transition: "The requested Delivery transition is not allowed."
          };
          return jsonResponse(409, {
            success: false,
            message: messages[result.outcome] || "The requested Delivery transition is not allowed."
          });
        }
        return jsonResponse(200, { success: true, delivery: result.delivery });
      } catch (error) {
        logFailure("delivery_transition", error, { commission_id: deliveryTransitionCommissionId });
        return jsonResponse(500, { success: false, message: "Unable to transition Delivery." });
      }
    }

    const deliveryCommissionId = getCommissionDeliveryId(pathname);

    if (deliveryCommissionId !== null) {
      if (
        deliveryCommissionId === undefined
        || !commissionIdPattern.test(deliveryCommissionId)
      ) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      try {
        const db = databaseFactory();
        if (request.method === "GET") {
          const requestNow = now();
          const [result, releaseEligibility] = await Promise.all([
            readCommissionDelivery(db, deliveryCommissionId, { now: requestNow }),
            evaluateDeliveryReleaseEligibility(db.pool, deliveryCommissionId)
          ]);
          if (!result) {
            return jsonResponse(404, { success: false, message: "Commission not found." });
          }
          return jsonResponse(200, {
            success: true,
            commission_id: String(deliveryCommissionId),
            ...result,
            release_eligibility: releaseEligibility
          });
        }

        if (request.method === "POST") {
          const normalized = normalizeDeliveryCreate(await parseJsonBody(request));
          if (normalized.error) {
            return jsonResponse(400, { success: false, message: normalized.error });
          }
          const requestNow = now();
          const result = await createCommissionDelivery(
            db,
            deliveryCommissionId,
            normalized.delivery,
            { now: () => requestNow }
          );
          if (result.outcome === "not_found") {
            return jsonResponse(404, { success: false, message: "Commission not found." });
          }
          if (result.outcome === "already_initialized") {
            return jsonResponse(409, { success: false, message: "Delivery already exists." });
          }
          if (result.outcome === "blocked") {
            return jsonResponse(409, {
              success: false,
              reason: result.reason,
              message: result.message
            });
          }
          return jsonResponse(201, { success: true, delivery: result.delivery });
        }

        if (request.method === "PATCH") {
          const normalized = normalizeDeliveryUpdate(await parseJsonBody(request));
          if (normalized.error) {
            return jsonResponse(400, { success: false, message: normalized.error });
          }
          const requestNow = now();
          const result = await updateCommissionDelivery(
            db,
            deliveryCommissionId,
            normalized.delivery,
            { now: () => requestNow }
          );
          if (result.outcome === "not_found") {
            return jsonResponse(404, { success: false, message: "Commission not found." });
          }
          if (result.outcome === "not_initialized") {
            return jsonResponse(404, { success: false, message: "Delivery is not initialized." });
          }
          if (result.outcome === "terminal") {
            return jsonResponse(409, { success: false, message: "Terminal Delivery records cannot be changed." });
          }
          if (result.outcome === "costs_not_allowed_for_pickup") {
            return jsonResponse(400, { success: false, message: "Actual shipping and protection costs are not allowed for pickup." });
          }
          return jsonResponse(200, { success: true, delivery: result.delivery });
        }

        return jsonResponse(405, {
          success: false,
          message: "Method not allowed. Use GET, POST, or PATCH."
        });
      } catch (error) {
        logFailure("delivery", error, { commission_id: deliveryCommissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load delivery."
        });
      }
    }

    const obligationsCommissionId = getCommissionObligationsId(pathname);

    if (obligationsCommissionId !== null) {
      if (
        obligationsCommissionId === undefined
        || !commissionIdPattern.test(obligationsCommissionId)
      ) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }
      try {
        const result = await readCommissionObligations(
          databaseFactory(),
          obligationsCommissionId
        );
        if (!result) {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        return jsonResponse(200, {
          success: true,
          commission_id: String(obligationsCommissionId),
          ...result
        });
      } catch (error) {
        logFailure("obligations", error, { commission_id: obligationsCommissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load financial obligations."
        });
      }
    }

    const nextActionCommissionId = getCommissionNextActionId(pathname);

    if (nextActionCommissionId !== null) {
      if (
        nextActionCommissionId === undefined
        || !commissionIdPattern.test(nextActionCommissionId)
      ) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }
      try {
        const nextAction = await readCommissionNextAction(
          databaseFactory(),
          nextActionCommissionId,
          { now: now() }
        );
        if (!nextAction) {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        return jsonResponse(200, {
          success: true,
          commission_id: String(nextActionCommissionId),
          next_action: nextAction
        });
      } catch (error) {
        logFailure("next_action", error, { commission_id: nextActionCommissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to resolve the next action."
        });
      }
    }

    const productionCommissionId = getCommissionProductionId(pathname);

    if (productionCommissionId !== null) {
      if (
        productionCommissionId === undefined
        || !commissionIdPattern.test(productionCommissionId)
      ) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }
      try {
        const production = await readCommissionProduction(
          databaseFactory(),
          productionCommissionId
        );
        if (!production) {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        return jsonResponse(200, { success: true, production });
      } catch (error) {
        logFailure("production", error, { commission_id: productionCommissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load production status."
        });
      }
    }

    const eventsCommissionId = getCommissionEventsId(pathname);

    if (eventsCommissionId !== null) {
      if (eventsCommissionId === undefined || !commissionIdPattern.test(eventsCommissionId)) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      if (request.method !== "GET") {
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
      }
      try {
        const events = await listCommissionEvents(databaseFactory(), eventsCommissionId);
        if (events === null) {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        return jsonResponse(200, {
          success: true,
          total: events.length,
          events
        });
      } catch (error) {
        logFailure("events", error, { commission_id: eventsCommissionId });
        return jsonResponse(500, { success: false, message: "Unable to load commission activity." });
      }
    }

    const statusCommissionId = getCommissionStatusId(pathname);

    if (statusCommissionId !== null) {
      if (
        statusCommissionId === undefined
        || !commissionIdPattern.test(statusCommissionId)
      ) {
        return jsonResponse(400, {
          success: false,
          message: "Invalid commission id."
        });
      }

      if (request.method !== "PATCH") {
        return jsonResponse(405, {
          success: false,
          message: "Method not allowed. Use PATCH."
        });
      }

      const data = await parseJsonBody(request);
      const normalized = normalizeCommissionStatus(data);

      if (normalized.error) {
        return jsonResponse(400, {
          success: false,
          message: normalized.error
        });
      }

      try {
        const result = await updateCommissionStatus(
          databaseFactory(),
          statusCommissionId,
          normalized.status
        );

        if (result.outcome === "not_found") {
          return jsonResponse(404, {
            success: false,
            message: "Commission not found."
          });
        }

        if (result.outcome === "invalid_transition") {
          return jsonResponse(409, {
            success: false,
            message: "Commission status transition is not allowed."
          });
        }

        return jsonResponse(200, {
          success: true,
          commission: result.commission
        });
      } catch (error) {
        logFailure("update_status", error, { commission_id: statusCommissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to update commission status."
        });
      }
    }

    const commissionId = getCommissionId(pathname);

    if (commissionId === undefined) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (commissionId === null) {
      if (request.method === "GET") {
        try {
          const commissions = await listCommissions(databaseFactory());

          return jsonResponse(200, {
            success: true,
            total: commissions.length,
            commissions
          });
        } catch (error) {
          logFailure("list", error);
          return jsonResponse(500, {
            success: false,
            message: "Unable to load commissions."
          });
        }
      }

      if (request.method === "POST") {
        return jsonResponse(409, {
          success: false,
          code: "accepted_quotation_required",
          message: "A new Commission must be created from a valid accepted Quotation."
        });
      }

      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET or POST."
      });
    }

    if (!commissionIdPattern.test(commissionId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid commission id."
      });
    }

    if (request.method === "PATCH") {
      const data = await parseJsonBody(request);
      const normalized = normalizeCommissionEdit(data);

      if (normalized.error) {
        return jsonResponse(400, {
          success: false,
          message: normalized.error
        });
      }

      try {
        const commission = await updateCommission(
          databaseFactory(),
          commissionId,
          normalized.commission
        );

        if (!commission) {
          return jsonResponse(404, {
            success: false,
            message: "Commission not found."
          });
        }

        return jsonResponse(200, {
          success: true,
          commission
        });
      } catch (error) {
        logFailure("update", error, { commission_id: commissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to update commission."
        });
      }
    }

    if (request.method !== "GET") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET or PATCH."
      });
    }

    try {
      const commission = await getCommission(databaseFactory(), commissionId);

      if (!commission) {
        return jsonResponse(404, {
          success: false,
          message: "Commission not found."
        });
      }

      return jsonResponse(200, {
        success: true,
        commission
      });
    } catch (error) {
      logFailure("detail", error, { commission_id: commissionId });
      return jsonResponse(500, {
        success: false,
        message: "Unable to load the commission."
      });
    }
  };
}

export const config = {
  path: [
    "/admin/api/commissions",
    "/admin/api/commissions/:id",
    "/admin/api/commissions/:id/status",
    "/admin/api/commissions/:id/events",
    "/admin/api/commissions/:id/production",
    "/admin/api/commissions/:id/next-action",
    "/admin/api/commissions/:id/obligations",
    "/admin/api/commissions/:id/delivery",
    "/admin/api/commissions/:id/delivery/transition",
    "/admin/api/commissions/:id/delivery/storage",
    "/admin/api/commissions/:id/delivery/storage-notice",
    "/admin/api/commissions/:id/delivery/final-notice"
  ]
};

export {
  createCommission,
  createHandler,
  commissionStatusTransitions,
  getCommission,
  getCommissionEventsId,
  getCommissionDeliveryId,
  getCommissionDeliveryStorageAction,
  getCommissionDeliveryTransitionId,
  getCommissionNextActionId,
  getCommissionObligationsId,
  getCommissionProductionId,
  getCommissionInquiries,
  listCommissionEvents,
  listCommissions,
  normalizeCommissionCreate,
  normalizeCommissionEdit,
  normalizeCommissionStatus,
  updateCommission,
  updateCommissionStatus
};

export default createHandler();
