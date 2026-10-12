CREATE TABLE commission_lifecycle (
  commission_id BIGINT PRIMARY KEY
    REFERENCES commissions(id) ON DELETE RESTRICT,
  lifecycle_status TEXT NOT NULL
    CHECK (lifecycle_status IN (
      'draft', 'active', 'paused', 'completed', 'cancelled', 'closed'
    )),
  activated_at TIMESTAMPTZ NOT NULL,
  activation_source TEXT NOT NULL
    CHECK (activation_source IN ('required_deposit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP INDEX payments_precommission_deposit_obligation_unique;

CREATE UNIQUE INDEX payments_precommission_deposit_obligation_unique
  ON payments (precommission_obligation_id)
  WHERE precommission_obligation_id IS NOT NULL
    AND payment_type = 'deposit'
    AND status = 'completed';

CREATE OR REPLACE FUNCTION enforce_precommission_payment_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.precommission_obligation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM commission_obligations AS obligation
      JOIN quotations AS quotation ON quotation.id = obligation.quotation_id
      WHERE obligation.id = NEW.precommission_obligation_id
        AND obligation.client_id = NEW.client_id
        AND obligation.quotation_id = NEW.quotation_id
        AND obligation.obligation_type = 'deposit'
        AND (
          (NEW.commission_id IS NULL)
          OR obligation.commission_id = NEW.commission_id
        )
        AND (
          TG_OP <> 'INSERT'
          OR obligation.obligation_status = 'open'
          OR (
            obligation.obligation_status = 'satisfied'
            AND EXISTS (
              SELECT 1
              FROM payments AS canonical_payment
              WHERE canonical_payment.precommission_obligation_id = obligation.id
                AND canonical_payment.payment_type = 'deposit'
                AND canonical_payment.status = 'completed'
                AND canonical_payment.client_id = obligation.client_id
                AND canonical_payment.quotation_id = obligation.quotation_id
                AND canonical_payment.amount = obligation.amount
            )
          )
        )
        AND quotation.client_id = NEW.client_id
        AND quotation.quotation_status = 'accepted'
        AND quotation.quotation_snapshot IS NOT NULL
        AND NEW.amount = obligation.amount
        AND NEW.amount = (
          quotation.quotation_snapshot -> 'commercial' ->> 'required_deposit'
        )::NUMERIC(12, 2)
    ) THEN
      RAISE EXCEPTION 'Invalid canonical pre-Commission deposit payment context.';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.precommission_obligation_id IS NOT NULL
    AND (
      NEW.client_id IS DISTINCT FROM OLD.client_id OR
      NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
      NEW.precommission_obligation_id IS DISTINCT FROM OLD.precommission_obligation_id OR
      NEW.payment_type IS DISTINCT FROM OLD.payment_type OR
      NEW.amount IS DISTINCT FROM OLD.amount OR
      NEW.sales_tax IS DISTINCT FROM OLD.sales_tax OR
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.request_id IS DISTINCT FROM OLD.request_id OR
      NEW.balance_after_payment IS DISTINCT FROM OLD.balance_after_payment OR
      (
        NEW.commission_id IS DISTINCT FROM OLD.commission_id
        AND NOT (OLD.commission_id IS NULL AND NEW.commission_id IS NOT NULL)
      )
    ) THEN
    RAISE EXCEPTION 'Canonical pre-Commission deposit payment identity is immutable.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_precommission_payment_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payment_row payments%ROWTYPE;
  obligation_row commission_obligations%ROWTYPE;
BEGIN
  SELECT * INTO payment_row FROM payments WHERE id = NEW.payment_id;
  SELECT * INTO obligation_row FROM commission_obligations WHERE id = NEW.obligation_id;

  IF payment_row.precommission_obligation_id IS NOT NULL
    OR obligation_row.contract_acceptance_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Canonical pre-Commission deposit allocations are immutable.';
    END IF;

    IF payment_row.id IS NULL
      OR obligation_row.id IS NULL
      OR payment_row.payment_type <> 'deposit'
      OR payment_row.status <> 'completed'
      OR obligation_row.obligation_type <> 'deposit'
      OR obligation_row.obligation_status <> 'open'
      OR payment_row.precommission_obligation_id <> obligation_row.id
      OR payment_row.client_id <> obligation_row.client_id
      OR payment_row.quotation_id <> obligation_row.quotation_id
      OR payment_row.commission_id IS DISTINCT FROM obligation_row.commission_id
      OR NEW.amount <> payment_row.amount
      OR NEW.amount <> obligation_row.amount
      OR EXISTS (
        SELECT 1
        FROM payment_allocations AS existing_allocation
        WHERE existing_allocation.payment_id = NEW.payment_id
          AND existing_allocation.obligation_id = NEW.obligation_id
      )
    THEN
      RAISE EXCEPTION 'Invalid canonical pre-Commission deposit allocation context.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_precommission_receipt_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_document documents%ROWTYPE;
  is_precommission_receipt BOOLEAN;
BEGIN
  SELECT * INTO current_document FROM documents WHERE id = NEW.id;
  SELECT EXISTS (
    SELECT 1
    FROM payments
    WHERE id = current_document.payment_id
      AND precommission_obligation_id IS NOT NULL
  ) INTO is_precommission_receipt;

  IF current_document.document_type = 'receipt' AND is_precommission_receipt THEN
    IF NOT EXISTS (
      SELECT 1
      FROM payments AS payment
      JOIN commission_obligations AS obligation
        ON obligation.id = payment.precommission_obligation_id
      JOIN quotations AS quotation ON quotation.id = payment.quotation_id
      WHERE payment.id = current_document.payment_id
        AND payment.payment_type = 'deposit'
        AND payment.status = 'completed'
        AND payment.sales_tax = 0
        AND payment.balance_after_payment IS NULL
        AND payment.client_id = current_document.client_id
        AND payment.quotation_id = current_document.quotation_id
        AND payment.commission_id IS NOT DISTINCT FROM current_document.commission_id
        AND obligation.commission_id IS NOT DISTINCT FROM current_document.commission_id
        AND obligation.obligation_type = 'deposit'
        AND obligation.obligation_status = 'satisfied'
        AND obligation.client_id = current_document.client_id
        AND obligation.quotation_id = current_document.quotation_id
        AND current_document.receipt_snapshot -> 'payment' ->> 'id' = payment.id::TEXT
        AND (current_document.receipt_snapshot -> 'payment' ->> 'amount')::NUMERIC(12, 2) = payment.amount
        AND current_document.receipt_snapshot -> 'quotation' ->> 'quotation_id' = quotation.id::TEXT
        AND current_document.receipt_snapshot -> 'quotation' ->> 'number' = quotation.quotation_number
        AND (current_document.receipt_snapshot -> 'quotation' ->> 'version')::INTEGER = quotation.version
        AND current_document.receipt_snapshot -> 'client' ->> 'client_id' = current_document.client_id::TEXT
        AND current_document.receipt_snapshot -> 'receipt' ->> 'number' = current_document.document_number
        AND (current_document.receipt_snapshot -> 'deposit' ->> 'required_deposit')::NUMERIC(12, 2) = obligation.amount
        AND (current_document.receipt_snapshot -> 'deposit' ->> 'amount_applied')::NUMERIC(12, 2) = obligation.amount
        AND (current_document.receipt_snapshot -> 'deposit' ->> 'remaining_after_payment')::NUMERIC(12, 2) = 0
    ) THEN
      RAISE EXCEPTION 'Invalid canonical pre-Commission deposit receipt context.';
    END IF;
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
    'commission_status_changed', 'commission_created_from_quotation',
    'commission_activated', 'production_initialized', 'production_reserved',
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

ALTER TABLE commission_events
  DROP CONSTRAINT commission_events_source_type_check;

ALTER TABLE commission_events
  ADD CONSTRAINT commission_events_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'inquiry', 'quotation', 'acceptance', 'contract', 'payment', 'document',
    'commission', 'delivery', 'communication', 'obligation'
  ));

COMMENT ON TABLE commission_lifecycle IS
  'Canonical Commission lifecycle. New deposit-activated Commissions begin active; legacy commissions remain valid without a row.';

COMMENT ON COLUMN commission_lifecycle.activation_source IS
  'Canonical business fact that activated this Commission. RC2.3B4 supports required_deposit only.';
