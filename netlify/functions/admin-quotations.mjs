import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import { appendCommissionEvent } from "../shared/commission-events.mjs";
import { initializeCommissionProduction } from "../shared/commission-production.mjs";
import { hashQuotationSnapshot } from "../shared/quotation-snapshot.mjs";
import { isQuotationExpired } from "../shared/quotation-state.mjs";
import { normalizeShippingEstimateSnapshot } from "../shared/shipping-rates.mjs";

const COMMISSIONS_PATH = "/admin/api/commissions";
const QUOTATIONS_PATH = "/admin/api/quotations";
const idPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedRates = new Set(["0.0000", "0.0600", "0.0700", "0.0800"]);
const quotationNumberLockNamespace = 20261031;
const requiredDepositRate = "0.5000";
const editFields = new Set([
  "artwork_title", "artwork_description", "artwork_medium", "artwork_width", "artwork_height",
  "price", "sales_tax_rate", "shipping_charge", "estimated_completion",
  "special_terms", "shipping_estimate_snapshot"
]);
const creationFields = new Set([...editFields, "inquiry_id", "request_id"]);
const allowedMediums = new Set(["Acrylic", "Watercolor", "Oil", "Drawing"]);

function jsonResponse(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function readEnvironmentVariable(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
}

function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function serializeNullableJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function toCents(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 999999999999 ? cents : null;
}

function normalizeRate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  const normalized = number.toFixed(4);
  return allowedRates.has(normalized) ? normalized : null;
}

function isValidDate(value) {
  if (!datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function serializeDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(normalized) ? normalized.slice(0, 10) : null;
}

function normalizeDraft(data, { partial = false, creation = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }
  const allowedFields = creation ? creationFields : editFields;
  if (Object.keys(data).some((key) => !allowedFields.has(key))) {
    return { error: "Request body contains unsupported fields." };
  }
  if (!partial && [...editFields].some((key) => ![
    "special_terms", "estimated_completion", "shipping_estimate_snapshot",
    "artwork_width", "artwork_height"
  ].includes(key) && !(key in data))) {
    return { error: "Quotation commercial fields are required." };
  }

  const result = {};
  for (const [field, label] of [
    ["artwork_title", "Artwork title"],
    ["artwork_description", "Artwork description"],
    ["artwork_medium", "Artwork medium"]
  ]) {
    if (field in data) {
      if (typeof data[field] !== "string" || !data[field].trim()) {
        return { error: `${label} is required.` };
      }
      result[field] = data[field].trim();
    }
  }
  if (result.artwork_medium && !allowedMediums.has(result.artwork_medium)) {
    return { error: "Artwork medium is unsupported." };
  }
  for (const field of ["artwork_width", "artwork_height"]) {
    if (field in data) {
      const value = data[field];
      if (value === null || value === "") result[field] = null;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: `${field} must be greater than 0.` };
        result[field] = parsed;
      }
    }
  }
  if ("price" in data) {
    const cents = toCents(data.price);
    if (cents === null) return { error: "Price must be a valid monetary amount." };
    result.price = formatCents(cents);
  }
  if ("sales_tax_rate" in data) {
    const rate = normalizeRate(data.sales_tax_rate);
    if (rate === null) return { error: "Sales tax rate is unsupported." };
    result.sales_tax_rate = rate;
  }
  if ("shipping_charge" in data) {
    const cents = toCents(data.shipping_charge);
    if (cents === null) return { error: "Shipping charge must be a valid monetary amount." };
    result.shipping_charge = formatCents(cents);
  }
  if ("estimated_completion" in data) {
    const value = data.estimated_completion;
    if (value !== null && value !== "" && (typeof value !== "string" || !isValidDate(value))) {
      return { error: "Estimated completion must be a valid date." };
    }
    result.estimated_completion = value || null;
  }
  if ("special_terms" in data) {
    if (data.special_terms !== null && typeof data.special_terms !== "string") {
      return { error: "Special terms must be text." };
    }
    result.special_terms = data.special_terms?.trim() || null;
  }
  if ("shipping_estimate_snapshot" in data) {
    const snapshot = normalizeShippingEstimateSnapshot(data.shipping_estimate_snapshot);
    if (snapshot.error) return { error: snapshot.error };
    result.shipping_estimate_snapshot = snapshot.value;
  }
  if (creation) {
    if (data.inquiry_id !== null && data.inquiry_id !== undefined && data.inquiry_id !== ""
      && (typeof data.inquiry_id !== "string" || !uuidPattern.test(data.inquiry_id))) {
      return { error: "Inquiry id must be a valid UUID." };
    }
    if (data.request_id !== null && data.request_id !== undefined
      && (typeof data.request_id !== "string" || !uuidPattern.test(data.request_id))) {
      return { error: "Request id must be a valid UUID." };
    }
    result.inquiry_id = data.inquiry_id || null;
    result.request_id = data.request_id || null;
  }
  return { value: result };
}

