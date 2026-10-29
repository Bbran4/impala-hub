# Returns & Claims Roadmap

Updated: 2026-10-29

## Current workspace

- Returns & Claims records with editable dates, warehouse, RFC details, customer and invoice information.
- Reason, requested outcome, status, comments and supplier-received tracking.
- Search, status, company, reason and outcome filters.
- Inclusive claim-date range filters and SLA filters for overdue, due-soon and open claims.
- A 7-calendar-day default SLA, warning during the final 2 days, per-claim SLA adjustment, and ageing that stops when a claim closes.
- Filtered CSV and XLSX exports, with an on-screen reporting summary by status and company.
- Side-panel creation and editing.
- Record deletion and saved attachments.
- Supabase record history displays actor names, timestamps, actions and changed-field summaries inside the record panel.
- Stored attachments display uploader names and upload dates. Images open in a new browser tab; PDFs have inline previews; all supported formats have download controls.
- References follow `RCYYYYMMDDNN`, for example `RC2026102601`. New numbers use the Johannesburg creation date, restart at 01 daily, and support more than 99 records per day. Existing records receive references ordered by creation time while retaining their UUID keys.
- Saved claim and RFQ attachments can be permanently removed from Storage and their metadata tables, with a confirmation and retained audit event.
- Supplier tracking includes supplier response/date, credit reference/amount/received date, replacement reference/quantity/received date, and pickup/drop-off status, dates, contact and notes.
- Supported attachments: JPEG, PNG, GIF, WebP, PDF, Word (.doc/.docx), Excel (.xls/.xlsx). Maximum 10 per claim and 15 MB per file.
- Controlled status transitions prevent incomplete claims from being completed and record rejection, reopening and status-change reasons in history.
- Automated pgTAP coverage verifies workspace roles, RLS, claim creation/editing/soft deletion, attachments, audit events and signed-out privileges in an isolated local Supabase stack.

## Next priorities

| Priority | Capability | Outcome | Status |
|---|---|---|---|
| 1 | Record validation and required-field guidance | Database-backed status transitions, completion prerequisites and clear save errors | Implemented |
| 2 | Attachment preview and file management | New-tab images, inline PDF previews, downloads, uploader/date, file limits and permanent deletion | Implemented |
| 3 | Supplier outcome tracking | Capture credits, replacements, supplier responses and pickup/drop-off progress | Implemented |
| 4 | Customer and invoice search | Substring search across claim values, including customer and invoice fields | Implemented |
| 5 | Return ageing and SLA reporting | Identify due-soon and overdue claims using an adjustable 7-day default | Implemented |
| 6 | Exports and audit history | Current-filter CSV/XLSX reports plus named activity history | Implemented |
| 7 | Automated security and lifecycle tests | Local and CI verification of RLS, CRUD, attachments, audit and signed-out access | Implemented |

## Acceptance direction

New records may be created before an outcome is known. Outcome Request remains unknown until selected, and every saved record can be edited later.

## Deployment and verification

Apply migrations through 0036 before deploying the updated frontend. Migration 0033 assigns readable references to existing claims and adds supplier workflow fields. Migration 0034 enables permission-checked attachment deletion for both workspaces. Migration 0035 adds SLA fields, closed timestamps, transition validation and explicit status/SLA audit events. It deliberately stops with a list of values if legacy records contain unsupported statuses, so those records can be corrected instead of silently becoming uneditable. Migration 0036 makes create/edit/delete audits and actor attribution atomic, blocks browser hard-deletes and scopes attachment uploads to the caller and active claim. Applying these migrations does not delete existing attachments. Missing employee profiles are shown as Former employee.

Attachment deletion removes the stored object through the Storage API first, then removes metadata and records the audit event in one database transaction. If Storage removal fails, metadata remains. If metadata finalization fails after the file was removed, retry Delete to complete the operation. Only users permitted to manage the parent record may delete its files. This operation is permanent; the audit entry retains the filename and actor.

