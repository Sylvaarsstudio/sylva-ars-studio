CREATE TABLE legal_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_key TEXT NOT NULL
    CHECK (btrim(template_key) <> ''),
  name TEXT NOT NULL
    CHECK (btrim(name) <> ''),
  template_kind TEXT NOT NULL
    CHECK (btrim(template_kind) <> ''),
  description TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'archived')),
  created_by_admin_user_id BIGINT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT legal_templates_archive_state_check CHECK (
    (lifecycle_status = 'active' AND archived_at IS NULL)
    OR
    (lifecycle_status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX legal_templates_template_key_unique
  ON legal_templates (template_key);

CREATE TABLE legal_template_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id BIGINT NOT NULL
    REFERENCES legal_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'approved', 'effective', 'superseded', 'revoked')),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  content_schema_version INTEGER
    CHECK (content_schema_version IS NULL OR content_schema_version > 0),
  structured_content JSONB
    CHECK (structured_content IS NULL OR jsonb_typeof(structured_content) = 'object'),
  variable_manifest JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(variable_manifest) = 'object'),
  content_hash TEXT
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  version_label TEXT
    CHECK (version_label IS NULL OR btrim(version_label) <> ''),
  review_source TEXT
    CHECK (review_source IS NULL OR btrim(review_source) <> ''),
  legal_review_notes TEXT
    CHECK (legal_review_notes IS NULL OR btrim(legal_review_notes) <> ''),
  approved_by_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  revocation_reason TEXT,
  superseded_at TIMESTAMPTZ,
  created_by_admin_user_id BIGINT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT legal_template_versions_number_unique
    UNIQUE (template_id, version_number),
  CONSTRAINT legal_template_versions_id_template_unique
    UNIQUE (id, template_id),
  CONSTRAINT legal_template_versions_approval_pair_check CHECK (
    (approved_at IS NULL AND approved_by_admin_user_id IS NULL)
    OR
    (approved_at IS NOT NULL AND approved_by_admin_user_id IS NOT NULL)
  ),
  CONSTRAINT legal_template_versions_revocation_tuple_check CHECK (
    (
      revoked_at IS NULL
      AND revoked_by_admin_user_id IS NULL
      AND revocation_reason IS NULL
    )
    OR
    (
      revoked_at IS NOT NULL
      AND revoked_by_admin_user_id IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND btrim(revocation_reason) <> ''
    )
  ),
  CONSTRAINT legal_template_versions_state_timestamps_check CHECK (
    (
      state = 'draft'
      AND approved_at IS NULL
      AND approved_by_admin_user_id IS NULL
      AND effective_at IS NULL
      AND superseded_at IS NULL
      AND revoked_at IS NULL
      AND revoked_by_admin_user_id IS NULL
      AND revocation_reason IS NULL
    )
    OR
    (
      state = 'approved'
      AND approved_at IS NOT NULL
      AND approved_by_admin_user_id IS NOT NULL
      AND effective_at IS NULL
      AND superseded_at IS NULL
      AND revoked_at IS NULL
      AND revoked_by_admin_user_id IS NULL
      AND revocation_reason IS NULL
    )
    OR
    (
      state = 'effective'
      AND approved_at IS NOT NULL
      AND approved_by_admin_user_id IS NOT NULL
      AND effective_at IS NOT NULL
      AND effective_at >= approved_at
      AND superseded_at IS NULL
      AND revoked_at IS NULL
      AND revoked_by_admin_user_id IS NULL
      AND revocation_reason IS NULL
    )
    OR
    (
      state = 'superseded'
      AND approved_at IS NOT NULL
      AND approved_by_admin_user_id IS NOT NULL
      AND effective_at IS NOT NULL
      AND effective_at >= approved_at
      AND superseded_at IS NOT NULL
      AND superseded_at >= effective_at
      AND revoked_at IS NULL
      AND revoked_by_admin_user_id IS NULL
      AND revocation_reason IS NULL
    )
    OR
    (
      state = 'revoked'
      AND approved_at IS NOT NULL
      AND approved_by_admin_user_id IS NOT NULL
      AND effective_at IS NOT NULL
      AND effective_at >= approved_at
      AND superseded_at IS NULL
      AND revoked_at IS NOT NULL
      AND revoked_at >= effective_at
      AND revoked_by_admin_user_id IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND btrim(revocation_reason) <> ''
    )
  )
);

