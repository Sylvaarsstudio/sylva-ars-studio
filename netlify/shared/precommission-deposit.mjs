import { resolveContractAcceptanceSource } from "./contract-acceptance.mjs";
import { centsToMoney, moneyToCents } from "./commission-obligations.mjs";
import { hashQuotationSnapshot } from "./quotation-snapshot.mjs";

const requiredDepositPolicy = Object.freeze({
  allow_partial: false,
  full_payment_only: true,
  deadline_source: "quotation.expires_at"
});

function deriveDepositPaymentEligibility(expiresAt, now = new Date()) {
  const expiry = new Date(expiresAt);
  const current = new Date(now);
  return {
    ...requiredDepositPolicy,
    quotation_expires_at: Number.isNaN(expiry.getTime()) ? null : expiry,
    deposit_payment_eligible: !Number.isNaN(expiry.getTime())
      && !Number.isNaN(current.getTime())
      && current.getTime() <= expiry.getTime()
  };
}

function normalizeRequiredDepositObligation(row, expiresAt, now = new Date()) {
  return {
    id: String(row.id),
    commission_id: row.commission_id === null ? null : String(row.commission_id),
    client_id: String(row.client_id),
    quotation_id: String(row.quotation_id),
    contract_document_id: String(row.contract_document_id),
    contract_acceptance_id: String(row.contract_acceptance_id),
    obligation_type: row.obligation_type,
    obligation_status: row.obligation_status,
    amount: String(row.amount),
    allocated_amount: "0.00",
    outstanding_amount: String(row.amount),
    source_type: row.source_type,
    source_id: row.source_id,
    ...deriveDepositPaymentEligibility(expiresAt, now)
  };
}

