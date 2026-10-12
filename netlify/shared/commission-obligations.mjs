const obligationTypes = Object.freeze([
  "deposit",
  "final_balance",
  "modification_charge",
  "storage_fee",
  "shipping_adjustment",
  "protection_charge",
  "other"
]);

const obligationStatuses = Object.freeze(["open", "satisfied", "waived", "voided"]);
const inactiveObligationStatuses = new Set(["waived", "voided"]);

function moneyToCents(value, label = "Amount") {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new TypeError(`${label} must be a valid non-negative monetary amount.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`${label} is outside the supported range.`);
  }
  return cents;
}

function centsToMoney(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError("Monetary cents must be a non-negative safe integer.");
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function deriveObligationFinancials(amount, allocatedAmount, obligationStatus = "open") {
  const amountCents = moneyToCents(amount, "Obligation amount");
  const allocatedCents = moneyToCents(allocatedAmount, "Allocated amount");
  if (allocatedCents > amountCents) {
    throw new RangeError("Allocated amount cannot exceed the obligation amount.");
  }

  if (inactiveObligationStatuses.has(obligationStatus)) {
    return {
      allocated_amount: centsToMoney(allocatedCents),
      outstanding_amount: "0.00",
      financial_condition: obligationStatus
    };
  }

  const outstandingCents = amountCents - allocatedCents;
  return {
    allocated_amount: centsToMoney(allocatedCents),
    outstanding_amount: centsToMoney(outstandingCents),
    financial_condition: outstandingCents === 0
      ? "satisfied"
      : allocatedCents === 0
        ? "unpaid"
        : "partially_satisfied"
  };
}

function normalizeObligationRow(row) {
  const derived = deriveObligationFinancials(
    row.amount,
    row.allocated_amount ?? "0.00",
    row.obligation_status
  );
  return {
    id: String(row.id),
    obligation_type: row.obligation_type,
    obligation_status: row.obligation_status,
    amount: String(row.amount),
    ...derived,
    due_at: row.due_at,
    source_type: row.source_type,
    source_id: row.source_id
  };
}

function sameObligationIntent(existing, requested) {
  const existingDueAt = existing.due_at ? new Date(existing.due_at).getTime() : null;
  const requestedDueAt = requested.dueAt ? new Date(requested.dueAt).getTime() : null;
  return String(existing.commission_id) === String(requested.commissionId)
    && existing.obligation_type === requested.obligationType
    && moneyToCents(existing.amount) === moneyToCents(requested.amount)
    && existingDueAt === requestedDueAt
    && (existing.source_type ?? null) === (requested.sourceType ?? null)
    && (existing.source_id ?? null) === (
      requested.sourceId === undefined || requested.sourceId === null
        ? null
        : String(requested.sourceId)
    )
    && (existing.description ?? null) === (requested.description ?? null);
}

async function readCommissionObligations(db, commissionId) {
  const commission = await db.pool.query(
    "SELECT id FROM commissions WHERE id = $1",
    [commissionId]
  );
  if (!commission.rows[0]) return null;

  const result = await db.pool.query(
    `SELECT
       o.id, o.obligation_type, o.obligation_status, o.amount,
       o.due_at, o.source_type, o.source_id, o.created_at,
       COALESCE(SUM(a.amount), 0)::NUMERIC(12, 2) AS allocated_amount
     FROM commission_obligations AS o
     LEFT JOIN payment_allocations AS a ON a.obligation_id = o.id
     WHERE o.commission_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC, o.id DESC`,
    [commissionId]
  );

  return {
    initialized: result.rows.length > 0,
    obligations: result.rows.map(normalizeObligationRow)
  };
}

function validateAllocation({
  payment,
  obligation,
  paymentAllocated = "0.00",
  obligationAllocated = "0.00",
  amount
}) {
  if (!payment || !obligation) return { outcome: "not_found" };
  if (String(payment.commission_id) !== String(obligation.commission_id)) {
    return { outcome: "cross_commission" };
  }
  if (payment.status !== "completed") return { outcome: "payment_not_completed" };
  if (obligation.obligation_status !== "open") {
    return { outcome: "obligation_inactive" };
  }

  const allocationCents = moneyToCents(amount, "Allocation amount");
  if (allocationCents <= 0) return { outcome: "invalid_amount" };
  const paymentRemainingCents = moneyToCents(payment.amount, "Payment amount")
    - moneyToCents(paymentAllocated, "Payment allocated amount");
  const obligationRemainingCents = moneyToCents(obligation.amount, "Obligation amount")
    - moneyToCents(obligationAllocated, "Obligation allocated amount");

  if (allocationCents > paymentRemainingCents) {
    return { outcome: "payment_overallocated" };
  }
  if (allocationCents > obligationRemainingCents) {
    return { outcome: "obligation_overallocated" };
  }
  return {
    outcome: "valid",
    allocation_cents: allocationCents,
    payment_remaining_cents: paymentRemainingCents,
    obligation_remaining_cents: obligationRemainingCents
  };
}

async function createCommissionObligation(db, obligation, { now = () => new Date() } = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    if (obligation.requestId) {
      await connection.query(
        "SELECT pg_advisory_xact_lock(hashtext('commission-obligation'), hashtext($1::text))",
        [obligation.requestId]
      );
      const existing = (await connection.query(
        "SELECT * FROM commission_obligations WHERE request_id = $1",
        [obligation.requestId]
      )).rows[0];
      if (existing) {
        if (!sameObligationIntent(existing, obligation)) {
          await connection.query("ROLLBACK");
          return { outcome: "request_id_conflict" };
        }
        await connection.query("COMMIT");
        return { outcome: "idempotent", obligation: normalizeObligationRow({ ...existing, allocated_amount: "0.00" }) };
      }
    }

    const createdAt = now();
    const created = (await connection.query(
      `INSERT INTO commission_obligations (
         commission_id, obligation_type, obligation_status, amount, due_at,
         source_type, source_id, description, request_id, created_at, updated_at
       ) VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING *`,
      [
        obligation.commissionId,
        obligation.obligationType,
        obligation.amount,
        obligation.dueAt ?? null,
        obligation.sourceType ?? null,
        obligation.sourceId === undefined || obligation.sourceId === null
          ? null
          : String(obligation.sourceId),
        obligation.description ?? null,
        obligation.requestId ?? null,
        createdAt
      ]
    )).rows[0];
    await connection.query("COMMIT");
    return { outcome: "success", obligation: normalizeObligationRow({ ...created, allocated_amount: "0.00" }) };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function allocatePaymentToObligation(db, allocation, { now = () => new Date() } = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const payment = (await connection.query(
      "SELECT id, commission_id, amount, status FROM payments WHERE id = $1 FOR UPDATE",
      [allocation.paymentId]
    )).rows[0];
    const obligation = (await connection.query(
      "SELECT * FROM commission_obligations WHERE id = $1 FOR UPDATE",
      [allocation.obligationId]
    )).rows[0];
    const paymentAllocated = (await connection.query(
      "SELECT COALESCE(SUM(amount), 0)::NUMERIC(12, 2) AS amount FROM payment_allocations WHERE payment_id = $1",
      [allocation.paymentId]
    )).rows[0].amount;
    const obligationAllocated = (await connection.query(
      "SELECT COALESCE(SUM(amount), 0)::NUMERIC(12, 2) AS amount FROM payment_allocations WHERE obligation_id = $1",
      [allocation.obligationId]
    )).rows[0].amount;
    const validation = validateAllocation({
      payment,
      obligation,
      paymentAllocated,
      obligationAllocated,
      amount: allocation.amount
    });
    if (validation.outcome !== "valid") {
      await connection.query("ROLLBACK");
      return validation;
    }

    const occurredAt = now();
    const inserted = (await connection.query(
      `INSERT INTO payment_allocations (payment_id, obligation_id, amount, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, payment_id, obligation_id, amount, created_at`,
      [allocation.paymentId, allocation.obligationId, allocation.amount, occurredAt]
    )).rows[0];
    const satisfied = validation.allocation_cents === validation.obligation_remaining_cents;
    if (satisfied) {
      await connection.query(
        `UPDATE commission_obligations
         SET obligation_status = 'satisfied', satisfied_at = $2, updated_at = $2
         WHERE id = $1 AND obligation_status = 'open'`,
        [allocation.obligationId, occurredAt]
      );
    }
    await connection.query("COMMIT");
    return {
      outcome: "success",
      allocation: {
        ...inserted,
        id: String(inserted.id),
        payment_id: String(inserted.payment_id),
        obligation_id: String(inserted.obligation_id),
        amount: String(inserted.amount)
      },
      obligation_satisfied: satisfied
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export {
  allocatePaymentToObligation,
  createCommissionObligation,
  deriveObligationFinancials,
  normalizeObligationRow,
  obligationStatuses,
  obligationTypes,
  readCommissionObligations,
  sameObligationIntent,
  validateAllocation
};