CREATE UNIQUE INDEX legal_template_versions_one_effective_per_template
  ON legal_template_versions (template_id)
  WHERE state = 'effective';

CREATE INDEX legal_template_versions_template_created_index
  ON legal_template_versions (template_id, created_at DESC, id DESC);

CREATE FUNCTION enforce_legal_template_key_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.template_key IS DISTINCT FROM OLD.template_key
    AND EXISTS (
      SELECT 1
      FROM legal_template_versions
      WHERE template_id = OLD.id
    )
  THEN
    RAISE EXCEPTION 'Legal Template key is immutable after its first version exists.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_templates_key_immutability_trigger
BEFORE UPDATE ON legal_templates
FOR EACH ROW EXECUTE FUNCTION enforce_legal_template_key_immutability();

CREATE FUNCTION enforce_legal_template_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'Approved Legal Template versions cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.template_id IS DISTINCT FROM OLD.template_id
    OR NEW.version_number IS DISTINCT FROM OLD.version_number
    OR NEW.created_by_admin_user_id IS DISTINCT FROM OLD.created_by_admin_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Legal Template version identity is immutable.';
  END IF;

  IF NOT (
    (OLD.state = 'draft' AND NEW.state IN ('draft', 'approved'))
    OR (OLD.state = 'approved' AND NEW.state IN ('approved', 'effective'))
    OR (OLD.state = 'effective' AND NEW.state IN ('effective', 'superseded', 'revoked'))
    OR (OLD.state = 'superseded' AND NEW.state = 'superseded')
    OR (OLD.state = 'revoked' AND NEW.state = 'revoked')
  ) THEN
    RAISE EXCEPTION 'Invalid Legal Template version lifecycle transition from % to %.',
      OLD.state, NEW.state;
  END IF;

  IF OLD.state <> 'draft' AND (
    NEW.draft_revision IS DISTINCT FROM OLD.draft_revision
    OR NEW.content_schema_version IS DISTINCT FROM OLD.content_schema_version
    OR NEW.structured_content IS DISTINCT FROM OLD.structured_content
    OR NEW.variable_manifest IS DISTINCT FROM OLD.variable_manifest
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.version_label IS DISTINCT FROM OLD.version_label
    OR NEW.review_source IS DISTINCT FROM OLD.review_source
    OR NEW.legal_review_notes IS DISTINCT FROM OLD.legal_review_notes
    OR NEW.approved_by_admin_user_id IS DISTINCT FROM OLD.approved_by_admin_user_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR (
      OLD.state IN ('effective', 'superseded', 'revoked')
      AND NEW.effective_at IS DISTINCT FROM OLD.effective_at
    )
  ) THEN
    RAISE EXCEPTION 'Approved Legal Template version content is immutable.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_template_versions_mutation_trigger
BEFORE UPDATE OR DELETE ON legal_template_versions
FOR EACH ROW EXECUTE FUNCTION enforce_legal_template_version_mutation();

CREATE TABLE legal_template_assets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_version_id BIGINT NOT NULL
    REFERENCES legal_template_versions(id) ON DELETE RESTRICT,
  asset_role TEXT NOT NULL CHECK (btrim(asset_role) <> ''),
  storage_provider TEXT
    CHECK (storage_provider IS NULL OR btrim(storage_provider) <> ''),
  storage_key TEXT NOT NULL CHECK (btrim(storage_key) <> ''),
  original_filename TEXT NOT NULL CHECK (btrim(original_filename) <> ''),
  mime_type TEXT NOT NULL CHECK (btrim(mime_type) <> ''),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status TEXT NOT NULL DEFAULT 'quarantined'
    CHECK (scan_status IN ('quarantined', 'scanning', 'clean', 'rejected', 'locked')),
  uploaded_by_admin_user_id BIGINT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  CONSTRAINT legal_template_assets_lock_state_check CHECK (
    (scan_status = 'locked' AND locked_at IS NOT NULL)
    OR
    (scan_status <> 'locked' AND locked_at IS NULL)
  )
);