async function resolveRequiredDepositSource(connection, acceptanceId, { lock = false } = {}) {
  const acceptance = (await connection.query(
    `SELECT *
     FROM acceptances
     WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [acceptanceId]
  )).rows[0];

  if (!acceptance || acceptance.acceptance_type !== "contract" || acceptance.accepted !== true) {
    return { outcome: "invalid_contract_acceptance" };
  }
  if (acceptance.commission_id !== null) {
    return { outcome: "not_precommission" };
  }

  const contractSource = await resolveContractAcceptanceSource(
    connection,
    acceptance.document_id,
    { lock }
  );
  if (contractSource.outcome !== "eligible") {
    return { outcome: contractSource.outcome };
  }

  const { document, snapshot_hash: contractSnapshotHash, terms_version: termsVersion } = contractSource;
  if (document.commission_id !== null) return { outcome: "not_precommission" };
  if (String(acceptance.document_id) !== String(document.id)) {
    return { outcome: "contract_document_mismatch" };
  }
  if (String(acceptance.client_id) !== String(document.client_id)) {
    return { outcome: "contract_client_mismatch" };
  }
  if (String(acceptance.quotation_id) !== String(document.quotation_id)) {
    return { outcome: "contract_quotation_mismatch" };
  }
  if (
    acceptance.subject_number !== document.document_number
    || Number(acceptance.subject_version) !== Number(document.version)
  ) {
    return { outcome: "contract_subject_mismatch" };
  }
  if (acceptance.snapshot_hash !== contractSnapshotHash) {
    return { outcome: "contract_snapshot_mismatch" };
  }
  if (acceptance.terms_version !== termsVersion) {
    return { outcome: "contract_terms_mismatch" };
  }

  const quotationAcceptanceId = document.document_snapshot?.quotation?.quotation_acceptance_id;
  const quotation = (await connection.query(
    `SELECT
       q.*,
       a.id AS source_acceptance_id,
       a.client_id AS source_acceptance_client_id,
       a.quotation_id AS source_acceptance_quotation_id,
       a.accepted AS source_acceptance_accepted,
       a.accepted_at AS source_acceptance_accepted_at,
       a.subject_number AS source_acceptance_subject_number,
       a.subject_version AS source_acceptance_subject_version,
       a.snapshot_hash AS source_acceptance_snapshot_hash
     FROM quotations AS q
     JOIN acceptances AS a ON a.id = $2
     WHERE q.id = $1${lock ? " FOR UPDATE OF q, a" : ""}`,
    [document.quotation_id, quotationAcceptanceId]
  )).rows[0];

  if (!quotation || quotation.quotation_status !== "accepted") {
    return { outcome: "invalid_quotation" };
  }
  if (
    !quotation.quotation_snapshot
    || !quotation.snapshot_hash
    || hashQuotationSnapshot(quotation.quotation_snapshot) !== quotation.snapshot_hash
    || document.document_snapshot?.quotation?.quotation_snapshot_hash !== quotation.snapshot_hash
  ) {
    return { outcome: "quotation_snapshot_mismatch" };
  }
  if (
    String(quotation.client_id) !== String(document.client_id)
    || String(quotation.source_acceptance_id) !== String(quotationAcceptanceId)
    || quotation.source_acceptance_accepted !== true
    || String(quotation.source_acceptance_client_id) !== String(document.client_id)
    || String(quotation.source_acceptance_quotation_id) !== String(quotation.id)
    || quotation.source_acceptance_subject_number !== quotation.quotation_number
    || Number(quotation.source_acceptance_subject_version) !== Number(quotation.version)
    || quotation.source_acceptance_snapshot_hash !== quotation.snapshot_hash
    || !quotation.source_acceptance_accepted_at
    || !quotation.expires_at
    || new Date(quotation.source_acceptance_accepted_at) > new Date(quotation.expires_at)
  ) {
    return { outcome: "quotation_acceptance_mismatch" };
  }

  let amount;
  try {
    amount = centsToMoney(moneyToCents(
      quotation.quotation_snapshot?.commercial?.required_deposit,
      "Required deposit"
    ));
  } catch {
    return { outcome: "invalid_required_deposit" };
  }
  if (moneyToCents(amount, "Required deposit") <= 0) {
    return { outcome: "invalid_required_deposit" };
  }

  return {
    outcome: "eligible",
    acceptance,
    document,
    quotation,
    amount
  };
}

async function ensureRequiredDepositObligationInTransaction(
  connection,
  contractAcceptanceId,
  { now = () => new Date() } = {}
) {
  await connection.query(
    "SELECT pg_advisory_xact_lock(hashtext('precommission-required-deposit'), hashtext($1::text))",
    [String(contractAcceptanceId)]
  );

  const source = await resolveRequiredDepositSource(connection, contractAcceptanceId, { lock: true });
  if (source.outcome !== "eligible") return source;

  const existing = (await connection.query(
    `SELECT * FROM commission_obligations
     WHERE obligation_type = 'deposit'
       AND contract_acceptance_id = $1
     FOR UPDATE`,
    [contractAcceptanceId]
  )).rows[0];
  const currentTime = now();
  if (existing) {
    return {
      outcome: "idempotent",
      obligation: normalizeRequiredDepositObligation(
        existing,
        source.quotation.expires_at,
        currentTime
      )
    };
  }

  const created = (await connection.query(
    `INSERT INTO commission_obligations (
       commission_id, client_id, quotation_id, contract_document_id,
       contract_acceptance_id, obligation_type, obligation_status, amount,
       due_at, source_type, source_id, description, request_id,
       created_at, updated_at
     ) VALUES (
       NULL, $1, $2, $3, $4, 'deposit', 'open', $5,
       NULL, 'contract_acceptance', $6, 'Required deposit', $7,
       $8, $8
     )
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      source.acceptance.client_id,
      source.acceptance.quotation_id,
      source.acceptance.document_id,
      source.acceptance.id,
      source.amount,
      String(source.acceptance.id),
      source.acceptance.request_id,
      currentTime
    ]
  )).rows[0];

  if (!created) {
    const concurrent = (await connection.query(
      `SELECT * FROM commission_obligations
       WHERE obligation_type = 'deposit'
         AND contract_acceptance_id = $1
       FOR UPDATE`,
      [contractAcceptanceId]
    )).rows[0];
    if (!concurrent) return { outcome: "request_conflict" };
    return {
      outcome: "idempotent",
      obligation: normalizeRequiredDepositObligation(
        concurrent,
        source.quotation.expires_at,
        currentTime
      )
    };
  }

  return {
    outcome: "success",
    obligation: normalizeRequiredDepositObligation(
      created,
      source.quotation.expires_at,
      currentTime
    )
  };
}

async function ensureRequiredDepositObligationForContractAcceptance(
  db,
  contractAcceptanceId,
  options = {}
) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await ensureRequiredDepositObligationInTransaction(
      connection,
      contractAcceptanceId,
      options
    );
    if (["success", "idempotent"].includes(result.outcome)) {
      await connection.query("COMMIT");
    } else {
      await connection.query("ROLLBACK");
    }
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export {
  deriveDepositPaymentEligibility,
  ensureRequiredDepositObligationForContractAcceptance,
  ensureRequiredDepositObligationInTransaction,
  normalizeRequiredDepositObligation,
  requiredDepositPolicy,
  resolveRequiredDepositSource
};
