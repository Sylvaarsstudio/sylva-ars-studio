ALTER TABLE payments
  ALTER COLUMN commission_id DROP NOT NULL,
  ADD COLUMN client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  ADD COLUMN quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  ADD COLUMN precommission_obligation_id BIGINT;

ALTER TABLE payments
  ADD CONSTRAINT payments_canonical_context_check CHECK (
    commission_id IS NOT NULL
    OR (
      payment_type = 'deposit'
      AND status = 'completed'
      AND client_id IS NOT NULL
      AND quotation_id IS NOT NULL
      AND precommission_obligation_id IS NOT NULL
      AND sales_tax = 0
      AND balance_after_payment IS NULL
    )
  );

CREATE UNIQUE INDEX payments_precommission_deposit_obligation_unique
  ON payments (precommission_obligation_id)
  WHERE commission_id IS NULL
    AND payment_type = 'deposit'
    AND status = 'completed';

CREATE INDEX payments_precommission_client_index
  ON payments (client_id, created_at DESC)
  WHERE commission_id IS NULL;

CREATE INDEX payments_precommission_quotation_index
  ON payments (quotation_id, created_at DESC)
  WHERE commission_id IS NULL;

CREATE FUNCTION enforce_precommission_payment_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.commission_id IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM commission_obligations AS obligation
      JOIN quotations AS quotation ON quotation.id = obligation.quotation_id
      WHERE obligation.id = NEW.precommission_obligation_id
        AND obligation.commission_id IS NULL
        AND obligation.client_id = NEW.client_id
        AND obligation.quotation_id = NEW.quotation_id
        AND obligation.obligation_type = 'deposit'
        AND (
          TG_OP <> 'INSERT'
          OR obligation.obligation_status = 'open'
          OR (
            obligation.obligation_status = 'satisfied'
            AND EXISTS (
              SELECT 1
              FROM payments AS canonical_payment
              WHERE canonical_payment.precommission_obligation_id = obligation.id
                AND canonical_payment.commission_id IS NULL
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
    AND OLD.commission_id IS NULL
    AND (
      NEW.client_id IS DISTINCT FROM OLD.client_id OR
      NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
      NEW.precommission_obligation_id IS DISTINCT FROM OLD.precommission_obligation_id OR
      NEW.payment_type IS DISTINCT FROM OLD.payment_type OR
      NEW.amount IS DISTINCT FROM OLD.amount OR
      NEW.sales_tax IS DISTINCT FROM OLD.sales_tax OR
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.request_id IS DISTINCT FROM OLD.request_id OR
      NEW.balance_after_payment IS DISTINCT FROM OLD.balance_after_payment
    ) THEN
    RAISE EXCEPTION 'Canonical pre-Commission deposit payment identity is immutable.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_precommission_context_trigger
BEFORE INSERT OR UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION enforce_precommission_payment_context();

CREATE FUNCTION enforce_precommission_payment_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payment_row payments%ROWTYPE;
  obligation_row commission_obligations%ROWTYPE;
BEGIN
  SELECT * INTO payment_row FROM payments WHERE id = NEW.payment_id;
  SELECT * INTO obligation_row FROM commission_obligations WHERE id = NEW.obligation_id;

  IF payment_row.commission_id IS NULL OR obligation_row.commission_id IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Canonical pre-Commission deposit allocations are immutable.';
    END IF;

    IF payment_row.id IS NULL
      OR obligation_row.id IS NULL
      OR payment_row.commission_id IS NOT NULL
      OR obligation_row.commission_id IS NOT NULL
      OR payment_row.payment_type <> 'deposit'
      OR payment_row.status <> 'completed'
      OR obligation_row.obligation_type <> 'deposit'
      OR obligation_row.obligation_status <> 'open'
      OR payment_row.precommission_obligation_id <> obligation_row.id
      OR payment_row.client_id <> obligation_row.client_id
      OR payment_row.quotation_id <> obligation_row.quotation_id
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

CREATE TRIGGER payment_allocations_precommission_context_trigger
BEFORE INSERT OR UPDATE ON payment_allocations
FOR EACH ROW EXECUTE FUNCTION enforce_precommission_payment_allocation();

ALTER TABLE documents
  DROP CONSTRAINT documents_canonical_context_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_canonical_context_check CHECK (
    (
      document_type = 'quotation'
      AND quotation_id IS NOT NULL
      AND client_id IS NOT NULL
    )
    OR
    (
      document_type = 'contract'
      AND (
        commission_id IS NOT NULL
        OR (
          client_id IS NOT NULL
          AND quotation_id IS NOT NULL
          AND document_snapshot IS NOT NULL
        )
      )
    )
    OR
    (
      document_type = 'receipt'
      AND (
        commission_id IS NOT NULL
        OR (
          client_id IS NOT NULL
          AND quotation_id IS NOT NULL
          AND payment_id IS NOT NULL
          AND receipt_snapshot IS NOT NULL
        )
      )
    )
    OR
    (
      document_type NOT IN ('quotation', 'contract', 'receipt')
      AND commission_id IS NOT NULL
    )
  );

CREATE FUNCTION enforce_precommission_receipt_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.document_type = 'receipt' AND NEW.commission_id IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM payments AS payment
      JOIN commission_obligations AS obligation
        ON obligation.id = payment.precommission_obligation_id
      JOIN quotations AS quotation ON quotation.id = payment.quotation_id
      WHERE payment.id = NEW.payment_id
        AND payment.commission_id IS NULL
        AND payment.payment_type = 'deposit'
        AND payment.status = 'completed'
        AND payment.sales_tax = 0
        AND payment.balance_after_payment IS NULL
        AND payment.client_id = NEW.client_id
        AND payment.quotation_id = NEW.quotation_id
        AND obligation.obligation_type = 'deposit'
        AND obligation.obligation_status = 'satisfied'
        AND obligation.client_id = NEW.client_id
        AND obligation.quotation_id = NEW.quotation_id
        AND NEW.receipt_snapshot -> 'payment' ->> 'id' = payment.id::TEXT
        AND (NEW.receipt_snapshot -> 'payment' ->> 'amount')::NUMERIC(12, 2) = payment.amount
        AND NEW.receipt_snapshot -> 'quotation' ->> 'quotation_id' = quotation.id::TEXT
        AND NEW.receipt_snapshot -> 'quotation' ->> 'number' = quotation.quotation_number
        AND (NEW.receipt_snapshot -> 'quotation' ->> 'version')::INTEGER = quotation.version
        AND NEW.receipt_snapshot -> 'client' ->> 'client_id' = NEW.client_id::TEXT
        AND NEW.receipt_snapshot -> 'receipt' ->> 'number' = NEW.document_number
        AND (NEW.receipt_snapshot -> 'deposit' ->> 'required_deposit')::NUMERIC(12, 2) = obligation.amount
        AND (NEW.receipt_snapshot -> 'deposit' ->> 'amount_applied')::NUMERIC(12, 2) = obligation.amount
        AND (NEW.receipt_snapshot -> 'deposit' ->> 'remaining_after_payment')::NUMERIC(12, 2) = 0
    ) THEN
      RAISE EXCEPTION 'Invalid canonical pre-Commission deposit receipt context.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER documents_precommission_receipt_context_trigger
AFTER INSERT OR UPDATE ON documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_precommission_receipt_context();

CREATE FUNCTION enforce_issued_receipt_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.document_type = 'receipt' AND (
    NEW.document_type IS DISTINCT FROM OLD.document_type OR
    NEW.client_id IS DISTINCT FROM OLD.client_id OR
    NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
    NEW.payment_id IS DISTINCT FROM OLD.payment_id OR
    NEW.document_number IS DISTINCT FROM OLD.document_number OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.file_location IS DISTINCT FROM OLD.file_location OR
    NEW.receipt_snapshot IS DISTINCT FROM OLD.receipt_snapshot OR
    NEW.request_id IS DISTINCT FROM OLD.request_id OR
    (
      NEW.commission_id IS DISTINCT FROM OLD.commission_id
      AND NOT (OLD.commission_id IS NULL AND NEW.commission_id IS NOT NULL)
    )
  ) THEN
    RAISE EXCEPTION 'Issued Receipt identity and snapshot are immutable.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_issued_receipt_immutability_trigger
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_issued_receipt_immutability();

COMMENT ON CONSTRAINT payments_canonical_context_check ON payments IS
  'A Payment without a Commission is only valid as the completed full canonical deposit for a pre-Commission obligation.';

COMMENT ON COLUMN payments.precommission_obligation_id IS
  'Canonical required-deposit obligation satisfied by a pre-Commission Payment. Integrity is enforced by the context and allocation triggers.';

COMMENT ON CONSTRAINT documents_canonical_context_check ON documents IS
  'A pre-Commission Receipt is valid only with complete Client, accepted Quotation, completed Payment, and immutable snapshot context.';
