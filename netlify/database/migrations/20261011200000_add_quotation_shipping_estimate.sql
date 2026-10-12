ALTER TABLE quotations
  ADD COLUMN shipping_estimate_snapshot JSONB
  CHECK (
    shipping_estimate_snapshot IS NULL
    OR jsonb_typeof(shipping_estimate_snapshot) = 'object'
  );

CREATE OR REPLACE FUNCTION enforce_quotation_immutability()
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
    NEW.shipping_estimate_snapshot IS DISTINCT FROM OLD.shipping_estimate_snapshot OR
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

COMMENT ON COLUMN quotations.shipping_estimate_snapshot IS
  'Validated pre-sale rate estimate selected for this Quotation version. Distinct from shipping_charge and later Delivery actual costs.';
