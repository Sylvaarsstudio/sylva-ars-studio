import businessInformation from "../../web/js/business-info.js";

import { activateCommissionFromRequiredDeposit } from "./commission-activation.mjs";
import { attemptAutomaticCommunicationSend } from "./communication-automations.mjs";
import { centsToMoney, moneyToCents } from "./commission-obligations.mjs";
import { getCommunicationTemplate, renderCommunicationTemplate } from "./communication-templates.mjs";
import { resolveRequiredDepositSource } from "./precommission-deposit.mjs";

const receiptNumberLockNamespace = 18518;
const documentNumberToken = "__SAS_DOCUMENT_NUMBER__";

function getCalendarDateInTimeZone(date, timeZone = "America/New_York") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizePrecommissionPaymentRow(row) {
  return {
    id: String(row.id),
    commission_id: row.commission_id === null ? null : String(row.commission_id),
    client_id: String(row.client_id),
    quotation_id: String(row.quotation_id),
    precommission_obligation_id: String(row.precommission_obligation_id),
    payment_type: row.payment_type,
    amount: String(row.amount),
    sales_tax: String(row.sales_tax),
    payment_method: row.payment_method,
    payment_date: row.payment_date,
    status: row.status,
    external_reference: row.external_reference,
    notes: row.notes,
    balance_after_payment: null,
    request_id: row.request_id,
    created_at: row.created_at
  };
}

function buildPrecommissionReceiptSnapshot({
  receiptNumber,
  receiptDate,
  issuedAt,
  payment,
  obligation,
  quotation
}) {
  const snapshot = quotation.quotation_snapshot;
  return {
    schema_version: 2,
    receipt: {
      number: receiptNumber,
      version: 1,
      receipt_date: receiptDate,
      issued_at: issuedAt
    },
    client: {
      client_id: String(quotation.client_id),
      name: snapshot.client?.full_name || snapshot.client?.name,
      email: snapshot.client?.email || null,
      phone: snapshot.client?.phone || null
    },
    quotation: {
      quotation_id: String(quotation.id),
      number: quotation.quotation_number,
      version: Number(quotation.version)
    },
    artwork: {
      title: snapshot.artwork?.title,
      description: snapshot.artwork?.description || null,
      medium: snapshot.artwork?.medium || null,
      dimensions: snapshot.artwork?.dimensions || null
    },
    payment: {
      id: String(payment.id),
      type: "deposit",
      amount: String(payment.amount),
      sales_tax: "0.00",
      method: payment.payment_method,
      payment_date: payment.payment_date,
      external_reference: payment.external_reference,
      notes: payment.notes,
      balance_after_payment: null
    },
    deposit: {
      required_deposit: String(obligation.amount),
      amount_applied: String(payment.amount),
      remaining_after_payment: "0.00"
    },
    reference: {
      type: "quotation",
      number: quotation.quotation_number
    },
    studio: {
      name: businessInformation.name,
      email: businessInformation.email,
      phone: businessInformation.phone,
      website: businessInformation.website
    }
  };
}

