import { appendCommissionEvent } from "./commission-events.mjs";
import {
  normalizeEmailProviderError,
  validateEmailProviderResult
} from "./email-provider.mjs";

const communicationChannels = Object.freeze(["email", "manual"]);
const communicationTypes = Object.freeze([
  "general", "inquiry_reply", "quotation", "contract",
  "payment_request", "receipt", "final_invoice", "final_presentation",
  "delivery", "storage_notice", "final_storage_notice", "thank_you",
  "manual_note"
]);
const communicationStatuses = Object.freeze([
  "draft", "ready", "queued", "sent", "delivered",
  "bounced", "failed", "cancelled"
]);
const relationshipFields = Object.freeze([
  "inquiry_id", "client_id", "commission_id", "quotation_id", "document_id"
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bigintPattern = /^[1-9][0-9]*$/;
const QUEUED_STALE_AFTER_MS = 3 * 60 * 1000;
const manualReconciliationConfirmations = Object.freeze({
  sent: "MARK_AS_SENT_VERIFIED_EXTERNALLY",
  failed: "MARK_AS_FAILED_NO_RETRY"
});

function normalizeOptionalText(value, field) {
  if (value === null || value === undefined || value === "") return { value: null };
  if (typeof value !== "string") return { error: `${field} must be text or null.` };
  return { value: value.trim() || null };
}

function normalizeRequiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    return { error: `${field} is required.` };
  }
  return { value: value.trim() };
}

function normalizeRelationship(value, field) {
  if (value === null || value === undefined || value === "") return { value: null };
  const normalized = String(value).trim();
  const valid = field === "inquiry_id" ? uuidPattern.test(normalized) : bigintPattern.test(normalized);
  return valid ? { value: normalized } : { error: `${field} is invalid.` };
}

function normalizeRequestId(value) {
  if (value === null || value === undefined || value === "") return { value: null };
  return typeof value === "string" && uuidPattern.test(value.trim())
    ? { value: value.trim().toLowerCase() }
    : { error: "request_id must be a valid UUID." };
}

function normalizeCommunicationInput(data, { manual = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }

  const allowed = new Set([
    ...relationshipFields, "channel", "communication_type", "recipient",
    "subject", "body_snapshot", "request_id"
  ]);
  if (Object.keys(data).some((field) => !allowed.has(field))) {
    return { error: "Request body contains unsupported fields." };
  }

  const relationships = {};
  for (const field of relationshipFields) {
    const normalized = normalizeRelationship(data[field], field);
    if (normalized.error) return normalized;
    relationships[field] = normalized.value;
  }
  if (!relationshipFields.some((field) => relationships[field] !== null)) {
    return { error: "At least one valid relationship is required." };
  }

  const channel = manual ? "manual" : data.channel;
  if (!communicationChannels.includes(channel)) {
    return { error: "channel is invalid." };
  }
  const communicationType = data.communication_type;
  if (!communicationTypes.includes(communicationType)) {
    return { error: "communication_type is invalid." };
  }
  const recipient = normalizeRequiredText(data.recipient, "recipient");
  if (recipient.error) return recipient;
  if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.value)) {
    return { error: "recipient must be an email address for the email channel." };
  }
  const bodySnapshot = normalizeRequiredText(data.body_snapshot, "body_snapshot");
  if (bodySnapshot.error) return bodySnapshot;
  const subject = normalizeOptionalText(data.subject, "subject");
  if (subject.error) return subject;
  const requestId = normalizeRequestId(data.request_id);
  if (requestId.error) return requestId;

  return {
    communication: {
      ...relationships,
      channel,
      communication_type: communicationType,
      recipient: recipient.value,
      subject: subject.value,
      body_snapshot: bodySnapshot.value,
      request_id: requestId.value
    }
  };
}

function normalizeDraftUpdate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }
  const allowed = new Set(["recipient", "subject", "body_snapshot", "communication_type"]);
  if (Object.keys(data).some((field) => !allowed.has(field))) {
    return { error: "Only draft content fields may be edited." };
  }
  if (!communicationTypes.includes(data.communication_type)) {
    return { error: "communication_type is invalid." };
  }
  const recipient = normalizeRequiredText(data.recipient, "recipient");
  if (recipient.error) return recipient;
  const bodySnapshot = normalizeRequiredText(data.body_snapshot, "body_snapshot");
  if (bodySnapshot.error) return bodySnapshot;
  const subject = normalizeOptionalText(data.subject, "subject");
  if (subject.error) return subject;
  return {
    update: {
      communication_type: data.communication_type,
      recipient: recipient.value,
      subject: subject.value,
      body_snapshot: bodySnapshot.value
    }
  };
}

