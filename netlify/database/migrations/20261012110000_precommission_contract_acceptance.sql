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
      document_type NOT IN ('quotation', 'contract')
      AND commission_id IS NOT NULL
    )
  );

CREATE INDEX documents_contract_quotation_index
  ON documents (quotation_id, created_at DESC)
  WHERE document_type = 'contract';

CREATE FUNCTION enforce_issued_contract_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.document_type = 'contract'
    AND OLD.document_snapshot -> 'contract' ->> 'status' = 'issued' THEN
    IF
      NEW.document_type IS DISTINCT FROM OLD.document_type OR
      NEW.client_id IS DISTINCT FROM OLD.client_id OR
      NEW.quotation_id IS DISTINCT FROM OLD.quotation_id OR
      NEW.document_number IS DISTINCT FROM OLD.document_number OR
      NEW.version IS DISTINCT FROM OLD.version OR
      NEW.document_snapshot IS DISTINCT FROM OLD.document_snapshot OR
      NEW.request_id IS DISTINCT FROM OLD.request_id OR
      (
        NEW.commission_id IS DISTINCT FROM OLD.commission_id
        AND NOT (OLD.commission_id IS NULL AND NEW.commission_id IS NOT NULL)
      )
    THEN
      RAISE EXCEPTION 'Issued Contract identity and snapshot are immutable.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_issued_contract_immutability_trigger
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_issued_contract_immutability();

ALTER TABLE acceptances
  DROP CONSTRAINT acceptances_subject_context_check;

ALTER TABLE acceptances
  ADD CONSTRAINT acceptances_subject_context_check CHECK (
    (
      acceptance_type = 'quotation'
      AND quotation_id IS NOT NULL
      AND document_id IS NULL
      AND client_id IS NOT NULL
    )
    OR
    (
      acceptance_type = 'contract'
      AND document_id IS NOT NULL
      AND client_id IS NOT NULL
      AND (
        (quotation_id IS NOT NULL AND terms_version IS NOT NULL)
        OR (quotation_id IS NULL AND commission_id IS NOT NULL)
      )
    )
  );

CREATE UNIQUE INDEX acceptances_effective_contract_unique
  ON acceptances (document_id)
  WHERE acceptance_type = 'contract' AND accepted = TRUE;

CREATE INDEX acceptances_contract_quotation_index
  ON acceptances (quotation_id, accepted_at DESC)
  WHERE acceptance_type = 'contract';

COMMENT ON CONSTRAINT documents_canonical_context_check ON documents IS
  'Quotation-rooted Contracts may exist before Commission activation; unrelated document types retain their Commission requirements.';

COMMENT ON CONSTRAINT acceptances_subject_context_check ON acceptances IS
  'Canonical Contract Acceptances retain Document, Quotation, Client, and terms evidence without requiring a Commission; legacy Commission-centric records remain valid.';
