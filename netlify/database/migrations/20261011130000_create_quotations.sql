CREATE TABLE quotations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  quotation_number TEXT NOT NULL
    CHECK (quotation_number ~ '^SAS-QUO-[0-9]{4}-[0-9]{4,}$'),
  version INTEGER NOT NULL CHECK (version > 0),
  quotation_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (quotation_status IN (
      'draft', 'issued', 'sent', 'accepted', 'declined',
      'expired', 'superseded', 'withdrawn'
    )),
  issued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  supersedes_quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  sales_tax_rate NUMERIC(5, 4) NOT NULL CHECK (sales_tax_rate >= 0),
  sales_tax NUMERIC(12, 2) NOT NULL CHECK (sales_tax >= 0),
  shipping_charge NUMERIC(12, 2) NOT NULL CHECK (shipping_charge >= 0),
  estimated_completion DATE,
  required_deposit_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.50
    CHECK (required_deposit_rate = 0.50),
  required_deposit NUMERIC(12, 2) NOT NULL CHECK (required_deposit >= 0),
  special_terms TEXT,
  quotation_snapshot JSONB,
  snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (quotation_number, version),
  UNIQUE (request_id),
  CHECK (supersedes_quotation_id IS NULL OR version > 1),
  CHECK (
    quotation_status = 'draft'
    OR (
      issued_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND quotation_snapshot IS NOT NULL
      AND jsonb_typeof(quotation_snapshot) = 'object'
      AND snapshot_hash IS NOT NULL
    )
  )
);

CREATE INDEX quotations_commission_id_index ON quotations (commission_id);
CREATE INDEX quotations_status_index ON quotations (quotation_status);
CREATE INDEX quotations_supersedes_index ON quotations (supersedes_quotation_id);

CREATE FUNCTION enforce_quotation_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.quotation_status <> 'draft' AND (
    NEW.commission_id IS DISTINCT FROM OLD.commission_id OR
    NEW.quotation_number IS DISTINCT FROM OLD.quotation_number OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.price IS DISTINCT FROM OLD.price OR
    NEW.sales_tax_rate IS DISTINCT FROM OLD.sales_tax_rate OR
    NEW.sales_tax IS DISTINCT FROM OLD.sales_tax OR
    NEW.shipping_charge IS DISTINCT FROM OLD.shipping_charge OR
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

CREATE TRIGGER quotations_immutability_trigger
BEFORE UPDATE ON quotations
FOR EACH ROW EXECUTE FUNCTION enforce_quotation_immutability();

ALTER TABLE documents
  DROP CONSTRAINT documents_document_type_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_check
    CHECK (document_type IN ('contract', 'invoice', 'coa', 'receipt', 'quotation')),
  ADD COLUMN quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_quotation_reference_required_check
    CHECK (document_type <> 'quotation' OR quotation_id IS NOT NULL),
  ADD CONSTRAINT documents_quotation_snapshot_required_check
    CHECK (document_type <> 'quotation' OR document_snapshot IS NOT NULL);

CREATE UNIQUE INDEX documents_quotation_unique
  ON documents (quotation_id)
  WHERE document_type = 'quotation';
