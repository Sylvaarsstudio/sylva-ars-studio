ALTER TABLE commission_obligations
  ALTER COLUMN commission_id DROP NOT NULL,
  ADD COLUMN client_id BIGINT
    REFERENCES clients(id) ON DELETE RESTRICT,
  ADD COLUMN quotation_id BIGINT
    REFERENCES quotations(id) ON DELETE RESTRICT,
  ADD COLUMN contract_document_id BIGINT
    REFERENCES documents(id) ON DELETE RESTRICT,
  ADD COLUMN contract_acceptance_id BIGINT
    REFERENCES acceptances(id) ON DELETE RESTRICT;

ALTER TABLE commission_obligations
  ADD CONSTRAINT commission_obligations_context_check CHECK (
    commission_id IS NOT NULL
    OR (
      obligation_type = 'deposit'
      AND client_id IS NOT NULL
      AND quotation_id IS NOT NULL
      AND contract_document_id IS NOT NULL
      AND contract_acceptance_id IS NOT NULL
      AND due_at IS NULL
    )
  );

CREATE UNIQUE INDEX commission_obligations_contract_acceptance_deposit_unique
  ON commission_obligations (contract_acceptance_id)
  WHERE obligation_type = 'deposit' AND contract_acceptance_id IS NOT NULL;

CREATE INDEX commission_obligations_precommission_client_index
  ON commission_obligations (client_id, obligation_status, created_at DESC)
  WHERE commission_id IS NULL;

CREATE INDEX commission_obligations_precommission_quotation_index
  ON commission_obligations (quotation_id, created_at DESC)
  WHERE commission_id IS NULL;

CREATE FUNCTION enforce_precommission_deposit_context()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.commission_id IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM acceptances AS contract_acceptance
      JOIN documents AS contract_document
        ON contract_document.id = contract_acceptance.document_id
      JOIN quotations AS quotation
        ON quotation.id = contract_acceptance.quotation_id
      JOIN acceptances AS quotation_acceptance
        ON quotation_acceptance.id = NULLIF(
          contract_document.document_snapshot -> 'quotation' ->> 'quotation_acceptance_id',
          ''
        )::BIGINT
      WHERE contract_acceptance.id = NEW.contract_acceptance_id
        AND contract_acceptance.acceptance_type = 'contract'
        AND contract_acceptance.accepted = TRUE
        AND contract_acceptance.commission_id IS NULL
        AND contract_acceptance.client_id = NEW.client_id
        AND contract_acceptance.quotation_id = NEW.quotation_id
        AND contract_acceptance.document_id = NEW.contract_document_id
        AND contract_acceptance.subject_number = contract_document.document_number
        AND contract_acceptance.subject_version = contract_document.version
        AND contract_acceptance.terms_version = contract_document.document_snapshot -> 'terms' ->> 'terms_version'
        AND contract_document.document_type = 'contract'
        AND contract_document.commission_id IS NULL
        AND contract_document.client_id = NEW.client_id
        AND contract_document.quotation_id = NEW.quotation_id
        AND contract_document.document_snapshot -> 'contract' ->> 'status' = 'issued'
        AND (contract_document.document_snapshot ->> 'schema_version')::INTEGER = 3
        AND contract_document.document_snapshot -> 'client' ->> 'client_id' = NEW.client_id::TEXT
        AND contract_document.document_snapshot -> 'quotation' ->> 'quotation_id' = NEW.quotation_id::TEXT
        AND contract_document.document_snapshot -> 'quotation' ->> 'quotation_snapshot_hash' = quotation.snapshot_hash
        AND quotation.client_id = NEW.client_id
        AND quotation.quotation_status = 'accepted'
        AND quotation_acceptance.acceptance_type = 'quotation'
        AND quotation_acceptance.accepted = TRUE
        AND quotation_acceptance.quotation_id = NEW.quotation_id
        AND quotation_acceptance.client_id = NEW.client_id
        AND quotation_acceptance.snapshot_hash = quotation.snapshot_hash
        AND quotation_acceptance.subject_number = quotation.quotation_number
        AND quotation_acceptance.subject_version = quotation.version
        AND NEW.amount = (
          quotation.quotation_snapshot -> 'commercial' ->> 'required_deposit'
        )::NUMERIC(12, 2)
    ) THEN
      RAISE EXCEPTION 'Invalid canonical pre-Commission deposit obligation context.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_obligations_precommission_context_trigger
BEFORE INSERT OR UPDATE ON commission_obligations
FOR EACH ROW EXECUTE FUNCTION enforce_precommission_deposit_context();

COMMENT ON CONSTRAINT commission_obligations_context_check ON commission_obligations IS
  'Only a canonical required-deposit obligation with complete Contract Acceptance provenance may exist before Commission activation.';

COMMENT ON COLUMN commission_obligations.contract_acceptance_id IS
  'Canonical source Acceptance for a pre-Commission required-deposit obligation. Exactly one such obligation may exist per Contract Acceptance.';
