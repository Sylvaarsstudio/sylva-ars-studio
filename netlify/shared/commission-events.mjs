const commissionEventTypes = Object.freeze([
  "inquiry_linked",
  "quotation_created",
  "quotation_issued",
  "quotation_sent",
  "quotation_accepted",
  "quotation_withdrawn",
  "quotation_superseded",
  "contract_preview_prepared",
  "payment_recorded",
  "deposit_received",
  "balance_paid",
  "receipt_issued",
  "final_invoice_issued",
  "commission_status_changed",
  "commission_activated",
  "production_initialized",
  "production_reserved",
  "production_started",
  "production_awaiting_client_review",
  "production_revision_started",
  "production_final_presented",
  "production_final_accepted",
  "production_paused",
  "production_resumed",
  "production_completed",
  "delivery_created",
  "delivery_ready",
  "delivery_scheduled",
  "delivery_shipped",
  "delivery_delivered",
  "delivery_picked_up",
  "delivery_cancelled",
  "delivery_in_storage",
  "storage_notice_recorded",
  "storage_fee_created",
  "storage_fee_updated",
  "storage_final_notice_recorded",
  "communication_draft_created",
  "manual_communication_recorded",
  "communication_generated_from_template",
  "communication_marked_ready",
  "communication_queued",
  "communication_sent",
  "communication_failed",
  "communication_reconciliation_started",
  "communication_reconciled_sent",
  "communication_reconciled_not_sent",
  "communication_reconciliation_inconclusive",
  "communication_marked_sent_manually",
  "communication_marked_failed_manually",
  "communication_automation_created"
]);

const commissionEventActorTypes = Object.freeze(["admin", "client", "system"]);
const commissionEventSourceTypes = Object.freeze([
  "inquiry", "quotation", "acceptance", "contract",
  "payment", "document", "commission", "delivery", "communication", "obligation"
]);

async function appendCommissionEvent(queryable, {
  commissionId,
  eventType,
  occurredAt = new Date(),
  actorType = "system",
  actorId = null,
  sourceType = null,
  sourceId = null,
  payload = {},
  requestId = null
}) {
  const result = await queryable.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type, actor_id,
       source_type, source_id, payload, request_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (request_id, event_type, source_type, source_id)
       WHERE request_id IS NOT NULL
         AND source_type IS NOT NULL
         AND source_id IS NOT NULL
     DO NOTHING
     RETURNING id, commission_id, event_type, occurred_at, actor_type,
               actor_id, source_type, source_id, payload, request_id, created_at`,
    [
      commissionId,
      eventType,
      occurredAt,
      actorType,
      actorId,
      sourceType,
      sourceId === null ? null : String(sourceId),
      JSON.stringify(payload),
      requestId
    ]
  );

  return result.rows[0] || null;
}

export {
  appendCommissionEvent,
  commissionEventActorTypes,
  commissionEventSourceTypes,
  commissionEventTypes
};