async function validateRelationships(queryable, communication) {
  const result = await queryable.query(
    `SELECT
       CASE WHEN $1::uuid IS NULL THEN NULL ELSE (SELECT id FROM inquiries WHERE id = $1) END AS inquiry_id,
       CASE WHEN $2::bigint IS NULL THEN NULL ELSE (SELECT id FROM clients WHERE id = $2) END AS client_id,
       CASE WHEN $3::bigint IS NULL THEN NULL ELSE (SELECT id FROM commissions WHERE id = $3) END AS commission_id,
       CASE WHEN $4::bigint IS NULL THEN NULL ELSE (SELECT id FROM quotations WHERE id = $4) END AS quotation_id,
       CASE WHEN $5::bigint IS NULL THEN NULL ELSE (SELECT id FROM documents WHERE id = $5) END AS document_id,
       (SELECT client_id FROM commissions WHERE id = $3) AS commission_client_id,
       (SELECT commission_id FROM quotations WHERE id = $4) AS quotation_commission_id,
       (SELECT co.client_id FROM quotations q JOIN commissions co ON co.id = q.commission_id WHERE q.id = $4) AS quotation_client_id,
       (SELECT commission_id FROM documents WHERE id = $5) AS document_commission_id,
       (SELECT co.client_id FROM documents d JOIN commissions co ON co.id = d.commission_id WHERE d.id = $5) AS document_client_id`,
    relationshipFields.map((field) => communication[field])
  );
  const row = result.rows[0];
  for (const field of relationshipFields) {
    if (communication[field] !== null && row[field] === null) return `${field} does not exist.`;
  }
  if (communication.client_id && communication.commission_id
    && String(row.commission_client_id) !== String(communication.client_id)) {
    return "client_id does not match the Commission.";
  }
  if (communication.quotation_id && communication.commission_id
    && String(row.quotation_commission_id) !== String(communication.commission_id)) {
    return "quotation_id does not match the Commission.";
  }
  if (communication.document_id && communication.commission_id
    && String(row.document_commission_id) !== String(communication.commission_id)) {
    return "document_id does not match the Commission.";
  }
  if (communication.client_id && communication.quotation_id
    && String(row.quotation_client_id) !== String(communication.client_id)) {
    return "quotation_id does not match the Client.";
  }
  if (communication.client_id && communication.document_id
    && String(row.document_client_id) !== String(communication.client_id)) {
    return "document_id does not match the Client.";
  }
  if (communication.quotation_id && communication.document_id
    && String(row.quotation_commission_id) !== String(row.document_commission_id)) {
    return "quotation_id and document_id do not belong to the same Commission.";
  }
  return null;
}

function sameCreationIntent(existing, communication, status) {
  return existing.communication_status === status
    && relationshipFields.every((field) => String(existing[field] ?? "") === String(communication[field] ?? ""))
    && existing.channel === communication.channel
    && existing.communication_type === communication.communication_type
    && existing.recipient === communication.recipient
    && (existing.subject ?? null) === communication.subject
    && existing.body_snapshot === communication.body_snapshot
    && (existing.template_key ?? null) === (communication.template_key ?? null)
    && Number(existing.template_version ?? 0) === Number(communication.template_version ?? 0);
}