function inferSalesTaxRate(price, salesTax) {
  const priceCents = toCents(price) ?? 0;
  const taxCents = toCents(salesTax) ?? 0;
  if (!priceCents && !taxCents) return "0.0600";
  return [...allowedRates].find((rate) => Math.round(priceCents * Number(rate)) === taxCents) || "0.0600";
}

function calculateCommercials({ price, sales_tax_rate, shipping_charge }) {
  const priceCents = toCents(price);
  const shippingCents = toCents(shipping_charge);
  const rate = normalizeRate(sales_tax_rate);
  if (priceCents === null || shippingCents === null || rate === null) return null;
  const salesTaxCents = Math.round(priceCents * Number(rate));
  const requiredDepositCents = Math.round(priceCents * 0.5);
  return {
    price: formatCents(priceCents),
    sales_tax_rate: rate,
    sales_tax: formatCents(salesTaxCents),
    shipping_charge: formatCents(shippingCents),
    required_deposit_rate: requiredDepositRate,
    required_deposit: formatCents(requiredDepositCents),
    total: formatCents(priceCents + salesTaxCents + shippingCents)
  };
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
}

function getTimeZoneOffset(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  return Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  ) - Math.floor(date.getTime() / 1000) * 1000;
}

function addCalendarDays(date, days, timeZone = "America/New_York") {
  const parts = getTimeZoneParts(date, timeZone);
  const wallClock = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day + days,
    parts.hour, parts.minute, parts.second, date.getUTCMilliseconds()
  ));
  let result = new Date(wallClock.getTime() - getTimeZoneOffset(wallClock, timeZone));
  result = new Date(wallClock.getTime() - getTimeZoneOffset(result, timeZone));
  return result;
}

function buildQuotationSnapshot({ quotation, issuedAt, expiresAt }) {
  const commercial = calculateCommercials(quotation);
  if (Number(quotation.snapshot_version) === 2 || !quotation.commission_id) {
    return {
      snapshot_version: 2,
      quotation_number: quotation.quotation_number,
      version: Number(quotation.version),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      client: {
        client_id: String(quotation.client_id),
        full_name: quotation.client_name,
        email: quotation.client_email,
        phone: quotation.client_phone || null
      },
      inquiry: quotation.inquiry_id ? { inquiry_id: quotation.inquiry_id } : null,
      artwork: {
        title: quotation.artwork_title,
        description: quotation.artwork_description,
        medium: quotation.artwork_medium,
        dimensions: {
          width: quotation.artwork_width === null ? null : String(quotation.artwork_width),
          height: quotation.artwork_height === null ? null : String(quotation.artwork_height),
          unit: "in"
        }
      },
      commercial: {
        ...commercial,
        estimated_completion: serializeDateOnly(quotation.estimated_completion),
        special_terms: quotation.special_terms || null,
        shipping_estimate: quotation.shipping_estimate_snapshot || null
      }
    };
  }
  return {
    quotation_number: quotation.quotation_number,
    version: Number(quotation.version),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    client: {
      client_id: String(quotation.client_id),
      full_name: quotation.client_name,
      email: quotation.client_email,
      phone: quotation.client_phone || null
    },
    commission: {
      commission_id: String(quotation.commission_id),
      commission_number: quotation.commission_number,
      title: quotation.commission_title,
      description: quotation.commission_description,
      medium: quotation.commission_medium,
      dimensions: {
        width: quotation.commission_width === null ? null : String(quotation.commission_width),
        height: quotation.commission_height === null ? null : String(quotation.commission_height),
        unit: "in"
      }
    },
    commercial: {
      ...commercial,
      estimated_completion: serializeDateOnly(quotation.estimated_completion),
      special_terms: quotation.special_terms || null,
      shipping_estimate: quotation.shipping_estimate_snapshot || null
    }
  };
}

function parseRoute(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  let match = path.match(/^\/admin\/api\/commissions\/([^/]+)\/quotations$/);
  if (match) return { kind: "commission_collection", id: decodeURIComponent(match[1]) };
  match = path.match(/^\/admin\/api\/clients\/([^/]+)\/quotations$/);
  if (match) return { kind: "client_collection", id: decodeURIComponent(match[1]) };
  if (path === QUOTATIONS_PATH) return { kind: "global_collection", id: null };
  match = path.match(/^\/admin\/api\/quotations\/([^/]+)(?:\/(issue|mark-sent|withdraw|new-version|create-commission))?$/);
  if (match) return { kind: match[2] || "quotation", id: decodeURIComponent(match[1]) };
  return null;
}

const quotationSelect = `
  q.*,
  c.commission_number,
  sc.id AS source_commission_id,
  sc.commission_number AS source_commission_number,
  COALESCE(c.title, q.artwork_title) AS commission_title,
  COALESCE(c.description, q.artwork_description) AS commission_description,
  COALESCE(c.medium, q.artwork_medium) AS commission_medium,
  COALESCE(c.width, q.artwork_width) AS commission_width,
  COALESCE(c.height, q.artwork_height) AS commission_height,
  cl.full_name AS client_name,
  cl.email AS client_email,
  cl.phone AS client_phone`;

