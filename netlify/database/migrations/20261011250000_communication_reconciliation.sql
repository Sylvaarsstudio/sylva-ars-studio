ALTER TABLE communications
  ADD COLUMN reconciliation_status TEXT
    CHECK (reconciliation_status IS NULL OR reconciliation_status IN (
      'pending', 'confirmed_sent', 'confirmed_not_sent', 'inconclusive'
    )),
  ADD COLUMN reconciled_at TIMESTAMPTZ,
  ADD COLUMN reconciliation_note TEXT
    CHECK (reconciliation_note IS NULL OR reconciliation_note IN (
      'gmail_send_scope_cannot_read_mailbox',
      'provider_confirmed_sent',
      'provider_confirmed_not_sent',
      'provider_reconciliation_error',
      'admin_verified_externally_sent',
      'admin_closed_inconclusive_as_failed'
    )),
  ADD CONSTRAINT communications_reconciliation_state_check CHECK (
    (reconciliation_status IS NULL AND reconciled_at IS NULL AND reconciliation_note IS NULL)
    OR (reconciliation_status = 'pending' AND communication_status = 'queued' AND reconciled_at IS NULL)
    OR (reconciliation_status = 'confirmed_sent' AND communication_status = 'sent' AND reconciled_at IS NOT NULL)
    OR (reconciliation_status = 'confirmed_not_sent' AND communication_status = 'failed' AND reconciled_at IS NOT NULL)
    OR (reconciliation_status = 'inconclusive' AND communication_status IN ('queued', 'failed') AND reconciled_at IS NOT NULL)
  );

ALTER TABLE communications
  DROP CONSTRAINT communications_email_sent_provider_check;

ALTER TABLE communications
  ADD CONSTRAINT communications_email_sent_provider_check CHECK (
    channel <> 'email'
    OR communication_status <> 'sent'
    OR (provider_message_id IS NOT NULL AND btrim(provider_message_id) <> '')
    OR reconciliation_status = 'confirmed_sent'
  );

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_event_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_event_type_check
  CHECK (event_type IN (
    'inquiry_linked',
    'quotation_created',
    'quotation_issued',
    'quotation_sent',
    'quotation_accepted',
    'quotation_withdrawn',
    'quotation_superseded',
    'contract_preview_prepared',
    'payment_recorded',
    'deposit_received',
    'balance_paid',
    'receipt_issued',
    'final_invoice_issued',
    'commission_status_changed',
    'production_initialized',
    'production_reserved',
    'production_started',
    'production_awaiting_client_review',
    'production_revision_started',
    'production_final_presented',
    'production_final_accepted',
    'production_paused',
    'production_resumed',
    'production_completed',
    'delivery_created',
    'delivery_ready',
    'delivery_scheduled',
    'delivery_shipped',
    'delivery_delivered',
    'delivery_picked_up',
    'delivery_cancelled',
    'delivery_in_storage',
    'storage_notice_recorded',
    'storage_fee_created',
    'storage_fee_updated',
    'storage_final_notice_recorded',
    'communication_draft_created',
    'manual_communication_recorded',
    'communication_generated_from_template',
    'communication_marked_ready',
    'communication_queued',
    'communication_sent',
    'communication_failed',
    'communication_reconciliation_started',
    'communication_reconciled_sent',
    'communication_reconciled_not_sent',
    'communication_reconciliation_inconclusive',
    'communication_marked_sent_manually',
    'communication_marked_failed_manually'
  ));

COMMENT ON COLUMN communications.reconciliation_status IS
  'Controlled recovery result for a queued send whose provider outcome was not safely persisted.';

COMMENT ON COLUMN communications.reconciliation_note IS
  'Controlled non-sensitive reason code; arbitrary notes and raw provider responses are not stored.';
