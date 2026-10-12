ALTER TABLE quotations
  ADD COLUMN client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  ADD COLUMN inquiry_id UUID REFERENCES inquiries(id) ON DELETE RESTRICT,
  ADD COLUMN artwork_title TEXT,
  ADD COLUMN artwork_description TEXT,
  ADD COLUMN artwork_medium TEXT,
  ADD COLUMN artwork_width NUMERIC(10, 2) CHECK (artwork_width > 0),
  ADD COLUMN artwork_height NUMERIC(10, 2) CHECK (artwork_height > 0),
  ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 1
    CHECK (snapshot_version IN (1, 2));

UPDATE quotations AS q
SET
  client_id = c.client_id,
  artwork_title = c.title,
  artwork_description = c.description,
  artwork_medium = c.medium,
  artwork_width = c.width,
  artwork_height = c.height
FROM commissions AS c
WHERE c.id = q.commission_id;

ALTER TABLE quotations
  ALTER COLUMN commission_id DROP NOT NULL,
  ALTER COLUMN client_id SET NOT NULL,
  ALTER COLUMN artwork_title SET NOT NULL,
  ALTER COLUMN artwork_description SET NOT NULL,
  ALTER COLUMN artwork_medium SET NOT NULL,
  ADD CONSTRAINT quotations_artwork_title_not_blank_check
    CHECK (btrim(artwork_title) <> ''),
  ADD CONSTRAINT quotations_artwork_description_not_blank_check
    CHECK (btrim(artwork_description) <> ''),
  ADD CONSTRAINT quotations_artwork_medium_not_blank_check
    CHECK (btrim(artwork_medium) <> '');

CREATE INDEX quotations_client_id_index ON quotations (client_id);
CREATE INDEX quotations_inquiry_id_index ON quotations (inquiry_id);

CREATE SEQUENCE quotation_number_sequence;

