CREATE TABLE commission_obligations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL
    REFERENCES commissions(id) ON DELETE RESTRICT,
  obligation_type TEXT NOT NULL
    CHECK (obligation_type IN (
      'deposit',
      'final_balance',
      'modification_charge',
      'storage_fee',
      'shipping_adjustment',
      'protection_charge',
      'other'
    )),
  obligation_status TEXT NOT NULL DEFAULT 'open'
    CHECK (obligation_status IN ('open', 'satisfied', 'waived', 'voided')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  due_at TIMESTAMPTZ,
  source_type TEXT,
  source_id TEXT,
  description TEXT CHECK (description IS NULL OR btrim(description) <> ''),
  satisfied_at TIMESTAMPTZ,
  waived_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (source_type IS NULL AND source_id IS NULL)
    OR
    (source_type IS NOT NULL AND source_id IS NOT NULL AND btrim(source_id) <> '')
  ),
  CHECK (
    (obligation_status = 'open'
      AND satisfied_at IS NULL AND waived_at IS NULL AND voided_at IS NULL)
    OR
    (obligation_status = 'satisfied'
      AND satisfied_at IS NOT NULL AND waived_at IS NULL AND voided_at IS NULL)
    OR
    (obligation_status = 'waived'
      AND satisfied_at IS NULL AND waived_at IS NOT NULL AND voided_at IS NULL)
    OR
    (obligation_status = 'voided'
      AND satisfied_at IS NULL AND waived_at IS NULL AND voided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX commission_obligations_request_id_unique
  ON commission_obligations (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX commission_obligations_commission_status_index
  ON commission_obligations (commission_id, obligation_status, created_at DESC);

CREATE TABLE payment_allocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id BIGINT NOT NULL
    REFERENCES payments(id) ON DELETE RESTRICT,
  obligation_id BIGINT NOT NULL
    REFERENCES commission_obligations(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX payment_allocations_payment_id_index
  ON payment_allocations (payment_id);

CREATE INDEX payment_allocations_obligation_id_index
  ON payment_allocations (obligation_id);

COMMENT ON TABLE commission_obligations IS
  'Canonical future record of amounts a Client owes SAS. Existing rows are not inferred from legacy Commission financial fields.';

COMMENT ON TABLE payment_allocations IS
  'Links money actually received in payments to canonical Commission obligations.';

COMMENT ON COLUMN commissions.deposit_amount IS
  'Legacy aggregate: initial deposit actually received. Not a canonical obligation.';

COMMENT ON COLUMN commissions.amount_paid IS
  'Total accumulated gross money actually received. Legacy aggregate retained for compatibility; Payments remain the received-money source of truth.';

COMMENT ON COLUMN commissions.balance IS
  'Legacy generated balance retained for compatibility. Not the canonical future outstanding-obligation total.';
