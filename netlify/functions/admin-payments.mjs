import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH_PATTERN = /^\/admin\/api\/commissions\/([^/]+)\/payments\/?$/;
const commissionIdPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedPaymentTypes = new Set(["deposit", "installment", "balance"]);
const createFields = new Set([
  "request_id",
  "payment_type",
  "amount",
  "sales_tax",
  "payment_method",
  "payment_date",
  "external_reference",
  "notes"
]);
const paymentSelect = `
  id,
  commission_id,
  payment_type,
  amount,
  sales_tax,
  payment_method,
  payment_date,
  status,
  external_reference,
  notes,
  created_at`;
const commissionSelect = `
  id,
  price,
  deposit_amount,
  amount_paid,
  sales_tax,
  shipping,
  balance`;

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
  const match = pathname.match(API_PATH_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
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

function normalizeOptionalText(value) {
  if (value === null || value === undefined) {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: "Optional text fields must be strings." };
  }

  return { value: value.trim() || null };
}

function formatCents(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function normalizeMoney(value, label, { required = false } = {}) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");

  if (!normalized) {
    return required
      ? { error: `${label} is required.` }
      : { cents: 0, value: "0.00" };
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

  if (required && cents <= 0) {
    return { error: `${label} must be greater than 0.` };
  }

  return { cents, value: formatCents(cents) };
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: "Payment date must be a valid date." };
  }

  const normalized = value.trim();
  const date = new Date(`${normalized}T00:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== normalized
  ) {
    return { error: "Payment date must be a valid date." };
  }

  return { value: normalized };
}

function normalizePaymentCreate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  if (Object.keys(data).some((field) => !createFields.has(field))) {
    return { error: "Request body contains unsupported fields." };
  }

  if (typeof data.request_id !== "string" || !uuidPattern.test(data.request_id.trim())) {
    return { error: "Request id must be a valid UUID." };
  }

  if (typeof data.payment_type !== "string" || !allowedPaymentTypes.has(data.payment_type)) {
    return { error: "Payment type is unsupported." };
  }

  const amount = normalizeMoney(data.amount, "Amount", { required: true });
  const salesTax = normalizeMoney(data.sales_tax, "Sales tax");
  const paymentMethod = normalizeOptionalText(data.payment_method);
  const paymentDate = normalizeDate(data.payment_date);
  const externalReference = normalizeOptionalText(data.external_reference);
  const notes = normalizeOptionalText(data.notes);
  const firstError = [
    amount,
    salesTax,
    paymentMethod,
    paymentDate,
    externalReference,
    notes
  ].find((result) => result.error);

  if (firstError) {
    return { error: firstError.error };
  }

  if (salesTax.cents > amount.cents) {
    return { error: "Sales tax cannot exceed amount." };
  }

  return {
    payment: {
      request_id: data.request_id.trim().toLowerCase(),
      payment_type: data.payment_type,
      amount: amount.value,
      sales_tax: salesTax.value,
      payment_method: paymentMethod.value,
      payment_date: paymentDate.value,
      external_reference: externalReference.value,
      notes: notes.value
    }
  };
}

async function getCommission(connection, commissionId) {
  const result = await connection.query(
    `SELECT ${commissionSelect}
     FROM commissions
     WHERE id = $1`,
    [commissionId]
  );

  return result.rows[0] || null;
}

async function getPaymentByRequestId(connection, requestId) {
  const result = await connection.query(
    `SELECT ${paymentSelect}
     FROM payments
     WHERE request_id = $1`,
    [requestId]
  );

  return result.rows[0] || null;
}

async function listPayments(db, commissionId) {
  const commission = await getCommission(db.pool, commissionId);

  if (!commission) {
    return { outcome: "not_found" };
  }

  const result = await db.pool.query(
    `SELECT ${paymentSelect}
     FROM payments
     WHERE commission_id = $1
     ORDER BY payment_date DESC NULLS LAST, created_at DESC, id DESC`,
    [commissionId]
  );

  return {
    outcome: "success",
    commission,
    payments: result.rows
  };
}

async function createPayment(db, commissionId, data) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    let existing = await getPaymentByRequestId(connection, data.request_id);

    if (existing) {
      const commission = await getCommission(connection, existing.commission_id);
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? { outcome: "success", created: false, payment: existing, commission }
        : { outcome: "request_id_conflict" };
    }

    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-payments-v1'), hashtext($1::text))",
      [commissionId]
    );
    const lockedResult = await connection.query(
      `SELECT ${commissionSelect}
       FROM commissions
       WHERE id = $1
       FOR UPDATE`,
      [commissionId]
    );
    const lockedCommission = lockedResult.rows[0];

    if (!lockedCommission) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    existing = await getPaymentByRequestId(connection, data.request_id);

    if (existing) {
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? {
            outcome: "success",
            created: false,
            payment: existing,
            commission: lockedCommission
          }
        : { outcome: "request_id_conflict" };
    }

    if (Number(data.amount) > Number(lockedCommission.balance)) {
      await connection.query("ROLLBACK");
      return { outcome: "overpayment" };
    }

    const result = await connection.query(
      `WITH updated_commission AS (
         UPDATE commissions
         SET
           amount_paid = amount_paid + $1,
           deposit_amount = deposit_amount + CASE WHEN $2 = 'deposit' THEN $1 ELSE 0 END
         WHERE id = $3
           AND amount_paid + $1 <= price + sales_tax + shipping
         RETURNING ${commissionSelect}
       ),
       inserted_payment AS (
         INSERT INTO payments (
           commission_id,
           request_id,
           payment_type,
           amount,
           sales_tax,
           payment_method,
           payment_date,
           status,
           external_reference,
           notes
         )
         SELECT $3, $4, $2, $1, $5, $6, $7, 'completed', $8, $9
         FROM updated_commission
         RETURNING ${paymentSelect}
       )
       SELECT
         p.id AS payment_id,
         p.commission_id AS payment_commission_id,
         p.payment_type,
         p.amount,
         p.sales_tax AS payment_sales_tax,
         p.payment_method,
         p.payment_date,
         p.status AS payment_status,
         p.external_reference,
         p.notes,
         p.created_at AS payment_created_at,
         c.id AS financial_commission_id,
         c.price,
         c.deposit_amount,
         c.amount_paid,
         c.sales_tax AS commission_sales_tax,
         c.shipping,
         c.balance
       FROM inserted_payment AS p
       JOIN updated_commission AS c ON true`,
      [
        data.amount,
        data.payment_type,
        commissionId,
        data.request_id,
        data.sales_tax,
        data.payment_method,
        data.payment_date,
        data.external_reference,
        data.notes
      ]
    );

    if (!result.rows[0]) {
      await connection.query("ROLLBACK");
      return { outcome: "overpayment" };
    }

    await connection.query("COMMIT");
    return {
      outcome: "success",
      created: true,
      payment: {
        id: result.rows[0].payment_id,
        commission_id: result.rows[0].payment_commission_id,
        payment_type: result.rows[0].payment_type,
        amount: result.rows[0].amount,
        sales_tax: result.rows[0].payment_sales_tax,
        payment_method: result.rows[0].payment_method,
        payment_date: result.rows[0].payment_date,
        status: result.rows[0].payment_status,
        external_reference: result.rows[0].external_reference,
        notes: result.rows[0].notes,
        created_at: result.rows[0].payment_created_at
      },
      commission: {
        id: result.rows[0].financial_commission_id,
        price: result.rows[0].price,
        deposit_amount: result.rows[0].deposit_amount,
        amount_paid: result.rows[0].amount_paid,
        sales_tax: result.rows[0].commission_sales_tax,
        shipping: result.rows[0].shipping,
        balance: result.rows[0].balance
      }
    };
  } catch (error) {
    await connection.query("ROLLBACK");

    if (error?.code === "23505") {
      const existing = await getPaymentByRequestId(connection, data.request_id);

      if (existing) {
        const commission = await getCommission(connection, existing.commission_id);

        return String(existing.commission_id) === String(commissionId)
          ? { outcome: "success", created: false, payment: existing, commission }
          : { outcome: "request_id_conflict" };
      }
    }

    throw error;
  } finally {
    connection.release();
  }
}

function logFailure(action, error, details = {}) {
  console.error("Admin payment request failed.", {
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

    if (commissionId === null) {
      return jsonResponse(404, {
        success: false,
        message: "Admin endpoint not found."
      });
    }

    if (commissionId === undefined || !commissionIdPattern.test(commissionId)) {
      return jsonResponse(400, {
        success: false,
        message: "Invalid commission id."
      });
    }

    if (request.method === "GET") {
      try {
        const result = await listPayments(databaseFactory(), commissionId);

        if (result.outcome === "not_found") {
          return jsonResponse(404, {
            success: false,
            message: "Commission not found."
          });
        }

        return jsonResponse(200, {
          success: true,
          total: result.payments.length,
          commission: result.commission,
          payments: result.payments
        });
      } catch (error) {
        logFailure("list", error, { commission_id: commissionId });
        return jsonResponse(500, {
          success: false,
          message: "Unable to load payments."
        });
      }
    }

    if (request.method !== "POST") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use GET or POST."
      });
    }

    const data = await parseJsonBody(request);
    const normalized = normalizePaymentCreate(data);

    if (normalized.error) {
      return jsonResponse(400, {
        success: false,
        message: normalized.error
      });
    }

    try {
      const result = await createPayment(
        databaseFactory(),
        commissionId,
        normalized.payment
      );

      if (result.outcome === "not_found") {
        return jsonResponse(404, {
          success: false,
          message: "Commission not found."
        });
      }

      if (result.outcome === "overpayment") {
        return jsonResponse(409, {
          success: false,
          message: "Payment amount exceeds the commission balance."
        });
      }

      if (result.outcome === "request_id_conflict") {
        return jsonResponse(409, {
          success: false,
          message: "Payment request id is already in use."
        });
      }

      return jsonResponse(result.created ? 201 : 200, {
        success: true,
        created: result.created,
        payment: result.payment,
        commission: result.commission
      });
    } catch (error) {
      logFailure("create", error, { commission_id: commissionId });
      return jsonResponse(500, {
        success: false,
        message: "Unable to record payment."
      });
    }
  };
}

export const config = {
  path: "/admin/api/commissions/:id/payments"
};

export {
  allowedPaymentTypes,
  createHandler,
  createPayment,
  getCommissionId,
  listPayments,
  normalizePaymentCreate
};

export default createHandler();
