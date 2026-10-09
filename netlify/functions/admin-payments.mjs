import { getDatabase } from "@netlify/database";
import businessInformation from "../../web/js/business-info.js";

import { hasValidAdminSession } from "../shared/admin-session.mjs";

const API_PATH_PATTERN = /^\/admin\/api\/commissions\/([^/]+)\/payments\/?$/;
const commissionIdPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedPaymentTypes = new Set(["deposit", "installment", "balance"]);
const allowedPaymentMethods = new Set([
  "cash",
  "card",
  "bank_transfer",
  "check",
  "zelle",
  "paypal"
]);
const receiptNumberLockNamespace = 18518;
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
  balance_after_payment,
  created_at`;
const commissionSelect = `
  id,
  price,
  deposit_amount,
  amount_paid,
  sales_tax,
  shipping,
  balance`;
const receiptCommissionSelect = `
  c.id,
  c.commission_number,
  c.title,
  c.price,
  c.deposit_amount,
  c.amount_paid,
  c.sales_tax,
  c.shipping,
  c.balance,
  cl.full_name AS client_name,
  cl.email AS client_email,
  cl.phone AS client_phone,
  cl.address_line_1,
  cl.address_line_2,
  cl.city,
  cl.state,
  cl.postal_code,
  cl.country`;

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

function normalizePaymentMethod(value) {
  const normalized = normalizeOptionalText(value);

  if (normalized.error) {
    return { error: "Payment method is unsupported." };
  }

  if (normalized.value !== null && !allowedPaymentMethods.has(normalized.value)) {
    return { error: "Payment method is unsupported." };
  }

  return normalized;
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
  const paymentMethod = normalizePaymentMethod(data.payment_method);
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

async function getReceiptByPaymentId(connection, paymentId) {
  const result = await connection.query(
    `SELECT id, document_number, file_location
     FROM documents
     WHERE document_type = 'receipt'
       AND payment_id = $1`,
    [paymentId]
  );

  return result.rows[0] || null;
}

function attachReceipt(payment) {
  const {
    receipt_id: receiptId,
    receipt_document_number: documentNumber,
    receipt_file_location: fileLocation,
    ...paymentFields
  } = payment;

  return {
    ...paymentFields,
    receipt: receiptId
      ? {
          id: receiptId,
          document_number: documentNumber,
          file_location: fileLocation
        }
      : null
  };
}

async function listPayments(db, commissionId) {
  const commission = await getCommission(db.pool, commissionId);

  if (!commission) {
    return { outcome: "not_found" };
  }

  const result = await db.pool.query(
    `SELECT
       p.id,
       p.commission_id,
       p.payment_type,
       p.amount,
       p.sales_tax,
       p.payment_method,
       p.payment_date,
       p.status,
       p.external_reference,
       p.notes,
       p.balance_after_payment,
       p.created_at,
       d.id AS receipt_id,
       d.document_number AS receipt_document_number,
       d.file_location AS receipt_file_location
     FROM payments AS p
     LEFT JOIN documents AS d
       ON d.payment_id = p.id
      AND d.document_type = 'receipt'
     WHERE p.commission_id = $1
     ORDER BY p.payment_date DESC NULLS LAST, p.created_at DESC, p.id DESC`,
    [commissionId]
  );

  return {
    outcome: "success",
    commission,
    payments: result.rows.map(attachReceipt)
  };
}

function addMoney(...values) {
  return formatCents(values.reduce(
    (total, value) => total + Math.round(Number(value) * 100),
    0
  ));
}

function subtractMoney(total, ...values) {
  return formatCents(
    Math.round(Number(total) * 100)
    - values.reduce((sum, value) => sum + Math.round(Number(value) * 100), 0)
  );
}

function buildReceiptSnapshot({ receiptNumber, issuedAt, payment, commission }) {
  return {
    receipt: {
      number: receiptNumber,
      issued_at: issuedAt
    },
    payment: {
      id: payment.id,
      type: payment.payment_type,
      amount: payment.amount,
      sales_tax: payment.sales_tax,
      method: payment.payment_method,
      payment_date: payment.payment_date,
      external_reference: payment.external_reference,
      notes: payment.notes,
      balance_after_payment: payment.balance_after_payment
    },
    commission: {
      id: commission.id,
      number: commission.commission_number,
      title: commission.title,
      price: commission.price,
      sales_tax: commission.sales_tax,
      shipping: commission.shipping,
      total: addMoney(commission.price, commission.sales_tax, commission.shipping)
    },
    client: {
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
    studio: {
      name: businessInformation.name,
      email: businessInformation.email,
      phone: businessInformation.phone,
      website: businessInformation.website
    }
  };
}

async function createPayment(db, commissionId, data) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    let existing = await getPaymentByRequestId(connection, data.request_id);

    if (existing) {
      const commission = await getCommission(connection, existing.commission_id);
      const receipt = await getReceiptByPaymentId(connection, existing.id);
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? {
            outcome: "success",
            created: false,
            payment: existing,
            receipt,
            commission
          }
        : { outcome: "request_id_conflict" };
    }

    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-payments-v1'), hashtext($1::text))",
      [commissionId]
    );
    const lockedResult = await connection.query(
      `SELECT ${receiptCommissionSelect}
       FROM commissions AS c
       JOIN clients AS cl ON cl.id = c.client_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [commissionId]
    );
    const lockedCommission = lockedResult.rows[0];

    if (!lockedCommission) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    existing = await getPaymentByRequestId(connection, data.request_id);

    if (existing) {
      const receipt = await getReceiptByPaymentId(connection, existing.id);
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? {
            outcome: "success",
            created: false,
            payment: existing,
            receipt,
            commission: lockedCommission
          }
        : { outcome: "request_id_conflict" };
    }

    if (Number(data.amount) > Number(lockedCommission.balance)) {
      await connection.query("ROLLBACK");
      return { outcome: "overpayment" };
    }

    const updatedCommission = {
      id: lockedCommission.id,
      price: lockedCommission.price,
      deposit_amount: data.payment_type === "deposit"
        ? addMoney(lockedCommission.deposit_amount, data.amount)
        : lockedCommission.deposit_amount,
      amount_paid: addMoney(lockedCommission.amount_paid, data.amount),
      sales_tax: lockedCommission.sales_tax,
      shipping: lockedCommission.shipping,
      balance: subtractMoney(
        addMoney(
          lockedCommission.price,
          lockedCommission.sales_tax,
          lockedCommission.shipping
        ),
        addMoney(lockedCommission.amount_paid, data.amount)
      )
    };

    const issuedAt = new Date().toISOString();
    const receiptYear = new Date(issuedAt).getUTCFullYear();

    await connection.query(
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [receiptNumberLockNamespace, receiptYear]
    );
    const sequenceResult = await connection.query(
      `SELECT COALESCE(MAX(split_part(document_number, '-', 4)::integer), 0) + 1 AS next_number
       FROM documents
       WHERE document_type = 'receipt'
         AND document_number LIKE $1`,
      [`SAS-REC-${receiptYear}-%`]
    );
    const receiptNumber = `SAS-REC-${receiptYear}-${String(
      Number(sequenceResult.rows[0].next_number)
    ).padStart(4, "0")}`;
    const snapshot = buildReceiptSnapshot({
      receiptNumber,
      issuedAt,
      payment: {
        id: null,
        payment_type: data.payment_type,
        amount: data.amount,
        sales_tax: data.sales_tax,
        payment_method: data.payment_method,
        payment_date: data.payment_date,
        external_reference: data.external_reference,
        notes: data.notes,
        balance_after_payment: updatedCommission.balance
      },
      commission: {
        ...lockedCommission,
        ...updatedCommission
      }
    });
    const creationResult = await connection.query(
      `WITH locked_commission AS MATERIALIZED (
         SELECT id, balance
         FROM commissions
         WHERE id = $1
           AND balance >= $4
         FOR UPDATE
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
           notes,
           balance_after_payment
         )
         SELECT
           $1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, lc.balance - $4
         FROM locked_commission AS lc
         ON CONFLICT (request_id) DO NOTHING
         RETURNING *
       ),
       updated_commission AS (
         UPDATE commissions AS c
         SET
           amount_paid = c.amount_paid + p.amount,
           deposit_amount = c.deposit_amount
             + CASE WHEN p.payment_type = 'deposit' THEN p.amount ELSE 0 END
         FROM inserted_payment AS p
         WHERE c.id = p.commission_id
         RETURNING c.id, c.price, c.deposit_amount, c.amount_paid,
                   c.sales_tax, c.shipping, c.balance
       ),
       inserted_receipt AS (
         INSERT INTO documents (
           commission_id,
           payment_id,
           document_type,
           document_number,
           version,
           file_location,
           receipt_snapshot
         )
         SELECT
           $1,
           p.id,
           'receipt',
           $10,
           1,
           '/admin/payment-receipt.html',
           jsonb_set(
             jsonb_set($11::jsonb, '{payment,id}', to_jsonb(p.id), false),
             '{payment,balance_after_payment}',
             to_jsonb(p.balance_after_payment::text),
             false
           )
         FROM inserted_payment AS p
         JOIN updated_commission AS c ON c.id = p.commission_id
         RETURNING id, document_number
       )
       SELECT
         row_to_json(p) AS payment,
         row_to_json(c) AS commission,
         r.id AS receipt_id,
         r.document_number
       FROM updated_commission AS c
       CROSS JOIN inserted_payment AS p
       CROSS JOIN inserted_receipt AS r`,
      [
        commissionId,
        data.request_id,
        data.payment_type,
        data.amount,
        data.sales_tax,
        data.payment_method,
        data.payment_date,
        data.external_reference,
        data.notes,
        receiptNumber,
        JSON.stringify(snapshot)
      ]
    );

    if (!creationResult.rows[0]) {
      await connection.query("ROLLBACK");
      existing = await getPaymentByRequestId(connection, data.request_id);

      if (existing) {
        const commission = await getCommission(connection, existing.commission_id);
        const receipt = await getReceiptByPaymentId(connection, existing.id);
        return String(existing.commission_id) === String(commissionId)
          ? {
              outcome: "success",
              created: false,
              payment: existing,
              receipt,
              commission
            }
          : { outcome: "request_id_conflict" };
      }

      return { outcome: "overpayment" };
    }
    const rawPayment = creationResult.rows[0].payment;
    const payment = {
      id: String(rawPayment.id),
      commission_id: String(rawPayment.commission_id),
      payment_type: rawPayment.payment_type,
      amount: Number(rawPayment.amount).toFixed(2),
      sales_tax: Number(rawPayment.sales_tax).toFixed(2),
      payment_method: rawPayment.payment_method,
      payment_date: rawPayment.payment_date,
      status: rawPayment.status,
      external_reference: rawPayment.external_reference,
      notes: rawPayment.notes,
      balance_after_payment: Number(rawPayment.balance_after_payment).toFixed(2),
      created_at: rawPayment.created_at
    };
    const rawCommission = creationResult.rows[0].commission;
    const commission = {
      id: String(rawCommission.id),
      price: Number(rawCommission.price).toFixed(2),
      deposit_amount: Number(rawCommission.deposit_amount).toFixed(2),
      amount_paid: Number(rawCommission.amount_paid).toFixed(2),
      sales_tax: Number(rawCommission.sales_tax).toFixed(2),
      shipping: Number(rawCommission.shipping).toFixed(2),
      balance: Number(rawCommission.balance).toFixed(2)
    };
    const receiptId = String(creationResult.rows[0].receipt_id);
    const fileLocation = `/admin/payment-receipt.html?receipt=${receiptId}`;
    const storedReceipt = (await connection.query(
      `UPDATE documents
       SET file_location = $1
       WHERE id = $2
       RETURNING id, document_number, file_location`,
      [fileLocation, receiptId]
    )).rows[0];
    const receipt = {
      id: String(storedReceipt.id),
      document_number: storedReceipt.document_number,
      file_location: storedReceipt.file_location
    };

    await connection.query("COMMIT");
    return {
      outcome: "success",
      created: true,
      payment,
      receipt,
      commission
    };
  } catch (error) {
    await connection.query("ROLLBACK");

    if (error?.code === "23505") {
      const existing = await getPaymentByRequestId(db.pool, data.request_id);

      if (existing) {
        const commission = await getCommission(db.pool, existing.commission_id);
        const receipt = await getReceiptByPaymentId(db.pool, existing.id);

        return String(existing.commission_id) === String(commissionId)
          ? {
              outcome: "success",
              created: false,
              payment: existing,
              receipt,
              commission
            }
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
        receipt: result.receipt,
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
  allowedPaymentMethods,
  allowedPaymentTypes,
  buildReceiptSnapshot,
  createHandler,
  createPayment,
  getReceiptByPaymentId,
  getCommissionId,
  listPayments,
  normalizePaymentCreate,
  receiptNumberLockNamespace
};

export default createHandler();
