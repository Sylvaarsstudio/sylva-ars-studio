ALTER TABLE deliveries
  ADD COLUMN storage_notice_at TIMESTAMPTZ,
  ADD COLUMN storage_fee_start_at TIMESTAMPTZ,
  ADD COLUMN final_notice_at TIMESTAMPTZ,
  ADD COLUMN abandonment_eligible_at TIMESTAMPTZ,
  ADD COLUMN abandoned_at TIMESTAMPTZ,
  ADD CONSTRAINT deliveries_storage_fee_window_check CHECK (
    storage_fee_start_at IS NULL
    OR (storage_start_at IS NOT NULL AND storage_fee_start_at >= storage_start_at)
  ),
  ADD CONSTRAINT deliveries_abandonment_window_check CHECK (
    abandonment_eligible_at IS NULL
    OR (final_notice_at IS NOT NULL AND abandonment_eligible_at >= final_notice_at)
  );

CREATE UNIQUE INDEX commission_obligations_storage_delivery_unique
  ON commission_obligations (source_type, source_id)
  WHERE obligation_type = 'storage_fee'
    AND source_type = 'delivery';

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
    'storage_final_notice_recorded'
  ));

COMMENT ON COLUMN deliveries.storage_fee_start_at IS
  'End of the 30-calendar-day free storage period. Storage fees accrue only after this timestamp.';

COMMENT ON COLUMN deliveries.abandonment_eligible_at IS
  'Earliest derived review date, 180 calendar days after final written notice. It is not automatic abandonment.';

COMMENT ON COLUMN deliveries.abandoned_at IS
  'Reserved for a future structured legal review workflow. Phase 10C never sets this automatically.';