Credit receipt requires a date, reference and nonnegative amount. Replacement receipt requires a date, reference and positive integer quantity. Scheduled handovers require a scheduled date; completed handovers require a completion date. New supplier changes record before/after values in audit history. Existing legacy supplier-received flags are retained; entering receipt dates keeps the summary in sync.

Completed claims must have the requested credit or replacement recorded and any required pickup/drop-off completed. Rejections and reopening a completed or rejected claim require a new reason. A closed claim may only be reopened to In Progress. Moving a claim to a supplier-waiting status requires a supplier; moving it to handover waiting requires a pickup/drop-off method and pending or scheduled handover status. These rules are enforced in both the interface and database.

SLA calculations use Johannesburg calendar dates. The default target is 7 calendar days from the claim date and the final 2 days are marked due soon. Claims become overdue the day after the due date. The target can be adjusted from 1 to 365 days per claim. Completed and rejected claims retain their closing age and are never displayed as currently overdue. Existing closed records use their last update time as an approximate closing time during migration.

CSV and XLSX reports contain only records matching the current search and filters. The workbook includes a summary sheet, status and company breakdowns, and a detailed Claims sheet. Numeric values remain numeric and text is protected from spreadsheet-formula execution. Supabase claim retrieval is paged so reports are not silently limited to the first 1,000 permitted records.

Local checks: `npm.cmd test` and `npm.cmd run build` from `frontend/`, plus `npx.cmd --prefix frontend supabase test db` from the repository root while the local Supabase stack is running. The 26 frontend tests cover formats, sizes, combined attachment counts, supplier receipt validation, handover scheduling/completion, deletion authorization, parent scoping, Storage failure, operation ordering and retry handling, permitted status changes, SLA boundaries, date filters, summaries, CSV safety and XLSX round-tripping. The database suite creates temporary local identities for administrator, management, returns, sales and inactive roles, exercises RLS and lifecycle behavior, and rolls the entire test transaction back. GitHub Actions runs both suites and the production build.

The automated database suite covers table and RPC privileges, active-role workspace access, create/edit/soft-delete operations, atomic lifecycle and status/SLA audit triggers, private attachment Storage policies, metadata validation, the 15 MB and 10-file limits, attachment deletion and signed-out denial. Hosted signed-URL delivery, browser previews/downloads and production configuration remain smoke-test responsibilities:

- Open an existing record and confirm history, uploader names and dates appear.
- Open an image in a new tab and preview a PDF inside the panel; download a document and check its filename.
- Confirm existing references, create concurrent claims and check unique daily numbers, including the transition from 99 to 100.
- Delete an attachment from a claim and an owned RFQ; verify both Storage and metadata removal and the retained audit event. Verify an unauthorized salesperson cannot delete another user's RFQ files.
- Save credit/replacement receipts and scheduled/completed handovers, reopen the claim and check saved values and named audit events.
- Attempt to complete a claim before its requested outcome is received, reject without a reason, and reopen without a new reason; confirm each save is rejected by Supabase.
- Complete and reopen a valid claim and confirm its status, closing time, reopening reason and named history events.
- Check due-soon on the fifth through seventh calendar day, overdue on the eighth day, and confirm closed claim age no longer increases.
- Apply search, date and SLA filters, then compare the visible rows and summary counts with both CSV and XLSX exports.
- Save an edited record with stored files, reopen it and confirm metadata is preserved.
- Attempt an eleventh attachment, a file above 15 MB, and an unsupported file; each must be rejected.
- With nine files saved, attempt two concurrent uploads; only one attachment registration should succeed.
- Confirm signed-out users and users without administrator, management or returns roles cannot retrieve names or files.


## Wildcard search

Literal substring search is implemented across RFC, customer, invoice, part number and other claim values. True wildcard-pattern semantics such as `*` and `?` remain planned, along with final hosted smoke verification.
