ALTER TABLE communications
  ADD COLUMN automation_key TEXT,
  ADD COLUMN automation_mode TEXT,
  ADD COLUMN automation_source_key TEXT,
  ADD CONSTRAINT communications_automation_key_check CHECK (
    automation_key IS NULL OR automation_key IN (
      'inquiry_received_confirmation',
      'quotation_acceptance_confirmation',
      'receipt_delivery',
      'final_invoice_delivery'
    )
  ),
  ADD CONSTRAINT communications_automation_mode_check CHECK (
    automation_mode IS NULL OR automation_mode IN ('auto_send', 'review_required')
  ),
  ADD CONSTRAINT communications_automation_metadata_check CHECK (
    (automation_key IS NULL AND automation_mode IS NULL AND automation_source_key IS NULL)
    OR (
      automation_key IS NOT NULL
      AND automation_mode IS NOT NULL
      AND automation_source_key IS NOT NULL
      AND btrim(automation_source_key) <> ''
    )
  );

CREATE UNIQUE INDEX communications_automation_source_unique
  ON communications (automation_source_key)
  WHERE automation_source_key IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_communication_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.communication_status IN ('ready', 'queued', 'sent', 'delivered', 'bounced', 'failed') AND (
    NEW.inquiry_id IS DISTINCT FROM OLD.inquiry_id OR
    NEW.client_id IS DISTINCT FROM OLD.client_id OR
    NEW.commission_id IS DISTINCT FROM OLD.commission_id OR
    NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
    NEW.document_id IS DISTINCT FROM OLD.document_id OR
    NEW.channel IS DISTINCT FROM OLD.channel OR
    NEW.communication_type IS DISTINCT FROM OLD.communication_type OR
    NEW.recipient IS DISTINCT FROM OLD.recipient OR
    NEW.subject IS DISTINCT FROM OLD.subject OR
    NEW.body_snapshot IS DISTINCT FROM OLD.body_snapshot OR
    NEW.template_key IS DISTINCT FROM OLD.template_key OR
    NEW.template_version IS DISTINCT FROM OLD.template_version OR
    NEW.automation_key IS DISTINCT FROM OLD.automation_key OR
    NEW.automation_mode IS DISTINCT FROM OLD.automation_mode OR
    NEW.automation_source_key IS DISTINCT FROM OLD.automation_source_key
  ) THEN
    RAISE EXCEPTION 'Reviewed, queued, or historical communication content, template, automation metadata, and relationships are immutable.';
  END IF;

  IF OLD.provider_message_id IS NOT NULL
    AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'Provider message ID is immutable once recorded.';
  END IF;

  IF OLD.communication_status = 'draft'
    AND NEW.communication_status NOT IN ('draft', 'ready') THEN
    RAISE EXCEPTION 'Draft communications may only be marked ready.';
  END IF;

  IF OLD.communication_status = 'ready'
    AND NEW.communication_status NOT IN ('ready', 'queued') THEN
    RAISE EXCEPTION 'Ready communications may only be claimed by the sending engine.';
  END IF;

  IF OLD.communication_status = 'queued'
    AND NEW.communication_status NOT IN ('queued', 'sent', 'failed') THEN
    RAISE EXCEPTION 'Queued communications may only become sent or failed.';
  END IF;

  IF OLD.communication_status IN ('sent', 'delivered', 'bounced', 'failed')
    AND NEW.communication_status <> OLD.communication_status THEN
    RAISE EXCEPTION 'Sent, delivery-result, and failed communications cannot return or transition in Phase 11C.1.';
  END IF;

  IF OLD.communication_status = 'cancelled'
    AND NEW.communication_status <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled communications cannot be reopened.';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_event_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_event_type_check
  CHECK (event_type IN (
    'inquiry_linked', 'quotation_created', 'quotation_issued', 'quotation_sent',
    'quotation_accepted', 'quotation_withdrawn', 'quotation_superseded',
    'contract_preview_prepared', 'payment_recorded', 'deposit_received',
    'balance_paid', 'receipt_issued', 'final_invoice_issued',
    'commission_status_changed', 'production_initialized', 'production_reserved',
    'production_started', 'production_awaiting_client_review',
    'production_revision_started', 'production_final_presented',
    'production_final_accepted', 'production_paused', 'production_resumed',
    'production_completed', 'delivery_created', 'delivery_ready',
    'delivery_scheduled', 'delivery_shipped', 'delivery_delivered',
    'delivery_picked_up', 'delivery_cancelled', 'delivery_in_storage',
    'storage_notice_recorded', 'storage_fee_created', 'storage_fee_updated',
    'storage_final_notice_recorded', 'communication_draft_created',
    'manual_communication_recorded', 'communication_generated_from_template',
    'communication_marked_ready', 'communication_queued', 'communication_sent',
    'communication_failed', 'communication_reconciliation_started',
    'communication_reconciled_sent', 'communication_reconciled_not_sent',
    'communication_reconciliation_inconclusive',
    'communication_marked_sent_manually', 'communication_marked_failed_manually',
    'communication_automation_created'
  ));

COMMENT ON COLUMN communications.automation_key IS
  'Controlled Safe Automation policy key that created this Communication.';

COMMENT ON COLUMN communications.automation_source_key IS
  'Stable canonical source identity used to prevent duplicate automatic Communications.';