async function getQuotation(queryable, id, lock = false) {
  const result = await queryable.query(
    `SELECT ${quotationSelect}
     FROM quotations q
     LEFT JOIN commissions c ON c.id = q.commission_id
     LEFT JOIN commissions sc ON sc.source_quotation_id = q.id
     JOIN clients cl ON cl.id = q.client_id
     WHERE q.id = $1${lock ? " FOR UPDATE OF q" : ""}`,
    [id]
  );
  const quotation = result.rows[0] || null;
  if (quotation) quotation.is_expired = Boolean(
    quotation.expires_at
    && ["issued", "sent"].includes(quotation.quotation_status)
    && isQuotationExpired(quotation)
  );
  return quotation;
}

async function listQuotations(db, { commissionId = null, clientId = null, status = null } = {}) {
  const conditions = [];
  const values = [];
  if (commissionId) {
    values.push(commissionId);
    conditions.push(`(q.commission_id = $${values.length} OR sc.id = $${values.length})`);
  }
  if (clientId) { values.push(clientId); conditions.push(`q.client_id = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`q.quotation_status = $${values.length}`); }
  const result = await db.pool.query(
    `SELECT ${quotationSelect}
     FROM quotations q
     LEFT JOIN commissions c ON c.id = q.commission_id
     LEFT JOIN commissions sc ON sc.source_quotation_id = q.id
     JOIN clients cl ON cl.id = q.client_id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY q.created_at DESC, q.version DESC, q.id DESC`,
    values
  );
  const now = new Date();
  return result.rows.map((quotation) => ({
    ...quotation,
    is_expired: Boolean(
      quotation.expires_at
      && ["issued", "sent"].includes(quotation.quotation_status)
      && isQuotationExpired(quotation, now)
    )
  }));
}

async function createPreCommissionDraft(db, clientId, data, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    if (data.request_id) {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtext('sylva-quotation-request'), hashtext($1::text))",
        [data.request_id]
      );
      const existing = (await connection.query(
        "SELECT id, client_id FROM quotations WHERE request_id = $1",
        [data.request_id]
      )).rows[0];
      if (existing) {
        if (String(existing.client_id) !== String(clientId)) {
          await connection.query("ROLLBACK");
          return { outcome: "request_conflict" };
        }
        const quotation = await getQuotation(connection, existing.id);
        await connection.query("COMMIT");
        return { outcome: "success", created: false, quotation };
      }
    }

    const client = (await connection.query(
      "SELECT id, email FROM clients WHERE id = $1 FOR SHARE",
      [clientId]
    )).rows[0];
    if (!client) {
      await connection.query("ROLLBACK");
      return { outcome: "client_not_found" };
    }
    if (data.inquiry_id) {
      const inquiry = (await connection.query(
        `SELECT id, lower(btrim(client_email)) = lower(btrim($2)) AS client_matches
         FROM inquiries WHERE id = $1`,
        [data.inquiry_id, client.email]
      )).rows[0];
      if (!inquiry) {
        await connection.query("ROLLBACK");
        return { outcome: "inquiry_not_found" };
      }
      if (!inquiry.client_matches) {
        await connection.query("ROLLBACK");
        return { outcome: "inquiry_client_mismatch" };
      }
    }

    const year = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric"
    }).format(now()));
    const sequence = await connection.query(
      "SELECT nextval('quotation_number_sequence')::BIGINT AS next_number"
    );
    const quotationNumber = `SAS-QUO-${year}-${String(sequence.rows[0].next_number).padStart(4, "0")}`;
    const commercial = calculateCommercials(data);
    const inserted = await connection.query(
      `INSERT INTO quotations (
         commission_id, client_id, inquiry_id, artwork_title, artwork_description,
         artwork_medium, artwork_width, artwork_height, snapshot_version,
         quotation_number, version, quotation_status, price, sales_tax_rate,
         sales_tax, shipping_charge, estimated_completion, required_deposit_rate,
         required_deposit, special_terms, shipping_estimate_snapshot, request_id
       ) VALUES (
         NULL, $1, $2, $3, $4, $5, $6, $7, 2,
         $8, 1, 'draft', $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
       ) ON CONFLICT (request_id) DO NOTHING
       RETURNING id`,
      [clientId, data.inquiry_id, data.artwork_title, data.artwork_description,
       data.artwork_medium, data.artwork_width, data.artwork_height, quotationNumber,
       commercial.price, commercial.sales_tax_rate, commercial.sales_tax,
       commercial.shipping_charge, data.estimated_completion,
       commercial.required_deposit_rate, commercial.required_deposit,
       data.special_terms, serializeNullableJson(data.shipping_estimate_snapshot), data.request_id]
    );
    const existingAfterConflict = !inserted.rows[0] && data.request_id
      ? (await connection.query(
          "SELECT id, client_id FROM quotations WHERE request_id = $1",
          [data.request_id]
        )).rows[0]
      : null;
    const quotationId = inserted.rows[0]?.id || existingAfterConflict?.id;
    if (!quotationId) throw Object.assign(new Error("Quotation creation conflict."), {
      code: "quotation_creation_conflict"
    });
    if (existingAfterConflict?.client_id
      && String(existingAfterConflict.client_id) !== String(clientId)) {
      await connection.query("ROLLBACK");
      return { outcome: "request_conflict" };
    }
    const quotation = await getQuotation(connection, quotationId);
    await connection.query("COMMIT");
    return { outcome: "success", created: Boolean(inserted.rows[0]), quotation };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function createDraft(db, commissionId, requestId = null, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    if (requestId) {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtext('sylva-quotation-request'), hashtext($1::text))",
        [requestId]
      );
      const existing = await connection.query("SELECT id, commission_id FROM quotations WHERE request_id = $1", [requestId]);
      if (existing.rows[0]) {
        if (String(existing.rows[0].commission_id) !== String(commissionId)) {
          await connection.query("ROLLBACK");
          return { outcome: "request_conflict" };
        }
        const quotation = await getQuotation(connection, existing.rows[0].id);
        await connection.query("COMMIT");
        return { outcome: "success", created: false, quotation };
      }
    }
    const contextResult = await connection.query(
      `SELECT c.*, cl.full_name AS client_name, cl.email AS client_email, cl.phone AS client_phone
       FROM commissions c JOIN clients cl ON cl.id = c.client_id WHERE c.id = $1 FOR SHARE OF c`,
      [commissionId]
    );
    const commission = contextResult.rows[0];
    if (!commission) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(now()));
    await connection.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [quotationNumberLockNamespace, year]);
    const sequence = await connection.query(
      `SELECT COALESCE(MAX(split_part(quotation_number, '-', 4)::integer), 0) + 1 AS next_number
       FROM quotations WHERE quotation_number LIKE $1`,
      [`SAS-QUO-${year}-%`]
    );
    const quotationNumber = `SAS-QUO-${year}-${String(sequence.rows[0].next_number).padStart(4, "0")}`;
    const salesTaxRate = inferSalesTaxRate(commission.price, commission.sales_tax);
    const commercial = calculateCommercials({
      price: commission.price,
      sales_tax_rate: salesTaxRate,
      shipping_charge: commission.shipping
    });
    let inserted = await connection.query(
      `INSERT INTO quotations (
         commission_id, client_id, artwork_title, artwork_description, artwork_medium,
         artwork_width, artwork_height, snapshot_version,
         quotation_number, version, quotation_status,
         price, sales_tax_rate, sales_tax, shipping_charge,
         estimated_completion, required_deposit_rate, required_deposit, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 1, 'draft', $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [commissionId, commission.client_id, commission.title, commission.description,
       commission.medium, commission.width, commission.height, quotationNumber,
       commercial.price, commercial.sales_tax_rate, commercial.sales_tax,
       commercial.shipping_charge, commission.estimated_completion,
       commercial.required_deposit_rate, commercial.required_deposit, requestId]
    );
    let existingAfterConflict = inserted.rows[0] || (requestId
      ? (await connection.query(
          "SELECT id, commission_id FROM quotations WHERE request_id = $1",
          [requestId]
        )).rows[0]
      : null);

    if (!existingAfterConflict) {
      const retrySequence = await connection.query(
        `SELECT COALESCE(MAX(split_part(quotation_number, '-', 4)::integer), 0) + 1 AS next_number
         FROM quotations WHERE quotation_number LIKE $1`,
        [`SAS-QUO-${year}-%`]
      );
      const retryNumber = `SAS-QUO-${year}-${String(retrySequence.rows[0].next_number).padStart(4, "0")}`;
      inserted = await connection.query(
        `INSERT INTO quotations (
           commission_id, client_id, artwork_title, artwork_description, artwork_medium,
           artwork_width, artwork_height, snapshot_version,
           quotation_number, version, quotation_status,
           price, sales_tax_rate, sales_tax, shipping_charge,
           estimated_completion, required_deposit_rate, required_deposit, request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, 1, 'draft', $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [commissionId, commission.client_id, commission.title, commission.description,
         commission.medium, commission.width, commission.height, retryNumber,
         commercial.price, commercial.sales_tax_rate, commercial.sales_tax,
         commercial.shipping_charge, commission.estimated_completion,
         commercial.required_deposit_rate, commercial.required_deposit, requestId]
      );
      existingAfterConflict = inserted.rows[0] || (requestId
        ? (await connection.query(
            "SELECT id, commission_id FROM quotations WHERE request_id = $1",
            [requestId]
          )).rows[0]
        : null);
    }
    if (!existingAfterConflict) {
      throw Object.assign(new Error("Quotation numbering conflict."), { code: "quotation_number_conflict" });
    }
    if (String(existingAfterConflict.commission_id || commissionId) !== String(commissionId)) {
      await connection.query("ROLLBACK");
      return { outcome: "request_conflict" };
    }
    const quotation = await getQuotation(connection, existingAfterConflict.id);
    if (inserted.rows[0]) {
      await appendCommissionEvent(connection, {
        commissionId,
        eventType: "quotation_created",
        occurredAt: now(),
        actorType: "admin",
        sourceType: "quotation",
        sourceId: quotation.id,
        requestId,
        payload: {
          quotation_number: quotation.quotation_number,
          version: Number(quotation.version)
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "success", created: Boolean(inserted.rows[0]), quotation };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function updateDraft(db, id, changes) {
  const current = await getQuotation(db.pool, id);
  if (!current) return { outcome: "not_found" };
  if (current.quotation_status !== "draft") return { outcome: "immutable" };
  const next = { ...current, ...changes };
  const commercial = calculateCommercials(next);
  const result = await db.pool.query(
    `UPDATE quotations SET
       artwork_title = $1, artwork_description = $2, artwork_medium = $3,
       artwork_width = $4, artwork_height = $5,
       price = $6, sales_tax_rate = $7, sales_tax = $8, shipping_charge = $9,
       required_deposit_rate = $10, required_deposit = $11,
       estimated_completion = $12, special_terms = $13,
       shipping_estimate_snapshot = $14::jsonb
     WHERE id = $15 AND quotation_status = 'draft'
     RETURNING id`,
    [next.artwork_title, next.artwork_description, next.artwork_medium,
     next.artwork_width, next.artwork_height,
     commercial.price, commercial.sales_tax_rate, commercial.sales_tax,
     commercial.shipping_charge, commercial.required_deposit_rate,
     commercial.required_deposit, next.estimated_completion, next.special_terms,
     serializeNullableJson(next.shipping_estimate_snapshot), id]
  );
  if (!result.rows[0]) return { outcome: "immutable" };
  return { outcome: "success", quotation: await getQuotation(db.pool, id) };
}

async function issueQuotation(db, id, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const quotationReference = await getQuotation(connection, id);
    if (!quotationReference) { await connection.query("ROLLBACK"); return { outcome: "not_found" }; }
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-quotation-family'), hashtext($1::text))",
      [quotationReference.quotation_number]
    );
    const quotation = await getQuotation(connection, id, true);
    if (quotation.quotation_status !== "draft") {
      await connection.query("COMMIT");
      return quotation.quotation_status === "issued"
        ? { outcome: "success", created: false, quotation }
        : { outcome: "invalid_status" };
    }
    const issuedAt = now();
    const expiresAt = addCalendarDays(issuedAt, 30);
    const snapshot = buildQuotationSnapshot({ quotation, issuedAt, expiresAt });
    const snapshotHash = hashQuotationSnapshot(snapshot);
    if (quotation.supersedes_quotation_id) {
      const previous = await getQuotation(connection, quotation.supersedes_quotation_id, true);
      if (!previous || !["issued", "sent"].includes(previous.quotation_status)) {
        await connection.query("ROLLBACK");
        return { outcome: "invalid_superseded" };
      }
      await connection.query(
        "UPDATE quotations SET quotation_status = 'superseded' WHERE id = $1",
        [previous.id]
      );
      if (quotation.commission_id) {
        await appendCommissionEvent(connection, {
          commissionId: quotation.commission_id,
          eventType: "quotation_superseded",
          occurredAt: issuedAt,
          actorType: "admin",
          sourceType: "quotation",
          sourceId: previous.id,
          payload: {
            quotation_number: previous.quotation_number,
            version: Number(previous.version)
          }
        });
      }
    }
    await connection.query(
      `UPDATE quotations SET quotation_status = 'issued', issued_at = $1, expires_at = $2,
       quotation_snapshot = $3::jsonb, snapshot_hash = $4 WHERE id = $5`,
      [issuedAt, expiresAt, JSON.stringify(snapshot), snapshotHash, id]
    );
    const documentResult = await connection.query(
      `INSERT INTO documents (
         commission_id, client_id, document_type, document_number, version, file_location,
         document_snapshot, quotation_id
       ) VALUES ($1, $2, 'quotation', $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [quotation.commission_id, quotation.client_id, quotation.quotation_number, quotation.version,
       `/admin/quotation.html?id=${id}`, JSON.stringify(snapshot), id]
    );
    const updated = await getQuotation(connection, id);
    if (quotation.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: quotation.commission_id,
        eventType: "quotation_issued",
        occurredAt: issuedAt,
        actorType: "admin",
        sourceType: "quotation",
        sourceId: quotation.id,
        payload: {
          quotation_number: quotation.quotation_number,
          version: Number(quotation.version)
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "success", created: Boolean(documentResult.rows[0]), quotation: updated };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function transitionQuotation(db, id, action, now = () => new Date()) {
  const rules = {
    "mark-sent": { from: ["issued"], to: "sent", timestamp: "sent_at" },
    withdraw: { from: ["issued", "sent"], to: "withdrawn", timestamp: null }
  };
  const rule = rules[action];
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const quotation = await getQuotation(connection, id, true);
    if (!quotation) { await connection.query("ROLLBACK"); return { outcome: "not_found" }; }
    if (!rule.from.includes(quotation.quotation_status)) {
      await connection.query("ROLLBACK"); return { outcome: "invalid_status" };
    }
    const timestampClause = rule.timestamp ? `, ${rule.timestamp} = $2` : "";
    const values = rule.timestamp ? [rule.to, now(), id] : [rule.to, id];
    await connection.query(
      `UPDATE quotations SET quotation_status = $1${timestampClause} WHERE id = $${values.length}`,
      values
    );
    const updated = await getQuotation(connection, id);
    if (quotation.commission_id) await appendCommissionEvent(connection, {
      commissionId: quotation.commission_id,
      eventType: action === "mark-sent" ? "quotation_sent" : "quotation_withdrawn",
      occurredAt: rule.timestamp ? updated.sent_at : now(),
      actorType: "admin",
      sourceType: "quotation",
      sourceId: quotation.id,
      payload: {
        quotation_number: quotation.quotation_number,
        version: Number(quotation.version)
      }
    });
    await connection.query("COMMIT");
    return { outcome: "success", quotation: updated };
  } catch (error) {
    await connection.query("ROLLBACK"); throw error;
  } finally { connection.release(); }
}

async function createNewVersion(db, id) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const previous = await getQuotation(connection, id, true);
    if (!previous) { await connection.query("ROLLBACK"); return { outcome: "not_found" }; }
    if (!["issued", "sent"].includes(previous.quotation_status)) {
      await connection.query("ROLLBACK"); return { outcome: "invalid_status" };
    }
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-quotation-family'), hashtext($1::text))",
      [previous.quotation_number]
    );
    const existingDraft = await connection.query(
      "SELECT id FROM quotations WHERE quotation_number = $1 AND quotation_status = 'draft' FOR UPDATE",
      [previous.quotation_number]
    );
    if (existingDraft.rows[0]) {
      const quotation = await getQuotation(connection, existingDraft.rows[0].id);
      await connection.query("COMMIT");
      return { outcome: "success", created: false, quotation };
    }
    const versionResult = await connection.query(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM quotations WHERE quotation_number = $1",
      [previous.quotation_number]
    );
    const inserted = await connection.query(
      `INSERT INTO quotations (
         commission_id, client_id, inquiry_id, artwork_title, artwork_description,
         artwork_medium, artwork_width, artwork_height, snapshot_version,
         quotation_number, version, quotation_status,
         supersedes_quotation_id, price, sales_tax_rate, sales_tax,
         shipping_charge, estimated_completion, required_deposit_rate,
         required_deposit, special_terms, shipping_estimate_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)
       ON CONFLICT (quotation_number, version) DO NOTHING
       RETURNING id`,
      [previous.commission_id, previous.client_id, previous.inquiry_id,
       previous.artwork_title, previous.artwork_description, previous.artwork_medium,
       previous.artwork_width, previous.artwork_height, previous.snapshot_version,
       previous.quotation_number, versionResult.rows[0].next_version, previous.id, previous.price,
       previous.sales_tax_rate, previous.sales_tax, previous.shipping_charge,
       previous.estimated_completion, previous.required_deposit_rate,
       previous.required_deposit, previous.special_terms,
       serializeNullableJson(previous.shipping_estimate_snapshot)]
    );
    const quotationId = inserted.rows[0]?.id || (await connection.query(
      "SELECT id FROM quotations WHERE quotation_number = $1 AND quotation_status = 'draft' ORDER BY version DESC LIMIT 1",
      [previous.quotation_number]
    )).rows[0]?.id;
    const quotation = await getQuotation(connection, quotationId);
    if (inserted.rows[0]) {
      if (previous.commission_id) await appendCommissionEvent(connection, {
        commissionId: previous.commission_id,
        eventType: "quotation_created",
        actorType: "admin",
        sourceType: "quotation",
        sourceId: quotation.id,
        payload: {
          quotation_number: quotation.quotation_number,
          version: Number(quotation.version)
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "success", created: Boolean(inserted.rows[0]), quotation };
  } catch (error) {
    await connection.query("ROLLBACK"); throw error;
  } finally { connection.release(); }
}

async function createCommissionFromQuotation(db, id, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-create-commission-from-quotation'), hashtext($1::text))",
      [id]
    );
    const quotation = await getQuotation(connection, id, true);
    if (!quotation) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const existingCommission = (await connection.query(
      "SELECT id, commission_number FROM commissions WHERE source_quotation_id = $1",
      [id]
    )).rows[0];
    if (existingCommission) {
      await connection.query("COMMIT");
      return { outcome: "success", created: false, commission: existingCommission };
    }
    if (quotation.quotation_status !== "accepted") {
      await connection.query("ROLLBACK");
      return { outcome: "not_accepted" };
    }
    if (!quotation.expires_at || isQuotationExpired(quotation, now())) {
      await connection.query("ROLLBACK");
      return { outcome: "expired" };
    }
    if (!quotation.quotation_snapshot || !quotation.snapshot_hash
      || hashQuotationSnapshot(quotation.quotation_snapshot) !== quotation.snapshot_hash) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_snapshot" };
    }
    const acceptance = (await connection.query(
      `SELECT id, client_id, snapshot_hash, subject_number, subject_version
       FROM acceptances
       WHERE acceptance_type = 'quotation' AND quotation_id = $1 AND accepted = TRUE
       LIMIT 1`,
      [id]
    )).rows[0];
    if (!acceptance
      || String(acceptance.client_id) !== String(quotation.client_id)
      || acceptance.snapshot_hash !== quotation.snapshot_hash
      || acceptance.subject_number !== quotation.quotation_number
      || Number(acceptance.subject_version) !== Number(quotation.version)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_acceptance" };
    }
    const snapshot = quotation.quotation_snapshot;
    if (Number(snapshot.snapshot_version) !== 2
      || String(snapshot.client?.client_id) !== String(quotation.client_id)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_snapshot" };
    }

    const createdAt = now();
    const year = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric"
    }).format(createdAt));
    const sequence = await connection.query(
      "SELECT nextval('commission_number_sequence') AS next_number"
    );
    const commissionNumber = `SAS-COM-${year}-${String(sequence.rows[0].next_number).padStart(4, "0")}`;
    const inserted = await connection.query(
      `INSERT INTO commissions (
         commission_number, client_id, title, description, medium, width, height,
         price, deposit_amount, sales_tax, shipping, status, estimated_completion,
         source_quotation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, 'draft', $11, $12)
       ON CONFLICT (source_quotation_id) WHERE source_quotation_id IS NOT NULL DO NOTHING
       RETURNING id, commission_number, client_id, source_quotation_id, status`,
      [commissionNumber, quotation.client_id, snapshot.artwork.title,
       snapshot.artwork.description, snapshot.artwork.medium,
       snapshot.artwork.dimensions?.width, snapshot.artwork.dimensions?.height,
       snapshot.commercial.price, snapshot.commercial.sales_tax,
       snapshot.commercial.shipping_charge, snapshot.commercial.estimated_completion,
       quotation.id]
    );
    const commission = inserted.rows[0];
    if (!commission) {
      const existing = (await connection.query(
        "SELECT id, commission_number, client_id, source_quotation_id, status FROM commissions WHERE source_quotation_id = $1",
        [quotation.id]
      )).rows[0];
      await connection.query("COMMIT");
      return { outcome: "success", created: false, commission: existing };
    }
    await initializeCommissionProduction(connection, commission.id, createdAt);
    if (quotation.inquiry_id) {
      await connection.query(
        `INSERT INTO commission_inquiries (commission_id, inquiry_id, relationship_type)
         VALUES ($1, $2, 'origin')`,
        [commission.id, quotation.inquiry_id]
      );
      await appendCommissionEvent(connection, {
        commissionId: commission.id,
        eventType: "inquiry_linked",
        occurredAt: createdAt,
        actorType: "admin",
        sourceType: "inquiry",
        sourceId: quotation.inquiry_id,
        payload: { relationship_type: "origin" }
      });
    }
    await appendCommissionEvent(connection, {
      commissionId: commission.id,
      eventType: "commission_created_from_quotation",
      occurredAt: createdAt,
      actorType: "admin",
      sourceType: "quotation",
      sourceId: quotation.id,
      payload: {
        quotation_number: quotation.quotation_number,
        version: Number(quotation.version),
        acceptance_id: String(acceptance.id)
      }
    });
    await connection.query("COMMIT");
    return { outcome: "success", created: true, commission };
  } catch (error) {
    await connection.query("ROLLBACK");
    if (error?.code === "23505") {
      const existing = (await db.pool.query(
        "SELECT id, commission_number FROM commissions WHERE source_quotation_id = $1",
        [id]
      )).rows[0];
      if (existing) return { outcome: "success", created: false, commission: existing };
    }
    throw error;
  } finally {
    connection.release();
  }
}

