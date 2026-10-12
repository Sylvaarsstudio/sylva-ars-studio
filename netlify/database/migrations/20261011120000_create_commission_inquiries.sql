CREATE TABLE commission_inquiries (
  commission_id BIGINT NOT NULL
    REFERENCES commissions(id) ON DELETE RESTRICT,
  inquiry_id UUID NOT NULL
    REFERENCES inquiries(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL DEFAULT 'origin'
    CHECK (relationship_type IN ('origin', 'supporting')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (commission_id, inquiry_id)
);

CREATE INDEX commission_inquiries_inquiry_id_index
  ON commission_inquiries (inquiry_id);
