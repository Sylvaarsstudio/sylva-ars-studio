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
const invoiceNumberLockNamespace = 18519;
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

async function getInvoiceByRequestId(connection, requestId) {
  const result = await connection.query(
    `SELECT id, document_type, document_number, file_location
     FROM documents
     WHERE document_type = 'invoice'
       AND request_id = $1`,
    [requestId]
  );

  return result.rows[0] || null;
}

async function getPaymentDocument(connection, paymentId, requestId) {
  const receipt = await getReceiptByPaymentId(connection, paymentId);

  if (receipt) {
    return { ...receipt, document_type: "receipt" };
  }

  return getInvoiceByRequestId(connection, requestId);
}

function attachPaymentDocument(payment) {
  const {
    document_id: documentId,
    document_type: documentType,
    document_number: documentNumber,
    document_file_location: fileLocation,
    ...paymentFields
  } = payment;
  const document = documentId
    ? {
        id: documentId,
        document_type: documentType,
        document_number: documentNumber,
        file_location: fileLocation
      }
    : null;

  return {
    ...paymentFields,
    document,
    receipt: document?.document_type === "receipt" ? document : null
  };
}

function normalizePaymentRow(payment) {
  return {
    id: String(payment.id),
    commission_id: String(payment.commission_id),
    payment_type: payment.payment_type,
    amount: Number(payment.amount).toFixed(2),
    sales_tax: Number(payment.sales_tax).toFixed(2),
    payment_method: payment.payment_method,
    payment_date: payment.payment_date,
    status: payment.status,
    external_reference: payment.external_reference,
    notes: payment.notes,
    balance_after_payment: Number(payment.balance_after_payment).toFixed(2),
    created_at: payment.created_at
  };
}