function logFailure(action, error, details = {}) {
  console.error("Admin quotation request failed.", {
    action,
    ...details,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown",
    error_constraint: error?.constraint || null
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
    if (!adminPassword) return jsonResponse(500, { success: false, message: "Admin authentication is not configured." });
    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, { success: false, message: "Unauthorized." });
    }
    const route = parseRoute(new URL(request.url).pathname);
    if (!route) return jsonResponse(404, { success: false, message: "Admin endpoint not found." });
    if (route.id !== null && !idPattern.test(route.id)) return jsonResponse(400, { success: false, message: "Invalid id." });
    const db = databaseFactory();
    try {
      if (route.kind === "global_collection") {
        if (request.method !== "GET") return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
        const status = new URL(request.url).searchParams.get("status");
        const allowedStatuses = new Set(["draft", "issued", "sent", "accepted", "declined", "expired", "superseded", "withdrawn"]);
        if (status && !allowedStatuses.has(status)) return jsonResponse(400, { success: false, message: "Invalid quotation status." });
        const quotations = await listQuotations(db, { status });
        return jsonResponse(200, { success: true, total: quotations.length, quotations });
      }
      if (route.kind === "client_collection") {
        if (request.method === "GET") {
          const quotations = await listQuotations(db, { clientId: route.id });
          return jsonResponse(200, { success: true, total: quotations.length, quotations });
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => null);
          const normalized = normalizeDraft(body, { creation: true });
          if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
          const result = await createPreCommissionDraft(db, route.id, normalized.value, now);
          if (result.outcome === "client_not_found") return jsonResponse(404, { success: false, message: "Client not found." });
          if (result.outcome === "inquiry_not_found") return jsonResponse(404, { success: false, message: "Inquiry not found." });
          if (result.outcome === "inquiry_client_mismatch") return jsonResponse(409, { success: false, message: "Inquiry does not match the selected Client." });
          if (result.outcome === "request_conflict") return jsonResponse(409, { success: false, message: "Request id is already used for another Quotation." });
          return jsonResponse(result.created ? 201 : 200, { success: true, ...result });
        }
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET or POST." });
      }
      if (route.kind === "commission_collection") {
        if (request.method === "GET") {
          const quotations = await listQuotations(db, { commissionId: route.id });
          return jsonResponse(200, { success: true, total: quotations.length, quotations });
        }
        if (request.method === "POST") {
          return jsonResponse(409, {
            success: false,
            message: "New Quotations must be created from a Client before a Commission exists."
          });
        }
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET or POST." });
      }
      if (route.kind === "quotation") {
        if (request.method === "GET") {
          const quotation = await getQuotation(db.pool, route.id);
          return quotation
            ? jsonResponse(200, { success: true, quotation })
            : jsonResponse(404, { success: false, message: "Quotation not found." });
        }
        if (request.method === "PATCH") {
          const body = await request.json().catch(() => null);
          const normalized = normalizeDraft(body, { partial: true });
          if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
          const result = await updateDraft(db, route.id, normalized.value);
          if (result.outcome === "not_found") return jsonResponse(404, { success: false, message: "Quotation not found." });
          if (result.outcome === "immutable") return jsonResponse(409, { success: false, message: "Issued quotations are immutable. Create a new version." });
          return jsonResponse(200, { success: true, quotation: result.quotation });
        }
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET or PATCH." });
      }
      if (request.method !== "POST") return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
      if (route.kind === "create-commission") {
        const result = await createCommissionFromQuotation(db, route.id, now);
        if (result.outcome === "not_found") return jsonResponse(404, { success: false, message: "Quotation not found." });
        if (result.outcome !== "success") return jsonResponse(409, { success: false, message: "A valid accepted Quotation is required to create a Commission.", code: result.outcome });
        return jsonResponse(result.created ? 201 : 200, { success: true, ...result });
      }
      const result = route.kind === "issue"
        ? await issueQuotation(db, route.id, now)
        : route.kind === "new-version"
          ? await createNewVersion(db, route.id)
          : await transitionQuotation(db, route.id, route.kind, now);
      if (result.outcome === "not_found") return jsonResponse(404, { success: false, message: "Quotation not found." });
      if (result.outcome !== "success") return jsonResponse(409, { success: false, message: "Quotation action is not allowed in its current status." });
      return jsonResponse(result.created ? 201 : 200, { success: true, created: result.created, quotation: result.quotation });
    } catch (error) {
      logFailure(route.kind, error, { quotation_id: route.kind === "commission_collection" ? undefined : route.id });
      return jsonResponse(500, { success: false, message: "Unable to complete quotation request." });
    }
  };
}

export const config = {
  path: [
    "/admin/api/quotations",
    "/admin/api/clients/:id/quotations",
    "/admin/api/commissions/:id/quotations",
    "/admin/api/quotations/:id",
    "/admin/api/quotations/:id/issue",
    "/admin/api/quotations/:id/mark-sent",
    "/admin/api/quotations/:id/withdraw",
    "/admin/api/quotations/:id/new-version",
    "/admin/api/quotations/:id/create-commission"
  ]
};

export {
  addCalendarDays,
  buildQuotationSnapshot,
  calculateCommercials,
  createDraft,
  createPreCommissionDraft,
  createCommissionFromQuotation,
  createHandler,
  createNewVersion,
  getQuotation,
  inferSalesTaxRate,
  issueQuotation,
  listQuotations,
  normalizeDraft,
  parseRoute,
  transitionQuotation,
  updateDraft
};

export default createHandler();
