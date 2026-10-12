import { hashQuotationSnapshot } from "./quotation-snapshot.mjs";
import { isQuotationExpired } from "./quotation-state.mjs";

async function resolveAcceptedQuotation(db, commissionId, now = new Date(), { lock = false } = {}) {
  const queryable = db.pool || db;
  const commissionResult = await queryable.query(
    "SELECT id, client_id, commission_number FROM commissions WHERE id = $1",
    [commissionId]
  );
  const commission = commissionResult.rows[0];
  if (!commission) return { outcome: "not_found" };

  const result = await queryable.query(
    `SELECT
       q.*,
       a.id AS acceptance_id,
       a.commission_id AS acceptance_commission_id,
       a.client_id AS acceptance_client_id,
       a.accepted_at AS acceptance_accepted_at,
       a.subject_number AS acceptance_subject_number,
       a.subject_version AS acceptance_subject_version,
       a.snapshot_hash AS acceptance_snapshot_hash
     FROM quotations q
     LEFT JOIN acceptances a
       ON a.quotation_id = q.id
      AND a.acceptance_type = 'quotation'
      AND a.accepted = TRUE
     WHERE q.commission_id = $1
       AND (q.quotation_status = 'accepted' OR a.id IS NOT NULL)
     ORDER BY q.id${lock ? " FOR UPDATE OF q" : ""}`,
    [commissionId]
  );
  if (!result.rows.length) return { outcome: "no_accepted_quotation", commission };
  if (result.rows.length !== 1) return { outcome: "ambiguous_accepted_quotation", commission };

  const quotation = result.rows[0];
  if (quotation.quotation_status !== "accepted") {
    return { outcome: "invalid_quotation_status", status: quotation.quotation_status, commission };
  }
  if (!quotation.acceptance_id) return { outcome: "missing_acceptance", commission };
  if (!quotation.expires_at || isQuotationExpired(quotation, now)) {
    return { outcome: "expired", commission };
  }
  if (!quotation.quotation_snapshot || !quotation.snapshot_hash) {
    return { outcome: "missing_snapshot", commission };
  }
  if (hashQuotationSnapshot(quotation.quotation_snapshot) !== quotation.snapshot_hash) {
    return { outcome: "quotation_hash_mismatch", commission };
  }
  if (quotation.acceptance_snapshot_hash !== quotation.snapshot_hash) {
    return { outcome: "acceptance_hash_mismatch", commission };
  }
  if (
    String(quotation.acceptance_commission_id) !== String(quotation.commission_id)
    || String(quotation.acceptance_client_id) !== String(commission.client_id)
    || quotation.acceptance_subject_number !== quotation.quotation_number
    || Number(quotation.acceptance_subject_version) !== Number(quotation.version)
  ) {
    return { outcome: "acceptance_relationship_mismatch", commission };
  }
  const snapshotClientId = quotation.quotation_snapshot?.client?.client_id;
  const snapshotCommissionId = quotation.quotation_snapshot?.commission?.commission_id;
  if (
    String(snapshotClientId) !== String(commission.client_id)
    || String(snapshotCommissionId) !== String(quotation.commission_id)
  ) {
    return { outcome: "snapshot_relationship_mismatch", commission };
  }

  const existingContract = (await queryable.query(
    `SELECT id, document_number, version, file_location
     FROM documents
     WHERE commission_id = $1
       AND document_type = 'contract'
       AND (
         quotation_id = $2
         OR quotation_id IS NULL
       )
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    [commissionId, quotation.id]
  )).rows[0] || null;
  if (existingContract) {
    return { outcome: "contract_conflict", commission, quotation, existingContract };
  }

  return {
    outcome: "eligible",
    commission,
    quotation,
    acceptance: {
      id: quotation.acceptance_id,
      accepted_at: quotation.acceptance_accepted_at,
      snapshot_hash: quotation.acceptance_snapshot_hash
    }
  };
}

function eligibilityMessage(outcome) {
  return {
    no_accepted_quotation: "Contract unavailable — Accepted Quotation required.",
    ambiguous_accepted_quotation: "Contract unavailable — multiple accepted quotations require review.",
    invalid_quotation_status: "Contract unavailable — the accepted quotation is no longer valid.",
    missing_acceptance: "Contract unavailable — the quotation has no valid Acceptance record.",
    expired: "Contract unavailable — the accepted quotation has expired.",
    missing_snapshot: "Contract unavailable — quotation snapshot evidence is missing.",
    quotation_hash_mismatch: "Contract unavailable — quotation snapshot integrity validation failed.",
    acceptance_hash_mismatch: "Contract unavailable — Acceptance hash does not match the quotation.",
    acceptance_relationship_mismatch: "Contract unavailable — Acceptance relationships are inconsistent.",
    snapshot_relationship_mismatch: "Contract unavailable — quotation snapshot relationships are inconsistent.",
    contract_conflict: "Contract unavailable — a Contract already exists for this source quotation."
  }[outcome] || "Contract unavailable — eligibility could not be verified.";
}

export { eligibilityMessage, resolveAcceptedQuotation };
