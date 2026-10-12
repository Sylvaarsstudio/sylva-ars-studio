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
    'delivery_cancelled'
  ));

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_source_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'inquiry', 'quotation', 'acceptance', 'contract',
    'payment', 'document', 'commission', 'delivery'
  ));