function normalizeCommissionRow(commission) {
  return {
    id: String(commission.id),
    price: Number(commission.price).toFixed(2),
    deposit_amount: Number(commission.deposit_amount).toFixed(2),
    amount_paid: Number(commission.amount_paid).toFixed(2),
    sales_tax: Number(commission.sales_tax).toFixed(2),
    shipping: Number(commission.shipping).toFixed(2),
    balance: Number(commission.balance).toFixed(2)
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
       COALESCE(r.id, i.id) AS document_id,
       COALESCE(r.document_type, i.document_type) AS document_type,
       COALESCE(r.document_number, i.document_number) AS document_number,
       COALESCE(r.file_location, i.file_location) AS document_file_location
     FROM payments AS p
     LEFT JOIN documents AS r
       ON r.payment_id = p.id
      AND r.document_type = 'receipt'
     LEFT JOIN documents AS i
       ON i.request_id = p.request_id
      AND i.document_type = 'invoice'
     WHERE p.commission_id = $1
     ORDER BY p.payment_date DESC NULLS LAST, p.created_at DESC, p.id DESC`,
    [commissionId]
  );

  return {
    outcome: "success",
    commission,
    payments: result.rows.map(attachPaymentDocument)
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

function buildFinalInvoiceSnapshot({ invoiceNumber, invoiceDate, commission, payments }) {
  const sortableDate = (value) => {
    if (!value) {
      return "9999-12-31";
    }

    const normalized = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(normalized)
      ? normalized.slice(0, 10)
      : new Date(value).toISOString().slice(0, 10);
  };
  const chronologicalPayments = [...payments].sort((left, right) => {
    const leftDate = sortableDate(left.payment_date);
    const rightDate = sortableDate(right.payment_date);
    const dateDifference = leftDate.localeCompare(rightDate);

    if (dateDifference) {
      return dateDifference;
    }

    if (Boolean(left.is_final_payment) !== Boolean(right.is_final_payment)) {
      return left.is_final_payment ? 1 : -1;
    }

    const leftCreatedAt = left.created_at ? new Date(left.created_at).getTime() : 0;
    const rightCreatedAt = right.created_at ? new Date(right.created_at).getTime() : 0;
    const createdDifference = leftCreatedAt - rightCreatedAt;
    return createdDifference || Number(left.id || 0) - Number(right.id || 0);
  });

  return {
    schema_version: 1,
    invoice: {
      number: invoiceNumber,
      version: 1,
      invoice_date: invoiceDate,
      financial_status: "PAID"
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
    commission: {
      id: commission.id,
      number: commission.commission_number,
      title: commission.title,
      description: commission.description,
      medium: commission.medium,
      width: commission.width,
      height: commission.height
    },
    financial: {
      price: commission.price,
      sales_tax: commission.sales_tax,
      shipping: commission.shipping,
      total: addMoney(commission.price, commission.sales_tax, commission.shipping),
      amount_paid: commission.amount_paid,
      balance: "0.00"
    },
    payments: chronologicalPayments.map((payment) => ({
      payment_type: payment.payment_type,
      amount: payment.amount,
      sales_tax: payment.sales_tax,
      payment_method: payment.payment_method,
      payment_date: payment.payment_date,
      external_reference: payment.external_reference,
      receipt_number: payment.receipt_number || null
    })),
    studio: {
      name: businessInformation.name,
      address_line_1: businessInformation.addressLine1,
      address_line_2: businessInformation.addressLine2,
      email: businessInformation.email,
      phone: businessInformation.phone,
      website: businessInformation.website
    }
  };
}

async function createPayment(db, commissionId, data, numberRetryCount = 0) {
  const connection = await db.pool.connect();
  let connectionReleased = false;

  try {
    await connection.query("BEGIN");
    let existing = await getPaymentByRequestId(connection, data.request_id);

    if (existing) {
      const commission = await getCommission(connection, existing.commission_id);
      const document = await getPaymentDocument(
        connection,
        existing.id,
        data.request_id
      );
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? {
            outcome: "success",
            created: false,
            payment: existing,
            document,
            receipt: document?.document_type === "receipt" ? document : null,
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
      const document = await getPaymentDocument(
        connection,
        existing.id,
        data.request_id
      );
      await connection.query("COMMIT");
      return String(existing.commission_id) === String(commissionId)
        ? {
            outcome: "success",
            created: false,
            payment: existing,
            document,
            receipt: document?.document_type === "receipt" ? document : null,
            commission: lockedCommission
          }
        : { outcome: "request_id_conflict" };
    }

    if (Number(data.amount) > Number(lockedCommission.balance)) {
      await connection.query("ROLLBACK");
      return { outcome: "overpayment" };
    }

    const issuedAt = new Date().toISOString();
    const documentYear = new Date(issuedAt).getUTCFullYear();
    const balanceAfterPayment = subtractMoney(lockedCommission.balance, data.amount);
    const isFinalPayment = Number(balanceAfterPayment) === 0;
    const updatedCommission = {
      ...lockedCommission,
      deposit_amount: data.payment_type === "deposit"
        ? addMoney(lockedCommission.deposit_amount, data.amount)
        : lockedCommission.deposit_amount,
      amount_paid: addMoney(lockedCommission.amount_paid, data.amount),
      balance: balanceAfterPayment
    };
    const numberNamespace = isFinalPayment
      ? invoiceNumberLockNamespace
      : receiptNumberLockNamespace;
    const numberPrefix = isFinalPayment ? "SAS-INV" : "SAS-REC";
    const documentType = isFinalPayment ? "invoice" : "receipt";

    const documentNumber = `${numberPrefix}-${documentYear}-0000`;
    let snapshot;

    if (isFinalPayment) {
      const historyResult = await connection.query(
        `SELECT
           p.payment_type,
           p.amount,
           p.sales_tax,
           p.payment_method,
           p.payment_date,
           p.external_reference,
           p.created_at,
           p.id,
           r.document_number AS receipt_number
         FROM payments AS p
         LEFT JOIN documents AS r
           ON r.payment_id = p.id
          AND r.document_type = 'receipt'
         WHERE p.commission_id = $1
           AND p.status = 'completed'
         ORDER BY p.payment_date ASC NULLS LAST, p.created_at ASC, p.id ASC`,
        [commissionId]
      );
      snapshot = buildFinalInvoiceSnapshot({
        invoiceNumber: documentNumber,
        invoiceDate: data.payment_date
          || getCalendarDateInTimeZone(new Date(issuedAt)),
        commission: updatedCommission,
        payments: [
          ...historyResult.rows,
          {
            payment_type: data.payment_type,
            amount: data.amount,
            sales_tax: data.sales_tax,
            payment_method: data.payment_method,
            payment_date: data.payment_date,
            external_reference: data.external_reference,
            created_at: issuedAt,
            id: Number.MAX_SAFE_INTEGER,
            is_final_payment: true,
            receipt_number: null
          }
        ]
      });
    } else {
      snapshot = buildReceiptSnapshot({
        receiptNumber: documentNumber,
        issuedAt,
        payment: {
          id: null,
          ...data,
          balance_after_payment: balanceAfterPayment
        },
        commission: updatedCommission
      });
    }

    const creationResult = await connection.query(
      `WITH number_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock($13::integer, $14::integer)
       ),
       next_document_number AS MATERIALIZED (
         SELECT $15::text || '-' || $14::text || '-' || lpad(
           (COALESCE(MAX(split_part(d.document_number, '-', 4)::integer), 0) + 1)::text,
           4,
           '0'
         ) AS document_number
         FROM documents AS d
         CROSS JOIN number_lock
         WHERE d.document_type = $10
           AND d.document_number LIKE $15::text || '-' || $14::text || '-%'
       ),
       locked_commission AS MATERIALIZED (
         SELECT id, balance
         FROM commissions
         WHERE id = $1
           AND balance >= $4
         FOR UPDATE
       ),
       inserted_payment AS (
         INSERT INTO payments (
           commission_id, request_id, payment_type, amount, sales_tax,
           payment_method, payment_date, status, external_reference, notes,
           balance_after_payment
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, lc.balance - $4
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
       inserted_document AS (
         INSERT INTO documents (
           commission_id, payment_id, document_type, document_number, version,
           file_location, receipt_snapshot, document_snapshot, request_id
         )
         SELECT
           $1,
           CASE WHEN $10 = 'receipt' THEN p.id ELSE NULL END,
           $10,
           n.document_number,
           1,
           $11,
           CASE WHEN $10 = 'receipt' THEN
             jsonb_set(
               jsonb_set(
                 jsonb_set($12::jsonb, '{receipt,number}', to_jsonb(n.document_number), false),
                 '{payment,id}',
                 to_jsonb(p.id),
                 false
               ),
               '{payment,balance_after_payment}',
               to_jsonb(p.balance_after_payment::text),
               false
             )
           ELSE NULL END,
           CASE WHEN $10 = 'invoice' THEN
             jsonb_set($12::jsonb, '{invoice,number}', to_jsonb(n.document_number), false)
           ELSE NULL END,
           CASE WHEN $10 = 'invoice' THEN $2::uuid ELSE NULL END
         FROM inserted_payment AS p
         JOIN updated_commission AS c ON c.id = p.commission_id
         CROSS JOIN next_document_number AS n
         ON CONFLICT (document_number, version) DO NOTHING
         RETURNING id, document_type, document_number
       )
       SELECT
         row_to_json(p) AS payment,
         row_to_json(c) AS commission,
         d.id AS document_id,
         d.document_type,
         d.document_number
       FROM updated_commission AS c
       CROSS JOIN inserted_payment AS p
       CROSS JOIN inserted_document AS d`,
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
        documentType,
        isFinalPayment ? "/admin/invoice.html" : "/admin/payment-receipt.html",
        JSON.stringify(snapshot),
        numberNamespace,
        documentYear,
        numberPrefix
      ]
    );

    if (!creationResult.rows[0]) {
      await connection.query("ROLLBACK");
      existing = await getPaymentByRequestId(db.pool, data.request_id);

      if (existing) {
        const commission = await getCommission(db.pool, existing.commission_id);
        const document = await getPaymentDocument(db.pool, existing.id, data.request_id);
        return String(existing.commission_id) === String(commissionId)
          ? {
              outcome: "success",
              created: false,
              payment: existing,
              document,
              receipt: document?.document_type === "receipt" ? document : null,
              commission
            }
          : { outcome: "request_id_conflict" };
      }

      const currentCommission = await getCommission(db.pool, commissionId);

      if (
        currentCommission
        && Number(data.amount) <= Number(currentCommission.balance)
        && numberRetryCount < 2
      ) {
        connection.release();
        connectionReleased = true;
        return createPayment(db, commissionId, data, numberRetryCount + 1);
      }

      return { outcome: "overpayment" };
    }

    const payment = normalizePaymentRow(creationResult.rows[0].payment);
    const commission = normalizeCommissionRow(creationResult.rows[0].commission);
    const documentId = String(creationResult.rows[0].document_id);
    const fileLocation = isFinalPayment
      ? `/admin/invoice.html?document=${documentId}`
      : `/admin/payment-receipt.html?receipt=${documentId}`;
    const storedDocument = (await connection.query(
      `UPDATE documents
       SET file_location = $1
       WHERE id = $2
       RETURNING id, document_type, document_number, file_location`,
      [fileLocation, documentId]
    )).rows[0];
    const document = {
      id: String(storedDocument.id),
      document_type: storedDocument.document_type,
      document_number: storedDocument.document_number,
      file_location: storedDocument.file_location
    };

    await connection.query("COMMIT");
    const canonicalPayment = await getPaymentByRequestId(db.pool, data.request_id);

    if (canonicalPayment && String(canonicalPayment.id) !== String(payment.id)) {
      const canonicalDocument = await getPaymentDocument(
        db.pool,
        canonicalPayment.id,
        data.request_id
      );
      const canonicalCommission = await getCommission(
        db.pool,
        canonicalPayment.commission_id
      );

      return {
        outcome: "success",
        created: false,
        payment: canonicalPayment,
        document: canonicalDocument,
        receipt: canonicalDocument?.document_type === "receipt"
          ? canonicalDocument
          : null,
        commission: canonicalCommission
      };
    }

    return {
      outcome: "success",
      created: true,
      payment,
      document,
      receipt: document.document_type === "receipt" ? document : null,
      commission
    };
  } catch (error) {
    await connection.query("ROLLBACK");

    if (error?.code === "23505") {
      const existing = await getPaymentByRequestId(db.pool, data.request_id);

      if (existing) {
        const commission = await getCommission(db.pool, existing.commission_id);
        const document = await getPaymentDocument(
          db.pool,
          existing.id,
          data.request_id
        );

        return String(existing.commission_id) === String(commissionId)
          ? {
              outcome: "success",
              created: false,
              payment: existing,
              document,
              receipt: document?.document_type === "receipt" ? document : null,
              commission
            }
          : { outcome: "request_id_conflict" };
      }
    }

    throw error;
  } finally {
    if (!connectionReleased) {
      connection.release();
    }
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
        document: result.document,
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
  buildFinalInvoiceSnapshot,
  buildReceiptSnapshot,
  createHandler,
  createPayment,
  getReceiptByPaymentId,
  getInvoiceByRequestId,
  getCalendarDateInTimeZone,
  getCommissionId,
  listPayments,
  normalizePaymentCreate,
  invoiceNumberLockNamespace,
  receiptNumberLockNamespace
};

export default createHandler();
