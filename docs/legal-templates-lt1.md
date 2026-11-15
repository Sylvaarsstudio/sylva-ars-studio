# Legal Templates LT-1 foundation

LT-1 is schema and audit foundation only. It adds no Legal Templates routes, UI,
navigation, upload pipeline, storage integration, malware-scanning integration,
role, capability, legacy import, or issuance behavior.

## Integrity decisions

- `documents.document_snapshot` remains the authoritative issued snapshot.
- A Document with `document_origin = 'template'` must carry both the Template ID
  and version ID. A composite foreign key proves that the version belongs to that
  Template. Other origins cannot claim Template provenance.
- Legal Template version identity is immutable. Draft content may change; approval
  freezes governed content and all attached Template asset metadata.
- Lifecycle transitions are monotonic: Draft → Approved → Effective → Superseded
  or Revoked. Static checks require the corresponding actor/timestamp evidence.
- An active canonical publication requires an Effective version. It must be closed
  before that version can become Superseded or Revoked.
- `legal_audit_events` is append-only. Asset references use `event_context` with an
  explicit table/type discriminator instead of an ambiguous polymorphic `asset_id`.
- Assignment and packet locking recognizes the new `issued_at`/`finalized_at`
  columns and the existing issued-Contract snapshot state. No historical row is
  backfilled or inferred.
- Document asset identity fields are append-only. Scan/availability lifecycle
  metadata may change only before the parent Document is issued or finalized.

## Deliberately deferred

- No constraint for a scheduled Approved version was added. The repository has no
  approved scheduling semantics yet, so LT-1 does not invent the meaning of a
  future `effective_at` on an Approved row.
- No optimistic-lock column was added. The existing schema has no shared generic
  optimistic-lock convention; Draft editing behavior belongs to a later phase.
- Storage provider values remain opaque metadata. Provider selection, object
  storage, scanning, signed access, and upload behavior remain deferred until the
  post-LT-2 decision checkpoint.

## Rollback boundary

The migration is additive, but rollback is safe only when all LT-1 tables are
empty and every new `documents` provenance/finalization column is still `NULL`.
Once any Legal Template version, publication, audit event, assignment, packet, or
asset exists, those rows are governed legal history and must not be silently
dropped.

For an empty LT-1 installation, a forward corrective migration may remove, in
dependency order, the LT-1 triggers/functions, audit and relationship tables,
publication and asset tables, Document constraints/indexes/columns, version table,
and Template table. Production rollback should use such a reviewed migration; it
should not edit the already-recorded migration or manually delete governed rows.