SELECT setval(
  'quotation_number_sequence',
  GREATEST(
    COALESCE((
      SELECT MAX(split_part(quotation_number, '-', 4)::BIGINT)
      FROM quotations
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM quotations)
);

CREATE OR REPLACE FUNCTION enforce_quotation_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.quotation_status <> 'draft' AND (
    NEW.commission_id IS DISTINCT FROM OLD.commission_id OR
    NEW.client_id IS DISTINCT FROM OLD.client_id OR
    NEW.inquiry_id IS DISTINCT FROM OLD.inquiry_id OR
    NEW.artwork_title IS DISTINCT FROM OLD.artwork_title OR
    NEW.artwork_description IS DISTINCT FROM OLD.artwork_description OR
    NEW.artwork_medium IS DISTINCT FROM OLD.artwork_medium OR
    NEW.artwork_width IS DISTINCT FROM OLD.artwork_width OR
    NEW.artwork_height IS DISTINCT FROM OLD.artwork_height OR
    NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version OR
    NEW.quotation_number IS DISTINCT FROM OLD.quotation_number OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.price IS DISTINCT FROM OLD.price OR
    NEW.sales_tax_rate IS DISTINCT FROM OLD.sales_tax_rate OR
    NEW.sales_tax IS DISTINCT FROM OLD.sales_tax OR
    NEW.shipping_charge IS DISTINCT FROM OLD.shipping_charge OR
    NEW.shipping_estimate_snapshot IS DISTINCT FROM OLD.shipping_estimate_snapshot OR
    NEW.estimated_completion IS DISTINCT FROM OLD.estimated_completion OR
    NEW.required_deposit_rate IS DISTINCT FROM OLD.required_deposit_rate OR
    NEW.required_deposit IS DISTINCT FROM OLD.required_deposit OR
    NEW.special_terms IS DISTINCT FROM OLD.special_terms OR
    NEW.quotation_snapshot IS DISTINCT FROM OLD.quotation_snapshot OR
    NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash OR
    NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
    NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
    NEW.supersedes_quotation_id IS DISTINCT FROM OLD.supersedes_quotation_id
  ) THEN
    RAISE EXCEPTION 'Issued quotation commercial fields are immutable.';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

ALTER TABLE documents
  ADD COLUMN client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT;

UPDATE documents AS d
SET client_id = c.client_id
FROM commissions AS c
WHERE c.id = d.commission_id;

ALTER TABLE documents
  ALTER COLUMN commission_id DROP NOT NULL,
  ADD CONSTRAINT documents_canonical_context_check
    CHECK (
      (document_type = 'quotation' AND quotation_id IS NOT NULL AND client_id IS NOT NULL)
      OR
      (document_type <> 'quotation' AND commission_id IS NOT NULL)
    );

CREATE INDEX documents_client_id_index ON documents (client_id);

ALTER TABLE acceptances
  ALTER COLUMN commission_id DROP NOT NULL,
  DROP CONSTRAINT acceptances_check,
  ADD CONSTRAINT acceptances_subject_context_check
    CHECK (
      (
        acceptance_type = 'quotation'
        AND quotation_id IS NOT NULL
        AND document_id IS NULL
        AND client_id IS NOT NULL
      )
      OR
      (
        acceptance_type = 'contract'
        AND quotation_id IS NULL
        AND document_id IS NOT NULL
        AND commission_id IS NOT NULL
        AND client_id IS NOT NULL
      )
    );

ALTER TABLE commissions
  ADD COLUMN source_quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX commissions_source_quotation_unique
  ON commissions (source_quotation_id)
  WHERE source_quotation_id IS NOT NULL;

CREATE SEQUENCE commission_number_sequence;

SELECT setval(
  'commission_number_sequence',
  GREATEST(
    COALESCE((
      SELECT MAX(split_part(commission_number, '-', 4)::BIGINT)
      FROM commissions
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM commissions)
);

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_event_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_event_type_check
  CHECK (event_type IN (
    'inquiry_linked', 'quotation_created', 'quotation_issued', 'quotation_sent',
    'quotation_accepted', 'quotation_withdrawn', 'quotation_superseded',
    'contract_preview_prepared', 'payment_recorded', 'deposit_received',
    'balance_paid', 'receipt_issued', 'final_invoice_issued',
    'commission_status_changed', 'commission_created_from_quotation',
    'production_initialized', 'production_reserved', 'production_started',
    'production_awaiting_client_review', 'production_revision_started',
    'production_final_presented', 'production_final_accepted',
    'production_paused', 'production_resumed', 'production_completed',
    'delivery_created', 'delivery_ready', 'delivery_scheduled',
    'delivery_shipped', 'delivery_delivered', 'delivery_picked_up',
    'delivery_cancelled', 'delivery_in_storage', 'storage_notice_recorded',
    'storage_fee_created', 'storage_fee_updated', 'storage_final_notice_recorded',
    'communication_draft_created', 'manual_communication_recorded',
    'communication_generated_from_template', 'communication_marked_ready',
    'communication_queued', 'communication_sent', 'communication_failed',
    'communication_reconciliation_started', 'communication_reconciled_sent',
    'communication_reconciled_not_sent', 'communication_reconciliation_inconclusive',
    'communication_marked_sent_manually', 'communication_marked_failed_manually',
    'communication_automation_created'
  ));

COMMENT ON COLUMN quotations.client_id IS
  'Canonical Client owner of the Quotation, including before a Commission exists.';
COMMENT ON COLUMN quotations.inquiry_id IS
  'Optional real Inquiry that led to this Quotation. Never inferred historically.';
COMMENT ON COLUMN quotations.snapshot_version IS
  'Version 1 is legacy Commission-based; version 2 is pre-Commission commercial truth.';
COMMENT ON COLUMN commissions.source_quotation_id IS
  'Accepted Quotation that canonically created this Commission; NULL only for legacy records.';
