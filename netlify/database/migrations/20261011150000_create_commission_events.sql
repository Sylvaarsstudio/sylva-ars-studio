CREATE TABLE commission_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL
    REFERENCES commissions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL
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
      'commission_status_changed'
    )),
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('admin', 'client', 'system')),
  actor_id TEXT,
  source_type TEXT
    CHECK (source_type IS NULL OR source_type IN (
      'inquiry', 'quotation', 'acceptance', 'contract',
      'payment', 'document', 'commission'
    )),
  source_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source_type IS NULL AND source_id IS NULL)
    OR
    (source_type IS NOT NULL AND source_id IS NOT NULL AND btrim(source_id) <> '')
  )
);

CREATE INDEX commission_events_commission_occurred_index
  ON commission_events (commission_id, occurred_at DESC, id DESC);

CREATE INDEX commission_events_source_index
  ON commission_events (source_type, source_id)
  WHERE source_type IS NOT NULL;

CREATE UNIQUE INDEX commission_events_request_event_source_unique
  ON commission_events (request_id, event_type, source_type, source_id)
  WHERE request_id IS NOT NULL
    AND source_type IS NOT NULL
    AND source_id IS NOT NULL;

CREATE FUNCTION prevent_commission_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Commission event records are append-only and immutable.';
END;
$$;

CREATE TRIGGER commission_events_append_only_trigger
BEFORE UPDATE OR DELETE ON commission_events
FOR EACH ROW EXECUTE FUNCTION prevent_commission_event_mutation();
