CREATE TABLE inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_submission_id TEXT UNIQUE,
  form_type TEXT NOT NULL
    CHECK (form_type IN (
      'contact',
      'artwork_inquiry',
      'commission_request',
      'collaboration'
    )),
  client_name TEXT NOT NULL CHECK (btrim(client_name) <> ''),
  client_email TEXT NOT NULL CHECK (btrim(client_email) <> ''),
  client_phone TEXT,
  artwork_title TEXT,
  artwork_subject TEXT,
  artwork_size TEXT,
  budget_range TEXT,
  estimated_date TEXT
    CHECK (
      estimated_date IS NULL
      OR estimated_date IN (
        'flexible',
        'within_1_month',
        'within_2_months',
        'within_3_months'
      )
    ),
  occasion TEXT
    CHECK (
      occasion IS NULL
      OR occasion IN (
        'birthday',
        'valentines_day',
        'mothers_day',
        'fathers_day',
        'graduation',
        'wedding_anniversary',
        'halloween',
        'thanksgiving',
        'christmas_holiday',
        'national_holiday',
        'other'
      )
    ),
  shipping_location TEXT,
  preferred_contact_method TEXT,
  reference_notes TEXT,
  organization_project TEXT,
  collaboration_type TEXT,
  message TEXT NOT NULL CHECK (btrim(message) <> ''),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new',
      'reviewing',
      'replied',
      'accepted',
      'declined',
      'closed'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inquiries_form_type_index
  ON inquiries (form_type);

CREATE INDEX inquiries_status_index
  ON inquiries (status);

CREATE INDEX inquiries_client_email_index
  ON inquiries (client_email);

CREATE INDEX inquiries_created_at_index
  ON inquiries (created_at);
