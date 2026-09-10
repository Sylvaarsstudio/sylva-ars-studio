CREATE TABLE clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (btrim(full_name) <> ''),
  email TEXT NOT NULL CHECK (btrim(email) <> ''),
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX clients_email_unique
  ON clients (lower(email));

CREATE TABLE commissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_number TEXT NOT NULL UNIQUE
    CHECK (commission_number ~ '^SAS-COM-[0-9]{4}-[0-9]{4,}$'),
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  medium TEXT NOT NULL CHECK (btrim(medium) <> ''),
  width NUMERIC(10, 2) CHECK (width > 0),
  height NUMERIC(10, 2) CHECK (height > 0),
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  deposit_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  sales_tax NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (sales_tax >= 0),
  shipping NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  balance NUMERIC(12, 2) GENERATED ALWAYS AS (
    price + sales_tax + shipping - deposit_amount
  ) STORED,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'quoted',
      'approved',
      'in_progress',
      'completed',
      'cancelled'
    )),
  estimated_completion DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (deposit_amount <= price + sales_tax + shipping)
);

CREATE INDEX commissions_client_id_index
  ON commissions (client_id);

CREATE TABLE payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  payment_type TEXT NOT NULL
    CHECK (payment_type IN ('deposit', 'installment', 'balance', 'refund', 'adjustment')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  sales_tax NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (sales_tax >= 0),
  payment_method TEXT,
  payment_date DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'refunded', 'void'))
);

CREATE INDEX payments_commission_id_index
  ON payments (commission_id);

CREATE TABLE documents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commission_id BIGINT NOT NULL REFERENCES commissions(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL
    CHECK (document_type IN ('contract', 'invoice', 'coa')),
  document_number TEXT NOT NULL CHECK (btrim(document_number) <> ''),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  file_location TEXT NOT NULL CHECK (btrim(file_location) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_number, version)
);

CREATE INDEX documents_commission_id_index
  ON documents (commission_id);
