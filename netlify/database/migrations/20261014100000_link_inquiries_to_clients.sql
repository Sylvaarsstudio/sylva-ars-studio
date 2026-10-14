ALTER TABLE inquiries
  ADD COLUMN client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT;

CREATE INDEX inquiries_client_id_index
  ON inquiries (client_id)
  WHERE client_id IS NOT NULL;

COMMENT ON COLUMN inquiries.client_id IS
  'Canonical Client created or recovered when an accepted Inquiry is converted; NULL for unconverted and historical inquiries.';
