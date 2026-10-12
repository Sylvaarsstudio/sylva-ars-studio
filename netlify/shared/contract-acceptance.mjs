import { createHash } from "node:crypto";

import { canonicalSerialize } from "./quotation-snapshot.mjs";

function hashContractSnapshot(snapshot) {
  return createHash("sha256").update(canonicalSerialize(snapshot)).digest("hex");
}

async function resolveContractAcceptanceSource(db, documentId, { lock = false } = {}) {
  const queryable = db.pool || db;
  const document = (await queryable.query(
    `SELECT
       d.id, d.document_type, d.document_number, d.version,
       d.client_id, d.quotation_id, d.commission_id, d.document_snapshot,
       q.client_id AS quotation_client_id, q.snapshot_hash AS quotation_snapshot_hash
     FROM documents d
     LEFT JOIN quotations q ON q.id = d.quotation_id
     WHERE d.id = $1${lock ? " FOR UPDATE OF d" : ""}`,
    [documentId]
  )).rows[0];

  if (!document || document.document_type !== "contract") {
    return { outcome: "not_found" };
  }
  const snapshot = document.document_snapshot;
  if (!snapshot || snapshot.contract?.status !== "issued") {
    return { outcome: "not_issued" };
  }
  if (
    Number(snapshot.schema_version) !== 3
    || !document.client_id
    || !document.quotation_id
    || String(document.client_id) !== String(document.quotation_client_id)
    || String(snapshot.client?.client_id) !== String(document.client_id)
    || String(snapshot.quotation?.quotation_id) !== String(document.quotation_id)
    || snapshot.quotation?.quotation_snapshot_hash !== document.quotation_snapshot_hash
  ) {
    return { outcome: "relationship_mismatch" };
  }
  if (!snapshot.terms?.terms_version || snapshot.terms?.approved !== true) {
    return { outcome: "terms_not_approved" };
  }

  return {
    outcome: "eligible",
    document,
    snapshot_hash: hashContractSnapshot(snapshot),
    terms_version: snapshot.terms.terms_version
  };
}

export { hashContractSnapshot, resolveContractAcceptanceSource };
