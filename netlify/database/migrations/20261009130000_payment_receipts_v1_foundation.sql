ALTER TABLE documents
  DROP CONSTRAINT documents_document_type_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_check
    CHECK (document_type IN ('contract', 'invoice', 'coa', 'receipt')),
  ADD COLUMN payment_id BIGINT,
  ADD COLUMN receipt_snapshot JSONB;

ALTER TABLE documents
  ADD CONSTRAINT documents_payment_id_fkey
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_receipt_payment_required_check
    CHECK (document_type <> 'receipt' OR payment_id IS NOT NULL),
  ADD CONSTRAINT documents_receipt_snapshot_required_check
    CHECK (document_type <> 'receipt' OR receipt_snapshot IS NOT NULL);

CREATE UNIQUE INDEX documents_receipt_payment_unique
  ON documents (payment_id)
  WHERE document_type = 'receipt';

CREATE UNIQUE INDEX documents_receipt_number_unique
  ON documents (document_number)
  WHERE document_type = 'receipt';

ALTER TABLE payments
  ADD COLUMN balance_after_payment NUMERIC(12, 2),
  ADD CONSTRAINT payments_balance_after_payment_nonnegative_check
    CHECK (balance_after_payment IS NULL OR balance_after_payment >= 0);
