ALTER TABLE documents
  ADD COLUMN document_snapshot JSONB,
  ADD COLUMN request_id UUID;

ALTER TABLE documents
  ADD CONSTRAINT documents_invoice_snapshot_required_check
    CHECK (document_type <> 'invoice' OR document_snapshot IS NOT NULL),
  ADD CONSTRAINT documents_invoice_snapshot_object_check
    CHECK (
      document_type <> 'invoice'
      OR jsonb_typeof(document_snapshot) = 'object'
    );

CREATE UNIQUE INDEX documents_request_id_unique
  ON documents (request_id)
  WHERE request_id IS NOT NULL;

COMMENT ON COLUMN documents.document_snapshot IS
  'Immutable historical snapshot for persistent documents other than receipts, beginning with final invoices.';

COMMENT ON COLUMN documents.request_id IS
  'Optional idempotency key for persistent document creation requests.';

COMMENT ON CONSTRAINT documents_receipt_snapshot_required_check ON documents IS
  'A receipt is proof of a completed payment made while the commission still has an outstanding balance.';

COMMENT ON CONSTRAINT documents_invoice_snapshot_required_check ON documents IS
  'A final invoice is the immutable closing financial document created when a completed payment reduces the commission balance to zero.';
