# Legal Templates LT-2 read-only registry

LT-2 adds a protected, read-only registry under Admin → Documents. It does not
add any Legal Template write route, editor, approval/effectivity operation,
publication route, upload, storage provider, scanner, issuance behavior, or role.

## Deterministic import

`npm run import:legal-templates:lt2` performs the explicit production import.
It requires exactly one active Owner Admin, or an exact active Owner Admin can be
selected with `LT2_IMPORT_ACTOR_SUBJECT`. The actor is required by the LT-1
creator foreign keys; audit metadata additionally records that this was a system
import operation.

The import:

- validates every source against its pinned SHA-256 before opening a transaction;
- takes a transaction-scoped advisory lock;
- uses stable Template keys, version numbers, and source identities;
- no-ops when the same source identity and hash already exist;
- stops on a mismatch rather than overwriting an existing Draft;
- records only Draft versions and creates no assets or publications;
- creates append-only `template_created_from_legacy`,
  `version_imported_from_legacy`, and `legacy_source_hash_recorded` events;
- never writes to existing `documents` rows.

No import runs as a side effect of a GET request. Because this phase makes no
schema change, the import is traceable and rerunnable but intentionally has no
automatic destructive rollback. Imported rows are legal inventory history and
must not be silently deleted.

## Governed inventory families

- `commission-agreement`
  - code-defined `COMMISSION_AGREEMENT_TERMS` (`draft-1`) as a legacy candidate;
  - protected Admin Commission Agreement HTML as a separate legacy candidate;
  - public static Commission Agreement HTML as a separate legacy reference;
  - equivalence is explicitly `not_established`; no source is declared canonical.
- `artwork-sales-agreement`
  - protected Admin Artwork Sales Agreement HTML as a legacy candidate;
  - public static Artwork Sales Agreement HTML as a legacy reference;
  - public availability does not establish approval or effectivity.

The Admin Invoice template, Admin COA template, legacy browser generator, and
public view generator are reported in the read-only operational inventory as
`not_governed`. Invoice and COA do not become Legal Template families in LT-2.

Existing Contract Documents are related only when the LT-1 composite provenance
is present. Matching pre-LT-1 Contract snapshots remain `legacy_unmapped`; LT-2
does not backfill or infer governed provenance.
