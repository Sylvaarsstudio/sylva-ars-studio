CREATE TABLE commission_production (
  commission_id BIGINT PRIMARY KEY
    REFERENCES commissions(id) ON DELETE RESTRICT,
  production_status TEXT NOT NULL
    CHECK (production_status IN (
      'not_started',
      'reserved',
      'in_progress',
      'awaiting_client_review',
      'revision_in_progress',
      'final_presented',
      'final_accepted',
      'paused',
      'completed',
      'cancelled'
    )),
  paused_from_status TEXT
    CHECK (paused_from_status IS NULL OR paused_from_status IN (
      'reserved',
      'in_progress',
      'awaiting_client_review',
      'revision_in_progress'
    )),
  reserved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  final_presented_at TIMESTAMPTZ,
  final_accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (production_status = 'paused' AND paused_from_status IS NOT NULL)
    OR
    (production_status <> 'paused' AND paused_from_status IS NULL)
  )
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
    'production_completed'
  ));
