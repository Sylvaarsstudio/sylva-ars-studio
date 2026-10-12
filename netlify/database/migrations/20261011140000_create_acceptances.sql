CREATE TABLE acceptances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acceptance_type TEXT NOT NULL
    CHECK (acceptance_type IN ('quotation', 'contract')),
  quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  document_id BIGINT REFERENCES documents(id) ON DELETE RESTRICT,
  commission_id BIGINT NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  client_name_entered TEXT NOT NULL CHECK (btrim(client_name_entered) <> ''),
  client_email TEXT NOT NULL CHECK (btrim(client_email) <> ''),
  accepted BOOLEAN NOT NULL DEFAULT TRUE,
  accepted_at TIMESTAMPTZ NOT NULL,
  acceptance_method TEXT NOT NULL
    CHECK (acceptance_method IN ('admin_recorded', 'portal')),
  subject_number TEXT NOT NULL CHECK (btrim(subject_number) <> ''),
  subject_version INTEGER NOT NULL CHECK (subject_version > 0),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  terms_version TEXT,
  request_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (acceptance_type = 'quotation' AND quotation_id IS NOT NULL)
    OR
    (acceptance_type = 'contract' AND document_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX acceptances_effective_quotation_unique
  ON acceptances (quotation_id)
  WHERE acceptance_type = 'quotation' AND accepted = TRUE;

CREATE INDEX acceptances_commission_id_index ON acceptances (commission_id);
CREATE INDEX acceptances_client_id_index ON acceptances (client_id);
CREATE INDEX acceptances_document_id_index ON acceptances (document_id);

CREATE FUNCTION prevent_acceptance_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Acceptance records are append-only and immutable.';
END;
$$;

CREATE TRIGGER acceptances_append_only_trigger
BEFORE UPDATE OR DELETE ON acceptances
FOR EACH ROW EXECUTE FUNCTION prevent_acceptance_mutation();
