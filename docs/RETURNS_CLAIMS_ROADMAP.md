# Returns & Claims Roadmap

## Current workspace

- Returns & Claims records with editable dates, warehouse, RFC details, customer and invoice information.
- Reason, requested outcome, status, comments and supplier-received tracking.
- Search, status, company, reason and outcome filters.
- Side-panel creation and editing.
- Record deletion and saved attachments.
- Supabase record history displays actor names, timestamps, actions and changed-field summaries inside the record panel.
- Stored attachments display uploader names and upload dates, with inline image/PDF previews and downloads.
- Supported attachments: JPEG, PNG, GIF, WebP, PDF, Word (.doc/.docx), Excel (.xls/.xlsx). Maximum 10 per claim and 15 MB per file.
- Migration `0032_returns_attachment_details_limits.sql` adds a claim-scoped name lookup, Storage size/MIME limits, serialized attachment registration limits and attachment audit events.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Record validation and required-field guidance | Clear creation and update errors | In progress |
| 2 | Attachment preview and file management | Inline image/PDF previews, downloads, uploader/date and file limits | Implemented; saved-file removal remains deferred |
| 3 | Supplier outcome tracking | Capture credits, replacements and supplier responses | Planned |
| 4 | Customer and invoice search | Faster investigation of claims | Planned |
| 5 | Return ageing and SLA reporting | Identify overdue claims | Planned |
| 6 | Exports and audit history | Share and trace claim activity | Audit display implemented; exports planned |

## Acceptance direction

New records may be created before an outcome is known. Outcome Request remains unknown until selected, and every saved record can be edited later.

## Deployment and verification

Apply migrations through 0032 before deploying the updated frontend. No existing attachment rows are deleted or rewritten. Missing employee profiles are shown as Former employee. Attachment audit events apply to new uploads; earlier uploads retain their existing uploader and timestamp metadata.

Local checks: `npm.cmd run build` and `node --experimental-strip-types --test tests/returnsAttachments.test.mjs` from `frontend/`. The tests cover supported formats, rejected types, MIME mismatch, size boundaries and combined saved/pending counts. Database migration, concurrency and signed-link behavior still require verification against a Supabase test project:

- Open an existing record and confirm history, uploader names and dates appear.
- Preview an image and PDF inside the panel; download a document and check its filename.
- Save an edited record with stored files, reopen it and confirm metadata is preserved.
- Attempt an eleventh attachment, a file above 15 MB, and an unsupported file; each must be rejected.
- With nine files saved, attempt two concurrent uploads; only one attachment registration should succeed.
- Confirm signed-out users and users without administrator, management or returns roles cannot retrieve names or files.


## Wildcard search

Wildcard search is planned across RFC, customer, invoice, part number and other claim fields.
