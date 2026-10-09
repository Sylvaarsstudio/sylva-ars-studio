import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH = "/admin/api/commissions";
const commissionIdPattern = /^[1-9][0-9]*$/;
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
  "estimated_completion"
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
      client_id: clientId,
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

async function listCommissions(db) {
  const result = await db.pool.query(
    `SELECT
       c.id,
       c.commission_number,
       c.title,
       c.status,
       c.price,
       c.balance,
       c.created_at,
       cl.id AS client_id,
       cl.full_name AS client_name,
       cl.email AS client_email
     FROM commissions AS c
     JOIN clients AS cl ON cl.id = c.client_id
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
       c.sales_tax,
       c.shipping,
       c.balance,
       c.status,
       c.estimated_completion,
       c.created_at
     FROM commissions AS c
     JOIN clients AS cl ON cl.id = c.client_id
     WHERE c.id = $1`,
    [id]
  );

  return result.rows[0] || null;
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
      commission: commissionResult.rows[0]
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
  environmentReader = readEnvironmentVariable
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

    const commissionId = getCommissionId(new URL(request.url).pathname);

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
        const data = await parseJsonBody(request);
        const normalized = normalizeCommissionCreate(data);

        if (normalized.error) {
          return jsonResponse(400, {
            success: false,
            message: normalized.error
          });
        }

        try {
          const result = await createCommission(databaseFactory(), normalized.commission);

          if (result.outcome === "client_not_found") {
            return jsonResponse(404, {
              success: false,
              message: "Client not found."
            });
          }

          return jsonResponse(201, {
            success: true,
            commission: result.commission
          });
        } catch (error) {
          logFailure("create", error);
          return jsonResponse(500, {
            success: false,
            message: "Unable to create commission."
          });
        }
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
    "/admin/api/commissions/:id"
  ]
};

export {
  createCommission,
  createHandler,
  getCommission,
  listCommissions,
  normalizeCommissionCreate,
  normalizeCommissionEdit,
  updateCommission
};

export default createHandler();