async function getPrecommissionPaymentResult(queryable, paymentId) {
  const result = await queryable.query(
    `SELECT
       p.*,
       a.id AS allocation_id,
       a.amount AS allocation_amount,
       o.obligation_status,
       o.satisfied_at,
       d.id AS receipt_id,
       d.document_number AS receipt_number,
       d.file_location AS receipt_file_location,
       c.id AS communication_id,
       c.communication_status,
       commission.commission_number,
       lifecycle.lifecycle_status,
       lifecycle.activated_at,
       lifecycle.activation_source
     FROM payments AS p
     JOIN payment_allocations AS a
       ON a.payment_id = p.id
      AND a.obligation_id = p.precommission_obligation_id
     JOIN commission_obligations AS o ON o.id = p.precommission_obligation_id
     JOIN documents AS d
       ON d.payment_id = p.id
      AND d.document_type = 'receipt'
     LEFT JOIN communications AS c
       ON c.automation_source_key = 'receipt:' || d.id::TEXT
     LEFT JOIN commissions AS commission ON commission.id = p.commission_id
     LEFT JOIN commission_lifecycle AS lifecycle ON lifecycle.commission_id = commission.id
     WHERE p.id = $1
       AND p.precommission_obligation_id IS NOT NULL`,
    [paymentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    payment: normalizePrecommissionPaymentRow(row),
    allocation: {
      id: String(row.allocation_id),
      payment_id: String(row.id),
      obligation_id: String(row.precommission_obligation_id),
      amount: String(row.allocation_amount)
    },
    obligation: {
      id: String(row.precommission_obligation_id),
      commission_id: row.commission_id === null ? null : String(row.commission_id),
      obligation_status: row.obligation_status,
      satisfied_at: row.satisfied_at,
      remaining: "0.00"
    },
    receipt: {
      id: String(row.receipt_id),
      commission_id: row.commission_id === null ? null : String(row.commission_id),
      document_type: "receipt",
      document_number: row.receipt_number,
      file_location: row.receipt_file_location
    },
    communication_id: row.communication_id ? String(row.communication_id) : null,
    communication_status: row.communication_status || null,
    commission: row.commission_id === null ? null : {
      id: String(row.commission_id),
      commission_number: row.commission_number,
      lifecycle_status: row.lifecycle_status,
      activated_at: row.activated_at,
      activation_source: row.activation_source
    }
  };
}

async function getExistingByRequestId(queryable, requestId) {
  return (await queryable.query(
    `SELECT id, commission_id, precommission_obligation_id
     FROM payments
     WHERE request_id = $1`,
    [requestId]
  )).rows[0] || null;
}

async function getExistingByObligation(queryable, obligationId) {
  return (await queryable.query(
    `SELECT id
     FROM payments
     WHERE payment_type = 'deposit'
       AND status = 'completed'
       AND precommission_obligation_id = $1`,
    [obligationId]
  )).rows[0] || null;
}

async function recordPrecommissionDepositPayment(db, data, {
  now = () => new Date(),
  afterPaymentCreated = null,
  onRequiredDepositSatisfied = activateCommissionFromRequiredDeposit
} = {}) {
  const connection = await db.pool.connect();
  let stage = "begin";
  try {
    await connection.query("BEGIN");

    stage = "request_id_lookup";
    let existing = await getExistingByRequestId(connection, data.request_id);
    if (existing) {
      if (String(existing.precommission_obligation_id) !== String(data.obligation_id)) {
        await connection.query("ROLLBACK");
        return { outcome: "request_id_conflict" };
      }
      const canonical = await getPrecommissionPaymentResult(connection, existing.id);
      await connection.query("COMMIT");
      return { outcome: "success", created: false, ...canonical };
    }

    stage = "obligation_lock";
    await connection.query(
      "SELECT pg_advisory_xact_lock($1::BIGINT)",
      [String(data.obligation_id)]
    );
    const obligation = (await connection.query(
      "SELECT * FROM commission_obligations WHERE id = $1 FOR UPDATE",
      [data.obligation_id]
    )).rows[0];
    if (!obligation || obligation.obligation_type !== "deposit") {
      await connection.query("ROLLBACK");
      return { outcome: "obligation_not_found" };
    }

    if (obligation.commission_id !== null) {
      const canonicalPayment = await getExistingByObligation(connection, obligation.id);
      if (canonicalPayment) {
        const canonical = await getPrecommissionPaymentResult(connection, canonicalPayment.id);
        await connection.query("COMMIT");
        return { outcome: "success", created: false, ...canonical };
      }
      await connection.query("ROLLBACK");
      return { outcome: "obligation_not_open" };
    }

    existing = await getExistingByRequestId(connection, data.request_id);
    if (existing) {
      if (String(existing.precommission_obligation_id) !== String(data.obligation_id)) {
        await connection.query("ROLLBACK");
        return { outcome: "request_id_conflict" };
      }
      const canonical = await getPrecommissionPaymentResult(connection, existing.id);
      await connection.query("COMMIT");
      return { outcome: "success", created: false, ...canonical };
    }

    if (obligation.obligation_status !== "open") {
      const canonicalPayment = await getExistingByObligation(connection, obligation.id);
      if (canonicalPayment) {
        const canonical = await getPrecommissionPaymentResult(connection, canonicalPayment.id);
        await connection.query("COMMIT");
        return { outcome: "success", created: false, ...canonical };
      }
      await connection.query("ROLLBACK");
      return { outcome: "obligation_not_open" };
    }

    stage = "source_validation";
    const source = await resolveRequiredDepositSource(
      connection,
      obligation.contract_acceptance_id,
      { lock: true }
    );
    if (source.outcome !== "eligible") {
      await connection.query("ROLLBACK");
      return { outcome: source.outcome };
    }
    if (
      String(obligation.client_id) !== String(source.acceptance.client_id)
      || String(obligation.quotation_id) !== String(source.quotation.id)
      || String(obligation.contract_document_id) !== String(source.document.id)
      || String(obligation.amount) !== String(source.amount)
    ) {
      await connection.query("ROLLBACK");
      return { outcome: "obligation_context_mismatch" };
    }

    const occurredAt = now();
    if (occurredAt.getTime() > new Date(source.quotation.expires_at).getTime()) {
      await connection.query("ROLLBACK");
      return { outcome: "quotation_expired_for_deposit" };
    }
    const requiredAmount = centsToMoney(moneyToCents(source.amount, "Required deposit"));
    if (
      data.amount !== null
      && moneyToCents(data.amount, "Amount") !== moneyToCents(requiredAmount, "Required deposit")
    ) {
      await connection.query("ROLLBACK");
      return { outcome: "amount_mismatch", required_amount: requiredAmount };
    }

    const paymentDate = data.payment_date || getCalendarDateInTimeZone(occurredAt);
    const receiptYear = Number(getCalendarDateInTimeZone(occurredAt).slice(0, 4));
    const snapshotTemplate = buildPrecommissionReceiptSnapshot({
      receiptNumber: documentNumberToken,
      receiptDate: paymentDate,
      issuedAt: occurredAt.toISOString(),
      payment: {
        id: null,
        amount: requiredAmount,
        payment_method: data.payment_method,
        payment_date: paymentDate,
        external_reference: data.external_reference,
        notes: data.notes
      },
      obligation,
      quotation: source.quotation
    });
    const communicationTemplate = getCommunicationTemplate("receipt");
    const renderedCommunication = renderCommunicationTemplate(communicationTemplate, {
      client_name: snapshotTemplate.client.name,
      commercial_reference: source.quotation.quotation_number,
      document_number: documentNumberToken
    });
    if (!communicationTemplate || renderedCommunication.error || !snapshotTemplate.client.email) {
      throw new Error("Pre-Commission Receipt communication context is incomplete.");
    }

    stage = "canonical_payment_graph_write";
    const graph = (await connection.query(
      `WITH number_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock($13::INTEGER, $12::INTEGER)
       ),
       next_document_number AS MATERIALIZED (
         SELECT 'SAS-REC-' || $12::TEXT || '-' || lpad(
           (COALESCE(MAX(split_part(document.document_number, '-', 4)::INTEGER), 0) + 1)::TEXT,
           4,
           '0'
         ) AS document_number
         FROM documents AS document
         CROSS JOIN number_lock
         WHERE document.document_type = 'receipt'
           AND document.document_number LIKE 'SAS-REC-' || $12::TEXT || '-%'
       ),
       next_document_identity AS MATERIALIZED (
         SELECT nextval(pg_get_serial_sequence('documents', 'id'))::BIGINT AS id
       ),
       inserted_payment AS (
         INSERT INTO payments (
           commission_id, client_id, quotation_id, precommission_obligation_id,
           request_id, payment_type, amount, sales_tax, payment_method,
           payment_date, status, external_reference, notes, balance_after_payment,
           created_at
         ) VALUES (
           NULL, $1, $2, $3, $4, 'deposit', $5, 0, $6,
           $7, 'completed', $8, $9, NULL, $10
         )
         ON CONFLICT (precommission_obligation_id)
           WHERE precommission_obligation_id IS NOT NULL
             AND payment_type = 'deposit'
             AND status = 'completed'
         DO NOTHING
         RETURNING *
       ),
       inserted_allocation AS (
         INSERT INTO payment_allocations (payment_id, obligation_id, amount, created_at)
         SELECT id, $3, amount, $10 FROM inserted_payment
         RETURNING *
       ),
       satisfied_obligation AS (
         UPDATE commission_obligations AS obligation
         SET obligation_status = 'satisfied', satisfied_at = $10, updated_at = $10
         FROM inserted_allocation AS allocation
         WHERE obligation.id = allocation.obligation_id
           AND obligation.obligation_status = 'open'
         RETURNING obligation.*
       ),
       inserted_document AS (
         INSERT INTO documents (
           id, commission_id, client_id, quotation_id, payment_id,
           document_type, document_number, version, file_location,
           receipt_snapshot, created_at
         ) OVERRIDING SYSTEM VALUE
         SELECT
           identity.id,
           NULL,
           $1,
           $2,
           payment.id,
           'receipt',
           number.document_number,
           1,
           '/admin/payment-receipt.html?receipt=' || identity.id::TEXT,
           jsonb_set(
             jsonb_set(
               $11::JSONB,
               '{receipt,number}',
               to_jsonb(number.document_number),
               false
             ),
             '{payment,id}',
             to_jsonb(payment.id::TEXT),
             false
           ),
           $10
         FROM inserted_payment AS payment
         JOIN inserted_allocation AS allocation ON allocation.payment_id = payment.id
         JOIN satisfied_obligation AS obligation ON obligation.id = allocation.obligation_id
         CROSS JOIN next_document_number AS number
         CROSS JOIN next_document_identity AS identity
         RETURNING *
       ),
       inserted_communication AS (
         INSERT INTO communications (
           client_id, commission_id, quotation_id, document_id,
           channel, communication_type, communication_status,
           recipient, subject, body_snapshot, ready_at,
           template_key, template_version,
           automation_key, automation_mode, automation_source_key
         )
         SELECT
           $1,
           NULL,
           $2,
           document.id,
           'email',
           $14,
           'ready',
           $15,
           replace($16, $21, document.document_number),
           replace($17, $21, document.document_number),
           $10,
           $18,
           $19,
           $20,
           'auto_send',
           'receipt:' || document.id::TEXT
         FROM inserted_document AS document
         ON CONFLICT (automation_source_key)
           WHERE automation_source_key IS NOT NULL
         DO NOTHING
         RETURNING *
       )
       SELECT
         row_to_json(payment) AS payment,
         row_to_json(allocation) AS allocation,
         row_to_json(obligation) AS obligation,
         row_to_json(document) AS receipt,
         row_to_json(communication) AS communication
       FROM inserted_payment AS payment
       JOIN inserted_allocation AS allocation ON allocation.payment_id = payment.id
       JOIN satisfied_obligation AS obligation ON obligation.id = allocation.obligation_id
       JOIN inserted_document AS document ON document.payment_id = payment.id
       JOIN inserted_communication AS communication ON communication.document_id = document.id`,
      [
        obligation.client_id,
        obligation.quotation_id,
        obligation.id,
        data.request_id,
        requiredAmount,
        data.payment_method,
        paymentDate,
        data.external_reference,
        data.notes,
        occurredAt,
        JSON.stringify(snapshotTemplate),
        receiptYear,
        receiptNumberLockNamespace,
        communicationTemplate.communication_type,
        snapshotTemplate.client.email,
        renderedCommunication.subject,
        renderedCommunication.body,
        communicationTemplate.key,
        communicationTemplate.version,
        "receipt_delivery",
        documentNumberToken
      ]
    )).rows[0];

    if (!graph) {
      const canonicalPayment = await getExistingByObligation(connection, obligation.id);
      if (canonicalPayment) {
        const canonical = await getPrecommissionPaymentResult(connection, canonicalPayment.id);
        await connection.query("COMMIT");
        return { outcome: "success", created: false, ...canonical };
      }
      throw new Error("Canonical required deposit payment was not persisted.");
    }

    const payment = graph.payment;
    const allocation = graph.allocation;
    const satisfied = graph.obligation;
    const receipt = graph.receipt;
    const communication = graph.communication;

    if (afterPaymentCreated) await afterPaymentCreated({ connection, payment, obligation, source });
    if (!satisfied) throw new Error("Required deposit obligation could not be satisfied atomically.");

    stage = "activation_handoff";
    const handoff = await onRequiredDepositSatisfied({
      connection,
      payment,
      allocation,
      obligation: satisfied,
      receipt,
      communication,
      source,
      occurredAt
    });

    stage = "commit";
    await connection.query("COMMIT");
    const canonical = await getPrecommissionPaymentResult(db.pool, payment.id);
    return { outcome: "success", created: true, ...canonical, activation_handoff: handoff };
  } catch (error) {
    error.precommission_stage = stage;
    await connection.query("ROLLBACK");
    if (error?.code === "23505") {
      const existing = await getExistingByObligation(db.pool, data.obligation_id);
      if (existing) {
        const canonical = await getPrecommissionPaymentResult(db.pool, existing.id);
        return { outcome: "success", created: false, ...canonical };
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function deliverPrecommissionReceiptCommunication(
  db,
  communicationId,
  emailProvider,
  now = () => new Date()
) {
  return attemptAutomaticCommunicationSend(db, communicationId, emailProvider, now);
}

export {
  buildPrecommissionReceiptSnapshot,
  deliverPrecommissionReceiptCommunication,
  getCalendarDateInTimeZone,
  getPrecommissionPaymentResult,
  normalizePrecommissionPaymentRow,
  recordPrecommissionDepositPayment,
  receiptNumberLockNamespace
};