CREATE INDEX legal_template_assets_version_index
  ON legal_template_assets (template_version_id, uploaded_at, id);

CREATE FUNCTION enforce_legal_template_asset_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state TEXT;
  target_version_id BIGINT;
BEGIN
  target_version_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.template_version_id ELSE NEW.template_version_id END;

  SELECT state INTO parent_state
  FROM legal_template_versions
  WHERE id = target_version_id
  FOR SHARE;

  IF parent_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Assets for approved Legal Template versions are immutable.';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
  THEN
    SELECT state INTO parent_state
    FROM legal_template_versions
    WHERE id = OLD.template_version_id
    FOR SHARE;

    IF parent_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Assets for approved Legal Template versions are immutable.';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER legal_template_assets_mutation_trigger
BEFORE INSERT OR UPDATE OR DELETE ON legal_template_assets
FOR EACH ROW EXECUTE FUNCTION enforce_legal_template_asset_mutation();

CREATE TABLE legal_template_publications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_version_id BIGINT NOT NULL
    REFERENCES legal_template_versions(id) ON DELETE RESTRICT,
  public_slug TEXT NOT NULL CHECK (btrim(public_slug) <> ''),
  publication_mode TEXT NOT NULL
    CHECK (publication_mode IN ('public_preview', 'public_canonical')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unpublished_at TIMESTAMPTZ,
  published_by_admin_user_id BIGINT NOT NULL
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  unpublished_by_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  reason TEXT CHECK (reason IS NULL OR btrim(reason) <> ''),
  CONSTRAINT legal_template_publications_unpublished_tuple_check CHECK (
    (
      unpublished_at IS NULL
      AND unpublished_by_admin_user_id IS NULL
    )
    OR
    (
      unpublished_at IS NOT NULL
      AND unpublished_by_admin_user_id IS NOT NULL
      AND unpublished_at >= published_at
    )
  )
);

CREATE UNIQUE INDEX legal_template_publications_active_slug_unique
  ON legal_template_publications (lower(public_slug))
  WHERE unpublished_at IS NULL;

CREATE INDEX legal_template_publications_version_index
  ON legal_template_publications (template_version_id, published_at DESC, id DESC);

CREATE FUNCTION enforce_legal_template_publication()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Legal Template publication history cannot be deleted.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.unpublished_at IS NOT NULL THEN
      RAISE EXCEPTION 'Closed Legal Template publications are immutable.';
    END IF;

    IF NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
      OR NEW.public_slug IS DISTINCT FROM OLD.public_slug
      OR NEW.publication_mode IS DISTINCT FROM OLD.publication_mode
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by_admin_user_id IS DISTINCT FROM OLD.published_by_admin_user_id
      OR NEW.unpublished_at IS NULL
    THEN
      RAISE EXCEPTION 'Legal Template publications may only be closed, not replaced.';
    END IF;
  END IF;

  IF NEW.publication_mode = 'public_canonical'
    AND NEW.unpublished_at IS NULL
  THEN
    SELECT state INTO parent_state
    FROM legal_template_versions
    WHERE id = NEW.template_version_id
    FOR SHARE;

    IF parent_state IS DISTINCT FROM 'effective' THEN
      RAISE EXCEPTION 'An active canonical publication requires an Effective Legal Template version.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_template_publications_history_trigger
BEFORE INSERT OR UPDATE OR DELETE ON legal_template_publications
FOR EACH ROW EXECUTE FUNCTION enforce_legal_template_publication();

