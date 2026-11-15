# SAS-008 — Contract draft browser-storage hardening

## Pre-change audit

The Contract preparation page wrote one key to `sessionStorage`:

- Key: `sylvaArsDraftContractPreview`
- Writer: `web/js/admin-create-contract.js`, after a successful authenticated `GET /admin/api/contracts/prepare`
- Reader: `web/js/admin-contract.js`, on `/admin/contract.html?preview=1`
- Lifetime: the full JSON snapshot remained available for the browser-tab session; it was not removed after render, navigation, invalid data, or logout
- Purpose: move the prepared draft from the preparation page to the separate preview page and make refresh work without another server request

The stored JSON was a reconstructable Contract draft. Depending on the source version, it could contain:

- Direct PII: client full name, email, phone, and, for legacy Commission snapshots, postal address fields (`address_line_1`, `address_line_2`, `city`, `state`, `postal_code`, `country`).
- Sensitive commercial data: artwork title/description/medium/dimensions; price, tax rate and amount, shipping, total, required deposit, remaining balance estimate, completion date, accepted special terms, quotation and Commission numbers, acceptance date, snapshot hash, and the unsaved `optional_message` and `delivery_notes` fields.
- Identifiers: client, quotation, acceptance, and Commission record IDs.
- Non-sensitive structure: draft terms, studio business information, and manual-signature labels. No signature value or authentication secret was stored.

The authenticated server already owned the canonical accepted Quotation/Commission context, client data, financial values, business information, and draft terms. Only the chosen draft date plus the two optional document fields originated in the preparation form. The full snapshot was stored solely as a cross-page transport and was therefore unnecessary duplication.

No Contract-flow data was found in `localStorage`, IndexedDB, Cache Storage, cookies, analytics, DOM data attributes, or hidden fields other than the low-sensitivity hidden `quotation_id`. Existing `quotation_id`/`commission_id` query parameters were already used as authenticated Admin deep links. The unrelated `localStorage` artwork override feature in `web/js/admin.js` is outside SAS-008.

## Remediation

The preview no longer reads or writes browser storage.

1. The preparation page keeps only an in-memory descriptor containing one opaque source ID, the draft date, and the two unsaved document fields.
2. Opening the preview creates a cryptographically random, one-time UUID reference and opens a separate Admin preview tab. The URL is allowlisted to `preview`, exactly one of `quotation_id` or `commission_id`, `contract_date`, and the one-time `draft_ref`. Names, contact data, addresses, artwork details, prices, terms, and document fields are rejected from the URL.
3. The preview page re-fetches the canonical snapshot from the existing authenticated preparation endpoint. It never trusts the opener for client, artwork, quotation, financial, or terms data.
4. `optional_message` and `delivery_notes` are transferred once from the opener's memory, merged only for rendering, then removed from the preparation form and the one-time map. They are never written to storage or placed in the URL.
5. The one-time reference is removed from browser history immediately after success or failure. Refresh and Back/Forward therefore re-fetch the authorized server snapshot and cannot resurrect the transient fields.
6. Navigation away, logout, source/form changes, invalid parameters, stale server responses, and failed preview requests discard pending one-time contexts. The preparation form disables browser autocomplete and clears the two transient fields on `pagehide`.
7. The common Admin bootstrap removes the legacy `sylvaArsDraftContractPreview` key on every Admin page load and again on logout, including when browser storage access throws.

## Browser state after the fix

- `sessionStorage`: no Contract draft key or Contract data; the old key is removal-only.
- `localStorage` / IndexedDB / Cache Storage: no Contract data.
- URL/history: only an authenticated opaque record ID, draft date, and a short-lived random reference; the random reference is removed after use. No PII or commercial text is placed in the URL.
- Memory/DOM: the two unsaved document fields exist only while actively preparing or during the one-time handoff. All canonical draft content comes from the authenticated server response.

Contract issuance remains locked by `COMMISSION_AGREEMENT_TERMS.approved === false`; snapshot immutability, lifecycle rules, authentication, RBAC, payment logic, schema, and CSP are unchanged.
