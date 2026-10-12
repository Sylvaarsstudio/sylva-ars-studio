CREATE TABLE communications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id UUID REFERENCES inquiries(id) ON DELETE RESTRICT,
  client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  commission_id BIGINT REFERENCES commissions(id) ON DELETE RESTRICT,
  quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  document_id BIGINT REFERENCES documents(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL
    CHECK (channel IN ('email', 'manual')),
  communication_type TEXT NOT NULL
    CHECK (communication_type IN (
      'general', 'inquiry_reply', 'quotation', 'contract',
      'payment_request', 'receipt', 'final_invoice',
      'final_presentation', 'delivery', 'storage_notice',
      'final_storage_notice', 'thank_you', 'manual_note'
    )),
  communication_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (communication_status IN (
      'draft', 'ready', 'queued', 'sent', 'delivered',
      'bounced', 'failed', 'cancelled'
    )),
  recipient TEXT NOT NULL CHECK (btrim(recipient) <> ''),
  subject TEXT,
  body_snapshot TEXT NOT NULL CHECK (btrim(body_snapshot) <> ''),
  provider_message_id TEXT,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  bounced_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  error_code TEXT,
  CHECK (
    inquiry_id IS NOT NULL
    OR client_id IS NOT NULL
    OR commission_id IS NOT NULL
    OR quotation_id IS NOT NULL
    OR document_id IS NOT NULL
  ),
  CHECK (
    channel <> 'email'
    OR recipient ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CHECK (communication_status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX communications_commission_id_index ON communications (commission_id);
CREATE INDEX communications_client_id_index ON communications (client_id);
CREATE INDEX communications_inquiry_id_index ON communications (inquiry_id);
CREATE INDEX communications_status_index ON communications (communication_status);
CREATE INDEX communications_created_at_index ON communications (created_at DESC);

CREATE UNIQUE INDEX communications_request_id_unique
  ON communications (request_id)
  WHERE request_id IS NOT NULL;

CREATE FUNCTION enforce_communication_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.communication_status IN ('sent', 'delivered', 'bounced', 'failed') AND (
    NEW.inquiry_id IS DISTINCT FROM OLD.inquiry_id OR
    NEW.client_id IS DISTINCT FROM OLD.client_id OR
    NEW.commission_id IS DISTINCT FROM OLD.commission_id OR
    NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
    NEW.document_id IS DISTINCT FROM OLD.document_id OR
    NEW.channel IS DISTINCT FROM OLD.channel OR
    NEW.communication_type IS DISTINCT FROM OLD.communication_type OR
    NEW.recipient IS DISTINCT FROM OLD.recipient OR
    NEW.subject IS DISTINCT FROM OLD.subject OR
    NEW.body_snapshot IS DISTINCT FROM OLD.body_snapshot
  ) THEN
    RAISE EXCEPTION 'Historical communication content and relationships are immutable.';
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

CREATE TRIGGER communications_immutability_trigger
BEFORE UPDATE ON communications
FOR EACH ROW EXECUTE FUNCTION enforce_communication_immutability();

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
    'manual_communication_recorded'
  ));

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_source_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'inquiry', 'quotation', 'acceptance', 'contract',
    'payment', 'document', 'commission', 'delivery', 'communication'
  ));

COMMENT ON TABLE communications IS
  'Persistent communication records. Phase 11A records drafts and manual history but does not send messages.';

COMMENT ON COLUMN communications.body_snapshot IS
  'Exact message text at the time represented by this communication; immutable after historical delivery states.';
