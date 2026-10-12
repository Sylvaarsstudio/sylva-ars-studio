CREATE TABLE deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL UNIQUE
    REFERENCES commissions(id) ON DELETE RESTRICT,
  delivery_method TEXT NOT NULL
    CHECK (delivery_method IN ('pickup', 'shipping')),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN (
      'pending',
      'ready',
      'scheduled',
      'shipped',
      'delivered',
      'picked_up',
      'in_storage',
      'cancelled'
    )),
  recipient_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state_region TEXT,
  postal_code TEXT,
  country TEXT,
  carrier TEXT,
  service_level TEXT,
  tracking_number TEXT,
  actual_shipping_cost NUMERIC(12, 2)
    CHECK (actual_shipping_cost IS NULL OR actual_shipping_cost >= 0),
  protection_cost NUMERIC(12, 2)
    CHECK (protection_cost IS NULL OR protection_cost >= 0),
  ready_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  storage_start_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX deliveries_status_index
  ON deliveries (delivery_status);

COMMENT ON TABLE deliveries IS
  'Canonical Delivery/Fulfillment record. Existing Commissions are not backfilled and no Delivery is inferred from commercial shipping charges or lifecycle states.';

COMMENT ON COLUMN deliveries.actual_shipping_cost IS
  'Actual fulfillment shipping cost to SAS; distinct from any shipping charge billed to the Client.';

COMMENT ON COLUMN deliveries.protection_cost IS
  'Actual carrier protection or insurance cost to SAS; not a Client charge or obligation by itself.';