CREATE FUNCTION enforce_canonical_publication_effectivity_on_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'effective'
    AND NEW.state <> 'effective'
    AND EXISTS (
      SELECT 1
      FROM legal_template_publications
      WHERE template_version_id = OLD.id
        AND publication_mode = 'public_canonical'
        AND unpublished_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'Close active canonical publications before leaving the Effective state.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_template_versions_canonical_publication_trigger
BEFORE UPDATE OF state ON legal_template_versions
FOR EACH ROW EXECUTE FUNCTION enforce_canonical_publication_effectivity_on_version();

ALTER TABLE documents
  ADD COLUMN legal_template_id BIGINT,
  ADD COLUMN legal_template_version_id BIGINT,
  ADD COLUMN document_origin TEXT,
  ADD COLUMN snapshot_hash TEXT,
  ADD COLUMN issued_by_admin_user_id BIGINT,
  ADD COLUMN issued_at TIMESTAMPTZ,
  ADD COLUMN finalized_at TIMESTAMPTZ,
  ADD CONSTRAINT documents_legal_template_fkey
    FOREIGN KEY (legal_template_id)
    REFERENCES legal_templates(id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_legal_template_version_pair_fkey
    FOREIGN KEY (legal_template_version_id, legal_template_id)
    REFERENCES legal_template_versions(id, template_id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_issued_by_admin_user_fkey
    FOREIGN KEY (issued_by_admin_user_id)
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT documents_legal_provenance_check CHECK (
    (
      document_origin IS NULL
      AND legal_template_id IS NULL
      AND legal_template_version_id IS NULL
    )
    OR
    (
      document_origin = 'template'
      AND legal_template_id IS NOT NULL
      AND legal_template_version_id IS NOT NULL
    )
    OR
    (
      document_origin IN ('uploaded_pdf', 'bespoke_structured')
      AND legal_template_id IS NULL
      AND legal_template_version_id IS NULL
    )
  ),
  ADD CONSTRAINT documents_snapshot_hash_check
    CHECK (snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT documents_finalization_order_check
    CHECK (finalized_at IS NULL OR issued_at IS NULL OR finalized_at >= issued_at);

CREATE INDEX documents_legal_template_version_index
  ON documents (legal_template_version_id)
  WHERE legal_template_version_id IS NOT NULL;

CREATE FUNCTION is_legal_document_locked(document_key BIGINT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE((
    SELECT
      issued_at IS NOT NULL
      OR finalized_at IS NOT NULL
      OR (
        document_type = 'contract'
        AND document_snapshot -> 'contract' ->> 'status' = 'issued'
      )
    FROM documents
    WHERE id = document_key
  ), FALSE);
$$;

CREATE TABLE document_assets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL
    REFERENCES documents(id) ON DELETE RESTRICT,
  asset_role TEXT NOT NULL CHECK (btrim(asset_role) <> ''),
  storage_provider TEXT
    CHECK (storage_provider IS NULL OR btrim(storage_provider) <> ''),
  storage_key TEXT NOT NULL CHECK (btrim(storage_key) <> ''),
  mime_type TEXT NOT NULL CHECK (btrim(mime_type) <> ''),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  scan_status TEXT NOT NULL DEFAULT 'quarantined'
    CHECK (scan_status IN ('quarantined', 'scanning', 'clean', 'rejected', 'locked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ,
  CONSTRAINT document_assets_availability_order_check
    CHECK (available_at IS NULL OR available_at >= created_at)
);

CREATE INDEX document_assets_document_created_index
  ON document_assets (document_id, created_at, id);

CREATE FUNCTION enforce_document_asset_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_document_id BIGINT;
BEGIN
  parent_document_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.document_id ELSE NEW.document_id END;

  PERFORM 1 FROM documents WHERE id = parent_document_id FOR SHARE;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document asset metadata is append-only.';
  END IF;

  IF is_legal_document_locked(parent_document_id) THEN
    RAISE EXCEPTION 'Assets cannot be added to or changed on an issued or finalized Document.';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.asset_role IS DISTINCT FROM OLD.asset_role
    OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Document asset identity metadata is append-only.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER document_assets_mutation_trigger
BEFORE INSERT OR UPDATE OR DELETE ON document_assets
FOR EACH ROW EXECUTE FUNCTION enforce_document_asset_mutation();

CREATE TABLE document_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id BIGINT NOT NULL
    REFERENCES documents(id) ON DELETE RESTRICT,
  relationship_role TEXT NOT NULL CHECK (btrim(relationship_role) <> ''),
  client_id BIGINT REFERENCES clients(id) ON DELETE RESTRICT,
  quotation_id BIGINT REFERENCES quotations(id) ON DELETE RESTRICT,
  contract_document_id BIGINT REFERENCES documents(id) ON DELETE RESTRICT,
  commission_id BIGINT REFERENCES commissions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_assignments_exactly_one_subject_check CHECK (
    num_nonnulls(client_id, quotation_id, contract_document_id, commission_id) = 1
  ),
  CONSTRAINT document_assignments_no_self_contract_check CHECK (
    contract_document_id IS NULL OR contract_document_id <> document_id
  )
);

CREATE INDEX document_assignments_document_index
  ON document_assignments (document_id, created_at, id);

CREATE INDEX document_assignments_client_index
  ON document_assignments (client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX document_assignments_quotation_index
  ON document_assignments (quotation_id)
  WHERE quotation_id IS NOT NULL;

CREATE INDEX document_assignments_contract_document_index
  ON document_assignments (contract_document_id)
  WHERE contract_document_id IS NOT NULL;

CREATE INDEX document_assignments_commission_index
  ON document_assignments (commission_id)
  WHERE commission_id IS NOT NULL;

CREATE FUNCTION enforce_document_assignment_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_document_id BIGINT;
  subject_document_type TEXT;
BEGIN
  parent_document_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.document_id ELSE NEW.document_id END;

  PERFORM 1 FROM documents WHERE id = parent_document_id FOR SHARE;

  IF is_legal_document_locked(parent_document_id) THEN
    RAISE EXCEPTION 'Assignments for issued or finalized Documents are immutable.';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    PERFORM 1 FROM documents WHERE id = OLD.document_id FOR SHARE;
    IF is_legal_document_locked(OLD.document_id) THEN
      RAISE EXCEPTION 'Assignments for issued or finalized Documents are immutable.';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.contract_document_id IS NOT NULL THEN
    SELECT document_type INTO subject_document_type
    FROM documents
    WHERE id = NEW.contract_document_id;

    IF subject_document_type IS DISTINCT FROM 'contract' THEN
      RAISE EXCEPTION 'contract_document_id must reference a Contract Document.';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER document_assignments_mutation_trigger
BEFORE INSERT OR UPDATE OR DELETE ON document_assignments
FOR EACH ROW EXECUTE FUNCTION enforce_document_assignment_mutation();

CREATE TABLE document_packet_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  root_contract_document_id BIGINT NOT NULL
    REFERENCES documents(id) ON DELETE RESTRICT,
  document_id BIGINT NOT NULL
    REFERENCES documents(id) ON DELETE RESTRICT,
  packet_role TEXT NOT NULL CHECK (btrim(packet_role) <> ''),
  position INTEGER NOT NULL CHECK (position > 0),
  required_for_acceptance BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_packet_items_position_unique
    UNIQUE (root_contract_document_id, position),
  CONSTRAINT document_packet_items_document_unique
    UNIQUE (root_contract_document_id, document_id),
  CONSTRAINT document_packet_items_no_self_reference_check
    CHECK (root_contract_document_id <> document_id)
);

CREATE INDEX document_packet_items_document_index
  ON document_packet_items (document_id);

CREATE FUNCTION enforce_document_packet_item_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  root_document_id BIGINT;
  root_document_type TEXT;
BEGIN
  root_document_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD.root_contract_document_id ELSE NEW.root_contract_document_id END;

  SELECT document_type INTO root_document_type
  FROM documents
  WHERE id = root_document_id
  FOR SHARE;

  IF root_document_type IS DISTINCT FROM 'contract' THEN
    RAISE EXCEPTION 'Packet root must reference a Contract Document.';
  END IF;

  IF is_legal_document_locked(root_document_id) THEN
    RAISE EXCEPTION 'Packet structure is immutable after the root Contract is issued or finalized.';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.root_contract_document_id IS DISTINCT FROM OLD.root_contract_document_id
  THEN
    PERFORM 1 FROM documents WHERE id = OLD.root_contract_document_id FOR SHARE;
    IF is_legal_document_locked(OLD.root_contract_document_id) THEN
      RAISE EXCEPTION 'Packet structure is immutable after the root Contract is issued or finalized.';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER document_packet_items_mutation_trigger
BEFORE INSERT OR UPDATE OR DELETE ON document_packet_items
FOR EACH ROW EXECUTE FUNCTION enforce_document_packet_item_mutation();

CREATE TABLE legal_audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  actor_admin_user_id BIGINT
    REFERENCES admin_users(id) ON DELETE RESTRICT,
  actor_role_snapshot TEXT
    CHECK (actor_role_snapshot IS NULL OR btrim(actor_role_snapshot) <> ''),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  template_id BIGINT
    REFERENCES legal_templates(id) ON DELETE RESTRICT,
  template_version_id BIGINT,
  document_id BIGINT
    REFERENCES documents(id) ON DELETE RESTRICT,
  publication_id BIGINT
    REFERENCES legal_template_publications(id) ON DELETE RESTRICT,
  previous_state JSONB
    CHECK (previous_state IS NULL OR jsonb_typeof(previous_state) = 'object'),
  new_state JSONB
    CHECK (new_state IS NULL OR jsonb_typeof(new_state) = 'object'),
  event_context JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(event_context) = 'object'),
  content_hash TEXT
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  request_id UUID,
  reason TEXT CHECK (reason IS NULL OR btrim(reason) <> ''),
  CONSTRAINT legal_audit_events_version_requires_template_check CHECK (
    template_version_id IS NULL OR template_id IS NOT NULL
  ),
  CONSTRAINT legal_audit_events_template_version_pair_fkey
    FOREIGN KEY (template_version_id, template_id)
    REFERENCES legal_template_versions(id, template_id) ON DELETE RESTRICT
);

CREATE INDEX legal_audit_events_template_occurred_index
  ON legal_audit_events (template_id, occurred_at DESC, id DESC)
  WHERE template_id IS NOT NULL;

CREATE INDEX legal_audit_events_version_occurred_index
  ON legal_audit_events (template_version_id, occurred_at DESC, id DESC)
  WHERE template_version_id IS NOT NULL;

CREATE INDEX legal_audit_events_document_occurred_index
  ON legal_audit_events (document_id, occurred_at DESC, id DESC)
  WHERE document_id IS NOT NULL;

CREATE INDEX legal_audit_events_publication_index
  ON legal_audit_events (publication_id)
  WHERE publication_id IS NOT NULL;

CREATE INDEX legal_audit_events_request_index
  ON legal_audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE FUNCTION prevent_legal_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Legal audit event records are append-only and immutable.';
END;
$$;

CREATE TRIGGER legal_audit_events_append_only_trigger
BEFORE UPDATE OR DELETE ON legal_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_legal_audit_event_mutation();

COMMENT ON TABLE legal_templates IS
  'Stable Legal Templates families governed independently from issued Documents.';

COMMENT ON TABLE legal_template_assets IS
  'Provider-neutral metadata only. LT-1 creates no storage, upload, URL, or malware-scanning integration.';

COMMENT ON COLUMN documents.document_snapshot IS
  'Authoritative issued-document snapshot. Legal Template provenance columns do not replace it.';

COMMENT ON TABLE legal_audit_events IS
  'Append-only legal governance audit. Payloads must contain metadata and state only, never sensitive document content.';
