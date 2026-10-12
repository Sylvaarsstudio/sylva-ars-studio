import { appendCommissionEvent } from "./commission-events.mjs";
import { initializeCommissionProduction } from "./commission-production.mjs";
import { centsToMoney, moneyToCents } from "./commission-obligations.mjs";
import { resolveRequiredDepositSource } from "./precommission-deposit.mjs";

class CommissionActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommissionActivationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommissionActivationError(code, message);
}

function getYearInNewYork(date) {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric"
  }).format(date));
}

function normalizeActivatedCommission(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    commission_number: row.commission_number,
    client_id: String(row.client_id),
    source_quotation_id: String(row.source_quotation_id),
    status: row.status,
    lifecycle_status: row.lifecycle_status,
    activated_at: row.activated_at,
    activation_source: row.activation_source
  };
}

async function readExistingActivation(connection, quotationId, obligationId) {
  const result = await connection.query(
    `SELECT
       commission.id,
       commission.commission_number,
       commission.client_id,
       commission.source_quotation_id,
       commission.status,
       lifecycle.lifecycle_status,
       lifecycle.activated_at,
       lifecycle.activation_source,
       production.production_status,
       contract.commission_id AS contract_commission_id,
       obligation.commission_id AS obligation_commission_id,
       payment.commission_id AS payment_commission_id,
       receipt.commission_id AS receipt_commission_id,
       event.id AS activation_event_id
     FROM commissions AS commission
     LEFT JOIN commission_lifecycle AS lifecycle
       ON lifecycle.commission_id = commission.id
     LEFT JOIN commission_production AS production
       ON production.commission_id = commission.id
     LEFT JOIN commission_obligations AS obligation
       ON obligation.id = $2
     LEFT JOIN documents AS contract
       ON contract.id = obligation.contract_document_id
     LEFT JOIN payments AS payment
       ON payment.precommission_obligation_id = obligation.id
      AND payment.payment_type = 'deposit'
      AND payment.status = 'completed'
     LEFT JOIN documents AS receipt
       ON receipt.payment_id = payment.id
      AND receipt.document_type = 'receipt'
     LEFT JOIN commission_events AS event
       ON event.commission_id = commission.id
      AND event.event_type = 'commission_activated'
      AND event.source_type = 'obligation'
      AND event.source_id = obligation.id::TEXT
     WHERE commission.source_quotation_id = $1`,
    [quotationId, obligationId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const commissionId = String(row.id);
  if (
    row.lifecycle_status !== "active"
    || row.activation_source !== "required_deposit"
    || row.production_status !== "not_started"
    || String(row.contract_commission_id) !== commissionId
    || String(row.obligation_commission_id) !== commissionId
    || String(row.payment_commission_id) !== commissionId
    || String(row.receipt_commission_id) !== commissionId
    || !row.activation_event_id
  ) {
    fail(
      "source_quotation_conflict",
      "The source Quotation already belongs to a non-canonical or incomplete Commission activation."
    );
  }
  return normalizeActivatedCommission(row);
}

async function readCanonicalDepositGraph(connection, obligationId) {
  const result = await connection.query(
    `SELECT
       obligation.id AS obligation_id,
       obligation.commission_id AS obligation_commission_id,
       obligation.client_id AS obligation_client_id,
       obligation.quotation_id AS obligation_quotation_id,
       obligation.contract_document_id,
       obligation.contract_acceptance_id,
       obligation.obligation_status,
       obligation.amount AS obligation_amount,
       obligation.satisfied_at,
       payment.id AS payment_id,
       payment.commission_id AS payment_commission_id,
       payment.client_id AS payment_client_id,
       payment.quotation_id AS payment_quotation_id,
       payment.payment_type,
       payment.amount AS payment_amount,
       payment.status AS payment_status,
       payment.request_id AS payment_request_id,
       payment.created_at AS payment_created_at,
       allocation.id AS allocation_id,
       allocation.amount AS allocation_amount,
       receipt.id AS receipt_id,
       receipt.commission_id AS receipt_commission_id,
       receipt.client_id AS receipt_client_id,
       receipt.quotation_id AS receipt_quotation_id,
       receipt.receipt_snapshot,
       communication.id AS communication_id,
       communication.commission_id AS communication_commission_id
     FROM commission_obligations AS obligation
     JOIN payments AS payment
       ON payment.precommission_obligation_id = obligation.id
      AND payment.payment_type = 'deposit'
      AND payment.status = 'completed'
     JOIN payment_allocations AS allocation
       ON allocation.payment_id = payment.id
      AND allocation.obligation_id = obligation.id
     JOIN documents AS receipt
       ON receipt.payment_id = payment.id
      AND receipt.document_type = 'receipt'
     JOIN communications AS communication
       ON communication.document_id = receipt.id
      AND communication.automation_key = 'receipt_delivery'
     WHERE obligation.id = $1
     FOR UPDATE OF obligation, payment, allocation, receipt, communication`,
    [obligationId]
  );
  if (result.rows.length !== 1) {
    fail("invalid_deposit_graph", "The canonical Deposit Payment graph is incomplete or ambiguous.");
  }
  return result.rows[0];
}

function validateCanonicalDepositGraph(graph, source, occurredAt) {
  const amount = centsToMoney(moneyToCents(source.amount, "Required deposit"));
  const sameContext = [
    [graph.obligation_client_id, source.acceptance.client_id],
    [graph.obligation_quotation_id, source.quotation.id],
    [graph.contract_document_id, source.document.id],
    [graph.contract_acceptance_id, source.acceptance.id],
    [graph.payment_client_id, source.acceptance.client_id],
    [graph.payment_quotation_id, source.quotation.id],
    [graph.receipt_client_id, source.acceptance.client_id],
    [graph.receipt_quotation_id, source.quotation.id]
  ].every(([actual, expected]) => String(actual) === String(expected));
  const allocationCountIsExact = String(graph.allocation_amount) === amount
    && String(graph.payment_amount) === amount
    && String(graph.obligation_amount) === amount;
  const snapshotMatches = graph.receipt_snapshot?.payment?.id === String(graph.payment_id)
    && graph.receipt_snapshot?.quotation?.quotation_id === String(source.quotation.id)
    && graph.receipt_snapshot?.deposit?.required_deposit === amount
    && graph.receipt_snapshot?.deposit?.amount_applied === amount;
  const paymentAcceptedAt = new Date(graph.payment_created_at);
  const expiresAt = new Date(source.quotation.expires_at);

  if (
    graph.obligation_commission_id !== null
    || graph.payment_commission_id !== null
    || graph.receipt_commission_id !== null
    || graph.communication_commission_id !== null
    || graph.obligation_status !== "satisfied"
    || !graph.satisfied_at
    || graph.payment_type !== "deposit"
    || graph.payment_status !== "completed"
    || !sameContext
    || !allocationCountIsExact
    || !snapshotMatches
    || Number.isNaN(paymentAcceptedAt.getTime())
    || Number.isNaN(expiresAt.getTime())
    || paymentAcceptedAt.getTime() > expiresAt.getTime()
    || occurredAt.getTime() < paymentAcceptedAt.getTime()
  ) {
    fail("invalid_deposit_graph", "The required Deposit Payment does not satisfy activation preconditions.");
  }
}

function readCommissionSnapshot(source) {
  const snapshot = source.quotation.quotation_snapshot;
  const artwork = snapshot?.artwork;
  const commercial = snapshot?.commercial;
  const required = [
    artwork?.title,
    artwork?.description,
    artwork?.medium,
    commercial?.price,
    commercial?.sales_tax,
    commercial?.shipping_charge,
    commercial?.required_deposit
  ];
  if (Number(snapshot?.snapshot_version) !== 2 || required.some((value) => value === undefined || value === null || value === "")) {
    fail("invalid_accepted_snapshot", "The immutable Accepted Quotation snapshot is incomplete.");
  }
  return { artwork, commercial };
}

async function promoteCanonicalRows(connection, commissionId, graph) {
  const updates = [
    ["documents", graph.contract_document_id, "document_type = 'contract'"],
    ["commission_obligations", graph.obligation_id, "obligation_type = 'deposit'"],
    ["payments", graph.payment_id, "precommission_obligation_id IS NOT NULL"],
    ["documents", graph.receipt_id, "document_type = 'receipt'"]
  ];
  for (const [table, id, guard] of updates) {
    const updated = await connection.query(
      `UPDATE ${table}
       SET commission_id = $1
       WHERE id = $2
         AND commission_id IS NULL
         AND ${guard}
       RETURNING id`,
      [commissionId, id]
    );
    if (updated.rowCount !== 1) {
      fail("relational_promotion_conflict", `Canonical ${table} relationship could not be promoted.`);
    }
  }
}

async function activateCommissionFromRequiredDeposit({
  connection,
  payment,
  allocation,
  obligation,
  receipt,
  communication,
  source,
  occurredAt
}, { afterStage = null } = {}) {
  const quotationId = source?.quotation?.id;
  if (!quotationId || !obligation?.id) {
    fail("invalid_activation_context", "Commission activation context is incomplete.");
  }
  await connection.query(
    "SELECT pg_advisory_xact_lock(hashtext('commission-activation'), hashtext($1::text))",
    [quotationId]
  );

  const existing = await readExistingActivation(connection, quotationId, obligation.id);
  if (existing) return { created: false, commission: existing };

  const canonicalSource = await resolveRequiredDepositSource(
    connection,
    obligation.contract_acceptance_id,
    { lock: true }
  );
  if (canonicalSource.outcome !== "eligible") {
    fail(canonicalSource.outcome, "Canonical Contract and Acceptance context is no longer activation-eligible.");
  }
  if (
    String(canonicalSource.quotation.id) !== String(source.quotation.id)
    || String(canonicalSource.document.id) !== String(source.document.id)
    || String(canonicalSource.acceptance.id) !== String(source.acceptance.id)
  ) {
    fail("activation_context_mismatch", "Activation source context changed during the transaction.");
  }

  const graph = await readCanonicalDepositGraph(connection, obligation.id);
  if (
    String(graph.payment_id) !== String(payment.id)
    || String(graph.allocation_id) !== String(allocation.id)
    || String(graph.receipt_id) !== String(receipt.id)
    || String(graph.communication_id) !== String(communication.id)
  ) {
    fail("activation_context_mismatch", "Activation graph does not match the canonical B3 result.");
  }
  validateCanonicalDepositGraph(graph, canonicalSource, occurredAt);
  const { artwork, commercial } = readCommissionSnapshot(canonicalSource);
  const paidDeposit = centsToMoney(moneyToCents(graph.payment_amount, "Deposit payment"));
  const year = getYearInNewYork(occurredAt);
  const sequence = await connection.query(
    "SELECT nextval('commission_number_sequence') AS next_number"
  );
  const commissionNumber = `SAS-COM-${year}-${String(sequence.rows[0].next_number).padStart(4, "0")}`;
  const inserted = (await connection.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, width, height,
       price, deposit_amount, amount_paid, sales_tax, shipping, status,
       estimated_completion, source_quotation_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $9, $10, $11, 'draft', $12, $13
     )
     ON CONFLICT (source_quotation_id) WHERE source_quotation_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      commissionNumber,
      canonicalSource.quotation.client_id,
      artwork.title,
      artwork.description,
      artwork.medium,
      artwork.dimensions?.width ?? null,
      artwork.dimensions?.height ?? null,
      commercial.price,
      paidDeposit,
      commercial.sales_tax,
      commercial.shipping_charge,
      commercial.estimated_completion ?? null,
      canonicalSource.quotation.id
    ]
  )).rows[0];
  if (!inserted) {
    const recovered = await readExistingActivation(connection, quotationId, obligation.id);
    if (recovered) return { created: false, commission: recovered };
    fail("source_quotation_conflict", "The Accepted Quotation already belongs to another Commission.");
  }
  if (afterStage) await afterStage("commission_inserted", { commission: inserted });

  await promoteCanonicalRows(connection, inserted.id, graph);
  if (afterStage) await afterStage("relationships_promoted", { commission: inserted });

  if (canonicalSource.quotation.inquiry_id) {
    await connection.query(
      `INSERT INTO commission_inquiries (commission_id, inquiry_id, relationship_type)
       VALUES ($1, $2, 'origin')
       ON CONFLICT (commission_id, inquiry_id) DO NOTHING`,
      [inserted.id, canonicalSource.quotation.inquiry_id]
    );
    await appendCommissionEvent(connection, {
      commissionId: inserted.id,
      eventType: "inquiry_linked",
      occurredAt,
      actorType: "system",
      sourceType: "inquiry",
      sourceId: canonicalSource.quotation.inquiry_id,
      payload: { relationship_type: "origin" },
      requestId: graph.payment_request_id
    });
  }

  const production = await initializeCommissionProduction(connection, inserted.id, occurredAt);
  if (!production.production || production.production.production_status !== "not_started") {
    fail("production_initialization_failed", "Commission Production could not be initialized safely.");
  }
  if (afterStage) await afterStage("production_initialized", { commission: inserted });

  const lifecycle = (await connection.query(
    `INSERT INTO commission_lifecycle (
       commission_id, lifecycle_status, activated_at, activation_source,
       created_at, updated_at
     ) VALUES ($1, 'active', $2, 'required_deposit', $2, $2)
     ON CONFLICT (commission_id) DO NOTHING
     RETURNING *`,
    [inserted.id, occurredAt]
  )).rows[0];
  if (!lifecycle) {
    fail("lifecycle_initialization_failed", "Canonical Commission lifecycle could not be initialized.");
  }

  const activationEvent = await appendCommissionEvent(connection, {
    commissionId: inserted.id,
    eventType: "commission_activated",
    occurredAt,
    actorType: "system",
    sourceType: "obligation",
    sourceId: graph.obligation_id,
    payload: {
      quotation_id: String(canonicalSource.quotation.id),
      quotation_acceptance_id: String(canonicalSource.quotation.source_acceptance_id),
      contract_document_id: String(canonicalSource.document.id),
      contract_acceptance_id: String(canonicalSource.acceptance.id),
      deposit_obligation_id: String(graph.obligation_id),
      activating_payment_id: String(graph.payment_id)
    },
    requestId: graph.payment_request_id
  });
  if (!activationEvent) {
    fail("activation_event_failed", "Canonical Commission activation event could not be recorded.");
  }
  if (afterStage) await afterStage("activation_event_created", { commission: inserted });

  return {
    created: true,
    commission: normalizeActivatedCommission({ ...inserted, ...lifecycle })
  };
}

export {
  CommissionActivationError,
  activateCommissionFromRequiredDeposit,
  getYearInNewYork,
  normalizeActivatedCommission
};
