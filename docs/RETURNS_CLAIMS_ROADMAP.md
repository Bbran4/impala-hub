# Returns & Claims Roadmap

## Current workspace

- Returns & Claims records with editable dates, warehouse, RFC details, customer and invoice information.
- Reason, requested outcome, status, comments and supplier-received tracking.
- Search, status, company, reason and outcome filters.
- Side-panel creation and editing.
- Record deletion and saved attachments.
- Supabase record history displays actor names, timestamps, actions and changed-field summaries inside the record panel.
- Stored attachments display uploader names and upload dates. Images open in a new browser tab; PDFs have inline previews; all supported formats have download controls.
- References follow `RCYYYYMMDDNN`, for example `RC2026102601`. New numbers use the Johannesburg creation date, restart at 01 daily, and support more than 99 records per day. Existing records receive references ordered by creation time while retaining their UUID keys.
- Saved claim and RFQ attachments can be permanently removed from Storage and their metadata tables, with a confirmation and retained audit event.
- Supplier tracking includes supplier response/date, credit reference/amount/received date, replacement reference/quantity/received date, and pickup/drop-off status, dates, contact and notes.
- Supported attachments: JPEG, PNG, GIF, WebP, PDF, Word (.doc/.docx), Excel (.xls/.xlsx). Maximum 10 per claim and 15 MB per file.
- Migration `0032_returns_attachment_details_limits.sql` adds a claim-scoped name lookup, Storage size/MIME limits, serialized attachment registration limits and attachment audit events.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Record validation and required-field guidance | Clear creation and update errors | In progress |
| 2 | Attachment preview and file management | New-tab images, inline PDF previews, downloads, uploader/date, file limits and permanent deletion | Implemented |
| 3 | Supplier outcome tracking | Capture credits, replacements, supplier responses and pickup/drop-off progress | Implemented |
| 4 | Customer and invoice search | Faster investigation of claims | Planned |
| 5 | Return ageing and SLA reporting | Identify overdue claims | Planned |
| 6 | Exports and audit history | Share and trace claim activity | Audit display implemented; exports planned |

## Acceptance direction

New records may be created before an outcome is known. Outcome Request remains unknown until selected, and every saved record can be edited later.

## Deployment and verification

Apply migrations through 0034 before deploying the updated frontend. Migration 0033 assigns readable references to existing claims and adds supplier workflow fields. Migration 0034 enables permission-checked attachment deletion for both workspaces. Applying migrations does not delete existing attachments. Missing employee profiles are shown as Former employee.

Attachment deletion removes the stored object through the Storage API first, then removes metadata and records the audit event in one database transaction. If Storage removal fails, metadata remains. If metadata finalization fails after the file was removed, retry Delete to complete the operation. Only users permitted to manage the parent record may delete its files. This operation is permanent; the audit entry retains the filename and actor.

Credit receipt requires a date, reference and nonnegative amount. Replacement receipt requires a date, reference and positive integer quantity. Scheduled handovers require a scheduled date; completed handovers require a completion date. New supplier changes record before/after values in audit history. Existing legacy supplier-received flags are retained; entering receipt dates keeps the summary in sync. Claim completion status remains an explicit user choice.

Local checks: `npm.cmd run build` and `node --experimental-strip-types --test tests/returnsAttachments.test.mjs tests/returnsWorkflow.test.mjs tests/recordAttachments.test.mjs` from `frontend/`. Tests cover formats, sizes, combined attachment counts, supplier receipt validation, handover scheduling/completion, deletion authorization, parent scoping, Storage failure, operation ordering and retry handling. Database migrations, concurrency and signed links require verification against a Supabase test project:

- Open an existing record and confirm history, uploader names and dates appear.
- Open an image in a new tab and preview a PDF inside the panel; download a document and check its filename.
- Confirm existing references, create concurrent claims and check unique daily numbers, including the transition from 99 to 100.
- Delete an attachment from a claim and an owned RFQ; verify both Storage and metadata removal and the retained audit event. Verify an unauthorized salesperson cannot delete another user's RFQ files.
- Save credit/replacement receipts and scheduled/completed handovers, reopen the claim and check saved values and named audit events.
- Save an edited record with stored files, reopen it and confirm metadata is preserved.
- Attempt an eleventh attachment, a file above 15 MB, and an unsupported file; each must be rejected.
- With nine files saved, attempt two concurrent uploads; only one attachment registration should succeed.
- Confirm signed-out users and users without administrator, management or returns roles cannot retrieve names or files.


## Wildcard search

Wildcard search is planned across RFC, customer, invoice, part number and other claim fields.