async function createCommunication(db, communication, {
  manual = false,
  templateGenerated = false,
  now = () => new Date()
} = {}) {
  const connection = await db.pool.connect();
  const status = manual ? "sent" : "draft";
  try {
    await connection.query("BEGIN");
    if (communication.request_id) {
      await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [communication.request_id]);
      const existing = (await connection.query(
        "SELECT * FROM communications WHERE request_id = $1",
        [communication.request_id]
      )).rows[0];
      if (existing) {
        await connection.query("COMMIT");
        return sameCreationIntent(existing, communication, status)
          ? { outcome: "success", created: false, communication: existing }
          : { outcome: "request_conflict" };
      }
    }

    const relationshipError = await validateRelationships(connection, communication);
    if (relationshipError) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_relationship", message: relationshipError };
    }

    const occurredAt = now();
    const inserted = (await connection.query(
      `INSERT INTO communications (
         inquiry_id, client_id, commission_id, quotation_id, document_id,
         channel, communication_type, communication_status, recipient,
         subject, body_snapshot, request_id, sent_at, template_key, template_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        communication.inquiry_id, communication.client_id, communication.commission_id,
        communication.quotation_id, communication.document_id, communication.channel,
        communication.communication_type, status, communication.recipient,
        communication.subject, communication.body_snapshot, communication.request_id,
        manual ? occurredAt : null, communication.template_key || null,
        communication.template_version || null
      ]
    )).rows[0];

    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: manual
          ? "manual_communication_recorded"
          : templateGenerated
            ? "communication_generated_from_template"
            : "communication_draft_created",
        occurredAt,
        actorType: "admin",
        sourceType: "communication",
        sourceId: inserted.id,
        requestId: communication.request_id,
        payload: templateGenerated
          ? {
              communication_id: String(inserted.id),
              template_key: communication.template_key,
              template_version: Number(communication.template_version),
              communication_type: communication.communication_type
            }
          : {
              communication_type: communication.communication_type,
              channel: communication.channel,
              communication_id: String(inserted.id)
            }
      });
    }

    await connection.query("COMMIT");
    return { outcome: "success", created: true, communication: inserted };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function markCommunicationReady(db, id, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (current.communication_status === "ready") {
      await connection.query("COMMIT");
      return { outcome: "success", changed: false, communication: current };
    }
    if (current.communication_status !== "draft") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_status" };
    }
    if (current.channel !== "email") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "Only email drafts may be marked ready." };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(current.recipient)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "A valid recipient email is required." };
    }
    if (!current.subject?.trim()) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "Subject is required before review is complete." };
    }
    if (!current.body_snapshot?.trim()) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "Body Snapshot is required before review is complete." };
    }
    if ((current.template_key === null) !== (current.template_version === null)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "Template context is incomplete." };
    }

    const readyAt = now();
    const communication = (await connection.query(
      `UPDATE communications
       SET communication_status = 'ready', ready_at = $1
       WHERE id = $2
       RETURNING *`,
      [readyAt, id]
    )).rows[0];
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: "communication_marked_ready",
        occurredAt: readyAt,
        actorType: "admin",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          template_key: communication.template_key,
          template_version: communication.template_version,
          communication_type: communication.communication_type
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "success", changed: true, communication };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function validReviewedEmail(communication) {
  return communication.channel === "email"
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(communication.recipient)
    && Boolean(communication.subject?.trim())
    && Boolean(communication.body_snapshot?.trim())
    && !communication.provider_message_id;
}

async function claimCommunicationForSend(db, id, emailProvider, now) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (current.channel !== "email") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_channel" };
    }
    if (current.communication_status === "sent") {
      await connection.query("COMMIT");
      return { outcome: "success", changed: false, communication: current };
    }
    if (current.communication_status === "queued") {
      await connection.query("ROLLBACK");
      return { outcome: "in_progress" };
    }
    if (current.communication_status === "failed") {
      await connection.query("ROLLBACK");
      return { outcome: "failed_terminal", error_code: current.error_code };
    }
    if (current.communication_status !== "ready") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_status" };
    }
    if (!validReviewedEmail(current)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content" };
    }
    if (!emailProvider || emailProvider.configured === false || typeof emailProvider.sendEmail !== "function") {
      await connection.query("ROLLBACK");
      return { outcome: "provider_not_configured" };
    }

    const queuedAt = now();
    const communication = (await connection.query(
      `UPDATE communications
       SET communication_status = 'queued', queued_at = $1
       WHERE id = $2
       RETURNING *`,
      [queuedAt, id]
    )).rows[0];
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: "communication_queued",
        occurredAt: queuedAt,
        actorType: "admin",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          communication_type: communication.communication_type,
          channel: communication.channel
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "claimed", communication };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function finalizeCommunicationSent(db, id, providerResult) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (current?.communication_status === "sent") {
      await connection.query("COMMIT");
      return current;
    }
    if (!current || current.communication_status !== "queued") {
      throw new Error("Communication send claim was lost before success could be recorded.");
    }
    const communication = (await connection.query(
      `UPDATE communications
       SET communication_status = 'sent', provider_message_id = $1, sent_at = $2
       WHERE id = $3
       RETURNING *`,
      [providerResult.provider_message_id, providerResult.accepted_at, id]
    )).rows[0];
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: "communication_sent",
        occurredAt: providerResult.accepted_at,
        actorType: "system",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          communication_type: communication.communication_type,
          channel: communication.channel,
          provider: providerResult.provider
        }
      });
    }
    await connection.query("COMMIT");
    return communication;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function finalizeCommunicationFailed(db, id, errorCode, now) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current || current.communication_status !== "queued") {
      throw new Error("Communication send claim was lost before failure could be recorded.");
    }
    const failedAt = now();
    const communication = (await connection.query(
      `UPDATE communications
       SET communication_status = 'failed', failed_at = $1, error_code = $2
       WHERE id = $3
       RETURNING *`,
      [failedAt, errorCode, id]
    )).rows[0];
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: "communication_failed",
        occurredAt: failedAt,
        actorType: "system",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          communication_type: communication.communication_type,
          channel: communication.channel,
          error_code: errorCode
        }
      });
    }
    await connection.query("COMMIT");
    return communication;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function sendCommunication(db, id, emailProvider, now = () => new Date()) {
  const claim = await claimCommunicationForSend(db, id, emailProvider, now);
  if (claim.outcome !== "claimed") return claim;

  let providerResult;
  try {
    providerResult = validateEmailProviderResult(await emailProvider.sendEmail({
      to: claim.communication.recipient,
      subject: claim.communication.subject,
      text: claim.communication.body_snapshot,
      idempotency_key: `communication:${claim.communication.id}`,
      metadata: {
        communication_id: String(claim.communication.id),
        communication_type: claim.communication.communication_type
      }
    }));
  } catch (error) {
    const normalized = normalizeEmailProviderError(error);
    const communication = await finalizeCommunicationFailed(db, id, normalized.code, now);
    return { outcome: "provider_failed", error_code: normalized.code, communication };
  }

  const communication = await finalizeCommunicationSent(db, id, providerResult);
  return { outcome: "success", changed: true, communication, provider: providerResult.provider };
}

function isQueuedStale(communication, now = new Date(), thresholdMs = QUEUED_STALE_AFTER_MS) {
  if (communication?.communication_status !== "queued" || !communication.queued_at) return false;
  const queuedAt = new Date(communication.queued_at);
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(queuedAt.getTime()) || Number.isNaN(reference.getTime())) return false;
  return reference.getTime() - queuedAt.getTime() >= thresholdMs;
}

async function claimCommunicationForReconciliation(db, id, now) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (current.communication_status !== "queued") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_status" };
    }
    const checkedAt = now();
    if (!isQueuedStale(current, checkedAt)) {
      await connection.query("ROLLBACK");
      return { outcome: "not_stale" };
    }
    if (current.reconciliation_status === "pending") {
      await connection.query("ROLLBACK");
      return { outcome: "in_progress" };
    }
    if (current.reconciliation_status === "inconclusive") {
      await connection.query("COMMIT");
      return { outcome: "success", changed: false, result: "inconclusive", communication: current };
    }

    const communication = (await connection.query(
      `UPDATE communications
       SET reconciliation_status = 'pending', reconciled_at = NULL, reconciliation_note = NULL
       WHERE id = $1
       RETURNING *`,
      [id]
    )).rows[0];
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType: "communication_reconciliation_started",
        occurredAt: checkedAt,
        actorType: "admin",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          provider: "gmail",
          result: "pending"
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "claimed", communication };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeReconciliationResult(result) {
  if (!["confirmed_sent", "confirmed_not_sent", "inconclusive"].includes(result?.result)) {
    return { provider: result?.provider || null, result: "inconclusive", code: "provider_reconciliation_error" };
  }
  return {
    provider: typeof result.provider === "string" ? result.provider : null,
    result: result.result,
    code: typeof result.code === "string" ? result.code : null,
    provider_message_id: typeof result.provider_message_id === "string" && result.provider_message_id.trim()
      ? result.provider_message_id.trim()
      : null,
    sent_at: result.sent_at || null
  };
}

async function finalizeCommunicationReconciliation(db, id, result, now) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current || current.communication_status !== "queued" || current.reconciliation_status !== "pending") {
      throw new Error("Communication reconciliation claim was lost before its result could be recorded.");
    }
    const reconciledAt = now();
    let communication;
    let eventType;
    if (result.result === "confirmed_sent") {
      const sentAtValue = result.sent_at && !Number.isNaN(new Date(result.sent_at).getTime())
        ? new Date(result.sent_at)
        : reconciledAt;
      communication = (await connection.query(
        `UPDATE communications
         SET communication_status = 'sent', sent_at = $1,
             provider_message_id = COALESCE(provider_message_id, $2),
             reconciliation_status = 'confirmed_sent', reconciled_at = $3,
             reconciliation_note = 'provider_confirmed_sent'
         WHERE id = $4
         RETURNING *`,
        [sentAtValue, result.provider_message_id, reconciledAt, id]
      )).rows[0];
      eventType = "communication_reconciled_sent";
    } else if (result.result === "confirmed_not_sent") {
      communication = (await connection.query(
        `UPDATE communications
         SET communication_status = 'failed', failed_at = $1,
             error_code = 'reconciliation_confirmed_not_sent',
             reconciliation_status = 'confirmed_not_sent', reconciled_at = $1,
             reconciliation_note = 'provider_confirmed_not_sent'
         WHERE id = $2
         RETURNING *`,
        [reconciledAt, id]
      )).rows[0];
      eventType = "communication_reconciled_not_sent";
    } else {
      const note = result.code === "reconciliation_not_supported_with_current_scope"
        ? "gmail_send_scope_cannot_read_mailbox"
        : "provider_reconciliation_error";
      communication = (await connection.query(
        `UPDATE communications
         SET reconciliation_status = 'inconclusive', reconciled_at = $1,
             reconciliation_note = $2
         WHERE id = $3
         RETURNING *`,
        [reconciledAt, note, id]
      )).rows[0];
      eventType = "communication_reconciliation_inconclusive";
    }
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType,
        occurredAt: reconciledAt,
        actorType: "system",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          provider: result.provider,
          result: result.result
        }
      });
    }
    await connection.query("COMMIT");
    return communication;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function reconcileCommunication(db, id, emailProvider, now = () => new Date()) {
  const claim = await claimCommunicationForReconciliation(db, id, now);
  if (claim.outcome !== "claimed") return claim;

  let result;
  try {
    result = typeof emailProvider?.reconcileEmail === "function"
      ? normalizeReconciliationResult(await emailProvider.reconcileEmail({
          communication_id: String(claim.communication.id),
          idempotency_key: `communication:${claim.communication.id}`,
          provider_message_id: claim.communication.provider_message_id
        }))
      : { provider: null, result: "inconclusive", code: "provider_reconciliation_error" };
  } catch {
    result = { provider: null, result: "inconclusive", code: "provider_reconciliation_error" };
  }
  const communication = await finalizeCommunicationReconciliation(db, id, result, now);
  return { outcome: "success", changed: true, result: result.result, communication };
}

async function resolveQueuedCommunicationManually(db, id, resolution, confirmation, now = () => new Date()) {
  if (!Object.hasOwn(manualReconciliationConfirmations, resolution)
    || confirmation !== manualReconciliationConfirmations[resolution]) {
    return { outcome: "confirmation_required" };
  }
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT * FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const resolvedAt = now();
    if (current.communication_status !== "queued"
      || current.reconciliation_status !== "inconclusive"
      || !isQueuedStale(current, resolvedAt)) {
      await connection.query("ROLLBACK");
      return { outcome: "not_eligible" };
    }

    let communication;
    let eventType;
    let result;
    if (resolution === "sent") {
      communication = (await connection.query(
        `UPDATE communications
         SET communication_status = 'sent', sent_at = $1,
             reconciliation_status = 'confirmed_sent', reconciled_at = $1,
             reconciliation_note = 'admin_verified_externally_sent'
         WHERE id = $2
         RETURNING *`,
        [resolvedAt, id]
      )).rows[0];
      eventType = "communication_marked_sent_manually";
      result = "confirmed_sent";
    } else {
      communication = (await connection.query(
        `UPDATE communications
         SET communication_status = 'failed', failed_at = $1,
             error_code = 'manual_reconciliation_failed',
             reconciliation_status = 'inconclusive', reconciled_at = $1,
             reconciliation_note = 'admin_closed_inconclusive_as_failed'
         WHERE id = $2
         RETURNING *`,
        [resolvedAt, id]
      )).rows[0];
      eventType = "communication_marked_failed_manually";
      result = "inconclusive";
    }
    if (communication.commission_id) {
      await appendCommissionEvent(connection, {
        commissionId: communication.commission_id,
        eventType,
        occurredAt: resolvedAt,
        actorType: "admin",
        sourceType: "communication",
        sourceId: communication.id,
        payload: {
          communication_id: String(communication.id),
          provider: "manual",
          result
        }
      });
    }
    await connection.query("COMMIT");
    return { outcome: "success", communication, result };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function updateDraftCommunication(db, id, update) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    const current = (await connection.query(
      "SELECT id, communication_status, channel FROM communications WHERE id = $1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    if (current.communication_status !== "draft") {
      await connection.query("ROLLBACK");
      return { outcome: "not_editable" };
    }
    if (current.channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.recipient)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_content", message: "recipient must be an email address for the email channel." };
    }
    const communication = (await connection.query(
      `UPDATE communications
       SET recipient = $1, subject = $2, body_snapshot = $3, communication_type = $4
       WHERE id = $5
       RETURNING *`,
      [update.recipient, update.subject, update.body_snapshot, update.communication_type, id]
    )).rows[0];
    await connection.query("COMMIT");
    return { outcome: "success", communication };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

const selectFields = `
  c.id, c.inquiry_id, c.client_id, c.commission_id, c.quotation_id,
  c.document_id, c.channel, c.communication_type, c.communication_status,
  c.recipient, c.subject, c.template_key, c.template_version,
  c.automation_key, c.automation_mode, c.automation_source_key,
  c.provider_message_id, c.request_id, c.created_at,
  c.ready_at, c.queued_at, c.sent_at, c.delivered_at, c.bounced_at,
  c.failed_at, c.cancelled_at, c.error_code, c.reconciliation_status,
  c.reconciled_at, c.reconciliation_note,
  co.commission_number, q.quotation_number, d.document_number`;

function withDerivedReconciliationState(communication, now = new Date()) {
  if (!communication) return null;
  const queuedStale = isQueuedStale(communication, now);
  return {
    ...communication,
    queued_stale: queuedStale,
    reconciliation_required: queuedStale
      && communication.reconciliation_status !== "pending"
  };
}

async function listCommunications(db, filters = {}, now = new Date()) {
  const result = await db.pool.query(
    `SELECT ${selectFields}
     FROM communications c
     LEFT JOIN commissions co ON co.id = c.commission_id
     LEFT JOIN quotations q ON q.id = c.quotation_id
     LEFT JOIN documents d ON d.id = c.document_id
     WHERE ($1::bigint IS NULL OR c.commission_id = $1)
       AND ($2::bigint IS NULL OR c.client_id = $2)
       AND ($3::uuid IS NULL OR c.inquiry_id = $3)
       AND ($4::text IS NULL OR c.communication_status = $4)
       AND ($5::text IS NULL OR c.communication_type = $5)
       AND ($6::text IS NULL OR c.channel = $6)
     ORDER BY c.created_at DESC, c.id DESC`,
    [filters.commission_id, filters.client_id, filters.inquiry_id, filters.status, filters.type, filters.channel]
  );
  return result.rows.map((row) => withDerivedReconciliationState(row, now));
}

async function getCommunication(db, id, now = new Date()) {
  const communication = (await db.pool.query(
    `SELECT ${selectFields}, c.body_snapshot
     FROM communications c
     LEFT JOIN commissions co ON co.id = c.commission_id
     LEFT JOIN quotations q ON q.id = c.quotation_id
     LEFT JOIN documents d ON d.id = c.document_id
     WHERE c.id = $1`,
    [id]
  )).rows[0] || null;
  return withDerivedReconciliationState(communication, now);
}

export {
  communicationChannels,
  communicationStatuses,
  communicationTypes,
  QUEUED_STALE_AFTER_MS,
  createCommunication,
  getCommunication,
  isQueuedStale,
  listCommunications,
  markCommunicationReady,
  normalizeCommunicationInput,
  normalizeDraftUpdate,
  reconcileCommunication,
  relationshipFields,
  resolveQueuedCommunicationManually,
  sendCommunication,
  updateDraftCommunication,
  validateRelationships
};
