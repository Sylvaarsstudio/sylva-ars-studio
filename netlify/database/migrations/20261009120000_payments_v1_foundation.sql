ALTER TABLE commissions
  ADD COLUMN amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0
    CHECK (amount_paid >= 0);

UPDATE commissions
SET amount_paid = deposit_amount;

ALTER TABLE commissions
  ADD CONSTRAINT commissions_amount_paid_not_above_total_check
    CHECK (amount_paid <= price + sales_tax + shipping);

ALTER TABLE commissions
  DROP COLUMN balance;

ALTER TABLE commissions
  ADD COLUMN balance NUMERIC(12, 2) GENERATED ALWAYS AS (
    price + sales_tax + shipping - amount_paid
  ) STORED;

ALTER TABLE payments
  ADD COLUMN request_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN external_reference TEXT,
  ADD COLUMN notes TEXT;

ALTER TABLE payments
  ADD CONSTRAINT payments_request_id_unique UNIQUE (request_id);

COMMENT ON COLUMN commissions.deposit_amount IS
  'Initial deposit actually received.';

COMMENT ON COLUMN commissions.amount_paid IS
  'Total accumulated gross money actually received for the commission.';

COMMENT ON COLUMN payments.request_id IS
  'Idempotency key. A retried payment request must reuse the same request_id.';

COMMENT ON COLUMN payments.amount IS
  'Gross money actually received. Any payment sales_tax is included in this amount.';

COMMENT ON COLUMN payments.sales_tax IS
  'Informational portion of payment amount attributable to sales tax; never added to amount.';
