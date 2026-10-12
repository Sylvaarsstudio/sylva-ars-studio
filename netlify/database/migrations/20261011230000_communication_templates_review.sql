ALTER TABLE communications
  ADD COLUMN template_key TEXT,
  ADD COLUMN template_version INTEGER,
  ADD CONSTRAINT communications_template_metadata_check CHECK (
    (template_key IS NULL AND template_version IS NULL)
    OR
    (template_key IS NOT NULL AND btrim(template_key) <> '' AND template_version > 0)
  ),
  ADD CONSTRAINT communications_ready_timestamp_check CHECK (
    communication_status <> 'ready' OR ready_at IS NOT NULL
  );

CREATE OR REPLACE FUNCTION enforce_communication_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.communication_status IN ('ready', 'sent', 'delivered', 'bounced', 'failed') AND (
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
    NEW.template_version IS DISTINCT FROM OLD.template_version
  ) THEN
    RAISE EXCEPTION 'Reviewed or historical communication content, template metadata, and relationships are immutable.';
  END IF;

  IF OLD.communication_status = 'draft'
    AND NEW.communication_status NOT IN ('draft', 'ready') THEN
    RAISE EXCEPTION 'Phase 11B permits only the draft to ready transition.';
  END IF;

  IF OLD.communication_status = 'ready'
    AND NEW.communication_status <> 'ready' THEN
    RAISE EXCEPTION 'Ready communications cannot transition until a sending workflow exists.';
  END IF;

  IF OLD.communication_status IN ('sent', 'delivered', 'bounced', 'failed')
    AND NEW.communication_status IN ('draft', 'ready', 'queued') THEN
    RAISE EXCEPTION 'Historical communications cannot return to an editable or pre-send state.';
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
    'communication_marked_ready'
  ));

COMMENT ON COLUMN communications.template_key IS
  'Versioned code-registry template used to generate this draft. NULL for manually composed records.';

COMMENT ON COLUMN communications.template_version IS
  'Template registry version used at generation time; the exact rendered result remains in body_snapshot.';
